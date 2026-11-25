import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli/tickets.js'
import { openDatabase } from '../src/db/database.js'
import { ProposalStore } from '../src/db/proposals.js'
import { TicketError, TicketStore } from '../src/db/tickets.js'

let dir: string
let db: DatabaseSync
let tickets: TicketStore
let proposals: ProposalStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'docshield-p-'))
  db = openDatabase(path.join(dir, 'docshield.db'))
  tickets = new TicketStore(db)
  proposals = new ProposalStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const newTicket = () => tickets.create({ userId: 'alice', sessionId: 's-1', question: 'Học phí 2027?', reason: 'không thấy' }).ticket.code

describe('ProposalStore', () => {
  it('keeps the draft away from the asker until an admin approves it', () => {
    const code = newTicket()
    const p = proposals.add(code, { config: 'H1', raw: 'text {"tra_loi":"14 triệu"}', payload: { tra_loi: '14 triệu' }, tokens: 10, seconds: 2 })
    expect(p.status).toBe('draft')
    const before = tickets.get(code, 'alice')!
    expect(before.status).toBe('in_progress')
    expect(before.adminReply).toBeNull()
    const { ticket, proposal } = proposals.decide(p.id, { approve: true, reply: '  14 triệu đồng  ', by: 'admin' })
    expect(ticket.status).toBe('resolved')
    expect(ticket.admin_reply).toBe('14 triệu đồng')
    expect(proposal.status).toBe('approved')
    expect(() => proposals.decide(p.id, { approve: true, reply: 'x', by: 'admin' })).toThrow(TicketError)
  })

  it('rejects need a reason; a closed ticket cannot be decided again', () => {
    const code = newTicket()
    const a = proposals.add(code, { config: 'H1', raw: 'a' })
    const b = proposals.add(code, { config: 'H2', raw: 'b' })
    expect(() => proposals.decide(a.id, { approve: false, reply: ' ', by: 'admin' })).toThrow(/lý do/)
    proposals.decide(a.id, { approve: false, reply: 'Ngoài phạm vi', by: 'admin' })
    expect(tickets.get(code, undefined)!.status).toBe('rejected')
    expect(() => proposals.decide(b.id, { approve: true, reply: 'x', by: 'admin' })).toThrow(/đã đóng/)
  })

  it('refuses unknown tickets and bad config names', () => {
    expect(() => proposals.add('TICK-999', { config: 'H1', raw: 'x' })).toThrow(/Không tìm thấy/)
    expect(() => proposals.add(newTicket(), { config: 'H1; drop', raw: 'x' })).toThrow(/Cấu hình/)
  })
})

describe('tickets CLI', () => {
  it('lists, proposes, decides and writes the Q&A document into public_docs', async () => {
    const code = newTicket()
    db.close()
    mkdirSync(path.join(dir, 'public_docs'))
    const env = { DOCSHIELD_DB: path.join(dir, 'docshield.db'), DOCSHIELD_STORAGE_ROOT: dir }
    const stdin = (value: unknown) => {
      const { Readable } = require('node:stream') as typeof import('node:stream')
      Object.defineProperty(process, 'stdin', { value: Readable.from([JSON.stringify(value)]), configurable: true })
    }
    const original = process.stdin
    try {
      stdin({ config: 'H1', raw: 'r', payload: { tra_loi: '14 triệu', trich_dan: [{ file: 'hoc-phi.pdf', vi_tri: 'tr. 2', nguyen_van: '14.000.000 đồng' }] }, model: 'm', tokens: 5 })
      const p = await main(['propose', code], env) as { id: number }
      const list = await main(['list', '--status', 'in_progress'], env) as Array<{ code: string; drafts: number; sessionId: string }>
      expect(list).toEqual([expect.objectContaining({ code, drafts: 1, sessionId: 's-1' })])
      stdin({ approve: true, reply: '14 triệu đồng', by: 'admin', kb: true })
      const done = await main(['decide', String(p.id)], env) as { ticket: { status: string }; proposal: { kbFile: string } }
      expect(done.ticket.status).toBe('resolved')
      const doc = readFileSync(path.join(dir, 'public_docs', done.proposal.kbFile), 'utf8')
      expect(doc).toContain('Câu hỏi: Học phí 2027?')
      expect(doc).toContain('hoc-phi.pdf (tr. 2): "14.000.000 đồng"')
      await expect(main(['get', 'TICK-1'], env)).rejects.toThrow(/Không tìm thấy/)
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, configurable: true })
      db = openDatabase(path.join(dir, 'docshield.db'))
    }
  })
})
