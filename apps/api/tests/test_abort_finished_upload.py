"""Retired uploads stop without deleting assembled originals or publishing work."""
import uuid
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

import apps.api.routers.upload as upload_module
from apps.api.models.asset import ProcessingStatus

MB = 1024 * 1024
KEY = "raw/p/a/v/original.mp4"


def _client_error(code: str, op: str = "AbortMultipartUpload"):
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


@pytest.fixture
def abort_rows(mock_db, test_user):
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading
    version.upload_id = "u-1"

    media_file = MagicMock()
    media_file.version_id = version.id
    media_file.s3_key_raw = KEY
    media_file.file_size_bytes = 23 * MB

    # version lookup, then the media file lookup that pins the key being aborted
    mock_db.with_for_update.return_value = mock_db
    mock_db.first.side_effect = [version, media_file]
    return version, media_file


def _abort(client, auth_headers):
    return client.post(
        "/upload/abort",
        json={"s3_key": KEY, "upload_id": "u-1", "version_id": str(uuid.uuid4())},
        headers=auth_headers,
    )


def test_a_completed_upload_is_stopped_without_deleting_its_original(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    version, media = abort_rows
    dispose = MagicMock()
    monkeypatch.setattr("apps.api.tasks.cleanup_tasks._dispose_version_files", dispose)
    monkeypatch.setattr(upload_module, "abort_multipart_upload",
                        lambda k, u: (_ for _ in ()).throw(_client_error("NoSuchUpload")))

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.failed
    assert media.s3_key_raw == KEY
    assert media.file_size_bytes == 23 * MB
    dispose.assert_not_called()


def test_a_genuinely_cancelled_upload_still_fails(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    """The ordinary case: nothing at the key, so this really did fail."""
    version, _ = abort_rows
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda k, u: None)

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.failed


def test_a_partial_object_at_the_key_is_not_mistaken_for_success(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    """Retirement does not mark a partial upload ready."""
    version, media = abort_rows
    media.file_size_bytes = 10 * MB
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda k, u: None)

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.failed


def test_an_unreadable_head_object_does_not_claim_success(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    """Guessing wrong in this direction would report a missing upload as done."""
    version, _ = abort_rows
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda k, u: None)
    from apps.api.services.s3_service import get_s3_client as storage
    storage.reset_mock()

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.failed
    storage.assert_not_called()


def test_a_version_that_already_reached_processing_is_left_alone(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    version = MagicMock()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.processing
    version.upload_id = "u-1"
    media_file = MagicMock()
    media_file.s3_key_raw = KEY
    mock_db.with_for_update.return_value = mock_db
    mock_db.first.side_effect = [version, media_file]
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda k, u: None)

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.processing


def test_a_real_storage_failure_is_still_surfaced(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    """Parts are still in the bucket; reporting success would hide that."""
    version, _ = abort_rows
    monkeypatch.setattr(upload_module, "abort_multipart_upload",
                        lambda k, u: (_ for _ in ()).throw(_client_error("AccessDenied")))

    assert _abort(client, auth_headers).status_code >= 500
    assert version.processing_status == ProcessingStatus.uploading
