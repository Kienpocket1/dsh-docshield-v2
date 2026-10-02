/** Per-user instance mode (dsh-gate): fixed identity, owned-area indexing, remote embedder. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCoreConfig } from '../src/config.js'
import { EMBEDDING_DIMS } from '../src/db/database.js'
import { HashEmbedder, RemoteEmbedder } from '../src/embed/embedder.js'
import { createGuard } from '../src/guard.js'
import { resolveScope } from '../src/scope.js'
import { DocShieldService } from '../src/service.js'
import { requireScope } from '../src/tools/scope-check.js'

const ROOT = path.resolve('/store')
const ELSEWHERE = path.resolve('/elsewhere')
const execIn = (cwd: string | undefined, name = 'scoped_doc_search') =>
  ({ name, agent: { session: { id: 's', header: { cwd } } } }) as never

describe('config.identity', () => {
  it('parses user and admin identities, rejects junk', () => {
    expect(resolveCoreConfig({ storageRoot: ROOT, identity: { user: 'alice' } }, {}).identity).toEqual({ role: 'user', userId: 'alice' })
    expect(resolveCoreConfig({ storageRoot: ROOT, identity: { role: 'admin' } }, {}).identity).toEqual({ role: 'admin' })
    expect(resolveCoreConfig({ storageRoot: ROOT }, {}).identity).toBeUndefined()
    expect(() => resolveCoreConfig({ storageRoot: ROOT, identity: { user: '../x' } }, {})).toThrow()
    expect(() => resolveCoreConfig({ storageRoot: ROOT, embedUrl: 'http://evil.com/embed' }, {})).toThrow()
    expect(resolveCoreConfig({ storageRoot: ROOT, embedUrl: 'http://127.0.0.1:3490/embed' }, {}).embedUrl).toBe('http://127.0.0.1:3490/embed')
    expect(resolveCoreConfig({ storageRoot: ROOT, embedUrl: 'http://host.docker.internal:3490/embed' }, {}).embedUrl).toBe('http://host.docker.internal:3490/embed')
    expect(() => resolveCoreConfig({ storageRoot: ROOT, embedUrl: 'http://host.docker.internal.evil.com/embed' }, {})).toThrow()
    const remote = { storageRoot: ROOT, serviceUrl: 'http://host.docker.internal:3492', identity: { user: 'alice' } }
    expect(resolveCoreConfig({ ...remote, allowOtherTools: true }, {}).allowOtherTools).toBe(true)
    expect(() => resolveCoreConfig({ storageRoot: ROOT, identity: { user: 'alice' }, allowOtherTools: true }, {})).toThrow(/serviceUrl/)
    // exec-router tool sandbox: other tools allowed, database file outside the shared storage
    const sandboxed = resolveCoreConfig({ storageRoot: ROOT, allowOtherTools: true, toolSandbox: true, dbFile: path.resolve('/var/docshield/d.db') }, {})
    expect(sandboxed.allowOtherTools).toBe(true)
    expect(sandboxed.dbFile).toBe(path.resolve('/var/docshield/d.db'))
    expect(() => resolveCoreConfig({ storageRoot: ROOT, dbFile: 'relative.db' }, {})).toThrow(/dbFile/)
    expect(resolveCoreConfig(remote, {}).serviceUrl).toBe('http://host.docker.internal:3492')
    expect(() => resolveCoreConfig({ ...remote, serviceUrl: 'http://host.docker.internal:3492.evil.com' }, {})).toThrow()
    expect(() => resolveCoreConfig({ storageRoot: ROOT, serviceUrl: 'http://127.0.0.1:3492' }, {})).toThrow(/identity/)
  })
})

describe('fixed identity overrides the cwd', () => {
  const identity = { role: 'user', userId: 'bob' } as const
  it('every cwd, even another user folder or outside storage, resolves to the instance user', () => {
    for (const cwd of [undefined, ELSEWHERE, path.join(ROOT, 'users', 'alice'), path.join(ROOT, 'admin')]) {
      expect(resolveScope(cwd, ROOT, { identity })).toEqual({ inside: true, scope: identity })
    }
  })
  it('guard applies the allowlist to every session of the instance', () => {
    const guard = createGuard(ROOT, { identity })
    expect(guard(execIn(ELSEWHERE, 'bash'))).toMatch(/không được phép/)
    expect(guard(execIn(ELSEWHERE, 'scoped_doc_search'))).toBeUndefined()
    expect(guard(execIn(undefined, 'publish_public_doc'))).toMatch(/không được phép/)
  })
  it('tools cannot reach admin through the cwd', () => {
    expect(() => requireScope(execIn(path.join(ROOT, 'admin')), { storageRoot: ROOT, scopeOptions: { identity } }, 'admin')).toThrow(/Admin/)
    expect(requireScope(execIn(path.join(ROOT, 'admin')), { storageRoot: ROOT, scopeOptions: { identity } }, 'any')).toEqual(identity)
  })
})

describe('owned-area indexing', () => {
  let root: string
  const services: DocShieldService[] = []
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'docshield-id-'))
    for (const dir of ['users/alice/docs', 'users/bob/docs', 'public_docs', 'admin']) mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, 'users/alice/docs/a.md'), 'Mã số cá nhân của Alice là AL-99.')
    writeFileSync(path.join(root, 'users/bob/docs/b.md'), 'Mã số cá nhân của Bob là BO-42.')
    writeFileSync(path.join(root, 'public_docs/quy_che.md'), 'Điều 5. Học bổng khuyến khích.')
  })
  afterEach(async () => {
    for (const s of services.splice(0)) await s.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const make = (identity?: { role: 'user'; userId: string } | { role: 'admin' }) => {
    const s = new DocShieldService(root, { embedder: new HashEmbedder(), log: () => {}, dbFile: ':memory:', ...(identity ? { identity } : {}) })
    services.push(s)
    return s
  }
  const scopes = (s: DocShieldService) => s.store.listAllLive().map(d => d.scope).sort()

  it('a user instance indexes only its own docs; admin only public; no identity indexes all', async () => {
    const alice = make({ role: 'user', userId: 'alice' })
    await alice.watcher.reconcile()
    expect(scopes(alice)).toEqual(['user:alice'])
    const admin = make({ role: 'admin' })
    await admin.watcher.reconcile()
    expect(scopes(admin)).toEqual(['public'])
    const all = make()
    await all.watcher.reconcile()
    expect(scopes(all)).toEqual(['public', 'user:alice', 'user:bob'])
  })
})

describe('RemoteEmbedder', () => {
  let server: http.Server
  let url: string
  const batches: number[] = []
  beforeEach(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const { texts } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { texts: string[] }
        batches.push(texts.length)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ vectors: texts.map((_, i) => Array.from({ length: EMBEDDING_DIMS }, (_x, j) => (j === i ? 1 : 0))) }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/embed`
  })
  afterEach(() => { server.close(); batches.length = 0 })

  it('batches requests and reports progress', async () => {
    const progress: number[] = []
    const out = await new RemoteEmbedder(url, { batchSize: 2 }).embed(['a', 'b', 'c'], done => progress.push(done))
    expect(out).toHaveLength(3)
    expect(out[0]).toBeInstanceOf(Float32Array)
    expect(batches).toEqual([2, 1])
    expect(progress).toEqual([2, 3])
  })
  it('fails clearly when the service is down', async () => {
    await expect(new RemoteEmbedder('http://127.0.0.1:1/embed').embed(['x'])).rejects.toThrow(/embedding/)
  })
})
