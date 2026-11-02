#!/usr/bin/env node
/**
 * tool-manager — runs on the Windows host; the ONLY component allowed to call
 * `docker`. The shared DSH (container dsh-main) asks it for a zone's tool
 * container and gets back {host, token}; it can never pass Docker arguments
 * (TC13): every `docker run` parameter is a constant here, the zone is checked
 * against a strict pattern before anything is built, and processes are
 * spawned with argument arrays, never a shell string (TC2).
 *
 * It also starts dsh-main and the egress proxy itself, each with a fresh secret
 * every run (passed only through the environment), and stops everything when it
 * exits. Tool containers reach the internet only through that proxy
 * (container/egress-proxy.mjs): their network is internal, and they get proxy
 * credentials for their own zone (admin-review gets none: it stays offline).
 *
 *   node exec-router/tool-manager.mjs            start the whole system
 * A zone over its disk quota is blocked; each refused request re-measures it, so once an
 * admin deletes files the next request unblocks it. After a (re)start every zone gets
 * 10 minutes of grace to delete files itself.
 * Environment: TOOL_PREFIX (default "docshield"; e2e uses "e2e"), GATE_PUBLISH (127.0.0.1:3444),
 *   TOOL_MANAGER_PORT (3460), DOCKER_BIN, TOOL_QUOTA_MB (1024), TOOL_IMAGE / MAIN_IMAGE / PROXY_IMAGE
 *   (docshield-tools / docshield-dsh-main / docshield-egress-proxy, tag dev); for tests only:
 *   TOOL_QUOTA_GRACE_S (600) and TOOL_QUOTA_SWEEP_S (60).
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { promisify } from 'node:util'
import { proxyUser, zoneToken } from '../container/egress-proxy.mjs'

const run = promisify(execFile)
const DOCKER = process.env.DOCKER_BIN ?? (existsSync('E:/Docker/DockerDesktop/resources/bin/docker.exe') ? 'E:/Docker/DockerDesktop/resources/bin/docker.exe' : 'docker')
const P = process.env.TOOL_PREFIX ?? 'docshield'
if (!/^[a-z][a-z0-9-]{1,20}$/.test(P)) throw new Error('TOOL_PREFIX không hợp lệ')
const PORT = Number(process.env.TOOL_MANAGER_PORT ?? 3460)
const PUBLISH = process.env.GATE_PUBLISH ?? '127.0.0.1:3444'
const QUOTA = Number(process.env.TOOL_QUOTA_MB ?? 1024) * 1024 * 1024
const QUOTA_GRACE_MS = Number(process.env.TOOL_QUOTA_GRACE_S ?? 600) * 1000
const QUOTA_SWEEP_MS = Math.max(1, Number(process.env.TOOL_QUOTA_SWEEP_S ?? 60)) * 1000
const IMAGE_TOOLS = process.env.TOOL_IMAGE ?? 'docshield-tools:dev'
const IMAGE_MAIN = process.env.MAIN_IMAGE ?? 'docshield-dsh-main:dev'
const IMAGE_PROXY = process.env.PROXY_IMAGE ?? 'docshield-egress-proxy:dev'
const NET_TOOLS = `${P}-tools`
const VOL = { storage: `${P}-storage`, home: `${P}-home`, db: `${P}-db`, gate: `${P}-gate` }
const MAIN = `${P}-dsh-main`
const NET_EGRESS = `${P}-egress`
const VOL_EGRESS = `${P}-egress-log`
const PROXY = `${P}-egress-proxy`
/** Proxy secret of this run; tool containers get HMAC(secret, zone) as their proxy password. */
let egressSecret = ''

export const ZONE = /^(user:[a-z0-9][a-z0-9_-]{2,31}|admin|admin-review)$/

/** Container name and mounts for a zone; only ever called with a zone that matched ZONE. */
export function zoneSpec(zone) {
  if (!ZONE.test(zone)) throw new Error('zone không hợp lệ')
  const sub = (src, dst, ro = false) => ['--mount', `type=volume,src=${VOL.storage},dst=${dst},volume-subpath=${src}${ro ? ',readonly' : ''}`]
  if (zone === 'admin') return { name: `${P}-tool-admin`, mounts: [...sub('admin', '/data/admin'), ...sub('public_docs', '/data/public_docs')], root: '/data/admin' }
  if (zone === 'admin-review') return { name: `${P}-tool-review`, mounts: sub('users', '/data/users', true), root: '/data/users' }
  const user = zone.slice(5)
  return { name: `${P}-tool-u-${user}`, mounts: sub(`users/${user}`, `/data/users/${user}`), root: `/data/users/${user}` }
}

/**
 * Proxy settings of a zone's tool container: curl, python, npm and (with NODE_USE_ENV_PROXY)
 * Node's fetch follow them. Not a security boundary on its own: the container's network is
 * internal, so without the proxy there is no way out at all. admin-review stays offline.
 */
export function proxyEnv(zone, proxyPassword) {
  if (zone === 'admin-review') return []
  if (!/^[0-9a-f]{64}$/.test(proxyPassword ?? '')) throw new Error('mật khẩu proxy không hợp lệ')
  const url = `http://${proxyUser(zone)}:${proxyPassword}@egress-proxy:3128`
  return [...['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].flatMap(name => ['-e', `${name}=${url}`]), '-e', 'NODE_USE_ENV_PROXY=1']
}

/** Every `docker run` argument for a tool container. Constants only, plus the validated zone spec, a fresh token and the zone's proxy password. */
export function toolRunArgs(zone, token, proxyPassword) {
  const spec = zoneSpec(zone)
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('token không hợp lệ')
  const proxy = proxyEnv(zone, proxyPassword)
  return ['run', '-d', '--rm', '--name', spec.name, '--hostname', spec.name.slice(P.length + 1),
    '--network', NET_TOOLS, '--network-alias', spec.name,
    '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=64m,mode=1777', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    // --init reaps orphaned zombies; the pids cap counts threads (each node process has ~7-10), so 256 still stops fork bombs.
    '--init', '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '256',
    '--label', `${P}.role=tool`, '-e', `LAUNCHER_TOKEN=${token}`, ...proxy,
    ...spec.mounts, IMAGE_TOOLS]
}

const docker = (args, opts = {}) => run(DOCKER, args, { windowsHide: true, maxBuffer: 1 << 20, ...opts })
const safeEqual = (a, b) => { const x = Buffer.from(String(a ?? '')); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }

async function ensureInfra() {
  const nets = (await docker(['network', 'ls', '--format', '{{.Name}}'])).stdout.split(/\r?\n/)
  if (!nets.includes(NET_TOOLS)) await docker(['network', 'create', '--internal', NET_TOOLS])
  // The proxy's own way out: an ordinary bridge that no other container joins.
  if (!nets.includes(NET_EGRESS)) await docker(['network', 'create', NET_EGRESS])
  for (const v of [...Object.values(VOL), VOL_EGRESS]) await docker(['volume', 'create', v])
}

async function removeLeftovers() {
  const names = (await docker(['ps', '-a', '--filter', `label=${P}.role`, '--format', '{{.Names}}'])).stdout.split(/\r?\n/).filter(Boolean)
  if (names.length) await docker(['rm', '-f', ...names]).catch(() => {})
  return names
}

/** zone → { token, name } of running tool containers. */
const running = new Map()
/** zone → until (ms) of quota grace; zones in `blocked` are refused. */
const blocked = new Set()
const grace = new Map()

/**
 * Run jobs of the same key one after another. Two overlapping ensure/release calls for
 * one zone (a UI file probe and a prompt) would otherwise remove each other's container.
 */
export function keyedQueue() {
  const tails = new Map()
  return (key, job) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(job, job)
    const tail = run.then(() => {}, () => {})
    tails.set(key, tail)
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
    return run
  }
}
const inZone = keyedQueue()

/** Bytes used by a zone, measured in a throwaway offline container with read-only mounts; NaN on failure. */
async function measure(zone) {
  const { mounts, root } = zoneSpec(zone)
  const ro = mounts.map(m => m.startsWith('type=') && !m.endsWith(',readonly') ? `${m},readonly` : m)
  const out = await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
    '--label', `${P}.role=measure`, '--entrypoint', 'du', ...ro, IMAGE_TOOLS, '-sb', root]).then(r => r.stdout, () => '')
  return Number(out.split(/\s/)[0])
}

async function ensure(zone) {
  if (blocked.has(zone)) {
    // ponytail: one throwaway container per refused request; cache the result if blocked users hammer it.
    const bytes = await measure(zone)
    if (!(bytes <= QUOTA)) throw Object.assign(new Error('Thư mục đã vượt hạn mức dung lượng; hãy liên hệ admin.'), { status: 403 })
    blocked.delete(zone)
    log(`${zone} đã về dưới hạn mức (${Math.round(bytes / 1048576)} MB): gỡ chặn`)
  }
  const current = running.get(zone)
  if (current) {
    const state = await docker(['inspect', '-f', '{{.State.Running}}', current.name]).then(r => r.stdout.trim(), () => 'false')
    if (state === 'true') return current
    running.delete(zone)
  }
  const { name } = zoneSpec(zone)
  await docker(['rm', '-f', name]).catch(() => {})
  const token = randomBytes(32).toString('hex')
  await docker(toolRunArgs(zone, token, zone === 'admin-review' ? undefined : zoneToken(egressSecret, zone)))
  const entry = { name, token }
  running.set(zone, entry)
  if (!grace.has(zone)) grace.set(zone, Date.now() + QUOTA_GRACE_MS)
  log(`bật ${name} cho ${zone}`)
  return entry
}

async function release(zone) {
  const entry = running.get(zone)
  running.delete(zone)
  if (entry) { await docker(['rm', '-f', entry.name]).catch(() => {}); log(`tắt ${entry.name}`) }
}

async function quotaSweep() {
  for (const [zone, entry] of running) {
    if (zone === 'admin-review') continue
    const { root } = zoneSpec(zone)
    const out = await docker(['exec', entry.name, 'du', '-sb', root]).then(r => r.stdout, () => '')
    const bytes = Number(out.split(/\s/)[0])
    if (!Number.isFinite(bytes) || bytes <= QUOTA) continue
    if ((grace.get(zone) ?? 0) > Date.now()) continue
    blocked.add(zone)
    await inZone(zone, () => release(zone))
    log(`${zone} vượt hạn mức (${Math.round(bytes / 1048576)} MB > ${QUOTA / 1048576} MB): đã chặn`)
  }
}

function log(msg) { console.log(`${new Date().toISOString().slice(11, 19)} tool-manager: ${msg}`) }

/** The egress proxy: on its own bridge, reachable from the tools network as "egress-proxy". */
async function startProxy() {
  await docker(['rm', '-f', PROXY]).catch(() => {})
  await docker(['run', '-d', '--name', PROXY, '--label', `${P}.role=proxy`, '--network', NET_EGRESS,
    '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--init', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64',
    '-e', `EGRESS_SECRET=${egressSecret}`, '-e', 'EGRESS_LOG=/var/egress/egress.jsonl', '-v', `${VOL_EGRESS}:/var/egress`,
    IMAGE_PROXY])
  await docker(['network', 'connect', '--alias', 'egress-proxy', NET_TOOLS, PROXY])
  return spawn(DOCKER, ['logs', '-f', PROXY], { stdio: 'inherit', windowsHide: true })
}

/**
 * Behind a local tunnel (start-gate.cmd … tunnel sets GATE_TRUST_PROXY=1) the gate should believe
 * CF-Connecting-IP — but only from the address the tunnel's connections arrive from. That address
 * (Docker Desktop's NAT for the published port) is measured, not guessed: dsh-main gets a one-time
 * token and calibrate() presents it over the published port. Only when the port is published on
 * loopback: then every connection on it comes from this machine. Published to the LAN, other
 * machines arrive through the same NAT address and could forge the header, so trust stays off.
 * @returns {{ args: string[], warn?: string }}
 */
export function trustEnv(publish, env, token) {
  if (env.GATE_TRUST_PROXY !== '1') return { args: [] }
  if (!/^127\.0\.0\.1:\d+$/.test(publish)) {
    return { args: [], warn: `GATE_TRUST_PROXY bị bỏ qua: gate mở ra mạng (${publish}), máy khác có thể giả IP; mọi người sẽ chung một IP trong nhật ký và khóa đăng nhập.` }
  }
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('token đo không hợp lệ')
  return { args: ['-e', 'GATE_TRUST_PROXY=1', '-e', `GATE_CALIBRATION_TOKEN=${token}`] }
}

/** Present the calibration token over the published port once the gate answers (background, ≤ 3 min). */
async function calibrate(token) {
  const url = `http://${PUBLISH}/gate/calibrate`
  const deadline = Date.now() + 3 * 60_000
  while (Date.now() < deadline) {
    const status = await fetch(url, { method: 'POST', headers: { 'x-gate-calibration': token } }).then(r => r.status, () => 0)
    if (status === 204) return log('gate đã nhận địa chỉ của tunnel: IP thật của người dùng được ghi đúng')
    if (status === 403 || status === 404) return log(`không đo được địa chỉ tunnel (HTTP ${status}): gate KHÔNG tin header IP`)
    await new Promise(r => setTimeout(r, 1000))
  }
  log('không đo được địa chỉ tunnel (gate chưa sẵn sàng sau 3 phút): gate KHÔNG tin header IP')
}

async function startMain(secret) {
  await docker(['rm', '-f', MAIN]).catch(() => {})
  const bridgeSubnet = (await docker(['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Subnet}}'])).stdout.trim()
  const calibrationToken = randomBytes(32).toString('hex')
  const trust = trustEnv(PUBLISH, process.env, calibrationToken)
  if (trust.warn) log(trust.warn)
  await docker(['run', '-d', '--name', MAIN, '--label', `${P}.role=main`,
    '--network', 'bridge', '-p', `${PUBLISH}:3444`, '--add-host', 'host.docker.internal:host-gateway',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-e', `TOOL_MANAGER_URL=http://host.docker.internal:${PORT}`, '-e', `TOOL_MANAGER_SECRET=${secret}`,
    '-e', `GATE_BIND_SUBNET=${bridgeSubnet}`, '-e', 'GATE_EGRESS_LOG=/var/egress/egress.jsonl', '-v', `${VOL_EGRESS}:/var/egress:ro`,
    ...trust.args,
    '-v', `${VOL.storage}:/data`, '-v', `${VOL.home}:/home/dsh`, '-v', `${VOL.db}:/var/docshield`, '-v', `${VOL.gate}:/var/gate`,
    IMAGE_MAIN])
  await docker(['network', 'connect', NET_TOOLS, MAIN])
  const logs = spawn(DOCKER, ['logs', '-f', MAIN], { stdio: 'inherit', windowsHide: true })
  if (trust.args.length) void calibrate(calibrationToken)
  return logs
}

async function serve() {
  const secret = randomBytes(32).toString('hex')
  await ensureInfra()
  const left = await removeLeftovers()
  if (left.length) log(`đã dọn container sót: ${left.join(', ')}`)
  const server = http.createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method !== 'POST' || !safeEqual(req.headers['x-tool-secret'], secret)) return reply(403, { error: 'forbidden' })
    let raw = ''
    req.on('data', c => { raw += c; if (raw.length > 1024) req.destroy() })
    req.on('end', async () => {
      let zone
      try { zone = JSON.parse(raw).zone } catch { return reply(400, { error: 'bad request' }) }
      if (typeof zone !== 'string' || !ZONE.test(zone)) return reply(400, { error: 'zone không hợp lệ' })
      try {
        if (req.url === '/ensure') { const e = await inZone(zone, () => ensure(zone)); return reply(200, { host: e.name, token: e.token }) }
        if (req.url === '/release') { await inZone(zone, () => release(zone)); return reply(200, {}) }
        reply(404, { error: 'not found' })
      } catch (err) {
        reply(err.status ?? 500, { error: err.message })
      }
    })
  })
  await new Promise(r => server.listen(PORT, '127.0.0.1', r))
  log(`nghe 127.0.0.1:${PORT}; mạng công cụ ${NET_TOOLS}; volumes ${Object.values(VOL).join(', ')}`)
  egressSecret = randomBytes(32).toString('hex')
  const proxyLogs = await startProxy()
  log(`đã bật ${PROXY} (internet cho container công cụ)`)
  const logs = await startMain(secret)
  log(`đã bật ${MAIN}; đăng nhập tại http://${PUBLISH}`)
  // One sweep at a time: with many containers (or a short test interval) `du` may outlast the interval.
  let sweeping = false
  const sweep = setInterval(() => {
    if (sweeping) return
    sweeping = true
    quotaSweep().catch(e => log(`quota: ${e.message}`)).finally(() => { sweeping = false })
  }, QUOTA_SWEEP_MS)
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    clearInterval(sweep)
    log('đang tắt...')
    logs.kill()
    proxyLogs.kill()
    await removeLeftovers().catch(() => {})
    server.close()
    process.exit(0)
  }
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, shutdown)
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('exec-router/tool-manager.mjs')) {
  serve().catch(err => { console.error(`tool-manager: ${err.stack ?? err}`); process.exit(1) })
}
