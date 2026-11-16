/** Retired queues may be cleared locally without discarding stored media. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { row, signInAs } from '@/test/upload-session'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'

beforeEach(() => {
  vi.resetAllMocks()
  testing.reset()
  localStorage.clear()
  vi.mocked(api.get).mockResolvedValue([])
  signInAs('user-1')
  useUploadStore.setState({ files: [] })
})

afterEach(() => testing.reset())

it('cancels a never-started local row without touching storage or the next row', () => {
  const next = row({ id: 'next', status: 'queued', ownerId: 'user-1' })
  useUploadStore.setState({ files: [row({ id: 'first', status: 'queued' }), next] })
  useUploadStore.getState().cancelUpload('first')
  expect(useUploadStore.getState().files).toEqual([next])
  expect(api.post).not.toHaveBeenCalled()
  expect(testing.runningIds()).toEqual([])
})

it('cancels an old resume request but preserves its uploaded parts and ownership', () => {
  const old = row({
    status: 'interrupted', ownerId: 'user-1', queuedResume: true,
    holdReason: 'connection', versionId: 'version', uploadId: 'multipart', s3Key: 'raw/file',
  })
  useUploadStore.setState({ files: [old] })
  useUploadStore.getState().cancelUpload(old.id)
  expect(useUploadStore.getState().files).toEqual([
    { ...old, queuedResume: undefined, holdReason: undefined },
  ])
  expect(api.post).not.toHaveBeenCalled()
})

it('cancel-all only clears the signed-in account’s waiting rows', () => {
  const foreign = row({ id: 'foreign', ownerId: 'other', status: 'queued' })
  const completed = row({ id: 'complete', ownerId: 'user-1', status: 'complete' })
  const interrupted = row({ id: 'resume', ownerId: 'user-1', status: 'interrupted', queuedResume: true, versionId: 'v' })
  useUploadStore.setState({ files: [foreign, completed, interrupted, row({ id: 'queued', ownerId: 'user-1', status: 'queued' })] })
  useUploadStore.getState().cancelAllQueued()
  expect(useUploadStore.getState().files).toEqual([
    foreign, completed, { ...interrupted, queuedResume: undefined, holdReason: undefined },
  ])
  expect(api.post).not.toHaveBeenCalled()
})

it('an unknown row is a no-op', () => {
  const old = row({ status: 'failed', versionId: 'v' })
  useUploadStore.setState({ files: [old] })
  useUploadStore.getState().cancelUpload('missing')
  expect(useUploadStore.getState().files).toEqual([old])
  expect(api.post).not.toHaveBeenCalled()
})
