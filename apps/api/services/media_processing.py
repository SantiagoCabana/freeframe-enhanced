"""The desktop prepares review media; this server only serves it."""
from fastapi import HTTPException


def require_media_processing():
    raise HTTPException(
        status_code=410,
        detail="Server media processing has been retired. Upload prepared videos with Electron/Ingest. Existing media remains available.",
    )
