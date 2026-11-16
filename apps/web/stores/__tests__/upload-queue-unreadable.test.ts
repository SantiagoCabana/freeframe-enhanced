import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { createPartBudget, type PartBudget } from '@/lib/upload-budget'
import { FileUnreadableError } from '@/lib/upload-readable'
import { signInAs, row } from '@/test/upload-session'
import { installXhrFake, fail } from '@/test/xhr-fake'
import { MB, fileOf, drop } from '@/test/upload-queue-server'
import { useUploadStore, uploadAllParts, __uploadQueueTesting as testing } from '../upload-store'

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  signInAs('owner')
  useUploadStore.setState({ files: [] })
})
afterEach(() => { testing.reset(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('retired queue never reads local media', () => {
  it.each(['NotFoundError', 'NotReadableError', 'SecurityError'])('refuses a new or resumed %s file without reading it', async (name) => {
    const file = fileOf('clip.mov')
    const read = vi.spyOn(file, 'slice').mockImplementation(() => { throw new DOMException('unavailable', name) })
    const previous = row({ id: 'old', status: 'interrupted', versionId: 'v', uploadId: 'u', s3Key: 'raw/k' })
    useUploadStore.setState({ files: [previous] })
    expect(drop([file])).toEqual([])
    await useUploadStore.getState().resumeUpload('old', file)
    expect(read).not.toHaveBeenCalled()
    expect(vi.mocked(api.get).mock.calls.filter(([path]) => !path.startsWith('/me/assets'))).toEqual([])
    expect(api.post).not.toHaveBeenCalled()
    expect(useUploadStore.getState().files).toEqual([previous])
    expect(useUploadStore.getState().canResume('old')).toBe(false)
  })
})

it('the legacy multipart helper releases its retry budget when a file becomes unreadable', async () => {
  vi.useFakeTimers()
  const events: string[] = []
  const real = createPartBudget(1)
  const budget: PartBudget = {
    size: real.size,
    acquire: async (key, signal, kind) => {
      events.push(`acquire ${kind}`)
      const release = await real.acquire(key, signal, kind)
      events.push(`granted ${kind}`)
      return () => { events.push(`release ${kind}`); release() }
    },
    sleeping: key => { events.push('sleeping'); real.sleeping(key) },
    woke: key => { events.push('woke'); real.woke(key) },
    setRank: real.setRank,
    forget: key => { events.push('forget'); real.forget(key) },
  }
  vi.mocked(api.post).mockImplementation((() => {
    events.push('presign')
    return Promise.resolve({ presigned_url: 'https://s3.test/x/1' })
  }) as never)
  const file = fileOf('a.mov', 10 * MB)
  installXhrFake(() => {
    const unreadable = new Blob()
    vi.spyOn(unreadable, 'arrayBuffer').mockImplementation(async () => {
      events.push('read')
      throw new DOMException('gone', 'NotFoundError')
    })
    vi.spyOn(file, 'slice').mockReturnValue(unreadable)
    return fail(503)
  })
  const ended = uploadAllParts(file, 'k', 'u', new AbortController(), () => {}, { budget, fileKey: 'f:1' }).catch(error => error)
  await vi.advanceTimersByTimeAsync(3_000)
  expect(await ended).toBeInstanceOf(FileUnreadableError)
  expect(events).toEqual([
    'acquire fresh', 'granted fresh', 'presign', 'sleeping', 'release fresh',
    'woke', 'acquire retry', 'granted retry', 'read', 'release retry', 'forget',
  ])
})
