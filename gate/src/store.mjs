/** Accounts, login throttling and audit log in one SQLite file (node:sqlite). */
import { DatabaseSync } from 'node:sqlite'

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/
export const ROLES = new Set(['user', 'admin'])
/** Names that would read as system roles or storage areas in the sidebar and folders. */
export const RESERVED_NAMES = new Set(['admin', 'administrator', 'root', 'owner', 'system', 'public', 'public_docs', 'gate', 'docshield', 'users'])

/** @param {{ allowReserved?: boolean }} [opts] reserved names are refused for self-registration only */
export function validateUsername(username, { allowReserved = true } = {}) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw new Error('Tên đăng nhập: 3–32 ký tự gồm chữ thường, số, _ hoặc -, bắt đầu bằng chữ hoặc số.')
  }
  if (!allowReserved && RESERVED_NAMES.has(username)) throw new Error(`Tên "${username}" được hệ thống giữ lại, hãy chọn tên khác.`)
}

/** Lockout ladder after repeated failures for one username+IP: minutes per step. */
const LOCK_STEPS_MIN = [1, 5, 15, 60]
const FAILS_PER_STEP = 5
const IP_WINDOW_MS = 15 * 60_000
const IP_MAX_FAILS = 50

export class GateStore {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('user','admin')),
        password_hash TEXT NOT NULL,
        credential_version INTEGER NOT NULL DEFAULT 1,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS login_failures (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        locked_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ip_failures (ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ip_failures_ip ON ip_failures (ip, at);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        username TEXT,
        event TEXT NOT NULL,
        ip TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registrations (ip TEXT NOT NULL, at INTEGER NOT NULL);
    `)
    // v2: self-registration awaiting approval, and forced password change after an admin reset.
    const columns = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(c => c.name))
    if (!columns.has('status')) this.db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    if (!columns.has('must_change_password')) this.db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0')
  }

  close() { this.db.close() }

  /**
   * @param {{ status?: 'active' | 'pending', mustChangePassword?: boolean }} [opts]
   * @throws on a malformed or reserved name, unknown role, or duplicate
   */
  addUser(username, role, passwordHash, { status = 'active', mustChangePassword = false } = {}) {
    validateUsername(username)
    if (!ROLES.has(role)) throw new Error(`Vai trò không hợp lệ: ${role}`)
    if (this.getUser(username) !== undefined) throw new Error(`Tên đăng nhập "${username}" đã có người dùng.`)
    this.db.prepare('INSERT INTO users (username, role, password_hash, created_at, status, must_change_password) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, role, passwordHash, new Date().toISOString(), status, mustChangePassword ? 1 : 0)
  }

  approve(username) {
    const r = this.db.prepare("UPDATE users SET status = 'active' WHERE username = ? AND status = 'pending'").run(username)
    if (r.changes === 0) throw new Error(`Không có đơn đăng ký chờ duyệt của ${username}`)
  }

  /** Only pending requests can be removed; active accounts are disabled instead. */
  reject(username) {
    const r = this.db.prepare("DELETE FROM users WHERE username = ? AND status = 'pending'").run(username)
    if (r.changes === 0) throw new Error(`Không có đơn đăng ký chờ duyệt của ${username}`)
  }

  setRole(username, role) {
    if (!ROLES.has(role)) throw new Error(`Vai trò không hợp lệ: ${role}`)
    const r = this.db.prepare('UPDATE users SET role = ?, credential_version = credential_version + 1 WHERE username = ?').run(role, username)
    if (r.changes === 0) throw new Error(`Không có tài khoản ${username}`)
  }

  /** Active, enabled admins; the gate never lets this drop to zero. */
  countActiveAdmins() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND disabled = 0").get().n
  }

  countPending() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").get().n
  }

  getSetting(key, fallback) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }

  registrationOpen() {
    return this.getSetting('registration_open', '1') === '1'
  }

  /** Accepted registration requests from one IP within the window. */
  countRegistrations(ip, windowMs, now = Date.now()) {
    this.db.prepare('DELETE FROM registrations WHERE at < ?').run(now - windowMs)
    return this.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE ip = ?').get(ip).n
  }

  recordRegistration(ip, now = Date.now()) {
    this.db.prepare('INSERT INTO registrations (ip, at) VALUES (?, ?)').run(ip, now)
  }

  getUser(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  }

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  }

  listUsers() {
    return this.db.prepare(`SELECT id, username, role, status, disabled, must_change_password, created_at, last_login_at
      FROM users ORDER BY status DESC, username`).all()
  }

  /** New password invalidates every existing session of that user. */
  setPassword(username, passwordHash, { mustChangePassword = false } = {}) {
    const r = this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, credential_version = credential_version + 1 WHERE username = ?')
      .run(passwordHash, mustChangePassword ? 1 : 0, username)
    if (r.changes === 0) throw new Error(`Không có tài khoản ${username}`)
  }

  setDisabled(username, disabled) {
    const r = this.db.prepare('UPDATE users SET disabled = ?, credential_version = credential_version + 1 WHERE username = ?')
      .run(disabled ? 1 : 0, username)
    if (r.changes === 0) throw new Error(`Không có tài khoản ${username}`)
  }

  touchLogin(username) {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE username = ?').run(new Date().toISOString(), username)
  }

  /**
   * Remaining lock in ms for this username+IP, or for the whole IP; 0 when free.
   * @param {boolean} [ipWide] false when `ip` is shared by every client (Docker NAT): no IP-wide lock then
   */
  lockRemaining(username, ip, now = Date.now(), ipWide = true) {
    const row = this.db.prepare('SELECT locked_until FROM login_failures WHERE key = ?').get(`${username}|${ip}`)
    const userLock = row ? Math.max(0, row.locked_until - now) : 0
    if (!ipWide) return userLock
    const recent = this.db.prepare('SELECT COUNT(*) AS n FROM ip_failures WHERE ip = ? AND at > ?').get(ip, now - IP_WINDOW_MS).n
    const ipLock = recent >= IP_MAX_FAILS ? IP_WINDOW_MS : 0
    return Math.max(userLock, ipLock)
  }

  recordFailure(username, ip, now = Date.now()) {
    const key = `${username}|${ip}`
    const prev = this.db.prepare('SELECT count FROM login_failures WHERE key = ?').get(key)
    const count = (prev?.count ?? 0) + 1
    let lockedUntil = 0
    if (count % FAILS_PER_STEP === 0) {
      const step = Math.min(count / FAILS_PER_STEP - 1, LOCK_STEPS_MIN.length - 1)
      lockedUntil = now + LOCK_STEPS_MIN[step] * 60_000
    }
    this.db.prepare(`INSERT INTO login_failures (key, count, locked_until) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET count = excluded.count, locked_until = MAX(locked_until, excluded.locked_until)`)
      .run(key, count, lockedUntil)
    this.db.prepare('INSERT INTO ip_failures (ip, at) VALUES (?, ?)').run(ip, now)
    this.db.prepare('DELETE FROM ip_failures WHERE at < ?').run(now - IP_WINDOW_MS)
  }

  clearFailures(username, ip) {
    this.db.prepare('DELETE FROM login_failures WHERE key = ?').run(`${username}|${ip}`)
  }

  audit(event, { username = null, ip = null, detail = null } = {}) {
    this.db.prepare('INSERT INTO audit_log (at, username, event, ip, detail) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), username, event, ip, detail)
  }

  recentAudit(limit = 50) {
    return this.db.prepare('SELECT at, username, event, ip, detail FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
  }
}
