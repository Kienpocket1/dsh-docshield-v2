/**
 * Ingestion pipeline: hash → skip if unchanged → parse → chunk → embed →
 * write (one transaction). Jobs run one at a time so the single embedder and
 * the SQLite writer are never contended; callers await their own job.
 */
import { createHash } from 'node:crypto'
import { DocumentStore } from '../db/documents.js'
import type { Embedder } from '../embed/embedder.js'
import { chunkDocument } from './chunk.js'
import { parseDocument } from './parse.js'
import { openVerified, UnsafePathError } from './safe-fs.js'
import { assertSize } from './sanitize.js'

export interface IngestTarget {
  /** 'public' or 'user:<id>'. */
  readonly scope: string
  readonly docKey: string
  readonly filename: string
  readonly path: string
}

export type IngestResult =
  | { readonly status: 'indexed'; readonly version: number; readonly chunks: number; readonly superseded: number }
  | { readonly status: 'unchanged' }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'removed'; readonly count: number }

export interface IndexerLog {
  (message: string): void
}

/** Live state of a document that is queued or being indexed (not persisted). */
export interface IngestProgress {
  readonly scope: string
  readonly docKey: string
  readonly filename: string
  stage: 'queued' | 'reading' | 'embedding'
  done: number
  total: number
  readonly queuedAt: number
}

const PROGRESS_LOG_MS = 15_000

export class Indexer {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<string, IngestProgress>()

  constructor(
    private readonly store: DocumentStore,
    private readonly embedder: Embedder,
    /** Storage root; files are read only if their real location is inside it (see safe-fs.ts). */
    private readonly root: string,
    private readonly log: IndexerLog = () => {},
  ) {}

  /** `force` re-parses and re-embeds even when the content hash is unchanged. */
  ingest(target: IngestTarget, options: { force?: boolean } = {}): Promise<IngestResult> {
    const key = progressKey(target.scope, target.docKey)
    if (!this.pending.has(key)) {
      this.pending.set(key, { scope: target.scope, docKey: target.docKey, filename: target.filename, stage: 'queued', done: 0, total: 0, queuedAt: Date.now() })
    }
    return this.enqueue(async () => {
      try {
        return await this.ingestNow(target, options.force ?? false)
      } finally {
        this.pending.delete(key)
      }
    })
  }

  /** Documents currently queued or being indexed, oldest first. */
  inProgress(): IngestProgress[] {
    return [...this.pending.values()]
  }

  remove(scope: string, docKey: string): Promise<IngestResult> {
    return this.enqueue(async () => {
      const removed = this.store.remove(scope, docKey)
      if (removed.length > 0) this.log(`removed ${scope}/${docKey}`)
      return { status: 'removed', count: removed.length } as const
    })
  }

  /** Resolves once every job queued so far has settled. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined, () => undefined)
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async ingestNow(target: IngestTarget, force: boolean): Promise<IngestResult> {
    const base = { scope: target.scope, docKey: target.docKey, filename: target.filename, path: target.path }
    let opened
    try {
      opened = await openVerified(this.root, target.path)
    } catch (error) {
      // A link or junction out of the storage tree, or a file swapped while opening: never read it.
      if (error instanceof UnsafePathError) {
        this.log(`bỏ qua ${target.path}: ${error.message}`)
        return this.fail({ ...base, bytes: 0, sha256: '' }, error)
      }
      throw error
    }
    const identityBase = { ...base, bytes: opened.size }
    let bytes: Uint8Array
    try {
      try {
        assertSize(opened.size)
      } catch (error) {
        return this.fail({ ...identityBase, sha256: '' }, error)
      }
      bytes = new Uint8Array(await opened.handle.readFile())
    } finally {
      await opened.handle.close()
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const identity = { ...identityBase, sha256 }
    const current = this.store.current(target.scope, target.docKey)
    if (!force && current !== undefined && current.sha256 === sha256 && current.filename === target.filename) {
      return { status: 'unchanged' }
    }
    const progress = this.pending.get(progressKey(target.scope, target.docKey))
    const started = Date.now()
    try {
      if (progress) progress.stage = 'reading'
      const parsed = await parseDocument(target.path, bytes)
      const chunks = chunkDocument(parsed)
      if (chunks.length === 0) throw new Error('Không tách được đoạn văn nào từ tài liệu.')
      if (progress) {
        progress.stage = 'embedding'
        progress.total = chunks.length
      }
      this.log(`đang nạp ${target.scope}/${target.docKey} (${target.filename}): ${parsed.pages.length} trang, ${chunks.length} đoạn`)
      let lastLog = Date.now()
      const vectors = await this.embedder.embed(chunks.map(c => c.text), (done, total) => {
        if (progress) progress.done = done
        if (Date.now() - lastLog >= PROGRESS_LOG_MS && done < total) {
          lastLog = Date.now()
          this.log(`  … ${target.docKey}: ${done}/${total} đoạn (${elapsed(started)})`)
        }
      })
      const written = this.store.insertActive(identity, chunks.map((c, i) => ({ ...c, embedding: vectors[i]! })))
      this.log(`indexed ${target.scope}/${target.docKey} v${written.version} (${chunks.length} chunks, ${elapsed(started)})`)
      return { status: 'indexed', version: written.version, chunks: chunks.length, superseded: written.superseded.length }
    } catch (error) {
      return this.fail(identity, error)
    }
  }

  private fail(identity: Parameters<DocumentStore['insertFailed']>[0], error: unknown): IngestResult {
    // Never let a failure go unrecorded: if even the failure row cannot be written, still log it.
    const message = error instanceof Error ? error.message : String(error)
    try {
      this.store.insertFailed(identity, message)
    } catch (writeError) {
      this.log(`failed ${identity.scope}/${identity.docKey}: ${message} (và không ghi được trạng thái lỗi: ${writeError instanceof Error ? writeError.message : String(writeError)})`)
      return { status: 'failed', error: message }
    }
    this.log(`failed ${identity.scope}/${identity.docKey}: ${message}`)
    return { status: 'failed', error: message }
  }
}

const progressKey = (scope: string, docKey: string) => `${scope}\u0000${docKey}`

function elapsed(since: number): string {
  const s = Math.round((Date.now() - since) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
