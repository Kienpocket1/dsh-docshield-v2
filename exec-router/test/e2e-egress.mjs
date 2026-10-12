// Step 4 end-to-end, run on the HOST against a running test system (TOOL_PREFIX=e2e):
//   node exec-router/test/e2e-egress.mjs [prefix=e2e] [managerPort=3461]   (or ATK_PREFIX / ATK_MANAGER_PORT)
// Result lines: `PASS|FAIL  [TAG] description  (detail)` (test/attack/run.mjs groups them by TAG).
// Asks the tool-manager for the alice / admin / admin-review containers, then runs
// curl, python and node inside them: public sites work through the proxy; internal
// addresses, other ports, IPv6 and odd IPv4 spellings are refused; no proxy = no way out;
// limits cut big uploads; admin-review stays offline. Needs internet on the host.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const P = process.argv[2] ?? process.env.ATK_PREFIX ?? 'e2e'
const PORT = Number(process.argv[3] ?? process.env.ATK_MANAGER_PORT ?? 3461)
const ALICE = `${P}-alice`
const DOCKER = existsSync('E:/Docker/DockerDesktop/resources/bin/docker.exe') ? 'E:/Docker/DockerDesktop/resources/bin/docker.exe' : 'docker'
const docker = (args, input) => {
  try { return { out: execFileSync(DOCKER, args, { encoding: 'utf8', windowsHide: true, input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 }), code: 0 } }
  catch (e) { return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 } }
}
const results = []
const check = (tag, name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  [${tag}] ${name}${extra ? `  (${String(extra).replace(/\s+/g, ' ').slice(0, 160)})` : ''}`) }

const secret = docker(['exec', `${P}-dsh-main`, 'printenv', 'TOOL_MANAGER_SECRET']).out.trim()
async function ensure(zone) {
  const res = await fetch(`http://127.0.0.1:${PORT}/ensure`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tool-secret': secret }, body: JSON.stringify({ zone }) })
  if (!res.ok) throw new Error(`ensure ${zone}: ${res.status}`)
  return (await res.json()).host
}
const sh = (ct, script) => docker(['exec', ct, 'bash', '-c', script])
/** HTTP status through the proxy: the target's, or the proxy's answer to CONNECT when no tunnel opened (000 = nothing). */
const status = (ct, args) => {
  const [code, connect] = sh(ct, `curl -s -o /dev/null -w '%{http_code} %{http_connect}' -m 20 ${args}`).out.trim().split(' ')
  return code !== '000' ? code : connect ?? '000'
}
const proxyLog = () => docker(['exec', `${P}-egress-proxy`, 'cat', '/var/egress/egress.jsonl']).out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))

const alice = await ensure(`user:${ALICE}`)
const admin = await ensure('admin')
const review = await ensure('admin-review')
await new Promise(r => setTimeout(r, 1500))

// Works
check('Chức năng', 'alice: curl https://example.com qua proxy', status(alice, 'https://example.com') === '200')
check('Chức năng', 'alice: curl http://example.com (cổng 80) qua proxy', status(alice, 'http://example.com') === '200')
const py = sh(alice, `python3 -c "import urllib.request; print(urllib.request.urlopen('https://example.com', timeout=20).status)"`)
check('Chức năng', 'alice: python urllib qua proxy', py.out.trim() === '200', py.out)
const nodeFetch = sh(alice, `node -e "fetch('https://example.com').then(r => console.log(r.status), e => console.log('ERR', e.cause?.code ?? e.message))"`)
check('Chức năng', 'alice: node fetch qua proxy (NODE_USE_ENV_PROXY)', nodeFetch.out.trim() === '200', nodeFetch.out)
check('Chức năng', 'admin: curl https://example.com', status(admin, 'https://example.com') === '200')

// Refused by the proxy (403), never reaching the target
for (const [label, target] of [
  ['9Router trên máy host', 'http://host.docker.internal:20128/'],
  ['host.docker.internal cổng 80', 'http://host.docker.internal/'],
  ['192.168.65.254 (Docker Desktop)', 'http://192.168.65.254/'],
  ['172.17.0.1 (gateway Docker)', 'http://172.17.0.1/'],
  ['10.0.0.1', 'http://10.0.0.1/'],
  ['169.254.169.254 (metadata)', 'http://169.254.169.254/'],
  [`${P}-dsh-main theo tên`, `http://${P}-dsh-main/`],
  ['localhost', 'http://localhost/'],
  ['127.0.0.1.nip.io (tên trỏ về loopback)', 'http://127.0.0.1.nip.io/'],
  ['[::1] (IPv6)', 'http://[::1]/'],
  ['2130706433 (127.0.0.1 dạng số)', 'http://2130706433/'],
  ['0x7f.1', 'http://0x7f.1/'],
  ['cổng 8080', 'http://example.com:8080/'],
  ['HTTPS cổng 8443', 'https://example.com:8443/'],
]) {
  const code = status(alice, target)
  check(/^(HTTPS )?cổng/.test(label) ? 'TC16' : 'TC14', `alice: chặn ${label}`, code === '403' || code === '400' || code === '502', code)
}
const ssh = sh(alice, 'curl -s -m 10 -p -x "$HTTPS_PROXY" telnet://example.com:22 -o /dev/null -w "%{http_connect}" </dev/null; echo')
check('TC16', 'alice: CONNECT cổng 22 bị chặn (403)', ssh.out.trim() === '403', ssh.out)

// No proxy, wrong credentials, another zone's name
const direct = sh(alice, 'env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.com; echo " exit=$?"')
check('TC14', 'alice: bỏ proxy thì không ra được mạng', !direct.out.startsWith('200'), direct.out)
check('TC15', 'alice: sai mật khẩu proxy → 407', status(alice, `-x http://user.${ALICE}:${'0'.repeat(64)}@egress-proxy:3128 https://example.com`) === '407')
const asBob = sh(alice, `pw=$(printf %s "$HTTPS_PROXY" | sed -E 's#^http://[^:]+:([0-9a-f]+)@.*#\\1#'); curl -s -o /dev/null -w '%{http_connect}' -m 20 -x "http://user.${P}-bob:$pw@egress-proxy:3128" https://example.com`)
check('TC15', 'alice: dùng mật khẩu của mình với tên bob → 407', asBob.out.trim().endsWith('407'), asBob.out)

// admin-review: no proxy settings and no route
const reviewEnv = sh(review, 'env | grep -ci proxy; true')
check('Admin', 'admin-review: không có biến proxy', reviewEnv.out.trim() === '0', reviewEnv.out)
const reviewNet = sh(review, 'curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.com; echo " exit=$?"')
check('Admin', 'admin-review: không ra được internet', !reviewNet.out.startsWith('200'), reviewNet.out)
check('Admin', 'admin-review: không dùng được proxy kể cả tự đặt', status(review, '-x http://admin-review:x@egress-proxy:3128 https://example.com') === '407')

// No caps (DEFAULT_LIMITS): an 8 MB POST goes through, nothing is cut for budget
const up = sh(alice, 'head -c 8000000 /dev/zero > /tmp/big && curl -s -m 60 -o /dev/null -w "%{http_code}" -X POST --data-binary @/tmp/big https://httpbin.org/post; echo " exit=$?"; rm -f /tmp/big')
const cut = proxyLog().filter(e => e.zone === `user:${ALICE}` && /-limit$/.test(e.deny ?? ''))
check('TC15', 'alice: POST 8 MB không bị cắt (không hạn mức)', cut.length === 0, `${up.out} | cắt=${cut.length}`)

// No connection rate cap: a burst of 75 gets no 429; admin is not affected
const burst = sh(alice, 'for i in $(seq 1 75); do curl -s -o /dev/null -w "%{http_code}/%{http_connect} " -m 20 -I https://example.com; done')
const codes = burst.out.trim().split(/\s+/)
check('TC16', 'alice: 75 kết nối/phút không bị 429 (không hạn mức)', !codes.some(c => c.endsWith('/429')), `${codes.filter(c => c.startsWith('200')).length} lần 200`)
check('TC16', 'admin vẫn dùng được sau loạt kết nối của alice', status(admin, '-I https://example.com') === '200')

// Log content
const log = proxyLog()
check('TC15', 'log có truy cập thành công của alice', log.some(e => e.zone === `user:${ALICE}` && e.status === 200 && e.host === 'example.com'))
check('TC14', 'log ghi lý do chặn địa chỉ nội bộ', log.some(e => e.deny?.startsWith('private-ip')))
check('TC15', 'log không chứa mật khẩu proxy', !JSON.stringify(log).match(/[0-9a-f]{64}/))

const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} đạt`)
process.exit(failed ? 1 : 0)
