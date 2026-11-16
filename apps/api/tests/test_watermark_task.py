"""Burnt-in watermark jobs are retired; existing objects must remain untouched."""
from unittest.mock import patch

import pytest

from apps.api.tasks.watermark_tasks import apply_watermark


@pytest.mark.parametrize("retries", [0, 1, 3])
@pytest.mark.parametrize("logo", [None, "branding/existing-logo.png"])
def test_historical_watermark_jobs_cannot_encode_write_or_retry(retries, logo):
    apply_watermark.push_request(retries=retries, called_directly=False)
    try:
        with patch("apps.api.database.SessionLocal") as db, \
             patch("apps.api.services.s3_service.get_s3_client") as s3, \
             patch("apps.api.services.s3_service.put_object") as put, \
             patch("subprocess.run") as run, \
             patch.object(apply_watermark, "retry") as retry:
            with pytest.raises(RuntimeError, match="retired"):
                apply_watermark.run("historical-asset", "CONFIDENTIAL", "center", 0.5, logo)
            for operation in (db, s3, put, run, retry):
                operation.assert_not_called()
    finally:
        apply_watermark.pop_request()
