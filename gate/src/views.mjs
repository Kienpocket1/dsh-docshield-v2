/** Server-rendered gate pages (no scripts; CSP forbids them). */
import { MIN_PASSWORD_LENGTH } from './password.mjs'
import { summarize, zoneLabel } from './egress-log.mjs'
import { ADMIN, SYSTEM, vnTime } from './quota.mjs'

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const STYLE = `
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--ink:#1f2937;--muted:#6b7280;--line:#d1d5db;--accent:#0f766e;--on-accent:#fff;--err:#b91c1c;--ok:#047857;--warn:#b45309;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#121a30;--ink:#e6eaf2;--muted:#9aa4b8;--line:#26345a;--accent:#22d3ee;--on-accent:#0b1020;--err:#f87171;--ok:#34d399;--warn:#fbbf24;--chip:#1a2442}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
.center{min-height:100vh;display:grid;place-items:center;padding:16px}
.card{width:min(380px,100%);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;display:grid;gap:14px}
h1{margin:0;font-size:22px}h2{margin:24px 0 8px;font-size:18px}p{margin:0;color:var(--muted);font-size:14px}
label{display:grid;gap:6px;font-size:14px}
input{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;width:100%}
button{font:inherit;font-weight:600;padding:10px 14px;border:0;border-radius:8px;background:var(--accent);color:var(--on-accent);cursor:pointer}
button.ghost{background:var(--chip);color:var(--ink);font-weight:500;padding:6px 10px;font-size:13px}
button.danger{background:transparent;color:var(--err);border:1px solid var(--err);font-weight:500;padding:6px 10px;font-size:13px}
a{color:var(--accent)}.err{color:var(--err);font-size:14px}.ok{color:var(--ok);font-size:14px}
.links{display:flex;gap:12px;justify-content:center;font-size:14px}
.wide{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.table{width:100%;border-collapse:collapse;font-size:14px;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.table th,.table td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
.table th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.scroll{overflow-x:auto}.actions{display:flex;flex-wrap:wrap;gap:6px}.actions form{margin:0}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:var(--chip)}
.pill.pending{color:var(--warn)}.pill.off{color:var(--err)}.pill.on{color:var(--ok)}
.banner{padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);margin:12px 0}
.secret{font:600 20px/1.4 ui-monospace,monospace;letter-spacing:.05em}
`

export function renderPage(title, body, head = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — DocShield</title><style>${STYLE}</style>${head}</head><body>${body}</body></html>`
}

const errorBox = error => error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
const card = (action, inner) => `<main class="center"><form class="card" method="post" action="${action}">${inner}</form></main>`

export function renderLogin({ csrf, next, error, username, notice, registrationOpen }) {
  return renderPage('Đăng nhập', card('/gate/login', `
<h1>DocShield</h1><p>Đăng nhập để vào không gian làm việc của bạn.</p>${errorBox(error)}${notice ? `<div class="ok">${escapeHtml(notice)}</div>` : ''}
<label>Tên đăng nhập<input name="username" autocomplete="username" required value="${escapeHtml(username)}" autofocus></label>
<label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required></label>
${hidden('csrf', csrf)}${hidden('next', next)}
<button type="submit">Đăng nhập</button>
${registrationOpen ? '<div class="links"><a href="/gate/register">Chưa có tài khoản? Đăng ký</a></div>' : ''}`))
}

const newPasswordFields = `
<label>Mật khẩu<input name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"></label>
<label>Nhập lại mật khẩu<input name="password2" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"></label>
<p>Ít nhất ${MIN_PASSWORD_LENGTH} ký tự.</p>`

const usernameField = (username, autofocus) => `
<label>Tên đăng nhập<input name="username" autocomplete="username" required value="${escapeHtml(username)}"${autofocus ? ' autofocus' : ''}></label>
<p>3–32 ký tự: chữ thường, số, dấu _ hoặc -. Đây cũng là tên thư mục tài liệu của bạn.</p>`

export function renderSetup({ csrf, error, username }) {
  return renderPage('Thiết lập lần đầu', card('/gate/setup', `
<h1>Thiết lập lần đầu</h1>
<p>Chưa có tài khoản nào. Tạo tài khoản <b>admin</b> đầu tiên. Mã thiết lập đang hiện trong cửa sổ chạy gate.</p>${errorBox(error)}
<label>Mã thiết lập<input name="setup_key" autocomplete="off" required autofocus></label>
${usernameField(username, false)}${newPasswordFields}${hidden('csrf', csrf)}
<button type="submit">Tạo admin và đăng nhập</button>`))
}

export function renderRegister({ csrf, error, username }) {
  return renderPage('Đăng ký', card('/gate/register', `
<h1>Đăng ký tài khoản</h1><p>Sau khi gửi, tài khoản cần được admin duyệt mới đăng nhập được.</p>${errorBox(error)}
${usernameField(username, true)}${newPasswordFields}${hidden('csrf', csrf)}
<button type="submit">Gửi đăng ký</button>
<div class="links"><a href="/gate/login">Đã có tài khoản? Đăng nhập</a></div>`))
}

export function renderNotice(title, message, link = { href: '/gate/login', label: 'Về trang đăng nhập' }) {
  return renderPage(title, `<main class="center"><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<div class="links"><a href="${link.href}">${escapeHtml(link.label)}</a></div></div></main>`)
}

export function renderPassword({ token, error, forced, username }) {
  return renderPage('Đổi mật khẩu', card('/gate/password', `
<h1>Đổi mật khẩu</h1>
<p>${forced ? 'Mật khẩu của bạn vừa được admin đặt lại. Hãy đặt mật khẩu mới trước khi tiếp tục.' : `Tài khoản: ${escapeHtml(username)}`}</p>${errorBox(error)}
<label>Mật khẩu hiện tại${forced ? ' (mật khẩu tạm)' : ''}<input name="current" type="password" autocomplete="current-password" required autofocus></label>
${newPasswordFields}${hidden('token', token)}
<button type="submit">Lưu mật khẩu mới</button>
${forced ? '' : '<div class="links"><a href="/">Quay lại</a></div>'}`))
}

const MESSAGES = {
  approved: 'Đã duyệt tài khoản.', rejected: 'Đã từ chối đơn đăng ký.', disabled: 'Đã khóa tài khoản; phiên làm việc của người này đã bị tắt.',
  enabled: 'Đã mở khóa tài khoản.', made_admin: 'Đã cấp quyền admin.', made_user: 'Đã chuyển về người dùng thường.',
  reg_open: 'Đã mở đăng ký tài khoản.', reg_closed: 'Đã tắt đăng ký tài khoản.', plan_saved: 'Đã lưu gói token.',
}

const EVENT_LABELS = {
  login: 'Đăng nhập', logout: 'Đăng xuất', login_failed: 'Sai mật khẩu', login_locked: 'Bị khóa tạm', login_pending: 'Đăng nhập khi chờ duyệt',
  registered: 'Gửi đăng ký', approved: 'Được duyệt', rejected: 'Bị từ chối', user_disabled: 'Bị khóa', user_enabled: 'Được mở khóa',
  role_changed: 'Đổi vai trò', password_reset: 'Admin đặt lại mật khẩu', password_changed: 'Đổi mật khẩu', setup_admin_created: 'Tạo admin đầu tiên',
  setup_failed: 'Sai mã thiết lập', user_added: 'Tạo bằng dòng lệnh', registration_toggled: 'Bật/tắt đăng ký',
  plan_changed: 'Sửa gói token', plan_assigned: 'Gán gói token',
}

const DENY_LABELS = {
  auth: 'Sai thông tin proxy', port: 'Cổng không cho phép', 'private-ip': 'Địa chỉ nội bộ', ipv6: 'IPv6 không hỗ trợ', dns: 'Không phân giải được tên',
  'bad-host': 'Tên máy không hợp lệ', 'bad-request': 'Yêu cầu không hợp lệ', 'rate-limit': 'Quá số kết nối/phút', 'too-many-connections': 'Quá số kết nối đồng thời',
  'upload-limit': 'Vượt hạn mức gửi đi', 'download-limit': 'Vượt hạn mức tải về', idle: 'Hết thời gian chờ', upstream: 'Lỗi máy đích', error: 'Lỗi',
}
const bytes = n => { n = Number(n) || 0; return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB` }

const num = n => Number(n).toLocaleString('vi-VN')
const percent = w => w.limit === null ? 0 : w.limit === 0 ? 100 : Math.round(w.used * 100 / w.limit)
const windowText = w => w.limit === null ? `${num(w.used)} / không giới hạn` : `${percent(w)}% · ${num(w.used)} / ${num(w.limit)}`
const resetText = w => w.resetsAt === null ? 'Chưa dùng trong cửa sổ này' : `Đặt lại lúc ${vnTime(w.resetsAt)}`

/**
 * One account's token usage, like Claude Code's usage panel: plan, 5-hour and weekly bars with
 * percent, tokens and reset time. `embed` is the bar popup's iframe (compact, refreshes every 30 s).
 * @param {{ plan: { name: string } | null, session: object, week: object }} usage from quota.usageOf
 */
export function renderUsage(usage, { embed = false } = {}) {
  const bar = (label, w) => {
    const p = percent(w)
    const color = p >= 100 ? 'var(--err)' : p >= 80 ? 'var(--warn)' : 'var(--accent)'
    return `<section class="usage-row"><div class="usage-head"><b>${label}</b><span>${w.limit === null ? 'Không giới hạn' : `${p}%`}</span></div>
<div class="usage-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(p, 100)}"><div style="width:${Math.min(p, 100)}%;background:${color}"></div></div>
<div class="usage-sub"><span>${num(w.used)}${w.limit === null ? '' : ` / ${num(w.limit)}`} token</span><span>${resetText(w)}</span></div></section>`
  }
  const style = `<style>.usage{display:grid;gap:14px;padding:${embed ? '12px' : '0'}}.usage-row{display:grid;gap:6px}
.usage-head,.usage-sub{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.usage-sub{font-size:13px;color:var(--muted)}
.usage-track{height:6px;border-radius:999px;background:var(--chip);overflow:hidden}.usage-track div{height:100%}
${embed ? 'body{min-height:0;font-size:14px}' : ''}</style>`
  const body = `<div class="usage"><div class="usage-head"><span>Gói: <b>${usage.plan === null ? 'Không giới hạn' : escapeHtml(usage.plan.name)}</b></span>${embed ? '<a href="/gate/usage" target="_blank" rel="noopener">Chi tiết</a>' : ''}</div>
${bar('Giới hạn 5 giờ', usage.session)}${bar('Tuần', usage.week)}</div>`
  return embed
    ? renderPage('Mức dùng', body, `${style}<meta http-equiv="refresh" content="30">`)
    : renderPage('Mức dùng', `<main class="wide"><div class="top"><h1>Mức dùng token</h1><div class="actions"><a href="/">← Về DocShield</a></div></div>${body}
<p class="usage-sub">Cửa sổ mở từ lời gọi model đầu tiên và kéo dài 5 giờ / 7 ngày. Khi chạm một trong hai giới hạn, lượt chat bị chặn tới giờ đặt lại.</p></main>`, style)
}

/** Internet access through the egress proxy (docker mode only; undefined → section hidden). */
function renderEgress(entries) {
  if (entries === undefined) return ''
  const date = s => escapeHtml(String(s).slice(0, 19).replace('T', ' '))
  const totals = summarize(entries, Date.now() - 24 * 3600_000)
  const totalRows = totals.map(t => `<tr><td>${escapeHtml(zoneLabel(t.zone))}</td><td>${t.requests}</td><td>${t.denied}</td><td>${bytes(t.up)}</td><td>${bytes(t.down)}</td></tr>`).join('')
  const rows = entries.slice(0, 100).map(e => {
    const [reason, detail] = String(e.deny ?? '').split(' ')
    const result = e.deny ? `<span class="pill off">${escapeHtml(DENY_LABELS[reason] ?? reason)}${detail ? ` · ${escapeHtml(detail)}` : ''}</span>` : `<span class="pill on">${escapeHtml(e.status)}</span>`
    return `<tr><td>${date(e.t)}</td><td>${escapeHtml(zoneLabel(e.zone))}</td><td>${escapeHtml(e.method)} ${escapeHtml(e.host)}:${escapeHtml(e.port)}</td><td>${result}</td><td>${bytes(e.up)} / ${bytes(e.down)}</td></tr>`
  }).join('')
  return `<h2>Truy cập internet (24 giờ qua)</h2>
${totals.length === 0 ? '<p>Chưa có truy cập nào.</p>' : `<div class="scroll"><table class="table"><thead><tr><th>Tài khoản</th><th>Kết nối</th><th>Bị chặn</th><th>Gửi đi</th><th>Tải về</th></tr></thead><tbody>${totalRows}</tbody></table></div>`}
${rows ? `<h2>Truy cập internet gần đây</h2>
<div class="scroll"><table class="table"><thead><tr><th>Thời điểm (UTC)</th><th>Tài khoản</th><th>Đích</th><th>Kết quả</th><th>Gửi / nhận</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`
}

/** @param {{ token: string, me: object, users: object[], audit: object[], registrationOpen: boolean, ok?: string, error?: string, tempPassword?: { username: string, password: string }, egress?: object[] }} v */
export function renderAdmin(v) {
  const action = (username, act, label, cls = 'ghost') =>
    `<form method="post" action="/gate/admin">${hidden('token', v.token)}${hidden('username', username)}${hidden('action', act)}<button class="${cls}" type="submit">${label}</button></form>`
  const pending = v.users.filter(u => u.status === 'pending')
  const accounts = v.users.filter(u => u.status !== 'pending')
  const date = s => s ? escapeHtml(s.slice(0, 16).replace('T', ' ')) : '—'
  const statusPill = u => u.disabled ? '<span class="pill off">Đã khóa</span>' : '<span class="pill on">Hoạt động</span>'
  const self = u => u.username === v.me.username
  const q = v.quota ?? { plans: [], defaultPlan: 'free', systemPlan: '', usage: undefined }
  const form = (username, act, fields) => `<form method="post" action="/gate/admin" class="actions">${hidden('token', v.token)}${hidden('username', username)}${hidden('action', act)}${fields}<button class="ghost" type="submit">Lưu</button></form>`
  const planSelect = (username, act, current, blankLabel) => form(username, act, `<select name="plan" aria-label="Gói">${blankLabel ? `<option value="">${blankLabel}</option>` : ''}${q.plans.map(p => `<option value="${escapeHtml(p.id)}"${p.id === current ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>`)
  const limitInput = (name, value, label) => `<input name="${name}" type="number" min="0" step="1" value="${value ?? ''}" placeholder="không giới hạn" aria-label="${label}" style="width:9em">`
  const usageCell = name => {
    if (q.usage === undefined) return ''
    const u = q.usage(name)
    return `5 giờ: ${windowText(u.session)}<br>Tuần: ${windowText(u.week)}`
  }
  const quotaCell = u => u.role === 'admin'
    ? `Không giới hạn (tính vào ${escapeHtml(ADMIN)})`
    : `${usageCell(u.username)}${planSelect(u.username, 'set_plan', u.plan ?? '', 'Theo gói mặc định')}`

  const pendingTable = pending.length === 0 ? '<p>Không có đơn nào đang chờ.</p>' : `<div class="scroll"><table class="table"><thead><tr><th>Tên đăng nhập</th><th>Gửi lúc</th><th>Thao tác</th></tr></thead><tbody>
${pending.map(u => `<tr><td>${escapeHtml(u.username)} <span class="pill pending">Chờ duyệt</span></td><td>${date(u.created_at)}</td>
<td><div class="actions">${action(u.username, 'approve', 'Duyệt')}${action(u.username, 'reject', 'Từ chối', 'danger')}</div></td></tr>`).join('')}
</tbody></table></div>`

  const accountRows = accounts.map(u => `<tr><td>${escapeHtml(u.username)}${self(u) ? ' (bạn)' : ''}</td>
<td>${u.role === 'admin' ? 'Admin' : 'Người dùng'}</td><td>${statusPill(u)}${u.must_change_password ? ' <span class="pill pending">Chờ đổi MK</span>' : ''}</td>
<td>${date(u.last_login_at)}</td><td>${quotaCell(u)}</td><td><div class="actions">
${self(u) ? '' : (u.disabled ? action(u.username, 'enable', 'Mở khóa') : action(u.username, 'disable', 'Khóa', 'danger'))}
${self(u) ? '' : (u.role === 'admin' ? action(u.username, 'make_user', 'Bỏ quyền admin') : action(u.username, 'make_admin', 'Cấp quyền admin'))}
${self(u) ? '<a href="/gate/password">Đổi mật khẩu của bạn</a>' : action(u.username, 'reset_password', 'Đặt lại mật khẩu')}
</div></td></tr>`).join('')

  const auditRows = v.audit.map(a => `<tr><td>${date(a.at)}</td><td>${escapeHtml(a.username ?? '—')}</td><td>${escapeHtml(EVENT_LABELS[a.event] ?? a.event)}${a.detail ? ` · ${escapeHtml(a.detail)}` : ''}</td><td>${escapeHtml(a.ip ?? '')}</td></tr>`).join('')

  return renderPage('Quản trị tài khoản', `<main class="wide">
<div class="top"><h1>Quản trị tài khoản</h1><div class="actions"><a href="/">← Về DocShield</a></div></div>
${v.ok && MESSAGES[v.ok] ? `<div class="banner ok" role="status">${MESSAGES[v.ok]}</div>` : ''}
${v.error ? `<div class="banner err" role="alert">${escapeHtml(v.error)}</div>` : ''}
${v.tempPassword ? `<div class="banner" role="status"><p>Mật khẩu tạm cho <b>${escapeHtml(v.tempPassword.username)}</b> — chỉ hiện một lần, hãy gửi cho người dùng. Họ sẽ phải đổi ngay khi đăng nhập.</p><div class="secret">${escapeHtml(v.tempPassword.password)}</div></div>` : ''}
<div class="banner top"><span>Tự đăng ký tài khoản: <b>${v.registrationOpen ? 'đang mở' : 'đang tắt'}</b></span>
${action('-', v.registrationOpen ? 'close_registration' : 'open_registration', v.registrationOpen ? 'Tắt đăng ký' : 'Mở đăng ký')}</div>
<h2>Đơn đăng ký chờ duyệt (${pending.length})</h2>${pendingTable}
<h2>Tài khoản (${accounts.length})</h2>
<div class="scroll"><table class="table"><thead><tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Trạng thái</th><th>Đăng nhập gần nhất</th><th>Token: mức dùng / gói</th><th>Thao tác</th></tr></thead><tbody>${accountRows}</tbody></table></div>
<h2>Gói token LLM (cửa sổ 5 giờ và tuần, mở từ lời gọi đầu tiên)</h2>
<div class="scroll"><table class="table"><thead><tr><th>Gói</th><th>Giới hạn 5 giờ / tuần (token, trống = không giới hạn)</th></tr></thead><tbody>
${q.plans.map(p => `<tr><td>${escapeHtml(p.name)}${p.id === q.defaultPlan ? ' <span class="pill on">Mặc định</span>' : ''}</td><td>${form('-', 'update_plan', `${hidden('plan', p.id)}${limitInput('session_limit', p.session_limit, `Giới hạn 5 giờ gói ${p.name}`)}${limitInput('weekly_limit', p.weekly_limit, `Giới hạn tuần gói ${p.name}`)}`)}</td></tr>`).join('')}
</tbody></table></div>
<div class="scroll"><table class="table"><thead><tr><th>Áp dụng cho</th><th>Mức dùng</th><th>Gói</th></tr></thead><tbody>
<tr><td>Người dùng chưa gán gói</td><td>—</td><td>${planSelect('-', 'set_default_plan', q.defaultPlan)}</td></tr>
<tr><td>${escapeHtml(SYSTEM)} — lời gọi không gắn phiên</td><td>${usageCell(SYSTEM)}</td><td>${planSelect('-', 'set_system_plan', q.systemPlan, 'Theo gói mặc định')}</td></tr>
<tr><td>${escapeHtml(ADMIN)} — phiên ngoài thư mục người dùng</td><td>${usageCell(ADMIN)}</td><td>Không giới hạn</td></tr>
</tbody></table></div>
<h2>Nhật ký gần đây</h2>
<div class="scroll"><table class="table"><thead><tr><th>Thời điểm (UTC)</th><th>Tài khoản</th><th>Sự kiện</th><th>IP</th></tr></thead><tbody>${auditRows}</tbody></table></div>
${renderEgress(v.egress)}
</main>`)
}

export function renderBar(user) {
  const link = (href, label) => `<a href="${href}" style="color:#e6eaf2;text-decoration:none;padding:3px 8px;border-radius:999px;background:#26345a">${label}</a>`
  return `<form method="post" action="/gate/logout" style="position:fixed;top:8px;right:12px;z-index:2147483647;margin:0;display:flex;gap:6px;align-items:center;font:12px system-ui,sans-serif;background:rgba(18,26,48,.88);color:#e6eaf2;border:1px solid #26345a;border-radius:999px;padding:4px 6px 4px 12px">
<span>${escapeHtml(user.username)}${user.role === 'admin' ? ' · admin' : ''}</span>
<details style="position:relative"><summary style="list-style:none;cursor:pointer;padding:3px 8px;border-radius:999px;background:#26345a">Mức dùng</summary>
<iframe src="/gate/usage?embed=1" loading="lazy" title="Mức dùng token" style="position:absolute;right:0;top:calc(100% + 8px);width:340px;max-width:calc(100vw - 24px);height:230px;border:1px solid #26345a;border-radius:12px;background:#121a30"></iframe></details>
${user.role === 'admin' ? link('/gate/admin', 'Quản trị') : ''}${link('/gate/password', 'Đổi mật khẩu')}
<button type="submit" style="font:inherit;border:0;border-radius:999px;padding:3px 10px;background:#26345a;color:#e6eaf2;cursor:pointer">Đăng xuất</button></form>`
}
