'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 3;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'trip.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

// Schema is created automatically on startup. `user_version` tracks future migrations.
function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        total_cents INTEGER NOT NULL CHECK (total_cents > 0),
        split_mode  TEXT NOT NULL CHECK (split_mode IN ('equal', 'manual')),
        version     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- One row per participant of an invoice. Payers are always participants.
      CREATE TABLE IF NOT EXISTS invoice_members (
        invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        person_id     INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
        paid_cents    INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
        share_cents   INTEGER NOT NULL DEFAULT 0 CHECK (share_cents >= 0),
        settled_cents INTEGER NOT NULL DEFAULT 0 CHECK (settled_cents >= 0),
        PRIMARY KEY (invoice_id, person_id)
      );
      CREATE INDEX IF NOT EXISTS idx_members_person ON invoice_members(person_id);

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    db.pragma('user_version = 1');
  }
  if (version < 2) {
    // v2: the app works with whole numbers only — round any existing fractions UP.
    db.transaction(() => {
      db.exec(`
        UPDATE invoices SET total_cents = ((total_cents + 99) / 100) * 100;
        UPDATE invoice_members SET
          paid_cents    = ((paid_cents + 99) / 100) * 100,
          share_cents   = ((share_cents + 99) / 100) * 100,
          settled_cents = ((settled_cents + 99) / 100) * 100;
      `);
      db.pragma('user_version = 2');
    })();
  }
  if (version < 3) {
    // v3: optional free-text description of what the expense included.
    db.transaction(() => {
      db.exec("ALTER TABLE invoices ADD COLUMN description TEXT NOT NULL DEFAULT ''");
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
}

module.exports = { openDb };
