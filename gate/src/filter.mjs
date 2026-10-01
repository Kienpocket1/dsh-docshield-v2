/**
 * Per-user filtering in front of the shared DSH. Admins are relayed
 * unchanged; for a normal user every `/api` call and every WebSocket message
 * goes through the rules in policy.mjs, with session ownership from
 * sessions.mjs. Anything unrecognized is refused.
 */
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { checkCall, checkOpen, collect, filterItem, filterResult, isInside } from './policy.mjs'
import { downstreamHeaders, proxyHttp, proxyUpgrade, upstreamHeaders } from './proxy.mjs'
import { OP, createDecoder, encodeFrame } from './ws.mjs'

const MAX_RPC_BODY = 64 * 1024 * 1024
/** Plain GET routes with no user data (UI shell, client bundles, Host info). */
const STATIC_PREFIXES = ['/assets/', '/plugins/', '/open-in-app/icon/']
const STATIC_EXACT = new Set(['/', '/index.html', '/favicon.ico', '/api/present.host', '/open-in-app/apps'])
/** Non-RPC /api routes keyed by a `sessionId` query parameter. */
const SESSION_QUERY_ROUTES = new Set(['/api/session/uploadFileBinary', '/api/changes.summary', '/api/changes.diff', '/api/session.export'])

/**
 * @param {object} deps
 * @param {import('./upstream.mjs').Upstream} deps.upstream
 * @param {import('./sessions.mjs').SessionIndex} deps.sessions
 * @param {(method: string, args: object) => Promise<any>} deps.call unfiltered upstream RPC
 * @param {string} deps.storageRoot
 * @param {(msg: string) => void} [deps.log]
 */
export function createFilter({ upstream, sessions, call, storageRoot, log = () => {} }) {
  /** workspaceId → path, learned from relayed workspace views. */
  const workspaces = new Map()
  /** user → "clientId|eventId" of Host waterfalls delivered to them. */
  const events = new Map()
  /** user → pending/done workspace registration. */
  const ensured = new Map()
  /** user → open WebSockets, closed when the account is disabled or changes role. */
  const sockets = new Map()
  const track = (username, socket) => {
    const set = sockets.get(username) ?? new Set()
    sockets.set(username, set.add(socket))
    socket.once('close', () => set.delete(socket))
  }
  function disconnect(username) {
    for (const socket of sockets.get(username) ?? []) socket.destroy()
    sockets.delete(username)
    events.delete(username)
  }

  const rootOf = username => path.resolve(storageRoot, 'users', username)

  /** Ownership answers for one user (see policy.mjs Access). */
  function accessFor(username) {
    const root = rootOf(username)
    const inRoot = p => isInside(root, p)
    const grants = events.get(username) ?? new Set()
    events.set(username, grants)
    return {
      root,
      inRoot,
      owns: id => inRoot(sessions.cwdOf(id)),
      known: id => sessions.cwdOf(id) !== undefined,
      workspacePath: id => (typeof id === 'string' ? workspaces.get(id) : undefined),
      ownsWorkspace: id => inRoot(workspaces.get(id)),
      learn: (id, cwd) => sessions.learn(id, cwd),
      grants,
    }
  }

  /** The account's folder (users/<name>, or admin for admins) exists and is a DSH workspace (once per gate run). */
  function ensureWorkspace(user) {
    const key = user.role === 'admin' ? '#admin' : user.username
    let pending = ensured.get(key)
    if (pending === undefined) {
      const root = user.role === 'admin' ? path.resolve(storageRoot, 'admin') : rootOf(user.username)
      pending = (async () => {
        mkdirSync(path.join(root, 'docs'), { recursive: true })
        const value = await call('workspace/create', { request: { path: root } })
        if (value?.workspace?.workspaceId) workspaces.set(value.workspace.workspaceId, value.workspace.path ?? root)
      })()
      pending.catch(err => { ensured.delete(key); log(`workspace ${key}: ${err.message}`) })
      ensured.set(key, pending)
    }
    return pending
  }

  // ---------------- HTTP ----------------

  async function handleHttp(req, res, user) {
    const instance = await upstream.get()
    await ensureWorkspace(user).catch(() => {})
    if (user.role === 'admin') return proxyHttp(req, res, instance)
    const url = new URL(req.url ?? '/', 'http://gate.local')
    const p = url.pathname
    const access = accessFor(user.username)

    if (req.method === 'GET' && (STATIC_EXACT.has(p) || STATIC_PREFIXES.some(x => p.startsWith(x)))) return proxyHttp(req, res, instance)
    if (SESSION_QUERY_ROUTES.has(p)) {
      const id = url.searchParams.get('sessionId')
      await sessions.ensure([id])
      if (access.owns(id)) return proxyHttp(req, res, instance)
      log(`deny ${user.username} ${p} (sessionId)`)
      return deny(res, 403)
    }
    if (p === '/api/file' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (access.inRoot(url.searchParams.get('path'))) return proxyHttp(req, res, instance)
      log(`deny ${user.username} /api/file (ngoài thư mục)`)
      return deny(res, 403)
    }
    const rpc = /^\/api\/([A-Za-z0-9_$.-]+)\/([A-Za-z0-9_$.-]+)$/.exec(p)
    if (rpc && req.method === 'POST') return handleRpc(req, res, `${rpc[1]}/${rpc[2]}`, access, instance, user.username)
    log(`deny ${user.username} ${req.method} ${p}`)
    return deny(res, 404)
  }

  async function handleRpc(req, res, method, access, instance, username) {
    let message
    try {
      message = JSON.parse((await readBody(req, MAX_RPC_BODY)).toString('utf8'))
    } catch {
      return deny(res, 400)
    }
    const rpcId = message?.rpcId
    const args = message?.payload?.args
    if (message?.type !== 'client-request' || message.method !== method || args === null || typeof args !== 'object') return deny(res, 400)
    const refuse = reason => (log(`deny ${username} ${method}: ${reason}`), rpcReply(res, rpcId, { ok: false, error: { code: 'gate/forbidden', message: `Gate: ${reason}.`, details: {} } }))

    if (method === '$events/result') {
      const key = `${args.clientId}|${args.eventId}`
      if (!access.grants.delete(key)) return refuse('câu trả lời không thuộc phiên của bạn')
      return forwardRpc(res, instance, method, message)
    }
    await sessions.ensure(collect(args).ids)
    const decision = checkCall(method, args, access)
    if ('fake' in decision) return rpcReply(res, rpcId, { ok: true, value: decision.fake })
    if (!decision.allow) return refuse(decision.reason)
    const outgoing = decision.args === undefined ? message : { ...message, payload: { ...message.payload, args: decision.args } }
    const reply = await forwardRpc(res, instance, method, outgoing, { capture: true })
    if (reply === undefined) return
    if (reply.result?.ok) {
      if (method === 'session/create') {
        const request = outgoing.payload.args.request
        const cwd = typeof request.cwd === 'string' ? request.cwd : access.workspacePath(request.workspaceId)
        sessions.learn(reply.result.value?.sessionId, cwd)
      }
      if (method === 'session/fork') sessions.learn(reply.result.value?.sessionId, sessions.cwdOf(args.request?.sessionId))
      reply.result.value = filterResult(method, reply.result.value, access)
    } else if (reply.result?.error) {
      // DSH error details can name other sessions' folders (e.g. session/conflict existingCwd).
      reply.result.error.details = {}
    }
    rpcSend(res, reply)
  }

  /** Send the (possibly rewritten) RPC upstream; with `capture`, return the parsed reply instead of piping it. */
  function forwardRpc(res, instance, method, message, { capture = false } = {}) {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    return new Promise(resolve => {
      const headers = { ...upstreamHeaders({ 'content-type': 'application/json' }, instance), 'content-length': body.length }
      const up = http.request({ host: '127.0.0.1', port: instance.port, method: 'POST', path: `/api/${method}`, headers }, upRes => {
        if (upRes.statusCode === 401) upstream.invalidate()
        if (!capture || upRes.statusCode !== 200) {
          res.writeHead(upRes.statusCode ?? 502, downstreamHeaders(upRes.headers, instance))
          upRes.pipe(res)
          return resolve(undefined)
        }
        const chunks = []
        upRes.on('data', c => chunks.push(c))
        upRes.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { deny(res, 502); resolve(undefined) }
        })
      })
      up.on('error', err => { log(`rpc ${method}: ${err.message}`); deny(res, 502); resolve(undefined) })
      up.end(body)
    })
  }

  // ---------------- WebSocket (/api/remote.mux) ----------------

  async function handleUpgrade(req, socket, head, user) {
    const instance = await upstream.get()
    track(user.username, socket)
    await ensureWorkspace(user).catch(() => {})
    if (user.role === 'admin') return proxyUpgrade(req, socket, head, instance)
    const url = new URL(req.url ?? '/', 'http://gate.local')
    if (url.pathname !== '/api/remote.mux') return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    relayMux(req, socket, head, instance, accessFor(user.username), user.username)
  }

  function relayMux(req, client, head, instance, access, username) {
    const upstreamSocket = net.connect(instance.port, '127.0.0.1')
    /** streamId → endpoint, for streams this user opened. */
    const streams = new Map()
    let clientId
    let established = false
    let chain = Promise.resolve()
    const close = () => { upstreamSocket.destroy(); client.destroy() }
    upstreamSocket.on('error', close)
    client.on('error', close)
    upstreamSocket.on('close', () => client.destroy())
    client.on('close', () => upstreamSocket.destroy())

    const toClient = obj => client.write(encodeFrame(OP.TEXT, JSON.stringify(obj)))
    const toUpstream = obj => upstreamSocket.write(encodeFrame(OP.TEXT, JSON.stringify(obj), { mask: true }))
    const streamError = (streamId, message) => (log(`deny ${username} mux ${streams.get(streamId) ?? streamId}: ${message}`), toClient({ type: 'error', streamId, error: { code: 'gate/forbidden', message: `Gate: ${message}.`, details: {} } }))

    // Handshake: same request, without compression (the relay reads every frame).
    upstreamSocket.once('connect', () => {
      const headers = upstreamHeaders(req.headers, instance, { keepUpgrade: true })
      delete headers['sec-websocket-extensions']
      let raw = `GET ${req.url} HTTP/1.1\r\n`
      for (const [name, value] of Object.entries(headers)) for (const v of [].concat(value)) raw += `${name}: ${v}\r\n`
      upstreamSocket.write(`${raw}\r\n`)
    })

    let handshake = Buffer.alloc(0)
    const fromUpstream = createDecoder(onUpstreamMessage, err => { log(`ws ${username}: ${err.message}`); close() })
    upstreamSocket.on('data', chunk => {
      if (established) return fromUpstream(chunk)
      handshake = Buffer.concat([handshake, chunk])
      const end = handshake.indexOf('\r\n\r\n')
      if (end < 0) return
      const head101 = handshake.subarray(0, end).toString('latin1')
      if (!/^HTTP\/1\.1 101/.test(head101)) { client.end(handshake); return upstreamSocket.destroy() }
      const lines = head101.split('\r\n').filter(l => !/^sec-websocket-extensions:/i.test(l) && !/^set-cookie:/i.test(l))
      client.write(`${lines.join('\r\n')}\r\n\r\n`)
      established = true
      if (head.length > 0) fromClient(head)
      for (const chunk of early.splice(0)) fromClient(chunk)
      const rest = handshake.subarray(end + 4)
      if (rest.length > 0) fromUpstream(rest)
    })

    const fromClient = createDecoder(msg => { chain = chain.then(() => onClientMessage(msg)).catch(err => { log(`ws ${username}: ${err.message}`); close() }) },
      err => { log(`ws ${username}: ${err.message}`); close() })
    const early = []
    client.on('data', chunk => { if (established) fromClient(chunk); else early.push(chunk) })

    async function onClientMessage({ opcode, data }) {
      if (opcode !== OP.TEXT) {
        if (opcode === OP.BINARY) return close()
        return upstreamSocket.write(encodeFrame(opcode, data, { mask: true }))
      }
      const frame = JSON.parse(data.toString('utf8'))
      if (frame?.type === 'cancel') {
        if (streams.has(frame.streamId)) toUpstream(frame)
        return
      }
      if (frame?.type !== 'open' || typeof frame.streamId !== 'string') return close()
      const args = frame.payload?.args ?? {}
      await sessions.ensure(collect(args).ids)
      const decision = checkOpen(frame.endpoint, args, access)
      if (!decision.allow) return streamError(frame.streamId, `${frame.endpoint}: ${decision.reason}`)
      streams.set(frame.streamId, frame.endpoint)
      toUpstream(frame)
    }

    function onUpstreamMessage({ opcode, data }) {
      if (opcode !== OP.TEXT) return client.write(encodeFrame(opcode, data))
      let frame
      try { frame = JSON.parse(data.toString('utf8')) } catch { return close() }
      const endpoint = streams.get(frame?.streamId)
      if (endpoint === undefined) return // not opened by this user (or already finished)
      if (frame.type === 'end' || frame.type === 'error') { streams.delete(frame.streamId); return toClient(frame) }
      if (frame.type !== 'item') return
      const value = frame.value
      if (endpoint === 'workspace/follow') learnWorkspaces(value)
      const streamAccess = {
        ...access,
        grantEvent: eventId => access.grants.add(`${clientId}|${eventId}`),
        hasEvent: eventId => access.grants.has(`${clientId}|${eventId}`),
      }
      if (endpoint === '$events' && value?.type === 'ready') clientId = value.clientId
      const result = filterItem(endpoint, value, streamAccess)
      if (result.keep) return toClient({ ...frame, value: result.value })
      if (endpoint === 'session/follow' && value?.type === 'snapshot') {
        // The session's folder is not this user's: end the stream on both sides.
        streams.delete(frame.streamId)
        toUpstream({ type: 'cancel', streamId: frame.streamId })
        streamError(frame.streamId, 'phiên không thuộc về bạn')
      }
    }
  }

  function learnWorkspaces(item) {
    const record = ws => { if (ws?.workspaceId && typeof ws.path === 'string') workspaces.set(ws.workspaceId, ws.path) }
    if (item?.type === 'baseline') for (const ws of item.value?.items ?? []) record(ws)
    if (item?.type === 'upsert') record(item.workspace)
  }

  return { handleHttp, handleUpgrade, accessFor, ensureWorkspace, disconnect, workspaces }
}

function rpcReply(res, rpcId, result) {
  rpcSend(res, { type: 'server-response', rpcId, result })
}

function rpcSend(res, reply) {
  const body = JSON.stringify(reply)
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function deny(res, status) {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(status === 404 ? 'not found' : status === 400 ? 'bad request' : status === 502 ? 'Gate: không kết nối được DSH' : 'Gate: không có quyền')
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
