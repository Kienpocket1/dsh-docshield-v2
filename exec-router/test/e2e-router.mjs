// End-to-end routing check, run INSIDE dsh-main (real tool-manager, real tool containers):
//   docker exec <prefix>-dsh-main node /opt/plugins/dsh-exec-router/test/e2e-router.mjs [phase]
// It loads the real exec-router plugin and plays sessions the way DSH tools call
// fs / subprocess / sandbox. Users: e2e-alice, e2e-bob (storage prepared by migrate.mjs).
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import * as router from '../src/index.mjs'

const phase = process.argv[2] ?? 'main'
const A = '/data/users/e2e-alice'
const B = '/data/users/e2e-bob'
const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${String(extra).slice(0, 160)})` : ''}`) }
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

try {
  if (phase === 'main') {
    // Each user runs in their own container
    const a = await bash('s-alice', A, 'id -u; hostname; ls /data/users; ls /data')
    const [uid, host, users] = a.out.split('\n')
    check('alice: bash chạy uid 1000 trong container của alice', uid === '1000' && host === 'tool-u-e2e-alice', `${uid} ${host}`)
    check('alice: /data/users chỉ có e2e-alice', users === 'e2e-alice', users)
    const b = await bash('s-bob', B, 'hostname; cat docs/bi_mat.md')
    check('bob: chạy trong container của bob, đọc được file của mình', b.out.startsWith('tool-u-e2e-bob') && b.out.includes('BOB-777'), b.out)

    // Files through fs, Vietnamese name, DocShield auto-index (checked from the host log)
    await write('s-alice', `${A}/docs/Ghi chú họp.md`, 'Ghi chú: buổi họp dời sang thứ Sáu.\n')
    check('alice: ghi/đọc file tên tiếng Việt qua fs', (await read('s-alice', `${A}/docs/Ghi chú họp.md`)).includes('thứ Sáu'))
    check('alice: file ghi qua fs thấy được từ bash cùng container', (await bash('s-alice', A, 'cat "docs/Ghi chú họp.md"')).out.includes('thứ Sáu'))

    // DSH's grep/glob tool: ripgrep at the path DSH itself computes, spawned without confine (tool-fs-search does this)
    const { rgPath } = await import('@vscode/ripgrep')
    as('s-alice')
    const rgProc = ctx.subprocess.spawn({ argv: [rgPath, '--no-config', '-l', 'thứ Sáu', A], cwd: A, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 2000 })
    rgProc.stderr.resume()
    let rgOut = ''
    for await (const c of rgProc.stdout) rgOut += c
    const rgDone = await rgProc.done
    check('grep của DSH (rg theo rgPath của DSH) chạy trong container', rgDone.exitCode === 0 && rgOut.includes('Ghi chú họp.md'), `${rgPath} → ${rgOut.trim()}`)

    // TC1: another user's data through every channel
    check('TC1 fs.resolve file của bob bị từ chối', await refused(() => read('s-alice', `${B}/docs/bi_mat.md`)))
    check('TC1 đường dẫn ../ sang bob: không đọc được', await refused(async () => { as('s-alice'); await ctx.fs.readText(await ctx.fs.resolve('../e2e-bob/docs/bi_mat.md', { cwd: A })) }))
    // DSH walks up from the cwd to "/" looking for project markers and AGENTS.md: those probes must answer "absent", not fail the turn
    as('s-alice')
    const probes = [await ctx.fs.lstat('/data/.git'), await ctx.fs.lstat('/.git'), await ctx.fs.stat(await ctx.fs.resolve('/data/AGENTS.md')), await ctx.fs.lstat('../AGENTS.md', { cwd: A })]
    check('dò .git/AGENTS.md ở thư mục cha: trả về "không có", không lỗi', probes.every(x => x === undefined))
    check('đọc AGENTS.md ngoài vùng: FS_NOT_FOUND', await ctx.fs.readText(await ctx.fs.resolve('/AGENTS.md')).then(() => false, e => e.code === 'FS_NOT_FOUND'))
    check('ghi ngoài vùng vẫn bị từ chối', await refused(async () => { as('s-alice'); await ctx.fs.writeText(await ctx.fs.resolve('/data/x.md'), 'x', undefined, undefined, policy('s-alice', A)) }))
    check('TC1 bash cat file của bob: không tồn tại', (await bash('s-alice', A, `cat ${B}/docs/bi_mat.md 2>&1; true`)).out.includes('No such file'))
    check('TC1 spawn với cwd thư mục bob bị từ chối', await refused(async () => { as('s-alice'); ctx.subprocess.spawn({ argv: ['ls'], cwd: B, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1000 }) }))
    check('TC1 confine với workspaceRoot của bob bị từ chối', await refused(async () => { as('s-alice'); await ctx.sandbox.confine(['ls'], policy('s-alice', B)) }))

    // TC4: links cannot leave the container's view
    await bash('s-alice', A, 'ln -sfn /etc/passwd lien-ket.txt; ln -sfn /data/users lien-ket-dir')
    check('TC4 symlink tới /etc/passwd: fs từ chối (đích ngoài vùng)', await refused(() => read('s-alice', `${A}/lien-ket.txt`)))
    check('TC4 symlink thư mục ra ngoài vùng bị từ chối', await refused(() => read('s-alice', `${A}/lien-ket-dir/e2e-bob/docs/bi_mat.md`)))

    // TC5 / fallback / TC6
    check('TC5 không có phiên: đọc bị từ chối', await refused(() => read(undefined, `${A}/docs/Ghi chú họp.md`)))
    check('TC5 không có phiên: spawn bị từ chối', await refused(async () => { as(undefined); ctx.subprocess.spawn({ argv: ['ls'], cwd: A, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1000 }) }))
    // resolve happens inside the session; the async context is lost before writeText (policy still carries DSH's sessionId)
    as('s-alice')
    const lostTarget = await ctx.fs.resolve(`${A}/docs/du-phong.md`)
    as(undefined)
    await ctx.fs.writeText(lostTarget, 'ghi qua sessionId dự phòng\n', undefined, undefined, policy('s-alice', A))
    check('mất initiator, không có sessionId: ghi bị từ chối', await refused(() => ctx.fs.writeText(lostTarget, 'x', undefined, undefined, policy(undefined, A))))
    check('mất initiator + sessionId của DSH: ghi đúng thư mục alice', (await bash('s-alice', A, 'cat docs/du-phong.md')).out.includes('dự phòng'))
    check('policy.sessionId khác phiên đang chạy bị từ chối', await refused(() => write('s-alice', `${A}/docs/x.md`, 'x', 's-bob')))
    check('TC6 subagent của alice chạy trong container alice', (await bash('s-alice-sub', A, 'hostname')).out === 'tool-u-e2e-alice')
    check('phiên ngoài vùng lưu trữ không chạy được công cụ', await refused(() => bash('s-outside', '/opt/dsh', 'id')))

    // admin-review: everything, read-only, offline
    const r = await bash('s-review', '/data/users', 'hostname; ls /data/users | tr "\\n" " "; touch /data/users/e2e-alice/hack 2>&1; true')
    check('admin-review thấy mọi người dùng', r.out.includes('e2e-alice') && r.out.includes('e2e-bob'), r.out)
    check('admin-review chỉ đọc (touch thất bại)', /Read-only file system/.test(r.out), r.out)
    check('admin-review đọc được file của bob', (await bash('s-review', '/data/users', 'cat e2e-bob/docs/bi_mat.md')).out.includes('BOB-777'))

    // Network from inside a tool container (TC7 and isolation)
    const net = await bash('s-alice', A, `node -e "
      const net=require('net'); const t=(h,p)=>new Promise(r=>{const s=net.connect(p,h);s.on('connect',()=>{s.destroy();r('OPEN')});s.on('error',e=>r(e.code));setTimeout(()=>{s.destroy();r('TIMEOUT')},3000)});
      (async()=>{console.log([await t('1.1.1.1',443), await t('e2e-dsh-main',3444), await t('host.docker.internal',3461), await t('e2e-tool-u-e2e-bob',7000)].join(' '))})()"`)
    const [inet, gate, manager, bobLauncher] = net.out.split(' ')
    check('tool-alice không ra internet', inet !== 'OPEN', inet)
    check('tool-alice không gọi được gate/DSH trên mạng nội bộ', gate !== 'OPEN', gate)
    check('tool-alice không gọi được tool-manager', manager !== 'OPEN', manager)
    const tc7 = await bash('s-alice', A, `node -e "
      const s=require('net').connect(7000,'e2e-tool-u-e2e-bob',()=>s.write(JSON.stringify({token:'0'.repeat(64),kind:'rpc'})+'\\n'));
      let n=0; s.on('data',d=>n+=d.length); s.on('close',()=>console.log('closed '+n)); s.on('error',e=>console.log('err '+e.code)); setTimeout(()=>console.log('open '+n),4000)"`)
    check('TC7 tool-alice vào launcher của bob bằng token đoán: bị đóng, 0 byte', /^(closed 0|err )/.test(tc7.out), `${bobLauncher} / ${tc7.out}`)

    // TC12 / concurrency
    const t0 = Date.now()
    const big = await bash('s-alice', A, 'head -c 20000000 /dev/zero')
    check('TC12 luồng 20 MB xong, không treo', big.size === 20_000_000 && Date.now() - t0 < 30_000, `${big.size} B ${Date.now() - t0} ms`)
    const many = await Promise.all([1, 2, 3, 4, 5].map(i => bash('s-alice', A, `sleep 0.5; echo ${i}`)))
    check('5 lệnh song song trong cùng container', many.map(m => m.out).join(',') === '1,2,3,4,5')
    check("số tiến trình trước fork bomb", true, (await bash("s-alice", A, "ls /proc | grep -c \"^[0-9]\"")).out)
    // 200 background sleeps against --pids-limit 64: bash must hit fork failures and the live count stays under the cap
    const bomb = await bash('s-alice', A, 'ok=0; fail=0; for i in $(seq 1 400); do if sleep 3 2>/dev/null & then ok=$((ok+1)); else fail=$((fail+1)); fi; done 2>/tmp/forkerr; n=$(ls /proc | grep -c "^[0-9]"); echo "$n $(grep -c -i "fork\\|resource" /tmp/forkerr)"; kill $(jobs -p) 2>/dev/null; true')
    const [live, forkErrors] = bomb.out.split(' ').map(Number)
    check('TC3 fork bomb bị chặn bởi pids-limit 256', live <= 256 && forkErrors > 0, `tiến trình sống ${live}, lỗi fork ${forkErrors}`)
  }

  if (phase === 'reconnect') {
    // Run after `docker rm -f e2e-tool-u-e2e-alice` on the host.
    const again = await bash('s-alice', A, 'hostname; cat "docs/Ghi chú họp.md"')
    check('container bị xóa giữa chừng: lệnh sau tự tạo lại và nối lại', again.out.startsWith('tool-u-e2e-alice') && again.out.includes('thứ Sáu'), again.out)
  }
} catch (error) {
  check('không lỗi bất ngờ', false, error.stack ?? error)
} finally {
  for (const f of fibers.reverse()) await f.dispose().catch(() => {})
}
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} đạt`)
process.exit(failed ? 1 : 0)
