#!/usr/bin/env node
/**
 * tool-manager — runs on the Windows host; the ONLY component allowed to call
 * `docker`. The shared DSH (container dsh-main) asks it for a zone's tool
 * container and gets back {host, token}; it can never pass Docker arguments
 * (TC13): every `docker run` parameter is a constant here, the zone is checked
 * against a strict pattern before anything is built, and processes are
 * spawned with argument arrays, never a shell string (TC2).
 *
 * It also starts dsh-main itself, with a fresh secret every run (passed only
 * through the environment), and stops everything when it exits.
 *
 *   node exec-router/tool-manager.mjs            start the whole system
 * A zone over its disk quota is blocked until tool-manager restarts; after a
 * (re)start every zone gets 10 minutes of grace to delete files.
 * Environment: TOOL_PREFIX (default "docshield"; e2e uses "e2e"), GATE_PUBLISH (127.0.0.1:3444),
 *   TOOL_MANAGER_PORT (3460), DOCKER_BIN, TOOL_QUOTA_MB (1024).
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { promisify } from 'node:util'

const run = promisify(execFile)
const DOCKER = process.env.DOCKER_BIN ?? (existsSync('E:/Docker/DockerDesktop/resources/bin/docker.exe') ? 'E:/Docker/DockerDesktop/resources/bin/docker.exe' : 'docker')
const P = process.env.TOOL_PREFIX ?? 'docshield'
if (!/^[a-z][a-z0-9-]{1,20}$/.test(P)) throw new Error('TOOL_PREFIX không hợp lệ')
const PORT = Number(process.env.TOOL_MANAGER_PORT ?? 3460)
const PUBLISH = process.env.GATE_PUBLISH ?? '127.0.0.1:3444'
const QUOTA = Number(process.env.TOOL_QUOTA_MB ?? 1024) * 1024 * 1024
const IMAGE_TOOLS = process.env.TOOL_IMAGE ?? 'docshield-tools:dev'
const IMAGE_MAIN = process.env.MAIN_IMAGE ?? 'docshield-dsh-main:dev'
const NET_TOOLS = `${P}-tools`
const VOL = { storage: `${P}-storage`, home: `${P}-home`, db: `${P}-db`, gate: `${P}-gate` }
const MAIN = `${P}-dsh-main`

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

/** Every `docker run` argument for a tool container. Constants only, plus the validated zone spec and a fresh token. */
export function toolRunArgs(zone, token) {
  const spec = zoneSpec(zone)
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('token không hợp lệ')
  return ['run', '-d', '--rm', '--name', spec.name, '--hostname', spec.name.slice(P.length + 1),
    '--network', NET_TOOLS, '--network-alias', spec.name,
    '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=64m,mode=1777', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    // --init reaps orphaned zombies; the pids cap counts threads (each node process has ~7-10), so 256 still stops fork bombs.
    '--init', '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '256',
    '--label', `${P}.role=tool`, '-e', `LAUNCHER_TOKEN=${token}`,
    ...spec.mounts, IMAGE_TOOLS]
}

const docker = (args, opts = {}) => run(DOCKER, args, { windowsHide: true, maxBuffer: 1 << 20, ...opts })
const safeEqual = (a, b) => { const x = Buffer.from(String(a ?? '')); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }

async function ensureInfra() {
  const nets = (await docker(['network', 'ls', '--format', '{{.Name}}'])).stdout.split(/\r?\n/)
  if (!nets.includes(NET_TOOLS)) await docker(['network', 'create', '--internal', NET_TOOLS])
  for (const v of Object.values(VOL)) await docker(['volume', 'create', v])
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

async function ensure(zone) {
  if (blocked.has(zone)) throw Object.assign(new Error('Thư mục đã vượt hạn mức dung lượng; hãy liên hệ admin.'), { status: 403 })
  const current = running.get(zone)
  if (current) {
    const state = await docker(['inspect', '-f', '{{.State.Running}}', current.name]).then(r => r.stdout.trim(), () => 'false')
    if (state === 'true') return current
    running.delete(zone)
  }
  const { name } = zoneSpec(zone)
  await docker(['rm', '-f', name]).catch(() => {})
  const token = randomBytes(32).toString('hex')
  await docker(toolRunArgs(zone, token))
  const entry = { name, token }
  running.set(zone, entry)
  if (!grace.has(zone)) grace.set(zone, Date.now() + 10 * 60_000)
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

async function startMain(secret) {
  await docker(['rm', '-f', MAIN]).catch(() => {})
  const bridgeSubnet = (await docker(['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Subnet}}'])).stdout.trim()
  await docker(['run', '-d', '--name', MAIN, '--label', `${P}.role=main`,
    '--network', 'bridge', '-p', `${PUBLISH}:3444`, '--add-host', 'host.docker.internal:host-gateway',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-e', `TOOL_MANAGER_URL=http://host.docker.internal:${PORT}`, '-e', `TOOL_MANAGER_SECRET=${secret}`,
    '-e', `GATE_BIND_SUBNET=${bridgeSubnet}`,
    '-v', `${VOL.storage}:/data`, '-v', `${VOL.home}:/home/dsh`, '-v', `${VOL.db}:/var/docshield`, '-v', `${VOL.gate}:/var/gate`,
    IMAGE_MAIN])
  await docker(['network', 'connect', NET_TOOLS, MAIN])
  const logs = spawn(DOCKER, ['logs', '-f', MAIN], { stdio: 'inherit', windowsHide: true })
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
  const logs = await startMain(secret)
  log(`đã bật ${MAIN}; đăng nhập tại http://${PUBLISH}`)
  const sweep = setInterval(() => void quotaSweep().catch(e => log(`quota: ${e.message}`)), 60_000)
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    clearInterval(sweep)
    log('đang tắt...')
    logs.kill()
    await removeLeftovers().catch(() => {})
    server.close()
    process.exit(0)
  }
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, shutdown)
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('exec-router/tool-manager.mjs')) {
  serve().catch(err => { console.error(`tool-manager: ${err.stack ?? err}`); process.exit(1) })
}
