import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'
import { row, signInAs } from '@/test/upload-session'

beforeEach(() => {
  testing.reset()
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(api.get).mockResolvedValue([])
  signInAs('user-1')
  useUploadStore.setState({ files: [row({ id: 'r', ownerId: 'user-1', assetName: 'Rushes', assetId: 'a1', status: 'interrupted' })] })
})

describe('renaming historical uploads without initiating transfers', () => {
  it('renames the existing asset as its owner', async () => {
    vi.mocked(api.patch).mockResolvedValue({} as never)
    await useUploadStore.getState().renameUpload('r', 'Ep04')
    expect(api.patch).toHaveBeenCalledWith('/assets/a1', { name: 'Ep04' }, { pinSubject: 'user-1' })
    expect(useUploadStore.getState().files[0]).toMatchObject({ assetName: 'Ep04', status: 'interrupted' })
    expect(api.post).not.toHaveBeenCalled()
  })

  it('preserves the original name on refusal and allows the same rename to be retried', async () => {
    vi.mocked(api.patch).mockRejectedValue(new Error('Name too long'))
    expect(await useUploadStore.getState().renameUpload('r', 'Ep04')).toBe('Name too long')
    expect(useUploadStore.getState().files[0]).toMatchObject({ assetName: 'Rushes', status: 'interrupted' })
    vi.mocked(api.patch).mockResolvedValue({} as never)
    await useUploadStore.getState().renameUpload('r', 'Ep04')
    expect(useUploadStore.getState().files[0]).toMatchObject({ assetName: 'Ep04', renameError: undefined })
    expect(api.post).not.toHaveBeenCalled()
  })

  it('does not create an asset when renaming a historical row without one', async () => {
    useUploadStore.setState({ files: [row({ id: 'r', ownerId: 'user-1', assetId: undefined, assetName: 'Rushes', status: 'failed' })] })
    await useUploadStore.getState().renameUpload('r', 'Ep04')
    expect(api.patch).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
  })
})
