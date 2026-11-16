/** Network recovery cannot restart the retired web upload queue. */
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
  useUploadStore.setState({ files: [], dropNotes: [] })
  vi.useFakeTimers()
})

afterEach(() => {
  testing.reset()
  vi.useRealTimers()
})

it.each(['connection', 'storage'] as const)(
  'keeps historical %s failures and their order when connectivity returns', async (reason) => {
    const rows = [3, 1, 2].map((id) => row({
      id: String(id), status: 'failed', holdReason: reason, queueSeq: id,
      versionId: `version-${id}`, uploadId: `upload-${id}`, s3Key: `raw/${id}/file`,
    }))
    useUploadStore.setState({ files: rows })
    for (const previous of rows) useUploadStore.getState().retryUpload(previous.id)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(useUploadStore.getState().files).toEqual(rows)
    expect(api.post).not.toHaveBeenCalled()
    expect(testing.runningIds()).toEqual([])
  },
)

it('a new drop during an outage neither starts nor replaces historical failures', async () => {
  const old = row({ id: 'old', status: 'failed', error: 'Storage unavailable' })
  useUploadStore.setState({ files: [old] })
  vi.mocked(api.post).mockRejectedValue(new TypeError('Failed to fetch'))
  const result = useUploadStore.getState().startUploads([
    { file: new File(['x'], 'new.mp4'), assetName: 'new' },
  ], 'project', 'Project', null)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(result).toEqual([])
  expect(useUploadStore.getState().files).toEqual([old])
  expect(api.post).not.toHaveBeenCalled()
  expect(useUploadStore.getState().dropNotes.at(-1)?.text).toContain('Electron/Ingest')
})
