/**
 * Minimal RFC 6455 framing for a message-level WebSocket relay (no
 * extensions: the gate strips Sec-WebSocket-Extensions, so frames are never
 * compressed). Browser→gate frames are masked, gate→DSH frames must be masked,
 * DSH→gate and gate→browser frames are not.
 */
import { randomBytes } from 'node:crypto'

export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }
const MAX_MESSAGE = 64 * 1024 * 1024

/** Encode one frame (fin set). */
export function encodeFrame(opcode, payload, { mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8')
  const len = data.length
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10
  const out = Buffer.alloc(head + (mask ? 4 : 0) + len)
  out[0] = 0x80 | opcode
  if (len < 126) out[1] = len
  else if (len < 65536) { out[1] = 126; out.writeUInt16BE(len, 2) } else { out[1] = 127; out.writeBigUInt64BE(BigInt(len), 2) }
  if (!mask) { data.copy(out, head); return out }
  out[1] |= 0x80
  const key = randomBytes(4)
  key.copy(out, head)
  for (let i = 0; i < len; i++) out[head + 4 + i] = data[i] ^ key[i & 3]
  return out
}

/**
 * Incremental decoder: feed raw bytes, receive whole messages (fragments
 * joined) and control frames, in order.
 * @param {(msg: { opcode: number, data: Buffer }) => void} onMessage
 * @param {(err: Error) => void} onError
 */
export function createDecoder(onMessage, onError) {
  let buffer = Buffer.alloc(0)
  let fragments = []
  let fragOpcode = 0
  let fragBytes = 0
  return function feed(chunk) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0
      const rsv = buffer[0] & 0x70
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let len = buffer[1] & 0x7f
      let offset = 2
      if (rsv !== 0) return onError(new Error('websocket: unexpected RSV bits'))
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4 } else if (len === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE)) return onError(new Error('websocket: frame too large'))
        len = Number(big); offset = 10
      }
      const total = offset + (masked ? 4 : 0) + len
      if (buffer.length < total) return
      let data = buffer.subarray(offset + (masked ? 4 : 0), total)
      if (masked) {
        const key = buffer.subarray(offset, offset + 4)
        data = Buffer.from(data)
        for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3]
      } else data = Buffer.from(data)
      buffer = buffer.subarray(total)
      if (opcode >= 0x8) { onMessage({ opcode, data }); continue }
      if (opcode !== OP.CONT) { fragments = []; fragOpcode = opcode; fragBytes = 0 }
      fragments.push(data)
      fragBytes += data.length
      if (fragBytes > MAX_MESSAGE) return onError(new Error('websocket: message too large'))
      if (fin) {
        const whole = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
        fragments = []
        onMessage({ opcode: fragOpcode, data: whole })
      }
    }
  }
}
