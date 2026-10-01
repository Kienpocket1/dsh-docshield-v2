/** Test doubles for the gate app: one fixed upstream and a filter that relays everything unchanged. */
import { proxyHttp, proxyUpgrade } from '../src/proxy.mjs'

/** @param {number} port fake DSH port */
export function passthrough(port, { cookie = 'dsh-auth-x=1', disconnected = [] } = {}) {
  const instance = { port, origin: `http://127.0.0.1:${port}`, cookie }
  const upstream = { get: async () => instance, invalidate() {} }
  const seenUsers = []
  const filter = {
    handleHttp: async (req, res, user) => { seenUsers.push(user.username); proxyHttp(req, res, instance) },
    handleUpgrade: async (req, socket, head, user) => { seenUsers.push(user.username); proxyUpgrade(req, socket, head, instance) },
    disconnect: username => { disconnected.push(username) },
  }
  return { upstream, filter, seenUsers }
}

/** Upstream that must never be reached. */
export const unused = {
  upstream: { get: async () => { throw new Error('unused') }, invalidate() {} },
  filter: { handleHttp: async () => { throw new Error('unused') }, handleUpgrade: async () => { throw new Error('unused') } },
}
