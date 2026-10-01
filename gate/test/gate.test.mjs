import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createGate, safeNext } from '../src/app.mjs'
import { hashPassword, verifyPassword } from '../src/password.mjs'
import { downstreamHeaders, upstreamHeaders } from '../src/proxy.mjs'
import { issueSession, verifySession } from '../src/session.mjs'
import { GateStore } from '../src/store.mjs'
import { passthrough } from './helpers.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-gate-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('password', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword('mat-khau-dung')
    assert.equal(await verifyPassword('mat-khau-dung', h), true)
    assert.equal(await verifyPassword('mat-khau-sai', h), false)
    assert.match(h, /^scrypt\$16384\$8\$1\$/)
  })
  it('rejects short passwords', async () => {
    await assert.rejects(hashPassword('ngan'))
  })
})

describe('session cookie', () => {
  const secret = Buffer.alloc(32, 7)
  const user = { username: 'alice', credential_version: 1, disabled: 0 }
  it('round-trips and rejects tampering, expiry, revocation', () => {
    const c = issueSession(secret, user, 1_000)
    assert.equal(verifySession(secret, c, () => user, 2_000)?.username, 'alice')
    assert.equal(verifySession(secret, c.replace(/.$/, 'x'), () => user, 2_000), undefined)
    assert.equal(verifySession(secret, c, () => user, 1_000 + 13 * 3600_000), undefined)
    assert.equal(verifySession(secret, c, () => ({ ...user, credential_version: 2 }), 2_000), undefined)
    assert.equal(verifySession(secret, c, () => ({ ...user, disabled: 1 }), 2_000), undefined)
    assert.equal(verifySession(Buffer.alloc(32, 8), c, () => user, 2_000), undefined)
  })
})

describe('store', () => {
  it('locks after 5 failures and escalates', () => {
    const store = new GateStore(path.join(dir, 'lock.db'))
    for (let i = 0; i < 4; i++) store.recordFailure('bob', '1.2.3.4', 0)
    assert.equal(store.lockRemaining('bob', '1.2.3.4', 0), 0)
    store.recordFailure('bob', '1.2.3.4', 0)
    assert.equal(store.lockRemaining('bob', '1.2.3.4', 0), 60_000)
    assert.equal(store.lockRemaining('bob', '5.6.7.8', 0), 0)
    for (let i = 0; i < 5; i++) store.recordFailure('bob', '1.2.3.4', 0)
    assert.equal(store.lockRemaining('bob', '1.2.3.4', 0), 5 * 60_000)
    store.clearFailures('bob', '1.2.3.4')
    assert.equal(store.lockRemaining('bob', '1.2.3.4', 0), 0)
    store.close()
  })
  it('password change bumps credential_version', async () => {
    const store = new GateStore(path.join(dir, 'cv.db'))
    store.addUser('carol', 'user', await hashPassword('password-1'))
    const before = store.getUser('carol').credential_version
    store.setPassword('carol', await hashPassword('password-2'))
    assert.equal(store.getUser('carol').credential_version, before + 1)
    assert.throws(() => store.addUser('Bad Name', 'user', 'x'))
    store.close()
  })
})

describe('proxy headers', () => {
  const instance = { port: 5555, origin: 'http://127.0.0.1:5555', cookie: 'dsh-auth-abc=sig' }
  it('rewrites authority and never forwards browser cookies', () => {
    const h = upstreamHeaders({ host: 'gate:3444', origin: 'http://gate:3444', cookie: 'gate_session=x', referer: 'http://gate:3444/s?a=1', 'x-a': '1', connection: 'keep-alive' }, instance)
    assert.equal(h.host, '127.0.0.1:5555')
    assert.equal(h.origin, 'http://127.0.0.1:5555')
    assert.equal(h.cookie, 'dsh-auth-abc=sig')
    assert.equal(h.referer, 'http://127.0.0.1:5555/s?a=1')
    assert.equal(h['x-a'], '1')
    assert.equal(h.connection, undefined)
  })
  it('drops upstream cookies and relativizes redirects', () => {
    const h = downstreamHeaders({ 'set-cookie': ['dsh-auth-x=1'], location: 'http://127.0.0.1:5555/next' }, instance)
    assert.equal(h['set-cookie'], undefined)
    assert.equal(h.location, '/next')
  })
  it('safeNext blocks open redirects', () => {
    assert.equal(safeNext('/abc?x=1'), '/abc?x=1')
    assert.equal(safeNext('//evil.com'), '/')
    assert.equal(safeNext('https://evil.com'), '/')
    assert.equal(safeNext('/\\evil.com'), '/')
    assert.equal(safeNext('/gate/logout'), '/')
  })
})

describe('gate end to end (fake DSH upstream)', () => {
  let upstream, gate, gatePort, store
  const seen = []
  before(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ url: req.url, cookie: req.headers.cookie, host: req.headers.host })
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'leak=1' })
        return res.end('<html><body>DSH</body></html>')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, url: req.url }))
    })
    upstream.on('upgrade', (req, socket) => {
      seen.push({ upgrade: req.url, cookie: req.headers.cookie })
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.end('pong')
    })
    await new Promise(r => upstream.listen(0, '127.0.0.1', r))
    const up = upstream.address().port
    store = new GateStore(path.join(dir, 'e2e.db'))
    store.addUser('alice', 'user', await hashPassword('alice-password'))
    const { upstream: dsh, filter, seenUsers } = passthrough(up, { cookie: 'dsh-auth-up=ok' })
    gate = createGate({ store, secret: Buffer.alloc(32, 1), upstream: dsh, filter })
    await new Promise(r => gate.listen(0, '127.0.0.1', r))
    gatePort = gate.address().port
    gate.started = seenUsers
  })
  after(() => { gate.close(); upstream.close(); store.close() })

  const request = (method, p, { cookie, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method, path: p, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
  const cookieValue = (res, name) => (res.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).find(c => c.startsWith(`${name}=`))

  const login = async (username, password) => {
    const page = await request('GET', '/gate/login')
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1]
    return request('POST', '/gate/login', {
      cookie: cookieValue(page, 'gate_csrf'),
      body: new URLSearchParams({ username, password, csrf, next: '/' }).toString(),
    })
  }

  it('redirects pages and rejects API/WebSocket without login (TC-03)', async () => {
    assert.equal((await request('GET', '/')).status, 302)
    assert.equal((await request('POST', '/api/session/list')).status, 401)
    const reply = await new Promise(resolve => {
      const s = net.connect(gatePort, '127.0.0.1', () => s.write('GET /api/remote.mux HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'))
      let data = ''
      s.on('data', d => { data += d })
      s.on('close', () => resolve(data))
    })
    assert.match(reply, /^HTTP\/1\.1 401/)
  })

  it('rejects wrong password and missing CSRF', async () => {
    assert.equal((await login('alice', 'wrong-password')).status, 401)
    assert.equal((await login('nobody', 'whatever-123')).status, 401)
    const noCsrf = await request('POST', '/gate/login', { body: 'username=alice&password=alice-password&csrf=x' })
    assert.equal(noCsrf.status, 400)
  })

  it('logs in, proxies with the DSH cookie, injects the bar, hides upstream cookies', async () => {
    const res = await login('alice', 'alice-password')
    assert.equal(res.status, 303)
    const session = cookieValue(res, 'gate_session')
    assert.ok(session)
    const index = await request('GET', '/', { cookie: session })
    assert.equal(index.status, 200)
    assert.match(index.body, /DSH/)
    assert.match(index.body, /Đăng xuất/)
    assert.equal(index.headers['set-cookie'], undefined)
    const api = await request('POST', '/api/session/list', { cookie: `${session}; other=1` })
    assert.equal(JSON.parse(api.body).ok, true)
    const last = seen.at(-1)
    assert.equal(last.cookie, 'dsh-auth-up=ok')
    assert.match(last.host, /^127\.0\.0\.1:/)
    assert.deepEqual([...new Set(gate.started)], ['alice'])
  })

  it('logout clears the cookie; password change revokes old sessions', async () => {
    const session = cookieValue(await login('alice', 'alice-password'), 'gate_session')
    const out = await request('POST', '/gate/logout', { cookie: session })
    assert.equal(out.status, 303)
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/)
    store.setPassword('alice', await hashPassword('new-alice-password'))
    assert.equal((await request('GET', '/', { cookie: session })).status, 302)
  })
})
