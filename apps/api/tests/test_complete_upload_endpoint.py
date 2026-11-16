"""Completion is retired; historical abort still enforces ownership and storage errors."""
import uuid
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from apps.api.models.asset import ProcessingStatus
from apps.api.routers import upload


@pytest.mark.parametrize("state", list(ProcessingStatus))
@pytest.mark.parametrize("parts", [[], [{"PartNumber": 1, "ETag": "etag"}]])
def test_completion_never_reassembles_or_requeues_an_existing_version(
    client, auth_headers, mock_db, state, parts,
):
    mock_db.first.return_value = MagicMock(processing_status=state)
    with patch("apps.api.services.s3_service.get_s3_client") as storage, \
         patch("apps.api.tasks.celery_app.send_task_safe") as dispatch:
        response = client.post("/upload/complete", headers=auth_headers, json={
            "s3_key": "raw/p/a/v/original.mp4", "upload_id": "historical",
            "asset_id": str(uuid.uuid4()), "version_id": str(uuid.uuid4()), "parts": parts,
        })
    assert response.status_code == 410
    storage.assert_not_called()
    dispatch.assert_not_called()
    mock_db.commit.assert_not_called()
    mock_db.add.assert_not_called()


@pytest.mark.parametrize("s3_key", ["raw/foreign/original.mp4", "processed/p/a/v/master.m3u8"])
def test_completion_refuses_forged_keys_without_inspecting_storage(client, auth_headers, mock_db, s3_key):
    response = client.post("/upload/complete", headers=auth_headers, json={
        "s3_key": s3_key, "upload_id": "unrecognised",
        "asset_id": str(uuid.uuid4()), "version_id": str(uuid.uuid4()),
    })
    assert response.status_code == 410
    mock_db.query.assert_not_called()


@pytest.mark.parametrize("storage_error,expected", [(None, 204), ("NoSuchUpload", 204), ("AccessDenied", 500)])
@pytest.mark.parametrize("state", [ProcessingStatus.uploading, ProcessingStatus.ready])
def test_abort_handles_gone_parts_without_masking_storage_errors(
    client, auth_headers, mock_db, test_user, storage_error, expected, state,
):
    version = MagicMock(id=uuid.uuid4(), asset_id=uuid.uuid4(), created_by=test_user.id,
                        processing_status=state, upload_id="historical")
    media = MagicMock(s3_key_raw="raw/p/a/v/original.mp4")
    mock_db.with_for_update.return_value = mock_db
    mock_db.first.side_effect = [version, media]
    error = ClientError({"Error": {"Code": storage_error}}, "AbortMultipartUpload") if storage_error else None
    with patch.object(upload, "abort_multipart_upload", side_effect=error):
        response = client.post("/upload/abort", headers=auth_headers, json={
            "s3_key": media.s3_key_raw, "upload_id": version.upload_id, "version_id": str(version.id),
        })
    assert response.status_code == expected
    if expected == 204 and state == ProcessingStatus.uploading:
        assert version.processing_status == ProcessingStatus.failed
        mock_db.commit.assert_called_once()
    else:
        assert version.processing_status == state
        mock_db.commit.assert_not_called()
    mock_db.delete.assert_not_called()


@pytest.mark.parametrize("missing", ["version", "media"])
def test_abort_requires_a_matching_live_version_and_raw_key(client, auth_headers, mock_db, test_user, missing):
    version = MagicMock(created_by=test_user.id, upload_id="historical")
    mock_db.with_for_update.return_value = mock_db
    mock_db.first.side_effect = [None] if missing == "version" else [version, None]
    with patch.object(upload, "abort_multipart_upload") as storage:
        response = client.post("/upload/abort", headers=auth_headers, json={
            "s3_key": "raw/foreign/original.mp4", "upload_id": "historical", "version_id": str(uuid.uuid4()),
        })
    assert response.status_code == 404
    storage.assert_not_called()
    mock_db.commit.assert_not_called()
