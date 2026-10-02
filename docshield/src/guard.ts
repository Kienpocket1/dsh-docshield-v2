/**
 * Global monotonic tool guard. Inside the DocShield storage tree only the
 * DocShield tools of the session's role may run, whatever preset the session
 * uses — this still holds if the owner ticks `standard` for a subuser by mistake.
 * Sessions outside the storage tree are left to their own policy.
 */
import path from 'node:path'
import type { ToolExecutionView, ToolGuard } from './dsh-types.js'
import { resolveScope, type ScopeOptions } from './scope.js'

export const USER_TOOLS: ReadonlySet<string> = new Set([
  'scoped_doc_search',
  'answer_with_evidence',
  'create_support_ticket',
  'check_ticket_status',
  'list_documents',
])

export const ADMIN_TOOLS: ReadonlySet<string> = new Set([
  ...USER_TOOLS,
  'list_tickets',
  'update_ticket',
  'publish_public_doc',
  'reindex_document',
])

/**
 * @param allowOtherTools per-user container (sandbox S4): shell, file and the
 *   other harness tools run inside the container's own sandbox, so only the
 *   DocShield tools stay role-checked here. Never set outside a container.
 */
export function createGuard(storageRoot: string, options: ScopeOptions = {}, allowOtherTools = false): ToolGuard {
  return (exec: Readonly<ToolExecutionView>) => {
    const cwd = exec.agent?.session.header.cwd
    const { inside, scope } = resolveScope(cwd, storageRoot, options)
    if (!inside) return undefined
    // Tool sandbox only: the admin's "all users" workspace (<root>/users, read-only and offline in
    // its tool container; only admins get it) runs harness tools but no DocShield tool.
    if (scope === null && allowOtherTools && isUsersRoot(cwd, storageRoot)) {
      return ADMIN_TOOLS.has(exec.name) ? 'DocShield: công cụ DocShield không dùng trong workspace xem dữ liệu người dùng.' : undefined
    }
    if (scope === null) {
      return 'DocShield: phiên này không nằm trong workspace hợp lệ (storage/users/<tên> hoặc storage/admin); mọi công cụ bị chặn.'
    }
    const allowed = scope.role === 'admin' ? ADMIN_TOOLS : USER_TOOLS
    if (allowed.has(exec.name)) return undefined
    if (allowOtherTools && !ADMIN_TOOLS.has(exec.name)) return undefined
    return `DocShield: công cụ "${exec.name}" không được phép trong workspace DocShield.`
  }
}

/** `cwd` is exactly `<storageRoot>/users` (case-insensitive on Windows). */
function isUsersRoot(cwd: string | undefined, storageRoot: string): boolean {
  if (typeof cwd !== 'string' || cwd === '') return false
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  return norm(cwd) === norm(path.join(storageRoot, 'users'))
}
