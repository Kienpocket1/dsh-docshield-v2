/** Gate configuration from the environment (the dsh-gate plugin sets these from its cordis row). */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function loadConfig(env = process.env) {
  return {
    host: env.GATE_HOST ?? '127.0.0.1',
    port: Number(env.GATE_PORT ?? 3444),
    // Set to 1 when a local tunnel (cloudflared) forwards internet traffic to the gate.
    trustProxy: env.GATE_TRUST_PROXY === '1',
    // Accounts, cookie secret and session ownership. Keep it outside the repo in production.
    varDir: path.resolve(env.GATE_VAR_DIR ?? path.join(root, 'var')),
    // The shared DSH, with its launch token (set by the plugin).
    upstreamUrl: env.GATE_UPSTREAM_URL,
    // DocShield storage root: each user's sessions must live under <storageRoot>/users/<name>.
    storageRoot: env.DOCSHIELD_STORAGE_ROOT,
  }
}
