"""Old transcode messages cannot inspect or change even deleted resources."""
from unittest.mock import patch

import pytest

from apps.api.tasks.transcode_tasks import process_asset


@pytest.mark.parametrize("asset_id,version_id", [
    ("deleted-asset", "live-version"),
    ("live-asset", "deleted-version"),
    ("missing-asset", "missing-version"),
])
def test_retired_job_never_accesses_resources(asset_id, version_id):
    with patch("apps.api.database.SessionLocal") as database, \
         patch("apps.api.services.s3_service.get_s3_client") as storage, \
         patch("subprocess.run") as encode:
        with pytest.raises(RuntimeError, match="processing is retired"):
            process_asset.run(asset_id, version_id)
        database.assert_not_called()
        storage.assert_not_called()
        encode.assert_not_called()
