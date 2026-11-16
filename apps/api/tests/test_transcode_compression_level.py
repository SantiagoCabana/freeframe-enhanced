"""Retired encoding preferences cannot create or mutate instance settings."""
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from apps.api.routers.instance_settings import update_instance_settings
from apps.api.schemas.instance_settings import InstanceSettingsUpdate


@pytest.mark.parametrize("body", [
    {"compression_level": level} for level in [None, 1, 2, 3, 4, 5]
] + [{"upload_part_size_bytes": 0}, {"upload_part_size_bytes": 10 * 1024 * 1024}])
def test_retired_preference_refused_before_database_access(body):
    db = MagicMock()
    with pytest.raises(HTTPException) as exc:
        update_instance_settings(InstanceSettingsUpdate(**body), db, MagicMock(is_superadmin=True))
    assert exc.value.status_code == 410
    assert not db.mock_calls
