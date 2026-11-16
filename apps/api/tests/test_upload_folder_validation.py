"""Retired uploads cannot allocate assets under any folder, including trash."""
import uuid
from unittest.mock import patch

import pytest


@pytest.mark.parametrize("folder_id", [None, str(uuid.uuid4())])
@pytest.mark.parametrize("existing_asset", [False, True])
def test_retired_uploads_cannot_allocate_in_folders(
    client, auth_headers, mock_db, folder_id, existing_asset,
):
    body = {
        "project_id": str(uuid.uuid4()), "folder_id": folder_id,
        "asset_id": str(uuid.uuid4()) if existing_asset else None,
        "mime_type": "image/png", "original_filename": "a.png",
        "file_size_bytes": 10, "asset_name": "a",
    }
    with patch("apps.api.services.s3_service.create_multipart_upload") as create:
        response = client.post("/upload/initiate", json=body, headers=auth_headers)
        assert response.status_code == 410
        create.assert_not_called()
    mock_db.query.assert_not_called()
    mock_db.add.assert_not_called()
    mock_db.commit.assert_not_called()
