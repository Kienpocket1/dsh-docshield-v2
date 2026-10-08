/**
 * Host-side file access to the storage tree that a user (or, later, their
 * agent inside a container) can write to. Such a tree may contain symlinks or
 * junctions pointing outside it, and they can be swapped at any moment, so a
 * "check the path, then open it" sequence is racy (TOCTOU).
 *
 * The rule here is "open first, then verify what was opened": the file handle
 * is compared (device + inode) with the file its real path names, and that
 * real path must lie inside the real storage root. Reads go through the
 * verified handle only. Directory listings skip symlinks and junctions.
 */
import { lstat, mkdir, open, readdir, readlink, realpath, stat, unlink, chmod, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

export class UnsafePathError extends Error {
  readonly code = 'UNSAFE_PATH'
  constructor(message: string) {
    super(message)
    this.name = 'UnsafePathError'
  }
}

/** `target` is `root` or below it (both already real paths); case-insensitive on Windows. */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * Open `file` for reading only if it is a regular file whose real location is
 * inside `root`, and is still the very file that was opened.
 * @returns the open handle (caller closes it) and its size
 * @throws UnsafePathError on a symlink/junction leading outside, a swapped file, or a non-file
 */
export async function openVerified(root: string, file: string): Promise<{ handle: FileHandle; size: number }> {
  const handle = await open(file, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) throw new UnsafePathError('Không phải tệp thông thường.')
    const realRoot = await realpath(root)
    // Linux (production): the kernel names the file this handle really is; no path is walked again.
    const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)
    if (actual !== undefined) {
      if (!isWithin(realRoot, actual)) throw new UnsafePathError('Tệp trỏ ra ngoài vùng lưu trữ.')
      return { handle, size: Number(opened.size) }
    }
    // Elsewhere: realpath and stat walk the path again, so a folder flipping between real and
    // link can line both up with the opened file. Require the real path to hold still around
    // the stat. ponytail: narrows the race on Windows (dev only) without closing it.
    const realFile = await realpath(file)
    if (!isWithin(realRoot, realFile)) throw new UnsafePathError('Tệp trỏ ra ngoài vùng lưu trữ.')
    const named = await stat(realFile, { bigint: true })
    if (named.dev !== opened.dev || named.ino !== opened.ino || (await realpath(file)) !== realFile) {
      throw new UnsafePathError('Tệp bị thay đổi trong lúc mở.')
    }
    return { handle, size: Number(opened.size) }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Whole content of a verified file, refusing anything larger than `maxBytes`. */
export async function readVerified(root: string, file: string, maxBytes: number): Promise<Uint8Array> {
  const { handle, size } = await openVerified(root, file)
  try {
    if (size > maxBytes) throw new UnsafePathError('Tệp quá lớn.')
    return new Uint8Array(await handle.readFile())
  } finally {
    await handle.close()
  }
}

/** A directory that is not a link and whose real path is inside `root`. */
async function isSafeDir(root: string, dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) return false
    const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)])
    return isWithin(realRoot, realDir)
  } catch {
    return false
  }
}

/** Names of the plain files (or, with `dirs`, plain sub-folders) of `dir`; links and junctions are skipped. */
export async function listSafe(root: string, dir: string, { dirs = false } = {}): Promise<string[]> {
  if (!(await isSafeDir(root, dir))) return []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(e => !e.isSymbolicLink() && (dirs ? e.isDirectory() : e.isFile())).map(e => e.name)
  } catch {
    return []
  }
}

/** True when `file` itself is a symlink or junction (never followed). */
export async function isLink(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Write `bytes` as `dir/name` inside `root`, replacing an existing plain file
 * of that name. Never writes through a link: the folder must be a real folder
 * inside the root, and the file is created exclusively (`wx`), which fails if
 * anything — including a freshly planted symlink — appears at that name.
 */
export async function writeInside(root: string, dir: string, name: string, bytes: Uint8Array): Promise<string> {
  await mkdir(dir, { recursive: true })
  if (!(await isSafeDir(root, dir))) throw new UnsafePathError('Thư mục tải lên trỏ ra ngoài vùng lưu trữ.')
  const dest = path.join(dir, name)
  const existing = await lstat(dest).catch(() => undefined)
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new UnsafePathError('Đã có một liên kết hoặc thư mục trùng tên tệp.')
    // DSH stores attachments read-only and copies keep the mode; Windows refuses to delete those.
    await chmod(dest, 0o644).catch(() => undefined)
    await unlink(dest)
  }
  const handle = await open(dest, 'wx', 0o644)
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
  return dest
}
