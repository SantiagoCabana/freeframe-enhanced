"""Container/MIME ambiguities cannot restart the retired server pipeline."""
import uuid
from unittest.mock import patch

import pytest


@pytest.mark.parametrize("filename,mime_type", [
    ("audio-only.mp4", "video/mp4"),
    ("audio-only.mpg", "video/mpeg"),
    ("recording.wav", "audio/wav"),
])
def test_audio_containers_are_refused_before_allocation(
    client, mock_db, auth_headers, filename, mime_type,
):
    with patch("subprocess.run") as probe:
        response = client.post("/upload/initiate", headers=auth_headers, json={
            "project_id": str(uuid.uuid4()),
            "asset_name": "Recording",
            "original_filename": filename,
            "mime_type": mime_type,
            "file_size_bytes": 1024,
        })
    assert response.status_code == 410
    mock_db.add.assert_not_called()
    mock_db.commit.assert_not_called()
    probe.assert_not_called()
