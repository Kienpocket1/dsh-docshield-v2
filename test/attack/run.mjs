#!/usr/bin/env node
/**
 * Attack suite, one command (Windows host, Docker Desktop running):
 *   npm run attack [-- --fresh] [-- --with-model] [-- --out report.md] [-- --prefix atk]
 *
 * Builds an isolated test system (prefix "atk": its own volumes, networks, ports 3448/3462;
 * never touches "docshield" or "e2e"), seeds sample data, creates test accounts with random
 * passwords kept only in memory, runs every attack group, prints a TC table and writes a
 * Markdown report. Containers are always removed at the end (even on Ctrl+C or a crash);
 * volumes are kept so the next run starts fast (--fresh rebuilds them).
 *
 * Needs the images docshield-tools:dev and docshield-dsh-main:dev (start-gate.cmd docker rebuild
 * builds them) and internet on the host (egress tests). Exit code 1 if any check fails.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback }
const P = opt('--prefix', 'atk')
if (!/^[a-z][a-z0-9-]{1,20}$/.test(P) || ['docshield', 'e2e'].includes(P)) throw new Error(`prefix "${P}" không được phép (phải khác docshield/e2e)`)
const FRESH = argv.includes('--fresh')
const WITH_MODEL = argv.includes('--with-model')
const OUT = path.resolve(opt('--out', path.join(ROOT, 'test', 'attack', 'last-run.md')))
const GATE_PORT = 3448
const MANAGER_PORT = 3462
const GATE = `http://127.0.0.1:${GATE_PORT}`
const MAIN = `${P}-dsh-main`
const ALICE = `${P}-alice`
const BOB = `${P}-bob`
const ADMIN = `${P}-admin`
const DOCKER = existsSync('E:/Docker/DockerDesktop/resources/bin/docker.exe') ? 'E:/Docker/DockerDesktop/resources/bin/docker.exe' : 'docker'
const VOLUMES = ['storage', 'home', 'db', 'gate', 'egress-log'].map(v => `${P}-${v}`)

const TC = {
  TC1: 'Đọc/ghi dữ liệu người khác, cwd giả', TC2: 'Chèn tham số vào lệnh Docker', TC3: 'Cạn tài nguyên (tiến trình, RAM, đĩa)',
  TC4: 'Symlink thoát khỏi vùng', TC5: 'Lời gọi công cụ không gắn phiên', TC6: 'Subagent', TC7: 'Đi ngang giữa các container',
  TC8: 'Tìm kiếm rg/grep', TC9: 'Đua TOCTOU khi đọc file (phía host)', TC10: 'Đường dẫn lạ, tên tiếng Việt', TC11: 'Khóa file NTFS ↔ ext4',
  TC12: 'Bom dữ liệu qua socket', TC13: 'Điều khiển tool-manager trái phép', TC14: 'SSRF, tấn công mạng nội bộ', TC15: 'Rò rỉ dữ liệu ra ngoài',
  TC16: 'Botnet, spam, cổng lạ', Gate: 'Đăng nhập, cookie, phân quyền giao diện', Admin: 'Quyền xem dữ liệu của admin',
  'Phục hồi': 'Container bị xóa giữa chừng', 'Nạp tài liệu': 'DocShield nạp file agent ghi (cần mô hình)', 'Chức năng': 'Chức năng vẫn chạy đúng',
  Unit: 'Unit test (không cần Docker)', Lỗi: 'Lỗi của chính bộ test',
}

// ---------- helpers ----------
const t0 = Date.now()
const results = [] // { group, tag, ok, name, detail }
const say = msg => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
function docker(args, { input, timeout = 120_000, allowFail = true } = {}) {
  try { return execFileSync(DOCKER, args, { encoding: 'utf8', windowsHide: true, input, stdio: ['pipe', 'pipe', 'pipe'], timeout }).trim() }
  catch (e) { if (!allowFail) throw new Error(`docker ${args.slice(0, 3).join(' ')}: ${(e.stderr ?? e.message).toString().trim()}`); return null }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(probe, done, timeoutMs, everyMs, what) {
  const start = Date.now()
  let value = await probe()
  while (!done(value)) {
    if (Date.now() - start > timeoutMs) throw new Error(`hết thời gian chờ ${what} (${Math.round(timeoutMs / 1000)} s), giá trị cuối: ${String(value).slice(0, 200)}`)
    await sleep(everyMs)
    value = await probe()
  }
  return value
}
const record = (group, tag, ok, name, detail = '') => results.push({ group, tag, ok, name, detail })
const LINE = /^(PASS|FAIL)\s+\[([^\]]+)\]\s+(.*?)(?:\s{2}\((.*)\))?$/

/** Run a child test script; every `PASS|FAIL  [TAG] …` line it prints becomes a result. */
function runGroup(group, cmd, args, { env = {}, cwd = ROOT, timeoutMs = 10 * 60_000, onLine } = {}) {
  say(`▶ ${group}`)
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let seen = 0
    let stderr = ''
    let buf = ''
    const timer = setTimeout(() => {
      record(group, 'Lỗi', false, `nhóm "${group}" quá ${timeoutMs / 60_000} phút, đã dừng`)
      console.log(`   ✗ [Lỗi] nhóm "${group}" quá ${timeoutMs / 60_000} phút, đã dừng`)
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        onLine?.(line, child)
        const m = LINE.exec(line)
        if (!m) continue
        seen++
        record(group, m[2], m[1] === 'PASS', m[3], m[4] ?? '')
        console.log(`   ${m[1] === 'PASS' ? '✓' : '✗'} [${m[2]}] ${m[3]}${m[1] === 'FAIL' && m[4] ? `  (${m[4]})` : ''}`)
      }
    })
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000) })
    child.on('close', code => {
      clearTimeout(timer)
      if (seen === 0) record(group, 'Lỗi', false, `nhóm "${group}" không in kết quả nào (mã thoát ${code})`, stderr.split('\n').filter(Boolean).slice(-3).join(' | '))
      else if (code !== 0 && !results.some(r => r.group === group && !r.ok)) record(group, 'Lỗi', false, `nhóm "${group}" thoát với mã ${code}`, stderr.slice(-300))
      resolve(code)
    })
  })
}
const inMain = (phase, extra = {}) => ['exec', '-e', `ATK_PREFIX=${P}`, ...Object.entries(extra).flatMap(([k, v]) => ['-e', `${k}=${v}`]), MAIN, 'timeout', '-k', '10', '540', 'node', '/opt/plugins/dsh-exec-router/test/e2e-router.mjs', phase]

// ---------- cleanup: exactly once, on every way out ----------
let manager
let cleaned = false
function cleanup(reason) {
  if (cleaned) return
  cleaned = true
  if (reason) say(`dọn dẹp (${reason})...`)
  try { manager?.kill() } catch { /* already gone */ }
  // tool-manager cleans up on a signal, but on Windows kill() is abrupt: remove by label, synchronously.
  const names = docker(['ps', '-aq', '--filter', `label=${P}.role`]) ?? ''
  if (names) docker(['rm', '-f', ...names.split(/\s+/)])
}
process.on('exit', () => cleanup())
for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, () => { cleanup(s); process.exit(130) })
process.on('uncaughtException', e => { console.error(e); cleanup('lỗi không bắt'); process.exit(2) })
process.on('unhandledRejection', e => { console.error(e); cleanup('promise lỗi'); process.exit(2) })

// ---------- 1. preflight ----------
if (!docker(['version', '--format', '{{.Server.Version}}'])) { console.error('Docker chưa chạy. Mở Docker Desktop (hoặc start-gate.cmd docker) rồi chạy lại.'); process.exit(2) }
for (const image of ['docshield-tools:dev', 'docshield-dsh-main:dev']) {
  if (docker(['image', 'inspect', image, '--format', 'ok']) !== 'ok') { console.error(`Thiếu image ${image}: chạy start-gate.cmd docker rebuild trước.`); process.exit(2) }
}
const commit = (() => { try { return execFileSync('git', ['-C', ROOT, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' }).trim() } catch { return '?' } })()
// The real system's long-lived containers (its tool containers come and go on their own when idle).
const realSystem = () => ['docshield-dsh-main', 'docshield-egress-proxy'].map(n => `${n}=${docker(['inspect', '-f', '{{.Id}} {{.State.StartedAt}}', n]) ?? 'không chạy'}`).join(' ')
const realBefore = realSystem()
say(`bộ test tấn công — prefix ${P}, commit ${commit}`)
cleanup.call(null); cleaned = false // leftovers of a previous crashed run

// ---------- 2. test data ----------
if (FRESH) {
  say('--fresh: xóa volume thử cũ')
  docker(['volume', 'rm', '-f', ...VOLUMES])
  docker(['network', 'rm', `${P}-tools`, `${P}-egress`])
}
for (const v of VOLUMES) docker(['volume', 'create', v], { allowFail: false })
const SEED = `
set -e
mkdir -p /s/users/${ALICE}/docs /s/users/${BOB}/docs /s/admin/docs /s/public_docs /s/.docshield
printf 'Lịch họp nhóm: thứ Năm, 9 giờ.\\n' > /s/users/${ALICE}/docs/lich.md
printf 'Mã bí mật của bob: BOB-777. Không ai khác được đọc.\\n' > /s/users/${BOB}/docs/bi_mat.md
printf 'Quy chế chung: nộp báo cáo trước thứ Sáu.\\n' > /s/public_docs/quy_che.md
rm -f /s/users/${ALICE}/qua-han-muc.bin
chown -R 1000:1000 /s
find /s/users /s/admin /s/public_docs -type d -exec chmod 750 {} +
find /s/users /s/admin /s/public_docs -type f -exec chmod 640 {} +
`
docker(['run', '--rm', '-v', `${P}-storage:/s`, 'alpine', 'sh', '-c', SEED], { allowFail: false })
// DSH home: settings without any model or key (the attack groups never call the LLM).
const HOME_SEED = `[ -f /h/settings.yaml ] || printf 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nagent-presets:\n  modeSelectionEnabled: false\n  default: docshield-admin-harness\n' > /h/settings.yaml
chown -R 1000:1000 /h /d /g`
docker(['run', '--rm', '-v', `${P}-home:/h`, '-v', `${P}-db:/d`, '-v', `${P}-gate:/g`, 'alpine', 'sh', '-c', HOME_SEED], { allowFail: false })
say('đã dựng dữ liệu thử (alice, bob, admin, public_docs)')
if (WITH_MODEL) {
  const has = docker(['run', '--rm', '-v', `${P}-storage:/s:ro`, 'alpine', 'sh', '-c', 'test -d /s/.docshield/models && echo yes'])
  if (has !== 'yes') {
    say('--with-model: chép mô hình nhúng (~560 MB) từ docshield-storage (chỉ đọc), có thể mất vài phút...')
    const copied = docker(['run', '--rm', '-v', 'docshield-storage:/src:ro', '-v', `${P}-storage:/s`, 'alpine', 'sh', '-c',
      'test -d /src/.docshield/models || { echo none; exit 0; }; cp -a /src/.docshield/models /s/.docshield/ && chown -R 1000:1000 /s/.docshield && du -sh /s/.docshield/models'], { timeout: 10 * 60_000 })
    say(`   mô hình: ${copied ?? 'lỗi khi chép'}`)
  }
}

// ---------- 3. start the test system ----------
say('khởi động hệ thống thử (tool-manager → proxy → dsh-main)...')
manager = spawn(process.execPath, [path.join(ROOT, 'exec-router', 'tool-manager.mjs')], {
  cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, TOOL_PREFIX: P, GATE_PUBLISH: `127.0.0.1:${GATE_PORT}`, TOOL_MANAGER_PORT: String(MANAGER_PORT), TOOL_QUOTA_MB: '20', TOOL_QUOTA_GRACE_S: '0', TOOL_QUOTA_SWEEP_S: '5' },
})
const managerLog = []
const keep = d => { for (const l of String(d).split('\n').filter(Boolean)) { managerLog.push(l); if (managerLog.length > 400) managerLog.shift() } }
manager.stdout.on('data', keep)
manager.stderr.on('data', keep)
manager.on('exit', code => { if (!cleaned) say(`tool-manager đã thoát (mã ${code})`) })
// Ready when the gate answers; give up early if the tool-manager exits or dsh-main stops.
const startState = async () => {
  if (manager.exitCode !== null) return 'tool-manager đã thoát'
  if (docker(['inspect', '-f', '{{.State.Status}}', MAIN]) === 'exited') return `${MAIN} đã dừng`
  return fetch(`${GATE}/gate/login`).then(r => r.status, () => 0)
}
const started = await waitFor(startState, s => s === 200 || typeof s === 'string', 5 * 60_000, 2000, 'gate sẵn sàng').catch(e => e.message)
if (started !== 200) {
  console.error([`Hệ thống thử không khởi động được: ${started}`, '--- log tool-manager ---', ...managerLog.slice(-30),
    `--- log ${MAIN} ---`, docker(['logs', '--tail', '30', MAIN]) ?? '(không có)'].join('\n'))
  throw new Error('hệ thống thử không khởi động được')
}
say('gate đã sẵn sàng')

// Accounts: random passwords, memory only. "add" on the first run, "passwd" when the account already exists.
const passwords = {}
for (const [name, role] of [[ALICE, 'user'], [BOB, 'user'], [ADMIN, 'admin']]) {
  const pw = randomBytes(18).toString('base64url')
  const cli = sub => docker(['exec', '-i', '-e', 'GATE_VAR_DIR=/var/gate', MAIN, 'node', '/opt/plugins/dsh-gate/bin/gate.mjs', 'user', sub, name, ...(sub === 'add' ? ['--role', role] : []), '--password-stdin'], { input: `${pw}\n` })
  if (cli('add') === null && cli('passwd') === null) throw new Error(`không tạo/đặt được mật khẩu cho ${name}`)
  passwords[name] = pw
}
say('đã tạo tài khoản thử (mật khẩu ngẫu nhiên, chỉ trong bộ nhớ)')
// The image may predate the repo's test file: always run the current one.
docker(['cp', path.join(ROOT, 'exec-router', 'test', 'e2e-router.mjs'), `${MAIN}:/opt/plugins/dsh-exec-router/test/e2e-router.mjs`], { allowFail: false })

// Self-test of the crash cleanup: ATK_SELFTEST_CRASH=1 throws here, with the whole system up.
if (process.env.ATK_SELFTEST_CRASH === '1') setTimeout(() => { throw new Error('ATK_SELFTEST_CRASH: lỗi giả lập giữa chừng') }, 0)

// ---------- 4. attack groups ----------
const hostEnv = { ATK_PREFIX: P, ATK_MANAGER_PORT: String(MANAGER_PORT), ATK_GATE_URL: GATE }
await runGroup('Định tuyến & cách ly (trong dsh-main)', DOCKER, inMain('main'))
await runGroup('Hủy luồng dữ liệu (TC12)', DOCKER, inMain('abort'))
await runGroup('Container bị xóa giữa chừng', DOCKER, inMain('kill'))
// Same, but removed from outside with `docker rm -f` while the router holds a live connection.
docker(['exec', MAIN, 'rm', '-f', '/tmp/go'])
await runGroup('docker rm -f từ bên ngoài', DOCKER, inMain('kill-external'), {
  onLine: line => {
    if (line !== 'READY') return
    docker(['rm', '-f', `${P}-tool-u-${ALICE}`])
    docker(['exec', MAIN, 'touch', '/tmp/go'])
  },
})
await runGroup('Internet qua DSH', DOCKER, inMain('egress'))
await runGroup('Internet qua proxy (TC14–16)', process.execPath, [path.join(ROOT, 'exec-router', 'test', 'e2e-egress.mjs')], { env: hostEnv, timeoutMs: 15 * 60_000 })
await runGroup('Gate', process.execPath, [path.join(ROOT, 'test', 'attack', 'gate.mjs')], { env: { ...hostEnv, ATK_PASSWORDS: JSON.stringify(passwords) } })
await runGroup('Docker & tool-manager (TC2, TC3, TC11, TC13)', process.execPath, [path.join(ROOT, 'test', 'attack', 'resources.mjs')], { env: hostEnv })
if (WITH_MODEL) await modelGroup()
// Last: leaves alice blocked until the tool-manager restarts.
await runGroup('Hạn mức đĩa (TC3)', process.execPath, [path.join(ROOT, 'test', 'attack', 'resources.mjs'), '--quota'], { env: hostEnv })

// Unit suites (TC9 lives there: the host-side TOCTOU race against real links).
await runUnits()

// ---------- 5. stop, report ----------
cleanup('xong')
docker(['run', '--rm', '-v', `${P}-storage:/s`, 'alpine', 'rm', '-f', `/s/users/${ALICE}/qua-han-muc.bin`])
const realAfter = realSystem()
record('Hệ thống thật', 'Chức năng', realBefore === realAfter, 'hệ thống thật (docshield-*) không bị đụng tới', realAfter || '(không chạy)')
report()

// ---------- groups implemented here ----------
async function modelGroup() {
  const group = 'Nạp tài liệu (--with-model)'
  say(`▶ ${group}`)
  const ct = `${P}-tool-u-${ALICE}`
  const logs = () => docker(['logs', MAIN]) ?? ''
  const docs = `/data/users/${ALICE}/docs`
  const ensure = await fetch(`http://127.0.0.1:${MANAGER_PORT}/ensure`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tool-secret': docker(['exec', MAIN, 'printenv', 'TOOL_MANAGER_SECRET']) }, body: JSON.stringify({ zone: `user:${ALICE}` }) })
  if (!ensure.ok) return record(group, 'Lỗi', false, 'không bật được container alice')
  const indexed = (doc, version) => waitFor(() => logs(), l => l.includes(`indexed user:${ALICE}/${doc} v${version}`) || l.includes(`indexed user:${ALICE}/${doc}`) && version === undefined, 90_000, 1000, `nạp ${doc}`).then(() => true, () => false)
  const marker = randomBytes(4).toString('hex')
  docker(['exec', ct, 'sh', '-c', `printf 'Mã kiểm thử ${marker}.\\n' > ${docs}/nap-${marker}.md`])
  record(group, 'Nạp tài liệu', await indexed(`nap_${marker}`), 'file mới trong docs/ được nạp')
  docker(['exec', ct, 'sh', '-c', `printf 'bản thay ${marker}\\n' > ${docs}/.tmp-${marker} && mv ${docs}/.tmp-${marker} ${docs}/nap-${marker}.md`])
  record(group, 'Nạp tài liệu', await indexed(`nap_${marker}`, 2), 'file bị thay bằng rename được nạp lại (v2)')
  docker(['exec', ct, 'sh', '-c', `printf 'nối thêm\\n' >> ${docs}/nap-${marker}.md`])
  record(group, 'Nạp tài liệu', await indexed(`nap_${marker}`, 3), 'sửa SAU khi bị rename vẫn được nạp lại (v3)')
  const scopes = docker(['exec', MAIN, 'node', '-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/docshield/docshield.db',{readOnly:true});console.log(JSON.stringify(db.prepare("select distinct scope from documents where filename='bi_mat.md'").all().map(r=>r.scope)))`])
  record(group, 'TC1', scopes === JSON.stringify([`user:${BOB}`]), 'tài liệu bí mật của bob chỉ thuộc phạm vi của bob', scopes)
}

async function runUnits() {
  const vitest = path.join(ROOT, 'docshield', 'node_modules', 'vitest', 'vitest.mjs')
  const unit = (name, cmd, args, cwd, tag = 'Unit') => new Promise(resolve => {
    say(`▶ unit: ${name}`)
    let out = ''
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', code => {
      const clean = out.replace(/\x1b\[[0-9;]*m/g, '')
      const passed = /Tests\s+(\d+) passed/.exec(clean)?.[1] ?? /ℹ pass (\d+)/.exec(clean)?.[1] ?? '?'
      const failed = /(\d+) failed/.exec(clean)?.[1] ?? /ℹ fail (\d+)/.exec(clean)?.[1] ?? '0'
      record('Unit', tag, code === 0, `${name}: ${passed} đạt, ${failed} trượt`, code === 0 ? '' : clean.split('\n').filter(l => /FAIL|✖|not ok/.test(l)).slice(0, 3).join(' | '))
      console.log(`   ${code === 0 ? '✓' : '✗'} ${name}: ${passed} đạt, ${failed} trượt`)
      resolve()
    })
  })
  if (existsSync(vitest)) {
    await unit('docshield (safe-fs: symlink/junction thật + đua 2000 lần)', process.execPath, [vitest, 'run', 'tests/safe-fs.spec.ts'], path.join(ROOT, 'docshield'), 'TC9')
    await unit('docshield (toàn bộ)', process.execPath, [vitest, 'run'], path.join(ROOT, 'docshield'))
  } else {
    record('Unit', 'Lỗi', false, 'chưa cài phụ thuộc docshield (npm install trong docshield/)')
  }
  await unit('gate', process.execPath, ['--test', 'test/*.test.mjs'], path.join(ROOT, 'gate'))
  await unit('exec-router + proxy', process.execPath, ['--test', 'exec-router/test/*.test.mjs', 'container/test/*.test.mjs'], ROOT)
}

function report() {
  const tags = [...new Set([...Object.keys(TC), ...results.map(r => r.tag)])].filter(t => results.some(r => r.tag === t))
  const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const total = results.length
  const ok = results.filter(r => r.ok).length
  const secs = Math.round((Date.now() - t0) / 1000)

  console.log(`\n${'─'.repeat(78)}`)
  for (const t of tags) {
    const rs = results.filter(r => r.tag === t)
    const pass = rs.filter(r => r.ok).length
    console.log(`${pass === rs.length ? '✓' : '✗'} ${t.padEnd(10)} ${`${pass}/${rs.length}`.padStart(6)}  ${TC[t] ?? ''}`)
  }
  console.log(`${'─'.repeat(78)}\n${ok}/${total} kiểm tra đạt · ${Math.floor(secs / 60)} phút ${secs % 60} giây`)

  const lines = [
    `# Kết quả bộ test tấn công`, '',
    `- Thời điểm: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    `- Commit: \`${commit}\``,
    `- Hệ thống thử: prefix \`${P}\` (gate ${GATE}), ${WITH_MODEL ? 'có' : 'không có'} mô hình nhúng`,
    `- **Kết quả: ${ok}/${total} kiểm tra đạt** ${ok === total ? '✅' : '❌'} · thời gian chạy ${Math.floor(secs / 60)} phút ${secs % 60} giây`, '',
    `## Tổng hợp theo kịch bản`, '',
    '| TC | Nội dung | Đạt/Tổng | Kết quả | Mục trượt & chi tiết |', '|---|---|---|---|---|',
    ...tags.map(t => {
      const rs = results.filter(r => r.tag === t)
      const fails = rs.filter(r => !r.ok)
      return `| ${t} | ${esc(TC[t] ?? '')} | ${rs.length - fails.length}/${rs.length} | ${fails.length ? '❌ Trượt' : '✅ Đạt'} | ${esc(fails.map(f => `${f.name}${f.detail ? ` — ${f.detail}` : ''}`).join('; '))} |`
    }),
    '', `## Chi tiết từng kiểm tra`, '',
  ]
  for (const group of [...new Set(results.map(r => r.group))]) {
    lines.push(`### ${group}`, '', '| | TC | Kiểm tra | Chi tiết |', '|---|---|---|---|')
    for (const r of results.filter(x => x.group === group)) lines.push(`| ${r.ok ? '✅' : '❌'} | ${r.tag} | ${esc(r.name)} | ${esc(r.detail)} |`)
    lines.push('')
  }
  lines.push(`## Ngoài phạm vi / rủi ro còn lại`, '',
    '- Tấn công qua chính model (prompt injection trong tài liệu): ranh giới an toàn là sandbox, đã kiểm ở các TC trên; hành vi của model phụ thuộc 9Router, thử tay riêng.',
    '- HTTPS được mã hóa: proxy không đọc nội dung gửi ra, chỉ giới hạn lưu lượng và ghi log tên miền (TC15).',
    '- Agent có thể in mật khẩu proxy của chính vùng mình khi chạy `env`: chỉ dùng được từ mạng nội bộ của vùng đó, đổi mỗi lần khởi động.',
    '- Chế độ tunnel + Docker: gate thấy IP gateway của Docker thay vì IP thật của người dùng.', '')
  if (results.some(r => !r.ok)) lines.push('## 40 dòng log cuối của tool-manager', '', '```', ...managerLog.slice(-40), '```', '')
  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, lines.join('\n'))
  say(`đã ghi báo cáo: ${OUT}`)
  process.exitCode = ok === total ? 0 : 1
}
