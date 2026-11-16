/**
 * `canResume(id)`: whether a Resume of this row would be taken up now.
 *
 * The panel offers Resume only when this is true. It has to agree with
 * `resumeUpload`, which refuses silently, so a button that the store would
 * ignore is a button that does nothing: a row that is not `interrupted`, one
 * already waiting for its turn, one a run is still settling, one whose Discard
 * is out. And, because the answer reads state that no row field mirrors (the
 * runs, the Discards), a change in either has to reach a subscriber that is
 * watching nothing else.
 *
 * The API is mocked but `ApiError` is the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs, row } from '@/test/upload-session'
import { MB, fileOf, settle } from '@/test/upload-queue-server'

const interrupted = (over: Parameters<typeof row>[0] = {}) =>
  row({
    id: 'r', status: 'interrupted', fileSize: 50 * MB,
    assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
    ...over,
  })

const canResume = (id = 'r') => useUploadStore.getState().canResume(id)

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  signInAs('user-1')
})

afterEach(() => {
  vi.restoreAllMocks()
  testing.reset()
})

describe('canResume', () => {
  it('is false for an interrupted row after server processing retirement', () => {
    useUploadStore.setState({ files: [interrupted()] })

    expect(canResume()).toBe(false)
  })

  it('is false for a row that is not interrupted, has no upload to come back to, or does not exist', () => {
    useUploadStore.setState({
      files: [
        interrupted({ id: 'no-version', versionId: undefined }),
        ...(['queued', 'starting', 'uploading', 'processing', 'complete', 'failed', 'cancelled', 'elsewhere'] as const)
          .map((status) => interrupted({ id: status, status })),
      ],
    })

    for (const f of useUploadStore.getState().files) expect(canResume(f.id)).toBe(false)
    expect(canResume('nobody')).toBe(false)
  })

  it('is false for a resume already waiting for its turn', () => {
    useUploadStore.setState({ files: [interrupted({ queuedResume: true })] })

    expect(canResume()).toBe(false)
  })

  it('refuses a stale Resume action without reading parts or changing its history', async () => {
    useUploadStore.setState({ files: [interrupted()] })
    const before = useUploadStore.getState().files
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', 50 * MB))
    await settle()
    expect(api.get).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
    expect(useUploadStore.getState().files).toBe(before)
    expect(useUploadStore.getState().panelOpen).toBe(true)
    expect(canResume()).toBe(false)
  })

  it('remains false while a Discard is in flight and after storage fails', async () => {
    let failParts!: (err: unknown) => void
    vi.mocked(api.get).mockImplementation(() => new Promise((_, reject) => {
      failParts = reject
    }) as never)
    useUploadStore.setState({ files: [interrupted()] })
    const seen: boolean[] = []
    const stop = useUploadStore.subscribe((s) => {
      const now = s.canResume('r')
      if (seen[seen.length - 1] !== now) seen.push(now)
    })

    const discarded = useUploadStore.getState().discardUpload('r')
    await settle()
    expect(canResume()).toBe(false)

    failParts(new ApiError(503, 'Storage is not answering'))
    expect(await discarded).toBe('Storage is not answering')
    stop()

    expect(canResume()).toBe(false)
    expect(seen).toEqual([false])
  })
})

describe('a Discard that failed', () => {
  it('preserves the discard error when a stale Resume action is invoked', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(503, 'Storage is not answering'))
    useUploadStore.setState({ files: [interrupted()] })

    await useUploadStore.getState().discardUpload('r')

    expect(useUploadStore.getState().files[0]).toMatchObject({
      status: 'interrupted', error: 'Storage is not answering', discardFailed: true,
    })

    vi.mocked(api.get).mockClear()
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', 50 * MB))
    await settle()

    expect(api.get).not.toHaveBeenCalled()
    expect(useUploadStore.getState().files[0].discardFailed).toBe(true)
    expect(useUploadStore.getState().files[0].error).toBe('Storage is not answering')
  })
})
