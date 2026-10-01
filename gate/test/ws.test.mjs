import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OP, createDecoder, encodeFrame } from '../src/ws.mjs'

const decodeAll = (bytes, chunkSize = bytes.length) => {
  const out = []
  const feed = createDecoder(m => out.push(m), err => { throw err })
  for (let i = 0; i < bytes.length; i += chunkSize) feed(bytes.subarray(i, i + chunkSize))
  return out
}

describe('websocket framing', () => {
  it('round-trips masked and unmasked frames of every length class, split arbitrarily', () => {
    for (const len of [0, 5, 125, 126, 300, 65535, 70000]) {
      const text = 'x'.repeat(len)
      for (const mask of [false, true]) {
        const msgs = decodeAll(encodeFrame(OP.TEXT, text, { mask }), 7)
        assert.equal(msgs.length, 1)
        assert.equal(msgs[0].opcode, OP.TEXT)
        assert.equal(msgs[0].data.toString(), text)
      }
    }
  })
  it('joins fragments and passes control frames through in order', () => {
    const first = encodeFrame(OP.TEXT, 'hel')
    first[0] &= 0x7f // fin = 0
    const ping = encodeFrame(OP.PING, 'p')
    const last = encodeFrame(OP.CONT, 'lo')
    const msgs = decodeAll(Buffer.concat([first, ping, last]), 3)
    assert.deepEqual(msgs.map(m => [m.opcode, m.data.toString()]), [[OP.PING, 'p'], [OP.TEXT, 'hello']])
  })
  it('rejects compressed frames', () => {
    const frame = encodeFrame(OP.TEXT, 'a')
    frame[0] |= 0x40
    const errors = []
    createDecoder(() => {}, e => errors.push(e))(frame)
    assert.equal(errors.length, 1)
  })
})
