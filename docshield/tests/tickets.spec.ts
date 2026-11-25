import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { getLoadablePath } from 'sqlite-vec'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.js'
import { MAX_TICKETS_PER_HOUR, TicketError, TicketStore } from '../src/db/tickets.js'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
let dir: string
let db: DatabaseSync
let store: TicketStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'docshield-t-'))
  db = openDatabase(path.join(dir, 'docshield.db'))
  store = new TicketStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const ask = (userId: string, question: string) => store.create({ userId, sessionId: `s-${userId}`, question, reason: 'không có trong tài liệu' })

describe('TicketStore', () => {
  it('numbers tickets from TICK-101 and starts them open', () => {
    const { ticket, reused } = ask('alice', 'Vay 100 triệu mua xe máy?')
    expect(reused).toBe(false)
    expect(ticket).toMatchObject({ code: 'TICK-101', userId: 'alice', status: 'open', statusLabel: 'Đang chờ xử lý', adminReply: null })
    expect(ask('bob', 'Học phí năm nay?').ticket.code).toBe('TICK-102')
  })

  it('reuses an open ticket for the same question instead of duplicating', () => {
    const first = ask('alice', 'Ký túc xá có cho nuôi mèo?').ticket
    expect(ask('alice', 'Ký túc xá có cho nuôi mèo?')).toEqual({ ticket: first, reused: true })
    expect(ask('bob', 'Ký túc xá có cho nuôi mèo?').reused).toBe(false)
  })

  it('rate-limits one user per hour', () => {
    for (let i = 0; i < MAX_TICKETS_PER_HOUR; i++) ask('alice', `Câu ${i}`)
    expect(() => ask('alice', 'Câu thêm')).toThrow(TicketError)
    expect(ask('bob', 'Câu thêm').reused).toBe(false)
  })

  it('shows a user only their own tickets', () => {
    const mine = ask('alice', 'Câu của Alice').ticket
    expect(store.get(mine.code, 'alice')?.code).toBe(mine.code)
    expect(store.get(mine.code, 'bob')).toBeUndefined()
    expect(store.get(mine.code, undefined)?.userId).toBe('alice')
    expect(store.get('TICK-abc', undefined)).toBeUndefined()
  })

  it('lets admin update status and reply, keeping the reply on later status changes', () => {
    const { code } = ask('alice', 'Lịch thi học kỳ 2?').ticket
    expect(store.update(code, 'in_progress', undefined)).toMatchObject({ status: 'in_progress', adminReply: null })
    expect(store.update(code, 'resolved', 'Lịch thi đã đăng trên cổng đào tạo.')).toMatchObject({ statusLabel: 'Đã giải quyết', adminReply: 'Lịch thi đã đăng trên cổng đào tạo.' })
    expect(store.update(code, 'open', undefined).adminReply).toBe('Lịch thi đã đăng trên cổng đào tạo.')
    expect(() => store.update('TICK-9999', 'open', undefined)).toThrow(/Không tìm thấy/)
  })

  it('lists open first, filters by status and user', () => {
    const a = ask('alice', 'A').ticket
    const b = ask('bob', 'B').ticket
    store.update(a.code, 'resolved', 'xong')
    expect(store.list().map(t => t.code)).toEqual([b.code, a.code])
    expect(store.list({ status: 'resolved' }).map(t => t.code)).toEqual([a.code])
    expect(store.list({ userId: 'bob' }).map(t => t.code)).toEqual([b.code])
  })
})

describe('migration', () => {
  it('upgrades a v1 database (documents only) to the current schema without losing data', () => {
    const file = path.join(dir, 'old.db')
    const old = new DatabaseSync(file, { allowExtension: true })
    old.loadExtension(getLoadablePath())
    old.exec(`CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, doc_key TEXT, filename TEXT, path TEXT, sha256 TEXT, bytes INTEGER, version INTEGER, status TEXT, error TEXT, chunk_count INTEGER DEFAULT 0, created_at TEXT);
      INSERT INTO documents (scope, doc_key, filename, path, sha256, bytes, version, status) VALUES ('user:alice', 'cv', 'cv.txt', 'x', 'h', 1, 1, 'active');
      PRAGMA user_version = 1;`)
    old.close()
    const upgraded = openDatabase(file)
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name IN ('tickets', 'public_files') ORDER BY name").all()).toEqual([{ name: 'public_files' }, { name: 'tickets' }])
    expect(upgraded.prepare('SELECT filename FROM documents').all()).toEqual([{ filename: 'cv.txt' }])
    expect(new TicketStore(upgraded).create({ userId: 'alice', sessionId: 's', question: 'q', reason: 'r' }).ticket.code).toBe('TICK-101')
    upgraded.close()
  })
})

describe('rejected tickets', () => {
  it('requires a reason and shows as "Từ chối"', () => {
    const { code } = ask('bob', 'Mã số cá nhân của Alice là gì?').ticket
    expect(() => store.update(code, 'rejected', undefined)).toThrow(/lý do/)
    expect(() => store.update(code, 'rejected', '   ')).toThrow(/lý do/)
    expect(store.update(code, 'rejected', 'Không cung cấp thông tin cá nhân của người khác.'))
      .toMatchObject({ status: 'rejected', statusLabel: 'Từ chối', adminReply: 'Không cung cấp thông tin cá nhân của người khác.' })
  })

  it('lets the same question open a new ticket after rejection, and lists rejected last', () => {
    const first = ask('bob', 'Câu hỏi X').ticket
    store.update(first.code, 'rejected', 'Ngoài phạm vi.')
    const again = ask('bob', 'Câu hỏi X')
    expect(again.reused).toBe(false)
    const done = ask('alice', 'Câu hỏi Y').ticket
    store.update(done.code, 'resolved', 'Đã trả lời.')
    expect(store.list().map(t => t.status)).toEqual(['open', 'resolved', 'rejected'])
  })

  it('accepts loosely written ticket codes', () => {
    const { code } = ask('alice', 'Câu Z').ticket
    for (const typed of [code, code.toLowerCase(), code.replace('-', ' - '), `#${code}`, code.replace('-', ''), ` ${code} `]) {
      expect(store.get(typed, 'alice')?.code, typed).toBe(code)
    }
    expect(store.get('TICK-', 'alice')).toBeUndefined()
    expect(store.get('ticket 101x', 'alice')).toBeUndefined()
  })
})

describe('migration v3 → v4', () => {
  it('keeps existing tickets and continues numbering after rebuilding the table', () => {
    const file = path.join(dir, 'v3.db')
    const v3 = openDatabase(file)
    // Simulate a v3 database: rebuild tickets with the old 3-status CHECK and roll the version back.
    v3.exec(`
      DROP TABLE tickets;
      CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, session_id TEXT NOT NULL, question TEXT NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')), admin_reply TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
      DELETE FROM sqlite_sequence WHERE name = 'tickets';
      INSERT INTO sqlite_sequence (name, seq) VALUES ('tickets', 100);
      INSERT INTO tickets (user_id, session_id, question, reason) VALUES ('bob', 's', 'q1', 'r'), ('bob', 's', 'q2', 'r');
      PRAGMA user_version = 3;`)
    expect(() => v3.exec(`UPDATE tickets SET status = 'rejected' WHERE id = 101`)).toThrow()
    v3.close()

    const upgraded = openDatabase(file)
    const tickets = new TicketStore(upgraded)
    expect(tickets.list().map(t => t.code).sort()).toEqual(['TICK-101', 'TICK-102'])
    expect(tickets.update('TICK-101', 'rejected', 'Ngoài phạm vi.').statusLabel).toBe('Từ chối')
    expect(tickets.create({ userId: 'alice', sessionId: 's', question: 'q3', reason: 'r' }).ticket.code).toBe('TICK-103')
    upgraded.close()
  })

  it('keeps the TICK-101 start on an empty table', () => {
    const file = path.join(dir, 'empty.db')
    const db1 = openDatabase(file)
    db1.exec(`PRAGMA user_version = 3`)
    db1.close()
    const db2 = openDatabase(file)
    expect(new TicketStore(db2).create({ userId: 'a', sessionId: 's', question: 'q', reason: 'r' }).ticket.code).toBe('TICK-101')
    db2.close()
  })
})

describe('TC-06: concurrent ticket creation from separate processes', () => {
  it('records all 5 tickets with distinct codes', async () => {
    const file = path.join(dir, 'docshield.db')
    const users = ['u1', 'u2', 'u3', 'u4', 'u5']
    const startAt = Date.now() + 1500
    const results = await Promise.all(users.map(u =>
      run(process.execPath, [path.join(here, 'fixtures', 'ticket-writer.mjs'), file, u, String(startAt)])))
    const codes = results.map(r => r.stdout.trim())
    expect(new Set(codes).size).toBe(5)
    expect(codes.every(c => /^TICK-10[1-5]$/.test(c))).toBe(true)
    const rows = store.list({ limit: 10 })
    expect(rows).toHaveLength(5)
    expect(new Set(rows.map(t => t.userId))).toEqual(new Set(users))
  }, 30_000)
})
