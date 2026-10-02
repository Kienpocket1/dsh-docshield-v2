/**
 * A stand-in for DSH's `ssh` service (packages/ssh/ssh) that reaches the
 * helper inside a per-user tool container over TCP (container/launcher.mjs)
 * instead of OpenSSH. It offers exactly what the SSH fs/subprocess/sandbox
 * providers use: `request`, `connectStream`, `dispose`, `ready`.
 *
 * - RPC: one TCP connection whose bytes are the helper's stdin/stdout, framed
 *   by DSH's own SshRpcPeer.
 * - Streams: one TCP connection per process stream, relayed by the launcher to
 *   the helper's unix socket; TLS-PSK with the per-stream capability runs end
 *   to end (copied from ssh/src/stream-security.ts), so the relay is untrusted.
 */
import net from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { z } from 'zod'
import { SshRpcPeer } from '@deepseek-ai/dsh-ssh/protocol'
import { helloSchema } from '@deepseek-ai/dsh-ssh/schemas'

const SSH_PROTOCOL_VERSION = 1
const TLS_OPTIONS = { ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }

export class ToolConnection {
  /**
   * @param {object} opts
   * @param {string} opts.host        tool container name on the internal network
   * @param {number} [opts.port]
   * @param {string} opts.token       launcher token of that container
   * @param {string} opts.workspace   absolute workspace inside the container
   * @param {string} [opts.helperHash] expected sha256 of the helper bundle; refuse others
   * @param {number} [opts.leaseMs]
   * @param {number} [opts.requestTimeoutMs]
   * @param {number} [opts.maxFrameBytes]
   * @param {number} [opts.maxPending]
   */
  constructor(opts) {
    this.opts = { port: 7000, leaseMs: 30_000, requestTimeoutMs: 30_000, maxFrameBytes: 8 * 1024 * 1024, maxPending: 8, ...opts }
    this.sockets = new Set()
    this.closed = false
    this.failure = undefined
    this.ready = this.#start()
    this.ready.catch(err => this.#fail(err))
  }

  /** Verified helper facts (root of its stream sockets, node path…). */
  get nodeExecutable() {
    if (this.hello === undefined) throw new Error('tool helper is not ready')
    return this.hello.node
  }

  async request(method, params, schema, signal, wait = false) {
    this.#assertOpen()
    await this.ready
    this.#assertOpen()
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.opts.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.opts.requestTimeoutMs)])
    return this.rpc.request(method, params, schema, bounded)
  }

  /** Open one helper stream (path + capability from `process.prepare`); returns a paused TLS socket. */
  async connectStream(endpoint, signal) {
    const hello = await this.ready
    this.#assertOpen()
    if (!endpoint.path.startsWith(`${hello.root}/`) || /[:\r\n\0]/u.test(endpoint.path)) throw new Error('tool helper returned an invalid stream path')
    const raw = await this.#open({ kind: 'stream', path: endpoint.path }, signal)
    const secured = await authenticateStream(raw, endpoint.capability, this.opts.requestTimeoutMs, signal)
    this.#track(secured)
    secured.on('error', () => secured.destroy())
    return secured
  }

  async dispose() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    try {
      if (this.failure === undefined && this.rpc) await this.rpc.request('close', {}, z.null(), AbortSignal.timeout(this.opts.requestTimeoutMs)).catch(() => {})
    } finally {
      this.rpc?.close()
      for (const s of this.sockets) s.destroy()
      this.sockets.clear()
    }
  }

  async #start() {
    const socket = await this.#open({ kind: 'rpc' })
    this.rpc = new SshRpcPeer(socket, socket, this.opts.maxFrameBytes, this.opts.maxPending)
    this.rpc.once('closed', err => this.#fail(err ?? new Error('tool helper disconnected')))
    const hello = await this.rpc.request('hello', {
      protocol: SSH_PROTOCOL_VERSION, workspace: this.opts.workspace, leaseMs: this.opts.leaseMs,
    }, helloSchema, AbortSignal.timeout(this.opts.requestTimeoutMs))
    if (this.opts.helperHash !== undefined && hello.hash !== this.opts.helperHash) throw new Error('tool helper digest differs from the expected bundle')
    this.hello = hello
    let pending
    this.heartbeat = setInterval(() => {
      pending ??= this.rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.opts.leaseMs / 2))
        .catch(err => this.#fail(err))
        .finally(() => { pending = undefined })
    }, Math.floor(this.opts.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }

  /** TCP to the launcher, then its one-line header. */
  #open(header, signal) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.opts.host, port: this.opts.port, allowHalfOpen: true })
      this.#track(socket)
      const abort = () => socket.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      signal?.addEventListener('abort', abort, { once: true })
      socket.once('error', err => { signal?.removeEventListener('abort', abort); reject(err) })
      socket.once('connect', () => {
        signal?.removeEventListener('abort', abort)
        socket.write(`${JSON.stringify({ token: this.opts.token, ...header })}\n`)
        socket.on('error', () => socket.destroy())
        resolve(socket)
      })
    })
  }

  #track(socket) {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
  }

  #assertOpen() {
    if (this.closed) throw new Error('tool connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  #fail(error) {
    if (this.failure !== undefined || this.closed) return
    this.failure = error instanceof Error ? error : new Error(String(error))
    clearInterval(this.heartbeat)
    this.rpc?.close(this.failure)
    for (const s of this.sockets) s.destroy()
  }
}

/** TLS-PSK handshake on a relayed stream (ssh/src/stream-security.ts). */
export async function authenticateStream(socket, capability, timeoutMs, signal) {
  if (signal?.aborted) { socket.destroy(); signal.throwIfAborted() }
  const stream = tlsConnect({
    ...TLS_OPTIONS, socket, rejectUnauthorized: true,
    pskCallback: () => ({ psk: Buffer.from(capability, 'hex'), identity: 'dsh-stream' }),
    checkServerIdentity: () => undefined,
  })
  const abort = () => stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason)))
  signal?.addEventListener('abort', abort, { once: true })
  stream.once('close', () => signal?.removeEventListener('abort', abort))
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { stream.off('secureConnect', secured); stream.off('error', failed); stream.off('close', closed); clearTimeout(timer) }
      const secured = () => { cleanup(); stream.disableRenegotiation(); stream.pause(); resolve() }
      const failed = err => { cleanup(); reject(err) }
      const closed = () => failed(new Error('tool stream closed during authentication'))
      const timer = setTimeout(() => failed(new Error('tool stream authentication timed out')), timeoutMs)
      stream.once('secureConnect', secured)
      stream.once('error', failed)
      stream.once('close', closed)
    })
    return stream
  } catch (error) {
    stream.destroy()
    throw error
  }
}
