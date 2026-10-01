/**
 * The one shared DSH behind the gate. Its launch URL
 * (`http://127.0.0.1:<port>/?token=…`, handed over by the dsh-gate plugin)
 * is traded once for DSH's auth cookie, which the proxy attaches to every
 * upstream request; browsers never see either. The token stays valid for the
 * life of that DSH process, so a rejected cookie is simply traded again.
 */
import http from 'node:http'

export class Upstream {
  /** @param {string} launchUrl DSH root URL with its `token` query parameter */
  constructor(launchUrl) {
    const url = new URL(launchUrl)
    const token = url.searchParams.get('token')
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !token) {
      throw new Error('GATE_UPSTREAM_URL must be http://127.0.0.1:<port>/?token=…')
    }
    this.port = Number(url.port)
    this.origin = `http://127.0.0.1:${url.port}`
    this.token = token
    /** @type {Promise<string> | undefined} */
    this.pending = undefined
  }

  /** `{ port, origin, cookie }` for the proxy; the first call trades the token. */
  async get() {
    this.pending ??= exchangeToken(this.origin, this.token).catch(err => { this.pending = undefined; throw err })
    return { port: this.port, origin: this.origin, cookie: await this.pending }
  }

  /** DSH answered 401: forget the cookie so the next request trades the token again. */
  invalidate() {
    this.pending = undefined
  }
}

/** GET /?token=… → 303 with Set-Cookie dsh-auth-*; returns "name=value" for later requests. */
export function exchangeToken(origin, token) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${origin}/?token=${encodeURIComponent(token)}`, res => {
      res.resume()
      const cookies = res.headers['set-cookie'] ?? []
      const auth = cookies.map(c => c.split(';')[0]).find(c => c.startsWith('dsh-auth-'))
      if (auth === undefined) reject(new Error(`token exchange failed: HTTP ${res.statusCode}, no dsh-auth cookie`))
      else resolve(auth)
    })
    req.on('error', reject)
  })
}
