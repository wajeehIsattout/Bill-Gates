/*
 * Money + accounting helpers shared by the server (require) and the browser (window.Money).
 * Amounts are integer cents internally, but the app only works with WHOLE numbers:
 * any fraction entered is rounded UP (5.1 → 6, 5.7 → 6), so every stored value is a multiple of 100.
 */
(function (root) {
  'use strict';

  var MAX_CENTS = 1000000000; // 10,000,000.00 — sane upper bound for one amount

  var DIGIT_MAP = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  };

  // Accepts "200", "200.5", Arabic-Indic digits, "٫" or "," as decimal separator (max 2 decimals).
  // Any fraction is rounded UP to the next whole number. Returns cents (a multiple of 100),
  // or null when the value is not a valid non-negative amount.
  function parseMoney(value) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) return null;
      value = String(value);
    }
    if (typeof value !== 'string') return null;
    var s = value.trim().replace(/[٠-٩۰-۹]/g, function (d) { return DIGIT_MAP[d]; });
    s = s.replace(/[٫,]/g, '.').replace(/\s+/g, '');
    if (s.length === 0 || s.length > 16) return null;
    var m = /^(\d{0,10})(?:\.(\d{0,2}))?$/.exec(s);
    if (!m || (m[1] === '' && !m[2])) return null;
    var whole = m[1] === '' ? 0 : parseInt(m[1], 10);
    if (m[2] && /[1-9]/.test(m[2])) whole += 1; // ceil
    var cents = whole * 100;
    if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
    return cents;
  }

  // 12300 -> "123" (for input fields; values are non-negative)
  function centsToPlain(cents) {
    return String(Math.ceil(Math.abs(cents) / 100) * (cents < 0 ? -1 : 1));
  }

  // 123400 -> "1,234" (always unsigned, no decimals)
  function formatAbs(cents) {
    return String(Math.ceil(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // Equal split: every participant's share is total ÷ count rounded UP to a whole number.
  // (e.g. 100 ÷ 3 → 34 each, so the shares add up to 102 — slightly more than the total.)
  function equalSplit(totalCents, personIds) {
    var n = personIds.length;
    var shares = {};
    if (n === 0) return shares;
    var each = Math.ceil(Math.ceil(totalCents / 100) / n) * 100;
    personIds.forEach(function (id) { shares[id] = each; });
    return shares;
  }

  /*
   * members: [{ personId, paid, share, settled }] (cents)
   * net = paid − share   (positive: should receive, negative: should pay)
   * expected = |net|     (amount that must move for this person to be square)
   * diff = settled − expected (negative: still missing, positive: over-settled)
   */
  function computeInvoice(members) {
    var rows = members.map(function (m) {
      var net = m.paid - m.share;
      var expected = Math.abs(net);
      var diff = m.settled - expected;
      var status;
      if (expected === 0 && m.settled === 0) status = 'even';
      else if (diff === 0) status = 'settled';
      else if (diff < 0) status = m.settled > 0 ? 'partial' : 'pending';
      else status = 'over';
      return {
        personId: m.personId,
        paid: m.paid,
        share: m.share,
        settled: m.settled,
        net: net,
        expected: expected,
        remaining: Math.max(0, -diff),
        diff: diff,
        status: status,
      };
    });
    var netSum = 0, shareSum = 0, discrepancy = 0, missing = 0, over = 0;
    rows.forEach(function (r) {
      netSum += r.net;
      shareSum += r.share;
      discrepancy += r.diff;
      if (r.diff < 0) missing += -r.diff; else over += r.diff;
    });
    return { rows: rows, netSum: netSum, shareSum: shareSum, discrepancy: discrepancy, missing: missing, over: over };
  }

  var api = {
    MAX_CENTS: MAX_CENTS,
    parseMoney: parseMoney,
    centsToPlain: centsToPlain,
    formatAbs: formatAbs,
    equalSplit: equalSplit,
    computeInvoice: computeInvoice,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Money = api;
})(this);
