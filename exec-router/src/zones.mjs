/**
 * Which tool container may serve a call, decided ONLY from the session that
 * runs it — never from a path the model wrote (TC1). Pure functions, so the
 * rules are testable without DSH or Docker.
 *
 * Zones (storage root /data inside every container):
 *   /data/users/<u>[/…]  → user:<u>      container tool-<u>      sees /data/users/<u>
 *   /data/admin[/…]      → admin         container tool-admin    sees /data/admin, /data/public_docs
 *   /data/users (exact)  → admin-review  container tool-review   sees /data/users (read-only), no network
 */
import path from 'node:path'

export const STORAGE = '/data'
const USER = /^[a-z0-9][a-z0-9_-]{2,31}$/
export const ZONE_PATTERN = /^(user:[a-z0-9][a-z0-9_-]{2,31}|admin|admin-review)$/

export class ZoneError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZoneError'
    this.code = 'FS_SANDBOX_DENIED'
  }
}

/** Normalized absolute POSIX path, or throws (relative, NUL, non-string). */
export function clean(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) throw new ZoneError('Đường dẫn không hợp lệ.')
  if (!p.startsWith('/')) throw new ZoneError('Đường dẫn phải là tuyệt đối.')
  return path.posix.normalize(p).replace(/\/+$/, '') || '/'
}

const inside = (root, p) => p === root || p.startsWith(`${root}/`)

/** Zone of a session cwd, or undefined when the session may not run tools. */
export function zoneOfCwd(cwd) {
  let p
  try { p = clean(cwd) } catch { return undefined }
  if (p === `${STORAGE}/users`) return 'admin-review'
  if (inside(`${STORAGE}/admin`, p)) return 'admin'
  const m = new RegExp(`^${STORAGE}/users/([^/]+)(/|$)`).exec(p)
  if (m && USER.test(m[1])) return `user:${m[1]}`
  return undefined
}

/** Folders a zone's container sees (and the only places its calls may touch). */
export function rootsOf(zone) {
  if (!ZONE_PATTERN.test(zone)) throw new ZoneError('Vùng không hợp lệ.')
  if (zone === 'admin') return [`${STORAGE}/admin`, `${STORAGE}/public_docs`]
  if (zone === 'admin-review') return [`${STORAGE}/users`]
  return [`${STORAGE}/users/${zone.slice(5)}`]
}

/** Throws unless `p` (absolute, or relative to `cwd`) lies inside the zone. Returns the clean path. */
export function assertInZone(zone, p, cwd) {
  const abs = typeof p === 'string' && !p.startsWith('/') && typeof cwd === 'string' ? path.posix.join(clean(cwd), p) : p
  const c = clean(abs)
  if (!rootsOf(zone).some(r => inside(r, c))) throw new ZoneError('Đường dẫn nằm ngoài thư mục của phiên này.')
  return c
}

/**
 * Zone of the current call.
 * @param {{ currentInitiator(): any } | undefined} agents DSH agents service
 * @param {{ get(id: string): any } | undefined} sessions DSH sessions service
 * @param {string | undefined} policySessionId sessionId DSH put in the sandbox policy (not model-written)
 * @param {(msg: string) => void} [log]
 */
export function zoneOfCall(agents, sessions, policySessionId, log = () => {}) {
  const agent = agents?.currentInitiator?.()
  const session = agent?.session
  if (session !== undefined) {
    if (policySessionId !== undefined && policySessionId !== session.id) throw new ZoneError('Chính sách sandbox không khớp phiên đang chạy.')
    const zone = zoneOfCwd(session.header?.cwd)
    if (zone === undefined) throw new ZoneError('Phiên này không được chạy công cụ (thư mục ngoài vùng lưu trữ).')
    return zone
  }
  // Async context lost: only DSH's own sessionId (never a model-written path) may identify the caller.
  if (policySessionId !== undefined) {
    const zone = zoneOfCwd(sessions?.get?.(policySessionId)?.header?.cwd)
    if (zone !== undefined) {
      log(`exec-router: dùng sessionId dự phòng cho ${policySessionId} → ${zone}`)
      return zone
    }
  }
  throw new ZoneError('Lời gọi công cụ không thuộc phiên nào.')
}
