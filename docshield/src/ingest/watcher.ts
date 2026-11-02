/**
 * Keep the index in step with the filesystem: a startup reconcile (index new
 * or changed files, retire documents whose file vanished or was retired) plus
 * per-directory watchers with per-path debounce for later changes (see start()). Every path is
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
      for (const docs of await this.docsDirsOf(path.join(usersDir, user))) {
        for (const name of await listSafe(root, docs)) files.push(path.join(docs, name))
      }
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

  /**
   * Watch every directory that can hold documents with its own non-recursive
   * watcher: the root, `users`, each `users/<u>`, each `users/<u>/docs` and
   * `public_docs`. Not `recursive: true`: on Linux, Node's recursive watcher
   * loses a file once it is replaced by a rename (DSH's write tool saves that
   * way), so later edits of it went unseen. A directory watch reports every
   * entry change whatever its inode. New user folders are picked up as they appear.
   */
  start(): void {
    if (this.closed === false) return
    this.closed = false
    void this.sync(true)
  }

  close(): void {
    this.closed = true
    for (const w of this.dirs.values()) w.close()
    this.dirs.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private closed: boolean | undefined
  private readonly dirs = new Map<string, FSWatcher>()
  private syncing: Promise<void> | undefined
  private resync = false

  /** Bring the set of directory watchers in line with the tree (serialized; coalesces bursts). */
  private sync(initial = false): Promise<void> {
    if (this.syncing !== undefined) { this.resync = true; return this.syncing }
    this.syncing = (async () => {
      do {
        this.resync = false
        await this.syncOnce(initial)
        initial = false
      } while (this.resync && !this.closed)
    })().finally(() => { this.syncing = undefined })
    return this.syncing
  }

  private async syncOnce(initial: boolean): Promise<void> {
    const root = this.storageRoot
    const usersDir = path.join(root, 'users')
    const owned = this.ownedScope
    // directory → role: 'tree' dirs only matter for what appears in them, 'docs' dirs hold documents.
    const want = new Map<string, 'tree' | 'docs'>([[root, 'tree']])
    if (await this.isPlainDir(usersDir)) {
      want.set(usersDir, 'tree')
      for (const user of await listSafe(root, usersDir, { dirs: true })) {
        if (owned !== undefined && owned !== `user:${user}`) continue
        const userDir = path.join(usersDir, user)
        want.set(userDir, 'tree')
        for (const wsp of await listSafe(root, userDir, { dirs: true })) if (wsp !== 'docs') want.set(path.join(userDir, wsp), 'tree')
        for (const docs of await this.docsDirsOf(userDir)) want.set(docs, 'docs')
      }
    }
    const publicDir = path.join(root, 'public_docs')
    if ((owned === undefined || owned === PUBLIC_SCOPE) && await this.isPlainDir(publicDir)) want.set(publicDir, 'docs')

    for (const [dir, w] of this.dirs) if (!want.has(dir)) { w.close(); this.dirs.delete(dir) }
    for (const [dir, role] of want) {
      if (this.closed || this.dirs.has(dir)) continue
      let w: FSWatcher
      try {
        w = watch(dir, (_event, name) => {
          if (role === 'tree') { void this.sync(); return }
          if (name !== null) this.schedule(path.join(dir, name.toString()))
        })
      } catch {
        continue // vanished meanwhile; the next sync retries
      }
      w.on('error', () => { w.close(); this.dirs.delete(dir); void this.sync() })
      this.dirs.set(dir, w)
      // A docs folder that appeared after startup may already hold files written before its watcher existed.
      if (role === 'docs' && !initial) for (const name of await listSafe(root, dir)) this.schedule(path.join(dir, name))
    }
  }

  /** `users/<u>/docs` and each `users/<u>/<wsp>/docs` that is a real directory (links skipped). */
  private async docsDirsOf(userDir: string): Promise<string[]> {
    const out: string[] = []
    const own = path.join(userDir, 'docs')
    if (await this.isPlainDir(own)) out.push(own)
    for (const wsp of await listSafe(this.storageRoot, userDir, { dirs: true })) {
      const docs = path.join(userDir, wsp, 'docs')
      if (wsp !== 'docs' && await this.isPlainDir(docs)) out.push(docs)
    }
    return out
  }

  private async isPlainDir(dir: string): Promise<boolean> {
    try { return (await lstat(dir)).isDirectory() } catch { return false }
  }

  private schedule(file: string): void {
    if (targetForPath(this.storageRoot, file) === null || !this.owns(file)) return
    clearTimeout(this.timers.get(file))
    this.timers.set(file, setTimeout(() => {
      this.timers.delete(file)
      void this.settle(file)
    }, DEBOUNCE_MS))
  }

  /** Directories currently watched (tests). */
  watchedDirs(): string[] {
    return [...this.dirs.keys()]
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

