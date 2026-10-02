// retryTransient: a tool container whose launcher is not listening yet must not fail the call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { retryTransient } from '../src/retry.mjs'

const connect = port => new Promise((resolve, reject) => {
  const s = net.connect({ host: '127.0.0.1', port })
  s.once('connect', () => resolve(s))
  s.once('error', reject)
})

async function freePort() {
  const srv = net.createServer()
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  await new Promise(r => srv.close(r))
  return port
}

test('waits for a server that starts listening late (real ECONNREFUSED)', async () => {
  const port = await freePort()
  const srv = net.createServer(s => s.end())
  setTimeout(() => srv.listen(port, '127.0.0.1'), 700)
  const waits = []
  const socket = await retryTransient(() => connect(port), { timeoutMs: 5000, intervalMs: 100, onWait: c => waits.push(c) })
  socket.destroy()
  srv.close()
  assert.deepEqual(waits, ['ECONNREFUSED'])
})

test('gives up at the deadline', async () => {
  const port = await freePort()
  const t0 = Date.now()
  await assert.rejects(retryTransient(() => connect(port), { timeoutMs: 500, intervalMs: 100 }), { code: 'ECONNREFUSED' })
  assert.ok(Date.now() - t0 < 2000)
})

test('does not retry other errors', async () => {
  let calls = 0
  await assert.rejects(retryTransient(async () => { calls++; throw Object.assign(new Error('bad token'), { code: 'EPROTO' }) }, { timeoutMs: 5000 }), /bad token/)
  assert.equal(calls, 1)
})
