import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertInZone, clean, rootsOf, zoneOfCall, zoneOfCwd, ZoneError } from '../src/zones.mjs'

const agentsFor = (header, id = 's1') => ({ currentInitiator: () => ({ session: { id, header } }) })
const none = { currentInitiator: () => undefined }

describe('zoneOfCwd', () => {
  it('maps folders to zones', () => {
    assert.equal(zoneOfCwd('/data/users/alice'), 'user:alice')
    assert.equal(zoneOfCwd('/data/users/alice/docs/sub'), 'user:alice')
    assert.equal(zoneOfCwd('/data/admin'), 'admin')
    assert.equal(zoneOfCwd('/data/users'), 'admin-review')
  })
  it('refuses anything else', () => {
    for (const p of ['/data', '/data/public_docs', '/data/users/Al ice', '/data/users/../admin2', '/etc', 'data/users/alice', '/data/users/a', '', undefined, '/data/users/alice\0x']) {
      assert.equal(zoneOfCwd(p), p === '/data/users/../admin2' ? undefined : undefined, String(p))
    }
    assert.equal(zoneOfCwd('/data/users/alice/../bob'), 'user:bob', 'normalized before mapping')
  })
})

describe('assertInZone (TC1, TC10)', () => {
  it('accepts paths inside, including Vietnamese names', () => {
    assert.equal(assertInZone('user:alice', '/data/users/alice/docs/Lịch họp.md'), '/data/users/alice/docs/Lịch họp.md')
    assert.equal(assertInZone('user:alice', 'docs/a.md', '/data/users/alice'), '/data/users/alice/docs/a.md')
    assert.equal(assertInZone('admin', '/data/public_docs/q.md'), '/data/public_docs/q.md')
  })
  it('refuses other users, traversal, NUL, prefixes', () => {
    const bad = [
      ['user:alice', '/data/users/bob/x'], ['user:alice', '/data/users/alice/../bob/x'], ['user:alice', '../bob/x', '/data/users/alice'],
      ['user:alice', '/data/users/alice2/x'], ['user:alice', '/data/users/alice/x\0.md'], ['user:alice', '/etc/passwd'],
      ['admin', '/data/users/alice/x'], ['admin-review', '/data/admin/x'],
    ]
    for (const [z, p, cwd] of bad) assert.throws(() => assertInZone(z, p, cwd), ZoneError, `${z} ${p}`)
  })
  it('validates zone names', () => {
    assert.throws(() => rootsOf('user:Bob'), ZoneError)
    assert.throws(() => rootsOf('user:a;b'), ZoneError)
    assert.throws(() => clean('relative'), ZoneError)
  })
})

describe('zoneOfCall (TC1, TC5, TC6)', () => {
  it('uses the running session, not the arguments', () => {
    assert.equal(zoneOfCall(agentsFor({ cwd: '/data/users/alice' }), undefined, undefined), 'user:alice')
  })
  it('a subagent session keeps its own (inherited) cwd', () => {
    assert.equal(zoneOfCall(agentsFor({ cwd: '/data/users/alice', parentSession: 'p', origin: 'subagent' }, 'child'), undefined, undefined), 'user:alice')
  })
  it('refuses a session outside storage', () => {
    assert.throws(() => zoneOfCall(agentsFor({ cwd: '/opt/dsh' }), undefined, undefined), ZoneError)
  })
  it('refuses a policy naming another session', () => {
    assert.throws(() => zoneOfCall(agentsFor({ cwd: '/data/users/alice' }, 's1'), undefined, 's2'), ZoneError)
  })
  it('without an agent: only DSH sessionId fallback, otherwise refused', () => {
    const sessions = { get: id => (id === 's9' ? { header: { cwd: '/data/users/bob' } } : undefined) }
    const logs = []
    assert.equal(zoneOfCall(none, sessions, 's9', m => logs.push(m)), 'user:bob')
    assert.equal(logs.length, 1)
    assert.throws(() => zoneOfCall(none, sessions, undefined), ZoneError)
    assert.throws(() => zoneOfCall(none, sessions, 'unknown'), ZoneError)
    assert.throws(() => zoneOfCall(undefined, undefined, undefined), ZoneError)
  })
})
