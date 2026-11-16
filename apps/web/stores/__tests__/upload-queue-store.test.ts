/** Retired queues never allocate storage, including after restoring old rows. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { signInAs, row } from '@/test/upload-session'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'

beforeEach(() => {
  vi.resetAllMocks()
  testing.reset()
  localStorage.clear()
  vi.mocked(api.get).mockResolvedValue([])
  signInAs('user-x')
  useUploadStore.setState({ files: [], dropNotes: [], panelOpen: false })
  vi.mocked(api.get).mockClear()
})

afterEach(() => {
  testing.reset()
  vi.useRealTimers()
})

it.each(['video/mp4', 'audio/wav', 'image/png', 'application/octet-stream'])(
  'refuses %s before reading the file or allocating any queue entries', (type) => {
    const file = new File(['media'], 'file', { type })
    const read = vi.spyOn(file, 'slice')
    const previous = row({ id: 'historical', status: 'complete' })
    useUploadStore.setState({ files: [previous] })
    expect(useUploadStore.getState().startUploads([
      { file, assetName: 'first' }, { file, assetName: 'duplicate' },
    ], 'project', 'Project', null)).toEqual([])
    expect(useUploadStore.getState().files).toEqual([previous])
    expect(testing.runningIds()).toEqual([])
    expect(read).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
    expect(useUploadStore.getState().dropNotes.at(-1)?.text).toContain('Electron/Ingest')
  },
)

it('an empty selection leaves the panel closed', () => {
  expect(useUploadStore.getState().startUploads([], 'p', 'Project', null)).toEqual([])
  expect(useUploadStore.getState().panelOpen).toBe(false)
  expect(useUploadStore.getState().dropNotes).toEqual([])
})

it.each(['queued', 'starting', 'uploading', 'interrupted', 'failed'] as const)(
  'retrying a historical %s row never starts work or overwrites its identifiers', async (status) => {
    vi.useFakeTimers()
    const previous = row({ id: 'old', status, versionId: 'v', uploadId: 'u', s3Key: 'raw/p/a/v/file' })
    useUploadStore.setState({ files: [previous] })
    useUploadStore.getState().retryUpload('old')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(useUploadStore.getState().files).toEqual([previous])
    expect(useUploadStore.getState().canRetry('old')).toBe(false)
    expect(api.post).not.toHaveBeenCalled()
    expect(testing.runningIds()).toEqual([])
  },
)

it('restoring a queued resume preserves its owner and server identifiers without reviving it', async () => {
  const previous = row({
    id: 'old', status: 'interrupted', queuedResume: true, ownerId: 'user-x',
    versionId: 'v', uploadId: 'u', s3Key: 'raw/p/a/v/file',
  })
  useUploadStore.setState({ files: [previous] })
  await useUploadStore.persist.rehydrate()
  expect(useUploadStore.getState().files[0]).toMatchObject({
    ownerId: 'user-x', versionId: 'v', uploadId: 'u', status: 'interrupted',
  })
  expect(useUploadStore.getState().canResume('old')).toBe(false)
  expect(api.post).not.toHaveBeenCalled()
})
