/** Behind a local tunnel: real client IP from CF-Connecting-IP, Secure cookies over https, no spoofing when off. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { createGate } from '../src/app.mjs'
import { hashPassword } from '../src/password.mjs'
import { GateStore } from '../src/store.mjs'
import { unused } from './helpers.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-gate-proxy-'))
after(() => rmSync(dir, { recursive: true, force: true }))

async function startGate(trustProxy, name) {
  const store = new GateStore(path.join(dir, `${name}.db`))
  store.addUser('alice', 'user', await hashPassword('alice-password'))
  const gate = createGate({ store, secret: Buffer.alloc(32, 5), ...unused, trustProxy })
  await new Promise(r => gate.listen(0, '127.0.0.1', r))
  return { store, gate, port: gate.address().port }
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
