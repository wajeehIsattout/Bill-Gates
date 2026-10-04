'use strict';
// Creates a consistent copy of the database (safe while the server is running).
// Usage: npm run backup            -> backups/trip-YYYY-MM-DD-HHMMSS.db
//        npm run backup -- out.db  -> custom path
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const dbFile = path.join(path.resolve(root, process.env.DATA_DIR || 'data'), 'trip.db');
if (!fs.existsSync(dbFile)) {
  console.error(`Database not found: ${dbFile}`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const out = path.resolve(process.argv[2] || path.join(root, 'backups', `trip-${stamp}.db`));
fs.mkdirSync(path.dirname(out), { recursive: true });

const db = new Database(dbFile, { readonly: true });
db.backup(out)
  .then(() => { console.log(`Backup written to ${out}`); db.close(); })
  .catch((err) => { console.error('Backup failed:', err.message); process.exit(1); });
