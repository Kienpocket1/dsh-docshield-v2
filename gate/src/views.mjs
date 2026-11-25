/** Server-rendered gate pages (no scripts; CSP forbids them). */
import { MIN_PASSWORD_LENGTH } from './password.mjs'
import { summarize, zoneLabel } from './egress-log.mjs'
import { ADMIN, SYSTEM, vnTime } from './quota.mjs'
import { USER_PRESET, USER_EXTRA_PRESETS } from './policy.mjs'

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Swiss-minimal: navy brand + teal action, system fonts (CSP blocks web fonts), light/dark tokens.
const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#e2e8f0;--line-strong:#cbd5e1;--brand:#1e3a5f;--on-brand:#fff;--accent:#0f766e;--on-accent:#fff;--err:#b91c1c;--err-bg:#fef2f2;--ok:#047857;--ok-bg:#ecfdf5;--warn:#b45309;--warn-bg:#fffbeb;--chip:#f1f5f9;--ring:#2563eb;--shadow:0 1px 2px rgba(15,23,42,.06),0 4px 16px rgba(15,23,42,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111a2e;--ink:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--line-strong:#334155;--brand:#93c5fd;--on-brand:#0b1120;--accent:#2dd4bf;--on-accent:#042f2e;--err:#f87171;--err-bg:#2a1215;--ok:#34d399;--ok-bg:#062a1f;--warn:#fbbf24;--warn-bg:#2a1f07;--chip:#1a2540;--ring:#60a5fa;--shadow:none}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:72px}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
h1{margin:0;font-size:24px;line-height:1.25;letter-spacing:-.01em}h2{margin:0;font-size:17px;line-height:1.3}h3{margin:0;font-size:15px}
p{margin:0;color:var(--muted);font-size:14px}
a{color:var(--accent);text-underline-offset:2px}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.center{min-height:100vh;display:grid;place-items:center;padding:24px 16px}
.card{width:min(400px,100%);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 28px;display:grid;gap:16px;box-shadow:var(--shadow)}
.brand{display:flex;align-items:center;gap:10px;color:var(--brand);font-weight:700;font-size:15px;letter-spacing:.01em}
.brand svg{width:28px;height:28px;flex:none}
label{display:grid;gap:6px;font-size:14px;font-weight:500}
input,select{font:inherit;font-size:15px;padding:10px 12px;min-height:44px;border:1px solid var(--line-strong);border-radius:10px;background:var(--card);color:inherit;width:100%;transition:border-color .15s}
input:hover,select:hover{border-color:var(--muted)}
input[type=checkbox]{width:18px;height:18px;min-height:0;padding:0;accent-color:var(--accent);margin:0;flex:none}
button{font:inherit;font-weight:600;font-size:15px;min-height:44px;padding:10px 16px;border:1px solid transparent;border-radius:10px;background:var(--accent);color:var(--on-accent);cursor:pointer;transition:filter .15s,background .15s}
button:hover{filter:brightness(1.08)}
button.ghost{background:var(--chip);color:var(--ink);border-color:var(--line);font-weight:500;font-size:13px;min-height:36px;padding:6px 12px}
button.ghost:hover{border-color:var(--line-strong);filter:none}
button.danger{background:transparent;color:var(--err);border-color:currentColor;font-weight:500;font-size:13px;min-height:36px;padding:6px 12px}
button.danger:hover{background:var(--err-bg);filter:none}
.err{color:var(--err);background:var(--err-bg);padding:10px 12px;border-radius:10px;font-size:14px}
.ok{color:var(--ok);background:var(--ok-bg);padding:10px 12px;border-radius:10px;font-size:14px}
.links{display:flex;gap:12px;justify-content:center;font-size:14px}
.hint{font-size:13px}
.wide{max-width:1180px;margin:0 auto;padding:0 16px 64px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.head{padding:28px 0 16px}
.nav{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);margin:0 -16px 20px;padding:8px 16px;display:flex;gap:4px;overflow-x:auto}
.nav a{flex:none;color:var(--muted);text-decoration:none;font-size:14px;font-weight:500;padding:8px 12px;border-radius:8px}
.nav a:hover{background:var(--chip);color:var(--ink)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat b{display:block;font-size:24px;line-height:1.2;font-variant-numeric:tabular-nums}.stat span{font-size:13px;color:var(--muted)}
.section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:20px;display:grid;gap:14px;box-shadow:var(--shadow)}
.section-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}
.table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
.table th,.table td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.table tbody tr:last-child td{border-bottom:0}.table tbody tr:hover{background:color-mix(in srgb,var(--chip) 60%,transparent)}
.table th{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);white-space:nowrap;border-bottom-color:var(--line-strong)}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
.actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.actions form{margin:0}
.table td form.actions{flex-wrap:nowrap}
form.actions select,form.actions input:not([type=checkbox]){width:auto;min-height:36px;padding:6px 10px;font-size:14px}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--chip);white-space:nowrap}
.pill.pending{color:var(--warn);background:var(--warn-bg)}.pill.off{color:var(--err);background:var(--err-bg)}.pill.on{color:var(--ok);background:var(--ok-bg)}
.banner{padding:12px 16px;border-radius:12px;border:1px solid var(--line);background:var(--card);margin:0 0 16px}
.banner.ok{border-color:color-mix(in srgb,var(--ok) 35%,transparent)}.banner.err{border-color:color-mix(in srgb,var(--err) 35%,transparent)}
.secret{font:600 20px/1.4 ui-monospace,Consolas,monospace;letter-spacing:.05em;margin-top:8px;user-select:all}
.user b{font-weight:600}.user small{color:var(--muted);font-size:12px}
.usage-mini{font-size:13px;color:var(--muted);margin-bottom:6px;white-space:nowrap}
details.presets>summary{cursor:pointer;font-size:13px;color:var(--ink);list-style:none;display:inline-flex;gap:6px;align-items:center;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--chip);white-space:nowrap}
details.presets>summary::-webkit-details-marker{display:none}
details.presets>summary::after{content:"▾";color:var(--muted)}details.presets[open]>summary::after{content:"▴"}
.checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px 14px;margin:10px 0}
.checks label{display:flex;gap:8px;align-items:center;font-weight:400;font-size:13px;font-family:ui-monospace,Consolas,monospace}
.checks .fixed{color:var(--muted)}
`
const LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>'
const brand = `<div class="brand">${LOGO}<span>DocShield</span></div>`

export function renderPage(title, body, head = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — DocShield</title><style>${STYLE}</style>${head}</head><body>${body}</body></html>`
}

const errorBox = error => error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
const card = (action, inner) => `<main class="center"><form class="card" method="post" action="${action}">${brand}${inner}</form></main>`

export function renderLogin({ csrf, next, error, username, notice, registrationOpen }) {
  return renderPage('Đăng nhập', card('/gate/login', `
<div><h1>Đăng nhập</h1><p>Vào không gian làm việc tài liệu của bạn.</p></div>${errorBox(error)}${notice ? `<div class="ok">${escapeHtml(notice)}</div>` : ''}
<label>Tên đăng nhập<input name="username" autocomplete="username" required value="${escapeHtml(username)}" autofocus></label>
<label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required></label>
${hidden('csrf', csrf)}${hidden('next', next)}
<button type="submit">Đăng nhập</button>
${registrationOpen ? '<div class="links"><a href="/gate/register">Chưa có tài khoản? Đăng ký</a></div>' : ''}`))
}

const newPasswordFields = `
<label>Mật khẩu<input name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"></label>
<label>Nhập lại mật khẩu<input name="password2" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"></label>
<p class="hint">Ít nhất ${MIN_PASSWORD_LENGTH} ký tự.</p>`

const usernameField = (username, autofocus) => `
<label>Tên đăng nhập<input name="username" autocomplete="username" required value="${escapeHtml(username)}"${autofocus ? ' autofocus' : ''}></label>
<p class="hint">3–32 ký tự: chữ thường, số, dấu _ hoặc -. Đây cũng là tên thư mục tài liệu của bạn.</p>`

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
  return renderPage(title, `<main class="center"><div class="card">${brand}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
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
  reg_open: 'Đã mở đăng ký tài khoản.', reg_closed: 'Đã tắt đăng ký tài khoản.', plan_saved: 'Đã lưu gói token.', presets_saved: 'Đã lưu quyền preset.',
}

const EVENT_LABELS = {
  login: 'Đăng nhập', logout: 'Đăng xuất', login_failed: 'Sai mật khẩu', login_locked: 'Bị khóa tạm', login_pending: 'Đăng nhập khi chờ duyệt',
  registered: 'Gửi đăng ký', approved: 'Được duyệt', rejected: 'Bị từ chối', user_disabled: 'Bị khóa', user_enabled: 'Được mở khóa',
  role_changed: 'Đổi vai trò', password_reset: 'Admin đặt lại mật khẩu', password_changed: 'Đổi mật khẩu', setup_admin_created: 'Tạo admin đầu tiên',
  setup_failed: 'Sai mã thiết lập', user_added: 'Tạo bằng dòng lệnh', registration_toggled: 'Bật/tắt đăng ký',
  plan_changed: 'Sửa gói token', plan_assigned: 'Gán gói token', presets_assigned: 'Gán preset', ticket_decided: 'Duyệt phiếu hỗ trợ',
}

// ---------------- Support tickets + ticket-agent proposals (Project 3) ----------------

const TICKET_PILL = { open: 'pending', in_progress: 'pending', resolved: 'on', rejected: 'off' }
const TICKET_MESSAGES = { ticket_approved: 'Đã duyệt: người hỏi sẽ thấy câu trả lời khi kiểm tra phiếu.', ticket_rejected: 'Đã từ chối phiếu; lý do đã gửi người hỏi.' }
const DIAGNOSIS = { 'truc-tiep': 'Có sẵn, chatbot trả lời được', 'tim-kiem-truot': 'Tìm kiếm trượt (khác từ ngữ)', 'nhieu-buoc': 'Cần ghép nhiều đoạn / tính toán',
  'cu-mau-thuan': 'Văn bản cũ / mâu thuẫn', 'mo-ho': 'Câu hỏi mơ hồ', thieu: 'Kho thiếu tài liệu' }
const ticketPill = t => `<span class="pill ${TICKET_PILL[t.status] ?? ''}">${escapeHtml(t.statusLabel)}</span>`
const shortDate = s => s ? escapeHtml(String(s).slice(0, 16).replace('T', ' ')) : '—'
const ticketShell = (title, inner) => renderPage(title, `<main class="wide">
<div class="top head"><div>${brand}<h1 style="margin-top:6px">${escapeHtml(title)}</h1></div><div class="actions"><a href="/gate/admin">Quản trị tài khoản</a><a href="/">← Về DocShield</a></div></div>${inner}</main>`)

/** @param {{ tickets: object[], status?: string, ok?: string, error?: string }} v */
export function renderTickets(v) {
  const tab = (s, label) => `<a href="/gate/admin/tickets${s ? `?status=${s}` : ''}"${(v.status ?? '') === s ? ' aria-current="page" style="background:var(--chip);color:var(--ink)"' : ''}>${label}</a>`
  const rows = v.tickets.map(t => `<tr><td style="white-space:nowrap"><a href="/gate/admin/tickets?code=${escapeHtml(t.code)}"><b>${escapeHtml(t.code)}</b></a></td>
<td>${escapeHtml(t.userId)}</td><td>${escapeHtml(t.question)}</td><td>${ticketPill(t)}</td>
<td>${t.drafts ? `<span class="pill pending">${t.drafts} chờ duyệt</span>` : t.proposals ? `${t.proposals}` : '<span class="pill">Chưa có</span>'}</td>
<td style="white-space:nowrap">${shortDate(t.createdAt)}</td></tr>`).join('')
  return ticketShell('Phiếu hỗ trợ', `<nav class="nav" aria-label="Lọc theo trạng thái">${tab('', 'Tất cả')}${tab('open', 'Đang chờ')}${tab('in_progress', 'Đang xử lý')}${tab('resolved', 'Đã giải quyết')}${tab('rejected', 'Từ chối')}</nav>
${v.error ? `<div class="banner err" role="alert">${escapeHtml(v.error)}</div>` : ''}
<section class="section"><div class="section-head"><div><h2>${v.tickets.length} phiếu</h2><p>Agent xử lý phiếu tự soạn đề xuất cho phiếu mới; người hỏi chỉ thấy câu trả lời sau khi bạn duyệt.</p></div></div>
${v.tickets.length === 0 ? '<p>Không có phiếu nào.</p>' : `<div class="scroll"><table class="table"><thead><tr><th scope="col">Mã</th><th scope="col">Người hỏi</th><th scope="col">Câu hỏi</th><th scope="col">Trạng thái</th><th scope="col">Đề xuất</th><th scope="col">Tạo lúc (UTC)</th></tr></thead><tbody>${rows}</tbody></table></div>`}</section>`)
}

/** Reply prefilled from the proposal: the answer, then its sources. */
export function draftReply(payload) {
  if (!payload || typeof payload.tra_loi !== 'string' || payload.tra_loi.trim() === '') return ''
  const cites = Array.isArray(payload.trich_dan) ? payload.trich_dan.filter(c => c && c.file) : []
  return cites.length === 0 ? payload.tra_loi : `${payload.tra_loi}\n\nNguồn: ${cites.map(c => `${c.file}${c.vi_tri ? ` (${c.vi_tri})` : ''}`).join('; ')}`
}

/** @param {{ token: string, ticket: object, proposals: object[], showRationale: boolean, ok?: string, error?: string }} v */
export function renderTicket(v) {
  const t = v.ticket
  const closed = t.status === 'resolved' || t.status === 'rejected'
  const field = (label, value) => value === undefined || value === null || value === '' ? '' : `<div><h3>${label}</h3><p style="color:var(--ink);white-space:pre-wrap">${escapeHtml(value)}</p></div>`
  const toggle = `<a href="/gate/admin/tickets?code=${escapeHtml(t.code)}${v.showRationale ? '&lydo=0' : ''}">${v.showRationale ? 'Ẩn phiếu lý do' : 'Hiện phiếu lý do'}</a>`
  const card = p => {
    const d = p.payload ?? {}
    const meta = [p.config, p.model, p.tokens ? `${num(p.tokens)} token` : '', p.seconds ? `${Math.round(p.seconds)} giây` : '', shortDate(p.createdAt)].filter(Boolean).map(escapeHtml).join(' · ')
    const status = p.status === 'draft' ? '<span class="pill pending">Chờ duyệt</span>' : p.status === 'approved' ? '<span class="pill on">Đã duyệt</span>' : '<span class="pill off">Từ chối</span>'
    const cites = Array.isArray(d.trich_dan) && d.trich_dan.length ? `<div><h3>Trích dẫn</h3><ul style="margin:4px 0 0;padding-left:20px;font-size:14px">${d.trich_dan.map(c => `<li><b>${escapeHtml(c.file ?? '')}</b>${c.vi_tri ? ` (${escapeHtml(c.vi_tri)})` : ''}: “${escapeHtml(c.nguyen_van ?? '')}”</li>`).join('')}</ul></div>` : ''
    const badges = p.payload === null ? '<span class="pill off">Agent không xuất phiếu đề xuất JSON</span>'
      : `${d.chan_doan ? `<span class="pill">${escapeHtml(DIAGNOSIS[d.chan_doan] ?? d.chan_doan)}</span>` : ''} ${d.do_tin_cay ? `<span class="pill">Tin cậy: ${escapeHtml(d.do_tin_cay)}</span>` : ''} ${d.da_kiem_chung === true ? '<span class="pill on">Trích dẫn đã kiểm chứng</span>' : '<span class="pill pending">Trích dẫn chưa kiểm chứng</span>'}`
    const decide = p.status === 'draft' && !closed ? `<div class="section" style="box-shadow:none;margin:0;background:var(--bg)">
<form method="post" action="/gate/admin/tickets" style="display:grid;gap:10px">${hidden('token', v.token)}${hidden('code', t.code)}${hidden('proposal', String(p.id))}${hidden('decision', 'approve')}
<label>Câu trả lời gửi người hỏi (sửa nếu cần)<textarea name="reply" rows="6" required style="font:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--line-strong);border-radius:10px;background:var(--card);color:inherit;resize:vertical">${escapeHtml(draftReply(d))}</textarea></label>
<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" name="kb" value="1"${d.de_xuat_cap_nhat_kho || d.chan_doan === 'thieu' ? ' checked' : ''}>Thêm câu hỏi + câu trả lời này vào kho tài liệu chung (hỏi đáp), để chatbot trả lời được lần sau</label>
<div class="actions"><button type="submit">Duyệt và gửi</button></div></form>
<form method="post" action="/gate/admin/tickets" style="display:grid;gap:10px">${hidden('token', v.token)}${hidden('code', t.code)}${hidden('proposal', String(p.id))}${hidden('decision', 'reject')}
<details><summary style="cursor:pointer;font-size:14px;color:var(--err)">Từ chối phiếu…</summary><div style="display:grid;gap:10px;margin-top:10px">
<label>Lý do gửi người hỏi<input name="reason" required></label><div class="actions"><button class="danger" type="submit">Từ chối</button></div></div></details></form></div>` : ''
    return `<section class="section" aria-label="Đề xuất #${p.id}"><div class="section-head"><div><h2>Đề xuất #${p.id} ${status}</h2><p>${meta}</p></div><div class="actions">${badges}</div></div>
${field('Câu trả lời đề xuất', d.tra_loi === null && p.payload !== null ? 'Kho không có thông tin (agent đề nghị bổ sung kho).' : d.tra_loi)}
${cites}${field('Đề xuất cập nhật kho', d.de_xuat_cap_nhat_kho)}${v.showRationale ? field('Phiếu lý do (agent đã tìm gì, chọn nguồn nào)', d.phieu_ly_do) : ''}
${p.payload === null ? `<details><summary style="cursor:pointer;font-size:14px">Câu trả lời thô của agent</summary><p style="white-space:pre-wrap;color:var(--ink);margin-top:8px">${escapeHtml(p.raw)}</p></details>` : ''}
${p.finalReply ? field(p.status === 'approved' ? `Đã gửi người hỏi (${escapeHtml(p.decidedBy ?? '')}, ${shortDate(p.decidedAt)})` : `Lý do từ chối (${escapeHtml(p.decidedBy ?? '')})`, p.finalReply) : ''}
${p.kbFile ? `<p>Đã thêm vào kho: <code>${escapeHtml(p.kbFile)}</code></p>` : ''}${decide}</section>`
  }
  return ticketShell(`Phiếu ${t.code}`, `<p style="margin:-8px 0 16px"><a href="/gate/admin/tickets">← Danh sách phiếu</a> · ${toggle}</p>
${v.ok && TICKET_MESSAGES[v.ok] ? `<div class="banner ok" role="status">${TICKET_MESSAGES[v.ok]}</div>` : ''}
${v.error ? `<div class="banner err" role="alert">${escapeHtml(v.error)}</div>` : ''}
<section class="section"><div class="section-head"><div><h2>${escapeHtml(t.question)}</h2><p>Người hỏi: <b>${escapeHtml(t.userId)}</b> · tạo ${shortDate(t.createdAt)} (UTC)</p></div>${ticketPill(t)}</div>
${field('Lý do chatbot chuyển phiếu', t.reason)}${field(t.status === 'rejected' ? 'Lý do từ chối đã gửi' : 'Phản hồi đã gửi người hỏi', t.adminReply)}</section>
${v.proposals.length === 0 ? '<section class="section"><p>Agent chưa có đề xuất cho phiếu này (đang chờ worker xử lý).</p></section>' : v.proposals.slice().reverse().map(card).join('')}`)
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
.usage-track{height:8px;border-radius:999px;background:var(--chip);overflow:hidden}.usage-track div{height:100%}
${embed ? 'body{min-height:0;font-size:14px}' : ''}</style>`
  const body = `<div class="usage"><div class="usage-head"><span>Gói: <b>${usage.plan === null ? 'Không giới hạn' : escapeHtml(usage.plan.name)}</b></span>${embed ? '<a href="/gate/usage" target="_blank" rel="noopener">Chi tiết</a>' : ''}</div>
${bar('Giới hạn 5 giờ', usage.session)}${bar('Tuần', usage.week)}</div>`
  return embed
    ? renderPage('Mức dùng', body, `${style}<meta http-equiv="refresh" content="30">`)
    : renderPage('Mức dùng', `<main class="wide" style="max-width:720px"><div class="top head"><div>${brand}<h1 style="margin-top:6px">Mức dùng token</h1></div><div class="actions"><a href="/">← Về DocShield</a></div></div><section class="section">${body}
<p class="usage-sub">Cửa sổ mở từ lời gọi model đầu tiên và kéo dài 5 giờ / 7 ngày. Khi chạm một trong hai giới hạn, lượt chat bị chặn tới giờ đặt lại.</p></section></main>`, style)
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
  // Presets: USER_PRESET always on; the rest ticked per user, or "follow default" (NULL).
  const pr = v.presets ?? { catalog: [], defaults: undefined }
  const defaultList = pr.defaults === undefined ? [...USER_EXTRA_PRESETS] : pr.defaults.split(',').filter(Boolean)
  const choices = pr.catalog.filter(id => id !== USER_PRESET)
  const presetForm = (username, act, current, withFollow) => {
    const own = current === null || current === undefined ? null : current.split(',').filter(Boolean)
    const on = new Set(own ?? defaultList)
    const boxes = choices.map(id => `<label><input type="checkbox" name="preset" value="${escapeHtml(id)}"${on.has(id) ? ' checked' : ''}>${escapeHtml(id)}</label>`).join('')
    const follow = withFollow ? `<label style="font-family:inherit;font-weight:600"><input type="checkbox" name="follow_default" value="1"${own === null ? ' checked' : ''}>Theo mặc định</label>` : ''
    const grid = `<div class="checks"><label class="fixed"><input type="checkbox" checked disabled>${escapeHtml(USER_PRESET)} (luôn có)</label>${follow}${choices.length ? boxes : '<span>(không đọc được danh sách preset)</span>'}</div>`
    return `<form method="post" action="/gate/admin">${hidden('token', v.token)}${hidden('username', username)}${hidden('action', act)}${grid}<button class="ghost" type="submit">Lưu</button></form>`
  }
  const presetCell = u => {
    if (u.role === 'admin') return '<span class="pill">Tất cả</span>'
    const own = u.presets === null || u.presets === undefined ? null : u.presets.split(',').filter(Boolean)
    const label = own === null ? 'Theo mặc định' : `${own.length + 1} preset`
    return `<details class="presets"><summary aria-label="Preset được chọn của ${escapeHtml(u.username)}">${label}</summary>${presetForm(u.username, 'set_presets', u.presets, true)}</details>`
  }
  const quotaCell = u => u.role === 'admin'
    ? `<span class="usage-mini">Không giới hạn (tính vào ${escapeHtml(ADMIN)})</span>`
    : `<div class="usage-mini">${usageCell(u.username)}</div>${planSelect(u.username, 'set_plan', u.plan ?? '', 'Theo gói mặc định')}`

  const pendingTable = pending.length === 0 ? '<p>Không có đơn nào đang chờ.</p>' : `<div class="scroll"><table class="table"><thead><tr><th>Tên đăng nhập</th><th>Gửi lúc</th><th>Thao tác</th></tr></thead><tbody>
${pending.map(u => `<tr><td>${escapeHtml(u.username)} <span class="pill pending">Chờ duyệt</span></td><td>${date(u.created_at)}</td>
<td><div class="actions">${action(u.username, 'approve', 'Duyệt')}${action(u.username, 'reject', 'Từ chối', 'danger')}</div></td></tr>`).join('')}
</tbody></table></div>`

  const accountRows = accounts.map(u => `<tr><td class="user"><b>${escapeHtml(u.username)}</b>${self(u) ? ' <small>(bạn)</small>' : ''}<br><small>${u.role === 'admin' ? 'Admin' : 'Người dùng'}</small></td>
<td>${statusPill(u)}${u.must_change_password ? ' <span class="pill pending">Chờ đổi MK</span>' : ''}</td>
<td style="white-space:nowrap">${date(u.last_login_at)}</td><td>${quotaCell(u)}</td><td>${presetCell(u)}</td><td><div class="actions">
${self(u) ? '' : (u.disabled ? action(u.username, 'enable', 'Mở khóa') : action(u.username, 'disable', 'Khóa', 'danger'))}
${self(u) ? '' : (u.role === 'admin' ? action(u.username, 'make_user', 'Bỏ quyền admin') : action(u.username, 'make_admin', 'Cấp quyền admin'))}
${self(u) ? '<a href="/gate/password">Đổi mật khẩu của bạn</a>' : action(u.username, 'reset_password', 'Đặt lại mật khẩu')}
</div></td></tr>`).join('')

  const auditRows = v.audit.map(a => `<tr><td>${date(a.at)}</td><td>${escapeHtml(a.username ?? '—')}</td><td>${escapeHtml(EVENT_LABELS[a.event] ?? a.event)}${a.detail ? ` · ${escapeHtml(a.detail)}` : ''}</td><td>${escapeHtml(a.ip ?? '')}</td></tr>`).join('')

  const locked = accounts.filter(u => u.disabled).length
  const admins = accounts.filter(u => u.role === 'admin').length
  const section = (id, title, sub, inner, extra = '') => `<section class="section" id="${id}" aria-labelledby="${id}-h"><div class="section-head"><div><h2 id="${id}-h">${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${extra}</div>${inner}</section>`
  const table = (heads, rows) => `<div class="scroll"><table class="table"><thead><tr>${heads.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`

  return renderPage('Quản trị tài khoản', `<main class="wide">
<div class="top head"><div>${brand}<h1 style="margin-top:6px">Quản trị tài khoản</h1></div><div class="actions"><a href="/">← Về DocShield</a></div></div>
<nav class="nav" aria-label="Mục quản trị"><a href="#accounts">Tài khoản</a><a href="#pending">Chờ duyệt${pending.length ? ` (${pending.length})` : ''}</a><a href="#presets">Preset</a><a href="#plans">Gói token</a><a href="#audit">Nhật ký</a><a href="/gate/admin/tickets">Phiếu hỗ trợ →</a>${v.egress === undefined ? '' : '<a href="#egress">Internet</a>'}</nav>
${v.ok && MESSAGES[v.ok] ? `<div class="banner ok" role="status">${MESSAGES[v.ok]}</div>` : ''}
${v.error ? `<div class="banner err" role="alert">${escapeHtml(v.error)}</div>` : ''}
${v.tempPassword ? `<div class="banner" role="status"><p>Mật khẩu tạm cho <b>${escapeHtml(v.tempPassword.username)}</b> — chỉ hiện một lần, hãy gửi cho người dùng. Họ sẽ phải đổi ngay khi đăng nhập.</p><div class="secret">${escapeHtml(v.tempPassword.password)}</div></div>` : ''}
<div class="stats"><div class="stat"><b>${accounts.length}</b><span>Tài khoản</span></div><div class="stat"><b>${admins}</b><span>Admin</span></div>
<div class="stat"><b>${pending.length}</b><span>Đơn chờ duyệt</span></div><div class="stat"><b>${locked}</b><span>Đã khóa</span></div>
<div class="stat"><b>${v.registrationOpen ? 'Mở' : 'Tắt'}</b><span>Tự đăng ký</span></div></div>
${section('accounts', `Tài khoản (${accounts.length})`, 'Gói token, preset được chọn và thao tác cho từng người.',
  table(['Tài khoản', 'Trạng thái', 'Đăng nhập gần nhất', 'Token: mức dùng / gói', 'Preset được chọn', 'Thao tác'], accountRows))}
${section('pending', `Đơn đăng ký chờ duyệt (${pending.length})`, `Tự đăng ký tài khoản: <b>${v.registrationOpen ? 'đang mở' : 'đang tắt'}</b>`, pendingTable,
  action('-', v.registrationOpen ? 'close_registration' : 'open_registration', v.registrationOpen ? 'Tắt đăng ký' : 'Mở đăng ký'))}
${section('presets', 'Preset mặc định cho người dùng chưa gán riêng', 'Đổi quyền chỉ áp dụng cho phiên mới; phiên đã chạy giữ preset của nó.',
  presetForm('-', 'set_default_presets', pr.defaults ?? defaultList.join(','), false))}
${section('plans', 'Gói token LLM (cửa sổ 5 giờ và tuần, mở từ lời gọi đầu tiên)', 'Trống = không giới hạn.',
  `${table(['Gói', 'Giới hạn 5 giờ / tuần (token)'], q.plans.map(p => `<tr><td>${escapeHtml(p.name)}${p.id === q.defaultPlan ? ' <span class="pill on">Mặc định</span>' : ''}</td><td>${form('-', 'update_plan', `${hidden('plan', p.id)}${limitInput('session_limit', p.session_limit, `Giới hạn 5 giờ gói ${p.name}`)}${limitInput('weekly_limit', p.weekly_limit, `Giới hạn tuần gói ${p.name}`)}`)}</td></tr>`).join(''))}
${table(['Áp dụng cho', 'Mức dùng', 'Gói'], `<tr><td>Người dùng chưa gán gói</td><td>—</td><td>${planSelect('-', 'set_default_plan', q.defaultPlan)}</td></tr>
<tr><td>${escapeHtml(SYSTEM)} — lời gọi không gắn phiên</td><td class="usage-mini">${usageCell(SYSTEM)}</td><td>${planSelect('-', 'set_system_plan', q.systemPlan, 'Theo gói mặc định')}</td></tr>
<tr><td>${escapeHtml(ADMIN)} — phiên ngoài thư mục người dùng</td><td class="usage-mini">${usageCell(ADMIN)}</td><td>Không giới hạn</td></tr>`)}`)}
${section('audit', 'Nhật ký gần đây', '30 sự kiện mới nhất.', table(['Thời điểm (UTC)', 'Tài khoản', 'Sự kiện', 'IP'], auditRows))}
${v.egress === undefined ? '' : `<section class="section" id="egress">${renderEgress(v.egress)}</section>`}
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
