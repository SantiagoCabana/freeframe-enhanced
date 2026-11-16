import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { useUploadStore, visibleDropNotes, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { signInAs, signOutElsewhere } from '@/test/upload-session'
import type { Collected } from '../upload-folder-walk'
import { startDrop } from '../upload-drop'

const dest = { projectId: 'p1', projectName: 'Launch', folderId: 'f-here' }
const collected = (name: string, dirs: string[] = []): Collected => ({
  files: [{ file: new File(['media'], name), dirs }], unreadable: 0, unreadableFolders: 0,
})
const notes = () => visibleDropNotes(useUploadStore.getState()).map((n) => n.text)

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], dropNotes: [], panelOpen: false })
  signInAs('user-1')
  vi.mocked(api.get).mockImplementation(() => new Promise(() => {}) as never)
})
afterEach(() => { vi.restoreAllMocks(); testing.reset() })

describe('retired web drop entry point', () => {
  it.each(['clip.mov', 'image.jpg', 'sound.wav', 'unknown.bin'])('rejects %s before allocating folders or multipart uploads', async (name) => {
    expect(await startDrop(collected(name, ['parent', 'child']), dest)).toEqual({ kind: 'nothing' })
    expect(api.post).not.toHaveBeenCalled()
    expect(api.patch).not.toHaveBeenCalled()
    expect(useUploadStore.getState().files).toEqual([])
    expect(notes()).toEqual(['Web media uploads have been retired. Use Electron/Ingest.'])
    expect(useUploadStore.getState().panelOpen).toBe(true)
  })
  it('does not discard existing history when refusing a drop', async () => {
    const files = useUploadStore.getState().files
    await startDrop(collected('clip.mp4'), dest)
    expect(useUploadStore.getState().files).toBe(files)
  })
  it('refuses signed-out callers without writing notes for another account', async () => {
    expect(await startDrop(collected('clip.mov'), dest, null)).toEqual({ kind: 'signed-out' })
    expect(api.post).not.toHaveBeenCalled()
    expect(notes()).toEqual([])
  })
  it.each(['switch', 'logout'])('does not leak a pending drop after %s', async (action) => {
    let resolve!: (files: Collected) => void
    const pending = new Promise<Collected>((done) => { resolve = done })
    const result = startDrop(pending, dest)
    if (action === 'switch') signInAs('user-2')
    else signOutElsewhere()
    resolve(collected('private.mov'))
    expect(await result).toEqual({ kind: action === 'switch' ? 'account-changed' : 'signed-out' })
    expect(api.post).not.toHaveBeenCalled()
    expect(notes()).toEqual([])
  })
})
