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
    // Docker mode: exact addresses (besides loopback) the tunnel's connections come from; usually
    // learned at start through /gate/calibrate instead (GATE_CALIBRATION_TOKEN, read in bin/gate.mjs).
    trustedPeers: (env.GATE_TRUSTED_PEERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    // Accounts, cookie secret and session ownership. Keep it outside the repo in production.
    varDir: path.resolve(env.GATE_VAR_DIR ?? path.join(root, 'var')),
    // The shared DSH, with its launch token (set by the plugin).
    upstreamUrl: env.GATE_UPSTREAM_URL,
    // DocShield storage root: each user's sessions must live under <storageRoot>/users/<name>.
    storageRoot: env.DOCSHIELD_STORAGE_ROOT,
    // Docker mode: the egress proxy's JSONL log (read-only mount), shown on /gate/admin.
    egressLog: env.GATE_EGRESS_LOG,
  }
}

/**
 * The one-time calibration secret as a Buffer (so it can be zeroed after use), removed from
 * `env` at once so nothing started later inherits or prints it. Undefined when not set.
 */
export function takeCalibrationToken(env = process.env) {
  const value = env.GATE_CALIBRATION_TOKEN
  delete env.GATE_CALIBRATION_TOKEN
  return value ? Buffer.from(value) : undefined
}
