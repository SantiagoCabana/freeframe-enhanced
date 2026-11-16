"""Historical task deliveries must neither restart processing nor mutate media."""
from unittest.mock import patch

import pytest

from apps.api.tasks import cleanup_tasks, transcode_tasks


@pytest.mark.parametrize("retries", [0, 1, 2, 3, 10])
def test_old_deliveries_never_retry_or_change_database_state(retries):
    task = transcode_tasks.process_asset
    task.push_request(retries=retries, called_directly=False)
    try:
        with patch("apps.api.database.SessionLocal") as db, \
             patch("apps.api.services.s3_service.get_s3_client") as s3, \
             patch("apps.api.services.event_service.publish_sync") as publish, \
             patch.object(task, "retry") as retry:
            with pytest.raises(RuntimeError, match="retired"):
                task.run("historical-asset", "historical-version")
            db.assert_not_called()
            s3.assert_not_called()
            publish.assert_not_called()
            retry.assert_not_called()
    finally:
        task.pop_request()


@pytest.mark.parametrize("timeout", [0, 1, 6, 24])
def test_old_recovery_messages_are_non_destructive_noops(timeout):
    with patch.object(cleanup_tasks.settings, "stuck_processing_timeout_hours", timeout), \
         patch.object(cleanup_tasks, "SessionLocal") as db, \
         patch("apps.api.tasks.celery_app.send_task_safe") as send:
        assert cleanup_tasks.requeue_stuck_processing() == 0
        db.assert_not_called()
        send.assert_not_called()
