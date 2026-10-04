'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { openDb } = require('./db');
const Money = require('./public/money.js');

// ---------------------------------------------------------------------------
// Configuration (environment variables, optionally from a .env file)
// ---------------------------------------------------------------------------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const config = {
  port: parseInt(process.env.PORT || '4070', 10),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(__dirname, process.env.DATA_DIR || 'data'),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  cookieSecure: (process.env.COOKIE_SECURE || 'auto').toLowerCase(), // auto | true | false
  trustProxy: process.env.TRUST_PROXY === 'true',
  sessionHours: parseInt(process.env.SESSION_HOURS || '168', 10),
};

if (!config.adminPassword) {
  console.error('ADMIN_PASSWORD is not set. Copy .env.example to .env and set it.');
  process.exit(1);
}
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  console.error('PORT must be a number between 1 and 65535.');
  process.exit(1);
}

// The plaintext password is only kept long enough to derive a salted hash in memory.
const pwSalt = crypto.randomBytes(16);
const pwHash = crypto.scryptSync(config.adminPassword, pwSalt, 64);
delete process.env.ADMIN_PASSWORD;
config.adminPassword = null;

function checkPassword(input) {
  const candidate = crypto.scryptSync(input, pwSalt, 64);
  return crypto.timingSafeEqual(candidate, pwHash);
}

const db = openDb(config.dataDir);

// ---------------------------------------------------------------------------
// Errors & messages (Arabic, user-facing)
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const MSG = {
  unauthorized: 'غير مصرح لك بتنفيذ هذا الإجراء. يجب تسجيل دخول المسؤول.',
  csrf: 'انتهت صلاحية الجلسة أو الطلب غير صالح. حدّث الصفحة وحاول مرة أخرى.',
  badJson: 'البيانات المرسلة غير صالحة.',
  wrongPassword: 'كلمة المرور غير صحيحة.',
  tooMany: (min) => `محاولات كثيرة خاطئة. حاول مرة أخرى بعد ${min} دقيقة.`,
  nameRequired: 'الاسم مطلوب.',
  nameTooLong: (n) => `الاسم طويل جداً (الحد الأقصى ${n} حرفاً).`,
  nameExists: 'يوجد شخص بهذا الاسم مسبقاً.',
  personNotFound: 'الشخص غير موجود.',
  invoiceNotFound: 'المصروف غير موجود.',
  personInUse: (n) => `لا يمكن حذف هذا الشخص لأنه مشارك في ${n} من المصروفات. أزِله من تلك المصروفات أولاً.`,
  invoiceNameRequired: 'اسم المصروف مطلوب.',
  amountInvalid: 'المبلغ غير صالح.',
  totalInvalid: 'المبلغ الإجمالي غير صالح. أدخل رقماً أكبر من صفر.',
  participantsRequired: 'يجب اختيار مشارك واحد على الأقل.',
  payersRequired: 'يجب اختيار دافع واحد على الأقل.',
  payerNotParticipant: 'يجب أن يكون الدافع من ضمن المشاركين.',
  payerAmountInvalid: 'مبلغ الدافع غير صالح. يجب أن يكون أكبر من صفر.',
  payersSumMismatch: (paid, total) => `مجموع ما دفعه الدافعون (${paid}) لا يساوي المبلغ الإجمالي (${total}).`,
  splitModeInvalid: 'طريقة التقسيم غير صالحة.',
  sharesInvalid: 'حصص التقسيم اليدوي غير صالحة. يجب إدخال حصة لكل مشارك.',
  shareNegative: 'لا يمكن أن تكون الحصة سالبة.',
  descriptionInvalid: 'الوصف غير صالح.',
  descriptionTooLong: (n) => `الوصف طويل جداً (الحد الأقصى ${n} حرف).`,
  sharesZero: 'مجموع الحصص يجب أن يكون أكبر من صفر.',
  duplicateIds: 'يوجد تكرار في الأشخاص المختارين.',
  versionConflict: 'تم تعديل هذا المصروف من جهة أخرى. حدّث الصفحة وحاول مرة أخرى.',
  notMember: 'هذا الشخص ليس مشاركاً في هذا المصروف.',
  paymentNegative: 'لا يمكن أن يكون المبلغ المدفوع سالباً.',
  nothingToSettle: 'لا يوجد مبلغ مستحق على هذا الشخص أو له في هذا المصروف.',
  nothingToSettleFinal: 'لا يوجد مبلغ نهائي على هذا الشخص أو له — حساباته متعادلة.',
  tooManyPeople: 'تم الوصول إلى الحد الأقصى لعدد الأشخاص.',
  notFound: 'الصفحة أو الطلب غير موجود.',
  resetInvalid: 'طلب إعادة الضبط غير صالح.',
  server: 'حدث خطأ غير متوقع. حاول مرة أخرى.',
};

// ---------------------------------------------------------------------------
// Input validation helpers — never trust the browser
// ---------------------------------------------------------------------------
function parseId(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 31) return v;
  if (typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v)) {
    const n = Number(v);
    if (n < 2 ** 31) return n;
  }
  return null;
}

function cleanText(v, max, requiredMsg) {
  if (typeof v !== 'string') throw new HttpError(400, requiredMsg);
  const s = v
    .normalize('NFC')
    // strip control chars and bidi override/isolate chars that could spoof display
    .replace(/[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) throw new HttpError(400, requiredMsg);
  if ([...s].length > max) throw new HttpError(400, MSG.nameTooLong(max));
  return s;
}

// Optional multi-line text: keeps line breaks, strips other control/bidi chars, max `max` characters.
function cleanDescription(v, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, MSG.descriptionInvalid);
  const s = v
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if ([...s].length > max) throw new HttpError(400, MSG.descriptionTooLong(max));
  return s;
}

function money(v, msg) {
  const c = Money.parseMoney(v);
  if (c === null) throw new HttpError(400, msg);
  return c;
}

const fmt = (c) => Money.formatAbs(c);

function validateInvoice(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, MSG.badJson);
  const name = cleanText(body.name, 60, MSG.invoiceNameRequired);
  const description = cleanDescription(body.description, 500);

  if (!Array.isArray(body.participantIds) || body.participantIds.length === 0) {
    throw new HttpError(400, MSG.participantsRequired);
  }
  if (body.participantIds.length > 500) throw new HttpError(400, MSG.badJson);
  const participantIds = body.participantIds.map(parseId);
  if (participantIds.some((id) => id === null)) throw new HttpError(400, MSG.personNotFound);
  if (new Set(participantIds).size !== participantIds.length) throw new HttpError(400, MSG.duplicateIds);

  // Every participant must exist.
  const existing = new Set(db.prepare('SELECT id FROM people').all().map((r) => r.id));
  if (participantIds.some((id) => !existing.has(id))) throw new HttpError(400, MSG.personNotFound);
  const partSet = new Set(participantIds);

  const total = money(body.total, MSG.totalInvalid);
  if (total <= 0) throw new HttpError(400, MSG.totalInvalid);

  if (!Array.isArray(body.payers) || body.payers.length === 0) throw new HttpError(400, MSG.payersRequired);
  if (body.payers.length > participantIds.length) throw new HttpError(400, MSG.duplicateIds);
  const payers = new Map();
  for (const p of body.payers) {
    if (!p || typeof p !== 'object') throw new HttpError(400, MSG.badJson);
    const id = parseId(p.personId);
    if (id === null || !existing.has(id)) throw new HttpError(400, MSG.personNotFound);
    if (!partSet.has(id)) throw new HttpError(400, MSG.payerNotParticipant);
    if (payers.has(id)) throw new HttpError(400, MSG.duplicateIds);
    const amt = money(p.amount, MSG.payerAmountInvalid);
    if (amt <= 0) throw new HttpError(400, MSG.payerAmountInvalid);
    payers.set(id, amt);
  }
  const paidSum = [...payers.values()].reduce((a, b) => a + b, 0);
  if (paidSum !== total) throw new HttpError(400, MSG.payersSumMismatch(fmt(paidSum), fmt(total)));

  const splitMode = body.splitMode;
  let shares;
  if (splitMode === 'equal') {
    // Shares are always recomputed on the server for an equal split.
    const eq = Money.equalSplit(total, participantIds);
    shares = new Map(participantIds.map((id) => [id, eq[id]]));
  } else if (splitMode === 'manual') {
    if (!Array.isArray(body.shares) || body.shares.length !== participantIds.length) {
      throw new HttpError(400, MSG.sharesInvalid);
    }
    shares = new Map();
    for (const s of body.shares) {
      if (!s || typeof s !== 'object') throw new HttpError(400, MSG.sharesInvalid);
      const id = parseId(s.personId);
      if (id === null || !partSet.has(id) || shares.has(id)) throw new HttpError(400, MSG.sharesInvalid);
      if (typeof s.amount === 'string' && s.amount.trim().startsWith('-')) throw new HttpError(400, MSG.shareNegative);
      if (typeof s.amount === 'number' && s.amount < 0) throw new HttpError(400, MSG.shareNegative);
      shares.set(id, money(s.amount, MSG.amountInvalid));
    }
    // Shares may add up to more or less than the total (allowed on purpose), but not to zero.
    const shareSum = [...shares.values()].reduce((a, b) => a + b, 0);
    if (shareSum === 0) throw new HttpError(400, MSG.sharesZero);
  } else {
    throw new HttpError(400, MSG.splitModeInvalid);
  }

  return { name, description, participantIds, total, payers, shares, splitMode };
}

// ---------------------------------------------------------------------------
// Read model — every balance is computed here on the server from stored facts
// ---------------------------------------------------------------------------
function buildState() {
  const people = db.prepare(`
    SELECT p.id, p.name, COUNT(m.invoice_id) AS invoiceCount
    FROM people p LEFT JOIN invoice_members m ON m.person_id = p.id
    GROUP BY p.id ORDER BY p.id`).all();
  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  const invoiceRows = db.prepare(`
    SELECT id, name, description, total_cents AS total, split_mode AS splitMode, version, created_at AS createdAt
    FROM invoices ORDER BY id DESC`).all();
  const memberRows = db.prepare(`
    SELECT invoice_id AS invoiceId, person_id AS personId, paid_cents AS paid,
           share_cents AS share, settled_cents AS settled
    FROM invoice_members ORDER BY invoice_id, person_id`).all();
  const byInvoice = new Map();
  for (const m of memberRows) {
    if (!byInvoice.has(m.invoiceId)) byInvoice.set(m.invoiceId, []);
    byInvoice.get(m.invoiceId).push(m);
  }

  const summary = new Map(people.map((p) => [p.id, {
    personId: p.id, name: p.name, paid: 0, share: 0, net: 0, outstanding: 0,
    owe: 0, owePaid: 0, receive: 0, received: 0,
  }]));
  let spent = 0;

  const invoices = invoiceRows.map((inv) => {
    const calc = Money.computeInvoice(byInvoice.get(inv.id) || []);
    spent += inv.total;
    for (const r of calc.rows) {
      const s = summary.get(r.personId);
      s.paid += r.paid;
      s.share += r.share;
      s.net += r.net;
      // What is still open after recorded settlements (sign: + receive, − pay).
      s.outstanding += r.net < 0 ? r.net + r.settled : r.net - r.settled;
      // Gross totals per direction (not netted across invoices):
      // owe/owePaid = what they must pay / have paid; receive/received = what they must get / have got.
      if (r.net < 0) { s.owe += -r.net; s.owePaid += r.settled; }
      else if (r.net > 0) { s.receive += r.net; s.received += r.settled; }
    }
    return {
      ...inv,
      members: calc.rows.map((r) => ({ ...r, name: nameOf.get(r.personId) })),
      netSum: calc.netSum,
      shareSum: calc.shareSum,
      discrepancy: calc.discrepancy,
      missing: calc.missing,
      over: calc.over,
    };
  });

  return { people, invoices, summary: [...summary.values()], totals: { spent } };
}

// ---------------------------------------------------------------------------
// Sessions, CSRF, login rate limiting
// ---------------------------------------------------------------------------
const COOKIE = 'trip_sid';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare('SELECT token_hash, csrf_token FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(sha256(token), Date.now()) || null;
}

function cookieFlags(req) {
  const secure = config.cookieSecure === 'true' || (config.cookieSecure === 'auto' && req.secure);
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Every mutation goes through this: valid admin session + matching CSRF header.
function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return next(new HttpError(401, MSG.unauthorized));
  const csrf = req.get('x-csrf-token');
  if (!csrf || !safeEqual(csrf, session.csrf_token)) return next(new HttpError(403, MSG.csrf));
  req.session = session;
  next();
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 5;
const MAX_GLOBAL = 50;
const failures = new Map(); // ip -> { count, since }
let globalFailures = { count: 0, since: Date.now() };

function loginBlockedFor(ip) {
  const now = Date.now();
  if (now - globalFailures.since > WINDOW_MS) globalFailures = { count: 0, since: now };
  if (globalFailures.count >= MAX_GLOBAL) return globalFailures.since + WINDOW_MS - now;
  const f = failures.get(ip);
  if (!f) return 0;
  if (now - f.since > WINDOW_MS) { failures.delete(ip); return 0; }
  return f.count >= MAX_PER_IP ? f.since + WINDOW_MS - now : 0;
}

function recordFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || now - f.since > WINDOW_MS) failures.set(ip, { count: 1, since: now });
  else f.count++;
  globalFailures.count++;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (now - f.since > WINDOW_MS) failures.delete(ip);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

// Reject cross-site state-changing requests (defence in depth alongside SameSite + CSRF token).
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* invalid */ }
    if (host !== req.get('host')) return next(new HttpError(403, MSG.csrf));
  }
  // Bodies must be JSON (plain HTML forms cannot send this cross-site without a CORS preflight).
  if (req.is('application/json') === false) return next(new HttpError(415, MSG.badJson));
  next();
});
app.use('/api', express.json({ limit: '64kb', strict: true }));

const api = express.Router();

api.get('/state', (req, res) => res.json(buildState()));

api.get('/session', (req, res) => {
  const s = getSession(req);
  res.json({ isAdmin: !!s, csrfToken: s ? s.csrf_token : null });
});

api.post('/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const wait = loginBlockedFor(ip);
  if (wait > 0) throw new HttpError(429, MSG.tooMany(Math.ceil(wait / 60000)));
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || password.length === 0 || password.length > 200 || !checkPassword(password)) {
    recordFailure(ip);
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    throw new HttpError(401, MSG.wrongPassword);
  }
  failures.delete(ip);
  // Fresh random session on every login (no fixation); only the hash is stored.
  const old = getSession(req);
  if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(old.token_hash);
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const maxAge = config.sessionHours * 3600;
  db.prepare('INSERT INTO sessions (token_hash, csrf_token, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), csrfToken, Date.now() + maxAge * 1000);
  res.set('Set-Cookie', `${COOKIE}=${token}; Max-Age=${maxAge}; ${cookieFlags(req)}`);
  res.json({ isAdmin: true, csrfToken });
});

api.post('/logout', (req, res) => {
  const s = getSession(req);
  if (s) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash);
  res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
  res.json({ isAdmin: false });
});

// ---- People ---------------------------------------------------------------
function isUniqueViolation(e) { return e && e.code === 'SQLITE_CONSTRAINT_UNIQUE'; }

api.post('/people', requireAdmin, (req, res) => {
  const name = cleanText(req.body && req.body.name, 40, MSG.nameRequired);
  if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n >= 200) throw new HttpError(400, MSG.tooManyPeople);
  try {
    db.prepare('INSERT INTO people (name) VALUES (?)').run(name);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, MSG.nameExists);
    throw e;
  }
  res.status(201).json(buildState());
});

api.put('/people/:id', requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw new HttpError(404, MSG.personNotFound);
  const name = cleanText(req.body && req.body.name, 40, MSG.nameRequired);
  let info;
  try {
    info = db.prepare('UPDATE people SET name = ? WHERE id = ?').run(name, id);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, MSG.nameExists);
    throw e;
  }
  if (info.changes === 0) throw new HttpError(404, MSG.personNotFound);
  res.json(buildState());
});

api.delete('/people/:id', requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw new HttpError(404, MSG.personNotFound);
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) throw new HttpError(404, MSG.personNotFound);
    const used = db.prepare('SELECT COUNT(*) AS n FROM invoice_members WHERE person_id = ?').get(id).n;
    if (used > 0) throw new HttpError(409, MSG.personInUse(used));
    db.prepare('DELETE FROM people WHERE id = ?').run(id);
  })();
  res.json(buildState());
});

// ---- Invoices -------------------------------------------------------------
const insertMember = () => db.prepare(`
  INSERT INTO invoice_members (invoice_id, person_id, paid_cents, share_cents, settled_cents)
  VALUES (?, ?, ?, ?, ?)`);

api.post('/invoices', requireAdmin, (req, res) => {
  db.transaction(() => {
    const v = validateInvoice(req.body);
    const info = db.prepare('INSERT INTO invoices (name, description, total_cents, split_mode) VALUES (?, ?, ?, ?)')
      .run(v.name, v.description, v.total, v.splitMode);
    const ins = insertMember();
    for (const pid of v.participantIds) {
      ins.run(info.lastInsertRowid, pid, v.payers.get(pid) || 0, v.shares.get(pid), 0);
    }
  })();
  res.status(201).json(buildState());
});

api.put('/invoices/:id', requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw new HttpError(404, MSG.invoiceNotFound);
  db.transaction(() => {
    const inv = db.prepare('SELECT id, version FROM invoices WHERE id = ?').get(id);
    if (!inv) throw new HttpError(404, MSG.invoiceNotFound);
    if (req.body && req.body.version !== inv.version) throw new HttpError(409, MSG.versionConflict);
    const v = validateInvoice(req.body);
    // Keep recorded settlements for people who remain in the invoice.
    const settled = new Map(db.prepare('SELECT person_id, settled_cents FROM invoice_members WHERE invoice_id = ?')
      .all(id).map((r) => [r.person_id, r.settled_cents]));
    db.prepare(`UPDATE invoices SET name = ?, description = ?, total_cents = ?, split_mode = ?, version = version + 1,
                updated_at = datetime('now') WHERE id = ?`).run(v.name, v.description, v.total, v.splitMode, id);
    db.prepare('DELETE FROM invoice_members WHERE invoice_id = ?').run(id);
    const ins = insertMember();
    for (const pid of v.participantIds) {
      ins.run(id, pid, v.payers.get(pid) || 0, v.shares.get(pid), settled.get(pid) || 0);
    }
  })();
  res.json(buildState());
});

api.delete('/invoices/:id', requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw new HttpError(404, MSG.invoiceNotFound);
  const info = db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  if (info.changes === 0) throw new HttpError(404, MSG.invoiceNotFound);
  res.json(buildState());
});

// Record how much a participant actually paid (debtor) or received (creditor).
// Body: { amount: "8.00" } or { done: true } (settles the full amount computed on the server).
api.put('/invoices/:id/settlements/:personId', requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  const personId = parseId(req.params.personId);
  if (!id) throw new HttpError(404, MSG.invoiceNotFound);
  if (!personId) throw new HttpError(404, MSG.personNotFound);
  const body = req.body || {};
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM invoices WHERE id = ?').get(id)) throw new HttpError(404, MSG.invoiceNotFound);
    const m = db.prepare('SELECT paid_cents, share_cents FROM invoice_members WHERE invoice_id = ? AND person_id = ?')
      .get(id, personId);
    if (!m) throw new HttpError(404, MSG.notMember);
    const expected = Math.abs(m.paid_cents - m.share_cents);
    let amount;
    if (body.done === true) {
      amount = expected;
    } else {
      if ((typeof body.amount === 'string' && body.amount.trim().startsWith('-')) ||
          (typeof body.amount === 'number' && body.amount < 0)) {
        throw new HttpError(400, MSG.paymentNegative);
      }
      amount = money(body.amount, MSG.amountInvalid);
    }
    if (expected === 0 && amount > 0) throw new HttpError(400, MSG.nothingToSettle);
    db.prepare('UPDATE invoice_members SET settled_cents = ? WHERE invoice_id = ? AND person_id = ?')
      .run(amount, id, personId);
    db.prepare("UPDATE invoices SET updated_at = datetime('now') WHERE id = ?").run(id);
  })();
  res.json(buildState());
});

// ---- Final settlement per person ----------------------------------------
// Spread ONE amount (what the person finally paid, or received) over all his invoices.
// Everyone settles a single net amount at the end, so what he is owed in some invoices is
// netted against what he owes in others:
//   • he owes overall  (net < 0): invoices where he should receive are marked fully received
//     (netted), and his receivables + the amount he paid are spread over the invoices where he
//     owes, oldest first.
//   • he is owed overall (net > 0): the mirror image.
//   • net = 0: everything nets out; nothing can be paid.
// Any extra beyond what is due lands on his last invoice (shown as overpayment).
// rows: [{ invoiceId, net, expected }] ordered oldest first → returns Map(invoiceId → settled cents)
function allocateFinal(rows, amount) {
  const net = rows.reduce((a, r) => a + r.net, 0);
  const debts = rows.filter((r) => r.net < 0);
  const credits = rows.filter((r) => r.net > 0);
  const out = new Map(rows.filter((r) => r.net === 0).map((r) => [r.invoiceId, 0]));
  const fill = (list, pool) => {
    list.forEach((r) => { const v = Math.min(r.expected, pool); out.set(r.invoiceId, v); pool -= v; });
    if (pool > 0 && list.length) { const last = list[list.length - 1].invoiceId; out.set(last, out.get(last) + pool); }
  };
  const settleAll = (list) => list.forEach((r) => out.set(r.invoiceId, r.expected));
  if (net < 0) {
    settleAll(credits);
    fill(debts, credits.reduce((a, r) => a + r.expected, 0) + amount);
  } else if (net > 0) {
    settleAll(debts);
    fill(credits, debts.reduce((a, r) => a + r.expected, 0) + amount);
  } else {
    if (amount > 0) throw new HttpError(400, MSG.nothingToSettleFinal);
    settleAll(debts);
    settleAll(credits);
  }
  return out;
}

// Body: { amount: "2230" } (total paid/received so far) or { done: true } (the full final amount).
api.put('/people/:id/final-settlement', requireAdmin, (req, res) => {
  const personId = parseId(req.params.id);
  if (!personId) throw new HttpError(404, MSG.personNotFound);
  const body = req.body || {};
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) throw new HttpError(404, MSG.personNotFound);
    const rows = db.prepare(`SELECT invoice_id AS invoiceId, paid_cents - share_cents AS net
                             FROM invoice_members WHERE person_id = ? ORDER BY invoice_id`).all(personId)
      .map((r) => ({ ...r, expected: Math.abs(r.net) }));
    if (!rows.some((r) => r.net !== 0)) throw new HttpError(400, MSG.nothingToSettleFinal);
    let amount;
    if (body.done === true) {
      amount = Math.abs(rows.reduce((a, r) => a + r.net, 0));
    } else {
      if ((typeof body.amount === 'string' && body.amount.trim().startsWith('-')) ||
          (typeof body.amount === 'number' && body.amount < 0)) {
        throw new HttpError(400, MSG.paymentNegative);
      }
      amount = money(body.amount, MSG.amountInvalid);
    }
    const settled = allocateFinal(rows, amount);
    const upd = db.prepare('UPDATE invoice_members SET settled_cents = ? WHERE invoice_id = ? AND person_id = ?');
    const touch = db.prepare("UPDATE invoices SET updated_at = datetime('now') WHERE id = ?");
    for (const [invoiceId, v] of settled) { upd.run(v, invoiceId, personId); touch.run(invoiceId); }
  })();
  res.json(buildState());
});

// Start over for a new trip. Body: { scope: 'invoices' | 'all', confirm: 'RESET' }
// 'invoices' deletes all expenses and settlements but keeps the people; 'all' deletes people too.
// A copy of the database is saved to DATA_DIR/backups first, so a reset can be undone.
api.post('/reset', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (body.confirm !== 'RESET' || (body.scope !== 'invoices' && body.scope !== 'all')) {
    throw new HttpError(400, MSG.resetInvalid);
  }
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23);
  let backupFile = path.join(dir, `before-reset-${stamp}.db`);
  for (let i = 2; fs.existsSync(backupFile); i++) backupFile = path.join(dir, `before-reset-${stamp}-${i}.db`);
  db.prepare('VACUUM INTO ?').run(backupFile);
  db.transaction(() => {
    db.prepare('DELETE FROM invoice_members').run();
    db.prepare('DELETE FROM invoices').run();
    if (body.scope === 'all') db.prepare('DELETE FROM people').run();
  })();
  console.log(`Reset (${body.scope}); backup saved to ${backupFile}`);
  res.json(buildState());
});

app.use('/api', api);
app.use('/api', (req, res, next) => next(new HttpError(404, MSG.notFound)));

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}fonts${path.sep}`)) res.set('Cache-Control', 'public, max-age=2592000, immutable');
    else res.set('Cache-Control', 'no-cache');
  },
}));

app.use((req, res, next) => next(new HttpError(404, MSG.notFound)));

// Never leak stack traces or internals.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err instanceof HttpError ? err.message : MSG.server;
  if (!(err instanceof HttpError)) {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') { status = 400; message = MSG.badJson; }
    else { status = 500; console.error(err); }
  }
  if (req.path.startsWith('/api') || req.accepts(['json', 'html']) === 'json') {
    return res.status(status).json({ error: message });
  }
  res.status(status).type('text/plain; charset=utf-8').send(message);
});

if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log(`Bill Gates running on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  });
}

module.exports = { app, db };
