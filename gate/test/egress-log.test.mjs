// /gate/admin internet section: the egress proxy log, read defensively.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readEgressLog, summarize } from '../src/egress-log.mjs'
import { renderAdmin } from '../src/views.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'gate-egress-'))
const now = new Date().toISOString()
const entry = extra => ({ t: now, zone: 'user:alice', method: 'CONNECT', host: 'example.com', port: 443, ip: '93.184.216.34', status: 200, up: 1000, down: 5000, ms: 40, ...extra })

describe('readEgressLog', () => {
  it('returns the newest entries first and skips garbage lines', () => {
    const file = path.join(dir, 'a.jsonl')
    writeFileSync(file, [JSON.stringify(entry({ host: 'first.example' })), 'not json', '{"no":"fields"}', JSON.stringify(entry({ host: 'second.example' })), ''].join('\n'))
    const got = readEgressLog(file)
    assert.deepEqual(got.map(e => e.host), ['second.example', 'first.example'])
  })
  it('is undefined (section hidden) without a file', () => {
    assert.equal(readEgressLog(undefined), undefined)
    assert.equal(readEgressLog(path.join(dir, 'missing.jsonl')), undefined)
  })
  it('reads only the tail of a big file', () => {
    const file = path.join(dir, 'big.jsonl')
    const line = JSON.stringify(entry({ host: 'x'.repeat(200) }))
    writeFileSync(file, `${line}\n`.repeat(5000))
    const got = readEgressLog(file, 10000)
    assert.ok(got.length > 0 && got.length < 5000, String(got.length))
  })
})

describe('summarize + admin page', () => {
  const entries = [
    entry({}),
    entry({ host: '192.168.65.254', status: 403, deny: 'private-ip 192.168.65.254', up: 0, down: 0 }),
    entry({ zone: 'admin', up: 10, down: 20 }),
    entry({ t: '2000-01-01T00:00:00.000Z', up: 999999 }),
  ]
  it('totals per zone over the last 24 hours', () => {
    const s = summarize(entries, Date.now() - 24 * 3600_000)
    assert.deepEqual(s.find(x => x.zone === 'user:alice'), { zone: 'user:alice', requests: 2, denied: 1, up: 1000, down: 5000 })
    assert.equal(s.find(x => x.zone === 'admin').requests, 1)
  })
  const base = { token: 't', me: { username: 'boss' }, users: [], audit: [], registrationOpen: false }
  it('shows the section with escaped values, and hides it when there is no log', () => {
    const html = renderAdmin({ ...base, egress: [...entries, entry({ host: '<script>x</script>' })] })
    assert.match(html, /Truy cập internet \(24 giờ qua\)/)
    assert.match(html, /Địa chỉ nội bộ · 192\.168\.65\.254/)
    assert.ok(!html.includes('<script>x'))
    assert.ok(!renderAdmin(base).includes('Truy cập internet'))
  })
})
