/** Real symlinks/junctions on disk (TC4) and a swap race (TC9) against the host-side readers. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HashEmbedder } from '../src/embed/embedder.js'
import { listSafe, openVerified, readVerified, UnsafePathError, writeInside } from '../src/ingest/safe-fs.js'
import { DocShieldService } from '../src/service.js'

const SECRET = 'API_KEY=sk-bi-mat-cua-may-chu'
let base: string
let root: string
let outside: string
const services: DocShieldService[] = []

/** Directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
const linkDir = (target: string, link: string) => symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
/** File symlinks need a privilege on Windows; skip those cases when it is missing. */
function tryLinkFile(target: string, link: string): boolean {
  try { symlinkSync(target, link, 'file'); return true } catch { return false }
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'docshield-safefs-'))
  root = path.join(base, 'storage')
  outside = path.join(base, 'host-secrets')
  for (const d of ['users/alice/docs', 'users/bob/docs', 'public_docs', 'admin']) mkdirSync(path.join(root, d), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'secret.md'), SECRET)
})
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose()
  rmSync(base, { recursive: true, force: true })
})

const service = () => {
  const s = new DocShieldService(root, { embedder: new HashEmbedder(), log: () => {}, dbFile: ':memory:' })
  services.push(s)
  return s
}
const indexedText = (s: DocShieldService) => s.store.listAllLive().map(d => `${d.scope}:${d.filename}:${d.status}`)

describe('openVerified / readVerified', () => {
  it('reads a plain file inside the root', async () => {
    writeFileSync(path.join(root, 'users/alice/docs/a.md'), 'xin chào')
    expect(Buffer.from(await readVerified(root, path.join(root, 'users/alice/docs/a.md'), 1024)).toString()).toBe('xin chào')
  })
  it('refuses a file reached through a junctioned folder', async () => {
    linkDir(outside, path.join(root, 'users/alice/docs/link'))
    await expect(openVerified(root, path.join(root, 'users/alice/docs/link/secret.md'))).rejects.toBeInstanceOf(UnsafePathError)
  })
  it('refuses a file symlink pointing outside', async ctx => {
    const link = path.join(root, 'users/alice/docs/fake.md')
    if (!tryLinkFile(path.join(outside, 'secret.md'), link)) return ctx.skip()
    await expect(readVerified(root, link, 1024)).rejects.toBeInstanceOf(UnsafePathError)
  })
  it('refuses oversized files', async () => {
    writeFileSync(path.join(root, 'users/alice/docs/big.md'), 'x'.repeat(2048))
    await expect(readVerified(root, path.join(root, 'users/alice/docs/big.md'), 1024)).rejects.toThrow(/quá lớn/)
  })
})

describe('listSafe / writeInside', () => {
  it('skips junctions when listing', async () => {
    writeFileSync(path.join(root, 'users/alice/docs/a.md'), 'a')
    linkDir(outside, path.join(root, 'users/alice/docs/sub'))
    expect(await listSafe(root, path.join(root, 'users/alice/docs'))).toEqual(['a.md'])
    expect(await listSafe(root, path.join(root, 'users/alice/docs/sub'))).toEqual([])
  })
  it('never writes through a junctioned folder', async () => {
    rmSync(path.join(root, 'users/bob/docs'), { recursive: true })
    linkDir(outside, path.join(root, 'users/bob/docs'))
    await expect(writeInside(root, path.join(root, 'users/bob/docs'), 'x.md', new Uint8Array([1]))).rejects.toBeInstanceOf(UnsafePathError)
  })
  it('replaces a plain file but refuses a link at the destination', async ctx => {
    const dir = path.join(root, 'users/alice/docs')
    await writeInside(root, dir, 'a.md', Buffer.from('v1'))
    await writeInside(root, dir, 'a.md', Buffer.from('v2'))
    expect(Buffer.from(await readVerified(root, path.join(dir, 'a.md'), 10)).toString()).toBe('v2')
    if (!tryLinkFile(path.join(outside, 'secret.md'), path.join(dir, 'b.md'))) return ctx.skip()
    await expect(writeInside(root, dir, 'b.md', Buffer.from('x'))).rejects.toBeInstanceOf(UnsafePathError)
  })
})

describe('DocShield never indexes files outside storage (TC4)', () => {
  it('a junctioned docs folder is ignored by reconcile', async () => {
    rmSync(path.join(root, 'users/alice/docs'), { recursive: true })
    linkDir(outside, path.join(root, 'users/alice/docs'))
    const s = service()
    await s.watcher.reconcile()
    await s.indexer.idle()
    expect(indexedText(s)).toEqual([])
  })
  it('a junction inside docs is ignored, a real file next to it is indexed', async () => {
    writeFileSync(path.join(root, 'users/alice/docs/that.md'), 'Lịch họp thứ Năm.')
    linkDir(outside, path.join(root, 'users/alice/docs/secrets'))
    const s = service()
    await s.watcher.reconcile()
    await s.indexer.idle()
    expect(indexedText(s)).toEqual(['user:alice:that.md:active'])
  })
  it('a file symlink in docs is refused even when handed to the indexer directly', async ctx => {
    const link = path.join(root, 'users/alice/docs/fake.md')
    if (!tryLinkFile(path.join(outside, 'secret.md'), link)) return ctx.skip()
    const s = service()
    const result = await s.indexer.ingest({ scope: 'user:alice', docKey: 'fake', filename: 'fake.md', path: link })
    expect(result.status).toBe('failed')
  })
})

describe('swap race on the parent folder (TC9)', () => {
  it('never returns content from outside while a folder flips between real and junction', async () => {
    const docs = path.join(root, 'users/alice/docs')
    const real = path.join(docs, 'sub')
    const parked = path.join(docs, 'sub-real')
    mkdirSync(real)
    writeFileSync(path.join(real, 'secret.md'), 'nội dung của alice')
    let stop = false
    const flipper = (async () => {
      for (let i = 0; i < 400 && !stop; i++) {
        try {
          renameSync(real, parked) // real folder away …
          linkDir(outside, real)   // … junction to the host secrets in its place
          await new Promise(r => setImmediate(r))
          rmSync(real)             // junction away …
          renameSync(parked, real) // … real folder back
        } catch { /* a reader may hold the folder for an instant on Windows */ }
        await new Promise(r => setImmediate(r))
      }
    })()
    let leaked = 0
    let reads = 0
    for (let i = 0; i < 2000; i++) {
      try {
        const text = Buffer.from(await readVerified(root, path.join(real, 'secret.md'), 1024)).toString()
        reads++
        if (text.includes('sk-bi-mat')) leaked++
      } catch { /* refused or missing: fine */ }
      if (i % 20 === 0) await new Promise(r => setImmediate(r))
    }
    stop = true
    await flipper
    expect(leaked).toBe(0)
    expect(reads).toBeGreaterThan(0)
  }, 60_000)
})
