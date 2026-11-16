"""Retired multipart entry points and cancellation of historical web uploads."""
import logging
import math
import uuid

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus
from ..models.project import ProjectRole
from ..models.user import User
from ..schemas.upload import (
    AbortUploadRequest, CHUNK_SIZE_BYTES, CompleteUploadRequest,
    CompleteUploadResponse, InitiateUploadRequest, InitiateUploadResponse,
    PresignPartRequest, PresignPartResponse, ResumeUploadResponse,
)
from ..services.media_processing import require_media_processing
from ..services.permissions import require_project_role
from ..services.s3_service import abort_multipart_upload, UPLOAD_GONE_CODES

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/upload", tags=["upload"])


@router.post("/initiate", response_model=InitiateUploadResponse)
def initiate_upload(
    body: InitiateUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_media_processing()


@router.post("/presign-part", response_model=PresignPartResponse)
def presign_part(
    body: PresignPartRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_media_processing()


@router.get("/{version_id}/parts", response_model=ResumeUploadResponse)
def resume_upload(
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_media_processing()


@router.post("/complete", response_model=CompleteUploadResponse)
def complete_upload(
    body: CompleteUploadRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_media_processing()


def _may_remove_asset(db: Session, asset_id: uuid.UUID, user: User) -> bool:
    asset = db.query(Asset).filter(Asset.id == asset_id).first()
    if asset is None:
        return False
    try:
        require_project_role(db, asset.project_id, user, ProjectRole.editor)
    except HTTPException:
        return False
    return True


@router.post("/abort", status_code=status.HTTP_204_NO_CONTENT)
def abort_upload(
    body: AbortUploadRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    version = db.query(AssetVersion).filter(
        AssetVersion.id == body.version_id,
        AssetVersion.deleted_at.is_(None),
    ).with_for_update().first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    if version.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")
    media_file = db.query(MediaFile).filter(
        MediaFile.version_id == version.id,
        MediaFile.s3_key_raw == body.s3_key,
    ).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Upload not found for this version")
    if version.upload_id is not None and version.upload_id != body.upload_id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")
    if not media_file.s3_key_raw.startswith("raw/"):
        raise HTTPException(status_code=409, detail="Manage this upload through Ingest.")

    try:
        abort_multipart_upload(media_file.s3_key_raw, version.upload_id or body.upload_id)
    except ClientError as exc:
        if str(exc.response.get("Error", {}).get("Code", "")) not in UPLOAD_GONE_CODES:
            raise
    except BotoCoreError as exc:
        raise HTTPException(
            status_code=503,
            detail="Could not reach storage to abort this upload. Please retry.",
            headers={"Retry-After": "5"},
        ) from exc

    if (body.discard and version.deleted_at is None
            and version.processing_status == ProcessingStatus.uploading):
        from ..tasks.cleanup_tasks import _dispose_version_files, _strip_asset_with_no_versions

        asset_id = version.asset_id
        last_version = db.query(AssetVersion).filter(
            AssetVersion.asset_id == asset_id,
            AssetVersion.id != version.id,
            AssetVersion.deleted_at.is_(None),
        ).first() is None
        if last_version and not _may_remove_asset(db, asset_id, current_user):
            db.commit()
            return
        _dispose_version_files(db, version)
        db.flush()
        if last_version:
            _strip_asset_with_no_versions(db, asset_id)
        db.commit()
        return

    if version.processing_status == ProcessingStatus.uploading:
        # Failed raw uploads with assembled objects are preserved by the reaper.
        version.processing_status = ProcessingStatus.failed
        db.commit()


# Historical multipart validation remains available for offline diagnostics.
def _pinned_chunk_size(version, stored: list[dict]) -> int:
    if version.chunk_size_bytes:
        return version.chunk_size_bytes
    if len(stored) >= 2:
        highest = max(p["PartNumber"] for p in stored)
        full = [p["Size"] for p in stored if p["PartNumber"] < highest and p.get("Size")]
        if full:
            return max(full)
    return CHUNK_SIZE_BYTES


def _held_part_numbers(stored: list[dict], chunk_size: int, total_bytes: int) -> list[int]:
    total_parts = math.ceil(total_bytes / chunk_size) if chunk_size > 0 else 0
    counts: dict[int, int] = {}
    for part in stored:
        counts[part["PartNumber"]] = counts.get(part["PartNumber"], 0) + 1
    held = []
    for part in stored:
        number = part["PartNumber"]
        if number < 1 or number > total_parts or counts[number] > 1:
            continue
        expected = total_bytes - (total_parts - 1) * chunk_size if number == total_parts else chunk_size
        if part.get("Size") == expected:
            held.append(number)
    return sorted(held)


def _parts_from_listing(stored: list[dict], expected_total_bytes: int) -> list[dict]:
    by_number: dict[int, list[dict]] = {}
    for part in stored:
        by_number.setdefault(part["PartNumber"], []).append(part)
    numbers = sorted(by_number)
    if not numbers:
        raise ValueError("No uploaded parts were found for this upload.")
    if numbers != list(range(1, len(numbers) + 1)):
        missing = sorted(set(range(1, numbers[-1] + 1)) - set(numbers))
        raise ValueError(f"Upload is incomplete: {len(missing)} part(s) missing, starting at part {missing[0]}.")
    duplicated = [n for n in numbers if len(by_number[n]) > 1]
    if duplicated:
        raise ValueError(f"Storage reported part {duplicated[0]} more than once; please upload this file again.")
    parts = [by_number[n][0] for n in numbers]
    if any(p["Size"] is None for p in parts):
        raise ValueError("Storage did not report part sizes, so the upload cannot be verified.")
    chunk_size = parts[0]["Size"]
    for part in parts[:-1]:
        if part["Size"] != chunk_size:
            raise ValueError(
                f"Part {part['PartNumber']} is {part['Size']} bytes but every part before the "
                f"last must be {chunk_size}; please upload this file again."
            )
    if parts[-1]["Size"] > chunk_size:
        raise ValueError("The final part is larger than the parts before it.")
    total = sum(p["Size"] for p in parts)
    if total != expected_total_bytes:
        raise ValueError(f"Uploaded {total} bytes but the file was declared as {expected_total_bytes}.")
    return [{"PartNumber": p["PartNumber"], "ETag": p["ETag"]} for p in parts]
