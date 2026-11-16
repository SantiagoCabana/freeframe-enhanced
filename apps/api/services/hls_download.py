"""Stream an unchanged HLS version as ZIP, without transcoding or staging it."""
import io
import posixpath
import re
import zipfile
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlsplit

import jwt
from fastapi import HTTPException

from ..config import settings
from .s3_service import get_s3_client


def archive_url(prefix: str, filename: str) -> str:
    token = jwt.encode({
        "sub": "hls-download", "pfx": prefix, "filename": filename,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=15),
    }, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return f"/stream/hls-download?token={quote(token)}"


def archive_claims(token: str) -> dict:
    try:
        claims = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm],
                            options={"require": ["exp", "sub", "pfx", "filename"]})
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired download token")
    if claims["sub"] != "hls-download":
        raise HTTPException(status_code=403, detail="Invalid token type")
    prefix = claims["pfx"]
    if not isinstance(prefix, str) or not prefix or any(p in ("", ".", "..") for p in prefix.split("/")):
        raise HTTPException(status_code=400, detail="Invalid HLS prefix")
    if not isinstance(claims["filename"], str) or not claims["filename"]:
        raise HTTPException(status_code=400, detail="Invalid download filename")
    return claims


def archive_objects(prefix: str) -> list[dict]:
    """Follow only the playlist graph, never unrelated originals in the same prefix."""
    s3 = get_s3_client()
    objects = []
    pending = ["master.m3u8"]
    seen = set(pending)
    playlist_bytes = 0
    while pending:
        name = pending.pop()
        key = prefix + "/" + name
        obj = {"key": key, "name": name}
        if name.lower().endswith(".m3u8"):
            response = s3.get_object(Bucket=settings.s3_bucket, Key=key)
            body = response["Body"]
            try:
                data = body.read(2 * 1024 * 1024 + 1)
            finally:
                body.close()
            if len(data) > 2 * 1024 * 1024:
                raise HTTPException(status_code=409, detail="HLS playlist is too large")
            playlist_bytes += len(data)
            if playlist_bytes > 16 * 1024 * 1024:
                raise HTTPException(status_code=409, detail="HLS playlist metadata is too large")
            try:
                text = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                raise HTTPException(status_code=409, detail="Invalid HLS playlist")
            if not text.startswith("#EXTM3U"):
                raise HTTPException(status_code=409, detail="Invalid HLS playlist")
            obj.update(data=data, size=len(data))
            for line in text.splitlines():
                line = line.strip()
                refs = re.findall(r'URI="([^"]+)"', line) if line.startswith("#") else [line]
                for ref in filter(None, refs):
                    # ZIP filenames truncate at NUL; reject controls before URL normalization.
                    if any(ord(char) < 32 or ord(char) == 127 for char in ref):
                        raise HTTPException(status_code=409, detail="Invalid HLS reference")
                    try:
                        url = urlsplit(ref)
                    except ValueError:
                        raise HTTPException(status_code=409, detail="Invalid HLS reference")
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(name), ref))
                    if (url.scheme or url.netloc or url.query or url.fragment
                            or ref.startswith("/") or "\\" in ref or "%" in ref
                            or target in (".", "..") or target.startswith("../")):
                        raise HTTPException(status_code=409, detail="HLS contains a non-local reference")
                    if target not in seen:
                        seen.add(target)
                        if len(seen) > 20000:
                            raise HTTPException(status_code=409, detail="Too many HLS archive files")
                        pending.append(target)
        else:
            response = s3.head_object(Bucket=settings.s3_bucket, Key=key)
            obj.update(size=response["ContentLength"], etag=response["ETag"])
        objects.append(obj)
    return objects


class _ZipOutput(io.RawIOBase):
    def __init__(self):
        self.pending = bytearray()
        self.position = 0

    def writable(self):
        return True

    def tell(self):
        return self.position

    def write(self, data):
        self.pending.extend(data)
        self.position += len(data)
        return len(data)

    def drain(self):
        data = bytes(self.pending)
        self.pending.clear()
        return data


def archive_chunks(objects: list[dict]):
    output = _ZipOutput()
    s3 = get_s3_client()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for obj in objects:
            if "data" in obj:
                archive.writestr(obj["name"], obj["data"])
                yield output.drain()
                continue
            response = s3.get_object(Bucket=settings.s3_bucket, Key=obj["key"], IfMatch=obj["etag"])
            body = response["Body"]
            try:
                with archive.open(obj["name"], "w", force_zip64=True) as target:
                    size = 0
                    for chunk in body.iter_chunks(chunk_size=1024 * 1024):
                        size += len(chunk)
                        target.write(chunk)
                        yield output.drain()
                    if size != obj["size"]:
                        raise OSError("HLS object changed during download; retry")
            finally:
                body.close()
            yield output.drain()
    yield output.drain()
