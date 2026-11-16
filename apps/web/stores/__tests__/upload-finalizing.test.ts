import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
}))

import { api } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'
import { useUploadSpeedStore } from '../upload-speed-store'
import { row, signInAs } from '@/test/upload-session'
import { answerBatch } from '@/test/assets-batch'

beforeEach(() => {
  testing.reset()
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(api.get).mockResolvedValue([])
  signInAs('u1')
})

describe('historical finalization after multimedia retirement', () => {
  it.each(['ready', 'failed', 'processing'])('reconciles %s without another completion request', async (processing_status) => {
    useUploadStore.setState({ files: [row({ id: 'r', ownerId: 'u1', status: 'interrupted', finalizing: true, assetId: 'a', versionId: 'v', progress: 100 })] })
    vi.mocked(api.get).mockImplementation(answerBatch([{ id: 'a', latest_version: { id: 'v', processing_status } }]) as never)
    await useUploadStore.getState().refreshProcessingItems()
    expect(useUploadStore.getState().files[0].status).toBe(processing_status === 'ready' ? 'complete' : 'failed')
    expect(api.post).not.toHaveBeenCalled()
    expect(useUploadSpeedStore.getState().rates.r).toBeUndefined()
  })

  it('does not report transfer speed or finalization for refused new files', () => {
    useUploadStore.setState({ files: [] })
    const before = useUploadSpeedStore.getState().rates
    expect(useUploadStore.getState().startUpload(new File(['video'], 'clip.mp4'), 'p', 'clip')).toBeNull()
    expect(useUploadStore.getState().files).toEqual([])
    expect(useUploadSpeedStore.getState().rates).toEqual(before)
    expect(api.post).not.toHaveBeenCalled()
  })
})
