/**
 * The gate's HTTP server. Pages under /gate/ (setup, login, register,
 * password, admin); everything else goes to the shared DSH through the
 * per-user filter (filter.mjs).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { dummyVerify, hashPassword, verifyPassword } from './password.mjs'
import { downstreamHeaders, upstreamHeaders } from './proxy.mjs'
import {
  CSRF_COOKIE, SESSION_COOKIE, SESSION_TTL_MS, cookie, formToken, issueSession, newCsrfToken, parseCookies, sameToken, verifySession,
} from './session.mjs'
import { validateUsername } from './store.mjs'
import { readEgressLog } from './egress-log.mjs'
import { ADMIN, SYSTEM, usageOf } from './quota.mjs'
import {
  renderAdmin, renderBar, renderLogin, renderNotice, renderPassword, renderRegister, renderSetup, renderUsage,
} from './views.mjs'

const MAX_FORM_BYTES = 4096
const REGISTER_WINDOW_MS = 60 * 60_000
const REGISTER_PER_IP = 5
const MAX_PENDING = 50
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'same-origin',
}

/**
 * @param {object} deps
 * @param {import('./store.mjs').GateStore} deps.store
 * @param {Buffer} deps.secret
 * @param {{ get(): Promise<{ port: number, origin: string, cookie: string }> }} deps.upstream the shared DSH
 * @param {{ handleHttp(req, res, user): Promise<void>, handleUpgrade(req, socket, head, user): Promise<void>, disconnect?(username: string): void }} deps.filter
 * @param {string} [deps.setupKey] one-time key printed on the console while no account exists;
 *   it guards /gate/setup, which creates the first admin
 * @param {boolean} [deps.trustProxy] behind a local tunnel (cloudflared): take the client IP from
 *   CF-Connecting-IP / X-Forwarded-For and mark cookies Secure over https — only for requests
 *   arriving from this machine, so remote clients cannot spoof their IP
 * @param {string[]} [deps.trustedPeers] besides loopback, the exact addresses the local tunnel's
 *   connections arrive from (Docker mode: the NAT address of the published port)
 * @param {Buffer} [deps.calibrationToken] Docker mode: one-time secret of POST /gate/calibrate, which
 *   records the caller's address as a trusted peer (the tool-manager calls it over the same path
 *   cloudflared uses); zeroed and gone after the first success
 * @param {string} [deps.egressLog] egress proxy JSONL log (docker mode), shown to admins
 * @param {boolean} [deps.sharedDirectAddr] Docker mode: direct connections all arrive from the NAT
 *   address, so only tunnel-forwarded addresses count toward the IP-wide lockout
 * @param {(msg: string) => void} [deps.log]
 */
export function createGate({ store, secret, upstream, filter, setupKey, trustProxy = false, trustedPeers = [], calibrationToken, egressLog, sharedDirectAddr = false, log = () => {} }) {
  const setupOpen = () => setupKey !== undefined && store.countUsers() === 0
  const sessionValue = req => parseCookies(req.headers.cookie)[SESSION_COOKIE]
  const currentUser = req => verifySession(secret, sessionValue(req), name => store.getUser(name))
  const peers = trustedPeers.map(normalizeAddr).filter(Boolean)
  let calibration = trustProxy && calibrationToken?.length ? calibrationToken : undefined
  const fromTrustedProxy = req => trustProxy && isTrustedPeer(req.socket.remoteAddress, peers)
  /** Client address from a trusted tunnel's header, or undefined. */
  const forwardedIp = req => {
    if (!fromTrustedProxy(req)) return undefined
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && cf.trim() !== '') return cf.trim()
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.trim() !== '') return xff.split(',')[0].trim()
    return undefined
  }
  const ipOf = req => forwardedIp(req) ?? req.socket.remoteAddress ?? 'unknown'
  /**
   * Whether the address tells clients apart. Docker mode: every direct connection arrives from
   * the same NAT address, so an IP-wide lockout there would lock everyone out at once.
   */
  const ipDistinct = req => !sharedDirectAddr || forwardedIp(req) !== undefined
  /**
   * A browser request from another site (Origin ≠ the host it was sent to). The proxy rewrites
   * Origin for DSH's own fence, so the gate must check it first. No Origin: not a browser
   * cross-site request (CLI, same-origin GET), allowed.
   */
  const crossSite = req => {
    const origin = req.headers.origin
    if (origin === undefined) return false
    let host
    try { host = new URL(origin).host.toLowerCase() } catch { return true }
    if (host === String(req.headers.host ?? '').toLowerCase()) return false
    return !(fromTrustedProxy(req) && host === String(req.headers['x-forwarded-host'] ?? '').toLowerCase())
  }
  const viaHttps = req => fromTrustedProxy(req) && req.headers['x-forwarded-proto'] === 'https'
  const tokenFor = req => formToken(secret, sessionValue(req))
  const signIn = user => cookie(SESSION_COOKIE, issueSession(secret, user), { maxAgeSec: SESSION_TTL_MS / 1000 })
  const clearCsrf = cookie(CSRF_COOKIE, '', { maxAgeSec: 0 })

  const server = http.createServer((req, res) => {
    if (viaHttps(req)) secureCookies(res)
    handle(req, res).catch(err => {
      log(`error ${req.method} ${req.url}: ${err.stack ?? err}`)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Gate: lỗi nội bộ.')
    })
  })

  const ROUTES = {
    '/gate/setup': { open: true, GET: setupPage, POST: setupSubmit },
    '/gate/login': { open: true, GET: (req, res, url) => loginPage(req, res, safeNext(url.searchParams.get('next'))), POST: loginSubmit },
    '/gate/register': { open: true, GET: registerPage, POST: registerSubmit },
    '/gate/logout': { open: true, POST: logout },
    '/gate/password': { GET: passwordPage, POST: passwordSubmit },
    '/gate/admin': { admin: true, GET: adminPage, POST: adminSubmit },
    '/gate/usage': { GET: usagePage },
  }

  /** The signed-in account's own token usage (embedded in the bar's popup with ?embed=1). */
  function usagePage(_req, res, url, user) {
    // Admin sessions live outside users/, so their calls are booked to ADMIN.
    const html = renderUsage(usageOf(store, user.role === 'admin' ? ADMIN : user.username), { embed: url.searchParams.has('embed') })
    res.writeHead(200, { ...PAGE_HEADERS, 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': PAGE_HEADERS['content-security-policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'") })
    res.end(html)
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://gate.local')
    if (url.pathname === '/gate/calibrate') return calibrate(req, res)
    if (req.method !== 'GET' && req.method !== 'HEAD' && crossSite(req)) {
      log(`deny cross-site ${req.method} ${url.pathname} (Origin ${req.headers.origin})`)
      return json(res, 403, { error: 'cross-site request' })
    }
    const route = ROUTES[url.pathname]
    if (route !== undefined) {
      if (url.pathname === '/gate/setup' && !setupOpen()) return redirect(res, '/gate/login')
      if (url.pathname !== '/gate/setup' && setupOpen() && req.method === 'GET') return redirect(res, '/gate/setup')
      const handler = route[req.method]
      if (handler === undefined) return methodNotAllowed(res)
      if (route.open) return handler(req, res, url)
      const user = currentUser(req)
      if (user === undefined) return redirect(res, `/gate/login?next=${encodeURIComponent(url.pathname)}`)
      if (route.admin && user.role !== 'admin') return page(res, 403, renderNotice('Không có quyền', 'Trang này chỉ dành cho admin.', { href: '/', label: 'Về DocShield' }))
      if (user.must_change_password && url.pathname !== '/gate/password') return redirect(res, '/gate/password')
      return handler(req, res, url, user)
    }

    const user = currentUser(req)
    if (user === undefined) {
      if (url.pathname.startsWith('/api/') || req.method !== 'GET') return json(res, 401, { error: 'unauthenticated' })
      if (setupOpen()) return redirect(res, '/gate/setup')
      return redirect(res, `/gate/login?next=${encodeURIComponent(url.pathname + url.search)}`)
    }
    if (user.must_change_password) {
      if (url.pathname.startsWith('/api/') || req.method !== 'GET') return json(res, 403, { error: 'password change required' })
      return redirect(res, '/gate/password')
    }
    if (req.method === 'GET' && url.pathname === '/') return proxyIndexWithBar(req, res, await upstream.get(), user)
    return filter.handleHttp(req, res, user)
  }

  server.on('upgrade', (req, socket, head) => {
    if (crossSite(req)) {
      log(`deny cross-site upgrade ${req.url} (Origin ${req.headers.origin})`)
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const user = currentUser(req)
    if (user === undefined || user.must_change_password) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    filter.handleUpgrade(req, socket, head, user).catch(err => { log(`upgrade ${user.username}: ${err.message}`); socket.destroy() })
  })

  /**
   * One-time: the tool-manager proves it knows the token, over the very path the tunnel will use;
   * the address this connection arrives from becomes a trusted peer. Then the route is gone (404).
   */
  function calibrate(req, res) {
    if (calibration === undefined || req.method !== 'POST') return json(res, 404, { error: 'not found' })
    const given = Buffer.from(String(req.headers['x-gate-calibration'] ?? ''))
    if (given.length !== calibration.length || !timingSafeEqual(given, calibration)) return json(res, 403, { error: 'forbidden' })
    const addr = normalizeAddr(req.socket.remoteAddress)
    calibration.fill(0)
    calibration = undefined
    if (addr && !peers.includes(addr)) peers.push(addr)
    log(`gate: tin địa chỉ proxy ${addr} (CF-Connecting-IP / X-Forwarded-For từ địa chỉ này)`)
    res.writeHead(204)
    res.end()
  }

  // ---------- anonymous pages (double-submit CSRF cookie) ----------

  function withCsrf(res, status, render) {
    const csrf = newCsrfToken()
    res.writeHead(status, { ...PAGE_HEADERS, 'set-cookie': cookie(CSRF_COOKIE, csrf, { maxAgeSec: 3600 }) })
    res.end(render(csrf))
  }
  const csrfOk = (req, form) => sameToken(parseCookies(req.headers.cookie)[CSRF_COOKIE], form.get('csrf'))

  function loginPage(req, res, next, { error = '', username = '', status = 200, notice = '' } = {}) {
    withCsrf(res, status, csrf => renderLogin({ csrf, next, error, username, notice, registrationOpen: store.registrationOpen() }))
  }

  async function loginSubmit(req, res) {
    const form = await readForm(req)
    const next = safeNext(form.get('next'))
    const username = String(form.get('username') ?? '').trim().toLowerCase()
    const password = String(form.get('password') ?? '')
    const ip = ipOf(req)
    if (!csrfOk(req, form)) return loginPage(req, res, next, { error: 'Phiên đăng nhập đã hết hạn, hãy thử lại.', username, status: 400 })
    const locked = store.lockRemaining(username, ip, undefined, ipDistinct(req))
    if (locked > 0) {
      store.audit('login_locked', { username, ip })
      return loginPage(req, res, next, { error: `Đăng nhập sai quá nhiều lần. Thử lại sau ${Math.ceil(locked / 60_000)} phút.`, username, status: 429 })
    }
    const user = store.getUser(username)
    const ok = user !== undefined && !user.disabled
      ? await verifyPassword(password, user.password_hash)
      : await dummyVerify(password)
    if (!ok) {
      store.recordFailure(username, ip)
      store.audit('login_failed', { username, ip })
      return loginPage(req, res, next, { error: 'Sai tên đăng nhập hoặc mật khẩu.', username, status: 401 })
    }
    store.clearFailures(username, ip)
    if (user.status === 'pending') {
      store.audit('login_pending', { username, ip })
      return loginPage(req, res, next, { error: 'Tài khoản đang chờ admin duyệt.', username, status: 403 })
    }
    store.touchLogin(username)
    store.audit('login', { username, ip })
    res.writeHead(303, { 'set-cookie': [signIn(user), clearCsrf], location: user.must_change_password ? '/gate/password' : next })
    res.end()
  }

  function logout(req, res) {
    const user = currentUser(req)
    if (user) store.audit('logout', { username: user.username, ip: ipOf(req) })
    res.writeHead(303, { 'set-cookie': cookie(SESSION_COOKIE, '', { maxAgeSec: 0 }), location: '/gate/login' })
    res.end()
  }

  function setupPage(req, res, _url, { error = '', username = '', status = 200 } = {}) {
    withCsrf(res, status, csrf => renderSetup({ csrf, error, username }))
  }

  /** Create the first admin, then sign them in. Only while no account exists, and only with the console key. */
  async function setupSubmit(req, res) {
    const form = await readForm(req)
    const ip = ipOf(req)
    const username = String(form.get('username') ?? '').trim().toLowerCase()
    const password = String(form.get('password') ?? '')
    const again = { username }
    if (!csrfOk(req, form)) return setupPage(req, res, null, { ...again, error: 'Phiên thiết lập đã hết hạn, hãy thử lại.', status: 400 })
    const locked = store.lockRemaining('#setup', ip, undefined, ipDistinct(req))
    if (locked > 0) return setupPage(req, res, null, { ...again, error: `Nhập sai mã quá nhiều lần. Thử lại sau ${Math.ceil(locked / 60_000)} phút.`, status: 429 })
    if (!sameSecret(String(form.get('setup_key') ?? '').trim(), setupKey)) {
      store.recordFailure('#setup', ip)
      store.audit('setup_failed', { ip })
      return setupPage(req, res, null, { ...again, error: 'Mã thiết lập không đúng. Xem mã trong cửa sổ đang chạy gate.', status: 401 })
    }
    if (password !== String(form.get('password2') ?? '')) return setupPage(req, res, null, { ...again, error: 'Hai lần nhập mật khẩu không khớp.', status: 400 })
    try {
      if (store.countUsers() > 0) throw new Error('Đã có tài khoản; trang thiết lập đã khóa.')
      store.addUser(username, 'admin', await hashPassword(password))
    } catch (err) {
      return setupPage(req, res, null, { ...again, error: err.message, status: 400 })
    }
    store.clearFailures('#setup', ip)
    store.audit('setup_admin_created', { username, ip })
    log(`setup: đã tạo admin ${username}; trang /gate/setup đã khóa`)
    res.writeHead(303, { 'set-cookie': [signIn(store.getUser(username)), clearCsrf], location: '/' })
    res.end()
  }

  function registerPage(req, res, _url, { error = '', username = '', status = 200 } = {}) {
    if (!store.registrationOpen()) return page(res, 403, renderNotice('Đăng ký đang tắt', 'Admin đã tắt chức năng tự đăng ký. Hãy liên hệ admin để được cấp tài khoản.'))
    withCsrf(res, status, csrf => renderRegister({ csrf, error, username }))
  }

  /** Self-registration: the account is created as "pending" and cannot sign in until an admin approves it. */
  async function registerSubmit(req, res) {
    if (!store.registrationOpen()) return registerPage(req, res)
    const form = await readForm(req)
    const ip = ipOf(req)
    const username = String(form.get('username') ?? '').trim().toLowerCase()
    const password = String(form.get('password') ?? '')
    const fail = (error, status = 400) => registerPage(req, res, null, { error, username, status })
    if (!csrfOk(req, form)) return fail('Phiên đăng ký đã hết hạn, hãy thử lại.')
    if (store.countRegistrations(ip, REGISTER_WINDOW_MS) >= REGISTER_PER_IP) return fail('Bạn đã gửi quá nhiều đơn đăng ký. Hãy thử lại sau.', 429)
    if (store.countPending() >= MAX_PENDING) return fail('Đang có quá nhiều đơn chờ duyệt. Hãy thử lại sau hoặc liên hệ admin.', 429)
    if (password !== String(form.get('password2') ?? '')) return fail('Hai lần nhập mật khẩu không khớp.')
    try {
      validateUsername(username, { allowReserved: false })
      store.addUser(username, 'user', await hashPassword(password), { status: 'pending' })
    } catch (err) {
      return fail(err.message)
    }
    store.recordRegistration(ip)
    store.audit('registered', { username, ip })
    log(`đơn đăng ký mới: ${username}`)
    page(res, 200, renderNotice('Đã gửi đăng ký', `Tài khoản "${username}" đang chờ admin duyệt. Sau khi được duyệt, bạn đăng nhập bằng mật khẩu vừa đặt.`))
  }

  // ---------- signed-in pages (CSRF token bound to the session cookie) ----------

  function passwordPage(req, res, _url, user, { error = '', status = 200 } = {}) {
    page(res, status, renderPassword({ token: tokenFor(req), error, forced: Boolean(user.must_change_password), username: user.username }))
  }

  async function passwordSubmit(req, res, _url, user) {
    const form = await readForm(req)
    const fail = (error, status = 400) => passwordPage(req, res, null, user, { error, status })
    if (!sameToken(form.get('token'), tokenFor(req))) return fail('Phiên đã hết hạn, hãy tải lại trang.')
    const password = String(form.get('password') ?? '')
    if (!await verifyPassword(String(form.get('current') ?? ''), user.password_hash)) return fail('Mật khẩu hiện tại không đúng.', 401)
    if (password !== String(form.get('password2') ?? '')) return fail('Hai lần nhập mật khẩu không khớp.')
    if (await verifyPassword(password, user.password_hash)) return fail('Mật khẩu mới phải khác mật khẩu hiện tại.')
    try {
      store.setPassword(user.username, await hashPassword(password))
    } catch (err) {
      return fail(err.message)
    }
    store.audit('password_changed', { username: user.username, ip: ipOf(req) })
    // The change bumped credential_version; hand this browser a fresh cookie, others are signed out.
    res.writeHead(303, { 'set-cookie': signIn(store.getUser(user.username)), location: '/' })
    res.end()
  }

  function adminPage(req, res, url, user, extra = {}) {
    page(res, extra.status ?? 200, renderAdmin({
      token: tokenFor(req),
      me: user,
      users: store.listUsers(),
      audit: store.recentAudit(30),
      registrationOpen: store.registrationOpen(),
      egress: readEgressLog(egressLog),
      quota: {
        plans: store.listPlans(),
        defaultPlan: store.getSetting('default_plan', 'free'),
        systemPlan: store.getSetting('system_plan', ''),
        usage: name => usageOf(store, name),
      },
      ok: url?.searchParams.get('ok') ?? undefined,
      ...extra,
    }))
  }

  async function adminSubmit(req, res, _url, me) {
    const form = await readForm(req)
    const fail = error => adminPage(req, res, null, me, { error, status: 400 })
    if (!sameToken(form.get('token'), tokenFor(req))) return fail('Phiên đã hết hạn, hãy tải lại trang.')
    const action = String(form.get('action') ?? '')
    const username = String(form.get('username') ?? '')
    const ip = ipOf(req)
    const done = ok => { res.writeHead(303, { location: `/gate/admin?ok=${ok}` }); res.end() }

    if (action === 'open_registration' || action === 'close_registration') {
      const open = action === 'open_registration'
      store.setSetting('registration_open', open ? '1' : '0')
      store.audit('registration_toggled', { username: me.username, ip, detail: open ? 'mở' : 'tắt' })
      return done(open ? 'reg_open' : 'reg_closed')
    }

    const plan = String(form.get('plan') ?? '')
    const known = id => store.getPlan(id) !== undefined
    if (action === 'update_plan') {
      const session = parseLimit(form.get('session_limit'))
      const weekly = parseLimit(form.get('weekly_limit'))
      if (!known(plan)) return fail('Gói không hợp lệ.')
      if (session === undefined || weekly === undefined) return fail('Giới hạn token phải là số nguyên ≥ 0, hoặc để trống (không giới hạn).')
      store.updatePlan(plan, session, weekly)
      store.audit('plan_changed', { username: me.username, ip, detail: `${plan}: 5 giờ ${session ?? '∞'}, tuần ${weekly ?? '∞'}` })
      return done('plan_saved')
    }
    if (action === 'set_default_plan' || action === 'set_system_plan') {
      const isDefault = action === 'set_default_plan'
      if (!known(plan) && !(plan === '' && !isDefault)) return fail('Gói không hợp lệ.')
      store.setSetting(isDefault ? 'default_plan' : 'system_plan', plan)
      store.audit('plan_assigned', { username: me.username, ip, detail: `${isDefault ? 'gói mặc định' : SYSTEM}: ${plan || 'theo mặc định'}` })
      return done('plan_saved')
    }

    const target = store.getUser(username)
    if (target === undefined) return fail(`Không có tài khoản ${username}.`)
    const isSelf = target.username === me.username
    const lastAdmin = target.role === 'admin' && target.status === 'active' && !target.disabled && store.countActiveAdmins() <= 1
    // The new credential_version already rejects their cookie; also cut open WebSockets.
    const stopInstance = async () => filter.disconnect?.(target.username)
    const note = detail => store.audit(action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action, { username: target.username, ip, detail: `bởi ${me.username}${detail ? `: ${detail}` : ''}` })
    try {
      switch (action) {
        case 'approve':
          store.approve(target.username); note(); return done('approved')
        case 'reject':
          store.reject(target.username); note(); return done('rejected')
        case 'disable':
          if (isSelf) return fail('Bạn không thể tự khóa tài khoản của mình.')
          if (lastAdmin) return fail('Không thể khóa admin cuối cùng.')
          store.setDisabled(target.username, true); store.audit('user_disabled', { username: target.username, ip, detail: `bởi ${me.username}` })
          await stopInstance(); return done('disabled')
        case 'enable':
          store.setDisabled(target.username, false); store.audit('user_enabled', { username: target.username, ip, detail: `bởi ${me.username}` })
          return done('enabled')
        case 'make_admin':
        case 'make_user': {
          const role = action === 'make_admin' ? 'admin' : 'user'
          if (target.status !== 'active') return fail('Hãy duyệt tài khoản trước khi đổi vai trò.')
          if (isSelf) return fail('Bạn không thể tự đổi vai trò của mình.')
          if (role === 'user' && lastAdmin) return fail('Không thể bỏ quyền của admin cuối cùng.')
          store.setRole(target.username, role)
          store.audit('role_changed', { username: target.username, ip, detail: `${role} bởi ${me.username}` })
          await stopInstance(); return done(action)
        }
        case 'set_plan':
          if (plan !== '' && !known(plan)) return fail('Gói không hợp lệ.')
          store.setPlan(target.username, plan || null)
          store.audit('plan_assigned', { username: target.username, ip, detail: `${plan || 'theo mặc định'} bởi ${me.username}` })
          return done('plan_saved')
        case 'reset_password': {
          if (isSelf) return fail('Hãy dùng trang Đổi mật khẩu cho tài khoản của bạn.')
          const temp = tempPassword()
          store.setPassword(target.username, await hashPassword(temp), { mustChangePassword: true })
          store.audit('password_reset', { username: target.username, ip, detail: `bởi ${me.username}` })
          await stopInstance()
          // Shown once on this response only (never in a URL or the log).
          return adminPage(req, res, null, me, { tempPassword: { username: target.username, password: temp } })
        }
        default:
          return fail('Thao tác không hợp lệ.')
      }
    } catch (err) {
      return fail(err.message)
    }
  }

  /** The DSH index, with a small fixed bar showing the user and account links. */
  function proxyIndexWithBar(req, res, instance, user) {
    const headers = { ...upstreamHeaders(req.headers, instance), 'accept-encoding': 'identity' }
    const up = http.request({ host: '127.0.0.1', port: instance.port, method: 'GET', path: req.url, headers }, upRes => {
      const out = downstreamHeaders(upRes.headers, instance)
      const isHtml = String(upRes.headers['content-type'] ?? '').includes('text/html')
      if (!isHtml || upRes.headers['content-encoding']) {
        res.writeHead(upRes.statusCode ?? 502, out)
        return upRes.pipe(res)
      }
      const chunks = []
      upRes.on('data', c => chunks.push(c))
      upRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8')
        const bar = renderBar(user)
        html = html.includes('</body>') ? html.replace('</body>', `${bar}</body>`) : html + bar
        delete out['content-length']
        res.writeHead(upRes.statusCode ?? 200, out)
        res.end(html)
      })
    })
    up.on('error', err => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`Gate: không kết nối được phiên làm việc (${err.message})`)
    })
    up.end()
  }

  return server
}

/** Over https (via the tunnel) every cookie the gate sets gets the Secure flag. */
function secureCookies(res) {
  const writeHead = res.writeHead.bind(res)
  res.writeHead = (status, headers) => {
    const c = headers?.['set-cookie']
    if (c !== undefined) headers['set-cookie'] = [].concat(c).map(v => (/;\s*Secure/i.test(v) ? v : `${v}; Secure`))
    return writeHead(status, headers)
  }
}

const isLoopback = addr => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
/** IPv4-mapped IPv6 ("::ffff:1.2.3.4") → "1.2.3.4"; anything else unchanged. */
const normalizeAddr = addr => (typeof addr === 'string' ? addr.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').trim() : '')
/** A connection whose forwarded headers may be believed: loopback, or exactly one of `peers`. */
export const isTrustedPeer = (addr, peers = []) => isLoopback(addr) || (normalizeAddr(addr) !== '' && peers.includes(normalizeAddr(addr)))

function page(res, status, html) {
  res.writeHead(status, PAGE_HEADERS)
  res.end(html)
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function redirect(res, location) {
  res.writeHead(302, { location })
  res.end()
}

function methodNotAllowed(res) {
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Method not allowed')
}

/**
 * Only same-site relative paths; anything else falls back to "/". Control characters and
 * backslashes are refused outright: browsers drop TAB/CR/LF and read "\" as "/", so
 * "/\t/evil.com" would land on //evil.com.
 */
export function safeNext(value) {
  const v = typeof value === 'string' ? value : ''
  if (/[\x00-\x1f\x7f\\]/.test(v)) return '/'
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/gate/') ? v : '/'
}

/** Token limit field: blank → null (default/unlimited), whole number ≥ 0 → number, anything else → undefined. */
export function parseLimit(value) {
  const s = String(value ?? '').trim()
  if (s === '') return null
  return /^\d{1,15}$/.test(s) ? Number(s) : undefined
}

/** Readable one-time password: 12 characters without look-alikes (0/O, 1/l/I). */
export function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY23456789'
  const bytes = randomBytes(12)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`
}

function sameSecret(given, expected) {
  if (typeof expected !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_FORM_BYTES) { reject(new Error('form too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })
}
