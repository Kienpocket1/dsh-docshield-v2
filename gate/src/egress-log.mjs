/**
 * Internet access log written by the egress proxy (container/egress-proxy.mjs),
 * shown on /gate/admin. Read-only, bounded, and never fatal: a missing or
 * garbled file just hides the section.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const TAIL_BYTES = 512 * 1024

/** Last `limit` well-formed entries (newest first) from the JSONL file, or undefined when it cannot be read. */
export function readEgressLog(file, limit = 200) {
  if (!file) return undefined
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift() // first line may be cut in half
    const entries = []
    for (const line of lines) {
      if (!line) continue
      try {
        const e = JSON.parse(line)
        if (e && typeof e === 'object' && typeof e.t === 'string' && typeof e.zone === 'string') entries.push(e)
      } catch { /* skip */ }
    }
    return entries.slice(-limit).reverse()
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Account shown for a proxy zone. */
export const zoneLabel = zone => (zone.startsWith('user:') ? zone.slice(5) : zone === 'admin' ? 'admin (khu quản trị)' : zone === '-' ? '(không xác thực)' : zone)

/** Per-zone totals over entries newer than `sinceMs`: requests, denied, bytes up/down. */
export function summarize(entries, sinceMs) {
  const by = new Map()
  for (const e of entries) {
    if (Date.parse(e.t) < sinceMs) continue
    const s = by.get(e.zone) ?? { zone: e.zone, requests: 0, denied: 0, up: 0, down: 0 }
    s.requests++
    if (e.deny) s.denied++
    s.up += Number(e.up) || 0
    s.down += Number(e.down) || 0
    by.set(e.zone, s)
  }
  return [...by.values()].sort((a, b) => b.requests - a.requests)
}
