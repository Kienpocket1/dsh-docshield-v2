// End-to-end routing check, run INSIDE dsh-main (real tool-manager, real tool containers):
//   docker exec [-e ATK_PREFIX=atk] <prefix>-dsh-main node /opt/plugins/dsh-exec-router/test/e2e-router.mjs [phase]
// It loads the real exec-router plugin and plays sessions the way DSH tools call
// fs / subprocess / sandbox. Users <prefix>-alice and <prefix>-bob (bob owns docs/bi_mat.md with BOB-777).
// Every result line is `PASS|FAIL  [TAG] description  (detail)`; test/attack/run.mjs groups them by TAG.
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import * as router from '../src/index.mjs'

const phase = process.argv[2] ?? 'main'
const P = process.env.ATK_PREFIX ?? 'e2e'
const ALICE = `${P}-alice`
const BOB = `${P}-bob`
const A = `/data/users/${ALICE}`
const B = `/data/users/${BOB}`
const HOST_A = `tool-u-${ALICE}`
const MANAGER_PORT = new URL(process.env.TOOL_MANAGER_URL ?? 'http://host.docker.internal:3461').port
const results = []
const check = (tag, name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  [${tag}] ${name}${extra ? `  (${String(extra).replace(/\s+/g, ' ').slice(0, 160)})` : ''}`) }
const refused = async fn => { try { await fn(); return false } catch (e) { return /sandbox|phiên|vùng|Đường dẫn|không/i.test(e.message) || e.name === 'ZoneError' } }

const sessions = new Map([
  ['s-alice', { id: 's-alice', header: { cwd: A } }],
  ['s-alice-sub', { id: 's-alice-sub', header: { cwd: A, parentSession: 's-alice', origin: 'subagent' } }],
  ['s-bob', { id: 's-bob', header: { cwd: B } }],
  ['s-review', { id: 's-review', header: { cwd: '/data/users' } }],
  ['s-outside', { id: 's-outside', header: { cwd: '/opt/dsh' } }],
])
let current
const ctx = new Context()
ctx.provide('agents', { currentInitiator: () => (current ? { session: current } : undefined) })
ctx.provide('sessions', { get: id => sessions.get(id) })
const fibers = [await ctx.plugin(SessionProjectionRegistry), await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/data' })]
fibers.push(await ctx.plugin(router, { idleMinutes: 15 }))

const as = id => { current = id === undefined ? undefined : sessions.get(id) }
const policy = (id, root) => ({ mode: 'workspace-write', workspaceRoot: root, ...(id ? { sessionId: id } : {}) })
async function bash(id, root, command, { limit = 1 << 20, policyId = id } = {}) {
  as(id)
  const confined = await ctx.sandbox.confine(['bash', '-c', command], policy(policyId, root))
  const proc = ctx.subprocess.spawn({ argv: confined.argv, cwd: root, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 2000 })
  const out = []; const err = []; let size = 0
  proc.stderr.on('data', c => err.push(c))
  for await (const c of proc.stdout) { size += c.length; if (size <= limit) out.push(c) }
  const outcome = await proc.done
  return { out: Buffer.concat(out).toString('utf8').trim(), err: Buffer.concat(err).toString('utf8').trim(), size, code: outcome.exitCode }
}
const write = async (id, file, text, policyId = id) => {
  as(id)
  const t = await ctx.fs.resolve(file)
  return ctx.fs.writeText(t, text, undefined, undefined, policy(policyId, file.split('/').slice(0, 4).join('/')))
}
const read = async (id, file) => { as(id); return ctx.fs.readText(await ctx.fs.resolve(file)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
/** Poll `probe` until `done(value)`; returns the last value seen. */
async function waitFor(probe, done, timeoutMs, everyMs = 500) {
  const t0 = Date.now()
  let value = await probe()
  while (!done(value) && Date.now() - t0 < timeoutMs) { await sleep(everyMs); value = await probe() }
  return value
}

try {
  if (phase === 'main') {
    // Each user runs in their own container
    const a = await bash('s-alice', A, 'id -u; hostname; ls /data/users; ls /data')
    const [uid, host, users] = a.out.split('\n')
    check('TC1', 'alice: bash chạy uid 1000 trong container của alice', uid === '1000' && host === HOST_A, `${uid} ${host}`)
    check('TC1', `alice: /data/users chỉ có ${ALICE}`, users === ALICE, users)
    const b = await bash('s-bob', B, 'hostname; cat docs/bi_mat.md')
    check('Chức năng', 'bob: chạy trong container của bob, đọc được file của mình', b.out.startsWith(`tool-u-${BOB}`) && b.out.includes('BOB-777'), b.out)

    // Files through fs, Vietnamese name
    await write('s-alice', `${A}/docs/Ghi chú họp.md`, 'Ghi chú: buổi họp dời sang thứ Sáu.\n')
    check('TC10', 'alice: ghi/đọc file tên tiếng Việt qua fs', (await read('s-alice', `${A}/docs/Ghi chú họp.md`)).includes('thứ Sáu'))
    check('Chức năng', 'alice: file ghi qua fs thấy được từ bash cùng container', (await bash('s-alice', A, 'cat "docs/Ghi chú họp.md"')).out.includes('thứ Sáu'))

    // DSH's grep/glob tool: ripgrep at the path DSH itself computes, spawned without confine (tool-fs-search does this)
    const { rgPath } = await import('@vscode/ripgrep')
    as('s-alice')
    const rgProc = ctx.subprocess.spawn({ argv: [rgPath, '--no-config', '-l', 'thứ Sáu', A], cwd: A, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 2000 })
    rgProc.stderr.resume()
    let rgOut = ''
    for await (const c of rgProc.stdout) rgOut += c
    const rgDone = await rgProc.done
    check('TC8', 'grep của DSH (rg theo rgPath của DSH) chạy trong container', rgDone.exitCode === 0 && rgOut.includes('Ghi chú họp.md'), `${rgPath} → ${rgOut.trim()}`)
    as('s-alice')
    // Every real directory of the container, following links (/proc, /sys, /dev are pseudo-files that never end).
    const roots = ['/data', '/tmp', '/opt', '/etc', '/var', '/home', '/root', '/usr', '/srv', '/mnt']
    const rgAll = ctx.subprocess.spawn({ argv: [rgPath, '--no-config', '-L', '-l', '--no-messages', 'BOB-777', ...roots], cwd: A, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 2000, signal: AbortSignal.timeout(60_000) })
    rgAll.stderr.resume()
    let rgLeak = ''
    try { for await (const c of rgAll.stdout) rgLeak += c } catch { /* timed out */ }
    const rgAllDone = await rgAll.done.catch(e => ({ error: e.message }))
    check('TC8', 'rg -L quét mọi thư mục của container từ phiên alice: không thấy BOB-777', !rgLeak.includes('BOB-777') && !rgLeak.includes(BOB) && rgAllDone.signal == null, `${rgLeak.trim().slice(0, 100)} ${JSON.stringify(rgAllDone)}`)

    // TC1: another user's data through every channel
    check('TC1', 'fs.resolve file của bob bị từ chối', await refused(() => read('s-alice', `${B}/docs/bi_mat.md`)))
    check('TC1', 'đường dẫn ../ sang bob: không đọc được', await refused(async () => { as('s-alice'); await ctx.fs.readText(await ctx.fs.resolve(`../${BOB}/docs/bi_mat.md`, { cwd: A })) }))
    // DSH walks up from the cwd to "/" looking for project markers and AGENTS.md: those probes must answer "absent", not fail the turn
    as('s-alice')
    const probes = [await ctx.fs.lstat('/data/.git'), await ctx.fs.lstat('/.git'), await ctx.fs.stat(await ctx.fs.resolve('/data/AGENTS.md')), await ctx.fs.lstat('../AGENTS.md', { cwd: A })]
    check('Chức năng', 'dò .git/AGENTS.md ở thư mục cha: trả về "không có", không lỗi', probes.every(x => x === undefined))
    check('TC1', 'đọc AGENTS.md ngoài vùng: FS_NOT_FOUND', await ctx.fs.readText(await ctx.fs.resolve('/AGENTS.md')).then(() => false, e => e.code === 'FS_NOT_FOUND'))
    check('TC1', 'ghi ngoài vùng bị từ chối', await refused(async () => { as('s-alice'); await ctx.fs.writeText(await ctx.fs.resolve('/data/x.md'), 'x', undefined, undefined, policy('s-alice', A)) }))
    check('TC1', 'bash cat file của bob: không tồn tại', (await bash('s-alice', A, `cat ${B}/docs/bi_mat.md 2>&1; true`)).out.includes('No such file'))
    check('TC1', 'spawn với cwd thư mục bob bị từ chối', await refused(async () => { as('s-alice'); ctx.subprocess.spawn({ argv: ['ls'], cwd: B, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1000 }) }))
    check('TC1', 'confine với workspaceRoot của bob bị từ chối', await refused(async () => { as('s-alice'); await ctx.sandbox.confine(['ls'], policy('s-alice', B)) }))
    check('TC1', 'phiên ngoài vùng lưu trữ không chạy được công cụ', await refused(() => bash('s-outside', '/opt/dsh', 'id')))

    // TC4: links cannot leave the container's view
    await bash('s-alice', A, 'ln -sfn /etc/passwd lien-ket.txt; ln -sfn /data/users lien-ket-dir')
    check('TC4', 'symlink tới /etc/passwd: fs từ chối (đích ngoài vùng)', await refused(() => read('s-alice', `${A}/lien-ket.txt`)))
    check('TC4', 'symlink thư mục ra ngoài vùng bị từ chối', await refused(() => read('s-alice', `${A}/lien-ket-dir/${BOB}/docs/bi_mat.md`)))
    const viaBash = await bash('s-alice', A, `cat lien-ket-dir/${BOB}/docs/bi_mat.md 2>&1; true`)
    check('TC4', 'bash qua symlink thư mục: không thấy dữ liệu bob', !viaBash.out.includes('BOB-777'), viaBash.out)
    await bash('s-alice', A, 'rm -f lien-ket.txt lien-ket-dir')

    // TC5 / fallback / TC6
    check('TC5', 'không có phiên: đọc bị từ chối', await refused(() => read(undefined, `${A}/docs/Ghi chú họp.md`)))
    check('TC5', 'không có phiên: spawn bị từ chối', await refused(async () => { as(undefined); ctx.subprocess.spawn({ argv: ['ls'], cwd: A, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1000 }) }))
    // resolve happens inside the session; the async context is lost before writeText (policy still carries DSH's sessionId)
    as('s-alice')
    const lostTarget = await ctx.fs.resolve(`${A}/docs/du-phong.md`)
    as(undefined)
    await ctx.fs.writeText(lostTarget, 'ghi qua sessionId dự phòng\n', undefined, undefined, policy('s-alice', A))
    check('TC5', 'mất initiator, không có sessionId: ghi bị từ chối', await refused(() => ctx.fs.writeText(lostTarget, 'x', undefined, undefined, policy(undefined, A))))
    check('TC5', 'mất initiator + sessionId của DSH: ghi đúng thư mục alice', (await bash('s-alice', A, 'cat docs/du-phong.md')).out.includes('dự phòng'))
    check('TC5', 'policy.sessionId khác phiên đang chạy bị từ chối', await refused(() => write('s-alice', `${A}/docs/x.md`, 'x', 's-bob')))
    check('TC6', 'subagent của alice chạy trong container alice', (await bash('s-alice-sub', A, 'hostname')).out === HOST_A)

    // admin-review: everything, read-only, offline
    const r = await bash('s-review', '/data/users', `hostname; ls /data/users | tr "\\n" " "; touch /data/users/${ALICE}/hack 2>&1; true`)
    check('Admin', 'admin-review thấy mọi người dùng', r.out.includes(ALICE) && r.out.includes(BOB), r.out)
    check('Admin', 'admin-review chỉ đọc (touch thất bại)', /Read-only file system/.test(r.out), r.out)
    check('Admin', 'admin-review đọc được file của bob', (await bash('s-review', '/data/users', `cat ${BOB}/docs/bi_mat.md`)).out.includes('BOB-777'))

    // Network from inside a tool container (TC7 and isolation)
    const net = await bash('s-alice', A, `node -e "
      const net=require('net'); const t=(h,p)=>new Promise(r=>{const s=net.connect(p,h);s.on('connect',()=>{s.destroy();r('OPEN')});s.on('error',e=>r(e.code));setTimeout(()=>{s.destroy();r('TIMEOUT')},3000)});
      (async()=>{console.log([await t('1.1.1.1',443), await t('${P}-dsh-main',3444), await t('host.docker.internal',${MANAGER_PORT}), await t('${P}-tool-u-${BOB}',7000)].join(' '))})()"`)
    const [inet, gate, manager, bobLauncher] = net.out.split(' ')
    check('TC14', 'tool-alice không tự ra internet (không qua proxy)', inet !== 'OPEN', inet)
    check('TC7', 'tool-alice không gọi được gate/DSH trên mạng nội bộ', gate !== 'OPEN', gate)
    check('TC13', 'tool-alice không gọi được tool-manager', manager !== 'OPEN', manager)
    const launcherProbe = token => bash('s-alice', A, `node -e "
      const s=require('net').connect(7000,'${P}-tool-u-${BOB}',()=>s.write(JSON.stringify({token:'${token}',kind:'rpc'})+'\\n'));
      let n=0; s.on('data',d=>n+=d.length); s.on('close',()=>console.log('closed '+n)); s.on('error',e=>console.log('err '+e.code)); setTimeout(()=>console.log('open '+n),4000)"`)
    const guessed = await launcherProbe('0'.repeat(64))
    check('TC7', 'tool-alice vào launcher của bob bằng token đoán: bị đóng, 0 byte', /^(closed 0|err )/.test(guessed.out), `${bobLauncher} / ${guessed.out}`)
    // The agent's shell (sandboxed) cannot even read its own launcher's token from /proc.
    // (Using alice's real token at bob's launcher is tested from the host: test/attack/resources.mjs.)
    const own = (await bash('s-alice', A, 'for p in /proc/[0-9]*; do tr "\\0" "\\n" < $p/environ 2>/dev/null | grep -m1 "^LAUNCHER_TOKEN=" && break; done | cut -d= -f2; env | grep -c LAUNCHER_TOKEN; true')).out
    check('TC7', 'bash của agent không đọc được token launcher (env đã lọc, /proc bị sandbox chặn)', own === '0', own.replace(/[0-9a-f]{64}/g, '<token>'))

    // TC12 / concurrency / TC3
    const t0 = Date.now()
    const big = await bash('s-alice', A, 'head -c 20000000 /dev/zero')
    check('TC12', 'luồng 20 MB xong, không treo', big.size === 20_000_000 && Date.now() - t0 < 30_000, `${big.size} B ${Date.now() - t0} ms`)
    const many = await Promise.all([1, 2, 3, 4, 5].map(i => bash('s-alice', A, `sleep 0.5; echo ${i}`)))
    check('Chức năng', '5 lệnh song song trong cùng container', many.map(m => m.out).join(',') === '1,2,3,4,5')
    // 400 background sleeps against --pids-limit 256: bash must hit fork failures and the live count stays under the cap
    const bomb = await bash('s-alice', A, 'ok=0; fail=0; for i in $(seq 1 400); do if sleep 3 2>/dev/null & then ok=$((ok+1)); else fail=$((fail+1)); fi; done 2>/tmp/forkerr; n=$(ls /proc | grep -c "^[0-9]"); echo "$n $(grep -c -i "fork\\|resource" /tmp/forkerr)"; kill $(jobs -p) 2>/dev/null; true')
    const [live, forkErrors] = bomb.out.split(' ').map(Number)
    check('TC3', 'fork bomb bị chặn bởi pids-limit 256', live <= 256 && forkErrors > 0, `tiến trình sống ${live}, lỗi fork ${forkErrors}`)
    await sleep(3500)
    // Memory bomb: python asks for 400 MB in a 256 MB container → killed (137) or MemoryError; the container keeps working
    const mem = await bash('s-alice', A, 'python3 -c "b = bytearray(400 * 1024 * 1024); print(len(b))" >/dev/null 2>/tmp/memerr; echo "exit=$? $(tail -c 80 /tmp/memerr | tr "\\n" " ")"')
    check('TC3', 'bom RAM 400 MB bị chặn (OOM 137 hoặc MemoryError)', /exit=137|MemoryError/.test(mem.out), mem.out)
    check('TC3', 'sau bom RAM, lệnh kế tiếp chạy bình thường', (await bash('s-alice', A, 'echo ok')).out === 'ok')
  }

  if (phase === 'abort') {
    // TC12: an endless stream cut by the caller. The process in the container must really stop,
    // and neither this router host nor the container may be left stuck or swollen.
    const rssBefore = process.memoryUsage().rss
    as('s-alice')
    const controller = new AbortController()
    const confined = await ctx.sandbox.confine(['bash', '-c', 'cat /dev/zero'], policy('s-alice', A))
    const proc = ctx.subprocess.spawn({ argv: confined.argv, cwd: A, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 2000, signal: controller.signal })
    proc.stderr.resume()
    let got = 0
    try {
      for await (const c of proc.stdout) { got += c.length; if (got >= 50 * 1024 * 1024) { controller.abort(); proc.terminate(); break } }
    } catch { /* the aborted stream may end with an error */ }
    const outcome = await Promise.race([proc.done.then(o => o, e => ({ error: e.message })), sleep(15_000).then(() => 'TIMEOUT')])
    check('TC12', 'cat /dev/zero bị hủy sau ~50 MB: lệnh kết thúc (không treo)', outcome !== 'TIMEOUT' && got >= 50 * 1024 * 1024, `${Math.round(got / 1048576)} MB, kết thúc: ${JSON.stringify(outcome)}`)
    check('TC12', 'kết thúc bằng tín hiệu/hủy, không phải thoát bình thường', outcome !== 'TIMEOUT' && (outcome.signal != null || outcome.error !== undefined || (outcome.exitCode ?? 0) !== 0), JSON.stringify(outcome))
    // No pgrep in the slim image: count live processes whose command line starts with "cat /dev/zero" (this probe's own starts with bash).
    const left = await waitFor(() => bash('s-alice', A, 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done | grep -c "^cat /dev/zero" || true').then(r => r.out), out => out === '0', 10_000)
    check('TC12', 'tiến trình cat trong container thật sự đã dừng', left === '0', `còn ${left}`)
    check('TC12', 'lệnh kế tiếp trong container chạy được', (await bash('s-alice', A, 'echo ok')).out === 'ok')
    global.gc?.()
    const grown = Math.round((process.memoryUsage().rss - rssBefore) / 1048576)
    check('TC12', 'RAM tiến trình chạy router không phình (< +200 MB)', grown < 200, `+${grown} MB`)
  }

  if (phase === 'egress') {
    // The agent's real path (DSH bash tool → router → helper): the container's proxy settings must survive DSH's env scrubbing.
    const a = await bash('s-alice', A, 'printf "%s\\n" "${HTTPS_PROXY%%:*}"; curl -s -o /dev/null -w "%{http_code}" -m 20 https://example.com')
    const [scheme, code] = a.out.split('\n')
    check('TC14', 'alice qua DSH: bash thấy HTTPS_PROXY', scheme === 'http', a.out)
    check('Chức năng', 'alice qua DSH: curl https://example.com = 200', code === '200', a.out)
    const r = await bash('s-review', '/data/users', 'curl -s -o /dev/null -w "%{http_code}" -m 10 https://example.com; echo " $?"')
    check('Admin', 'admin-review qua DSH: không có internet', !r.out.startsWith('200'), r.out)
  }

  if (phase === 'kill') {
    // Same process: a live connection, then the container is removed (as `docker rm -f` would), then
    // the very next calls must reconnect to the freshly started container without failing (manual test D).
    check('Phục hồi', 'trước khi xóa: nối được', (await bash('s-alice', A, 'hostname')).out === HOST_A)
    const res = await fetch(`${process.env.TOOL_MANAGER_URL}/release`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tool-secret': process.env.TOOL_MANAGER_SECRET }, body: JSON.stringify({ zone: `user:${ALICE}` }),
    })
    check('Phục hồi', 'đã xóa container alice qua tool-manager', res.ok)
    await sleep(1500)
    const t0 = Date.now()
    check('Phục hồi', 'đọc file ngay sau khi xóa: tự tạo lại, không lỗi', (await read('s-alice', `${A}/docs/Ghi chú họp.md`)).includes('thứ Sáu'), `${Date.now() - t0} ms`)
    check('Phục hồi', 'bash sau khi xóa chạy bình thường', (await bash('s-alice', A, 'hostname')).out === HOST_A)
  }

  if (phase === 'kill-external') {
    // Same process; the host runs `docker rm -f <alice tool container>` and then creates /tmp/go.
    check('Phục hồi', 'trước khi xóa: nối được', (await bash('s-alice', A, 'hostname')).out === HOST_A)
    console.log('READY')
    const { existsSync } = await import('node:fs')
    while (!existsSync('/tmp/go')) await sleep(200)
    const t0 = Date.now()
    let first
    try { first = await read('s-alice', `${A}/docs/Ghi chú họp.md`) } catch (e) { first = `LỖI ${e.message}` }
    check('Phục hồi', 'đọc file ngay sau docker rm -f: không lỗi', first.includes('thứ Sáu'), `${first.slice(0, 80)} ${Date.now() - t0} ms`)
    check('Phục hồi', 'bash sau docker rm -f chạy bình thường', (await bash('s-alice', A, 'hostname')).out === HOST_A)
  }

  if (phase === 'reconnect') {
    // Run after `docker rm -f <prefix>-tool-u-<prefix>-alice` on the host.
    const again = await bash('s-alice', A, 'hostname; cat "docs/Ghi chú họp.md"')
    check('Phục hồi', 'container bị xóa giữa chừng: lệnh sau tự tạo lại và nối lại', again.out.startsWith(HOST_A) && again.out.includes('thứ Sáu'), again.out)
  }
} catch (error) {
  check('Lỗi', 'không lỗi bất ngờ', false, error.stack ?? error)
} finally {
  for (const f of fibers.reverse()) await f.dispose().catch(() => {})
}
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} đạt`)
process.exit(failed ? 1 : 0)
