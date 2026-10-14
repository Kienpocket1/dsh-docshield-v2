/**
 * LLM token quota per account, by plan, like Claude Code: a 5-hour window and a weekly window, each
 * opened by the first call after the previous one ended. The dsh-gate plugin wraps every model call in
 * DSH (`llm/stream`) and asks this process over IPC: `reserve` before the call, `settle` with the real
 * usage after it. Only the gate writes the ledger (gate.db, table quota_windows).
 *
 *   session id → cwd (SessionIndex, the same ownership the filter uses) → <storageRoot>/users/<name>
 *   no session id     → the virtual account SYSTEM, on its own plan (a lost id cannot be a free pass)
 *   cwd outside users → ADMIN, unlimited
 *   unknown session   → refused
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isInside } from './policy.mjs'

export const SYSTEM = '(hệ thống)'
export const ADMIN = '(admin)'
export const WINDOWS = { session: 5 * 3600_000, week: 7 * 24 * 3600_000 }
export const WINDOW_LABELS = { session: 'giới hạn 5 giờ', week: 'giới hạn tuần' }
const DEFAULT_INPUT = 8000
const TICKET_TTL_MS = 15 * 60_000 // longer than DSH's 5-minute stream idle timeout
const MAX_SESSIONS = 10_000

/** Unix ms → "HH:MM dd/mm" in Vietnam time (UTC+7, no DST). */
export function vnTime(ms) {
  const iso = new Date(ms + 7 * 3600_000).toISOString()
  return `${iso.slice(11, 16)} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`
}

/** `<storageRoot>/users/<name>[/...]` → name; anything else → undefined. */
export function ownerOfCwd(cwd, storageRoot) {
  const users = path.join(storageRoot, 'users')
  if (!isInside(users, cwd)) return undefined
  return path.relative(users, path.resolve(cwd)).split(path.sep)[0] || undefined
}

/**
 * What a name has used in each window right now; read for both the decision and the display.
 * @returns {{ plan: { id: string, name: string } | null, session: Window, week: Window }}
 * @typedef {{ used: number, limit: number | null, resetsAt: number | null }} Window
 */
export function usageOf(store, name, now = Date.now()) {
  const plan = name === ADMIN ? null : store.planOf(name, 'system_plan')
  const view = kind => {
    const w = store.getWindow(name, kind)
    const open = w !== undefined && w.started_at + WINDOWS[kind] > now
    const limit = plan === null ? null : (kind === 'session' ? plan.session_limit : plan.weekly_limit)
    return { used: open ? w.used : 0, limit: limit ?? null, resetsAt: open ? w.started_at + WINDOWS[kind] : null }
  }
  return { plan: plan && { id: plan.id, name: plan.name }, session: view('session'), week: view('week') }
}

export class Quota {
  /**
   * @param {{ store: import('./store.mjs').GateStore, sessions: { ensure(ids: string[]): Promise<void>, cwdOf(id: string): string | undefined }, storageRoot: string, now?: () => number, log?: (msg: string) => void }} opts
   */
  constructor({ store, sessions, storageRoot, now = Date.now, log = () => {} }) {
    Object.assign(this, { store, sessions, storageRoot, now, log })
    /** @type {Map<string, { name: string, est: number, sessionId?: string, expires: number }>} */
    this.tickets = new Map()
    /** Real input size of each session's last call: the next prompt is about as big. */
    this.lastInput = new Map()
  }

  reservedOf(name) {
    let sum = 0
    for (const t of this.tickets.values()) if (t.name === name) sum += t.est
    return sum
  }

  /**
   * @param {{ sessionId?: string, outCap?: number, purpose?: string, model?: string }} req
   * @returns {Promise<{ ok: true, ticket: string } | { ok: false, message: string }>}
   */
  async reserve({ sessionId, outCap = 0, purpose, model }) {
    const now = this.now()
    for (const [id, t] of this.tickets) if (t.expires <= now) this.tickets.delete(id)

    let name = SYSTEM
    if (typeof sessionId === 'string' && sessionId !== '') {
      await this.sessions.ensure([sessionId])
      const cwd = this.sessions.cwdOf(sessionId)
      if (cwd === undefined) return { ok: false, message: 'Gate: không xác định được phiên của lời gọi model.' }
      name = ownerOfCwd(cwd, this.storageRoot) ?? ADMIN
    } else {
      this.log(`quota: system call purpose=${purpose ?? '-'} model=${model ?? '-'}`)
    }

    // ponytail: the estimate only holds a place, it never decides (a limit below one estimate must still
    // allow a first call). Worst overshoot: the last call admitted while some quota was left, plus output
    // beyond outCap of calls already running in parallel. Exact enforcement would mean cutting streams.
    const usage = usageOf(this.store, name, now)
    const held = this.reservedOf(name)
    for (const kind of ['session', 'week']) {
      const w = usage[kind]
      if (w.limit !== null && w.used + held >= w.limit) {
        const reset = w.resetsAt === null ? 'khi các lời gọi đang chạy kết thúc' : `lúc ${vnTime(w.resetsAt)} (giờ VN)`
        return { ok: false, message: `Đã chạm ${WINDOW_LABELS[kind]} của gói ${usage.plan.name} (${w.limit.toLocaleString('vi-VN')} token). Đặt lại ${reset}; liên hệ admin để đổi gói.` }
      }
    }
    const ticket = randomUUID()
    const est = (this.lastInput.get(sessionId) ?? DEFAULT_INPUT) + Math.max(0, Number(outCap) || 0)
    this.tickets.set(ticket, { name, est, sessionId, expires: now + TICKET_TTL_MS })
    return { ok: true, ticket }
  }

  /**
   * Book real usage into the windows open now (a call that started just before a window ended counts
   * in the next one, never for free).
   * @param {{ ticket: string, input?: number, output?: number }} msg
   */
  settle({ ticket, input = 0, output = 0 }) {
    const t = this.tickets.get(ticket)
    if (t === undefined) return
    this.tickets.delete(ticket)
    const now = this.now()
    const tokens = (Number(input) || 0) + (Number(output) || 0)
    for (const [kind, len] of Object.entries(WINDOWS)) this.store.addToWindow(t.name, kind, tokens, now, len)
    if (typeof t.sessionId === 'string' && input > 0) {
      this.lastInput.delete(t.sessionId)
      this.lastInput.set(t.sessionId, input)
      if (this.lastInput.size > MAX_SESSIONS) this.lastInput.delete(this.lastInput.keys().next().value)
    }
  }
}
