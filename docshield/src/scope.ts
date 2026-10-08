/**
 * Identity by workspace: dsh-passwords only lets a subuser open sessions whose
 * cwd lies in that subuser's allowed folder, so the session cwd is the trusted
 * identity carrier.
 *
 *   <storageRoot>/users/<u>[/...]  → user <u>
 *   <storageRoot>/admin[/...]      → admin (only the owner is granted this folder)
 *   anything else under the root   → inside, but no valid scope (deny)
 *   outside the root               → not a DocShield session
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'

/** Same character set dsh-passwords accepts for usernames, lower-cased by provisioning. */
export const USER_ID_PATTERN = /^[a-z0-9_-]{3,32}$/

export type DocScope =
  | { readonly role: 'user'; readonly userId: string }
  | { readonly role: 'admin' }

export interface ScopeResolution {
  /** The cwd lies under the storage root. */
  readonly inside: boolean
  /** Valid DocShield scope, or `null` when outside or malformed. */
  readonly scope: DocScope | null
}

export interface ScopeOptions {
  readonly platform?: NodeJS.Platform
  /** Resolves symlinks/junctions; defaults to `realpathSync.native`, falling back to the input. */
  readonly realpath?: (p: string) => string
  /**
   * Fixed identity of a per-user DSH instance (set by dsh-gate). Every session
   * of the instance then has this scope, whatever its cwd: the gate, not the
   * folder, says who the user is.
   */
  readonly identity?: DocScope
}

const OUTSIDE: ScopeResolution = { inside: false, scope: null }
const INVALID: ScopeResolution = { inside: true, scope: null }

export function resolveScope(
  cwd: string | undefined,
  storageRoot: string,
  options: ScopeOptions = {},
): ScopeResolution {
  if (options.identity !== undefined) return { inside: true, scope: options.identity }
  if (cwd === undefined || cwd === '') return OUTSIDE
  const p = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  const real = options.realpath ?? defaultRealpath
  // The gate and the tool router judge a session by its cwd as written; a link inside it may
  // point anywhere (another user's folder, admin). Both readings must agree, or no scope at all.
  const written = classify(p, p.resolve(storageRoot), p.resolve(cwd))
  const resolved = classify(p, p.resolve(real(storageRoot)), p.resolve(real(cwd)))
  return sameResolution(written, resolved) ? written : INVALID
}

function classify(p: path.PlatformPath, root: string, target: string): ScopeResolution {
  // path.win32.relative compares case-insensitively, matching NTFS semantics.
  const rel = p.relative(root, target)
  if (rel === '') return INVALID
  if (rel === '..' || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) return OUTSIDE

  const [area, owner] = rel.split(p.sep)
  if (area === undefined) return INVALID
  const areaKey = area.toLowerCase()
  if (areaKey === 'admin') return { inside: true, scope: { role: 'admin' } }
  if (areaKey === 'users' && owner !== undefined && USER_ID_PATTERN.test(owner)) {
    return { inside: true, scope: { role: 'user', userId: owner } }
  }
  return INVALID
}

function sameResolution(a: ScopeResolution, b: ScopeResolution): boolean {
  if (a.inside !== b.inside) return false
  if (a.scope === null || b.scope === null) return a.scope === b.scope
  if (a.scope.role !== b.scope.role) return false
  return a.scope.role === 'admin' || a.scope.userId.toLowerCase() === (b.scope as { userId: string }).userId.toLowerCase()
}

/** Workspace folder of a scope: `users/<u>` or `admin`. */
export function workspaceFor(storageRoot: string, scope: DocScope): string {
  return scope.role === 'user' ? path.join(storageRoot, 'users', scope.userId) : path.join(storageRoot, 'admin')
}

/** Search partitions a scope may read: users see public plus their own; admin sees public. */
export function readableScopes(scope: DocScope): string[] {
  return scope.role === 'user' ? ['public', `user:${scope.userId}`] : ['public']
}

function defaultRealpath(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}
