// tool-manager builds every docker argument itself (TC2, TC13).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ZONE, toolRunArgs, zoneSpec } from '../tool-manager.mjs'

const TOKEN = 'a'.repeat(64)
const PROXY = 'b'.repeat(64)

describe('zone validation', () => {
  it('accepts only the three zone shapes', () => {
    for (const z of ['user:alice', 'user:bob_2', 'admin', 'admin-review']) assert.ok(ZONE.test(z), z)
    for (const z of ['user:Alice', 'user:al', 'user:alice bob', 'user:alice;rm', 'user:-x', 'user:../x', 'user:alice\n', 'root', 'admin ', '', 'user:alice --privileged']) {
      assert.ok(!ZONE.test(z), JSON.stringify(z))
      assert.throws(() => zoneSpec(z))
    }
  })
})

describe('docker run arguments', () => {
  it('are constants plus the validated zone, as an array (no shell string)', () => {
    const args = toolRunArgs('user:alice', TOKEN, PROXY)
    assert.ok(Array.isArray(args))
    for (const flag of ['--read-only', '--init', '--cap-drop', 'ALL', 'no-new-privileges', '--pids-limit', '256', '--memory', '256m', '--memory-swap']) assert.ok(args.includes(flag), flag)
    assert.ok(args.includes('1000:1000'))
    const mounts = args.filter((a, i) => args[i - 1] === '--mount')
    assert.deepEqual(mounts, ['type=volume,src=docshield-storage,dst=/data/users/alice,volume-subpath=users/alice'])
    assert.ok(!args.some(a => /privileged|docker\.sock|--network=host|^--pid(=|$)|^--ipc|^--userns/.test(a)))
  })
  it('admin sees admin + public docs; admin-review sees users read-only', () => {
    const admin = toolRunArgs('admin', TOKEN, PROXY).filter((a, i, all) => all[i - 1] === '--mount')
    assert.deepEqual(admin.map(m => m.split(',')[2]), ['dst=/data/admin', 'dst=/data/public_docs'])
    const review = toolRunArgs('admin-review', TOKEN).filter((a, i, all) => all[i - 1] === '--mount')
    assert.deepEqual(review, ['type=volume,src=docshield-storage,dst=/data/users,volume-subpath=users,readonly'])
  })
  it('refuses malformed tokens', () => {
    assert.throws(() => toolRunArgs('user:alice', 'x; rm -rf /', PROXY))
    assert.throws(() => toolRunArgs('user:alice', TOKEN, 'x; rm -rf /'))
    assert.throws(() => toolRunArgs('user:alice', TOKEN))
  })
  it('tool containers join only the internal tools network', () => {
    const args = toolRunArgs('user:alice', TOKEN, PROXY)
    assert.deepEqual(args.filter((a, i) => args[i - 1] === '--network'), ['docshield-tools'])
  })
})

describe('egress proxy settings', () => {
  const envOf = args => args.filter((a, i) => args[i - 1] === '-e')
  it('users and admin get proxy URLs for their own zone; admin-review gets none', () => {
    const user = envOf(toolRunArgs('user:alice', TOKEN, PROXY))
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.ok(user.includes(`${name}=http://user.alice:${PROXY}@egress-proxy:3128`), name)
    assert.ok(user.includes('NODE_USE_ENV_PROXY=1'))
    assert.ok(envOf(toolRunArgs('admin', TOKEN, PROXY)).includes(`HTTPS_PROXY=http://admin:${PROXY}@egress-proxy:3128`))
    const review = envOf(toolRunArgs('admin-review', TOKEN, PROXY))
    assert.ok(!review.some(e => /proxy/i.test(e)), review.join(' '))
  })
  it('matches what the proxy accepts', async () => {
    const { authZone, proxyUser, zoneToken } = await import('../../container/egress-proxy.mjs')
    const secret = 'c'.repeat(64)
    const url = new URL(envOf(toolRunArgs('user:alice', TOKEN, zoneToken(secret, 'user:alice'))).find(e => e.startsWith('HTTPS_PROXY=')).slice(12))
    const header = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
    assert.equal(authZone(header, secret), 'user:alice')
    assert.equal(proxyUser('user:alice'), url.username)
  })
})

describe('keyedQueue', () => {
  it('runs jobs of one zone in order, other zones in parallel, and survives a failing job', async () => {
    const { keyedQueue } = await import('../tool-manager.mjs')
    const q = keyedQueue()
    const log = []
    const job = (name, ms, fail = false) => () => new Promise((resolve, reject) => setTimeout(() => { log.push(name); fail ? reject(new Error(name)) : resolve(name) }, ms))
    const a1 = q('user:alice', job('a1', 60, true))
    const a2 = q('user:alice', job('a2', 10))
    const b1 = q('user:bob', job('b1', 20))
    await assert.rejects(a1, /a1/)
    assert.equal(await a2, 'a2')
    assert.equal(await b1, 'b1')
    assert.deepEqual(log, ['b1', 'a1', 'a2'])
  })
})
