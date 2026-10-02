import path from 'node:path'
import { USER_ID_PATTERN, type DocScope } from './scope.js'

/** Host row configuration (`cordis.yml` → `docshield-core.config`). */
export interface CoreConfig {
  /** Absolute storage root holding `users/<u>`, `admin`, `public_docs`, `.docshield`. */
  readonly storageRoot: string
  /** Coarse cosine floor for search candidates (bge-m3). Default 0.45. */
  readonly minSimilarity: number
  /** Default number of passages returned by scoped_doc_search. Default 5. */
  readonly topK: number
  /**
   * Set by dsh-gate for a per-user DSH instance: the instance belongs to this
   * user (or to the admin), so scope no longer comes from the session cwd, the
   * instance indexes only its own area, and its workspace is registered.
   */
  readonly identity?: DocScope
  /** Shared embedding service (`scripts/embed-server.mjs`); unset = in-process bge-m3 worker. */
  readonly embedUrl?: string
  /**
   * Host DocShield service (`scripts/docshield-server.mjs`) for a container
   * instance: tools and uploads go there with the token from DOCSHIELD_TOKEN,
   * and this instance opens no database. Requires `identity`.
   */
  readonly serviceUrl?: string
  /**
   * Let the harness tools (shell, files, search…) run beside DocShield's. Only
   * where something contains them: a per-user container (`serviceUrl`) or the
   * exec-router tool sandbox (`toolSandbox`). DocShield's admin tools stay admin-only.
   */
  readonly allowOtherTools?: boolean
  /** The DSH runs every agent tool in per-user tool containers (exec-router plugin). */
  readonly toolSandbox?: boolean
  /** Absolute database file; default `<storageRoot>/.docshield/docshield.db`. */
  readonly dbFile?: string
}

export const DEFAULT_MIN_SIMILARITY = 0.45
export const DEFAULT_TOP_K = 5

/** Preset row configuration (`agent.cordis.yml` → `docshield-tools.config`). */
export interface ToolsConfig {
  readonly role: 'user' | 'admin'
}

/**
 * Validate the host row configuration. `DOCSHIELD_STORAGE_ROOT` overrides the
 * file value so a deployment can move storage without editing the bundle.
 * @throws when no absolute storage root is available.
 */
export function resolveCoreConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const fromFile = isRecord(raw) && typeof raw.storageRoot === 'string' ? raw.storageRoot : undefined
  const storageRoot = env.DOCSHIELD_STORAGE_ROOT?.trim() || fromFile
  if (storageRoot === undefined || storageRoot === '' || !path.isAbsolute(storageRoot)) {
    throw new Error('docshield: config.storageRoot must be an absolute path')
  }
  const minSimilarity = isRecord(raw) && typeof raw.minSimilarity === 'number' ? raw.minSimilarity : DEFAULT_MIN_SIMILARITY
  const topK = isRecord(raw) && typeof raw.topK === 'number' ? raw.topK : DEFAULT_TOP_K
  if (!(minSimilarity >= 0 && minSimilarity < 1)) throw new Error('docshield: config.minSimilarity must be in [0, 1)')
  if (!Number.isInteger(topK) || topK < 1 || topK > 8) throw new Error('docshield: config.topK must be an integer in 1..8')
  const identity = resolveIdentity(isRecord(raw) ? raw.identity : undefined)
  const embedUrl = localUrl(raw, 'embedUrl')
  const serviceUrl = localUrl(raw, 'serviceUrl')
  if (serviceUrl !== undefined && identity === undefined) throw new Error('docshield: config.serviceUrl requires config.identity')
  const allowOtherTools = isRecord(raw) && raw.allowOtherTools === true
  const toolSandbox = isRecord(raw) && raw.toolSandbox === true
  // Without a container around them those tools would run on the host: refuse rather than open it.
  if (allowOtherTools && serviceUrl === undefined && !toolSandbox) throw new Error('docshield: config.allowOtherTools is only allowed with serviceUrl or toolSandbox')
  const dbFile = isRecord(raw) && typeof raw.dbFile === 'string' && raw.dbFile !== '' ? raw.dbFile : undefined
  if (dbFile !== undefined && !path.isAbsolute(dbFile)) throw new Error('docshield: config.dbFile must be an absolute path')
  return {
    storageRoot: path.resolve(storageRoot),
    minSimilarity,
    topK,
    ...(identity !== undefined ? { identity } : {}),
    ...(embedUrl !== undefined ? { embedUrl } : {}),
    ...(serviceUrl !== undefined ? { serviceUrl } : {}),
    ...(allowOtherTools ? { allowOtherTools } : {}),
    ...(toolSandbox ? { toolSandbox } : {}),
    ...(dbFile !== undefined ? { dbFile: path.resolve(dbFile) } : {}),
  }
}

/** An http URL on this machine; host.docker.internal = this machine as seen from a per-user container. */
function localUrl(raw: unknown, key: 'embedUrl' | 'serviceUrl'): string | undefined {
  const value = isRecord(raw) && typeof raw[key] === 'string' && raw[key] !== '' ? raw[key] as string : undefined
  if (value !== undefined && !/^http:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)(:\d+)?(\/|$)/.test(value)) {
    throw new Error(`docshield: config.${key} must be a loopback (or host.docker.internal) http URL`)
  }
  return value
}

/** `{ user: '<id>' }` → user scope, `{ role: 'admin' }` → admin; absent → cwd-based identity. */
function resolveIdentity(raw: unknown): DocScope | undefined {
  if (raw === undefined || raw === null) return undefined
  if (isRecord(raw) && raw.role === 'admin') return { role: 'admin' }
  if (isRecord(raw) && (raw.role === undefined || raw.role === 'user') && typeof raw.user === 'string' && USER_ID_PATTERN.test(raw.user)) {
    return { role: 'user', userId: raw.user }
  }
  throw new Error(`docshield: config.identity must be { user: "<id>" } or { role: "admin" } (got ${JSON.stringify(raw)})`)
}

/** @throws when `role` is missing or unknown, so a broken preset fails loudly at mount. */
export function resolveToolsConfig(raw: unknown): ToolsConfig {
  const role = isRecord(raw) ? raw.role : undefined
  if (role !== 'user' && role !== 'admin') {
    throw new Error(`docshield-tools: config.role must be "user" or "admin" (got ${JSON.stringify(role)})`)
  }
  return { role }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
