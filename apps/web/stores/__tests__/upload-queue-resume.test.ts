import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { useUploadStore, resumeClaimKey, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs, row } from '@/test/upload-session'

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  localStorage.clear()
  vi.mocked(api.get).mockResolvedValue([])
  useUploadStore.setState({ files: [], dropNotes: [] })
  signInAs('user-1')
  vi.mocked(api.get).mockClear()
})
afterEach(() => { testing.reset(); vi.useRealTimers() })

describe('retired resume preserves historical uploads', () => {
  it.each(['interrupted', 'uploading', 'failed', 'elsewhere', 'queued'] as const)(
    '%s cannot acquire a claim, sign parts, or mutate remote identifiers', (status) => {
      vi.useFakeTimers()
      const original = row({ id: 'r', status, ownerId: 'user-1', assetId: 'a', versionId: 'v', uploadId: 'u', s3Key: 'raw/key', progress: 45 })
      useUploadStore.setState({ files: [original] })
      const stored = localStorage.getItem('ff-uploads')
      useUploadStore.getState().resumeUpload('r', new File(['data'], 'clip.mp4'))
      vi.advanceTimersByTime(60_000)
      expect(useUploadStore.getState().files).toEqual([original])
      expect(localStorage.getItem(resumeClaimKey('v'))).toBeNull()
      expect(localStorage.getItem('ff-uploads')).toBe(stored)
      expect(api.get).not.toHaveBeenCalled()
      expect(api.post).not.toHaveBeenCalled()
      expect(testing.runningIds()).toEqual([])
      expect(useUploadStore.getState().dropNotes.at(-1)?.text).toContain('Electron/Ingest')
    },
  )

  it('does not replace a claim owned by another tab', () => {
    const key = resumeClaimKey('v')
    const claim = JSON.stringify({ tabId: 'other-tab', nonce: 'other', expiresAt: Date.now() + 60_000 })
    localStorage.setItem(key, claim)
    useUploadStore.setState({ files: [row({ id: 'r', versionId: 'v' })] })
    useUploadStore.getState().resumeUpload('r', new File(['data'], 'clip.mp4'))
    expect(localStorage.getItem(key)).toBe(claim)
    expect(api.post).not.toHaveBeenCalled()
  })
})
