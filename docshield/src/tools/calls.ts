/**
 * What each DocShield tool does, given an already-established caller scope.
 * The same table runs inside a DSH instance (local mode) and inside the host
 * DocShield service (docker mode, `src/server`), where the scope comes from
 * the gate-issued token instead of the session.
 */
import { TICKET_STATUS_LABEL, TicketError, type TicketStatus } from '../db/tickets.js'
import { ADMIN_TOOLS, USER_TOOLS } from '../guard.js'
import type { DocScope } from '../scope.js'
import { PublishError, type DocShieldService } from '../service.js'
import { ArgumentError, optionalInt, requireCitations, requireString } from './args.js'

export interface CallContext {
  readonly scope: DocScope
  /** Evidence ledger key: search hits are remembered per session for citation checks. */
  readonly sessionId: string
}

export type DocCall = (args: Record<string, unknown>, call: CallContext) => Promise<unknown>

/** Executes one tool call on behalf of `call.scope`; implemented locally or over HTTP. */
export type DocInvoke = (name: string, args: Record<string, unknown>, call: CallContext) => Promise<unknown>

const STATUSES = Object.keys(TICKET_STATUS_LABEL) as TicketStatus[]

/** Ticket owner id for a scope: the user id, or 'admin' for the admin workspace. */
const ownerOf = (scope: DocScope) => (scope.role === 'user' ? scope.userId : 'admin')

function optionalStatus(args: Record<string, unknown>, key: string): TicketStatus | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !STATUSES.includes(value as TicketStatus)) {
    throw new ArgumentError(`"${key}" phải là một trong: ${STATUSES.join(', ')}.`)
  }
  return value as TicketStatus
}

async function asArgumentError<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof PublishError || error instanceof TicketError) throw new ArgumentError(error.message)
    throw error
  }
}

export function docCalls(service: DocShieldService): Record<string, DocCall> {
  return {
    list_documents: async (_args, { scope }) => {
      const documents = service.listDocuments(scope)
      return { count: documents.length, documents }
    },
    my_access: async (_args, { scope }) => {
      if (scope.role !== 'user') throw new ArgumentError('DocShield: công cụ này chỉ dành cho người dùng.')
      const documents = service.listDocuments(scope)
      const tickets = service.tickets.list({ userId: scope.userId })
      return {
        role: 'người dùng',
        userId: scope.userId,
        dataScope: 'Tài liệu chung và tài liệu cá nhân của bạn; không xem được dữ liệu của người khác.',
        allowedTools: [...USER_TOOLS],
        deniedFunctions: ['Xem hoặc xử lý phiếu hỗ trợ của người khác', 'Công bố hoặc nạp lại tài liệu chung', 'Trang quản trị /gate/admin'],
        documents: {
          personal: documents.filter(d => d.scope === 'cá nhân').length,
          public: documents.filter(d => d.scope === 'chung').length,
        },
        tickets: { total: tickets.length, open: tickets.filter(t => t.status === 'open' || t.status === 'in_progress').length },
      }
    },
    scoped_doc_search: async (args, { scope, sessionId }) => {
      const query = requireString(args, 'query', { max: 1000 })
      const k = optionalInt(args, 'k', 1, 8)
      return service.search(sessionId, scope, query, k)
    },
    answer_with_evidence: async (args, { scope, sessionId }) => {
      const answer = requireString(args, 'answer', { max: 4000 })
      const citations = requireCitations(args)
      return { answer, evidence: service.verify(sessionId, scope, citations) }
    },
    create_support_ticket: async (args, { scope, sessionId }) => {
      const question = requireString(args, 'question', { max: 2000 })
      const reason = requireString(args, 'reason', { max: 1000 })
      return service.tickets.create({ userId: ownerOf(scope), sessionId, question, reason })
    },
    check_ticket_status: async (args, { scope }) => {
      const code = requireString(args, 'code', { max: 20 })
      // Users only ever see their own tickets; a foreign code looks exactly like a missing one.
      const ticket = service.tickets.get(code, scope.role === 'admin' ? undefined : scope.userId)
      return ticket === undefined ? { found: false, code } : { found: true, ticket }
    },
    list_tickets: async (args) => {
      const status = optionalStatus(args, 'status')
      const tickets = service.tickets.list(status === undefined ? {} : { status })
      return { count: tickets.length, tickets }
    },
    update_ticket: async (args) => {
      const code = requireString(args, 'code', { max: 20 })
      const status = optionalStatus(args, 'status')
      if (status === undefined) throw new ArgumentError('Thiếu "status".')
      const reply = args.reply === undefined || args.reply === null ? undefined : requireString(args, 'reply', { max: 2000 })
      return asArgumentError(() => ({ ticket: service.tickets.update(code, status, reply) }))
    },
    publish_public_doc: async (args) => {
      const filename = requireString(args, 'filename', { max: 200 })
      const docKey = requireString(args, 'doc_key', { max: 64 })
      const replaces = typeof args.replaces === 'string' && args.replaces.trim() !== '' ? args.replaces.trim() : undefined
      return asArgumentError(() => service.publishPublic(filename, docKey, replaces))
    },
    reindex_document: async (args) => {
      const docKey = requireString(args, 'doc_key', { max: 64 })
      const result = await asArgumentError(() => service.reindexPublic(docKey))
      return { docKey, result }
    },
  }
}

/**
 * Run one call after checking the tool exists and the scope's role may use it.
 * The host service calls this with the token's scope, so a container cannot
 * reach admin tools by claiming a role.
 */
export function invokeWith(calls: Record<string, DocCall>): DocInvoke {
  return async (name, args, call) => {
    const allowed = call.scope.role === 'admin' ? ADMIN_TOOLS : USER_TOOLS
    const run = Object.hasOwn(calls, name) ? calls[name] : undefined
    if (run === undefined || !allowed.has(name)) {
      throw new ArgumentError(`DocShield: công cụ "${name}" không dành cho vai trò ${call.scope.role === 'admin' ? 'Admin' : 'người dùng'}.`)
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new ArgumentError('DocShield: tham số công cụ phải là object.')
    }
    return run(args, call)
  }
}
