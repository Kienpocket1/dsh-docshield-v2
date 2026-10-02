/** The filter against a fake DSH that speaks the real wire format (HTTP RPC + /api/remote.mux). */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createFilter } from '../src/filter.mjs'
import { SessionIndex, callUpstream } from '../src/sessions.mjs'
import { Upstream } from '../src/upstream.mjs'
import { OP, createDecoder, encodeFrame } from '../src/ws.mjs'

const storage = mkdtempSync(path.join(tmpdir(), 'gate-filter-'))
const ALICE = path.join(storage, 'users', 'alice')
const BOB = path.join(storage, 'users', 'bob')
const COOKIE = 'dsh-auth-test=ok'

/** Fake shared DSH. */
const dshSessions = [{ sessionId: 's-bob', cwd: BOB, updatedAt: 1 }]
const dshWorkspaces = [{ workspaceId: 'w-bob', path: BOB, title: 'bob', sessionIds: ['s-bob'] }]
const calls = []
const upgraded = new Set()
let dsh, dshPort, gate, gatePort

function rpc(method, args) {
  calls.push(method)
  switch (method) {
    case 'session/list': return { items: dshSessions }
    case 'workspace/create': {
      let ws = dshWorkspaces.find(w => w.path === args.request.path)
      if (!ws) { ws = { workspaceId: `w-${dshWorkspaces.length}`, path: args.request.path, title: 't', sessionIds: [] }; dshWorkspaces.push(ws) }
      return { workspace: ws, created: true }
    }
    case 'session/create': {
      const ws = dshWorkspaces.find(w => w.workspaceId === args.request.workspaceId)
      const id = `s-${randomUUID().slice(0, 8)}`
      dshSessions.push({ sessionId: id, cwd: args.request.cwd ?? ws.path, updatedAt: 2, preset: args.request.agentPreset })
      return { sessionId: id }
    }
    default: return null
  }
}

function startDsh() {
  dsh = http.createServer((req, res) => {
    if (req.url.startsWith('/?token=')) { res.writeHead(303, { 'set-cookie': `${COOKIE}; Path=/`, location: '/' }); return res.end() }
    if (req.headers.cookie !== COOKIE) { res.writeHead(401); return res.end() }
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString())
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: msg.rpcId, result: { ok: true, value: rpc(msg.method, msg.payload.args) } }))
    })
  })
  dsh.on('upgrade', (req, socket) => {
    upgraded.add(socket)
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const send = obj => socket.write(encodeFrame(OP.TEXT, JSON.stringify(obj)))
    socket.on('data', createDecoder(({ opcode, data }) => {
      if (opcode !== OP.TEXT) return
      const f = JSON.parse(data.toString())
      calls.push(`mux:${f.type}:${f.endpoint ?? ''}`)
      if (f.type !== 'open') return
      if (f.endpoint === 'workspace/follow') send({ type: 'item', streamId: f.streamId, value: { type: 'baseline', value: { items: dshWorkspaces, archivedSessionIds: ['s-bob'] } } })
      if (f.endpoint === '$events') {
        send({ type: 'item', streamId: f.streamId, value: { type: 'ready', clientId: 'c1', host: { home: '/' } } })
        send({ type: 'item', streamId: f.streamId, value: { type: 'emit', event: 'api-session/status', args: ['s-bob', 'running'] } })
        send({ type: 'item', streamId: f.streamId, value: { type: 'waterfall', event: 'approval/request', eventId: 'e-bob', agentId: 's-bob', request: {} } })
        send({ type: 'item', streamId: f.streamId, value: { type: 'emit', event: 'commands/change', args: [] } })
      }
    }, () => socket.destroy()))
  })
  return new Promise(r => dsh.listen(0, '127.0.0.1', r))
}

before(async () => {
  await startDsh()
  dshPort = dsh.address().port
  const upstream = new Upstream(`http://127.0.0.1:${dshPort}/?token=t`)
  const call = (m, a) => callUpstream(upstream, m, a)
  const filter = createFilter({ upstream, sessions: new SessionIndex(call, { minRefreshMs: 0 }), call, storageRoot: storage })
  const users = { alice: { username: 'alice', role: 'user' }, boss: { username: 'boss', role: 'admin' } }
  gate = http.createServer((req, res) => filter.handleHttp(req, res, users[req.headers['x-user']]))
  gate.on('upgrade', (req, socket, head) => filter.handleUpgrade(req, socket, head, users[req.headers['x-user']]))
  await new Promise(r => gate.listen(0, '127.0.0.1', r))
  gatePort = gate.address().port
})
after(() => {
  for (const s of upgraded) s.destroy()
  gate.closeAllConnections(); dsh.closeAllConnections()
  gate.close(); dsh.close()
  rmSync(storage, { recursive: true, force: true })
})

function api(user, method, args) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } })
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: `/api/${method}`, headers: { 'x-user': user, 'content-type': 'application/json' } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Open the mux as `user`, send frames, collect what comes back for `ms`. */
function mux(user, frames, ms = 300) {
  return new Promise((resolve, reject) => {
    const s = net.connect(gatePort, '127.0.0.1')
    const got = []
    let open = false
    let buf = Buffer.alloc(0)
    const feed = createDecoder(({ opcode, data }) => { if (opcode === OP.TEXT) got.push(JSON.parse(data.toString())) }, reject)
    s.on('connect', () => s.write(`GET /api/remote.mux HTTP/1.1\r\nHost: x\r\nX-User: ${user}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`))
    s.on('data', chunk => {
      if (open) return feed(chunk)
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      assert.match(buf.subarray(0, end).toString(), /^HTTP\/1\.1 101/)
      assert.doesNotMatch(buf.subarray(0, end).toString(), /extensions/i)
      open = true
      if (buf.length > end + 4) feed(buf.subarray(end + 4))
      for (const f of frames) s.write(encodeFrame(OP.TEXT, JSON.stringify(f), { mask: true }))
      setTimeout(() => { s.destroy(); resolve(got) }, ms)
    })
    s.on('error', reject)
  })
}

describe('filter (HTTP)', () => {
  it('registers the user workspace and hides other users’ sessions', async () => {
    const res = await api('alice', 'session/list', { _request: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.result.value.items, [])
    assert.ok(dshWorkspaces.some(w => w.path === ALICE), 'workspace for alice created')
  })
  it('refuses acting on another user’s session without reaching DSH', async () => {
    const before = calls.filter(c => c === 'session/prompt').length
    const res = await api('alice', 'session/prompt', { request: { requestId: 'q', sessionId: 's-bob', mode: 'queue', content: [] } })
    assert.equal(res.body.result.ok, false)
    assert.equal(res.body.result.error.code, 'gate/forbidden')
    assert.equal(calls.filter(c => c === 'session/prompt').length, before)
  })
  it('creates a session in the user folder with the DocShield preset, then owns it', async () => {
    const wsAlice = dshWorkspaces.find(w => w.path === ALICE)
    const created = await api('alice', 'session/create', { request: { workspaceId: wsAlice.workspaceId, agentPreset: 'standard' } })
    assert.equal(created.body.result.ok, true)
    const id = created.body.result.value.sessionId
    assert.equal(dshSessions.find(s => s.sessionId === id).preset, 'docshield')
    const prompt = await api('alice', 'session/prompt', { request: { requestId: 'q', sessionId: id, mode: 'queue', content: [] } })
    assert.equal(prompt.body.result.ok, true)
    const list = await api('alice', 'session/list', { _request: {} })
    assert.deepEqual(list.body.result.value.items.map(s => s.sessionId), [id])
  })
  it('refuses creating a session in someone else’s workspace', async () => {
    const res = await api('alice', 'session/create', { request: { workspaceId: 'w-bob' } })
    assert.equal(res.body.result.ok, false)
  })
  it('refuses admin-only endpoints and files outside the folder', async () => {
    assert.equal((await api('alice', 'pluginManager/install', {})).body.result.ok, false)
    const file = await new Promise(r => http.get({ host: '127.0.0.1', port: gatePort, path: `/api/file?path=${encodeURIComponent(path.join(BOB, 'b.md'))}`, headers: { 'x-user': 'alice' } }, res => { res.resume(); r(res.statusCode) }))
    assert.equal(file, 403)
  })
  it('serves the user’s own file itself, never through a junction', async () => {
    const outside = path.join(storage, 'host-secrets')
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, 'secret.md'), 'API_KEY=sk-bi-mat')
    mkdirSync(path.join(ALICE, 'docs'), { recursive: true })
    writeFileSync(path.join(ALICE, 'docs', 'note.md'), 'ghi chú của alice')
    symlinkSync(outside, path.join(ALICE, 'docs', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const get = p => new Promise(r => http.get({ host: '127.0.0.1', port: gatePort, path: `/api/file?path=${encodeURIComponent(p)}`, headers: { 'x-user': 'alice' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => r({ status: res.statusCode, body: Buffer.concat(chunks).toString(), csp: res.headers['content-security-policy'] }))
    }))
    const own = await get(path.join(ALICE, 'docs', 'note.md'))
    assert.equal(own.status, 200)
    assert.equal(own.body, 'ghi chú của alice')
    assert.match(own.csp, /sandbox/)
    const viaLink = await get(path.join(ALICE, 'docs', 'link', 'secret.md'))
    assert.equal(viaLink.status, 403)
    assert.doesNotMatch(viaLink.body, /sk-bi-mat/)
  })
  it('relays admins unchanged', async () => {
    const res = await api('boss', 'session/list', { _request: {} })
    assert.ok(res.body.result.value.items.some(s => s.sessionId === 's-bob'))
  })
})

describe('filter (WebSocket mux)', () => {
  it('filters the workspace baseline and events; refuses foreign streams locally', async () => {
    const got = await mux('alice', [
      { type: 'open', streamId: 'w', endpoint: 'workspace/follow', payload: { args: {} } },
      { type: 'open', streamId: 'e', endpoint: '$events', payload: { args: {} } },
      { type: 'open', streamId: 'f', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 's-bob' } } } } },
      { type: 'open', streamId: 't', endpoint: 'terminal/follow', payload: { args: { agentId: 's-bob', id: 'x', attachmentId: 'y' } } },
    ])
    const baseline = got.find(f => f.streamId === 'w').value
    assert.deepEqual(baseline.value.items.map(w => w.path), [ALICE])
    assert.deepEqual(baseline.value.archivedSessionIds, [])
    const events = got.filter(f => f.streamId === 'e').map(f => f.value.type === 'emit' ? f.value.event : f.value.type)
    assert.deepEqual(events, ['ready', 'commands/change'])
    assert.equal(got.find(f => f.streamId === 'f').type, 'error')
    assert.equal(got.find(f => f.streamId === 't').type, 'error')
    assert.ok(!calls.includes('mux:open:session/follow'), 'foreign follow never reached DSH')
    assert.ok(!calls.includes('mux:open:terminal/follow'))
  })
  it('refuses answering an approval that was not delivered to the user', async () => {
    const res = await api('alice', '$events/result', { clientId: 'c1', eventId: 'e-bob', outcome: { kind: 'result', value: 'allowed-once' } })
    assert.equal(res.body.result.ok, false)
  })
})
