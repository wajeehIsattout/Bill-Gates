'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../public/money.js');

test('parseMoney accepts valid amounts and always rounds fractions UP to whole numbers', () => {
  assert.equal(M.parseMoney('100'), 10000);
  assert.equal(M.parseMoney('5.1'), 600);
  assert.equal(M.parseMoney('5.7'), 600);
  assert.equal(M.parseMoney('5.0'), 500);
  assert.equal(M.parseMoney('200.50'), 20100);
  assert.equal(M.parseMoney('0.01'), 100);
  assert.equal(M.parseMoney('.75'), 100);
  assert.equal(M.parseMoney('١٥٫٥'), 1600); // Arabic-Indic digits + Arabic decimal separator
  assert.equal(M.parseMoney('7,25'), 800);
  assert.equal(M.parseMoney(12.5), 1300);
  assert.equal(M.parseMoney('0'), 0);
});

test('parseMoney rejects invalid / negative / non-finite values', () => {
  for (const bad of ['', ' ', '-5', 'abc', '1e5', 'NaN', 'Infinity', '1.234', '1,000', '1..2', '0x10', null, undefined, {}, [], -1, NaN, Infinity, '99999999999']) {
    assert.equal(M.parseMoney(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('formatting has no decimals and no currency symbol', () => {
  assert.equal(M.formatAbs(123400), '1,234');
  assert.equal(M.formatAbs(-500), '5');
  assert.equal(M.centsToPlain(3400), '34');
});

test('equalSplit rounds each share UP to a whole number', () => {
  assert.deepEqual(M.equalSplit(10000, [1, 2, 3]), { 1: 3400, 2: 3400, 3: 3400 }); // 33.33 → 34
  assert.deepEqual(M.equalSplit(10000, [1, 2, 3, 4]), { 1: 2500, 2: 2500, 3: 2500, 4: 2500 });
  assert.deepEqual(M.equalSplit(1000, [1, 2, 3, 4, 5, 6, 7]), Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [i, 200]))); // 1.43 → 2
});

test('computeInvoice: net = paid − share, sums to zero, settlement diff', () => {
  const r = M.computeInvoice([
    { personId: 1, paid: 12000, share: 5000, settled: 0 },
    { personId: 2, paid: 8000, share: 5000, settled: 3000 },
    { personId: 3, paid: 0, share: 5000, settled: 4000 },
    { personId: 4, paid: 0, share: 5000, settled: 6000 },
  ]);
  assert.deepEqual(r.rows.map((x) => x.net), [7000, 3000, -5000, -5000]);
  assert.equal(r.netSum, 0);
  assert.equal(r.shareSum, 20000);
  assert.deepEqual(r.rows.map((x) => x.status), ['pending', 'settled', 'partial', 'over']);
  assert.equal(r.rows[2].remaining, 1000);
  assert.equal(r.discrepancy, -7000 + 0 - 1000 + 1000);
});
