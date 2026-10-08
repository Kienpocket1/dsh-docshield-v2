/** Behind a local tunnel: real client IP from CF-Connecting-IP, Secure cookies over https, no spoofing when off. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { createGate, isTrustedPeer } from '../src/app.mjs'
import { takeCalibrationToken } from '../src/config.mjs'
import { hashPassword } from '../src/password.mjs'
import { GateStore } from '../src/store.mjs'
import { unused } from './helpers.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-gate-proxy-'))
after(() => rmSync(dir, { recursive: true, force: true }))

async function startGate(trustProxy, name, extra = {}) {
  const store = new GateStore(path.join(dir, `${name}.db`))
  store.addUser('alice', 'user', await hashPassword('alice-password'))
  const logs = []
  const gate = createGate({ store, secret: Buffer.alloc(32, 5), ...unused, trustProxy, log: m => logs.push(m), ...extra })
  await new Promise(r => gate.listen(0, '127.0.0.1', r))
  return { store, gate, logs, port: gate.address().port }
}

const request = (port, method, p, headers = {}, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...headers, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
  })
  req.on('error', reject)
  req.end(body)
})

async function failLogin({ port }, headers) {
  const page = await request(port, 'GET', '/gate/login', headers)
  const csrfCookie = page.headers['set-cookie'].map(c => c.split(';')[0]).find(c => c.startsWith('gate_csrf='))
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1]
  return request(port, 'POST', '/gate/login', { ...headers, cookie: csrfCookie }, `username=alice&password=wrong-password&csrf=${csrf}&next=/`)
}

describe('trusted local proxy', () => {
  it('uses CF-Connecting-IP for audit/lockout and marks cookies Secure over https', async () => {
    const g = await startGate(true, 'on')
    const page = await request(g.port, 'GET', '/gate/login', { 'x-forwarded-proto': 'https' })
    assert.ok(page.headers['set-cookie'].every(c => /; Secure/.test(c)))
    await failLogin(g, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https' })
    assert.equal(g.store.recentAudit(1)[0].ip, '203.0.113.7')
    // Five failures lock only that client IP, not everyone behind the tunnel.
    for (let i = 0; i < 5; i++) await failLogin(g, { 'cf-connecting-ip': '203.0.113.7' })
    assert.ok(g.store.lockRemaining('alice', '203.0.113.7') > 0)
    assert.equal(g.store.lockRemaining('alice', '198.51.100.9'), 0)
    g.gate.close(); g.store.close()
  })

  it('ignores forwarded headers when trustProxy is off', async () => {
    const g = await startGate(false, 'off')
    const page = await request(g.port, 'GET', '/gate/login', { 'x-forwarded-proto': 'https' })
    assert.ok(page.headers['set-cookie'].every(c => !/; Secure/.test(c)))
    await failLogin(g, { 'cf-connecting-ip': '203.0.113.7' })
    assert.equal(g.store.recentAudit(1)[0].ip, '127.0.0.1')
    g.gate.close(); g.store.close()
  })
})

describe('cross-site requests', () => {
  it('refuses POST and WebSocket upgrades whose Origin is another site', async () => {
    const g = await startGate(false, 'origin')
    const host = `127.0.0.1:${g.port}`
    assert.equal((await request(g.port, 'POST', '/gate/logout', { origin: 'https://evil.example' })).status, 403)
    assert.equal((await request(g.port, 'POST', '/api/session/prompt', { origin: 'null' })).status, 403)
    assert.equal((await request(g.port, 'POST', '/gate/logout', { origin: `http://${host}` })).status, 303)
    assert.equal((await request(g.port, 'POST', '/gate/logout')).status, 303)
    const upgrade = await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: g.port, path: '/api/remote.mux', headers: { connection: 'Upgrade', upgrade: 'websocket', origin: 'http://localhost:9999' } })
      req.on('response', res => resolve(res.statusCode))
      req.on('upgrade', () => resolve(101))
      req.end()
    })
    assert.equal(upgrade, 403)
    g.gate.close(); g.store.close()
  })
})

describe('shared NAT address (Docker mode)', () => {
  it('a flood of failures from the shared address does not lock other accounts out', async () => {
    const g = await startGate(false, 'shared', { sharedDirectAddr: true })
    for (let i = 0; i < 60; i++) g.store.recordFailure(`spray${i}`, '127.0.0.1')
    const page = await request(g.port, 'GET', '/gate/login')
    const csrfCookie = page.headers['set-cookie'].map(c => c.split(';')[0]).find(c => c.startsWith('gate_csrf='))
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1]
    const res = await request(g.port, 'POST', '/gate/login', { cookie: csrfCookie }, `username=alice&password=alice-password&csrf=${csrf}&next=/`)
    assert.equal(res.status, 303)
    // Without the flag (one real client per address) the same flood locks the address.
    assert.ok(g.store.lockRemaining('alice', '127.0.0.1') > 0)
    g.gate.close(); g.store.close()
  })
})

describe('trusted peers (Docker + tunnel)', () => {
  it('trusts loopback and exactly the listed addresses, IPv4-mapped or not', () => {
    assert.ok(isTrustedPeer('127.0.0.1'))
    assert.ok(isTrustedPeer('::1'))
    assert.ok(isTrustedPeer('192.168.65.1', ['192.168.65.1']))
    assert.ok(isTrustedPeer('::ffff:192.168.65.1', ['192.168.65.1']))
    assert.ok(isTrustedPeer('192.168.65.1', ['::ffff:192.168.65.1'].map(a => a.replace(/^::ffff:/, ''))))
    assert.ok(!isTrustedPeer('192.168.65.2', ['192.168.65.1']))
    assert.ok(!isTrustedPeer('172.17.0.1', []))
    assert.ok(!isTrustedPeer(undefined, ['192.168.65.1']))
    assert.ok(!isTrustedPeer('', ['']))
  })

  it('takeCalibrationToken returns a Buffer and removes the variable from the environment', () => {
    const env = { GATE_CALIBRATION_TOKEN: 'b'.repeat(64), OTHER: 'x' }
    const token = takeCalibrationToken(env)
    assert.ok(Buffer.isBuffer(token))
    assert.equal(token.toString(), 'b'.repeat(64))
    assert.deepEqual(Object.keys(env), ['OTHER'])
    assert.equal(takeCalibrationToken({}), undefined)
  })

  it('POST /gate/calibrate: wrong token 403, right token 204 once (token zeroed), then 404 even with the old token', async () => {
    const token = Buffer.from('c'.repeat(64))
    const g = await startGate(true, 'calib', { calibrationToken: token })
    assert.equal((await request(g.port, 'GET', '/gate/calibrate', { 'x-gate-calibration': 'c'.repeat(64) })).status, 404)
    assert.equal((await request(g.port, 'POST', '/gate/calibrate', { 'x-gate-calibration': 'd'.repeat(64) })).status, 403)
    assert.equal((await request(g.port, 'POST', '/gate/calibrate', {})).status, 403)
    assert.equal((await request(g.port, 'POST', '/gate/calibrate', { 'x-gate-calibration': 'c'.repeat(64) })).status, 204)
    assert.ok(token.every(b => b === 0), 'token buffer zeroed')
    assert.equal((await request(g.port, 'POST', '/gate/calibrate', { 'x-gate-calibration': 'c'.repeat(64) })).status, 404)
    assert.ok(g.logs.some(m => /tin địa chỉ proxy 127.0.0.1/.test(m)))
    assert.ok(!g.logs.join(' ').includes('c'.repeat(16)), 'token never logged')
    g.gate.close(); g.store.close()
  })

  it('no calibration route without trustProxy or without a token', async () => {
    const off = await startGate(false, 'calib-off', { calibrationToken: Buffer.from('e'.repeat(64)) })
    assert.equal((await request(off.port, 'POST', '/gate/calibrate', { 'x-gate-calibration': 'e'.repeat(64) })).status, 404)
    off.gate.close(); off.store.close()
    const none = await startGate(true, 'calib-none')
    assert.equal((await request(none.port, 'POST', '/gate/calibrate', { 'x-gate-calibration': '' })).status, 404)
    none.gate.close(); none.store.close()
  })
})
