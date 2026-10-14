/** Self-registration, admin approval, admin account management, forced password change. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createGate, tempPassword } from '../src/app.mjs'
import { hashPassword } from '../src/password.mjs'
import { GateStore } from '../src/store.mjs'
import { passthrough } from './helpers.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-gate-acc-'))
let gate, port, store, upstream
const stopped = []

before(async () => {
  upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('DSH') })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const up = upstream.address().port
  store = new GateStore(path.join(dir, 'acc.db'))
  store.addUser('boss', 'admin', await hashPassword('boss-password'))
  const { upstream: dsh, filter } = passthrough(up, { disconnected: stopped })
  gate = createGate({ store, secret: Buffer.alloc(32, 9), upstream: dsh, filter })
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
const field = (html, name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1]

async function anonForm(pagePath, fields) {
  const page = await request('GET', pagePath)
  return request('POST', pagePath, { cookie: cookieOf(page, 'gate_csrf'), body: new URLSearchParams({ csrf: field(page.body, 'csrf'), ...fields }).toString() })
}
const login = (username, password) => anonForm('/gate/login', { username, password, next: '/' })
const register = (username, password, password2 = password) => anonForm('/gate/register', { username, password, password2 })

async function adminAction(session, action, username, extra = {}) {
  const page = await request('GET', '/gate/admin', { cookie: session })
  return request('POST', '/gate/admin', { cookie: session, body: new URLSearchParams({ token: field(page.body, 'token'), action, username, ...extra }).toString() })
}

describe('self-registration and approval', () => {
  let boss
  before(async () => { boss = cookieOf(await login('boss', 'boss-password'), 'gate_session') })

  it('login page links to registration; registering creates a pending account that cannot sign in', async () => {
    assert.match((await request('GET', '/gate/login')).body, /Đăng ký/)
    const res = await register('carol', 'carol-password')
    assert.equal(res.status, 200)
    assert.match(res.body, /chờ admin duyệt/)
    assert.equal(store.getUser('carol').status, 'pending')
    const attempt = await login('carol', 'carol-password')
    assert.equal(attempt.status, 403)
    assert.match(attempt.body, /chờ admin duyệt/)
    assert.equal(cookieOf(attempt, 'gate_session'), undefined)
  })

  it('rejects reserved, malformed, duplicate names and mismatched passwords', async () => {
    assert.match((await register('admin', 'admin-password')).body, /giữ lại/)
    assert.match((await register('Bad Name', 'bad-password')).body, /3–32 ký tự/)
    assert.match((await register('carol', 'carol-password')).body, /đã có người dùng/)
    assert.match((await register('dave', 'dave-password', 'other-password')).body, /không khớp/)
    assert.match((await register('dave', 'short')).body, /ít nhất 8/)
  })

  it('admin page is admin-only and lists the pending request', async () => {
    const page = await request('GET', '/gate/admin', { cookie: boss })
    assert.equal(page.status, 200)
    assert.match(page.body, /carol/)
    assert.match(page.body, /Chờ duyệt/)
    assert.equal((await request('GET', '/gate/admin')).status, 302)
  })

  it('approve lets the user sign in; a non-admin gets 403 on the admin page', async () => {
    assert.equal((await adminAction(boss, 'approve', 'carol')).headers.location, '/gate/admin?ok=approved')
    const carol = cookieOf(await login('carol', 'carol-password'), 'gate_session')
    assert.ok(carol)
    assert.equal((await request('GET', '/', { cookie: carol })).body, 'DSH')
    assert.equal((await request('GET', '/gate/admin', { cookie: carol })).status, 403)
  })

  it('reject removes a pending request; forged tokens are refused', async () => {
    await register('erin', 'erin-password')
    assert.equal((await request('POST', '/gate/admin', { cookie: boss, body: 'token=forged&action=reject&username=erin' })).status, 400)
    assert.equal(store.getUser('erin').status, 'pending')
    await adminAction(boss, 'reject', 'erin')
    assert.equal(store.getUser('erin'), undefined)
  })

  it('limits accepted requests per IP', async () => {
    // carol and erin already counted; three more reach the limit of 5.
    for (const u of ['gina', 'hank', 'ivan']) assert.equal((await register(u, `${u}-password`)).status, 200)
    const blocked = await register('judy', 'judy-password')
    assert.equal(blocked.status, 429)
    assert.equal(store.getUser('judy'), undefined)
    store.db.exec('DELETE FROM registrations')
  })

  it('closing registration hides the form', async () => {
    await adminAction(boss, 'close_registration', '-')
    assert.equal((await request('GET', '/gate/register')).status, 403)
    assert.doesNotMatch((await request('GET', '/gate/login')).body, /Chưa có tài khoản/)
    await adminAction(boss, 'open_registration', '-')
    assert.equal((await request('GET', '/gate/register')).status, 200)
  })
})

describe('account management', () => {
  let boss
  before(async () => {
    boss = cookieOf(await login('boss', 'boss-password'), 'gate_session')
    store.addUser('frank', 'user', await hashPassword('frank-password'))
  })

  it('disable signs the user out and stops their instance; enable restores', async () => {
    const frank = cookieOf(await login('frank', 'frank-password'), 'gate_session')
    await adminAction(boss, 'disable', 'frank')
    assert.ok(stopped.includes('frank'))
    assert.equal((await request('GET', '/', { cookie: frank })).status, 302)
    assert.equal((await login('frank', 'frank-password')).status, 401)
    await adminAction(boss, 'enable', 'frank')
    assert.equal((await login('frank', 'frank-password')).status, 303)
  })

  it('token plans: assign per user, edit limits, default and system plan; admins unlimited', async () => {
    assert.equal(store.planOf('frank').id, 'free')
    assert.equal((await adminAction(boss, 'set_plan', 'frank', { plan: 'max' })).status, 303)
    assert.equal(store.planOf('frank').id, 'max')
    assert.match((await adminAction(boss, 'set_plan', 'frank', { plan: 'gold' })).body, /Gói không hợp lệ/)
    await adminAction(boss, 'set_plan', 'frank', { plan: '' })
    assert.equal(store.planOf('frank').id, 'free')
    await adminAction(boss, 'set_default_plan', '-', { plan: 'pro' })
    assert.equal(store.planOf('frank').id, 'pro')
    await adminAction(boss, 'update_plan', '-', { plan: 'pro', session_limit: '123000', weekly_limit: '' })
    assert.deepEqual([store.getPlan('pro').session_limit, store.getPlan('pro').weekly_limit], [123000, null])
    assert.match((await adminAction(boss, 'update_plan', '-', { plan: 'pro', session_limit: '-5', weekly_limit: '1' })).body, /số nguyên/)
    await adminAction(boss, 'set_system_plan', '-', { plan: 'max' })
    assert.equal(store.planOf('(hệ thống)', 'system_plan').id, 'max')
    assert.equal(store.planOf('boss'), null)
    const page = (await request('GET', '/gate/admin', { cookie: boss })).body
    assert.match(page, /Gói token LLM/)
    assert.match(page, /123\.000/)
    assert.ok(store.recentAudit(5).some(a => a.event === 'plan_changed'))
    await adminAction(boss, 'set_default_plan', '-', { plan: 'free' })
    await adminAction(boss, 'update_plan', '-', { plan: 'pro', session_limit: '500000', weekly_limit: '2500000' })
  })

  it('/gate/usage shows only the signed-in user\'s own usage, frameable by the same origin only', async () => {
    store.addToWindow('frank', 'session', 25_000, Date.now(), 5 * 3600_000)
    store.addToWindow('boss', 'session', 99_999, Date.now(), 5 * 3600_000)
    const frank = cookieOf(await login('frank', 'frank-password'), 'gate_session')
    const res = await request('GET', '/gate/usage?embed=1', { cookie: frank })
    assert.equal(res.status, 200)
    assert.match(res.body, /Gói: <b>Free<\/b>/)
    assert.match(res.body, /25%/)
    assert.match(res.body, /25\.000 \/ 100\.000 token/)
    assert.doesNotMatch(res.body, /99\.999/)
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'self'/)
    assert.match((await request('GET', '/gate/admin', { cookie: boss })).headers['content-security-policy'], /frame-ancestors 'none'/)
    assert.match((await request('GET', '/gate/usage', { cookie: boss })).body, /Không giới hạn/)
    assert.equal((await request('GET', '/gate/usage')).status, 302)
  })

  it('protects the admin from locking themselves out', async () => {
    assert.match((await adminAction(boss, 'disable', 'boss')).body, /tự khóa/)
    assert.match((await adminAction(boss, 'make_user', 'boss')).body, /tự đổi vai trò/)
    assert.equal(store.getUser('boss').role, 'admin')
  })

  it('role change takes effect and ends the old session', async () => {
    const frank = cookieOf(await login('frank', 'frank-password'), 'gate_session')
    await adminAction(boss, 'make_admin', 'frank')
    assert.equal(store.getUser('frank').role, 'admin')
    assert.equal((await request('GET', '/', { cookie: frank })).status, 302)
    await adminAction(boss, 'make_user', 'frank')
    assert.equal(store.getUser('frank').role, 'user')
  })

  it('reset shows a temporary password once and forces a change at next sign-in', async () => {
    const reset = await adminAction(boss, 'reset_password', 'frank')
    assert.equal(reset.status, 200)
    const temp = /<div class="secret">([^<]+)<\/div>/.exec(reset.body)?.[1]
    assert.ok(temp)
    assert.equal(store.getUser('frank').must_change_password, 1)
    const signIn = await login('frank', temp)
    assert.equal(signIn.headers.location, '/gate/password')
    const frank = cookieOf(signIn, 'gate_session')
    assert.equal((await request('GET', '/', { cookie: frank })).headers.location, '/gate/password')
    assert.equal((await request('POST', '/api/session/list', { cookie: frank })).status, 403)
    const page = await request('GET', '/gate/password', { cookie: frank })
    assert.match(page.body, /mật khẩu tạm/)
    const change = await request('POST', '/gate/password', {
      cookie: frank,
      body: new URLSearchParams({ token: field(page.body, 'token'), current: temp, password: 'frank-new-password', password2: 'frank-new-password' }).toString(),
    })
    assert.equal(change.status, 303)
    const fresh = cookieOf(change, 'gate_session')
    assert.equal((await request('GET', '/', { cookie: fresh })).body, 'DSH')
    assert.equal(store.getUser('frank').must_change_password, 0)
    assert.equal((await login('frank', temp)).status, 401)
  })

  it('password page rejects a wrong current password', async () => {
    const frank = cookieOf(await login('frank', 'frank-new-password'), 'gate_session')
    const page = await request('GET', '/gate/password', { cookie: frank })
    const res = await request('POST', '/gate/password', {
      cookie: frank,
      body: new URLSearchParams({ token: field(page.body, 'token'), current: 'nope-nope', password: 'x-new-password', password2: 'x-new-password' }).toString(),
    })
    assert.equal(res.status, 401)
  })

  it('temporary passwords are readable and long enough', () => {
    const t = tempPassword()
    assert.match(t, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/)
    assert.doesNotMatch(t, /[01OIl]/)
  })
})

describe('store migration', () => {
  it('adds the new columns to a v1 database', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const file = path.join(dir, 'v1.db')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL, password_hash TEXT NOT NULL,
      credential_version INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT);
      INSERT INTO users (username, role, password_hash, created_at) VALUES ('old', 'admin', 'x', 'now');`)
    old.close()
    const s = new GateStore(file)
    assert.equal(s.getUser('old').status, 'active')
    assert.equal(s.getUser('old').must_change_password, 0)
    s.close()
  })
})
