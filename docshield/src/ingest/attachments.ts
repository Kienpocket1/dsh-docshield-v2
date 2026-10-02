/**
 * Chat uploads → documents. When a user message in a DocShield session
 * carries file parts, copy each admitted file from DSH's attachment store
 * into the session scope's upload folder and index it:
 *   users/<u> session → users/<u>/docs (personal)
 *   admin session     → public_docs    (public)
 */
import { readFile } from 'node:fs/promises'
import type { SessionView } from '../dsh-types.js'
import { resolveScope, type ScopeOptions } from '../scope.js'
import type { IngestResult, Indexer } from './indexer.js'
import { uploadDirFor, type TargetResolver } from './layout.js'
import { writeInside } from './safe-fs.js'
import { assertSize, resolveInside, sanitizeFilename } from './sanitize.js'

export interface FileAttachmentRef {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

export interface AttachmentsView {
  fileHostPath(ref: FileAttachmentRef): string | undefined
}

export interface IngestedUpload {
  readonly filename: string
  readonly result: IngestResult | { readonly status: 'rejected'; readonly error: string }
}

interface MessageEvent {
  readonly type: string
  readonly data?: { readonly content?: readonly unknown[] }
}

/** File parts of a `user/message` event, or [] for anything else. */
export function fileParts(event: MessageEvent): FileAttachmentRef[] {
  if (event.type !== 'user/message') return []
  const refs: FileAttachmentRef[] = []
  for (const part of event.data?.content ?? []) {
    if (typeof part !== 'object' || part === null) continue
    const { type, attachment } = part as { type?: unknown; attachment?: unknown }
    if (type !== 'file' || typeof attachment !== 'object' || attachment === null) continue
    const ref = attachment as Partial<FileAttachmentRef>
    if (typeof ref.attachmentId === 'string' && typeof ref.name === 'string' && typeof ref.bytes === 'number') {
      refs.push(ref as FileAttachmentRef)
    }
  }
  return refs
}

export async function ingestUploads(
  session: SessionView,
  refs: readonly FileAttachmentRef[],
  deps: {
    storageRoot: string
    attachments: AttachmentsView
    indexer: Indexer
    resolve: TargetResolver
    /** Fixed identity of a per-user instance; default: scope from the session cwd. */
    scopeOptions?: ScopeOptions
    /** Called once a file is admitted and copied, before indexing (which can take minutes). */
    onAccepted?: (filename: string) => void
  },
): Promise<IngestedUpload[]> {
  const { scope } = resolveScope(session.header.cwd, deps.storageRoot, deps.scopeOptions)
  if (scope === null || refs.length === 0) return []
  const { dir } = uploadDirFor(deps.storageRoot, scope)
  const results: IngestedUpload[] = []
  for (const ref of refs) {
    let filename = ref.name
    try {
      filename = sanitizeFilename(ref.name)
      assertSize(ref.bytes)
      const source = deps.attachments.fileHostPath(ref)
      if (source === undefined) throw new Error('Không tìm thấy file đính kèm trong kho của DSH.')
      const dest = resolveInside(dir, filename)
      // Decide before copying, so a retired public file is never overwritten or revived.
      const target = deps.resolve(dest)
      if (target === null) {
        throw new Error('Tên file này thuộc một tài liệu chung đã bị thay thế; hãy đổi tên file hoặc dùng publish_public_doc.')
      }
      // The source is DSH's own attachment store; the destination is written
      // without ever following a link planted in the user's folder.
      await writeInside(deps.storageRoot, dir, filename, new Uint8Array(await readFile(source)))
      deps.onAccepted?.(filename)
      const result = await deps.indexer.ingest(target)
      results.push({ filename, result })
    } catch (error) {
      results.push({ filename, result: { status: 'rejected', error: error instanceof Error ? error.message : String(error) } })
    }
  }
  return results
}

/** One-line Vietnamese summary for the agent's next request. */
export function describeUploads(uploads: readonly IngestedUpload[]): string {
  const lines = uploads.map(({ filename, result }) => {
    switch (result.status) {
      case 'indexed': return `- ${filename}: đã nạp (${result.chunks} đoạn${result.superseded > 0 ? ', thay bản cũ' : ''})`
      case 'unchanged': return `- ${filename}: nội dung không đổi, giữ bản đã nạp`
      case 'failed': return `- ${filename}: nạp thất bại — ${result.error}`
      case 'rejected': return `- ${filename}: bị từ chối — ${result.error}`
      case 'removed': return `- ${filename}: đã gỡ`
    }
  })
  return `[DocShield] Kết quả nạp tài liệu đính kèm:\n${lines.join('\n')}`
}
