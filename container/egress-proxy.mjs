#!/usr/bin/env node
/**
 * egress-proxy — the only way out to the internet for tool containers (their
 * network is `--internal`). Plain Node, no dependencies; runs from the tools
 * image as uid 1000 on `<P>-egress` + `<P>-tools`.
 *
 * - Who: `Proxy-Authorization: Basic <name>:<token>`, name `user.<u>` or `admin`,
 *   token = HMAC-SHA256(EGRESS_SECRET, zone). Stateless; `admin-review` never.
 * - Where (TC14, TC16): IPv4 only; the proxy resolves the name itself, every
 *   address must be public, and it connects to exactly the address it checked
 *   (no second lookup → no DNS rebinding). Plain HTTP to port 80, CONNECT to 443.
 * - How much (TC15): per zone, connections/minute, concurrent connections and
 *   bytes up/down per minute, counted on the raw TCP stream (inside a CONNECT
 *   tunnel that is TLS bytes); over the upload budget both sockets are cut.
 * - Log: one JSON line per connection to stdout and EGRESS_LOG (rotated at 5 MB).
 *
 *   EGRESS_SECRET=<hex> [EGRESS_PORT=3128] [EGRESS_LOG=/var/egress/egress.jsonl] node egress-proxy.mjs
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import dns from 'node:dns'
import { appendFileSync, renameSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'

/** Zones that may go out (admin-review is offline by design). */
export const EGRESS_ZONE = /^(user:[a-z0-9][a-z0-9_-]{2,31}|admin)$/

/** Non-public IPv4 ranges: private, loopback, link-local, CGNAT, Docker/Docker Desktop, test nets, multicast, reserved. */
const BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [toInt(base) >>> (32 - bits), bits])

function toInt(ip) { return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0) }

/** True unless `ip` is a dotted IPv4 address outside every blocked range. */
export function ipBlocked(ip) {
  if (!net.isIPv4(ip)) return true
  const n = toInt(ip)
  return BLOCKED.some(([prefix, bits]) => n >>> (32 - bits) === prefix)
}

export const zoneToken = (secret, zone) => createHmac('sha256', secret).update(zone).digest('hex')

/** Proxy user name for a zone: ':' is awkward inside proxy URLs. */
export const proxyUser = zone => zone.replace(/^user:/, 'user.')

/** Zone named by a valid Proxy-Authorization header, or undefined. */
export function authZone(header, secret) {
  const m = /^Basic\s+([A-Za-z0-9+/]+=*)\s*$/i.exec(header ?? '')
  if (!m) return undefined
  const raw = Buffer.from(m[1], 'base64').toString('utf8')
  const colon = raw.indexOf(':')
  if (colon < 0) return undefined
  const name = raw.slice(0, colon)
  const zone = name.startsWith('user.') ? `user:${name.slice(5)}` : name
  if (!EGRESS_ZONE.test(zone)) return undefined
  const got = Buffer.from(raw.slice(colon + 1))
  const want = Buffer.from(zoneToken(secret, zone))
  return got.length === want.length && timingSafeEqual(got, want) ? zone : undefined
}

class Denied extends Error {
  constructor(status, reason, detail) { super(reason); this.status = status; this.reason = reason; this.detail = detail }
}

/** Resolve `host` to one checked public IPv4 address (throws Denied). */
export async function resolvePublic(host, lookup = dns.promises.lookup) {
  if (host.includes(':') || host.startsWith('[')) throw new Denied(403, 'ipv6')
  if (!/^[A-Za-z0-9._-]{1,253}$/.test(host)) throw new Denied(400, 'bad-host')
  let addrs
  try { addrs = await lookup(host, { all: true, family: 4 }) } catch { throw new Denied(502, 'dns') }
  if (!Array.isArray(addrs) || addrs.length === 0) throw new Denied(502, 'dns')
  // Every answer must be public: a name that also points inside is refused outright.
  for (const { address } of addrs) if (ipBlocked(address)) throw new Denied(403, 'private-ip', address)
  return addrs[0].address
}

/** Sum of amounts added within the last `ms`. */
class Window {
  constructor(ms) { this.ms = ms; this.items = []; this.sum = 0 }
  prune(now) { while (this.items.length && this.items[0][0] <= now - this.ms) this.sum -= this.items.shift()[1] }
  total(now = Date.now()) { this.prune(now); return this.sum }
  add(n, now = Date.now()) { this.prune(now); this.items.push([now, n]); this.sum += n }
}

export const DEFAULT_LIMITS = { connsPerMin: 60, concurrent: 16, upPerMin: 5 * 1024 * 1024, downPerMin: 200 * 1024 * 1024, idleMs: 120_000 }
const ADMIN_FACTOR = 3

/**
 * @param {object} o
 * @param {string} o.secret
 * @param {(entry: object) => void} [o.log]
 * @param {typeof dns.promises.lookup} [o.lookup]  resolver (tests)
 * @param {Partial<typeof DEFAULT_LIMITS>} [o.limits]
 * @param {(ip: string, port: number) => net.Socket} [o.dial]  upstream connector (tests)
 * @param {number} [o.headersTimeoutMs]
 */
export function createEgressProxy({ secret, log = () => {}, lookup, limits = {}, dial = (ip, port) => net.connect({ host: ip, port }), headersTimeoutMs = 10_000 }) {
  if (!secret) throw new Error('egress-proxy: thiếu EGRESS_SECRET')
  const base = { ...DEFAULT_LIMITS, ...limits }
  const budgets = new Map()
  const budget = zone => {
    let b = budgets.get(zone)
    if (!b) {
      const f = zone === 'admin' ? ADMIN_FACTOR : 1
      b = { conns: new Window(60_000), up: new Window(60_000), down: new Window(60_000), active: 0,
        max: { conns: base.connsPerMin * f, concurrent: base.concurrent * f, up: base.upPerMin * f, down: base.downPerMin * f } }
      budgets.set(zone, b)
    }
    return b
  }

  /** Bookkeeping of one connection; `finish` logs exactly once. */
  function track(zone, method, host, port) {
    const entry = { t: new Date().toISOString(), zone, method, host, port, ip: undefined, status: 0, up: 0, down: 0, ms: 0, deny: undefined }
    const t0 = Date.now()
    let done = false
    let counted = false
    return {
      entry,
      open(b) { b.active++; counted = true },
      finish(b, extra = {}) {
        if (done) return
        done = true
        if (counted) b.active--
        Object.assign(entry, extra, { ms: Date.now() - t0 })
        if (entry.deny === undefined) delete entry.deny
        log(entry)
      },
    }
  }

  /** Admit a new connection for `zone` or throw Denied(429). */
  function admit(zone) {
    const b = budget(zone)
    if (b.conns.total() >= b.max.conns) throw new Denied(429, 'rate-limit')
    if (b.active >= b.max.concurrent) throw new Denied(429, 'too-many-connections')
    b.conns.add(1)
    return b
  }

  /**
   * Forward `from` → `to` chunk by chunk, counting bytes against `window`.
   * Returns a function that pushes an initial buffer through the same path.
   */
  function relay(from, to, window, limit, count, onOver) {
    const push = chunk => {
      if (chunk.length === 0) return true
      if (window.total() + chunk.length > limit) { onOver(); return false }
      window.add(chunk.length)
      count(chunk.length)
      if (!to.write(chunk)) { from.pause(); to.once('drain', () => from.resume()) }
      return true
    }
    from.on('data', push)
    from.on('end', () => to.end())
    return push
  }

  // Slowloris: headers must arrive within headersTimeoutMs (checked every second at most).
  const server = http.createServer({ headersTimeout: headersTimeoutMs, requestTimeout: 0, maxHeaderSize: 16 * 1024, connectionsCheckingInterval: Math.min(1000, headersTimeoutMs) })

  // CONNECT host:443 — a raw TCP tunnel (TLS inside).
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {})
    const zone = authZone(req.headers['proxy-authorization'], secret)
    const [host, portText] = splitHostPort(req.url)
    const t = track(zone ?? '-', 'CONNECT', host, Number(portText))
    const refuse = (status, reason, detail) => {
      client.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="egress"\r\n' : ''}Connection: close\r\n\r\n`)
      t.finish(budget(zone ?? '-'), { status, deny: detail ? `${reason} ${detail}` : reason })
    }
    if (!zone) return refuse(407, 'auth')
    if (portText !== '443') return refuse(403, 'port')
    let b
    let ip
    try {
      b = admit(zone)
      ip = await resolvePublic(host, lookup)
    } catch (e) {
      if (e instanceof Denied) return refuse(e.status, e.reason, e.detail)
      return refuse(502, 'error')
    }
    t.open(b)
    t.entry.ip = ip
    const upstream = dial(ip, 443)
    let over
    const close = () => { client.destroy(); upstream.destroy() }
    const cut = which => { over ??= which; close() }
    upstream.setTimeout(base.idleMs, close)
    client.setTimeout(base.idleMs, close)
    upstream.once('error', () => {
      if (t.entry.status === 0) { t.entry.status = 502; client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') } else close()
    })
    upstream.once('connect', () => {
      t.entry.status = 200
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const pushUp = relay(client, upstream, b.up, b.max.up, n => { t.entry.up += n }, () => cut('upload-limit'))
      relay(upstream, client, b.down, b.max.down, n => { t.entry.down += n }, () => cut('download-limit'))
      // Bytes the client sent right after the CONNECT head arrive here, not as 'data': count them too.
      if (head?.length) pushUp(head)
    })
    let closed = 0
    const finished = () => { if (++closed === 2) t.finish(b, { deny: over }) }
    client.once('close', () => { upstream.destroy(); finished() })
    upstream.once('close', () => { client.destroy(); finished() })
  })

  // Plain HTTP: absolute-form http://host[:80]/path only; one upstream connection per request.
  server.on('request', async (req, res) => {
    req.on('error', () => {})
    let url
    try { url = new URL(req.url) } catch { url = undefined }
    const zone = authZone(req.headers['proxy-authorization'], secret)
    const t = track(zone ?? '-', req.method, url?.hostname ?? '-', Number(url?.port || 80))
    const refuse = (status, reason, detail) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close', ...status === 407 ? { 'proxy-authenticate': 'Basic realm="egress"' } : {} })
      res.end(`egress-proxy: ${reason}${detail ? ` (${detail})` : ''}\n`)
      t.finish(budget(zone ?? '-'), { status, deny: detail ? `${reason} ${detail}` : reason })
    }
    if (!zone) return refuse(407, 'auth')
    if (!url || url.protocol !== 'http:' || url.username || url.password) return refuse(400, 'bad-request')
    if (url.port !== '' && url.port !== '80') return refuse(403, 'port')
    let b
    let ip
    try {
      b = admit(zone)
      ip = await resolvePublic(url.hostname, lookup)
    } catch (e) {
      if (e instanceof Denied) return refuse(e.status, e.reason, e.detail)
      return refuse(502, 'error')
    }
    t.open(b)
    t.entry.ip = ip
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v
    headers.host = url.host
    headers.connection = 'close'
    const sock = dial(ip, 80)
    const up = http.request({ createConnection: () => sock, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false })
    let over
    const cut = which => { over ??= which; up.destroy(); req.destroy(); res.destroy() }
    sock.setTimeout(base.idleMs, () => cut('idle'))
    up.on('error', () => {
      if (!res.headersSent) { res.writeHead(502, { connection: 'close' }); res.end() }
      t.finish(b, { status: t.entry.status || 502, deny: over })
    })
    up.on('response', upRes => {
      t.entry.status = upRes.statusCode ?? 0
      const out = {}
      for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v
      res.writeHead(upRes.statusCode ?? 502, out)
      relay(upRes, res, b.down, b.max.down, n => { t.entry.down += n }, () => cut('download-limit'))
      upRes.on('error', () => cut('upstream'))
    })
    relay(req, up, b.up, b.max.up, n => { t.entry.up += n }, () => cut('upload-limit'))
    res.on('close', () => { up.destroy(); t.finish(b, { deny: over }) })
  })

  server.on('clientError', (_err, socket) => { socket.destroy() })
  return server
}

const HOP_BY_HOP = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-authenticate'])

function splitHostPort(target) {
  // `[v6]:port` keeps its brackets so resolvePublic refuses it as IPv6.
  const m = /^(\[[^\]\s]*\]|[^:/\s[\]]+):(\d{1,5})$/.exec(target ?? '')
  return m ? [m[1], m[2]] : [String(target ?? '-').slice(0, 100), '']
}

/** stdout + an append-only JSONL file rotated at `maxBytes` (one previous file kept). */
export function fileLogger(file, maxBytes = 5 * 1024 * 1024) {
  return entry => {
    const line = `${JSON.stringify(entry)}\n`
    process.stdout.write(`egress ${line}`)
    if (!file) return
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) + line.length > maxBytes) renameSync(file, `${file}.1`)
      appendFileSync(file, line)
    } catch { /* logging must never break the proxy */ }
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/egress-proxy.mjs')) {
  const port = Number(process.env.EGRESS_PORT ?? 3128)
  const server = createEgressProxy({ secret: process.env.EGRESS_SECRET, log: fileLogger(process.env.EGRESS_LOG) })
  delete process.env.EGRESS_SECRET
  server.listen(port, '0.0.0.0', () => console.log(`egress-proxy: nghe :${port}`))
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0))
}
