"""HLS proxy for secure video streaming.

Rewrites m3u8 manifests so that:
- Variant playlist URLs go through this proxy (with token auth)
- Segment (.ts) URLs become presigned S3 URLs (direct to S3)

This eliminates the need for a public bucket policy on processed/*.
"""

import logging
import posixpath
from datetime import datetime, timedelta, timezone

import jwt
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from urllib.parse import quote

from ..config import settings
from ..services.s3_service import generate_presigned_get_url, get_s3_client
from ..services.hls_download import archive_claims, archive_objects, archive_chunks, resolve_hls_reference
from ..middleware.rate_limit import rate_limit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["streaming"])


@router.get("/hls-download", dependencies=[Depends(rate_limit("hls_download", 10, 60))])
def download_hls(token: str = Query(...)):
    claims = archive_claims(token)
    try:
        objects = archive_objects(claims["pfx"])
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code in {"404", "NoSuchKey", "NotFound"}:
            raise HTTPException(status_code=409, detail="HLS package is incomplete") from exc
        raise HTTPException(status_code=503, detail="HLS storage is unavailable; retry") from exc
    except BotoCoreError as exc:
        raise HTTPException(status_code=503, detail="HLS storage is unavailable; retry") from exc
    return StreamingResponse(
        archive_chunks(objects), media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(claims['filename'], safe='')}",
            "Cache-Control": "private, no-store",
        },
    )


def create_hls_token(s3_prefix: str, expires_hours: int = 24) -> str:
    """Create a short-lived JWT for HLS proxy access."""
    payload = {
        "sub": "hls",
        "pfx": s3_prefix,
        "exp": datetime.now(timezone.utc) + timedelta(hours=expires_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


# The longest a segment URL is signed for: the lifetime create_hls_token gives a token.
SEGMENT_URL_MAX_SECONDS = 86400


def _decode_hls_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if payload.get("sub") != "hls":
        raise HTTPException(status_code=403, detail="Invalid token type")
    return payload


def _verify_hls_token(token: str) -> str:
    """Verify HLS token and return s3_prefix."""
    return _decode_hls_token(token)["pfx"]


def _segment_url_lifetime(payload: dict) -> int:
    """Seconds a segment URL signed now may live: what is left of the token, never
    more. The proxy checks only the token, so a segment URL that outlived it would
    keep video playing past the token's expiry -- after access to the asset ended."""
    exp = payload.get("exp")
    if exp is None:
        return SEGMENT_URL_MAX_SECONDS
    remaining = int(exp - datetime.now(timezone.utc).timestamp())
    return max(1, min(SEGMENT_URL_MAX_SECONDS, remaining))


def _rewrite_manifest(
    content: str,
    s3_prefix: str,
    manifest_path: str,
    token: str,
    segment_expires_in: int = SEGMENT_URL_MAX_SECONDS,
) -> str:
    """Rewrite URLs in an m3u8 manifest.

    - .m3u8 references -> proxy URLs with token (appended as query param)
    - .ts references -> presigned S3 URLs
    """
    lines = content.split("\n")
    result = []

    for line in lines:
        stripped = line.strip()

        # Pass through comments/tags and empty lines
        if not stripped or stripped.startswith("#"):
            result.append(line)
            continue

        # Resolve Windows-generated playlist paths within the version prefix.
        stripped, relative_key = resolve_hls_reference(manifest_path, stripped)

        if stripped.endswith(".m3u8"):
            # Variant playlist -> proxy URL with token
            result.append(f"/stream/hls/{quote(relative_key, safe='/')}?token={quote(token, safe='')}")
        elif stripped.endswith(".ts"):
            # Segment -> presigned S3 URL (direct to S3), signed for what is
            # left of the token, so pause-and-resume works for as long as the
            # token does and no longer
            if settings.hls_proxy_segments:
                result.append(f"/stream/hls-segment/{quote(relative_key, safe='/')}?token={quote(token, safe='')}")
            else:
                s3_key = f"{s3_prefix}/{relative_key}"
                result.append(generate_presigned_get_url(s3_key, expires_in=segment_expires_in))
        else:
            result.append(line)

    return "\n".join(result)


@router.get("/hls-segment/{path:path}")
def hls_segment(path: str, request: Request, token: str = Query(...)):
    payload = _decode_hls_token(token)
    if not settings.hls_proxy_segments or not path.endswith(".ts"):
        raise HTTPException(status_code=404, detail="Segment not found")
    _, name = resolve_hls_reference("master.m3u8", path)
    if name != path:
        raise HTTPException(status_code=400, detail="Invalid segment path")
    args = {"Bucket": settings.s3_bucket, "Key": f"{payload['pfx']}/{name}"}
    if request.headers.get("range"):
        args["Range"] = request.headers["range"]
    try:
        obj = get_s3_client().get_object(**args)
    except ClientError as exc:
        status = 416 if exc.response.get("Error", {}).get("Code") == "InvalidRange" else 404
        raise HTTPException(status_code=status, detail="Segment unavailable") from exc
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(obj["ContentLength"])}
    if obj.get("ContentRange"):
        headers["Content-Range"] = obj["ContentRange"]
    def chunks():
        try:
            yield from obj["Body"].iter_chunks(chunk_size=1024 * 1024)
        finally:
            obj["Body"].close()
    return StreamingResponse(chunks(), status_code=206 if obj.get("ContentRange") else 200,
                             media_type="video/mp2t", headers=headers)


@router.get("/hls/{path:path}")
def hls_proxy(path: str, token: str = Query(...)):
    """Proxy HLS manifests with URL rewriting for secure streaming."""
    payload = _decode_hls_token(token)
    s3_prefix = payload["pfx"]

    # Only proxy m3u8 manifests
    if not path.endswith(".m3u8"):
        raise HTTPException(status_code=400, detail="Only .m3u8 files are proxied")

    # Prevent directory traversal
    normalised = posixpath.normpath(path)
    if normalised.startswith("..") or normalised.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid path")

    # Defense-in-depth: verify resolved key stays within the token's prefix
    s3_key = f"{s3_prefix}/{normalised}"
    if not s3_key.startswith(s3_prefix + "/"):
        raise HTTPException(status_code=400, detail="Invalid path")

    # Fetch manifest from S3
    s3 = get_s3_client()
    try:
        obj = s3.get_object(Bucket=settings.s3_bucket, Key=s3_key)
        content = obj["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        raise HTTPException(status_code=404, detail="Manifest not found")
    except Exception as e:
        logger.error("Failed to fetch HLS manifest %s: %s", s3_key, e)
        raise HTTPException(status_code=404, detail="Manifest not found")

    rewritten = _rewrite_manifest(
        content, s3_prefix, normalised, token, _segment_url_lifetime(payload),
    )

    return Response(
        content=rewritten,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache"},
    )
