/**
 * docshield.db: documents, chunks, and two search indexes over the same
 * chunk ids — `vec_chunks` (sqlite-vec, `scope` is a partition key so every
 * KNN query must name a scope) and `fts_chunks` (FTS5/BM25, `scope` column
 * filtered in every query). WAL + IMMEDIATE transactions for concurrent writers.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getLoadablePath } from 'sqlite-vec'

export const EMBEDDING_DIMS = 1024
const SCHEMA_VERSION = 5

export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file, { allowExtension: true })
  db.loadExtension(getLoadablePath())
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
  `)
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (current >= SCHEMA_VERSION) return
  db.exec('BEGIN IMMEDIATE')
  try {
    if (current < 1) migrateV1(db)
    if (current < 2) migrateV2(db)
    if (current < 3) migrateV3(db)
    if (current < 4) migrateV4(db)
    if (current < 5) migrateV5(db)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * v4: tickets gain the 'rejected' status. SQLite cannot alter a CHECK
 * constraint, so the table is rebuilt; the AUTOINCREMENT counter is carried
 * over explicitly (dropping the old table drops its sqlite_sequence row), so
 * codes continue from where they were instead of restarting.
 */
function migrateV4(db: DatabaseSync): void {
  const previous = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'tickets'`).get() as { seq: number } | undefined
  db.exec(`
    CREATE TABLE tickets_v4 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL,
      session_id  TEXT    NOT NULL,
      question    TEXT    NOT NULL,
      reason      TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'rejected')),
      admin_reply TEXT,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO tickets_v4 (id, user_id, session_id, question, reason, status, admin_reply, created_at, updated_at)
      SELECT id, user_id, session_id, question, reason, status, admin_reply, created_at, updated_at FROM tickets;
    DROP TABLE tickets;
    ALTER TABLE tickets_v4 RENAME TO tickets;
    CREATE INDEX idx_tickets_user ON tickets (user_id, created_at);
    CREATE INDEX idx_tickets_status ON tickets (status, created_at);
  `)
  const { maxId } = db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM tickets').get() as { maxId: number }
  const seq = Math.max(previous?.seq ?? 100, maxId, 100)
  db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'tickets'`).run()
  db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('tickets', ?)`).run(seq)
}

/**
 * v3: public file bindings. A file in public_docs may be bound to an explicit
 * doc_key (so quy_che_v2.pdf can replace quy_che_v1.pdf) or retired (never
 * indexed again while the file stays on disk). Unlisted files use the
 * filename-derived key.
 */
function migrateV3(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_files (
      filename   TEXT PRIMARY KEY,
      doc_key    TEXT NOT NULL,
      state      TEXT NOT NULL CHECK (state IN ('bound', 'retired')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_public_files_key ON public_files (doc_key, state);
  `)
}

/** v2: support tickets. Codes are 'TICK-' || id, starting at TICK-101. */
function migrateV2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL,
      session_id  TEXT    NOT NULL,
      question    TEXT    NOT NULL,
      reason      TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
      admin_reply TEXT,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status, created_at);
    INSERT INTO sqlite_sequence (name, seq)
      SELECT 'tickets', 100 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'tickets');
  `)
}

function migrateV1(db: DatabaseSync): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        scope       TEXT    NOT NULL,
        doc_key     TEXT    NOT NULL,
        filename    TEXT    NOT NULL,
        path        TEXT    NOT NULL,
        sha256      TEXT    NOT NULL,
        bytes       INTEGER NOT NULL,
        version     INTEGER NOT NULL,
        status      TEXT    NOT NULL CHECK (status IN ('active', 'superseded', 'removed', 'failed')),
        error       TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (scope, doc_key, version)
      );
      CREATE INDEX IF NOT EXISTS idx_documents_live ON documents (scope, doc_key, status);

      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        ord         INTEGER NOT NULL,
        text        TEXT    NOT NULL,
        locator     TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks (document_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        scope TEXT PARTITION KEY,
        embedding FLOAT[${EMBEDDING_DIMS}] distance_metric=cosine
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
        text,
        scope UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
  `)
}

/** Run `fn` inside BEGIN IMMEDIATE … COMMIT, rolling back on any throw. */
/**
 * v5: proposals from the ticket agent (Project 3). Admin-only: no user tool reads this table, and
 * a draft never touches tickets.admin_reply (which the asker sees) until an admin approves it.
 */
function migrateV5(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_proposals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
      config      TEXT    NOT NULL,
      model       TEXT,
      session_id  TEXT,
      payload     TEXT,
      raw         TEXT    NOT NULL,
      tokens      INTEGER,
      seconds     REAL,
      status      TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
      final_reply TEXT,
      kb_file     TEXT,
      decided_by  TEXT,
      decided_at  TEXT,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_ticket ON ticket_proposals (ticket_id, id);
  `)
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function vectorBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}
