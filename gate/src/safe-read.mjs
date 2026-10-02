/**
 * `/api/file` for normal users, served by the gate itself: DSH would follow
 * any symlink or junction a user (or their agent) planted in their folder.
 * Same rule as docshield/src/ingest/safe-fs.ts — open first, then verify that
 * the opened file (device + inode) is the one its real path names, and that
 * this real path lies inside the user's real folder. Bytes come from the
 * verified handle only.
 */
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_BYTES = 50 * 1024 * 1024
const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.csv': 'text/csv; charset=utf-8',
}
/** User files never run as part of the app's origin (an uploaded .html or .svg could carry script). */
const FILE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  'cache-control': 'no-store',
}

const within = (root, target) => {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * Stream `file` to `res` if it is safely inside `root`; otherwise answer 403/404.
 * @returns true when served
 */
export async function serveVerified(root, file, req, res) {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return false
  }
  try {
    const opened = await handle.stat({ bigint: true })
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)])
    const named = await stat(realFile, { bigint: true })
    if (!opened.isFile() || !within(realRoot, realFile) || named.dev !== opened.dev || named.ino !== opened.ino || opened.size > BigInt(MAX_BYTES)) {
      await handle.close()
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Gate: không có quyền')
      return false
    }
    const type = TYPES[path.extname(realFile).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { ...FILE_HEADERS, 'content-type': type, 'content-length': String(opened.size) })
    if (req.method === 'HEAD') { await handle.close(); res.end(); return true }
    const stream = handle.createReadStream({ autoClose: true })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return true
  } catch {
    await handle.close().catch(() => {})
    if (!res.headersSent) res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end()
    return false
  }
}
