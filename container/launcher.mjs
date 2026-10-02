/**
 * Entry point of a per-user tool container. The shared DSH (exec-router)
 * connects here over the internal Docker network instead of OpenSSH.
 *
 * Each TCP connection starts with one JSON line, then becomes a raw pipe:
 *   {"token": "...", "kind": "rpc"}                 → stdin/stdout of a fresh DSH helper
 *   {"token": "...", "kind": "stream", "path": "…"} → the helper's unix socket at `path`
 * Stream sockets are TLS-PSK protected by the helper itself (per-stream
 * capability), so this relay only checks the token and the path shape.
 *
 * No dependencies. Every socket and child has error/close handlers: a peer
 * reset must never take the launcher (and so the whole container) down.
 */
import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'

const PORT = Number(process.env.LAUNCHER_PORT ?? 7000)
const TOKEN = Buffer.from(process.env.LAUNCHER_TOKEN ?? '', 'utf8')
const HELPER = process.env.HELPER_PATH ?? '/opt/tool/helper.bundle.mjs'
const MAX_CONNECTIONS = 32
const HEADER_TIMEOUT_MS = 5000
const MAX_HEADER = 4096
/** Helper stream sockets live at /tmp/dsh-ssh-XXXXXX/<uuid>/<channel> (helper-processes.ts). */
const STREAM_PATH = /^\/tmp\/dsh-ssh-[A-Za-z0-9]+\/[0-9a-f-]{36}\/(stdout|stderr|stdin|control|terminal)$/

if (TOKEN.length < 32) {
  console.error('launcher: LAUNCHER_TOKEN missing or too short')
  process.exit(1)
}
process.on('uncaughtException', err => console.error(`launcher: ${err.stack ?? err}`))
process.on('unhandledRejection', err => console.error(`launcher: ${err?.stack ?? err}`))

const tokenOk = given => {
  const g = Buffer.from(typeof given === 'string' ? given : '', 'utf8')
  return g.length === TOKEN.length && timingSafeEqual(g, TOKEN)
}

const server = net.createServer({ allowHalfOpen: true }, socket => {
  socket.on('error', () => socket.destroy())
  const timer = setTimeout(() => socket.destroy(), HEADER_TIMEOUT_MS)
  let header = Buffer.alloc(0)
  const onData = chunk => {
    header = Buffer.concat([header, chunk])
    const nl = header.indexOf(0x0a)
    if (nl < 0) {
      if (header.length > MAX_HEADER) socket.destroy()
      return
    }
    socket.off('data', onData)
    socket.pause()
    clearTimeout(timer)
    let request
    try { request = JSON.parse(header.subarray(0, nl).toString('utf8')) } catch { return socket.destroy() }
    if (!tokenOk(request?.token)) return socket.destroy()
    const rest = header.subarray(nl + 1)
    if (request.kind === 'rpc') return startHelper(socket, rest)
    if (request.kind === 'stream' && typeof request.path === 'string' && STREAM_PATH.test(request.path) && path.posix.normalize(request.path) === request.path) {
      return relayStream(socket, request.path, rest)
    }
    socket.destroy()
  }
  socket.on('data', onData)
})
server.maxConnections = MAX_CONNECTIONS
server.on('error', err => console.error(`launcher: server ${err.message}`))
server.listen(PORT, '0.0.0.0', () => console.log(`launcher: listening on ${PORT}`))

/** One helper per rpc connection; it dies with the connection (and by its own lease). */
function startHelper(socket, rest) {
  const child = spawn(process.execPath, ['--disable-sigusr1', HELPER], { stdio: ['pipe', 'pipe', 'pipe'] })
  const end = () => { socket.destroy(); if (child.exitCode === null) child.kill('SIGTERM') }
  child.on('error', end)
  child.on('exit', () => socket.destroy())
  child.stdin.on('error', end)
  child.stdout.on('error', end)
  child.stderr.on('data', d => process.stderr.write(`helper: ${d}`))
  // The rpc channel has no half-close meaning: DSH closing its side ends the helper
  // (otherwise the helper sits on an EOF'd stdin and piles up against --pids-limit).
  socket.on('end', end)
  socket.on('close', end)
  if (rest.length > 0) child.stdin.write(rest)
  socket.pipe(child.stdin)
  child.stdout.pipe(socket)
  socket.resume()
}

/** Raw byte relay to a helper stream socket (TLS-PSK runs end to end through it). */
function relayStream(socket, socketPath, rest) {
  const target = net.connect({ path: socketPath, allowHalfOpen: true })
  const end = () => { socket.destroy(); target.destroy() }
  target.on('error', end)
  target.on('close', () => socket.destroy())
  socket.on('close', () => target.destroy())
  target.on('connect', () => {
    if (rest.length > 0) target.write(rest)
    socket.pipe(target)
    target.pipe(socket)
    socket.resume()
  })
}
