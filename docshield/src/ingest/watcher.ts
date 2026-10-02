/**
 * Keep the index in step with the filesystem: a startup reconcile (index new
 * or changed files, retire documents whose file vanished or was retired) plus
 * a recursive fs.watch with per-path debounce for later changes. Every path is
 * mapped through the binding-aware resolver, so a retired public file is never
 * indexed again while it stays on disk. Symlinks and junctions are never
 * followed (see safe-fs.ts): a link in `docs/` is treated as absent.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { DocumentStore } from '../db/documents.js'
import type { Indexer } from './indexer.js'
import type { DocScope } from '../scope.js'
import { PUBLIC_SCOPE, targetForPath, type TargetResolver } from './layout.js'
import { listSafe } from './safe-fs.js'

const DEBOUNCE_MS = 1000

export class StorageWatcher {
  private watcher: FSWatcher | undefined
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly storageRoot: string,
    private readonly resolve: TargetResolver,
    private readonly indexer: Indexer,
    private readonly store: DocumentStore,
    private readonly retiredPublic: () => string[],
    private readonly log: (message: string) => void,
    /**
     * Per-user instance (dsh-gate): index only the owned area — a user its own
     * `users/<u>/docs`, the admin `public_docs` — so instances sharing one
     * database never index the same file twice. Unset: the whole tree.
     */
    private readonly identity?: DocScope,
  ) {}

  /** Index scope this watcher owns, or undefined for all. */
  private get ownedScope(): string | undefined {
    if (this.identity === undefined) return undefined
    return this.identity.role === 'user' ? `user:${this.identity.userId}` : PUBLIC_SCOPE
  }

  private owns(file: string): boolean {
    const owned = this.ownedScope
    if (owned === undefined) return true
    return targetForPath(this.storageRoot, file)?.scope === owned
  }

  async reconcile(): Promise<void> {
    const files: string[] = []
    const usersDir = path.join(this.storageRoot, 'users')
    const owned = this.ownedScope
    const root = this.storageRoot
    for (const user of await listSafe(root, usersDir, { dirs: true })) {
      if (owned !== undefined && owned !== `user:${user}`) continue
      const docs = path.join(usersDir, user, 'docs')
      for (const name of await listSafe(root, docs)) files.push(path.join(docs, name))
    }
    const publicDir = path.join(root, 'public_docs')
    if (owned === undefined || owned === PUBLIC_SCOPE) {
      for (const name of await listSafe(root, publicDir)) files.push(path.join(publicDir, name))
    }

    for (const file of files) {
      const target = this.resolve(file)
      if (target === null) continue
      await this.indexer.ingest(target)
    }
    const retired = new Set(this.retiredPublic())
    for (const doc of this.store.listAllLive()) {
      if (owned !== undefined && doc.scope !== owned) continue
      const gone = !existsSync(doc.path)
      const retiredFile = doc.scope === PUBLIC_SCOPE && retired.has(doc.filename)
      if (gone || retiredFile) await this.indexer.remove(doc.scope, doc.doc_key)
    }
  }

  start(): void {
    if (this.watcher !== undefined) return
    this.watcher = watch(this.storageRoot, { recursive: true }, (_event, name) => {
      if (name === null) return
      const file = path.join(this.storageRoot, name.toString())
      if (targetForPath(this.storageRoot, file) === null || !this.owns(file)) return
      clearTimeout(this.timers.get(file))
      this.timers.set(file, setTimeout(() => {
        this.timers.delete(file)
        void this.settle(file)
      }, DEBOUNCE_MS))
    })
    this.watcher.on('error', error => this.log(`watcher error: ${error.message}`))
  }

  close(): void {
    this.watcher?.close()
    this.watcher = undefined
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private async settle(file: string): Promise<void> {
    try {
      const info = await lstat(file).catch(() => undefined)
      if (info === undefined || info.isSymbolicLink()) {
        // Deleted, or replaced by a link: retire whatever live document was indexed from this exact path.
        for (const doc of this.store.liveByPath(path.resolve(file))) await this.indexer.remove(doc.scope, doc.doc_key)
        return
      }
      const target = this.resolve(file)
      if (target !== null && info.isFile()) await this.indexer.ingest(target)
    } catch (error) {
      this.log(`watch ingest failed for ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

