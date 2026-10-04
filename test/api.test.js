'use strict';
// End-to-end scenarios against a real server process with a temporary database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PASSWORD = 'helloworld!!';
const PORT = 4900 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-test-'));
let proc;

function start() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, ADMIN_PASSWORD: PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}
function stop() {
  return new Promise((resolve) => { proc.removeAllListeners('exit'); proc.on('exit', resolve); proc.kill(); });
}

// Minimal client: keeps the admin cookie + CSRF token
function client() {
  const c = { cookie: '', csrf: '' };
  c.req = async (method, url, body, extra = {}) => {
    const headers = { Accept: 'application/json', ...extra.headers };
    if (body !== undefined) headers['Content-Type'] = extra.contentType || 'application/json';
    if (c.cookie) headers.Cookie = c.cookie;
    if (c.csrf && !extra.noCsrf) headers['X-CSRF-Token'] = c.csrf;
    const res = await fetch(BASE + url, {
      method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) c.cookie = setCookie.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json, headers: res.headers };
  };
  c.login = async (pw = PASSWORD) => {
    const r = await c.req('POST', '/api/login', { password: pw });
    if (r.status === 200) c.csrf = r.json.csrfToken;
    return r;
  };
  return c;
}

const admin = client();
const anon = client();
let people = []; // [{id, name}]
const ids = () => people.map((p) => p.id);
const member = (inv, pid) => inv.members.find((m) => m.personId === pid);
const lastInvoice = (state) => state.invoices[0];

test.before(start);
test.after(async () => { await stop(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('Scenario I — authentication: wrong password rejected, correct accepted', async () => {
  const bad = await admin.login('wrong');
  assert.equal(bad.status, 401);
  assert.equal(admin.cookie, '');
  const s0 = await admin.req('GET', '/api/session');
  assert.equal(s0.json.isAdmin, false);

  const ok = await admin.login();
  assert.equal(ok.status, 200);
  assert.ok(ok.json.csrfToken);
  const cookieHeader = ok.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  const s1 = await admin.req('GET', '/api/session');
  assert.equal(s1.json.isAdmin, true);
});

test('setup — admin adds 20 people', async () => {
  const names = ['محمد', 'أحمد', 'علي', 'خالد', 'سامر', 'يوسف', 'عمر', 'حسن', 'سعيد', 'فادي',
    'رامي', 'زياد', 'كريم', 'ماجد', 'نادر', 'وليد', 'طارق', 'باسل', 'جمال', 'هادي'];
  let state;
  for (const n of names) {
    const r = await admin.req('POST', '/api/people', { name: n });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    state = r.json;
  }
  people = state.people;
  assert.equal(people.length, 20);
  const dup = await admin.req('POST', '/api/people', { name: ' محمد ' });
  assert.equal(dup.status, 409);
  const empty = await admin.req('POST', '/api/people', { name: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'الاسم مطلوب.');
});

test('Scenario A — equal split: 20 participants, $100, one payer', async () => {
  const [payer] = people;
  const r = await admin.req('POST', '/api/invoices', {
    name: 'النقل', participantIds: ids(), total: '100', splitMode: 'equal',
    payers: [{ personId: payer.id, amount: '100' }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const inv = lastInvoice(r.json);
  assert.equal(inv.members.length, 20);
  for (const m of inv.members) assert.equal(m.share, 500);
  assert.equal(member(inv, payer.id).net, 9500);
  for (const p of people.slice(1)) assert.equal(member(inv, p.id).net, -500);
  assert.equal(inv.netSum, 0);
});

test('Scenario B — partial group: only the 8 participants are affected', async () => {
  const before = (await anon.req('GET', '/api/state')).json.summary;
  const eight = people.slice(0, 8);
  const r = await admin.req('POST', '/api/invoices', {
    name: 'العشاء', participantIds: eight.map((p) => p.id), total: '200', splitMode: 'equal',
    payers: [{ personId: eight[2].id, amount: '200' }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const inv = lastInvoice(r.json);
  assert.equal(inv.members.length, 8);
  for (const m of inv.members) assert.equal(m.share, 2500);
  assert.equal(member(inv, eight[2].id).net, 17500);
  const after = r.json.summary;
  for (const p of people.slice(8)) {
    const b = before.find((s) => s.personId === p.id);
    const a = after.find((s) => s.personId === p.id);
    assert.deepEqual(a, b, `${p.name} must not be affected`);
    assert.equal(member(inv, p.id), undefined);
  }
});

test('Scenario C — manual split must equal the total', async () => {
  const [a, b] = people;
  const base = { name: 'قهوة', participantIds: [a.id, b.id], total: '25', splitMode: 'manual', payers: [{ personId: a.id, amount: '25' }] };
  // Shares that add up to more or less than the total are allowed (shown as a difference)
  for (const [x, y, sum] of [['15', '9', 2400], ['15', '11', 2600]]) {
    const r = await admin.req('POST', '/api/invoices', { ...base, shares: [{ personId: a.id, amount: x }, { personId: b.id, amount: y }] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const inv = lastInvoice(r.json);
    assert.equal(inv.total, 2500);
    assert.equal(inv.shareSum, sum);
    assert.equal(member(inv, a.id).net, 2500 - 1500);
    assert.equal(member(inv, b.id).net, -Number(y) * 100);
    assert.equal((await admin.req('DELETE', `/api/invoices/${inv.id}`)).status, 200);
  }
  // …but not all zero
  const zeroSum = await admin.req('POST', '/api/invoices', { ...base, shares: [{ personId: a.id, amount: '0' }, { personId: b.id, amount: '0' }] });
  assert.equal(zeroSum.status, 400);
  assert.equal(zeroSum.json.error, 'مجموع الحصص يجب أن يكون أكبر من صفر.');
  const ok = await admin.req('POST', '/api/invoices', { ...base, shares: [{ personId: a.id, amount: '15' }, { personId: b.id, amount: '10' }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const inv = lastInvoice(ok.json);
  assert.equal(inv.splitMode, 'manual');
  assert.equal(member(inv, a.id).share, 1500);
  assert.equal(member(inv, b.id).share, 1000);
  assert.equal(member(inv, a.id).net, 1000);
  assert.equal(member(inv, b.id).net, -1000);

  // A zero share is allowed (e.g. محمد = 0)
  const zero = await admin.req('POST', '/api/invoices', {
    ...base, participantIds: [a.id, b.id, people[2].id], name: 'مثال',
    shares: [{ personId: a.id, amount: '0' }, { personId: b.id, amount: '15' }, { personId: people[2].id, amount: '10' }],
  });
  assert.equal(zero.status, 201, JSON.stringify(zero.json));
  assert.equal(member(lastInvoice(zero.json), a.id).net, 2500);
});

test('whole numbers — fractions are rounded up everywhere', async () => {
  const [a, b, c] = people;
  // 100 ÷ 3 = 33.33 → 34 each (shares total 102)
  const r = await admin.req('POST', '/api/invoices', {
    name: 'تقريب', participantIds: [a.id, b.id, c.id], total: '100', splitMode: 'equal', payers: [{ personId: a.id, amount: '100' }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  let inv = lastInvoice(r.json);
  assert.deepEqual(inv.members.map((m) => m.share), [3400, 3400, 3400]);
  assert.equal(inv.shareSum, 10200);
  assert.deepEqual(inv.members.map((m) => m.net), [6600, -3400, -3400]);
  // decimal inputs: total 99.2 → 100, manual 5.1 → 6 and 5.7 → 6, settlement 3.2 → 4
  const r2 = await admin.req('PUT', `/api/invoices/${inv.id}`, {
    name: 'تقريب', participantIds: [a.id, b.id], total: '99.2', splitMode: 'manual', version: inv.version,
    payers: [{ personId: a.id, amount: '99.2' }],
    shares: [{ personId: a.id, amount: '5.1' }, { personId: b.id, amount: '5.7' }],
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  inv = r2.json.invoices.find((i) => i.id === inv.id);
  assert.equal(inv.total, 10000);
  assert.deepEqual(inv.members.map((m) => m.share), [600, 600]);
  const s = await admin.req('PUT', `/api/invoices/${inv.id}/settlements/${b.id}`, { amount: '3.2' });
  assert.equal(member(s.json.invoices.find((i) => i.id === inv.id), b.id).settled, 400);
  // every amount in the state is a whole number
  for (const i of s.json.invoices) {
    for (const v of [i.total, ...i.members.flatMap((m) => [m.paid, m.share, m.settled, m.net])]) assert.equal(Math.abs(v % 100), 0);
  }
  assert.equal((await admin.req('DELETE', `/api/invoices/${inv.id}`)).status, 200);
});

test('invoice description — optional, saved, editable, validated', async () => {
  const [a, b] = people;
  const base = { name: 'العشاء', participantIds: [a.id, b.id], total: '40', splitMode: 'equal', payers: [{ personId: a.id, amount: '40' }] };

  // optional: missing or empty → ''
  let r = await admin.req('POST', '/api/invoices', base);
  assert.equal(r.status, 201);
  assert.equal(lastInvoice(r.json).description, '');
  await admin.req('DELETE', `/api/invoices/${lastInvoice(r.json).id}`);

  // saved as-is (line breaks kept, spaces tidied, HTML is just text)
  r = await admin.req('POST', '/api/invoices', { ...base, description: '  بيتزا   كبيرة\r\nمشروبات\n\n\n\n<b>حلويات</b>  ' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  let inv = lastInvoice(r.json);
  assert.equal(inv.description, 'بيتزا كبيرة\nمشروبات\n\n<b>حلويات</b>');

  // editable, and can be cleared
  r = await admin.req('PUT', `/api/invoices/${inv.id}`, { ...base, version: inv.version, description: 'تم التعديل' });
  inv = r.json.invoices.find((i) => i.id === inv.id);
  assert.equal(inv.description, 'تم التعديل');
  r = await admin.req('PUT', `/api/invoices/${inv.id}`, { ...base, version: inv.version, description: '' });
  inv = r.json.invoices.find((i) => i.id === inv.id);
  assert.equal(inv.description, '');

  // validation
  const long = await admin.req('POST', '/api/invoices', { ...base, description: 'ا'.repeat(501) });
  assert.equal(long.status, 400);
  assert.match(long.json.error, /الوصف طويل جداً/);
  assert.equal((await admin.req('POST', '/api/invoices', { ...base, description: 'ا'.repeat(500) })).status, 201);
  assert.equal((await admin.req('POST', '/api/invoices', { ...base, description: { x: 1 } })).status, 400);
  assert.equal((await admin.req('POST', '/api/invoices', { ...base, description: 123 })).status, 400);

  // normal users can read it but not change it
  const pub = (await anon.req('GET', '/api/state')).json;
  assert.ok(pub.invoices.every((i) => typeof i.description === 'string'));
  assert.equal((await anon.req('PUT', `/api/invoices/${inv.id}`, { ...base, version: inv.version + 1, description: 'x' })).status, 401);

  // clean up so later scenarios see the same data as before
  for (const i of (await anon.req('GET', '/api/state')).json.invoices.filter((x) => x.name === 'العشاء' && x.members.length === 2)) {
    await admin.req('DELETE', `/api/invoices/${i.id}`);
  }
});

test('Scenario D — multiple payers', async () => {
  const [m, a, al, k] = people;
  const base = { name: 'الفندق', participantIds: [m.id, a.id, al.id, k.id], total: '200', splitMode: 'equal' };
  const mismatch = await admin.req('POST', '/api/invoices', { ...base, payers: [{ personId: m.id, amount: '120' }, { personId: a.id, amount: '70' }] });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.json.error, /مجموع ما دفعه الدافعون/);

  const r = await admin.req('POST', '/api/invoices', { ...base, payers: [{ personId: m.id, amount: '120' }, { personId: a.id, amount: '80' }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const inv = lastInvoice(r.json);
  assert.deepEqual([m, a, al, k].map((p) => member(inv, p.id).net), [7000, 3000, -5000, -5000]);
  assert.equal(inv.netSum, 0);
});

test('Scenarios E, F, G — partial, full, and over settlement', async () => {
  const [a, b] = people;
  const r = await admin.req('POST', '/api/invoices', {
    name: 'تذاكر', participantIds: [a.id, b.id], total: '20', splitMode: 'equal', payers: [{ personId: a.id, amount: '20' }],
  });
  const inv = lastInvoice(r.json);
  assert.equal(member(inv, b.id).net, -1000); // b owes $10
  const url = `/api/invoices/${inv.id}/settlements/${b.id}`;

  // E: records 8 → 2 remaining
  let s = await admin.req('PUT', url, { amount: '8' });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  let mb = member(s.json.invoices.find((i) => i.id === inv.id), b.id);
  assert.equal(mb.remaining, 200);
  assert.equal(mb.status, 'partial');

  // F: records 10 → settled
  s = await admin.req('PUT', url, { amount: '10.00' });
  mb = member(s.json.invoices.find((i) => i.id === inv.id), b.id);
  assert.equal(mb.remaining, 0);
  assert.equal(mb.status, 'settled');

  // "تم" button: the server computes the full amount itself
  await admin.req('PUT', url, { amount: '0' });
  s = await admin.req('PUT', url, { done: true });
  mb = member(s.json.invoices.find((i) => i.id === inv.id), b.id);
  assert.equal(mb.settled, 1000);
  assert.equal(mb.status, 'settled');

  // creditor records receipt too → invoice balanced
  s = await admin.req('PUT', `/api/invoices/${inv.id}/settlements/${a.id}`, { done: true });
  let invNow = s.json.invoices.find((i) => i.id === inv.id);
  assert.equal(invNow.discrepancy, 0);

  // G: overpayment → positive discrepancy
  s = await admin.req('PUT', url, { amount: '12' });
  invNow = s.json.invoices.find((i) => i.id === inv.id);
  mb = member(invNow, b.id);
  assert.equal(mb.status, 'over');
  assert.equal(mb.diff, 200);
  assert.equal(invNow.discrepancy, 200);

  // invalid settlement values
  for (const bad of ['-5', 'abc', 'NaN', 'Infinity', '1e3', -1, null]) {
    const x = await admin.req('PUT', url, { amount: bad });
    assert.equal(x.status, 400, `amount ${bad}`);
  }
});

test('Scenario H — normal users cannot call admin APIs', async () => {
  const state = (await anon.req('GET', '/api/state')).json;
  const inv = state.invoices[0];
  const pid = inv.members[0].personId;
  const attempts = [
    ['POST', '/api/people', { name: 'مخترق' }],
    ['PUT', `/api/people/${pid}`, { name: 'مخترق' }],
    ['DELETE', `/api/people/${people[19].id}`, undefined],
    ['POST', '/api/invoices', { name: 'x', participantIds: [pid], total: '1', splitMode: 'equal', payers: [{ personId: pid, amount: '1' }] }],
    ['PUT', `/api/invoices/${inv.id}`, { version: inv.version, name: 'x', participantIds: [pid], total: '1', splitMode: 'equal', payers: [{ personId: pid, amount: '1' }] }],
    ['DELETE', `/api/invoices/${inv.id}`, undefined],
    ['PUT', `/api/invoices/${inv.id}/settlements/${pid}`, { amount: '999' }],
    ['PUT', `/api/invoices/${inv.id}/settlements/${pid}`, { done: true }],
  ];
  for (const [method, url, body] of attempts) {
    const r = await anon.req(method, url, body);
    assert.equal(r.status, 401, `${method} ${url}`);
  }
  // forged cookie
  const forged = client();
  forged.cookie = 'trip_sid=' + 'A'.repeat(43);
  forged.csrf = 'x';
  assert.equal((await forged.req('POST', '/api/people', { name: 'x' })).status, 401);

  // admin cookie but missing / wrong CSRF token
  assert.equal((await admin.req('POST', '/api/people', { name: 'x' }, { noCsrf: true })).status, 403);
  assert.equal((await admin.req('POST', '/api/people', { name: 'x' }, { noCsrf: true, headers: { 'X-CSRF-Token': 'nope' } })).status, 403);
  // cross-site origin
  assert.equal((await admin.req('POST', '/api/people', { name: 'x' }, { headers: { Origin: 'http://evil.example' } })).status, 403);
  // form-style (non-JSON) body
  assert.equal((await admin.req('POST', '/api/people', 'name=x', { contentType: 'text/plain' })).status, 415);

  const after = (await anon.req('GET', '/api/state')).json;
  assert.deepEqual(after, state, 'nothing changed');
});

test('validation — IDs, payers, amounts, IDOR, conflicts', async () => {
  const [a, b, c] = people;
  const base = { name: 'اختبار', participantIds: [a.id, b.id], total: '10', splitMode: 'equal', payers: [{ personId: a.id, amount: '10' }] };
  const cases = [
    [{ ...base, participantIds: [] }, 'يجب اختيار مشارك واحد على الأقل.'],
    [{ ...base, participantIds: [a.id, 99999] }, 'الشخص غير موجود.'],
    [{ ...base, participantIds: [a.id, a.id] }, null],
    [{ ...base, participantIds: [a.id, '1; DROP TABLE people'] }, null],
    [{ ...base, payers: [] }, 'يجب اختيار دافع واحد على الأقل.'],
    [{ ...base, payers: [{ personId: c.id, amount: '10' }] }, 'يجب أن يكون الدافع من ضمن المشاركين.'],
    [{ ...base, total: '-10' }, null],
    [{ ...base, total: '0' }, null],
    [{ ...base, total: 'Infinity' }, null],
    [{ ...base, total: 1e308 }, null],
    [{ ...base, name: '' }, 'اسم المصروف مطلوب.'],
    [{ ...base, splitMode: 'magic' }, null],
    [{ ...base, splitMode: 'manual', shares: [{ personId: a.id, amount: '-5' }, { personId: b.id, amount: '15' }] }, 'لا يمكن أن تكون الحصة سالبة.'],
    [{ ...base, splitMode: 'manual', shares: [{ personId: a.id, amount: '10' }] }, null],
  ];
  for (const [body, msg] of cases) {
    const r = await admin.req('POST', '/api/invoices', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    if (msg) assert.equal(r.json.error, msg);
  }

  // client-sent balances/shares are ignored for an equal split — the server recomputes
  const r = await admin.req('POST', '/api/invoices', { ...base, shares: [{ personId: a.id, amount: '0' }, { personId: b.id, amount: '10' }], net: 999 });
  const inv = lastInvoice(r.json);
  assert.equal(member(inv, a.id).share, 500);
  assert.equal(member(inv, b.id).net, -500);

  // settlement for someone who is not in the invoice (IDOR) / unknown invoice
  assert.equal((await admin.req('PUT', `/api/invoices/${inv.id}/settlements/${c.id}`, { amount: '1' })).status, 404);
  assert.equal((await admin.req('PUT', `/api/invoices/99999/settlements/${a.id}`, { amount: '1' })).status, 404);
  assert.equal((await admin.req('PUT', `/api/invoices/abc/settlements/${a.id}`, { amount: '1' })).status, 404);

  // edit keeps settlements, requires the current version
  await admin.req('PUT', `/api/invoices/${inv.id}/settlements/${b.id}`, { amount: '3' });
  const stale = await admin.req('PUT', `/api/invoices/${inv.id}`, { ...base, version: inv.version + 5 });
  assert.equal(stale.status, 409);
  const edited = await admin.req('PUT', `/api/invoices/${inv.id}`, { ...base, total: '30', payers: [{ personId: a.id, amount: '30' }], version: inv.version });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const e = edited.json.invoices.find((i) => i.id === inv.id);
  assert.equal(member(e, b.id).net, -1500);
  assert.equal(member(e, b.id).settled, 300);
  assert.equal(member(e, b.id).remaining, 1200);

  // cannot delete a person referenced by invoices; can delete an unused one
  const del = await admin.req('DELETE', `/api/people/${a.id}`);
  assert.equal(del.status, 409);
  const extra = await admin.req('POST', '/api/people', { name: 'مؤقت' });
  const tmp = extra.json.people.find((p) => p.name === 'مؤقت');
  assert.equal((await admin.req('DELETE', `/api/people/${tmp.id}`)).status, 200);
  assert.equal((await admin.req('DELETE', `/api/people/${tmp.id}`)).status, 404);

  // HTML in names is stored as plain text (the client renders text nodes only)
  const x = await admin.req('POST', '/api/people', { name: '<img src=x onerror=alert(1)>' });
  assert.equal(x.status, 201);
  assert.ok(x.json.people.some((p) => p.name === '<img src=x onerror=alert(1)>'));

  // malformed JSON → clean Arabic error, no stack trace
  const bad = await admin.req('POST', '/api/people', '{"name":', {});
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'البيانات المرسلة غير صالحة.');
});

test('Scenario J — persistence across restart', async () => {
  const before = (await anon.req('GET', '/api/state')).json;
  assert.ok(before.invoices.length >= 6);
  await stop();
  await start();
  const after = (await anon.req('GET', '/api/state')).json;
  assert.deepEqual(after, before);
  // admin session also survives a restart
  assert.equal((await admin.req('GET', '/api/session')).json.isAdmin, true);
});

test('logout ends the admin session', async () => {
  const c = client();
  await c.login();
  assert.equal((await c.req('POST', '/api/logout', {})).status, 200);
  assert.equal((await c.req('POST', '/api/people', { name: 'بعد الخروج' })).status, 401);
});

test('reset — admin only, requires confirmation, backs up first', async () => {
  const before = (await anon.req('GET', '/api/state')).json;
  assert.ok(before.invoices.length > 0 && before.people.length > 0);

  assert.equal((await anon.req('POST', '/api/reset', { scope: 'all', confirm: 'RESET' })).status, 401);
  assert.equal((await admin.req('POST', '/api/reset', { scope: 'all', confirm: 'RESET' }, { noCsrf: true })).status, 403);
  assert.equal((await admin.req('POST', '/api/reset', { scope: 'all' })).status, 400);
  assert.equal((await admin.req('POST', '/api/reset', { scope: 'everything', confirm: 'RESET' })).status, 400);
  assert.deepEqual((await anon.req('GET', '/api/state')).json, before, 'rejected resets change nothing');

  // expenses only: people stay, their balances go back to zero
  const r1 = await admin.req('POST', '/api/reset', { scope: 'invoices', confirm: 'RESET' });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.invoices.length, 0);
  assert.equal(r1.json.totals.spent, 0);
  assert.deepEqual(r1.json.people.map((p) => p.name), before.people.map((p) => p.name));
  assert.ok(r1.json.summary.every((s) => s.net === 0 && s.paid === 0));
  assert.equal((await admin.req('DELETE', `/api/people/${people[0].id}`)).status, 200, 'people are no longer referenced');

  // everything
  const r2 = await admin.req('POST', '/api/reset', { scope: 'all', confirm: 'RESET' });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.people.length, 0);
  assert.equal(r2.json.invoices.length, 0);

  const backups = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((f) => f.startsWith('before-reset-'));
  assert.ok(backups.length >= 1);
  // the backup holds the pre-reset data
  const Database = require('better-sqlite3');
  const bdb = new Database(path.join(DATA_DIR, 'backups', backups.sort()[0]), { readonly: true });
  assert.equal(bdb.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, before.invoices.length);
  bdb.close();
});

test('payments section — total to pay / paid and total to receive / received per person', async () => {
  // starts from the empty state left by the reset test
  let st;
  for (const n of ['س', 'ص', 'ع']) st = (await admin.req('POST', '/api/people', { name: n })).json;
  const [X, Y, Z] = st.people;
  // inv1: X paid 90 for X, Y, Z → X +60, Y −30, Z −30
  const i1 = lastInvoice((await admin.req('POST', '/api/invoices', {
    name: 'أ', participantIds: [X.id, Y.id, Z.id], total: '90', splitMode: 'equal', payers: [{ personId: X.id, amount: '90' }],
  })).json);
  // inv2: Y paid 60 for X, Y → X −30, Y +30
  const i2 = lastInvoice((await admin.req('POST', '/api/invoices', {
    name: 'ب', participantIds: [X.id, Y.id], total: '60', splitMode: 'equal', payers: [{ personId: Y.id, amount: '60' }],
  })).json);
  await admin.req('PUT', `/api/invoices/${i1.id}/settlements/${Y.id}`, { done: true });
  await admin.req('PUT', `/api/invoices/${i1.id}/settlements/${Z.id}`, { amount: '10' });
  await admin.req('PUT', `/api/invoices/${i1.id}/settlements/${X.id}`, { amount: '40' });
  st = (await admin.req('PUT', `/api/invoices/${i2.id}/settlements/${X.id}`, { done: true })).json;

  const pick = (id) => {
    const s = st.summary.find((x) => x.personId === id);
    return [s.owe, s.owePaid, s.receive, s.received].map((c) => c / 100);
  };
  // X owes 30 in inv2 (paid) and is owed 60 in inv1 (received 40) — the two are NOT netted
  assert.deepEqual(pick(X.id), [30, 30, 60, 40]);
  assert.deepEqual(pick(Y.id), [30, 30, 30, 0]);
  assert.deepEqual(pick(Z.id), [30, 10, 0, 0]);
  // the net view still nets them: X = +60 − 30 = +30
  assert.equal(st.summary.find((x) => x.personId === X.id).net, 3000);
  // visible to normal users too
  assert.deepEqual((await anon.req('GET', '/api/state')).json.summary, st.summary);
});

test('final bill — personal spending, paid for others, unaffected by settlements', async () => {
  const before = (await anon.req('GET', '/api/state')).json;
  const bill = (st) => st.summary.map((s) => [s.personId, s.share, s.paid, s.receive, s.owe, s.net]);
  for (const s of before.summary) {
    assert.equal(s.net, s.paid - s.share);
    assert.equal(s.net, s.receive - s.owe, 'final result = paid for others − paid by others');
  }
  // X from the previous test: share 30+30=60, paid 90, paid for others 60, others paid for him 30 → receives 30
  const X = before.summary.find((s) => s.name === 'س');
  assert.deepEqual([X.share, X.paid, X.receive, X.owe, X.net].map((c) => c / 100), [60, 90, 60, 30, 30]);

  // recording (or undoing) payments must not change the final bill
  const inv = before.invoices[0];
  for (const m of inv.members) await admin.req('PUT', `/api/invoices/${inv.id}/settlements/${m.personId}`, { amount: '0' });
  const mid = (await anon.req('GET', '/api/state')).json;
  assert.deepEqual(bill(mid), bill(before));
  for (const m of inv.members) if (m.expected) await admin.req('PUT', `/api/invoices/${inv.id}/settlements/${m.personId}`, { done: true });
  const after = (await anon.req('GET', '/api/state')).json;
  assert.deepEqual(bill(after), bill(before));
});

test('final settlement — one amount per person spread over all his invoices (netted, oldest first)', async () => {
  let st;
  for (const n of ['أ1', 'ب1', 'ج1', 'د1', 'هـ1', 'و1']) st = (await admin.req('POST', '/api/people', { name: n })).json;
  const id = (n) => st.people.find((p) => p.name === n).id;
  const [A, B, C, D, E, F] = ['أ1', 'ب1', 'ج1', 'د1', 'هـ1', 'و1'].map(id);
  const add = async (name, ids, total, payer) => lastInvoice((await admin.req('POST', '/api/invoices', {
    name, participantIds: ids, total: String(total), splitMode: 'equal', payers: [{ personId: payer, amount: String(total) }],
  })).json).id;
  const i1 = await add('ف1', [A, B, C], 300, A); // A +200, B −100, C −100
  const i2 = await add('ف2', [A, B], 60, B);     // A −30,  B +30
  const i3 = await add('ف3', [A, B, C], 90, C);  // A −30,  B −30, C +60
  // finals: A +140 (receives), B −100 (pays), C −40 (pays)
  const put = (pid, body) => admin.req('PUT', `/api/people/${pid}/final-settlement`, body);
  const settledOf = (state, pid) => Object.fromEntries([i1, i2, i3].map((iid) => {
    const m = state.invoices.find((i) => i.id === iid).members.find((x) => x.personId === pid);
    return [iid, m ? m.settled / 100 : null];
  }));
  const person = (state, pid) => state.summary.find((x) => x.personId === pid);

  // B pays part of his 100: his 30 receivable (ف2) is netted, 30 + 50 = 80 goes to ف1 first (oldest)
  let r = await put(B, { amount: '50' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(settledOf(r.json, B), { [i1]: 80, [i2]: 30, [i3]: 0 });
  let b = person(r.json, B);
  assert.equal((b.owePaid - b.received) / 100, 50, 'paid so far is derived back as 50');

  // B pays everything → every invoice he is in is settled exactly
  r = await put(B, { done: true });
  assert.deepEqual(settledOf(r.json, B), { [i1]: 100, [i2]: 30, [i3]: 30 });
  for (const iid of [i1, i2, i3]) assert.equal(r.json.invoices.find((i) => i.id === iid).members.find((x) => x.personId === B).diff, 0);
  b = person(r.json, B);
  assert.equal(b.owePaid - b.received, -b.net);

  // the same result when typing the exact amount
  r = await put(B, { amount: '100' });
  assert.deepEqual(settledOf(r.json, B), { [i1]: 100, [i2]: 30, [i3]: 30 });

  // C overpays (50 instead of 40): extra lands on his last debt invoice as overpayment
  r = await put(C, { amount: '50' });
  assert.deepEqual(settledOf(r.json, C), { [i1]: 110, [i2]: null, [i3]: 60 });
  assert.equal(r.json.invoices.find((i) => i.id === i1).members.find((x) => x.personId === C).diff, 1000);

  // A receives his 140: his debts (ف2, ف3) are netted, 60 + 140 = 200 received in ف1
  r = await put(A, { done: true });
  assert.deepEqual(settledOf(r.json, A), { [i1]: 200, [i2]: 30, [i3]: 30 });

  // final amounts never change
  assert.deepEqual([A, B, C].map((pid) => person(r.json, pid).net / 100), [140, -100, -40]);

  // net zero: D pays 10 for E in one invoice and E pays 10 for D in another
  const i4 = await add('ف4', [D, E], 20, D);
  const i5 = await add('ف5', [D, E], 20, E);
  const zero = await put(D, { amount: '5' });
  assert.equal(zero.status, 400);
  r = await put(D, { done: true });
  assert.equal(r.status, 200);
  for (const iid of [i4, i5]) assert.equal(r.json.invoices.find((i) => i.id === iid).members.find((x) => x.personId === D).diff, 0);

  // errors & authorization
  assert.equal((await put(F, { amount: '1' })).status, 400, 'person with no invoices');
  assert.equal((await put(99999, { amount: '1' })).status, 404);
  assert.equal((await put(B, { amount: '-5' })).status, 400);
  assert.equal((await put(B, { amount: 'abc' })).status, 400);
  assert.equal((await anon.req('PUT', `/api/people/${B}/final-settlement`, { done: true })).status, 401);
  assert.equal((await admin.req('PUT', `/api/people/${B}/final-settlement`, { done: true }, { noCsrf: true })).status, 403);
});

test('login rate limiting', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) assert.equal((await c.login('guess' + i)).status, 401);
  const blocked = await c.login(); // even the right password is refused while locked
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.error, /محاولات كثيرة/);
});
