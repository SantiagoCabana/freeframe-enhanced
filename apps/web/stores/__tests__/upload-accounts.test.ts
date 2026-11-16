/** Retiring producers must not weaken ownership of historical uploads. */
import { beforeEach, afterEach, it, expect, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>()
  return { ...real, api: { ...real.api, get: vi.fn(), post: vi.fn(), patch: vi.fn() } }
})
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, visibleFiles, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs, signOutElsewhere, writeTokenUnannounced, row, tokenFor } from '@/test/upload-session'

beforeEach(() => {
  vi.resetAllMocks()
  testing.reset()
  localStorage.clear()
  useUploadStore.setState({ files: [], panelOpen: false })
  vi.mocked(api.get).mockResolvedValue([])
  signOutElsewhere()
  signInAs('x')
})
afterEach(() => testing.reset())

it.each(['queued', 'interrupted', 'failed', 'complete'] as const)(
  'keeps %s history private across sign-out and account changes', (status) => {
    const original = row({ id: 'x-row', status, assetId: 'asset-x', versionId: 'version-x' })
    useUploadStore.setState({ files: [original, row({ id: 'y-row', ownerId: 'y' })] })
    expect(visibleFiles(useUploadStore.getState()).map(f => f.id)).toEqual(['x-row'])
    signOutElsewhere()
    expect(visibleFiles(useUploadStore.getState())).toEqual([])
    signInAs('y')
    expect(visibleFiles(useUploadStore.getState()).map(f => f.id)).toEqual(['y-row'])
    signInAs('x')
    expect(visibleFiles(useUploadStore.getState())[0]).toMatchObject({
      ownerId: 'x', assetId: 'asset-x', versionId: 'version-x',
    })
    expect(api.post).not.toHaveBeenCalled()
  },
)

it.each(['announced', 'unannounced', 'signed-out'])(
  'refuses discard under a different identity: %s', async (change) => {
    const original = row({ id: 'x-row', versionId: 'version-x', s3Key: 'raw/x', uploadId: 'upload-x' })
    useUploadStore.setState({ files: [original] })
    if (change === 'announced') signInAs('y')
    else if (change === 'unannounced') writeTokenUnannounced('y')
    else signOutElsewhere()
    vi.mocked(api.get).mockClear()
    await useUploadStore.getState().discardUpload('x-row')
    expect(api.get).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
    expect(useUploadStore.getState().files[0]).toMatchObject(original)
  },
)

it('pins an explicit legacy discard to its owner after the resume endpoint retires', async () => {
  useUploadStore.setState({ files: [row({ id: 'x-row', versionId: 'version-x', s3Key: 'raw/x', uploadId: 'upload-x' })] })
  vi.mocked(api.get).mockRejectedValue(new ApiError(410, 'Retired'))
  vi.mocked(api.post).mockResolvedValue(undefined)
  await useUploadStore.getState().discardUpload('x-row')
  expect(api.post).toHaveBeenCalledWith('/upload/abort', expect.objectContaining({
    version_id: 'version-x', upload_id: 'upload-x', s3_key: 'raw/x', discard: true,
  }), expect.objectContaining({ pinSubject: 'x' }))
})

it.each(['x', 'y'])( 'refuses new uploads without refreshing or changing %s tokens', (owner) => {
  signInAs(owner)
  localStorage.setItem('ff_refresh_token', `refresh-${owner}`)
  const file = new File(['bytes'], 'video.mp4', { type: 'video/mp4' })
  useUploadStore.getState().startUpload(file, 'project', 'video')
  expect(api.post).not.toHaveBeenCalled()
  expect(localStorage.getItem('ff_access_token')).toBe(tokenFor(owner))
  expect(localStorage.getItem('ff_refresh_token')).toBe(`refresh-${owner}`)
  expect(useUploadStore.getState().files).toEqual([])
})
