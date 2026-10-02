/**
 * DocShield host row (`docshield-core`): publishes the `docshield` service,
 * installs the global tool guard, keeps the index in step with storage, and
 * ingests files attached in DocShield sessions. Tools mount per agent through
 * the `docshield` / `docshield-admin` presets (see `./tools`).
 *
 * With `serviceUrl` (dsh-gate docker mode) this row runs inside a per-user
 * container and is only a client: the host DocShield service owns the
 * database, the watcher and indexing.
 */
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCoreConfig, type CoreConfig } from './config.js'
import type { AgentHandleView, DocShieldBackend, DshContext, SessionView } from './dsh-types.js'
import { createGuard } from './guard.js'
import { describeUploads, fileParts, ingestUploads, type AttachmentsView, type FileAttachmentRef, type IngestedUpload } from './ingest/attachments.js'
import { assertSize } from './ingest/sanitize.js'
import { RemoteDocShield } from './remote/client.js'
import { workspaceFor } from './scope.js'
import { DocShieldService } from './service.js'

export const name = 'docshield-core'

/** Store and index the attached files of one message; `onAccepted` fires before (possibly long) indexing. */
type IngestAttachments = (
  session: SessionView,
  refs: readonly FileAttachmentRef[],
  attachments: AttachmentsView,
  onAccepted: (filename: string) => void,
) => Promise<IngestedUpload[]>

export function apply(ctx: DshContext, rawConfig?: unknown): void {
  const config = resolveCoreConfig(rawConfig)
  if (config.serviceUrl !== undefined) {
    applyRemote(ctx, config, config.serviceUrl)
    return
  }
  const service = new DocShieldService(config.storageRoot, {
    minSimilarity: config.minSimilarity,
    topK: config.topK,
    ...(config.identity !== undefined ? { identity: config.identity } : {}),
    ...(config.embedUrl !== undefined ? { embedUrl: config.embedUrl } : {}),
    ...(config.dbFile !== undefined ? { dbFile: config.dbFile } : {}),
  })
  ctx.effect(() => () => service.dispose(), 'docshield: service lifetime')
  mountCommon(ctx, config, service, service.log, (session, refs, attachments, onAccepted) =>
    ingestUploads(session, refs, { storageRoot: config.storageRoot, attachments, indexer: service.indexer, resolve: service.resolve, scopeOptions: service.scopeOptions, onAccepted }))

  // Watch first: a file written while the (possibly minutes-long) reconcile runs would otherwise be
  // missed until the next restart. Both paths go through the indexer's serial queue and its hash check.
  service.watcher.start()
  void service.watcher.reconcile()
    .catch(error => service.log(`startup reconcile failed: ${error instanceof Error ? error.message : String(error)}`))
}

function applyRemote(ctx: DshContext, config: CoreConfig, serviceUrl: string): void {
  const token = process.env.DOCSHIELD_TOKEN?.trim()
  if (!token) throw new Error('docshield: config.serviceUrl is set but DOCSHIELD_TOKEN is empty')
  // resolveCoreConfig guarantees identity alongside serviceUrl.
  const backend = new RemoteDocShield(config.storageRoot, config.identity!, serviceUrl, token)
  mountCommon(ctx, config, backend, backend.log, async (_session, refs, attachments, onAccepted) => {
    const results: IngestedUpload[] = []
    for (const ref of refs) {
      try {
        assertSize(ref.bytes)
        const source = attachments.fileHostPath(ref)
        if (source === undefined) throw new Error('Không tìm thấy file đính kèm trong kho của DSH.')
        const bytes = await readFile(source)
        onAccepted(ref.name)
        results.push(await backend.upload(ref.name, bytes))
      } catch (error) {
        results.push({ filename: ref.name, result: { status: 'rejected', error: error instanceof Error ? error.message : String(error) } })
      }
    }
    return results
  })
}

/** Service, guard, the per-user workspace and upload handling: the same in both modes. */
function mountCommon(ctx: DshContext, config: CoreConfig, backend: DocShieldBackend, log: (message: string) => void, ingest: IngestAttachments): void {
  ctx.provide('docshield', backend)

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => toolsCtx.tools.guard(createGuard(config.storageRoot, backend.scopeOptions, config.allowOtherTools === true)), 'docshield: tool guard')
  })

  // Per-user instance: make sure its one workspace exists and is listed in the sidebar.
  const identity = config.identity
  if (identity !== undefined) {
    ctx.inject(['workspaceRegistry'], (wsCtx) => {
      const registry = wsCtx.get('workspaceRegistry') as WorkspaceRegistryView
      const folder = workspaceFor(config.storageRoot, identity)
      void ensureWorkspace(registry, folder, identity.role === 'admin' ? 'DocShield Admin' : `DocShield · ${identity.userId}`)
        .catch(error => log(`workspace registration failed: ${error instanceof Error ? error.message : String(error)}`))
    })
  }

  ctx.on('session/event', (session, event) => {
    const refs = fileParts(event)
    if (refs.length === 0) return
    const attachments = ctx.get('attachments') as AttachmentsView | undefined
    if (attachments === undefined) {
      log('attachments service unavailable; upload not ingested')
      return
    }
    const onAccepted = (filename: string) => {
      log(`nhận file đính kèm ${filename} (phiên ${session.id})`)
      notifyAgent(ctx, session.id, `[DocShield] Đã nhận "${filename}" và đang nạp. Tài liệu dài có thể mất vài phút; trong lúc đó list_documents hiện "đang nạp" kèm tiến độ. Đừng kết luận là tài liệu bị thiếu — hãy báo người dùng chờ nạp xong.`)
    }
    void ingest(session, refs, attachments, onAccepted)
      .then((uploads) => {
        if (uploads.length === 0) return
        const summary = describeUploads(uploads)
        log(summary.replaceAll('\n', ' | '))
        notifyAgent(ctx, session.id, summary)
      })
      .catch(error => log(`upload ingest failed: ${error instanceof Error ? error.message : String(error)}`))
  })
}

/** Tell the session's agent what happened to its uploads (seen on its next request). Best effort. */
function notifyAgent(ctx: DshContext, sessionId: string, text: string): void {
  try {
    const agents = ctx.get('agents') as { get?(id: string): AgentHandleView | undefined } | undefined
    agents?.get?.(sessionId)?.inject?.({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'docshield' } })
  } catch {
    // The agent may be idle-disposed; list_documents still shows the result.
  }
}

interface WorkspaceRegistryView {
  resolveByPath(path: string): Promise<unknown>
  create(path: string, title?: string): Promise<unknown>
}

async function ensureWorkspace(registry: WorkspaceRegistryView, folder: string, title: string): Promise<void> {
  await mkdir(path.join(folder, 'docs'), { recursive: true })
  if (await registry.resolveByPath(folder) === undefined) await registry.create(folder, title)
}
