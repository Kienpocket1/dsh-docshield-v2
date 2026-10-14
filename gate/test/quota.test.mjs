/** Token quota by plan (5-hour + weekly windows): the gate's ledger (Quota) and the plugin's llm/stream wrapper (quotaStream). */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { quotaStream } from '../plugin/index.mjs'
import { ADMIN, Quota, SYSTEM, WINDOWS, ownerOfCwd, usageOf, vnTime } from '../src/quota.mjs'
import { GateStore } from '../src/store.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-gate-quota-'))
const root = path.join(dir, 'storage')
const store = new GateStore(path.join(dir, 'q.db'))
store.addUser('alice', 'user', 'x')
store.addUser('boss', 'admin', 'x')
after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

const H = 3600_000
const cwds = { 'a-1': path.join(root, 'users', 'alice', 'chat'), 'a-2': path.join(root, 'users', 'alice'), 'b-1': path.join(root, 'admin') }
let clock, quota
beforeEach(() => {
  store.db.exec('DELETE FROM quota_windows')
  store.updatePlan('free', 10_000, 50_000)
  store.setPlan('alice', 'free')
  store.setSetting('system_plan', '')
  clock = Date.parse('2026-10-13T05:00:00Z')
  quota = new Quota({ store, sessions: { ensure: async () => {}, cwdOf: id => cwds[id] }, storageRoot: root, now: () => clock })
})
const call = async (sessionId, tokens, outCap = 0) => {
  const r = await quota.reserve({ sessionId, outCap })
  if (r.ok) quota.settle({ ticket: r.ticket, input: tokens, output: 0 })
  return r
}

describe('store.addToWindow (atomic open-or-add)', () => {
  it('creates, accumulates, and reopens an ended window in one statement', () => {
    store.addToWindow('w', 'session', 100, 1_000, 5 * H)
    store.addToWindow('w', 'session', 50, 2_000, 5 * H)
    assert.deepEqual({ ...store.getWindow('w', 'session') }, { started_at: 1_000, used: 150 })
    store.addToWindow('w', 'session', 7, 1_000 + 5 * H, 5 * H)
    assert.deepEqual({ ...store.getWindow('w', 'session') }, { started_at: 1_000 + 5 * H, used: 7 })
  })

  it('refuses a non-integer start (an ISO string would compare wrongly)', () => {
    assert.throws(() => store.db.prepare("INSERT INTO quota_windows VALUES ('x', 'session', '2026-10-13T00:00:00Z', 0)").run(), /CHECK/)
  })
})

describe('Quota (gate side)', () => {
  it('maps cwd to the owner; formats reset times in Vietnam time', () => {
    assert.equal(ownerOfCwd(cwds['a-1'], root), 'alice')
    assert.equal(ownerOfCwd(path.join(root, 'admin'), root), undefined)
    assert.equal(vnTime(Date.parse('2026-10-13T17:30:00Z')), '00:30 14/10')
  })

  it('the first call opens both windows; the 5-hour limit blocks, and lifts 5 hours later', async () => {
    assert.equal(usageOf(store, 'alice', clock).session.resetsAt, null)
    assert.equal((await call('a-1', 6000)).ok, true)
    const u = usageOf(store, 'alice', clock)
    assert.equal(u.session.used, 6000)
    assert.equal(u.session.resetsAt, clock + 5 * H)
    assert.equal(u.week.resetsAt, clock + WINDOWS.week)
    assert.equal((await call('a-1', 6000)).ok, true) // 6000 < 10000: still admitted
    const blocked = await quota.reserve({ sessionId: 'a-1' })
    assert.equal(blocked.ok, false)
    assert.match(blocked.message, /giới hạn 5 giờ của gói Free/)
    assert.match(blocked.message, /17:00 13\/10/) // 05:00Z + 5 h = 10:00Z = 17:00 giờ VN
    clock += 5 * H
    assert.equal((await quota.reserve({ sessionId: 'a-1' })).ok, true)
  })

  it('the weekly limit blocks even when the 5-hour window has room', async () => {
    store.updatePlan('free', 10_000, 15_000)
    await call('a-1', 9000)
    clock += 5 * H
    await call('a-1', 9000)
    clock += 5 * H
    const r = await quota.reserve({ sessionId: 'a-1' })
    assert.equal(r.ok, false)
    assert.match(r.message, /giới hạn tuần/)
  })

  it('lets a first call through even when one estimate exceeds the limit; a parallel second is held off', async () => {
    assert.equal((await quota.reserve({ sessionId: 'a-1', outCap: 8000 })).ok, true)
    assert.equal(quota.reservedOf('alice'), 16_000)
    assert.equal((await quota.reserve({ sessionId: 'a-2', outCap: 8000 })).ok, false)
  })

  it('a call settled after its window ended counts in the next window, not for free', async () => {
    await call('a-1', 1000)
    const r = await quota.reserve({ sessionId: 'a-1' })
    clock += 5 * H - 5_000 // 4:59:55 into the window
    clock += 10_000 // stream finishes 10 s later
    quota.settle({ ticket: r.ticket, input: 4000, output: 0 })
    assert.deepEqual({ ...store.getWindow('alice', 'session') }, { started_at: clock, used: 4000 })
    assert.equal(store.getWindow('alice', 'week').used, 5000)
  })

  it('estimates from the session\'s last real input; releases holds after 15 minutes', async () => {
    await call('a-1', 3000)
    await quota.reserve({ sessionId: 'a-1', outCap: 100 })
    assert.equal(quota.reservedOf('alice'), 3100)
    store.addToWindow('alice', 'session', 7000, clock, WINDOWS.session) // 10000 used + held
    assert.equal((await quota.reserve({ sessionId: 'a-1' })).ok, false)
    clock += 15 * 60_000
    assert.equal(quota.reservedOf('alice'), 3100)
    store.updatePlan('free', 10_001, 50_000)
    assert.equal((await quota.reserve({ sessionId: 'a-1' })).ok, true) // stale hold dropped
  })

  it('admins are unlimited; an unknown session is refused', async () => {
    assert.equal((await call('b-1', 1e9)).ok, true)
    assert.equal((await call('b-1', 1)).ok, true)
    assert.equal(usageOf(store, ADMIN, clock).plan, null)
    assert.equal((await quota.reserve({ sessionId: 'nobody' })).ok, false)
  })

  it('calls without a session id are booked to SYSTEM on its own plan', async () => {
    store.updatePlan('pro', 100, 1000)
    store.setSetting('system_plan', 'pro')
    assert.equal(usageOf(store, SYSTEM, clock).plan.id, 'pro')
    assert.equal((await call(undefined, 150)).ok, true)
    assert.equal((await quota.reserve({})).ok, false)
    store.updatePlan('pro', 500000, 2500000)
  })

  it('keeps at most 10 000 session estimates', async () => {
    store.updatePlan('free', null, null)
    for (let i = 0; i < 10_005; i++) {
      cwds[`s-${i}`] = cwds['a-1']
      await call(`s-${i}`, 1)
    }
    assert.equal(quota.lastInput.size, 10_000)
    assert.equal(quota.lastInput.has('s-0'), false)
  })
})

describe('quotaStream (plugin side)', () => {
  const collect = async it => { const out = []; for await (const c of it) out.push(c); return out }
  const fakeGate = verdict => {
    const sent = []
    return { sent, request: async msg => { sent.push(msg); return verdict }, notify: msg => sent.push(msg) }
  }

  it('denied: yields one terminal QUOTA error and never calls the model', async () => {
    const gate = fakeGate({ ok: false, message: 'hết' })
    let called = false
    const out = await collect(quotaStream(gate)({ sessionId: 'a-1', maxTokens: 100000 }, () => { called = true; return [] }))
    assert.equal(called, false)
    assert.deepEqual(out, [{ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'hết' } } }])
    assert.equal(gate.sent[0].outCap, 8000)
  })

  it('allowed: passes chunks through unchanged and settles with the last usage', async () => {
    const gate = fakeGate({ ok: true, ticket: 't1' })
    const chunks = [{ type: 'text-delta', text: 'hi' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 5 } }, { type: 'finish', reason: { kind: 'stop' } }]
    async function* model() { yield* chunks }
    assert.deepEqual(await collect(quotaStream(gate)({ sessionId: 'a-1', maxTokens: 300 }, model)), chunks)
    assert.equal(gate.sent[0].outCap, 300)
    assert.deepEqual(gate.sent[1], { op: 'settle', ticket: 't1', input: 115, output: 4 })
  })

  it('settles even when the model stream throws', async () => {
    const gate = fakeGate({ ok: true, ticket: 't2' })
    async function* model() { yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 0 } }; throw new Error('boom') }
    await assert.rejects(collect(quotaStream(gate)({ sessionId: 'a-1' }, model)), /boom/)
    assert.deepEqual(gate.sent[1], { op: 'settle', ticket: 't2', input: 7, output: 0 })
  })
})
