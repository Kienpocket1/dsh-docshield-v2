// Docker-level attack checks, run on the HOST by test/attack/run.mjs against the test system:
//   ATK_PREFIX=atk ATK_MANAGER_PORT=3462 ATK_GATE_URL=http://127.0.0.1:3448 node test/attack/resources.mjs [--quota]
// TC2 (arguments smuggled into docker), TC3 (limits, disk quota), TC11 (no Windows bind mounts),
// TC13 (who may drive the tool-manager). `--quota` runs the disk-quota attack, which leaves the
// zone blocked until the tool-manager restarts: run it last. It needs TOOL_QUOTA_MB=20,
// TOOL_QUOTA_GRACE_S=0 and a short TOOL_QUOTA_SWEEP_S on the tool-manager.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const P = process.env.ATK_PREFIX ?? 'atk'
const PORT = Number(process.env.ATK_MANAGER_PORT ?? 3462)
const GATE = process.env.ATK_GATE_URL ?? 'http://127.0.0.1:3448'
const MANAGER = `http://127.0.0.1:${PORT}`
const ALICE = `${P}-alice`
const BOB = `${P}-bob`
const DOCKER = existsSync('E:/Docker/DockerDesktop/resources/bin/docker.exe') ? 'E:/Docker/DockerDesktop/resources/bin/docker.exe' : 'docker'
const docker = (args, input) => {
  try { return { out: execFileSync(DOCKER, args, { encoding: 'utf8', windowsHide: true, input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 }).trim(), code: 0 } }
  catch (e) { return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim(), code: e.status ?? 1 } }
}
const results = []
const check = (tag, name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  [${tag}] ${name}${extra ? `  (${String(extra).replace(/\s+/g, ' ').slice(0, 160)})` : ''}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
/** Poll `probe` (sync or async) every `everyMs` until `done(value)` or `timeoutMs`; returns the last value. */
async function waitFor(probe, done, timeoutMs, everyMs = 1000) {
  const t0 = Date.now()
  let value = await probe()
  while (!done(value) && Date.now() - t0 < timeoutMs) { await sleep(everyMs); value = await probe() }
  return value
}

const secret = docker(['exec', `${P}-dsh-main`, 'printenv', 'TOOL_MANAGER_SECRET']).out
async function manager(path, body, headers = { 'x-tool-secret': secret }, method = 'POST') {
  try {
    const res = await fetch(`${MANAGER}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  } catch (e) {
    return { status: 0, body: { error: e.cause?.code ?? e.message } }
  }
}
const toolContainers = () => docker(['ps', '-a', '--filter', `label=${P}.role=tool`, '--format', '{{.Names}}']).out.split('\n').filter(Boolean).sort()
const running = name => docker(['inspect', '-f', '{{.State.Running}}', name]).out === 'true'

try {
  if (!process.argv.includes('--quota')) {
    // TC13: only dsh-main, with this run's secret, may drive the tool-manager; only /ensure and /release exist.
    check('TC13', 'tool-manager: thiếu secret → 403', (await manager('/ensure', { zone: `user:${ALICE}` }, {})).status === 403)
    check('TC13', 'tool-manager: sai secret → 403', (await manager('/ensure', { zone: `user:${ALICE}` }, { 'x-tool-secret': 'f'.repeat(64) })).status === 403)
    check('TC13', 'tool-manager: GET → 403', (await manager('/ensure', null, { 'x-tool-secret': secret }, 'GET')).status === 403)
    check('TC13', 'tool-manager: đường khác (/run, /exec) → 404', (await manager('/run', { zone: `user:${ALICE}` })).status === 404 && (await manager('/exec', { zone: 'admin' })).status === 404)
    const huge = await manager('/ensure', JSON.stringify({ zone: `user:${ALICE}`, pad: 'x'.repeat(4096) }))
    check('TC13', 'tool-manager: thân request quá lớn bị cắt', huge.status !== 200, `${huge.status} ${JSON.stringify(huge.body)}`)

    // TC2: zones that would smuggle arguments are refused before any docker call; no container appears.
    const before = toolContainers()
    const bad = ['user:a;rm -rf /', 'user:../../etc', 'user:alice --privileged', 'user:Alice', 'user:al', 'user:alice\n', '--privileged', 'admin ', 'root', 'user:$(id)', 'user:alice -v /:/host']
    const answers = []
    for (const zone of bad) answers.push((await manager('/ensure', { zone })).status)
    check('TC2', `tool-manager: ${bad.length} zone chứa tham số lạ đều bị từ chối (400)`, answers.every(s => s === 400), answers.join(','))
    check('TC2', 'không container mới nào được tạo từ các zone lạ', JSON.stringify(toolContainers()) === JSON.stringify(before), toolContainers().join(' '))
    // The same from inside dsh-main (the only legitimate caller), as a compromised DSH would try.
    const fromMain = docker(['exec', `${P}-dsh-main`, 'node', '-e',
      "fetch(process.env.TOOL_MANAGER_URL + '/ensure', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tool-secret': process.env.TOOL_MANAGER_SECRET }, body: JSON.stringify({ zone: 'user:x;docker run --privileged' }) }).then(r => console.log(r.status), e => console.log('ERR ' + e.message))"]).out
    check('TC2', 'từ trong dsh-main (DSH bị chiếm): zone lạ vẫn bị từ chối', fromMain === '400', fromMain)

    // TC3: limits really applied to a tool container (and the proxy).
    const ensured = await manager('/ensure', { zone: `user:${ALICE}` })
    const ct = ensured.body.host
    const hc = JSON.parse(docker(['inspect', '-f', '{{json .HostConfig}}', ct]).out || '{}')
    const user = docker(['inspect', '-f', '{{.Config.User}}', ct]).out
    const limits = { NanoCpus: hc.NanoCpus, Memory: hc.Memory, MemorySwap: hc.MemorySwap, PidsLimit: hc.PidsLimit, ReadonlyRootfs: hc.ReadonlyRootfs, CapDrop: hc.CapDrop, SecurityOpt: hc.SecurityOpt, Privileged: hc.Privileged, User: user, Network: hc.NetworkMode }
    check('TC3', 'container công cụ: CPU 0,5 / RAM 256 MB không swap / pids 256', hc.NanoCpus === 5e8 && hc.Memory === 256 * 1048576 && hc.MemorySwap === 256 * 1048576 && hc.PidsLimit === 256, JSON.stringify(limits))
    check('TC3', 'container công cụ: rootfs chỉ đọc, bỏ mọi capability, no-new-privileges, uid 1000, không privileged',
      hc.ReadonlyRootfs === true && hc.CapDrop?.includes('ALL') && hc.SecurityOpt?.some(o => o.startsWith('no-new-privileges')) && user === '1000:1000' && hc.Privileged === false, JSON.stringify(limits))
    check('TC7', `container công cụ chỉ ở mạng nội bộ ${P}-tools`, hc.NetworkMode === `${P}-tools`, hc.NetworkMode)
    // TC7, strongest attacker: full code execution in alice's container (docker exec, outside the agent sandbox),
    // holding alice's REAL launcher token, still gets nothing from bob's launcher.
    const bobCt = (await manager('/ensure', { zone: `user:${BOB}` })).body.host
    const lateral = docker(['exec', ct, 'node', '-e', `
      const s = require('net').connect(7000, '${bobCt}', () => s.write(JSON.stringify({ token: process.env.LAUNCHER_TOKEN, kind: 'rpc' }) + '\\n'))
      let n = 0; s.on('data', d => n += d.length); s.on('close', () => console.log('closed ' + n)); s.on('error', e => console.log('err ' + e.code)); setTimeout(() => console.log('open ' + n), 4000)`]).out
    check('TC7', 'kẻ có toàn quyền trong container alice, dùng token THẬT của alice vào launcher bob: bị đóng, 0 byte', /^(closed 0|err )/.test(lateral), lateral)
    const proxyHc = JSON.parse(docker(['inspect', '-f', '{{json .HostConfig}}', `${P}-egress-proxy`]).out || '{}')
    check('TC16', 'proxy: RAM 128 MB, CPU 0,5, rootfs chỉ đọc, bỏ mọi capability', proxyHc.Memory === 128 * 1048576 && proxyHc.NanoCpus === 5e8 && proxyHc.ReadonlyRootfs === true && proxyHc.CapDrop?.includes('ALL'))
    const mainHc = JSON.parse(docker(['inspect', '-f', '{{json .HostConfig}}', `${P}-dsh-main`]).out || '{}')
    check('TC13', 'dsh-main: không gắn Docker socket, không privileged, bỏ mọi capability',
      !JSON.stringify(mainHc.Binds ?? []).includes('docker.sock') && mainHc.Privileged === false && mainHc.CapDrop?.includes('ALL'))

    // TC11: no container shares a Windows folder; every mount is a Docker (ext4) volume. The DB lives on one.
    const names = docker(['ps', '--filter', `label=${P}.role`, '--format', '{{.Names}}']).out.split('\n').filter(Boolean)
    const mounts = names.map(n => [n, JSON.parse(docker(['inspect', '-f', '{{json .Mounts}}', n]).out || '[]')])
    const binds = mounts.flatMap(([n, ms]) => ms.filter(m => m.Type !== 'volume' && m.Type !== 'tmpfs').map(m => `${n}:${m.Type}:${m.Source}`))
    check('TC11', `${names.length} container: không có bind mount từ ổ Windows`, names.length >= 3 && binds.length === 0, binds.join(' ') || names.join(' '))
    const dbMount = mounts.find(([n]) => n === `${P}-dsh-main`)?.[1].find(m => m.Destination === '/var/docshield')
    check('TC11', 'DB DocShield nằm trên volume Docker (ext4), không trên NTFS', dbMount?.Type === 'volume' && dbMount.Name === `${P}-db`, JSON.stringify(dbMount))

    // Without the embedding model the agent's writes to docs/ must not take the system down.
    check('Chức năng', 'dsh-main vẫn chạy sau các bài tấn công', running(`${P}-dsh-main`))
    check('Chức năng', 'gate vẫn đáp sau các bài tấn công', (await fetch(`${GATE}/gate/login`).then(r => r.status, () => 0)) === 200)
  } else {
    // TC3 disk quota: alice writes past her 20 MB → the sweep stops her container, ensure refuses her, bob is unaffected.
    const b = await manager('/ensure', { zone: `user:${BOB}` })
    const a = await manager('/ensure', { zone: `user:${ALICE}` })
    const aliceCt = a.body.host
    check('TC3', 'trước khi ghi: container alice chạy', a.status === 200 && running(aliceCt), a.status)
    const fill = docker(['exec', aliceCt, 'sh', '-c', `head -c 31457280 /dev/zero > /data/users/${ALICE}/qua-han-muc.bin && du -sm /data/users/${ALICE} | cut -f1`])
    check('TC3', 'alice ghi 30 MB (hạn mức thử 20 MB)', Number(fill.out) >= 30, fill.out)
    const t0 = Date.now()
    const stillUp = await waitFor(() => running(aliceCt), up => !up, 45_000)
    check('TC3', 'vượt hạn mức: container alice bị dừng (polling)', !stillUp, `${Math.round((Date.now() - t0) / 1000)} s`)
    const again = await manager('/ensure', { zone: `user:${ALICE}` })
    check('TC3', 'vượt hạn mức: tool-manager từ chối alice (403) kèm thông báo', again.status === 403 && /hạn mức/.test(again.body.error ?? ''), `${again.status} ${again.body.error ?? ''}`)
    const bobOk = await manager('/ensure', { zone: `user:${BOB}` })
    check('TC3', 'bob không bị ảnh hưởng', bobOk.status === 200 && docker(['exec', bobOk.body.host, 'echo', 'ok']).out === 'ok', b.status)
  }
} catch (error) {
  check('Lỗi', 'không lỗi bất ngờ', false, error.stack ?? error)
}

const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} đạt`)
process.exitCode = failed ? 1 : 0
