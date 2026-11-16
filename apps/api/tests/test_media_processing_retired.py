"""Retired entry points cannot allocate storage, mutate rows, or publish jobs."""
import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from apps.api.routers import upload
from apps.api.models.asset import ProcessingStatus


_ID = str(uuid.uuid4())
_RETIRED_REQUESTS = [
    ("post", "/upload/initiate", {"project_id": _ID, "asset_name": "clip", "original_filename": "clip.mp4", "mime_type": "video/mp4", "file_size_bytes": 10}),
    ("post", "/upload/presign-part", {"s3_key": "raw/p/a/v/clip.mp4", "upload_id": "old", "part_number": 1}),
    ("get", f"/upload/{_ID}/parts", None),
    ("post", "/upload/complete", {"s3_key": "raw/p/a/v/clip.mp4", "upload_id": "old", "asset_id": _ID, "version_id": _ID}),
]


@pytest.mark.parametrize("method,path,body", _RETIRED_REQUESTS)
def test_http_retirement_authenticates_before_refusal(client, method, path, body):
    response = client.request(method, path, **({"json": body} if body else {}))
    assert response.status_code in (401, 403)


@pytest.mark.parametrize("method,path,body", _RETIRED_REQUESTS)
def test_authenticated_http_retirement_has_no_writes(client, auth_headers, mock_db, method, path, body):
    response = client.request(method, path, headers=auth_headers, **({"json": body} if body else {}))
    assert response.status_code == 410
    assert "Electron/Ingest" in response.json()["detail"]
    mock_db.add.assert_not_called()
    mock_db.commit.assert_not_called()
    mock_db.delete.assert_not_called()


@pytest.mark.parametrize("handler,args", [
    (upload.initiate_upload, (MagicMock(),)),
    (upload.presign_part, (MagicMock(),)),
    (upload.resume_upload, (uuid.uuid4(),)),
    (upload.complete_upload, (MagicMock(), MagicMock())),
])
def test_direct_calls_are_retired_before_side_effects(handler, args):
    db, user = MagicMock(), MagicMock()
    with pytest.raises(HTTPException) as exc:
        handler(*args, db=db, current_user=user)
    assert exc.value.status_code == 410
    assert "Electron/Ingest" in exc.value.detail
    assert not db.mock_calls


def test_legacy_abort_cannot_touch_ingest_objects():
    user, version, media, db, body = (MagicMock() for _ in range(5))
    version.created_by = user.id
    version.upload_id = None
    media.s3_key_raw = "processed/p/a/v/master.m3u8"
    db.query.return_value.filter.return_value.with_for_update.return_value.first.return_value = version
    db.query.return_value.filter.return_value.first.return_value = media
    with patch.object(upload, "abort_multipart_upload") as abort:
        with pytest.raises(HTTPException) as exc:
            upload.abort_upload(body, MagicMock(), db, user)
    assert exc.value.status_code == 409
    abort.assert_not_called()
    db.commit.assert_not_called()


def test_abort_preserves_completed_raw_without_processing():
    user, version, media, db, body = (MagicMock() for _ in range(5))
    version.created_by = user.id
    version.upload_id = body.upload_id
    version.processing_status = ProcessingStatus.uploading
    media.s3_key_raw = "raw/p/a/v/original.mp4"
    body.discard = False
    db.query.return_value.filter.return_value.with_for_update.return_value.first.return_value = version
    db.query.return_value.filter.return_value.first.return_value = media
    with patch.object(upload, "abort_multipart_upload") as abort:
        upload.abort_upload(body, MagicMock(), db, user)
    abort.assert_called_once_with(media.s3_key_raw, body.upload_id)
    assert version.processing_status == ProcessingStatus.failed
    db.delete.assert_not_called()
    db.commit.assert_called_once()


@pytest.mark.parametrize("status", [ProcessingStatus.ready, ProcessingStatus.processing, ProcessingStatus.failed])
def test_abort_cannot_rewind_a_finished_version(status):
    user, version, media, db, body = (MagicMock() for _ in range(5))
    version.created_by = user.id
    version.upload_id = body.upload_id
    version.processing_status = status
    media.s3_key_raw = "raw/p/a/v/original.mp4"
    body.discard = True
    db.query.return_value.filter.return_value.with_for_update.return_value.first.return_value = version
    db.query.return_value.filter.return_value.first.return_value = media
    with patch.object(upload, "abort_multipart_upload"):
        upload.abort_upload(body, MagicMock(), db, user)
    assert version.processing_status == status
    db.delete.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.parametrize("mismatch", ["owner", "upload_id"])
def test_abort_refuses_foreign_upload_before_storage(mismatch):
    user, version, media, db, body = (MagicMock() for _ in range(5))
    version.created_by = user.id if mismatch != "owner" else uuid.uuid4()
    version.upload_id = body.upload_id if mismatch != "upload_id" else "other-upload"
    media.s3_key_raw = "raw/p/a/v/original.mp4"
    db.query.return_value.filter.return_value.with_for_update.return_value.first.return_value = version
    db.query.return_value.filter.return_value.first.return_value = media
    with patch.object(upload, "abort_multipart_upload") as abort:
        with pytest.raises(HTTPException) as exc:
            upload.abort_upload(body, MagicMock(), db, user)
    assert exc.value.status_code == 403
    abort.assert_not_called()
    db.commit.assert_not_called()
