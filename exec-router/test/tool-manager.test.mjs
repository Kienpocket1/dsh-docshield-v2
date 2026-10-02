// tool-manager builds every docker argument itself (TC2, TC13).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ZONE, toolRunArgs, zoneSpec } from '../tool-manager.mjs'

const TOKEN = 'a'.repeat(64)

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
    const args = toolRunArgs('user:alice', TOKEN)
    assert.ok(Array.isArray(args))
    for (const flag of ['--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--memory-swap']) assert.ok(args.includes(flag), flag)
    assert.ok(args.includes('1000:1000'))
    const mounts = args.filter((a, i) => args[i - 1] === '--mount')
    assert.deepEqual(mounts, ['type=volume,src=docshield-storage,dst=/data/users/alice,volume-subpath=users/alice'])
    assert.ok(!args.some(a => /privileged|docker\.sock|--network=host|^--pid(=|$)|^--ipc|^--userns/.test(a)))
  })
  it('admin sees admin + public docs; admin-review sees users read-only', () => {
    const admin = toolRunArgs('admin', TOKEN).filter((a, i, all) => all[i - 1] === '--mount')
    assert.deepEqual(admin.map(m => m.split(',')[2]), ['dst=/data/admin', 'dst=/data/public_docs'])
    const review = toolRunArgs('admin-review', TOKEN).filter((a, i, all) => all[i - 1] === '--mount')
    assert.deepEqual(review, ['type=volume,src=docshield-storage,dst=/data/users,volume-subpath=users,readonly'])
  })
  it('refuses malformed tokens', () => {
    assert.throws(() => toolRunArgs('user:alice', 'x; rm -rf /'))
  })
  it('tool containers join only the internal tools network', () => {
    const args = toolRunArgs('user:alice', TOKEN)
    assert.deepEqual(args.filter((a, i) => args[i - 1] === '--network'), ['docshield-tools'])
  })
})
