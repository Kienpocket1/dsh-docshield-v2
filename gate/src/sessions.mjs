/**
 * Which folder each DSH session works in (session id → cwd). DSH's session
 * list is the source of truth; the gate asks for it (with its own cookie) when
 * it meets an id it does not know, at most once per `minRefreshMs`, and also
 * learns ids from the traffic it relays (workspace views, `api-session/added`,
 * successful `session/create`). Subagent sessions inherit their parent's cwd.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'

/**
 * Call one unary RPC on the shared DSH as the gate itself (no filtering).
 * @param {{ get(): Promise<{ port: number, cookie: string }>, invalidate(): void }} upstream
 * @returns {Promise<any>} the `value` of an ok result
 */
export async function callUpstream(upstream, method, args) {
  const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } })
  for (let attempt = 0; attempt < 2; attempt++) {
    const { port, cookie } = await upstream.get()
    const { status, text } = await post(port, `/api/${method}`, body, cookie)
    if (status === 401 && attempt === 0) { upstream.invalidate(); continue }
    if (status !== 200) throw new Error(`DSH ${method}: HTTP ${status}`)
    const reply = JSON.parse(text)
    if (!reply?.result?.ok) throw new Error(`DSH ${method}: ${reply?.result?.error?.message ?? 'lỗi'}`)
    return reply.result.value
  }
  throw new Error(`DSH ${method}: unauthorized`)
}

function post(port, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const authority = `127.0.0.1:${port}`
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: urlPath,
      headers: { host: authority, origin: `http://${authority}`, cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

export class SessionIndex {
  /**
   * @param {(method: string, args: object) => Promise<any>} call unfiltered upstream RPC
   * @param {{ minRefreshMs?: number, now?: () => number }} [opts]
   */
  constructor(call, { minRefreshMs = 2000, now = Date.now } = {}) {
    this.call = call
    this.minRefreshMs = minRefreshMs
    this.now = now
    /** @type {Map<string, string>} */
    this.cwd = new Map()
    this.lastRefresh = -Infinity
    /** @type {Promise<void> | undefined} */
    this.refreshing = undefined
  }

  /** Synchronous lookup: the cwd, or undefined when unknown. */
  cwdOf(sessionId) {
    return typeof sessionId === 'string' ? this.cwd.get(sessionId) : undefined
  }

  learn(sessionId, cwd) {
    if (typeof sessionId === 'string' && typeof cwd === 'string' && cwd !== '') this.cwd.set(sessionId, cwd)
  }

  /** Make sure every id is known if DSH knows it; refreshes at most once per window. */
  async ensure(ids) {
    if (ids.every(id => typeof id !== 'string' || this.cwd.has(id))) return
    await this.refresh()
  }

  refresh() {
    if (this.refreshing) return this.refreshing
    if (this.now() - this.lastRefresh < this.minRefreshMs) return Promise.resolve()
    this.lastRefresh = this.now()
    this.refreshing = this.call('session/list', { _request: {} })
      .then(value => {
        const items = value?.items ?? []
        const byId = new Map(items.map(s => [s.sessionId, s]))
        for (const s of items) {
          // A subagent summary may omit cwd: walk up to the root session.
          let cur = s
          for (let hops = 0; cur && typeof cur.cwd !== 'string' && cur.parentSessionId && hops < 16; hops++) cur = byId.get(cur.parentSessionId)
          if (cur && typeof cur.cwd === 'string') this.learn(s.sessionId, cur.cwd)
        }
      })
      .finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
}
