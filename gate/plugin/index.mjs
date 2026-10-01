/**
 * dsh-gate as a DSH plugin. Once the shared DSH has loaded, it starts the gate
 * as a child process in front of this DSH and hands it the launch URL (with
 * DSH's one-time token) through the environment; the gate trades that token
 * for DSH's auth cookie and is then the only way in for browsers. The gate
 * dies with DSH: it exits when its stdin (a pipe held by this process) closes.
 *
 * DSH core has no hook for per-user authentication, so sign-in and per-user
 * filtering live in that separate process, as with dsh-passwords; this row
 * only owns its lifetime.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-gate'
export const inject = ['connection', 'webServer']

const GATE_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gate.mjs')

/** Plugin config → gate environment (the gate's own config reads these). */
const ENV_KEYS = {
  port: 'GATE_PORT',
  host: 'GATE_HOST',
  varDir: 'GATE_VAR_DIR',
  storageRoot: 'DOCSHIELD_STORAGE_ROOT',
  trustProxy: 'GATE_TRUST_PROXY',
}

/**
 * @param {any} ctx DSH plugin context with `connection` and `webServer`
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  let child
  const start = () => {
    if (child !== undefined || ctx.webServer.port === undefined) return
    const upstream = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
    const env = { ...process.env, GATE_UPSTREAM_URL: upstream }
    for (const [key, name] of Object.entries(ENV_KEYS)) {
      const value = config[key]
      if (value !== undefined && value !== null) env[name] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
    }
    child = spawn(process.execPath, [GATE_BIN, 'serve', '--plugin'], { env, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
    child.once('exit', code => {
      child = undefined
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
