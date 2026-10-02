// Gate end-to-end against the real shared DSH behind the gate (run by test/attack/run.mjs).
//   ATK_GATE_URL=http://127.0.0.1:3448 ATK_PREFIX=atk ATK_PASSWORDS='{"atk-alice":"…",…}' node test/attack/gate.mjs
// Passwords come only from the environment (generated per run by run.mjs); nothing is stored.
// Result lines: `PASS|FAIL  [TAG] description  (detail)`.
import net from 'node:net'
import { OP, createDecoder, encodeFrame } from '../../gate/src/ws.mjs'

const GATE = process.env.ATK_GATE_URL ?? 'http://127.0.0.1:3448'
const { hostname: HOST, port: PORT } = new URL(GATE)
const P = process.env.ATK_PREFIX ?? 'atk'
const ALICE = `${P}-alice`
const BOB = `${P}-bob`
const ADMIN = `${P}-admin`
const passwords = JSON.parse(process.env.ATK_PASSWORDS ?? '{}')
const results = []
const check = (tag, name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  [${tag}] ${name}${extra ? `  (${String(extra).replace(/\s+/g, ' ').slice(0, 160)})` : ''}`) }

async function login(user, password = passwords[user]) {
  const page = await fetch(`${GATE}/gate/login`)
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1]
  const csrfCookie = page.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('gate_csrf='))
  const res = await fetch(`${GATE}/gate/login`, { method: 'POST', redirect: 'manual', headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: user, password, csrf, next: '/' }) })
  return res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('gate_session='))
}

async function api(cookie, method, args) {
  const res = await fetch(`${GATE}/api/${method}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'x', method, payload: { args } }) })
  const text = await res.text()
  try { return { status: res.status, ...JSON.parse(text) } } catch { return { status: res.status, text } }
}

function mux(cookie, frames, ms = 1500) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(PORT), HOST)
    const got = []
    let open = false
    let buf = Buffer.alloc(0)
    const feed = createDecoder(({ opcode, data }) => { if (opcode === OP.TEXT) got.push(JSON.parse(data.toString())) }, reject)
    s.on('connect', () => s.write(`GET /api/remote.mux HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nOrigin: ${GATE}\r\nCookie: ${cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`))
    s.on('data', chunk => {
      if (open) return feed(chunk)
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      if (!/^HTTP\/1\.1 101/.test(buf.subarray(0, end).toString())) { s.destroy(); return resolve([{ handshake: buf.subarray(0, end).toString().split('\r\n')[0] }]) }
      open = true
      if (buf.length > end + 4) feed(buf.subarray(end + 4))
      for (const f of frames) s.write(encodeFrame(OP.TEXT, JSON.stringify(f), { mask: true }))
      setTimeout(() => { s.destroy(); resolve(got) }, ms)
    })
    s.on('error', reject)
  })
}
const ownPath = (p, user) => new RegExp(`users[\\\\/]${user}$`, 'i').test(p ?? '')

try {
  const alice = await login(ALICE)
  const bob = await login(BOB)
  const admin = await login(ADMIN)
  check('Gate', '3 tài khoản đăng nhập được', Boolean(alice && bob && admin))
  check('Gate', 'sai mật khẩu: không đăng nhập được', (await login(ALICE, 'sai-mat-khau-hoan-toan')) === undefined)

  const index = await fetch(`${GATE}/`, { headers: { cookie: alice } })
  const html = await index.text()
  check('Gate', 'alice mở được giao diện DSH (có thanh tài khoản)', index.status === 200 && /Đăng xuất/.test(html))
  check('Gate', 'không lộ cookie DSH ra trình duyệt', !index.headers.getSetCookie().some(c => c.startsWith('dsh-auth')))

  // Workspaces via the mux (as the UI does).
  const baseline = frames => frames.find(f => f.streamId === 'w' && f.value?.type === 'baseline')?.value.value
  const follow = { type: 'open', streamId: 'w', endpoint: 'workspace/follow', payload: { args: {} } }
  const baselineA = baseline(await mux(alice, [follow]))
  check('TC1', 'alice chỉ thấy workspace của mình', baselineA?.items.length === 1 && ownPath(baselineA.items[0].path, ALICE), baselineA?.items.map(w => w.path).join(', '))
  const bobWs = baseline(await mux(bob, [follow]))?.items[0]
  const baselineAd = baseline(await mux(admin, [follow]))
  check('Admin', 'admin thấy mọi workspace (alice, bob, admin, xem dữ liệu người dùng)', (baselineAd?.items.length ?? 0) >= 4, baselineAd?.items.map(w => w.path.split(/[\\/]/).slice(-2).join('/')).join(', '))
  const aliceWsId = baselineA.items[0].workspaceId

  // Sessions.
  const createdA = await api(alice, 'session/create', { request: { workspaceId: aliceWsId } })
  const aliceSession = createdA.result?.value?.sessionId
  check('Chức năng', 'alice tạo phiên trong workspace của mình', createdA.result?.ok === true, aliceSession)
  const createdB = await api(bob, 'session/create', { request: { workspaceId: bobWs.workspaceId } })
  const bobSession = createdB.result?.value?.sessionId
  check('Chức năng', 'bob tạo phiên trong workspace của mình', createdB.result?.ok === true)
  check('TC1', 'alice không tạo được phiên trong workspace của bob', (await api(alice, 'session/create', { request: { workspaceId: bobWs.workspaceId } })).result?.ok === false)
  check('TC1', 'alice không tạo được phiên với cwd giả (thư mục bob)', (await api(alice, 'session/create', { request: { cwd: `/data/users/${BOB}` } })).result?.ok === false)
  check('TC1', 'alice không tạo được phiên ở thư mục ngoài', (await api(alice, 'session/create', { request: { cwd: '/etc' } })).result?.ok === false)

  const listA = await api(alice, 'session/list', { _request: {} })
  const itemsA = listA.result?.value?.items ?? []
  check('TC1', 'session/list của alice chỉ có phiên trong thư mục alice', listA.result?.ok && itemsA.some(s => s.sessionId === aliceSession) && !itemsA.some(s => s.sessionId === bobSession) && itemsA.every(s => ownPath(s.cwd, ALICE)), itemsA.map(s => s.cwd?.split(/[\\/]/).slice(-2).join('/')).join(', '))
  const listAd = await api(admin, 'session/list', { _request: {} })
  check('Admin', 'admin thấy cả phiên của alice và bob', [aliceSession, bobSession].every(id => listAd.result?.value?.items.some(s => s.sessionId === id)))

  check('TC1', 'alice không đổi tên được phiên của bob', (await api(alice, 'session/rename', { request: { sessionId: bobSession, title: 'hack' } })).result?.ok === false)
  check('TC1', 'alice không gửi được tin nhắn vào phiên của bob', (await api(alice, 'session/prompt', { request: { requestId: 'q1', sessionId: bobSession, mode: 'queue', content: [{ type: 'text', text: 'hi' }] } })).result?.ok === false)
  check('Chức năng', 'alice đổi tên được phiên của mình', (await api(alice, 'session/rename', { request: { sessionId: aliceSession, title: 'Phiên của alice' } })).result?.ok === true)

  const frames = await mux(alice, [
    { type: 'open', streamId: 'mine', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: aliceSession } } } } },
    { type: 'open', streamId: 'theirs', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: bobSession } } } } },
    { type: 'open', streamId: 'ctl', endpoint: 'session/control', payload: { args: {} } },
  ])
  check('Chức năng', 'alice theo dõi được phiên của mình', frames.some(f => f.streamId === 'mine' && f.value?.type === 'snapshot'))
  check('TC1', 'alice không theo dõi được phiên của bob', frames.some(f => f.streamId === 'theirs' && f.type === 'error') && !frames.some(f => f.streamId === 'theirs' && f.type === 'item'))
  const ctl = frames.find(f => f.streamId === 'ctl' && f.value?.type === 'baseline')?.value.value
  check('TC1', 'session/control của alice không chứa phiên của bob', ctl !== undefined && !(bobSession in (ctl.jobs ?? {})) && !(bobSession in (ctl.projections ?? {})))

  check('Gate', 'alice không dùng được quản lý plugin', (await api(alice, 'pluginManager/list', {})).result?.ok === false)
  check('Gate', 'alice không mở được terminal', (await api(alice, 'terminal/create', { agentId: aliceSession })).result?.ok === false)
  check('Gate', 'alice không ghi được cài đặt', (await api(alice, 'settings/update', {})).result?.ok === false)
  const bobDir = baselineAd.items.find(w => ownPath(w.path, BOB)).path
  for (const p of [`${bobDir}/docs/bi_mat.md`, `/data/users/${ALICE}/../${BOB}/docs/bi_mat.md`]) {
    check('TC1', `alice không đọc được file của bob qua /api/file (${p.includes('..') ? '../' : 'trực tiếp'})`, (await fetch(`${GATE}/api/file?path=${encodeURIComponent(p)}`, { headers: { cookie: alice } })).status === 403)
  }
  check('Gate', 'alice không vào được trang quản trị', (await fetch(`${GATE}/gate/admin`, { headers: { cookie: alice }, redirect: 'manual' })).status === 403)
  const adminPage = await (await fetch(`${GATE}/gate/admin`, { headers: { cookie: admin } })).text()
  check('TC15', 'trang quản trị có bảng truy cập internet', /Truy cập internet/.test(adminPage))
  check('Gate', 'chưa đăng nhập: API bị chặn', (await api('', 'session/list', { _request: {} })).status === 401)
  check('Gate', 'cookie giả: API bị chặn', (await api('gate_session=gia.mao.hoan.toan', 'session/list', { _request: {} })).status === 401)
} catch (error) {
  check('Lỗi', 'không lỗi bất ngờ', false, error.stack ?? error)
}

const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} đạt`)
process.exitCode = failed ? 1 : 0
