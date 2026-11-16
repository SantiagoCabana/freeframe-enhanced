/** Compatibility entry point for old pick/drop callers; never creates folders or uploads. */
import { currentSubject } from '@/lib/upload-owner'
import type { Collected } from '@/lib/upload-folder-walk'
import { useUploadStore } from '@/stores/upload-store'

export interface DropDestination {
  projectId: string
  projectName?: string
  folderId: string | null
}

export type DropOutcome =
  | { kind: 'queued'; ids: string[] }
  | { kind: 'nothing' }
  | { kind: 'failed' }
  | { kind: 'signed-out' }
  | { kind: 'account-changed' }

export async function startDrop(
  collected: Collected | Promise<Collected>,
  _dest: DropDestination,
  owner: string | null = currentSubject(),
): Promise<DropOutcome> {
  if (owner === null) return { kind: 'signed-out' }
  await collected
  const now = currentSubject()
  if (now !== owner) return { kind: now === null ? 'signed-out' : 'account-changed' }
  useUploadStore.getState().addDropNote('Web media uploads have been retired. Use Electron/Ingest.', owner)
  return { kind: 'nothing' }
}
