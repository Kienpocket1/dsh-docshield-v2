/**
 * Storage layout ↔ ingestion targets.
 *   users/<u>/docs/<file>        → scope 'user:<u>'
 *   users/<u>/<wsp>/docs/<file>  → scope 'user:<u>', key prefixed by <wsp> (one workspace level)
 *   public_docs/<file>     → scope 'public'
 * Only direct children with an already-safe name are indexed; anything else
 * under the root is ignored.
 */
import path from 'node:path'
import type { DocScope } from '../scope.js'
import { USER_ID_PATTERN } from '../scope.js'
import type { IngestTarget } from './indexer.js'
import { docKeyFromFilename, sanitizeFilename } from './sanitize.js'

export const PUBLIC_SCOPE = 'public'
export const userScope = (userId: string) => `user:${userId}`

/** Workspace folder name under users/<u>; same rule as user ids (no dots, so never `docs` traversal tricks). */
const WORKSPACE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Where uploads from a session of this scope land: users → `<workspace>/docs`
 * when the session cwd is `users/<u>/<wsp>[/…]`, else `users/<u>/docs`; admin → public_docs.
 */
export function uploadDirFor(storageRoot: string, scope: DocScope, cwd?: string): { dir: string; partition: string } {
  if (scope.role !== 'user') return { dir: path.join(storageRoot, 'public_docs'), partition: PUBLIC_SCOPE }
  const userDir = path.join(storageRoot, 'users', scope.userId)
  const wsp = cwd === undefined ? undefined : workspaceOf(userDir, cwd)
  return { dir: path.join(userDir, ...(wsp === undefined ? [] : [wsp]), 'docs'), partition: userScope(scope.userId) }
}

/** First folder of `cwd` below `userDir`, if it is a valid workspace name other than `docs`. */
function workspaceOf(userDir: string, cwd: string): string | undefined {
  const rel = path.relative(path.resolve(userDir), path.resolve(cwd))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  const first = rel.split(path.sep)[0]!
  return first !== 'docs' && WORKSPACE_PATTERN.test(first) ? first : undefined
}

/**
 * Maps a file to what should be indexed for it, after bindings: `null` means
 * "do not index" (not a document path, or a retired public file).
 */
export type TargetResolver = (file: string) => IngestTarget | null

export interface BindingLookup {
  get(filename: string): { readonly doc_key: string; readonly state: 'bound' | 'retired' } | undefined
}

export function bindingResolver(storageRoot: string, bindings: BindingLookup): TargetResolver {
  return (file) => {
    const target = targetForPath(storageRoot, file)
    if (target === null || target.scope !== PUBLIC_SCOPE) return target
    const binding = bindings.get(target.filename)
    if (binding === undefined) return target
    return binding.state === 'retired' ? null : { ...target, docKey: binding.doc_key }
  }
}

/** Layout-only mapping (no bindings): which scope and filename-derived key a path has. */
export function targetForPath(storageRoot: string, file: string): IngestTarget | null {
  const rel = path.relative(path.resolve(storageRoot), path.resolve(file))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(path.sep)
  let scope: string
  let filename: string
  let prefix = ''
  if (parts.length === 4 && parts[0] === 'users' && parts[2] === 'docs' && USER_ID_PATTERN.test(parts[1]!)) {
    scope = userScope(parts[1]!)
    filename = parts[3]!
  } else if (parts.length === 5 && parts[0] === 'users' && parts[3] === 'docs' && USER_ID_PATTERN.test(parts[1]!)
    && parts[2] !== 'docs' && WORKSPACE_PATTERN.test(parts[2]!)) {
    // Workspace docs share the user's scope; the prefix keeps same-named files in two workspaces apart.
    scope = userScope(parts[1]!)
    filename = parts[4]!
    prefix = `${parts[2]}__`
  } else if (parts.length === 2 && parts[0] === 'public_docs') {
    scope = PUBLIC_SCOPE
    filename = parts[1]!
  } else {
    return null
  }
  try {
    if (sanitizeFilename(filename) !== filename) return null
  } catch {
    return null
  }
  return { scope, docKey: docKeyFromFilename(prefix + filename), filename, path: path.resolve(file) }
}
