/**
 * Ticket/proposal CLI for the Project 3 ticket agent: the worker (via docker exec) and the gate's
 * review page (same container) both go through here, so every write uses the stores' own checks.
 *
 *   node dist/cli/tickets.js list [--status open] [--limit 50]
 *   node dist/cli/tickets.js get TICK-101
 *   node dist/cli/tickets.js propose TICK-101          stdin: {config, model, sessionId, raw, payload, tokens, seconds}
 *   node dist/cli/tickets.js decide <proposalId>        stdin: {approve, reply, by, kb}
 *
 * Output: one JSON value on stdout; on error {"error": "..."} and exit code 1.
 * Env: DOCSHIELD_DB (default /var/docshield/docshield.db), DOCSHIELD_STORAGE_ROOT (default /data).
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../db/database.js'
import { ProposalStore, type ProposalRow } from '../db/proposals.js'
import { parseTicketCode, ticketCode, TicketError, TICKET_STATUS_LABEL, type TicketRow, type TicketStatus } from '../db/tickets.js'

const STATUSES = new Set<TicketStatus>(['open', 'in_progress', 'resolved', 'rejected'])

export function ticketJson(t: TicketRow) {
  return {
    code: ticketCode(t.id), id: t.id, userId: t.user_id, sessionId: t.session_id, question: t.question, reason: t.reason,
    status: t.status, statusLabel: TICKET_STATUS_LABEL[t.status], adminReply: t.admin_reply, createdAt: t.created_at, updatedAt: t.updated_at,
  }
}

export function proposalJson(p: ProposalRow) {
  return {
    id: p.id, config: p.config, model: p.model, sessionId: p.session_id, payload: p.payload === null ? null : JSON.parse(p.payload),
    raw: p.raw, tokens: p.tokens, seconds: p.seconds, status: p.status, finalReply: p.final_reply, kbFile: p.kb_file,
    decidedBy: p.decided_by, decidedAt: p.decided_at, createdAt: p.created_at,
  }
}

/** Approved answer as a Q&A document in public_docs, so the chatbot can find it next time ("bồi đắp"). */
export function kbDocument(t: TicketRow, reply: string, payload: unknown, date: string): string {
  const cites = Array.isArray((payload as { trich_dan?: unknown })?.trich_dan) ? (payload as { trich_dan: Array<Record<string, unknown>> }).trich_dan : []
  const lines = [`# Hỏi đáp ${ticketCode(t.id)}`, '', `Câu hỏi: ${t.question}`, '', `Trả lời (cán bộ đã duyệt ngày ${date.slice(0, 10)}): ${reply}`]
  if (cites.length > 0) {
    lines.push('', 'Căn cứ:')
    for (const c of cites) lines.push(`- ${String(c.file ?? '')}${c.vi_tri ? ` (${String(c.vi_tri)})` : ''}: "${String(c.nguyen_van ?? '')}"`)
  }
  return `${lines.join('\n')}\n`
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Buffer | string))
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const [cmd, arg, ...rest] = argv
  const db = openDatabase(env.DOCSHIELD_DB ?? '/var/docshield/docshield.db')
  try {
    const proposals = new ProposalStore(db)
    const ticketRow = (code: string | undefined) => {
      const id = parseTicketCode(code ?? '')
      const row = id === undefined ? undefined : db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined
      if (row === undefined) throw new TicketError(`Không tìm thấy phiếu ${code ?? ''}.`)
      return row
    }
    switch (cmd) {
      case 'list': {
        const args = [arg, ...rest].filter((a): a is string => a !== undefined)
        const status = flag(args, '--status')
        if (status !== undefined && !STATUSES.has(status as TicketStatus)) throw new TicketError(`Trạng thái không hợp lệ: ${status}`)
        const limit = Math.min(Number(flag(args, '--limit') ?? 100), 500)
        const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM ticket_proposals p WHERE p.ticket_id = t.id) AS n,
            (SELECT COUNT(*) FROM ticket_proposals p WHERE p.ticket_id = t.id AND p.status = 'draft') AS drafts
          FROM tickets t ${status ? 'WHERE t.status = ?' : ''} ORDER BY t.id DESC LIMIT ?`)
          .all(...(status ? [status, limit] : [limit])) as unknown as Array<TicketRow & { n: number; drafts: number }>
        return rows.map(r => ({ ...ticketJson(r), proposals: r.n, drafts: r.drafts }))
      }
      case 'get': {
        const t = ticketRow(arg)
        return { ticket: ticketJson(t), proposals: proposals.forTicket(t.id).map(proposalJson) }
      }
      case 'propose': {
        const input = await readStdin() as Record<string, unknown>
        if (typeof input.raw !== 'string' || typeof input.config !== 'string') throw new TicketError('cần raw và config')
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
        const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
        const p = proposals.add(arg ?? '', {
          config: input.config, raw: input.raw, payload: input.payload, model: str(input.model), sessionId: str(input.sessionId),
          tokens: num(input.tokens), seconds: num(input.seconds),
        })
        return proposalJson(p)
      }
      case 'decide': {
        const input = await readStdin() as Record<string, unknown>
        const id = Number(arg)
        const p = Number.isInteger(id) ? proposals.get(id) : undefined
        if (p === undefined) throw new TicketError(`Không có đề xuất #${arg ?? ''}.`)
        const approve = input.approve === true
        const reply = typeof input.reply === 'string' ? input.reply : ''
        const by = typeof input.by === 'string' && input.by !== '' ? input.by : 'admin'
        const kbFile = approve && input.kb === true ? `hoi-dap-tick-${p.ticket_id}.md` : undefined
        const result = proposals.decide(id, { approve, reply, by, kbFile })
        if (kbFile !== undefined) {
          const root = env.DOCSHIELD_STORAGE_ROOT ?? '/data'
          writeFileSync(path.join(root, 'public_docs', kbFile), kbDocument(result.ticket, reply.trim(), p.payload === null ? null : JSON.parse(p.payload), result.proposal.decided_at ?? ''))
        }
        return { ticket: ticketJson(result.ticket), proposal: proposalJson(result.proposal) }
      }
      default:
        throw new TicketError('lệnh: list | get <mã> | propose <mã> | decide <id>')
    }
  } finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    value => { process.stdout.write(`${JSON.stringify(value)}\n`) },
    error => { process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1 },
  )
}
