import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StorageWatcher } from '../src/ingest/watcher.js'
import { targetForPath } from '../src/ingest/layout.js'
import type { DocumentStore } from '../src/db/documents.js'
import type { Indexer } from '../src/ingest/indexer.js'

// Live watching (start()): every change must reach the indexer, including edits of a file that
// was replaced by a rename — the way DSH's write tool saves (Node's recursive watcher lost those on Linux).
const made: { root: string, watcher: StorageWatcher }[] = []
afterEach(() => {
  for (const { root, watcher } of made.splice(0)) { watcher.close(); rmSync(root, { recursive: true, force: true }) }
})

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'docshield-watch-'))
  mkdirSync(path.join(root, 'users', 'alice', 'docs'), { recursive: true })
  mkdirSync(path.join(root, 'public_docs'))
  const seen: string[] = []
  const indexer = { ingest: async (t: { scope: string, filename: string }) => { seen.push(`${t.scope}/${t.filename}`); return { status: 'unchanged' } }, remove: async () => ({ status: 'removed', count: 0 }) } as unknown as Indexer
  const store = { listAllLive: () => [], liveByPath: () => [] } as unknown as DocumentStore
  const watcher = new StorageWatcher(root, f => targetForPath(root, f), indexer, store, () => [], () => {})
  made.push({ root, watcher })
  return { root, seen, watcher }
}
const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)) }
}
const count = (seen: string[], key: string) => seen.filter(s => s === key).length

describe('StorageWatcher.start', () => {
  it('sees new files, edits, and edits after a rename-replace', async () => {
    const { root, seen, watcher } = setup()
    const file = path.join(root, 'users', 'alice', 'docs', 'note.md')
    writeFileSync(file, 'v1')
    watcher.start()
    await until(() => watcher.watchedDirs().length >= 4)
    appendFileSync(file, ' a')
    await until(() => count(seen, 'user:alice/note.md') === 1)
    const tmp = path.join(root, 'users', 'alice', 'docs', '.note.tmp')
    writeFileSync(tmp, 'v2')
    renameSync(tmp, file)
    await until(() => count(seen, 'user:alice/note.md') === 2)
    appendFileSync(file, ' b')
    await until(() => count(seen, 'user:alice/note.md') === 3)
    writeFileSync(path.join(root, 'public_docs', 'rule.md'), 'r')
    await until(() => seen.includes('public/rule.md'))
  }, 30000)

  it('picks up a user folder created later, including files written before its docs watcher existed', async () => {
    const { root, seen, watcher } = setup()
    watcher.start()
    await until(() => watcher.watchedDirs().length >= 4)
    const docs = path.join(root, 'users', 'bob', 'docs')
    mkdirSync(docs, { recursive: true })
    writeFileSync(path.join(docs, 'early.md'), 'x')
    await until(() => seen.includes('user:bob/early.md'))
    await until(() => watcher.watchedDirs().includes(docs))
    writeFileSync(path.join(docs, 'later.md'), 'y')
    await until(() => seen.includes('user:bob/later.md'))
  }, 30000)

  it('never watches a docs folder that is a link, and stops on close', async () => {
    const { root, seen, watcher } = setup()
    const outside = mkdtempSync(path.join(tmpdir(), 'docshield-outside-'))
    mkdirSync(path.join(root, 'users', 'eve'))
    symlinkSync(outside, path.join(root, 'users', 'eve', 'docs'), 'junction')
    watcher.start()
    await until(() => watcher.watchedDirs().length >= 4)
    expect(watcher.watchedDirs()).not.toContain(path.join(root, 'users', 'eve', 'docs'))
    watcher.close()
    expect(watcher.watchedDirs()).toEqual([])
    writeFileSync(path.join(root, 'users', 'alice', 'docs', 'after-close.md'), 'z')
    await new Promise(r => setTimeout(r, 1500))
    expect(seen).not.toContain('user:alice/after-close.md')
    rmSync(outside, { recursive: true, force: true })
  }, 30000)
})
