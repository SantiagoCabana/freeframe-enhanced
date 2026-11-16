"""Compatibility entry points: old jobs must never start server media processing."""
from .celery_app import celery_app


@celery_app.task(bind=True)
def process_asset(self, asset_id: str, version_id: str):
    raise RuntimeError("Server media processing is retired; use Electron/Ingest")


@celery_app.task(bind=True)
def backfill_media_metadata(self):
    raise RuntimeError("Server media probing is retired; metadata must be supplied at ingest")
