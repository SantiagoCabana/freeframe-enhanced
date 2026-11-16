import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'
import { row, signInAs } from '@/test/upload-session'
import { answerBatch } from '@/test/assets-batch'

beforeEach(() => {
  testing.reset()
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(api.get).mockResolvedValue([])
  signInAs('user-1')
  useUploadStore.setState({ files: [row({ id: 'r', ownerId: 'user-1', status: 'interrupted', assetId: 'a', versionId: 'v', uploadId: 'u', s3Key: 'raw/key', progress: 100 })] })
})

describe('historical completion reconciliation without media workers', () => {
  it.each([
    ['ready', 'complete'],
    ['failed', 'failed'],
    ['processing', 'failed'],
  ])('reconciles %s using a read, without completing or deleting storage', async (processing_status, status) => {
    vi.mocked(api.get).mockImplementation(answerBatch([{ id: 'a', latest_version: { id: 'v', processing_status } }]) as never)
    await useUploadStore.getState().refreshProcessingItems()
    expect(useUploadStore.getState().files[0]).toMatchObject({ status, versionId: 'v', uploadId: 'u', s3Key: 'raw/key' })
    expect(api.post).not.toHaveBeenCalled()
  })

  it.each([new TypeError('offline'), new ApiError(503, 'unavailable')])('preserves identifiers on a failed read (%s)', async (error) => {
    const before = useUploadStore.getState().files[0]
    vi.mocked(api.get).mockRejectedValue(error)
    await useUploadStore.getState().refreshProcessingItems()
    expect(useUploadStore.getState().files[0]).toEqual(before)
    expect(api.post).not.toHaveBeenCalled()
  })

  it('does not apply another version’s completion to the historical row', async () => {
    vi.mocked(api.get).mockImplementation(answerBatch([{ id: 'a', latest_version: { id: 'new-version', processing_status: 'ready' } }]) as never)
    await useUploadStore.getState().refreshProcessingItems()
    expect(useUploadStore.getState().files[0]).toMatchObject({ status: 'interrupted', versionId: 'v' })
    expect(api.post).not.toHaveBeenCalled()
  })

  it('does not resurrect a row removed while a read was in flight', async () => {
    let answer!: (value: unknown) => void
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => { answer = resolve }) as never)
    const pending = useUploadStore.getState().refreshProcessingItems()
    useUploadStore.setState({ files: [] })
    answer([{ id: 'a', latest_version: { id: 'v', processing_status: 'ready' } }])
    await pending
    expect(useUploadStore.getState().files).toEqual([])
    expect(api.post).not.toHaveBeenCalled()
  })
})
