/**
 * Per-user rules for one shared DSH (0.1.6-alpha.2 wire format). A normal
 * user owns exactly the sessions whose cwd lies inside
 * `<storageRoot>/users/<name>`; admins are never filtered. Everything not
 * listed here is refused (fail closed).
 *
 * This module is pure: ownership questions go through an `Access` object
 * (see filter.mjs), so the rules are testable without a DSH.
 *
 * @typedef {object} Access
 * @property {string} root                       the user's folder, absolute
 * @property {(p: unknown) => boolean} inRoot     path inside the user's folder
 * @property {(id: unknown) => boolean} owns      session id whose cwd is inside the folder
 */
import path from 'node:path'

/** Read-only endpoints with Host-global data the UI needs; no user data in them. */
const GLOBAL = new Set([
  'session/modelCatalog', 'session/canOpenWorkspacePath',
  'permissionPresets/catalog', 'agentPresets/list',
  'llm/listProviders', 'llm/listConfigurableProviders', 'pluginInventory/list',
  'settings/describe', 'settings/canOpenAgentPresetDirectory', 'credentials/describe',
  'dynamicCordisRunner/inventory', 'officeToPdf/generation',
])

/** Endpoints acting on one or more sessions: every session id in the args must be owned. */
const SESSION_SCOPED = new Set([
  'session/selectModel', 'session/rename', 'session/fork', 'session/prompt', 'session/attachment',
  'session/updateQueue', 'session/cancel', 'session/page',
  'workspace/archiveSession', 'workspace/unarchiveSession',
  'commands/list', 'commands/execute', 'fileReferences/list', 'fileUploads/upload', 'skills/list',
  'subagents/list', 'subagents/prompt', 'subagents/interruptByParent',
  'messageFeedback/list', 'messageFeedback/put', 'messageFeedback/delete', 'sessionFeedback/record',
  'goals/get', 'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear',
  'sessionReferenceResolver/candidates',
])
// workspaceFiles/* is refused for normal users: DSH reads those paths on the host and would follow
// links in the user's folder. It returns once the tool sandbox reads files inside the user's container.

/** Mux streams a normal user may open. */
const STREAMS = new Set(['$events', 'workspace/follow', 'session/control', 'session/follow'])

/** Arg keys that carry a session id anywhere in a request. */
const ID_KEYS = new Set(['sessionId', 'agentId', 'parentSessionId', 'childSessionId', 'workspaceFileScopeId'])
/** Arg keys that carry a filesystem path. */
const PATH_KEYS = new Set(['path', 'cwd', 'relativePath'])
/** Large payload fields never searched for ids (message content, file data). */
const SKIP_KEYS = new Set(['content', 'data', 'text', 'submittedAttachments'])

/** The agent preset every normal-user session runs (DocShield tools only). */
export const USER_PRESET = 'docshield'

/** Case-insensitive on Windows; `child` equal to `root` counts as inside. */
export function isInside(root, child) {
  if (typeof child !== 'string' || child === '' || !path.isAbsolute(child)) return false
  const norm = p => {
    const r = path.resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  const a = norm(root)
  const b = norm(child)
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep)
}

/** Every value under an id key, and every value under a path key, in a request's args. */
export function collect(args) {
  const ids = []
  const paths = []
  const walk = (value, depth) => {
    if (depth > 6 || value === null || typeof value !== 'object') return
    for (const [key, v] of Object.entries(value)) {
      if (SKIP_KEYS.has(key)) continue
      if (ID_KEYS.has(key) && typeof v === 'string') ids.push(v)
      else if (PATH_KEYS.has(key) && typeof v === 'string') paths.push(v)
      else if (key === 'address' && v && typeof v === 'object') {
        for (const k of ['sessionId', 'parentSessionId', 'childSessionId']) if (typeof v[k] === 'string') ids.push(v[k])
      } else walk(v, depth + 1)
    }
  }
  walk(args, 0)
  return { ids, paths }
}

/**
 * Decide on one unary call from a normal user.
 * @param {string} method `<ns>/<method>`
 * @param {Record<string, any>} args the request's `payload.args`
 * @param {Access & { workspacePath(id: unknown): string | undefined }} access
 * @returns {{ allow: true, args?: object } | { allow: false, reason: string } | { fake: unknown }}
 */
export function checkCall(method, args, access) {
  if (GLOBAL.has(method)) return { allow: true }
  if (method === 'terminal/list') return { fake: [] }
  // The UI pushes its inspector manifest at boot (a developer tool); accept and drop it.
  if (method === 'dynamicCordisRunner/syncInspectManifest') return { fake: undefined }
  if (method === 'session/list' || method === 'session/search') return { allow: true } // responses are filtered
  if (method === 'session/create') return checkCreate(args, access)
  if (method === 'directoryPicker/list') {
    const request = args?.request ?? args
    const wanted = request?.path
    if (wanted === undefined || wanted === null) return { allow: true, args: rewritePath(args, access.root) }
    return access.inRoot(wanted) ? { allow: true } : { allow: false, reason: 'thư mục ngoài vùng của bạn' }
  }
  if (method === 'directoryPicker/createDirectory') {
    const { paths } = collect(args)
    return paths.length > 0 && paths.every(access.inRoot) ? { allow: true } : { allow: false, reason: 'thư mục ngoài vùng của bạn' }
  }
  if (SESSION_SCOPED.has(method)) {
    const { ids, paths } = collect(args)
    if (ids.length === 0) return { allow: false, reason: 'thiếu mã phiên' }
    if (!ids.every(access.owns)) return { allow: false, reason: 'phiên không thuộc về bạn' }
    if (method === 'workspaceFiles/readRelated' || method.startsWith('workspaceFiles/')) {
      const absolute = paths.filter(p => path.isAbsolute(p))
      if (!absolute.every(access.inRoot)) return { allow: false, reason: 'tệp ngoài vùng của bạn' }
      if (paths.some(p => !path.isAbsolute(p) && p.split(/[\\/]/).includes('..'))) return { allow: false, reason: 'đường dẫn không hợp lệ' }
    }
    return { allow: true }
  }
  return { allow: false, reason: `chức năng ${method} không dành cho tài khoản thường` }
}

/** New sessions only inside the user's folder, always with the DocShield preset; no adopting old ids. */
function checkCreate(args, access) {
  const request = args?.request
  if (!request || typeof request !== 'object') return { allow: false, reason: 'yêu cầu không hợp lệ' }
  const cwd = typeof request.cwd === 'string' ? request.cwd : access.workspacePath(request.workspaceId)
  if (cwd === undefined || !access.inRoot(cwd)) return { allow: false, reason: 'chỉ được tạo phiên trong thư mục của bạn' }
  // A client-chosen id may name an existing session elsewhere (DSH would adopt it or leak its cwd).
  if (request.sessionId !== undefined && !access.owns(request.sessionId) && access.known?.(request.sessionId)) {
    return { allow: false, reason: 'mã phiên không hợp lệ' }
  }
  return { allow: true, args: { ...args, request: { ...request, agentPreset: USER_PRESET } } }
}

function rewritePath(args, root) {
  if (args?.request && typeof args.request === 'object') return { ...args, request: { ...args.request, path: root } }
  return { ...args, path: root }
}

/** Trim a unary result to what the user owns. */
export function filterResult(method, value, access) {
  if (value === null || typeof value !== 'object') return value
  if (method === 'session/list') {
    return { ...value, items: (value.items ?? []).filter(s => access.inRoot(s.cwd) || access.owns(s.sessionId)) }
  }
  if (method === 'session/search') return { ...value, items: (value.items ?? []).filter(s => access.owns(s.sessionId)) }
  if (method === 'workspace/archiveSession' || method === 'workspace/unarchiveSession') {
    return { ...value, archivedSessionIds: (value.archivedSessionIds ?? []).filter(access.owns) }
  }
  if (method === 'sessionReferenceResolver/candidates' && Array.isArray(value)) return value.filter(c => access.owns(c?.sessionId))
  if (method === 'sessionReferenceResolver/candidates' && Array.isArray(value.items)) {
    return { ...value, items: value.items.filter(c => access.owns(c?.sessionId)) }
  }
  return value
}

/**
 * Decide on a mux stream open from a normal user.
 * @returns {{ allow: true } | { allow: false, reason: string }}
 */
export function checkOpen(endpoint, args, access) {
  if (!STREAMS.has(endpoint)) return { allow: false, reason: `luồng ${endpoint} không dành cho tài khoản thường` }
  if (endpoint === 'session/follow') {
    const { ids } = collect(args)
    if (ids.length === 0 || !ids.every(access.owns)) return { allow: false, reason: 'phiên không thuộc về bạn' }
  }
  return { allow: true }
}

/** Global UI-refresh notifications that carry no user data. */
const GLOBAL_EMITS = new Set(['commands/change', 'llm/adapters-updated', 'permission-presets/catalog-changed', 'settings/document-updated', 'credentials/reference-updated'])
/** Host waterfalls a user answers for their own sessions. */
const USER_WATERFALLS = new Set(['approval/request', 'user-questions/request'])

/**
 * Filter one item of an open stream for a normal user.
 * @param {string} endpoint
 * @param {any} item the frame's `value`
 * @param {Access & { learn(sessionId: string, cwd: string): void }} access
 * @returns {{ keep: false } | { keep: true, value: any }}
 */
export function filterItem(endpoint, item, access) {
  if (item === null || typeof item !== 'object') return { keep: false }
  switch (endpoint) {
    case 'workspace/follow': return filterWorkspace(item, access)
    case 'session/control': return filterControl(item, access)
    case 'session/follow':
      if (item.type === 'snapshot') return isInsideHeader(item.header, access) ? { keep: true, value: item } : { keep: false }
      return { keep: true, value: item }
    case '$events': return filterEvent(item, access)
    default: return { keep: false }
  }
}

const isInsideHeader = (header, access) => header && (access.inRoot(header.cwd) || access.owns(header.id))

function filterWorkspace(item, access) {
  const view = ws => {
    for (const id of ws.sessionIds ?? []) access.learn(id, ws.path)
    return ws
  }
  if (item.type === 'baseline') {
    const items = (item.value?.items ?? []).filter(ws => access.inRoot(ws.path)).map(view)
    const archivedSessionIds = (item.value?.archivedSessionIds ?? []).filter(access.owns)
    return { keep: true, value: { ...item, value: { ...item.value, items, archivedSessionIds } } }
  }
  if (item.type === 'upsert') return access.inRoot(item.workspace?.path) ? { keep: true, value: { ...item, workspace: view(item.workspace) } } : { keep: false }
  if (item.type === 'remove') return access.ownsWorkspace?.(item.workspaceId) ? { keep: true, value: item } : { keep: false }
  if (item.type === 'order') return { keep: true, value: { ...item, workspaceIds: (item.workspaceIds ?? []).filter(id => access.ownsWorkspace?.(id)) } }
  if (item.type === 'archived') return { keep: true, value: { ...item, archivedSessionIds: (item.archivedSessionIds ?? []).filter(access.owns) } }
  return { keep: false }
}

function filterControl(item, access) {
  if (item.type === 'baseline') {
    const pick = record => Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => access.owns(id)))
    return { keep: true, value: { ...item, value: { ...item.value, jobs: pick(item.value?.jobs), projections: pick(item.value?.projections) } } }
  }
  return access.owns(item.sessionId) ? { keep: true, value: item } : { keep: false }
}

function filterEvent(item, access) {
  if (item.type === 'ready') return { keep: true, value: item }
  if (item.type === 'waterfall') {
    if (!USER_WATERFALLS.has(item.event) || !access.owns(item.agentId)) return { keep: false }
    access.grantEvent?.(item.eventId)
    return { keep: true, value: item }
  }
  if (item.type === 'cancel') return access.hasEvent?.(item.eventId) ? { keep: true, value: item } : { keep: false }
  if (item.type !== 'emit') return { keep: false }
  const [first] = item.args ?? []
  if (GLOBAL_EMITS.has(item.event)) return { keep: true, value: item }
  if (item.event === 'api-session/added') {
    if (!first || !access.inRoot(first.cwd)) return { keep: false }
    access.learn(first.sessionId, first.cwd)
    return { keep: true, value: item }
  }
  if (item.event.startsWith('api-session/') || item.event === 'agent-preset/selected') return access.owns(first) ? { keep: true, value: item } : { keep: false }
  if (item.event === 'goal/activation-changed') return access.owns(first?.sessionId) ? { keep: true, value: item } : { keep: false }
  return { keep: false }
}
