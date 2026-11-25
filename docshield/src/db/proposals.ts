/**
 * Proposals from the ticket agent (Project 3): the agent drafts, an admin decides.
 * A draft lives only here; the asker sees nothing until `decide` writes the
 * approved (possibly edited) reply into tickets.admin_reply.
 */
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './database.js'
import { parseTicketCode, ticketCode, TicketError, type TicketRow } from './tickets.js'

export type ProposalStatus = 'draft' | 'approved' | 'rejected'

export interface ProposalRow {
  readonly id: number
  readonly ticket_id: number
  readonly config: string
  readonly model: string | null
  readonly session_id: string | null
  readonly payload: string | null
  readonly raw: string
  readonly tokens: number | null
  readonly seconds: number | null
  readonly status: ProposalStatus
  readonly final_reply: string | null
  readonly kb_file: string | null
  readonly decided_by: string | null
  readonly decided_at: string | null
  readonly created_at: string
}

export interface NewProposal {
  readonly config: string
  readonly model?: string | undefined
  readonly sessionId?: string | undefined
  /** The agent's whole final answer. */
  readonly raw: string
  /** The JSON proposal parsed from `raw`, or null when the agent produced none. */
  readonly payload?: unknown
  readonly tokens?: number | undefined
  readonly seconds?: number | undefined
}

export interface Decision {
  readonly approve: boolean
  /** Text sent to the asker: the edited answer when approving, the reason when rejecting. */
  readonly reply: string
  readonly by: string
  readonly kbFile?: string | undefined
}

const CONFIG_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/

export class ProposalStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Store a draft; an open ticket moves to in_progress so the worker does not pick it again. */
  add(code: string, input: NewProposal): ProposalRow {
    const id = parseTicketCode(code)
    if (id === undefined) throw new TicketError(`Mã phiếu không hợp lệ: ${code}`)
    if (!CONFIG_PATTERN.test(input.config)) throw new TicketError(`Cấu hình không hợp lệ: ${input.config}`)
    return transaction(this.db, () => {
      const ticket = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined
      if (ticket === undefined) throw new TicketError(`Không tìm thấy phiếu ${ticketCode(id)}.`)
      const row = this.db.prepare(`
        INSERT INTO ticket_proposals (ticket_id, config, model, session_id, payload, raw, tokens, seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
        id, input.config, input.model ?? null, input.sessionId ?? null,
        input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
        input.raw, input.tokens ?? null, input.seconds ?? null) as unknown as ProposalRow
      if (ticket.status === 'open') {
        this.db.prepare(`UPDATE tickets SET status = 'in_progress', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(id)
      }
      return row
    })
  }

  forTicket(ticketId: number): ProposalRow[] {
    return this.db.prepare('SELECT * FROM ticket_proposals WHERE ticket_id = ? ORDER BY id').all(ticketId) as unknown as ProposalRow[]
  }

  get(id: number): ProposalRow | undefined {
    return this.db.prepare('SELECT * FROM ticket_proposals WHERE id = ?').get(id) as ProposalRow | undefined
  }

  /**
   * Approve (ticket → resolved with `reply`) or reject (ticket → rejected, `reply` = reason).
   * Only a draft of a ticket that is not closed yet can be decided.
   */
  decide(proposalId: number, d: Decision): { proposal: ProposalRow; ticket: TicketRow } {
    const reply = d.reply.trim()
    if (reply === '') throw new TicketError(d.approve ? 'Câu trả lời gửi người hỏi không được để trống.' : 'Từ chối cần ghi lý do gửi người hỏi.')
    return transaction(this.db, () => {
      const p = this.get(proposalId)
      if (p === undefined) throw new TicketError(`Không có đề xuất #${proposalId}.`)
      if (p.status !== 'draft') throw new TicketError(`Đề xuất #${proposalId} đã được quyết định.`)
      const ticket = this.db.prepare(`
        UPDATE tickets SET status = ?, admin_reply = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND status NOT IN ('resolved', 'rejected') RETURNING *`).get(
        d.approve ? 'resolved' : 'rejected', reply, p.ticket_id) as TicketRow | undefined
      if (ticket === undefined) throw new TicketError(`Phiếu ${ticketCode(p.ticket_id)} đã đóng.`)
      const proposal = this.db.prepare(`
        UPDATE ticket_proposals SET status = ?, final_reply = ?, kb_file = ?, decided_by = ?,
          decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? RETURNING *`).get(d.approve ? 'approved' : 'rejected', reply, d.kbFile ?? null, d.by, proposalId) as unknown as ProposalRow
      return { proposal, ticket }
    })
  }
}
