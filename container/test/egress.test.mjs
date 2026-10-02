// egress-proxy: who may go out, where to (TC14/TC16) and how much (TC15).
// Upstreams are local fakes reached through `dial`; names resolve through a fake `lookup`.
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { authZone, createEgressProxy, ipBlocked, proxyUser, resolvePublic, zoneToken } from '../egress-proxy.mjs'

const SECRET = 'a'.repeat(64)
const basic = (zone, token = zoneToken(SECRET, zone)) => `Basic ${Buffer.from(`${proxyUser(zone)}:${token}`).toString('base64')}`
const PUBLIC = '93.184.216.34'

describe('ipBlocked', () => {
  it('blocks every non-public IPv4 range, including the Docker / Docker Desktop ones', () => {
    for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '127.255.255.255', '169.254.169.254', '172.16.0.1', '172.17.0.1',
      '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.65.254', '192.168.1.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '255.255.255.255']) {
      assert.ok(ipBlocked(ip), ip)
    }
  })
  it('lets public addresses through, right at the range edges too', () => {
    for (const ip of [PUBLIC, '1.1.1.1', '8.8.8.8', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255']) {
      assert.ok(!ipBlocked(ip), ip)
    }
  })
  it('treats anything that is not dotted IPv4 as blocked', () => {
    for (const ip of ['::1', '::ffff:127.0.0.1', 'fe80::1', '2606:4700::1', '2130706433', '0x7f.1', '', 'example.com']) assert.ok(ipBlocked(ip), ip)
  })
})

describe('authZone', () => {
  it('accepts the zone a token was made for', () => {
    assert.equal(authZone(basic('user:alice'), SECRET), 'user:alice')
    assert.equal(authZone(basic('admin'), SECRET), 'admin')
  })
  it("refuses a wrong token, another zone's token, admin-review and junk", () => {
    assert.equal(authZone(basic('user:alice', zoneToken(SECRET, 'user:bob')), SECRET), undefined)
    assert.equal(authZone(basic('user:alice', 'x'.repeat(64)), SECRET), undefined)
    assert.equal(authZone(basic('user:alice'), 'b'.repeat(64)), undefined)
    assert.equal(authZone(`Basic ${Buffer.from(`admin-review:${zoneToken(SECRET, 'admin-review')}`).toString('base64')}`, SECRET), undefined)
    for (const h of [undefined, '', 'Bearer x', 'Basic !!!', `Basic ${Buffer.from('nocolon').toString('base64')}`]) assert.equal(authZone(h, SECRET), undefined, String(h))
  })
})

describe('resolvePublic', () => {
  const fake = map => async host => { if (!(host in map)) throw new Error('ENOTFOUND'); return map[host].map(address => ({ address, family: 4 })) }
  it('returns the checked public address', async () => {
    assert.equal(await resolvePublic('ok.test', fake({ 'ok.test': [PUBLIC] })), PUBLIC)
  })
  it('refuses a name with ANY private answer (rebinding), IPv6 literals and unknown names', async () => {
    await assert.rejects(resolvePublic('rebind.test', fake({ 'rebind.test': [PUBLIC, '127.0.0.1'] })), { status: 403, reason: 'private-ip' })
    await assert.rejects(resolvePublic('host.docker.internal', fake({ 'host.docker.internal': ['192.168.65.254'] })), { status: 403 })
    await assert.rejects(resolvePublic('[::1]', fake({})), { status: 403, reason: 'ipv6' })
    await assert.rejects(resolvePublic('::ffff:127.0.0.1', fake({})), { status: 403, reason: 'ipv6' })
    await assert.rejects(resolvePublic('nope.test', fake({})), { status: 502, reason: 'dns' })
    await assert.rejects(resolvePublic('a b', fake({})), { status: 400 })
  })
  it('asks the resolver for IPv4 only', async () => {
    let options
    await resolvePublic('ok.test', async (_h, o) => { options = o; return [{ address: PUBLIC, family: 4 }] })
    assert.deepEqual(options, { all: true, family: 4 })
  })
})

// ---- the proxy itself, against local fake upstreams ----
const closers = []
after(() => { for (const c of closers) c() })
const listen = async server => { await new Promise(r => server.listen(0, '127.0.0.1', r)); closers.push(() => server.close()); return server.address().port }

/** A proxy whose names map to PUBLIC (or as given) and whose dials land on a local port. */
async function startProxy({ names = {}, limits, headersTimeoutMs } = {}) {
  const logs = []
  const dials = []
  let target = 0
  const lookup = async host => (names[host] ?? [PUBLIC]).map(address => ({ address, family: 4 }))
  const server = createEgressProxy({
    secret: SECRET, log: e => logs.push(e), lookup, limits, headersTimeoutMs,
    dial: (ip, port) => { dials.push(`${ip}:${port}`); return net.connect({ host: '127.0.0.1', port: target }) },
  })
  const port = await listen(server)
  return { port, logs, dials, setTarget: p => { target = p } }
}

/** Raw CONNECT; resolves with the status line and the open socket. */
function connect(port, target, auth, head = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port })
    let buf = Buffer.alloc(0)
    s.on('error', reject)
    s.once('connect', () => s.write(Buffer.concat([Buffer.from(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`), head])))
    const onData = d => {
      buf = Buffer.concat([buf, d])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      s.off('data', onData)
      resolve({ status: Number(buf.toString('latin1').split(' ')[1]), socket: s, rest: buf.subarray(end + 4) })
    }
    s.on('data', onData)
  })
}
const waitFor = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)) } }

describe('egress proxy', () => {
  it('tunnels CONNECT to port 443 of a checked public address and logs it', async () => {
    const echo = net.createServer(s => s.pipe(s))
    const p = await startProxy()
    p.setTarget(await listen(echo))
    const { status, socket } = await connect(p.port, 'example.com:443', basic('user:alice'))
    assert.equal(status, 200)
    socket.write('ping')
    const reply = await new Promise(r => socket.once('data', d => r(d.toString())))
    assert.equal(reply, 'ping')
    socket.end()
    await waitFor(() => p.logs.length === 1)
    assert.deepEqual(p.dials, [`${PUBLIC}:443`])
    assert.equal(p.logs[0].zone, 'user:alice')
    assert.equal(p.logs[0].status, 200)
    assert.equal(p.logs[0].ip, PUBLIC)
    assert.equal(p.logs[0].up, 4)
  })

  it('refuses without credentials (407), other ports (403) and rebinding names (403) — never dialing', async () => {
    const p = await startProxy({ names: { 'rebind.test': [PUBLIC, '10.0.0.1'], 'host.docker.internal': ['192.168.65.254'] } })
    assert.equal((await connect(p.port, 'example.com:443')).status, 407)
    assert.equal((await connect(p.port, 'example.com:443', basic('user:alice', 'f'.repeat(64)))).status, 407)
    assert.equal((await connect(p.port, 'example.com:22', basic('user:alice'))).status, 403)
    assert.equal((await connect(p.port, 'rebind.test:443', basic('user:alice'))).status, 403)
    assert.equal((await connect(p.port, 'host.docker.internal:443', basic('user:alice'))).status, 403)
    assert.equal((await connect(p.port, '[::1]:443', basic('user:alice'))).status, 403)
    assert.deepEqual(p.dials, [])
    await waitFor(() => p.logs.length === 6)
    assert.deepEqual(p.logs.map(l => l.deny.split(' ')[0]), ['auth', 'auth', 'port', 'private-ip', 'private-ip', 'ipv6'])
  })

  it('cuts a tunnel at the upload budget, counting the bytes sent along with the CONNECT head', async () => {
    let received = 0
    const sink = net.createServer(s => { s.on('data', d => { received += d.length }); s.on('error', () => {}) })
    const p = await startProxy({ limits: { upPerMin: 1024 * 1024 } })
    p.setTarget(await listen(sink))
    const head = Buffer.alloc(200 * 1024, 1)
    const { status, socket } = await connect(p.port, 'example.com:443', basic('user:alice'), head)
    assert.equal(status, 200)
    socket.on('error', () => {})
    const chunk = Buffer.alloc(64 * 1024, 2)
    let sent = head.length
    while (sent < 1.5 * 1024 * 1024 && !socket.destroyed) { socket.write(chunk); sent += chunk.length; await new Promise(r => setImmediate(r)) }
    await waitFor(() => p.logs.length === 1)
    assert.equal(p.logs[0].deny, 'upload-limit')
    assert.ok(p.logs[0].up <= 1024 * 1024, `up ${p.logs[0].up}`)
    assert.ok(p.logs[0].up >= head.length, 'the head bytes were counted')
    await waitFor(() => socket.destroyed || socket.readableEnded)
    assert.ok(received <= 1024 * 1024, `upstream got ${received}`)
  })

  it('rate-limits new connections per zone (429) and keeps zones apart', async () => {
    const echo = net.createServer(s => s.pipe(s))
    const p = await startProxy({ limits: { connsPerMin: 2 } })
    p.setTarget(await listen(echo))
    for (let i = 0; i < 2; i++) (await connect(p.port, 'example.com:443', basic('user:alice'))).socket.end()
    assert.equal((await connect(p.port, 'example.com:443', basic('user:alice'))).status, 429)
    const bob = await connect(p.port, 'example.com:443', basic('user:bob'))
    assert.equal(bob.status, 200)
    bob.socket.end()
  })

  it('forwards plain HTTP on port 80 only, without the proxy credentials, one upstream connection per request', async () => {
    let seen
    const web = http.createServer((req, res) => { seen = req.headers; res.end('hello') })
    const p = await startProxy()
    p.setTarget(await listen(web))
    const get = (url, auth = basic('user:alice')) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: p.port, path: url, headers: auth ? { 'proxy-authorization': auth } : {} }, res => {
        let body = ''
        res.on('data', d => { body += d }).on('end', () => resolve({ status: res.statusCode, body }))
      })
      r.on('error', reject)
      r.end()
    })
    const ok = await get('http://example.com/x?y=1')
    assert.deepEqual(ok, { status: 200, body: 'hello' })
    assert.equal(seen['proxy-authorization'], undefined)
    assert.equal(seen.host, 'example.com')
    assert.equal(seen.connection, 'close')
    assert.equal((await get('http://example.com:8080/')).status, 403)
    assert.equal((await get('http://example.com/', null)).status, 407)
    assert.equal((await get('https://example.com/')).status, 400)
    await waitFor(() => p.logs.length === 4)
    assert.deepEqual(p.logs.map(l => l.status), [200, 403, 407, 400])
  })

  it('drops a client that sends its headers too slowly (slowloris)', async () => {
    const p = await startProxy({ headersTimeoutMs: 300 })
    const s = net.connect({ host: '127.0.0.1', port: p.port })
    s.on('error', () => {})
    await new Promise(r => s.once('connect', r))
    s.write('CONNECT example.com:443 HTTP/1.1\r\n')
    const t0 = Date.now()
    await new Promise(r => s.once('close', r))
    assert.ok(Date.now() - t0 < 3000)
  })
})
