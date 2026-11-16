"""Compatibility entry point for retired watermark jobs; never touches stored media."""
from .celery_app import celery_app


@celery_app.task(name="apply_watermark", bind=True)
def apply_watermark(self, asset_id: str, watermark_text: str, position: str,
                    opacity: float, image_key: str | None):
    raise RuntimeError("Server watermark generation is retired")
