/**
 * Resuming an upload that stopped part-way.
 *
 * The point of the feature is what does NOT go over the wire: parts the storage
 * backend is already holding are not sent again. The server decides which those
 * are and which byte ranges they cover, so the tests here are mostly about the
 * client doing what it is told rather than what its own constants say.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) {
      super(detail)
      this.name = 'ApiError'
      this.status = status
      this.detail = detail
    }
  },
}))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, uploadAllParts, __uploadQueueTesting } from '../upload-store'
import type { UploadFile } from '../upload-store'
import { installXhrFake, ok, fail, type PartHandler } from '@/test/xhr-fake'
import { createPartBudget } from '@/lib/upload-budget'
import { signInAs } from '@/test/upload-session'
import { answerBatch, batchIds } from '@/test/assets-batch'

// The upload queue is tab-wide module state: start every test from an empty one.
beforeEach(() => __uploadQueueTesting.reset())
// Rows belong to the account that added them, and only it can resume them.
beforeEach(() => signInAs('u1'))

/** A budget of `n` slots for one file, which is what the old `concurrency` argument was. */
const slots = (n: number) => ({ budget: createPartBudget(n), fileKey: 'f' })

const MB = 1024 * 1024
const CHUNK = 10 * MB
const VERSION_ID = 'version-1'
const ASSET_ID = 'asset-1'
/** 23 MB is two full parts and a 3 MB remainder. */
const TOTAL = 23 * MB

function makeFile(bytes = TOTAL, name = 'clip.mp4'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'video/mp4' })
}

function resumeInfo(overrides: Record<string, unknown> = {}) {
  return {
    state: 'resumable',
    upload_id: 'u1',
    s3_key: 'raw/p/a/v/original.mp4',
    asset_id: ASSET_ID,
    version_id: VERSION_ID,
    chunk_size_bytes: CHUNK,
    file_size_bytes: TOTAL,
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    held_part_numbers: [],
    ...overrides,
  }
}

/** An interrupted row, as the panel would be showing it. */
function seedInterrupted() {
  useUploadStore.setState({
    files: [{
      id: 'row-1',
      fileName: 'clip.mp4',
      fileSize: TOTAL,
      fileType: 'video/mp4',
      projectId: 'project-1',
      assetName: 'clip',
      progress: 0,
      processingProgress: 0,
      status: 'interrupted',
      assetId: ASSET_ID,
      versionId: VERSION_ID,
      createdAt: Date.now(),
      ownerId: 'u1',
    }],
  })
}

function rowOf(id: string) {
  return useUploadStore.getState().files.find((f) => f.id === id)!
}

/** The part number a presigned URL names, so a PUT mock can tell parts apart. */
function mockPresignPerPart() {
  return vi.mocked(api.post).mockImplementation((path: string, body?: unknown) => {
    if (path === '/upload/presign-part') {
      return Promise.resolve({
        presigned_url: `https://s3.example/part-${(body as { part_number: number }).part_number}`,
      }) as never
    }
    return Promise.resolve({}) as never
  })
}

/** Plays the storage backend for every part PUT; each part succeeds by default. */
let put = vi.fn<PartHandler>()
function mockPut(handler: PartHandler = () => ok('"etag"')) {
  put = vi.fn(handler)
  installXhrFake(put)
}

function partsSentTo(putMock: typeof put): number[] {
  return putMock.mock.calls
    .map(([url]) => Number(String(url).split('-').pop()))
    .sort((a, b) => a - b)
}

function completionBody(): Record<string, unknown> {
  const call = vi.mocked(api.post).mock.calls.find(([p]) => p === '/upload/complete')!
  return call[1] as Record<string, unknown>
}

// --------------------------------------------------------------- uploadAllParts

describe('uploadAllParts with parts already held', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPresignPerPart()
    mockPut()
  })

  it('does not send a part the backend already holds', async () => {
    await uploadAllParts(
      makeFile(), 'key', 'u1', new AbortController(), () => {},
      { ...slots(5), chunkSize: CHUNK, alreadyHeld: [1, 2] },
    )

    expect(partsSentTo(put)).toEqual([3])
  })

  it('counts the held parts as progress instead of starting again at zero', async () => {
    // A resume that reports 0% and then jumps is indistinguishable from one that
    // is re-sending everything, which is exactly the doubt this removes.
    const onProgress = vi.fn()

    await uploadAllParts(
      makeFile(), 'key', 'u1', new AbortController(), onProgress,
      { ...slots(5), chunkSize: CHUNK, alreadyHeld: [1, 2] },
    )

    // 20 of 23 MB, in bytes rather than in parts.
    expect(onProgress.mock.calls[0][0]).toBe(Math.round((20 / 23) * 95))
  })

  it('counts a held last part at its own length, not a full chunk', async () => {
    // What is held is a set, so the short tail can be in it while earlier parts
    // are not. Counting it as a whole chunk would start this resume at 41%.
    const onProgress = vi.fn()

    await uploadAllParts(
      makeFile(), 'key', 'u1', new AbortController(), onProgress,
      { ...slots(5), chunkSize: CHUNK, alreadyHeld: [3] },
    )

    expect(onProgress.mock.calls[0][0]).toBe(Math.round((3 / 23) * 95))
  })

  it('sends the parts that are missing from the middle, not just the tail', async () => {
    // Parts finish out of order once several are in flight, so what is held is a
    // set. Treating it as a prefix would re-send everything after the first hole.
    await uploadAllParts(
      makeFile(), 'key', 'u1', new AbortController(), () => {},
      { ...slots(5), chunkSize: CHUNK, alreadyHeld: [1, 3] },
    )

    expect(partsSentTo(put)).toEqual([2])
  })

  it('cuts the file on the chunk size it is given, not on its own constant', async () => {
    // A release that changes CHUNK_SIZE must not move the byte ranges of an
    // upload whose earlier parts are already in the bucket.
    await uploadAllParts(
      makeFile(TOTAL), 'key', 'u1', new AbortController(), () => {},
      { ...slots(5), chunkSize: 5 * MB },
    )

    // 23 MB at 5 MB per part is five parts, not three.
    expect(partsSentTo(put)).toEqual([1, 2, 3, 4, 5])
  })

  it('returns only the parts it actually sent', async () => {
    const parts = await uploadAllParts(
      makeFile(), 'key', 'u1', new AbortController(), () => {},
      { ...slots(5), chunkSize: CHUNK, alreadyHeld: [1, 2] },
    )

    // Not a sparse array with holes where the skipped parts would be: that
    // serialises as nulls and would be rejected by the completion schema.
    expect(parts).toEqual([{ PartNumber: 3, ETag: '"etag"' }])
  })
})

// ---------------------------------------------------------------- resumeUpload

describe('retired resumeUpload preserves historical state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedInterrupted()
    mockPresignPerPart()
    mockPut()
    vi.mocked(api.get).mockResolvedValue(resumeInfo({ held_part_numbers: [1, 2] }) as never)
  })

  it('does not send missing parts or complete the old upload', async () => {
    useUploadStore.getState().resumeUpload('row-1', makeFile())
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(partsSentTo(put)).toEqual([])
    expect(api.post).not.toHaveBeenCalled()
  })

  it('does not invent missing keys or upload IDs', async () => {
    // The row may have been rehydrated from history in a browser that never saw
    // either of them, which is the normal case after a closed tab.
    useUploadStore.getState().resumeUpload('row-1', makeFile())
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(api.get).not.toHaveBeenCalled()
    expect(rowOf('row-1').s3Key).toBeUndefined()
    expect(rowOf('row-1').uploadId).toBeUndefined()
  })

  it('preserves the version without fetching a new upload ID', async () => {
    // The row seeded here has no upload id, which is the normal shape of a row
    // this browser only knows from `/me/assets` or got back after storage was
    // cleared -- and those are exactly the rows this feature exists for.
    // Without writing it down, `standingOfStoredRow` reads the row as a
    // transfer that broke before initiate answered and fails it: the panel
    // offers a failed row nothing but Dismiss, and re-uploading instead
    // strands the multipart upload until the reaper.
    expect(rowOf('row-1').uploadId).toBeUndefined()

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(rowOf('row-1').uploadId).toBeUndefined()
    expect(rowOf('row-1').versionId).toBe(VERSION_ID)
  })

  it('preserves a historical upload ID through rehydration', async () => {
    // The whole point of recording it: this is the same rehydration the fresh
    // upload paths already survive.
    vi.mocked(api.get).mockResolvedValue(resumeInfo({ held_part_numbers: [1, 2] }) as never)
    useUploadStore.getState().resumeUpload('row-1', makeFile())
    expect(rowOf('row-1').status).toBe('interrupted')

    const opts = (useUploadStore as unknown as {
      persist: { getOptions: () => { merge?: (p: unknown, c: unknown) => { files: UploadFile[] } } }
    }).persist.getOptions()
    const stored = { ...rowOf('row-1'), uploadId: 'historical', status: 'uploading' as const }
    const [rehydrated] = opts.merge!({ files: [stored] }, { files: [] }).files

    expect(rehydrated.status).toBe('interrupted')
  })

  it('does not submit an incomplete parts list', async () => {
    // The list is only read by a backend that cannot list its own parts, and a
    // resumed upload cannot produce a complete one: it never saw the ETags of
    // the parts it did not send. A partial list completes a truncated object
    // with no error on most backends. None makes such a backend refuse instead.
    useUploadStore.getState().resumeUpload('row-1', makeFile())
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('does not submit a parts list even when storage holds no parts', async () => {
    vi.mocked(api.get).mockResolvedValue(resumeInfo({ held_part_numbers: [] }) as never)

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('refuses a file of a different size', async () => {
    // The user picks the file again by hand. A different file of the same name
    // would be spliced onto the parts already in the bucket, and nothing
    // downstream would notice.
    useUploadStore.getState().resumeUpload('row-1', makeFile(TOTAL - 1))
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('interrupted'))

    expect(put).not.toHaveBeenCalled()
    // Short enough to survive the panel row's truncation, and it says what is
    // wrong rather than repeating the name of the file just picked.
    expect(rowOf('row-1').error).toBeUndefined()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('refuses a renamed file without changing the historical error', async () => {
    useUploadStore.getState().resumeUpload('row-1', makeFile(TOTAL, 'other.mp4'))
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('interrupted'))

    expect(put).not.toHaveBeenCalled()
    expect(rowOf('row-1').error).toBeUndefined()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('does not complete an assembled upload through the retired API', async () => {
    // CompleteMultipartUpload ran and only the status write is outstanding, so
    // there is nothing to send -- and refusing over a renamed file would strand
    // an upload that is whole.
    vi.mocked(api.get).mockResolvedValue(resumeInfo({ state: 'assembled' }) as never)

    useUploadStore.getState().resumeUpload('row-1', makeFile(1, 'renamed.mp4'))
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(put).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('stays resumable when the transfer breaks again', async () => {
    // A 403 rather than a dropped connection, so this does not spend the part
    // retry ladder's four minutes reaching the same place.
    mockPut(() => fail(403, 'Forbidden'))

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('interrupted'))

    // And nothing was aborted, so the next attempt starts from further along
    // than this one did.
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === '/upload/abort')).toBe(false)
  })

  it('does not request the retired parts endpoint to reinterpret a refusal', async () => {
    // A 409 is the server stating this version is no longer uploading. Offering
    // another resume would walk the user round the same loop.
    vi.mocked(api.get).mockRejectedValue(new ApiError(409, 'This upload is already failed.'))

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(api.get).not.toHaveBeenCalled()
  })

  it('does not invent completion from a resume attempt', async () => {
    // `/parts` answers 409 for any status that is not `uploading`, which
    // includes `processing` and `ready`. Taken as final, that put a red Failed
    // badge reading "This upload is already ready." on a file that uploaded and
    // transcoded perfectly -- the one message the mapping got wrong.
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (String(path).startsWith('/upload/')) {
        return Promise.reject(new ApiError(409, 'This upload is already ready.'))
      }
      return Promise.resolve({
        id: ASSET_ID,
        latest_version: { id: VERSION_ID, processing_status: 'ready' },
      }) as never
    })

    useUploadStore.getState().resumeUpload('row-1', makeFile())

    expect(rowOf('row-1').status).toBe('interrupted')
    expect(rowOf('row-1').progress).toBe(0)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('leaves status reconciliation to read-only history polling', async () => {
    // The refusal is only worth a second question, not the benefit of the doubt.
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (String(path).startsWith('/upload/')) {
        return Promise.reject(new ApiError(409, 'This upload is already failed.'))
      }
      return Promise.resolve({
        id: ASSET_ID,
        latest_version: { id: VERSION_ID, processing_status: 'failed' },
      }) as never
    })

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(api.get).not.toHaveBeenCalled()
  })

  it('stays resumable when the server merely could not be reached', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(503, 'Could not reach storage.'))

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('interrupted'))
  })

  it('does nothing for a row that is not interrupted', async () => {
    useUploadStore.setState((s) => ({
      files: s.files.map((f) => ({ ...f, status: 'processing' as const })),
    }))

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await new Promise((r) => setTimeout(r, 20))

    expect(api.get).not.toHaveBeenCalled()
  })
})

// --------------------------------------------------------------- discardUpload

describe('discardUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedInterrupted()
    vi.mocked(api.get).mockResolvedValue(resumeInfo() as never)
    vi.mocked(api.post).mockResolvedValue({} as never)
  })

  it('aborts the upload the user chose to be rid of', async () => {
    // The counterpart to no longer aborting on failure: this is now the only
    // path that discards parts, and a person asked for it.
    await useUploadStore.getState().discardUpload('row-1')

    expect(api.post).toHaveBeenCalledWith('/upload/abort', {
      s3_key: 'raw/p/a/v/original.mp4',
      upload_id: 'u1',
      version_id: VERSION_ID,
      discard: true,
    }, { pinSubject: 'u1' })
    expect(useUploadStore.getState().files).toEqual([])
  })

  it('says it is a discard, so nothing is published and nothing is left failed', async () => {
    // A plain abort publishes an upload whose object is already whole, and
    // leaves a red Failed badge in the version switcher for one that is not --
    // for a version somebody deliberately threw away. The flag is what tells
    // the two apart.
    await useUploadStore.getState().discardUpload('row-1')

    const abort = vi.mocked(api.post).mock.calls.find(([p]) => p === '/upload/abort')!
    expect(abort[1]).toMatchObject({ version_id: VERSION_ID, discard: true })
  })

  it('says the version list changed, once the server has answered', async () => {
    // The switcher is refreshed by transcode events, and a discard produces
    // none: it went on offering a version that had been deleted, still
    // labelled "Uploading". The signal comes after the request, because the row
    // leaves the panel before it and refetching then fetches the version back.
    const before = useUploadStore.getState().versionsRevision
    let abortResolved = false
    vi.mocked(api.post).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10))
      abortResolved = true
      return {} as never
    })

    await useUploadStore.getState().discardUpload('row-1')

    expect(abortResolved).toBe(true)
    expect(useUploadStore.getState().versionsRevision).toBe(before + 1)
  })

  it('says so even when the server could not be told', async () => {
    // What the server managed before it stopped answering is not knowable here.
    const before = useUploadStore.getState().versionsRevision
    vi.mocked(api.get).mockRejectedValue(new ApiError(503, 'Could not reach storage.'))

    await useUploadStore.getState().discardUpload('row-1')

    expect(useUploadStore.getState().versionsRevision).toBe(before + 1)
  })

  it('discards an already assembled upload too', async () => {
    vi.mocked(api.get).mockResolvedValue(resumeInfo({ state: 'assembled' }) as never)

    await useUploadStore.getState().discardUpload('row-1')

    const abort = vi.mocked(api.post).mock.calls.find(([p]) => p === '/upload/abort')!
    expect(abort[1]).toMatchObject({ discard: true })
    expect(useUploadStore.getState().files).toEqual([])
  })

  it('keeps the row, and says why, when the server cannot be told', async () => {
    // It used to leave the list before the request and swallow every failure,
    // so a 503 from unreachable storage left no row, no error, and a version the
    // reaper would not touch for a day.
    vi.mocked(api.post).mockRejectedValue(new ApiError(503, 'Could not reach storage.'))

    const refused = await useUploadStore.getState().discardUpload('row-1')

    expect(refused).toBe('Could not reach storage.')
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(rowOf('row-1').error).toBe('Could not reach storage.')
  })

  it('drops the row when there is no longer anything to discard', async () => {
    // 404: the reaper or another tab got there first.
    vi.mocked(api.get).mockRejectedValue(new ApiError(404, 'Version not found'))

    const refused = await useUploadStore.getState().discardUpload('row-1')

    expect(refused).toBeNull()
    expect(useUploadStore.getState().files).toEqual([])
    expect(api.post).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------- the chunk size a fresh upload cuts on

describe('retired new uploads ignore historical chunk settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUploadStore.setState({ files: [] })
    mockPut()
  })

  /** Initiate answers with `pinned`; everything after it succeeds. */
  function mockInitiate(pinned: number) {
    vi.mocked(api.post).mockImplementation((path: string, body?: unknown) => {
      if (path === '/upload/initiate' || String(path).endsWith('/versions')) {
        return Promise.resolve({
          upload_id: 'u1', s3_key: 'raw/k', asset_id: ASSET_ID,
          version_id: VERSION_ID, chunk_size_bytes: pinned,
        }) as never
      }
      if (path === '/upload/presign-part') {
        return Promise.resolve({
          presigned_url: `https://s3.example/part-${(body as { part_number: number }).part_number}`,
        }) as never
      }
      return Promise.resolve({}) as never
    })
  }

  it('does not allocate or send a new upload', async () => {
    // The column the migration adds records what the browser used. If the
    // browser uses something else, `_pinned_chunk_size` trusts the record,
    // every held part is rejected as the wrong size, and the upload the
    // pinning exists to rescue is the one that cannot be resumed.
    mockInitiate(5 * MB)

    useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')

    // 23 MB at 5 MB a part is five parts; at the client's own 10 MB it is three.
    expect(partsSentTo(put)).toEqual([])
    expect(api.post).not.toHaveBeenCalled()
  })

  it('does not allocate or send a new version', async () => {
    mockInitiate(5 * MB)

    useUploadStore.getState().startVersionUpload(makeFile(), ASSET_ID, 'clip', 'project-1')

    expect(partsSentTo(put)).toEqual([])
    expect(api.post).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------- reconciling against the server

describe('refreshProcessingItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function seedRow(over: Record<string, unknown>) {
    return {
      id: 'row-1', fileName: 'clip.mp4', fileSize: TOTAL, fileType: 'video/mp4',
      projectId: 'project-1', assetName: 'clip', progress: 0, processingProgress: 0,
      status: 'interrupted', assetId: ASSET_ID, versionId: VERSION_ID,
      createdAt: Date.now(), ownerId: 'u1', ...over,
    }
  }

  function assetWith(versionId: string, status: string) {
    return { id: ASSET_ID, latest_version: { id: versionId, processing_status: status } }
  }

  it('leaves an interrupted row alone when the answer is about another version', async () => {
    // `GET /assets/{id}` answers with the display version, which excludes
    // `uploading`, so for an interrupted v2 it hands back a ready v1. Taken at
    // face value the row was rewritten to complete: Resume and Discard
    // disappeared, the user was told the upload landed, and the parts sat in
    // the bucket until the reaper.
    useUploadStore.setState({ files: [seedRow({})] as never })
    vi.mocked(api.get).mockImplementation(answerBatch([assetWith('an-older-version', 'ready')]) as never)

    await useUploadStore.getState().refreshProcessingItems()

    expect(rowOf('row-1').status).toBe('interrupted')
  })

  it('still follows the answer when it is about its own version', async () => {
    // The reason interrupted rows are polled at all: the same upload can be
    // resumed from another tab or another machine.
    useUploadStore.setState({ files: [seedRow({})] as never })
    vi.mocked(api.get).mockImplementation(answerBatch([assetWith(VERSION_ID, 'processing')]) as never)

    await useUploadStore.getState().refreshProcessingItems()

    expect(rowOf('row-1').status).toBe('failed')
    expect(rowOf('row-1').error).toContain('Server processing retired')
  })

  it('applies the one answer two rows on one asset share only to the version it is about', async () => {
    // An interrupted v2 and a processing v3. The asset is asked about once, and
    // its answer names one version: the other row is left as it was rather
    // than being rewritten from an answer about someone else's version.
    useUploadStore.setState({
      files: [
        seedRow({ id: 'row-1', versionId: 'v2', status: 'interrupted' }),
        seedRow({ id: 'row-2', versionId: 'v3', status: 'processing' }),
      ] as never,
    })
    vi.mocked(api.get).mockImplementation(answerBatch([assetWith('v3', 'ready')]) as never)

    await useUploadStore.getState().refreshProcessingItems()

    expect(vi.mocked(api.get).mock.calls.map(([path]) => batchIds(path))).toEqual([[ASSET_ID]])
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(rowOf('row-2').status).toBe('complete')
  })
})

// -------------------------------------------------- surviving a reload mid-upload

describe('a row that was uploading when the tab reloaded', () => {
  /** What zustand's persist middleware does on the way in. */
  function rehydrate(stored: Record<string, unknown>[]): UploadFile[] {
    const opts = (useUploadStore as unknown as {
      persist: { getOptions: () => { merge?: (p: unknown, c: unknown) => { files: UploadFile[] } } }
    }).persist.getOptions()
    return opts.merge!({ files: stored }, { files: [] }).files
  }

  const inFlight = {
    id: 'row-1', fileName: 'clip.mp4', fileSize: TOTAL, fileType: 'video/mp4',
    projectId: 'project-1', assetName: 'clip', progress: 41, processingProgress: 0,
    status: 'uploading', assetId: ASSET_ID, versionId: VERSION_ID, uploadId: 'u1',
    createdAt: Date.now(), ownerId: 'u1',
  }

  it('comes back as interrupted rather than not at all', () => {
    // It used to be dropped, because history was expected to produce it again.
    // History reports the display version, which skips `uploading`, so for a
    // second version it produced the PREVIOUS version sitting at ready: the
    // panel showed one complete row, no Resume anywhere, and the parts stayed
    // in the bucket until the reaper. The row is the only thing that knows.
    const [row] = rehydrate([inFlight])

    expect(row.status).toBe('interrupted')
    expect(row.versionId).toBe(VERSION_ID)
    expect(row.uploadId).toBe('u1')
  })

  it('is failed, not interrupted, when it never got a version', () => {
    // Nothing to come back to: the same rule the upload loop applies when a
    // transfer breaks before initiate has answered.
    const [row] = rehydrate([{ ...inFlight, versionId: undefined, uploadId: undefined }])

    expect(row.status).toBe('failed')
  })

  it('is failed when it was sending and has no upload id, version or not', () => {
    // Each half of that condition stands on its own: a row can carry a version
    // id and no upload id, because the two are written in separate calls.
    // Tested apart from the case above, where the missing version id answers
    // first and hides whether the upload id is looked at at all.
    const [row] = rehydrate([{ ...inFlight, uploadId: undefined }])

    expect(row.status).toBe('failed')
  })

  it('does not fail an elsewhere row for having no upload id', () => {
    // A row from `/me/assets` never carries one -- the resume asks the server
    // -- so applying the rule to it turned an upload still running on another
    // device into a dead "Failed" on the next load.
    const [row] = rehydrate([{
      ...inFlight,
      status: 'elsewhere',
      uploadId: undefined,
      ownerTab: 'another-tab',
      heartbeatAt: Date.now(),
    }])

    expect(row.status).toBe('elsewhere')
  })

  it('leaves the rows it did not write alone', () => {
    const rows = rehydrate([
      { ...inFlight, id: 'a', status: 'interrupted' },
      { ...inFlight, id: 'b', status: 'failed' },
      { ...inFlight, id: 'c', status: 'cancelled' },
    ])

    expect(rows.map((r) => r.status)).toEqual(['interrupted', 'failed', 'cancelled'])
  })

  it('keeps an in-flight row in storage at all', () => {
    const opts = (useUploadStore as unknown as {
      persist: { getOptions: () => { partialize?: (s: unknown) => { files: UploadFile[] } } }
    }).persist.getOptions()
    const kept = opts.partialize!({
      files: [
        { ...inFlight, id: 'a', status: 'uploading' },
        { ...inFlight, id: 'b', status: 'processing' },
        { ...inFlight, id: 'c', status: 'complete' },
      ],
    }).files

    expect(kept.map((f) => f.id)).toEqual(['a'])
  })
})
