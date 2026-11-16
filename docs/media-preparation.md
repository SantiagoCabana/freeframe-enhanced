# Media preparation outside FreeFrame

This fork retires server-side media processing. Prepare new video in Electron,
upload its HLS files through the existing Ingest service, and use FreeFrame for
review, playback, sharing and management. Ingest and Electron remain separate
services; this change does not install or alter them.

## Changed behavior

- New web media uploads and versions, multipart signing, resuming and completion
  return HTTP 410 before allocating storage or changing records. New audio and
  image assets are not supported through these retired routes. Existing assets,
  avatars, branding images and comment attachments retain their own routes.
- Server-generated thumbnails, waveforms, transcoded files, metadata backfills
  and burnt-in watermark generation are retired. Existing derived files and
  player watermark overlays remain available.
- Comment exports accept explicit source timecode and otherwise use their
  existing default. They no longer run ffprobe to discover embedded timecode.
- Compression and multipart-size controls are removed from settings. Attempts
  to change those settings through the API return 410; existing database columns
  are retained for compatibility and rollback.
- The multipart abort endpoint remains for historical raw uploads. It verifies
  ownership and stored identifiers and locks the version before changing it.
  An ordinary abort does not delete an assembled original or enqueue processing.
  Explicit discard remains destructive. Ingest uploads must be managed in Ingest.

## Downloads

Existing original and derived-file downloads keep their authorization rules.
An Ingest `master.m3u8` is a playlist, not an original video: it is never offered
as the original. If no original was stored, FreeFrame cannot recover one.

HLS downloads return a streamed ZIP containing the master, referenced playlists
and their local dependencies. No FFmpeg, remuxing, recompression or staging file
is involved. Download permission is checked before issuing a purpose-specific
15-minute download token. Treat that URL as a temporary bearer credential.
Playback tokens cannot authorize archive downloads.

Archives reject references outside the version directory, remote URLs, malformed
playlists and excessive playlist metadata (2 MiB per playlist, 16 MiB total,
20,000 referenced files). These are manifest limits, not a video byte-size limit.
Segments are read conditionally against their storage ETags. If an object changes,
storage fails or the client disconnects during transfer, the ZIP may be incomplete;
retry the download. Archives proxy the video bytes through the API and consume
bandwidth and request capacity; high-concurrency performance has not been measured.

## Upgrade and rollback

The local Compose definitions omit `worker`. Redis, `email_worker`,
`maintenance_worker` and `beat` remain necessary. The GPU overlay is a no-op;
the installer skips GPU preparation for a Compose definition without a media
worker. Historical installer GPU paths remain for older releases.

Before a separately authorized deployment:

1. Verify backups and test the complete Electron → Ingest → storage → web flow
   against isolated data, including resume, playback, sharing and downloads.
2. Inventory uploads, running jobs and the old `transcoding` queue. Allow an
   existing worker to finish authorized work or stop it deliberately before
   switching; do not purge queues or mass-update processing states.
3. Replace Dokploy's custom startup patch scripts with the reviewed images and
   configuration. Repository Compose changes do not update an existing Dokploy
   definition or stop its containers automatically.
4. Restart API, frontend, maintenance, email and scheduler using matching code.
   Review retention and orphan-sweep settings independently; this change does not
   disable scheduled deletion or Ingest's own purge endpoints.
5. For rollback, restore the matching prior code, images and Compose files.
   Inspect retained old jobs before starting a legacy media worker, because it
   can consume queued jobs immediately. Do not restore a database blindly over
   newer data.

The repository change performs no deployment, queue purge, database migration
or production data cleanup. Full validation is tracked in
[`plan-sin-worker-multimedia.md`](plan-sin-worker-multimedia.md).
