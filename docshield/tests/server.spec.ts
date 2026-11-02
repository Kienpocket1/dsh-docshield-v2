/** Host DocShield service (docker mode): token-scoped tool calls and uploads over HTTP. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HashEmbedder } from '../src/embed/embedder.js'
import { targetForPath } from '../src/ingest/layout.js'
import { RemoteDocShield } from '../src/remote/client.js'
import type { DocScope } from '../src/scope.js'
import { createDocShieldServer } from '../src/server/server.js'
import { DocShieldService } from '../src/service.js'
import { ArgumentError } from '../src/tools/args.js'

const ADMIN_KEY = 'k'.repeat(40)
const alice: DocScope = { role: 'user', userId: 'alice' }
const admin: DocScope = { role: 'admin' }
let root: string
let service: DocShieldService
let server: http.Server
let url: string

async function put(rel: string, content: string) {
  const file = path.join(root, rel)
  writeFileSync(file, content)
  await service.indexer.ingest(targetForPath(root, file)!)
}

async function tokens(method: 'PUT' | 'DELETE', body: unknown, key = ADMIN_KEY) {
  return fetch(`${url}/v1/tokens`, { method, headers: { 'x-docshield-admin': key, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

const tokenFor = (c: string) => c.repeat(40)

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'docshield-srv-'))
  for (const dir of ['users/alice/docs', 'users/bob/docs', 'public_docs']) mkdirSync(path.join(root, dir), { recursive: true })
  service = new DocShieldService(root, { embedder: new HashEmbedder(), log: () => {}, dbFile: ':memory:', minSimilarity: 0.2 })
  await put('users/alice/docs/cv_alice.txt', 'Mã số cá nhân của Alice là AL-99.')
  await put('users/bob/docs/cv_bob.txt', 'Mã số cá nhân của Bob là BO-12.')
  await put('public_docs/quy_che.md', 'Điều 6. Thư viện\nThư viện mở cửa từ 7h30 đến 21h.')
  server = createDocShieldServer(service, { adminKey: ADMIN_KEY, log: () => {} })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.close()
  await service.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('docshield server', () => {
  it('only the admin key registers tokens; unknown tokens are refused', async () => {
    expect((await tokens('PUT', { token: tokenFor('a'), scope: alice }, 'x'.repeat(40))).status).toBe(403)
    const stranger = new RemoteDocShield('/storage', alice, url, tokenFor('z'))
    await expect(stranger.invoke('list_documents', {}, { scope: alice, sessionId: 's' })).rejects.toThrow(/token/)
  })

  it('scope comes from the token, not from what the container claims', async () => {
    expect((await tokens('PUT', { token: tokenFor('a'), scope: alice })).status).toBe(204)
    // The client says admin; the service still treats the caller as alice.
    const client = new RemoteDocShield('/storage', admin, url, tokenFor('a'))
    const listed = await client.invoke('list_documents', {}, { scope: admin, sessionId: 's1' }) as { documents: { filename: string }[] }
    expect(listed.documents.map(d => d.filename).sort()).toEqual(['cv_alice.txt', 'quy_che.md'])
    await expect(client.invoke('list_tickets', {}, { scope: admin, sessionId: 's1' })).rejects.toBeInstanceOf(ArgumentError)
    const found = await client.invoke('scoped_doc_search', { query: 'mã số cá nhân' }, { scope: admin, sessionId: 's1' }) as { hits: { filename: string }[] }
    expect(found.hits.map(h => h.filename)).not.toContain('cv_bob.txt')
  })

  it('my_access answers for the token owner only, and is refused to an admin token', async () => {
    await tokens('PUT', { token: tokenFor('a'), scope: alice })
    await tokens('PUT', { token: tokenFor('b'), scope: admin })
    const mine = await new RemoteDocShield('/storage', alice, url, tokenFor('a'))
      .invoke('my_access', {}, { scope: alice, sessionId: 's1' }) as { userId: string, allowedTools: string[], documents: { personal: number, public: number } }
    expect(mine.userId).toBe('alice')
    expect(mine.allowedTools).not.toContain('list_tickets')
    expect(mine.documents).toEqual({ personal: 1, public: 1 })
    await expect(new RemoteDocShield('/storage', admin, url, tokenFor('b'))
      .invoke('my_access', {}, { scope: admin, sessionId: 's2' })).rejects.toBeInstanceOf(ArgumentError)
  })

  it('stores and indexes an upload in the token owner\'s folder', async () => {
    await tokens('PUT', { token: tokenFor('a'), scope: alice })
    const client = new RemoteDocShield('/storage', alice, url, tokenFor('a'))
    const upload = await client.upload('ghi chu.txt', Buffer.from('Lịch họp nhóm vào thứ Năm.'))
    expect(upload.result.status).toBe('indexed')
    expect(existsSync(path.join(root, 'users', 'alice', 'docs', upload.filename))).toBe(true)
    const bad = await client.upload('virus.exe', Buffer.from('x'))
    expect(bad.result.status).toBe('rejected')
  })

  it('a revoked token stops working', async () => {
    await tokens('PUT', { token: tokenFor('a'), scope: alice })
    await tokens('DELETE', { token: tokenFor('a') })
    const client = new RemoteDocShield('/storage', alice, url, tokenFor('a'))
    await expect(client.invoke('list_documents', {}, { scope: alice, sessionId: 's' })).rejects.toThrow(/token/)
  })
})
