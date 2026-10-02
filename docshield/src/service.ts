/**
 * The `docshield` service: storage root, database, ingestion pipeline and
 * read models shared by the host row and the preset tool rows.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, transaction } from './db/database.js'
import { DocumentStore } from './db/documents.js'
import { PublicFiles } from './db/public-files.js'
import { TicketStore } from './db/tickets.js'
import { RemoteEmbedder, WorkerEmbedder, type Embedder } from './embed/embedder.js'
import { Indexer, type IngestResult } from './ingest/indexer.js'
import { bindingResolver, PUBLIC_SCOPE, type TargetResolver } from './ingest/layout.js'
import { docKeyFromFilename, resolveInside, sanitizeFilename } from './ingest/sanitize.js'
import { StorageWatcher } from './ingest/watcher.js'
import { DEFAULT_MIN_SIMILARITY, DEFAULT_TOP_K } from './config.js'
import { EvidenceLedger, verifyCitations, type Citation, type VerifiedEvidence } from './retrieval/evidence.js'
import { hybridSearch, type SearchResult } from './retrieval/search.js'
import { readableScopes, type DocScope, type ScopeOptions } from './scope.js'
import { docCalls, invokeWith, type DocInvoke } from './tools/calls.js'

export interface DocumentSummary {
  readonly filename: string
  readonly docKey: string
  readonly scope: 'chung' | 'cá nhân'
  readonly status: 'đã nạp' | 'lỗi' | 'đang nạp'
  readonly version: number
  readonly chunks: number
  readonly updatedAt: string
  readonly error?: string
  /** Only while indexing, e.g. "48/112 đoạn" or "đang đọc tài liệu". */
  readonly progress?: string
}

export interface ServiceOptions {
  readonly embedder?: Embedder
  readonly log?: (message: string) => void
  readonly dbFile?: string
  readonly minSimilarity?: number
  readonly topK?: number
  /** Fixed identity of a per-user instance (dsh-gate); see CoreConfig.identity. */
  readonly identity?: DocScope
  /** Shared embedding service URL; ignored when `embedder` is given. */
  readonly embedUrl?: string
}

export class DocShieldService {
  readonly db: DatabaseSync
  readonly store: DocumentStore
  readonly tickets: TicketStore
  readonly publicFiles: PublicFiles
  readonly resolve: TargetResolver
  readonly indexer: Indexer
  readonly watcher: StorageWatcher
  readonly ledger = new EvidenceLedger()
  readonly embedder: Embedder
  readonly log: (message: string) => void
  readonly minSimilarity: number
  readonly topK: number
  /** Scope resolution for guard, tools and uploads: fixed identity or the session cwd. */
  readonly scopeOptions: ScopeOptions
  /** Tool calls run against this service (see tools/calls.ts). */
  readonly invoke: DocInvoke

  constructor(readonly storageRoot: string, options: ServiceOptions = {}) {
    this.embedder = options.embedder
      ?? (options.embedUrl !== undefined
        ? new RemoteEmbedder(options.embedUrl)
        : new WorkerEmbedder({ modelsDir: path.join(storageRoot, '.docshield', 'models') }))
    this.scopeOptions = options.identity !== undefined ? { identity: options.identity } : {}
    this.log = options.log ?? (message => console.log(`[docshield] ${message}`))
    this.minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY
    this.topK = options.topK ?? DEFAULT_TOP_K
    this.db = openDatabase(options.dbFile ?? path.join(storageRoot, '.docshield', 'docshield.db'))
    this.store = new DocumentStore(this.db)
    this.tickets = new TicketStore(this.db)
    this.publicFiles = new PublicFiles(this.db)
    this.resolve = bindingResolver(storageRoot, this.publicFiles)
    this.indexer = new Indexer(this.store, this.embedder, storageRoot, this.log)
    this.watcher = new StorageWatcher(storageRoot, this.resolve, this.indexer, this.store, () => this.publicFiles.retiredFilenames(), this.log, options.identity)
    this.invoke = invokeWith(docCalls(this))
  }

  /** Search the partitions `scope` may read and remember the hits for citation checks. */
  async search(sessionId: string, scope: DocScope, query: string, k = this.topK): Promise<SearchResult> {
    const result = await hybridSearch(this.db, this.embedder, readableScopes(scope), query, { k, minSimilarity: this.minSimilarity })
    this.ledger.record(sessionId, result.hits)
    return result
  }

  verify(sessionId: string, scope: DocScope, citations: readonly Citation[]): VerifiedEvidence[] {
    return verifyCitations(this.db, this.ledger, sessionId, readableScopes(scope), citations)
  }

  /** Stored documents plus those still queued or indexing (which replace their stored row, if any). */
  listDocuments(scope: DocScope): DocumentSummary[] {
    const readable = readableScopes(scope)
    const busy = this.indexer.inProgress().filter(p => readable.includes(p.scope))
    const busyKeys = new Set(busy.map(p => `${p.scope}\u0000${p.docKey}`))
    const stored: DocumentSummary[] = this.store.listLive(readable)
      .filter(row => !busyKeys.has(`${row.scope}\u0000${row.doc_key}`))
      .map(row => ({
        filename: row.filename,
        docKey: row.doc_key,
        scope: row.scope === PUBLIC_SCOPE ? 'chung' : 'cá nhân',
        status: row.status === 'active' ? 'đã nạp' : 'lỗi',
        version: row.version,
        chunks: row.chunk_count,
        updatedAt: row.created_at,
        ...row.error === null ? {} : { error: row.error },
      }))
    const indexing: DocumentSummary[] = busy.map(p => ({
      filename: p.filename,
      docKey: p.docKey,
      scope: p.scope === PUBLIC_SCOPE ? 'chung' : 'cá nhân',
      status: 'đang nạp',
      version: 0,
      chunks: p.total,
      updatedAt: new Date(p.queuedAt).toISOString(),
      progress: p.stage === 'embedding' ? `${p.done}/${p.total} đoạn` : p.stage === 'reading' ? 'đang đọc tài liệu' : 'đang chờ tới lượt',
    }))
    return [...indexing, ...stored]
  }

  /**
   * Admin: make `filename` (already in public_docs) the active public version
   * of `docKey`. Every other file bound to that key, and `replaces` if given,
   * is retired: its index rows are dropped and it is never re-indexed while it
   * stays on disk (TC-05).
   */
  async publishPublic(filename: string, docKey: string, replaces?: string): Promise<PublishResult> {
    const dir = path.join(this.storageRoot, 'public_docs')
    const name = exactPublicName(filename)
    const file = resolveInside(dir, name)
    if (!existsSync(file)) throw new PublishError(`Không có file "${name}" trong public_docs.`)
    if (!/^[a-z0-9_-]{2,64}$/.test(docKey)) throw new PublishError('doc_key chỉ gồm a-z, 0-9, _ và -, dài 2-64 ký tự.')
    const replaced = replaces === undefined || replaces === '' ? undefined : exactPublicName(replaces)
    if (replaced === name) throw new PublishError('Không thể thay một file bằng chính nó.')

    const retired = transaction(this.db, () => {
      const out: string[] = []
      for (const other of this.publicFiles.boundTo(docKey)) {
        if (other === name) continue
        this.publicFiles.set(other, docKey, 'retired')
        out.push(other)
      }
      if (replaced !== undefined) {
        this.publicFiles.set(replaced, this.publicFiles.get(replaced)?.doc_key ?? docKeyFromFilename(replaced), 'retired')
        if (!out.includes(replaced)) out.push(replaced)
      }
      this.publicFiles.set(name, docKey, 'bound')
      return out
    })
    // Drop index rows of retired files, and of this file under any previous key.
    for (const doc of this.store.listLive([PUBLIC_SCOPE])) {
      if (retired.includes(doc.filename) || (doc.filename === name && doc.doc_key !== docKey)) {
        await this.indexer.remove(PUBLIC_SCOPE, doc.doc_key)
      }
    }
    const result = await this.indexer.ingest({ scope: PUBLIC_SCOPE, docKey, filename: name, path: file })
    this.log(`published ${name} as ${docKey}; retired: ${retired.join(', ') || 'none'}`)
    return { filename: name, docKey, result, retired }
  }

  /** Admin: re-parse and re-embed the active public document of `docKey`. */
  async reindexPublic(docKey: string): Promise<IngestResult> {
    const live = this.store.current(PUBLIC_SCOPE, docKey)
    const filename = live?.filename ?? this.publicFiles.boundTo(docKey)[0]
    if (filename === undefined) throw new PublishError(`Không có tài liệu chung nào với doc_key "${docKey}".`)
    const file = resolveInside(path.join(this.storageRoot, 'public_docs'), filename)
    if (!existsSync(file)) throw new PublishError(`File "${filename}" không còn trong public_docs.`)
    return this.indexer.ingest({ scope: PUBLIC_SCOPE, docKey, filename, path: file }, { force: true })
  }

  async dispose(): Promise<void> {
    this.watcher.close()
    await this.indexer.idle()
    await this.embedder.dispose()
    this.db.close()
  }
}

export interface PublishResult {
  readonly filename: string
  readonly docKey: string
  readonly result: IngestResult
  readonly retired: readonly string[]
}

export class PublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishError'
  }
}

/** The name must already be the safe on-disk form; never silently map it to another file. */
function exactPublicName(filename: string): string {
  let safe: string
  try {
    safe = sanitizeFilename(filename)
  } catch (error) {
    throw new PublishError(error instanceof Error ? error.message : String(error))
  }
  if (safe !== filename) throw new PublishError(`Tên file không hợp lệ: "${filename}" (gợi ý: "${safe}").`)
  return safe
}
