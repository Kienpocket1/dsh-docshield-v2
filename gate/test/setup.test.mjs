import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createGate } from '../src/app.mjs'
import { GateStore } from '../src/store.mjs'
import { passthrough, unused } from './helpers.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-gate-setup-'))
const KEY = 'ab12-cd34-ef56'
let gate, port, store, upstream

before(async () => {
  upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('DSH') })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const up = upstream.address().port
  store = new GateStore(path.join(dir, 'setup.db'))
  gate = createGate({ store, secret: Buffer.alloc(32, 3), ...passthrough(up), setupKey: KEY })
  await new Promise(r => gate.listen(0, '127.0.0.1', r))
  port = gate.address().port
})
after(() => { gate.close(); upstream.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })

const request = (method, p, { cookie, body } = {}) => new Promise((resolve, reject) => {
  const headers = { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
  })
  req.on('error', reject)
  req.end(body)
})
const cookieOf = (res, name) => (res.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).find(c => c.startsWith(`${name}=`))

async function submitSetup(fields) {
  const page = await request('GET', '/gate/setup')
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1]
  return request('POST', '/gate/setup', { cookie: cookieOf(page, 'gate_csrf'), body: new URLSearchParams({ csrf, ...fields }).toString() })
}

describe('first-run setup', () => {
  it('sends everyone to /gate/setup while no account exists', async () => {
    assert.equal((await request('GET', '/')).headers.location, '/gate/setup')
    assert.equal((await request('GET', '/gate/login')).headers.location, '/gate/setup')
    assert.match((await request('GET', '/gate/setup')).body, /Mã thiết lập/)
  })

  it('rejects a wrong key and mismatched passwords without creating anyone', async () => {
    assert.equal((await submitSetup({ setup_key: 'wrong-key-000', username: 'boss', password: 'boss-password', password2: 'boss-password' })).status, 401)
    assert.equal((await submitSetup({ setup_key: KEY, username: 'boss', password: 'boss-password', password2: 'other-password' })).status, 400)
    assert.equal((await submitSetup({ setup_key: KEY, username: 'Bad Name', password: 'boss-password', password2: 'boss-password' })).status, 400)
    assert.equal(store.countUsers(), 0)
  })

  it('creates the admin, signs them in, then closes for good', async () => {
    const res = await submitSetup({ setup_key: KEY, username: 'boss', password: 'boss-password', password2: 'boss-password' })
    assert.equal(res.status, 303)
    const session = cookieOf(res, 'gate_session')
    assert.ok(session)
    assert.equal(store.getUser('boss').role, 'admin')
    assert.equal((await request('GET', '/', { cookie: session })).body, 'DSH')
    assert.equal((await request('GET', '/gate/setup')).headers.location, '/gate/login')
    assert.equal((await request('POST', '/gate/setup', { body: `setup_key=${KEY}&username=evil&password=evil-password&password2=evil-password` })).headers.location, '/gate/login')
    assert.equal(store.countUsers(), 1)
    assert.equal((await request('GET', '/gate/login')).status, 200)
  })

  it('without a setup key the page is closed even with no accounts', async () => {
    const empty = new GateStore(path.join(dir, 'nokey.db'))
    const g = createGate({ store: empty, secret: Buffer.alloc(32, 4), ...unused })
    await new Promise(r => g.listen(0, '127.0.0.1', r))
    const res = await new Promise(resolve => http.get({ host: '127.0.0.1', port: g.address().port, path: '/gate/setup' }, r => { r.resume(); resolve(r) }))
    assert.equal(res.headers.location, '/gate/login')
    g.close()
    empty.close()
  })
})
