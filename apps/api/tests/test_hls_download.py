import io
import zipfile
from urllib.parse import parse_qs, urlsplit
from unittest.mock import MagicMock, patch

import pytest
from botocore.response import StreamingBody
from fastapi import HTTPException

from apps.api.routers.hls_proxy import create_hls_token
from apps.api.services.hls_download import archive_chunks, archive_claims, archive_objects, archive_url


def storage(files):
    client = MagicMock()

    def get_object(**kwargs):
        data = files[kwargs["Key"]]
        return {"Body": StreamingBody(io.BytesIO(data), len(data))}

    client.get_object.side_effect = get_object
    client.head_object.side_effect = lambda **kw: {
        "ContentLength": len(files[kw["Key"]]), "ETag": '"etag"',
    }
    return client


def test_archive_follows_nested_playlists_not_unrelated_original():
    files = {
        "processed/p/a/v/master.m3u8": b"#EXTM3U\n720p/index.m3u8\n",
        "processed/p/a/v/720p/index.m3u8": b'#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nchunk.m4s\n',
        "processed/p/a/v/720p/init.mp4": b"init",
        "processed/p/a/v/720p/chunk.m4s": b"segment",
        "processed/p/a/v/original.mp4": b"private original",
    }
    s3 = storage(files)
    with patch("apps.api.services.hls_download.get_s3_client", return_value=s3):
        objects = archive_objects("processed/p/a/v")
        payload = b"".join(archive_chunks(objects))
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        assert set(archive.namelist()) == {
            "master.m3u8", "720p/index.m3u8", "720p/init.mp4", "720p/chunk.m4s",
        }
        assert archive.read("720p/chunk.m4s") == b"segment"
        assert archive.testzip() is None
    assert all(call.kwargs.get("IfMatch") == '"etag"' for call in s3.get_object.call_args_list[2:])


@pytest.mark.parametrize("reference", ["../other/file.ts", "..\\other\\file.ts", "/other/file.ts", "https://example.test/file.ts", "//example.test/file.ts", "%2e%2e/file.ts", "a\x00.ts", "a\t.ts", "http://[invalid/file.ts"])
def test_archive_rejects_outside_references(reference):
    s3 = storage({"p/master.m3u8": f"#EXTM3U\n{reference}\n".encode()})
    with patch("apps.api.services.hls_download.get_s3_client", return_value=s3):
        with pytest.raises(HTTPException) as exc:
            archive_objects("p")
    assert exc.value.status_code == 409
    s3.head_object.assert_not_called()


def test_archive_normalizes_windows_paths_in_playlist_and_zip():
    s3 = storage({"p/master.m3u8": b"#EXTM3U\n1080p\\playlist.m3u8\n",
                  "p/1080p/playlist.m3u8": b"#EXTM3U\nsegment.ts\n",
                  "p/1080p/segment.ts": b"data"})
    with patch("apps.api.services.hls_download.get_s3_client", return_value=s3):
        payload = b"".join(archive_chunks(archive_objects("p")))
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        assert b"1080p/playlist.m3u8" in archive.read("master.m3u8")
        assert archive.read("1080p/segment.ts") == b"data"


def test_archive_handles_playlist_cycles_once():
    s3 = storage({"p/master.m3u8": b"#EXTM3U\nmaster.m3u8\n"})
    with patch("apps.api.services.hls_download.get_s3_client", return_value=s3):
        assert len(archive_objects("p")) == 1


def test_playback_token_cannot_download_archive():
    with pytest.raises(HTTPException):
        archive_claims(create_hls_token("p"))
    token = parse_qs(urlsplit(archive_url("p", "Video.hls.zip")).query)["token"][0]
    assert archive_claims(token)["pfx"] == "p"


def test_truncated_download_fails_and_closes_body():
    body = StreamingBody(io.BytesIO(b"short"), 5)
    s3 = MagicMock()
    s3.get_object.return_value = {"Body": body}
    with patch("apps.api.services.hls_download.get_s3_client", return_value=s3):
        with pytest.raises(OSError):
            b"".join(archive_chunks([{"key": "p/a.ts", "name": "a.ts", "size": 10, "etag": '"e"'}]))
    assert body._raw_stream.closed


@pytest.mark.parametrize("claims", [
    {"pfx": "../other"}, {"pfx": "p//v"}, {"pfx": 3},
    {"filename": None}, {"filename": ""}, {"exp": 1},
])
def test_invalid_archive_claims_are_rejected(claims):
    import jwt
    from apps.api.config import settings
    payload = {"sub": "hls-download", "pfx": "p", "filename": "a.zip", "exp": 4102444800}
    payload.update(claims)
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    with pytest.raises(HTTPException):
        archive_claims(token)


def test_playlist_memory_is_bounded_and_body_closed():
    body = StreamingBody(io.BytesIO(b"#EXTM3U\n" + b" " * (2 * 1024 * 1024)), 2 * 1024 * 1024 + 8)
    s3 = MagicMock()
    s3.get_object.return_value = {"Body": body}
    with patch("apps.api.services.hls_download.get_s3_client", return_value=s3):
        with pytest.raises(HTTPException) as exc:
            archive_objects("p")
    assert exc.value.status_code == 409
    assert body._raw_stream.closed


@pytest.mark.parametrize("code,status", [("NoSuchKey", 409), ("404", 409), ("AccessDenied", 503)])
def test_storage_errors_fail_before_starting_archive(code, status):
    from botocore.exceptions import ClientError
    from apps.api.routers.hls_proxy import download_hls
    token = parse_qs(urlsplit(archive_url("p", "a.zip")).query)["token"][0]
    error = ClientError({"Error": {"Code": code}}, "GetObject")
    with patch("apps.api.routers.hls_proxy.archive_objects", side_effect=error):
        with pytest.raises(HTTPException) as exc:
            download_hls(token)
    assert exc.value.status_code == status


def test_download_route_rejects_playback_token_before_storage_access():
    from apps.api.routers.hls_proxy import download_hls
    with patch("apps.api.routers.hls_proxy.archive_objects") as objects:
        with pytest.raises(HTTPException):
            download_hls(create_hls_token("p"))
    objects.assert_not_called()
