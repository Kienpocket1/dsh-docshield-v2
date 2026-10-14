/**
 * dsh-gate as a DSH plugin. Once the shared DSH has loaded, it starts the gate
 * as a child process in front of this DSH and hands it the launch URL (with
 * DSH's one-time token) through the environment; the gate trades that token
 * for DSH's auth cookie and is then the only way in for browsers. The gate
 * dies with DSH: it exits when its stdin (a pipe held by this process) closes.
 *
 * DSH core has no hook for per-user authentication, so sign-in and per-user
 * filtering live in that separate process, as with dsh-passwords; this row
 * owns its lifetime and the daily token quota: every model call (`llm/stream`)
 * asks the gate over an IPC channel first, and reports its usage after. The
 * gate decides and keeps the ledger (src/quota.mjs); nothing here touches it.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-gate'
export const inject = ['connection', 'webServer']

const GATE_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gate.mjs')

/** Plugin config → gate environment (the gate's own config reads these); a variable already set in DSH's environment wins. */
const ENV_KEYS = {
  port: 'GATE_PORT',
  host: 'GATE_HOST',
  varDir: 'GATE_VAR_DIR',
  storageRoot: 'DOCSHIELD_STORAGE_ROOT',
  trustProxy: 'GATE_TRUST_PROXY',
}

const OUT_CAP = 8000
const ASK_TIMEOUT_MS = 5000

/**
 * `llm/stream` listener: no model call without the gate's yes (fail-closed), real usage reported after.
 * @param {{ request(msg: object): Promise<{ ok: boolean, ticket?: string, message?: string }>, notify(msg: object): void }} gate
 */
export function quotaStream(gate) {
  return async function* (options, next) {
    const verdict = await gate.request({
      op: 'reserve', sessionId: options.sessionId, purpose: options.purpose, model: options.model,
      outCap: Math.min(options.maxTokens ?? OUT_CAP, OUT_CAP),
    })
    if (!verdict.ok) {
      // QUOTA is terminal (never retried); the chat shows this message as the turn's error.
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: verdict.message } } }
      return
    }
    let usage
    try {
      for await (const chunk of next()) {
        if (chunk?.type === 'usage') usage = chunk.usage
        yield chunk
      }
    } finally {
      const u = usage ?? {}
      gate.notify({
        op: 'settle', ticket: verdict.ticket,
        input: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
        output: u.outputTokens ?? 0,
      })
    }
  }
}

/**
 * @param {any} ctx DSH plugin context with `connection` and `webServer`
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  let child
  // Pending quota questions by id; each one ends: answer, timeout, or gate exit.
  const pending = new Map()
  let seq = 0
  const answer = (id, reply) => {
    const p = pending.get(id)
    if (p === undefined) return
    pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(reply)
  }
  const gate = {
    request: msg => new Promise(resolve => {
      const id = ++seq
      const deny = message => answer(id, { ok: false, message })
      pending.set(id, { resolve, timer: setTimeout(() => deny('Gate không trả lời kiểm tra hạn mức token; thử lại sau.'), ASK_TIMEOUT_MS) })
      if (!child?.connected) return deny('Gate không chạy: không kiểm tra được hạn mức token.')
      child.send({ ...msg, id }, err => { if (err) deny('Gate không chạy: không kiểm tra được hạn mức token.') })
    }),
    notify: msg => { if (child?.connected) child.send(msg, () => {}) },
  }
  ctx.on('llm/stream', quotaStream(gate))
  const start = () => {
    if (child !== undefined || ctx.webServer.port === undefined) return
    const upstream = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
    const env = { ...process.env, GATE_UPSTREAM_URL: upstream }
    for (const [key, name] of Object.entries(ENV_KEYS)) {
      const value = config[key]
      if (value !== undefined && value !== null && process.env[name] === undefined) env[name] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
    }
    child = spawn(process.execPath, [GATE_BIN, 'serve', '--plugin'], { env, stdio: ['pipe', 'inherit', 'inherit', 'ipc'], windowsHide: true })
    child.on('message', reply => answer(reply?.id, reply))
    child.once('exit', code => {
      child = undefined
      for (const id of [...pending.keys()]) answer(id, { ok: false, message: 'Gate đã dừng: không kiểm tra được hạn mức token.' })
      if (code !== 0 && code !== null) console.error(`dsh-gate: gate exited (${String(code)}); DSH keeps running but no one can sign in`)
    })
  }
  const settled = ctx.get('loader')?.await()
  if (settled === undefined) start()
  else settled.then(start, err => console.error(`dsh-gate: not started (${err?.message ?? err})`))
  ctx.effect(() => () => {
    if (child === undefined) return
    child.stdin.end()
    child.kill()
  }, 'dsh-gate: gate process')
}
