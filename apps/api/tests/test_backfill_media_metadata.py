"""Retired metadata jobs cannot probe storage or mutate existing metadata."""
import runpy
from unittest.mock import patch

import pytest

from apps.api.tasks.transcode_tasks import backfill_media_metadata


@pytest.mark.parametrize("invocation", ["direct", "celery"])
def test_old_backfill_job_refuses_before_external_access(invocation):
    with patch("apps.api.database.SessionLocal") as database, \
         patch("apps.api.services.s3_service.get_s3_client") as storage, \
         patch("subprocess.run") as probe:
        with pytest.raises(RuntimeError, match="probing is retired"):
            if invocation == "celery":
                backfill_media_metadata.apply().get()
            else:
                backfill_media_metadata()
        database.assert_not_called()
        storage.assert_not_called()
        probe.assert_not_called()


def test_backfill_cli_exits_without_publishing_or_probing():
    with patch("apps.api.tasks.celery_app.celery_app.send_task") as publish, \
         patch("subprocess.run") as probe:
        with pytest.raises(SystemExit, match="retired"):
            runpy.run_module("apps.api.scripts.backfill_media_metadata", run_name="__main__")
        publish.assert_not_called()
        probe.assert_not_called()
