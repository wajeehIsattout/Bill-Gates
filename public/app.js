/* Trip expenses — client. All data comes from the server; nothing here is trusted by the server. */
(function () {
  'use strict';

  var M = window.Money;
  var S = {
    data: null,
    isAdmin: false,
    csrf: null,
    expanded: new Set(),
    finalOpen: false,      // final-bill card opened?
    finalPeople: new Set(), // people opened inside it
    loginOpen: false,
    busy: false,
  };

  // ---------------------------------------------------------------------------
  // DOM helpers (text is always inserted as text nodes — never as HTML)
  // ---------------------------------------------------------------------------
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  function $(id) { return document.getElementById(id); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function firstChar(s) { return (Array.from(s || '?')[0] || '?').toUpperCase(); }

  var ICONS = [
    [/نقل|تاكسي|سيار|باص|مواصل|تذكر|طيران/, '🚗'], [/بنزين|وقود/, '⛽'], [/فندق|سكن|شالي|إقامة|اقامة/, '🏨'],
    [/فطور|إفطار|افطار|قهوة|كافيه/, '☕'], [/غداء|عشاء|مطعم|أكل|اكل|طعام/, '🍽️'], [/نشاط|رحلة|تذاكر/, '🎯'],
    [/مشتريات|سوبر|بقالة|تسوق/, '🛒'],
  ];
  function invoiceIcon(name) {
    for (var i = 0; i < ICONS.length; i++) if (ICONS[i][0].test(name)) return ICONS[i][1];
    var chars = Array.from(name.replace(/^ال(?=..)/, ''));
    return (chars[0] || '?').toUpperCase();
  }

  // "95.00 $", signed: "+95.00 $" / "−5.00 $"
  function money(cents, signed) {
    if (typeof cents !== 'number' || !isFinite(cents)) return h('span', { class: 'num', dir: 'ltr' }, '—');
    var sign = '';
    if (signed) sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
    else if (cents < 0) sign = '−';
    return h('span', { class: 'num', dir: 'ltr' }, sign + M.formatAbs(cents));
  }
  function plain(cents) { return M.centsToPlain(cents); }

  // Balance with colour AND a text label (not colour alone).
  function balance(net) {
    var cls = net > 0 ? 'pos' : net < 0 ? 'neg' : 'zero';
    var label = net > 0 ? '▲ يستلم' : net < 0 ? '▼ يدفع' : 'متعادل';
    return h('span', { class: 'bal ' + cls }, money(net, true), h('small', null, label));
  }

  function toast(msg, kind) {
    var t = h('div', { class: 'toast ' + (kind || ''), role: kind === 'error' ? 'alert' : 'status' }, msg);
    $('toast-root').appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'error' ? 4500 : 2600);
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (S.csrf) opts.headers['X-CSRF-Token'] = S.csrf;
    return fetch(url, opts).catch(function () {
      throw new Error('تعذّر الاتصال بالخادم. تحقق من الاتصال وحاول مرة أخرى.');
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (!res.ok) {
          if ((res.status === 401 || res.status === 403) && url !== '/api/login' && S.isAdmin) {
            S.isAdmin = false; S.csrf = null; renderAll();
          }
          throw new Error((json && json.error) || 'حدث خطأ غير متوقع.');
        }
        return json;
      });
    });
  }

  // Mutations return the fresh server-computed state.
  function mutate(method, url, body) {
    return api(method, url, body).then(function (data) {
      S.data = data;
      renderAll();
      return data;
    });
  }

  function refresh() {
    return api('GET', '/api/state').then(function (d) { S.data = d; renderAll(); });
  }

  // ---------------------------------------------------------------------------
  // Render: header stats, admin area, people, invoices, summary
  // ---------------------------------------------------------------------------
  function renderAll() {
    if (!S.data) return;
    renderStats();
    renderAdmin();
    renderPeople();
    renderInvoices();
    renderSummary();
    renderPayments();
    renderFinal();
    renderReset();
    renderFab();
  }

  function renderStats() {
    var d = S.data;
    clear($('stats')).append(
      h('div', { class: 'stat' }, h('b', null, money(d.totals.spent)), h('span', null, 'إجمالي المصاريف')),
      h('div', { class: 'stat' }, h('b', null, String(d.invoices.length)), h('span', null, 'المصروفات')),
      h('div', { class: 'stat' }, h('b', null, String(d.people.length)), h('span', null, 'الأشخاص'))
    );
  }

  function renderAdmin() {
    var box = clear($('admin'));
    if (S.isAdmin) {
      box.append(h('div', { class: 'admin-row' },
        h('div', { class: 'admin-status on' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), 'أنت في وضع المسؤول'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: logout }, 'تسجيل الخروج')));
      return;
    }
    box.append(h('div', { class: 'admin-row' },
      h('div', { class: 'admin-status' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), 'وضع المشاهدة فقط'),
      S.loginOpen ? null : h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onclick: function () { S.loginOpen = true; renderAdmin(); var i = $('pw'); if (i) i.focus(); },
      }, '🔒 دخول المسؤول')));
    if (!S.loginOpen) return;
    var err = h('div', { class: 'form-error', role: 'alert', hidden: true });
    var input = h('input', {
      id: 'pw', class: 'input', type: 'password', autocomplete: 'current-password',
      placeholder: 'كلمة المرور', 'aria-label': 'كلمة المرور', maxlength: '200',
    });
    var btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'دخول');
    var form = h('form', { class: 'login-form', novalidate: true }, input, btn);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!input.value) { err.textContent = 'أدخل كلمة المرور.'; err.hidden = false; return; }
      btn.disabled = true;
      api('POST', '/api/login', { password: input.value }).then(function (r) {
        S.isAdmin = true; S.csrf = r.csrfToken; S.loginOpen = false;
        toast('تم تسجيل الدخول كمسؤول', 'success');
        renderAll();
      }).catch(function (e2) {
        err.textContent = e2.message; err.hidden = false; btn.disabled = false; input.select();
      });
    });
    box.append(form, err);
  }

  function logout() {
    api('POST', '/api/logout', {}).catch(function () {}).then(function () {
      S.isAdmin = false; S.csrf = null;
      toast('تم تسجيل الخروج');
      renderAll();
    });
  }

  function avatar(p) {
    return h('span', { class: 'avatar', 'aria-hidden': 'true' }, firstChar(p.name));
  }

  function renderPeople() {
    var people = S.data.people;
    $('people-count').textContent = '(' + people.length + ')';
    var actions = clear($('people-actions'));
    if (S.isAdmin) actions.append(h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: openAddPerson }, '+ إضافة شخص'));
    var list = clear($('people-list'));
    if (!people.length) {
      list.append(h('div', { class: 'empty', style: null },
        h('span', { class: 'big', 'aria-hidden': 'true' }, '👋'),
        S.isAdmin ? 'لا يوجد أشخاص بعد. ابدأ بإضافة المشاركين في الرحلة.' : 'لا يوجد أشخاص بعد.'));
      list.firstChild.style.width = '100%';
      return;
    }
    people.forEach(function (p) {
      if (S.isAdmin) {
        list.append(h('button', {
          class: 'person-chip', type: 'button', 'aria-label': 'تعديل ' + p.name,
          onclick: function () { openEditPerson(p); },
        }, avatar(p), h('span', { class: 'name' }, p.name), h('span', { class: 'edit-mark', 'aria-hidden': 'true' }, '✎')));
      } else {
        list.append(h('span', { class: 'person-chip' }, avatar(p), h('span', { class: 'name' }, p.name)));
      }
    });
  }

  function renderInvoices() {
    var invoices = S.data.invoices;
    $('invoices-count').textContent = '(' + invoices.length + ')';
    var tools = clear($('invoices-tools'));
    if (invoices.length > 1) {
      var allOpen = invoices.every(function (i) { return S.expanded.has(i.id); });
      tools.append(h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onclick: function () {
          if (allOpen) S.expanded.clear();
          else invoices.forEach(function (i) { S.expanded.add(i.id); });
          renderInvoices();
        },
      }, allOpen ? 'طيّ الكل' : 'فتح الكل'));
    }
    var list = clear($('invoice-list'));
    if (!invoices.length) {
      list.append(h('div', { class: 'empty' },
        h('span', { class: 'big', 'aria-hidden': 'true' }, '🧾'),
        S.isAdmin ? 'لا توجد مصروفات بعد. اضغط «إضافة مصروف» لإضافة أول مصروف.' : 'لا توجد مصروفات بعد.'));
      return;
    }
    invoices.forEach(function (inv) { list.append(invoiceCard(inv)); });
  }

  function statusPills(inv) {
    var pills = [];
    var pending = inv.members.filter(function (m) { return m.diff < 0; }).length;
    var over = inv.members.filter(function (m) { return m.diff > 0; }).length;
    var anyDue = inv.members.some(function (m) { return m.expected > 0; });
    if (!pending && !over) {
      pills.push(h('span', { class: 'pill pill-ok' }, anyDue ? '✓ تمت التسوية' : '✓ متوازن'));
    } else {
      if (pending) pills.push(h('span', { class: 'pill pill-neg' }, '⚠ بانتظار التسوية: ' + pending));
      if (over) pills.push(h('span', { class: 'pill pill-pos' }, '↑ زيادة: ' + over));
    }
    pills.push(h('span', { class: 'pill pill-accent' }, inv.splitMode === 'equal' ? 'تقسيم بالتساوي' : 'تقسيم يدوي'));
    return pills;
  }

  function invoiceCard(inv) {
    var open = S.expanded.has(inv.id);
    var payers = inv.members.filter(function (m) { return m.paid > 0; });
    var card = h('article', { class: 'card invoice' + (open ? ' open' : ''), 'data-id': inv.id });
    var bodyId = 'inv-body-' + inv.id;
    card.append(h('button', {
      class: 'inv-head', type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId,
      onclick: function () {
        if (S.expanded.has(inv.id)) S.expanded.delete(inv.id); else S.expanded.add(inv.id);
        card.replaceWith(invoiceCard(inv));
      },
    },
    h('span', { class: 'inv-icon', 'aria-hidden': 'true' }, invoiceIcon(inv.name)),
    h('span', { class: 'inv-title' },
      h('span', { class: 'inv-name' }, inv.name),
      h('span', { class: 'inv-meta' },
        'دفع: ' + payers.map(function (p) { return p.name; }).join('، ') + ' · المشاركون: ' + inv.members.length)),
    h('span', { class: 'inv-total' }, money(inv.total), h('span', { class: 'chev', 'aria-hidden': 'true' }, '▼'))));
    card.append(h('div', { class: 'inv-status-row' }, statusPills(inv)));
    if (open) card.append(invoiceBody(inv, bodyId));
    return card;
  }

  function invoiceBody(inv, bodyId) {
    var body = h('div', { class: 'inv-body', id: bodyId });
    if (S.isAdmin) {
      body.append(h('div', { class: 'inv-tools' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: function () { openWizard(inv); } }, '✎ تعديل المصروف'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: function () { deleteInvoice(inv); } }, 'حذف')));
    }
    if (inv.description) {
      body.append(h('div', { class: 'inv-desc' },
        h('div', { class: 'subhead' }, 'الوصف'),
        h('p', { class: 'desc-text' }, inv.description)));
    }
    if (inv.shareSum !== inv.total) {
      var d = inv.shareSum - inv.total;
      body.append(h('div', { class: 'checkbar warn share-note' }, 'مجموع الحصص ', money(inv.shareSum), ' — ',
        d > 0 ? 'أكثر' : 'أقل', ' من الإجمالي بـ ', money(Math.abs(d)), ' (بسبب التقريب للأعلى أو التقسيم اليدوي).'));
    }
    body.append(h('div', { class: 'subhead' }, 'المشاركون والأرصدة'));
    var list = h('div', { class: 'members' });
    inv.members.forEach(function (m) { list.append(memberCard(inv, m)); });
    body.append(list, invoiceFooter(inv));
    return body;
  }

  function memberCard(inv, m) {
    // Red = this person still has to pay; amber = this person is still waiting to receive money.
    var flag = m.diff < 0 ? (m.net < 0 ? ' flag-missing' : ' flag-waiting') : m.diff > 0 ? ' flag-over' : '';
    var card = h('div', { class: 'member' + flag });
    card.append(h('div', { class: 'member-top' },
      h('div', { class: 'member-name' }, m.name,
        m.paid > 0 ? h('span', { class: 'pill pill-accent' }, 'دفع ', money(m.paid)) : null),
      balance(m.net)));
    card.append(h('div', { class: 'member-sub' }, 'حصته: ', money(m.share)));

    if (m.expected === 0 && m.settled === 0) return card;

    var debtor = m.net < 0;
    var settle = h('div', { class: 'settle' });
    var statusEl;
    if (m.diff === 0) statusEl = h('span', { class: 'pill pill-ok' }, '✓ تم');
    else if (m.diff < 0) statusEl = h('span', { class: 'pill ' + (debtor ? 'pill-neg' : 'pill-warn') }, 'المتبقي: ', money(m.remaining));
    else statusEl = h('span', { class: 'pill pill-pos' }, 'زيادة: ', money(m.diff));

    var what = m.expected === 0 ? 'لا يوجد مبلغ مستحق'
      : debtor ? 'يجب أن يدفع ' : 'يجب أن يستلم ';
    settle.append(h('div', { class: 'settle-line' },
      h('span', null, what, m.expected ? money(m.expected) : null,
        h('span', { class: 'settle-label' }, ' · ', debtor ? 'دفع ' : 'استلم ', money(m.settled))),
      statusEl));

    if (S.isAdmin) {
      var input = h('input', {
        class: 'input num-input', type: 'text', inputmode: 'decimal', autocomplete: 'off',
        placeholder: debtor ? 'المبلغ المدفوع' : 'المبلغ المستلم',
        'aria-label': (debtor ? 'المبلغ المدفوع من ' : 'المبلغ المستلم لـ ') + m.name,
        value: m.settled ? plain(m.settled) : '',
      });
      var save = function () {
        var raw = input.value.trim();
        if (raw.charAt(0) === '-') return toast('لا يمكن أن يكون المبلغ سالباً.', 'error');
        var c = raw === '' ? 0 : M.parseMoney(raw);
        if (c === null) { input.classList.add('invalid'); return toast('المبلغ غير صالح.', 'error'); }
        mutate('PUT', '/api/invoices/' + inv.id + '/settlements/' + m.personId, { amount: plain(c) })
          .then(function () { toast('تم حفظ المبلغ', 'success'); })
          .catch(function (e) { toast(e.message, 'error'); });
      };
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
      input.addEventListener('input', function () { input.classList.remove('invalid'); });
      settle.append(h('div', { class: 'settle-form' },
        input,
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: save }, 'حفظ'),
        m.expected > 0 ? h('button', {
          class: 'btn btn-success btn-sm', type: 'button', disabled: m.diff === 0,
          'aria-label': 'تم — تسوية كاملة لـ ' + m.name,
          onclick: function () {
            mutate('PUT', '/api/invoices/' + inv.id + '/settlements/' + m.personId, { done: true })
              .then(function () { toast('تمت التسوية', 'success'); })
              .catch(function (e) { toast(e.message, 'error'); });
          },
        }, '✓ تم') : null));
    }
    card.append(settle);
    return card;
  }

  function invoiceFooter(inv) {
    var missing = inv.members.filter(function (m) { return m.diff < 0; });
    var over = inv.members.filter(function (m) { return m.diff > 0; });
    var anyDue = inv.members.some(function (m) { return m.expected > 0; });
    var cls, title, note;
    if (!missing.length && !over.length) {
      cls = 'ok'; title = '✓ متوازن';
      note = anyDue ? 'تم تسجيل كل المبالغ المطلوبة بالكامل.' : 'لا توجد مبالغ تحتاج إلى تسوية.';
    } else if (inv.discrepancy < 0) {
      cls = 'neg'; title = '⚠ التسوية غير مكتملة'; note = 'ما زالت هناك مبالغ لم تُسجَّل بالكامل.';
    } else if (inv.discrepancy > 0) {
      cls = 'pos'; title = '↑ زيادة في الدفع'; note = 'المسجَّل أكثر من المطلوب.';
    } else {
      cls = 'neutral'; title = '⚖ فروقات متعاكسة'; note = 'المجموع صفر لكن توجد فروقات لدى بعض الأشخاص.';
    }
    var foot = h('div', { class: 'inv-foot ' + cls, role: 'status' },
      h('div', { class: 'foot-top' }, h('span', null, 'الفرق الإجمالي'), h('span', { class: 'foot-num' }, money(inv.discrepancy, true))),
      h('div', { class: 'foot-note' }, title + ' — ' + note));
    var debtorsMissing = missing.filter(function (m) { return m.net < 0; });
    var creditorsMissing = missing.filter(function (m) { return m.net >= 0; });
    if (debtorsMissing.length) {
      foot.append(h('div', { class: 'foot-note' }, 'لم يدفع بالكامل:'), h('ul', null, debtorsMissing.map(function (m) {
        return h('li', null, h('b', null, m.name), ' — متبقي عليه ', money(m.remaining));
      })));
    }
    if (creditorsMissing.length) {
      foot.append(h('div', { class: 'foot-note' }, 'لم يستلم بالكامل:'), h('ul', null, creditorsMissing.map(function (m) {
        return h('li', null, h('b', null, m.name), ' — متبقي له ', money(m.remaining));
      })));
    }
    if (over.length) {
      foot.append(h('div', { class: 'foot-note' }, 'زيادة عن المطلوب:'), h('ul', null, over.map(function (m) {
        return h('li', null, h('b', null, m.name), ' — زيادة ', money(m.diff));
      })));
    }
    return foot;
  }

  function renderSummary() {
    var list = clear($('summary-list'));
    var rows = S.data.summary.filter(function (s) { return s.paid || s.share; });
    if (!rows.length) {
      list.append(h('div', { class: 'empty' }, 'سيظهر هنا وضع كل شخص بعد إضافة المصروفات.'));
      return;
    }
    rows.sort(function (a, b) { return b.net - a.net; });
    rows.forEach(function (s) {
      var sub;
      if (s.net === 0 && s.outstanding === 0) sub = 'متعادل';
      else if (s.outstanding === 0) sub = '✓ تمت تسوية كل مبالغه';
      else sub = h('span', null, 'المتبقي بعد التسويات: ', h('span', { class: s.outstanding > 0 ? 'pos-text' : 'neg-text' }, money(s.outstanding, true)));
      var p = { id: s.personId, name: s.name };
      list.append(h('div', { class: 'card sum-row' },
        avatar(p),
        h('div', { class: 'who' }, h('b', null, s.name),
          h('small', null, 'دفع ', money(s.paid), ' · حصته ', money(s.share)),
          h('small', { style: null }, h('br'), sub)),
        balance(s.net)));
    });
  }

  // Per person: total to pay (and how much was paid) and total to receive (and how much was received).
  function flowBox(kind, title, total, done) {
    var pay = kind === 'pay';
    var box = h('div', { class: 'flow flow-' + kind + (total === 0 && done === 0 ? ' flow-none' : '') },
      h('div', { class: 'flow-title' }, title),
      h('div', { class: 'flow-total' }, money(total)));
    if (total === 0 && done === 0) {
      box.append(h('div', { class: 'flow-line' }, 'لا شيء'));
      return box;
    }
    box.append(h('div', { class: 'flow-line' }, pay ? 'دفع: ' : 'استلم: ', money(done)));
    var rem = total - done;
    if (rem > 0) box.append(h('span', { class: 'pill ' + (pay ? 'pill-neg' : 'pill-warn') }, 'متبقي: ', money(rem)));
    else if (rem === 0) box.append(h('span', { class: 'pill pill-ok' }, pay ? '✓ دفع بالكامل' : '✓ استلم بالكامل'));
    else box.append(h('span', { class: 'pill pill-pos' }, 'زيادة: ', money(-rem)));
    return box;
  }

  function renderPayments() {
    var list = clear($('payments-list'));
    var rows = S.data.summary.filter(function (s) { return s.owe || s.receive || s.owePaid || s.received; });
    if (!rows.length) {
      list.append(h('div', { class: 'empty' }, 'سيظهر هنا ما على كل شخص وما له بعد إضافة المصروفات.'));
      return;
    }
    var t = rows.reduce(function (a, s) {
      a.owe += s.owe; a.owePaid += s.owePaid; a.receive += s.receive; a.received += s.received; return a;
    }, { owe: 0, owePaid: 0, receive: 0, received: 0 });
    list.append(h('div', { class: 'card pay-card pay-totals' },
      h('div', { class: 'pay-head' }, h('b', null, 'المجموع لكل الأشخاص')),
      h('div', { class: 'flows' },
        flowBox('pay', 'إجمالي ما يجب دفعه', t.owe, t.owePaid),
        flowBox('get', 'إجمالي ما يجب استلامه', t.receive, t.received))));
    rows.forEach(function (s) {
      var open = s.owe - s.owePaid > 0 || s.receive - s.received > 0;
      list.append(h('div', { class: 'card pay-card' },
        h('div', { class: 'pay-head' },
          avatar({ id: s.personId, name: s.name }),
          h('b', null, s.name),
          h('span', { class: 'pill ' + (open ? 'pill-warn' : 'pill-ok') }, open ? '⏳ غير مكتمل' : '✓ مكتمل')),
        h('div', { class: 'flows' },
          flowBox('pay', 'عليه أن يدفع', s.owe, s.owePaid),
          flowBox('get', 'له أن يستلم', s.receive, s.received))));
    });
  }

  // Final bill per person — depends only on the invoices, never on recorded settlements.
  // One collapsible card holds the people; each person opens to show every invoice he was in.
  //   share   = what he spent on himself          paid = what he paid out of his own pocket
  //   owe     = Σ per invoice max(0, share − paid) (others paid for him → he must pay)
  //   receive = Σ per invoice max(0, paid − share) (he paid for others → he must receive)
  //   net     = paid − share = receive − owe      → final amount to receive (+) or pay (−)
  function finalResult(net) {
    if (net < 0) return h('div', { class: 'final-result neg' }, h('span', null, '▼ يجب أن يدفع'), money(-net));
    if (net > 0) return h('div', { class: 'final-result pos' }, h('span', null, '▲ يجب أن يستلم'), money(net));
    return h('div', { class: 'final-result zero' }, h('span', null, 'متعادل — لا يدفع ولا يستلم'), money(0));
  }

  function finalLine(label, cents, cls) {
    return h('div', { class: 'final-line' + (cls ? ' ' + cls : '') }, h('span', null, label), money(cents));
  }

  // One row per invoice: what this person pays (−) or gets (+) for it.
  function finalInvoiceRow(inv, m) {
    var amount;
    if (m.net < 0) amount = h('span', { class: 'fin-amt neg' }, h('small', null, 'يدفع'), money(-m.net));
    else if (m.net > 0) amount = h('span', { class: 'fin-amt pos' }, h('small', null, 'يستلم'), money(m.net));
    else amount = h('span', { class: 'fin-amt zero' }, h('small', null, 'متعادل'), money(0));
    return h('li', { class: 'fin-inv' },
      h('span', { class: 'fin-icon', 'aria-hidden': 'true' }, invoiceIcon(inv.name)),
      h('span', { class: 'fin-inv-name' }, h('b', null, inv.name),
        h('small', null, 'حصته ', money(m.share), m.paid ? [' · دفع ', money(m.paid)] : null)),
      amount);
  }

  function finalPerson(s, invoices) {
    var open = S.finalPeople.has(s.personId);
    var detailsId = 'fin-person-' + s.personId;
    var toggle = function () {
      if (S.finalPeople.has(s.personId)) S.finalPeople.delete(s.personId); else S.finalPeople.add(s.personId);
      card.replaceWith(finalPerson(s, invoices));
    };
    var card = h('div', { class: 'fin-person' + (open ? ' open' : '') });
    card.append(h('button', {
      class: 'fin-person-head', type: 'button', 'aria-expanded': String(open), 'aria-controls': detailsId, onclick: toggle,
    },
    avatar({ id: s.personId, name: s.name }),
    h('b', null, s.name),
    h('span', { class: 'fin-count' }, 'المصروفات: ' + invoices.length),
    h('span', { class: 'chev', 'aria-hidden': 'true' }, '▼')));

    if (open) {
      var rows = h('ul', { class: 'fin-invs' });
      invoices.forEach(function (x) { rows.append(finalInvoiceRow(x.inv, x.m)); });
      card.append(h('div', { class: 'fin-details', id: detailsId },
        h('div', { class: 'subhead' }, 'المصروفات التي شارك فيها'),
        rows,
        h('div', { class: 'final-lines' },
          finalLine('▼ إجمالي ما يجب أن يدفعه', s.owe, 'strong neg-line'),
          finalLine('▲ إجمالي ما يجب أن يستلمه', s.receive, 'strong pos-line'),
          finalLine('🧾 مصروفه الشخصي (حصته)', s.share, 'sub'),
          finalLine('💳 دفع من جيبه', s.paid, 'sub'))));
    }
    var result = finalResult(s.net);
    result.classList.add('clickable');
    result.addEventListener('click', toggle);
    card.append(result, finalSettleArea(s));
    return card;
  }

  // Progress of the person's final payment + (admin) one input that is spread over all his invoices.
  // Paid/received so far is derived from the per-invoice records: cash = paid as debtor − received as creditor.
  function finalSettleArea(s) {
    var owes = s.net < 0;
    var due = Math.abs(s.net);
    var cash = s.owePaid - s.received;
    // done < 0 means money already moved the other way (e.g. he is owed overall but already paid
    // something in one invoice) — that increases what remains for him.
    var done = owes ? cash : -cash;
    var remaining = due - done;
    var hasRows = s.owe > 0 || s.receive > 0;
    var area = h('div', { class: 'fin-settle' });
    var status;
    if (s.net === 0) {
      var open = s.owePaid < s.owe || s.received < s.receive;
      status = h('span', { class: 'pill ' + (open ? 'pill-neutral' : 'pill-ok') }, open ? 'متعادل — تحتاج تسوية بالمقاصة' : '✓ متعادل');
    } else if (remaining === 0) {
      status = h('span', { class: 'pill pill-ok' }, owes ? '✓ دفع كامل المبلغ' : '✓ استلم كامل المبلغ');
    } else if (remaining < 0) {
      status = h('span', { class: 'pill pill-pos' }, 'زيادة: ', money(-remaining));
    } else {
      status = h('span', { class: 'pill ' + (owes ? 'pill-neg' : 'pill-warn') }, 'متبقي: ', money(remaining));
    }
    var progress;
    if (s.net === 0) progress = h('span', null, '');
    else if (done >= 0) progress = h('span', null, owes ? 'دفع ' : 'استلم ', money(done), ' من ', money(due));
    else progress = h('span', null, owes ? 'استلم مسبقاً ' : 'دفع مسبقاً ', money(-done));
    area.append(h('div', { class: 'fin-settle-line' }, progress, status));
    if (!S.isAdmin || !hasRows) return area;

    var send = function (body, msg) {
      mutate('PUT', '/api/people/' + s.personId + '/final-settlement', body)
        .then(function () { toast(msg, 'success'); })
        .catch(function (e) { toast(e.message, 'error'); });
    };
    if (s.net === 0) {
      area.append(h('div', { class: 'settle-form' }, h('button', {
        class: 'btn btn-success btn-sm btn-block', type: 'button',
        onclick: function () { send({ done: true }, 'تمت التسوية بالمقاصة'); },
      }, '✓ تسوية بالمقاصة')));
      return area;
    }
    var input = h('input', {
      class: 'input num-input', type: 'text', inputmode: 'decimal', autocomplete: 'off',
      placeholder: owes ? 'المبلغ الذي دفعه' : 'المبلغ الذي استلمه',
      'aria-label': (owes ? 'المبلغ الذي دفعه ' : 'المبلغ الذي استلمه ') + s.name,
      value: done > 0 ? plain(done) : '',
    });
    var save = function () {
      var raw = input.value.trim();
      if (raw.charAt(0) === '-') return toast('لا يمكن أن يكون المبلغ سالباً.', 'error');
      var c = raw === '' ? 0 : M.parseMoney(raw);
      if (c === null) { input.classList.add('invalid'); return toast('المبلغ غير صالح.', 'error'); }
      send({ amount: plain(c) }, 'تم توزيع المبلغ على مصروفات ' + s.name);
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
    input.addEventListener('input', function () { input.classList.remove('invalid'); });
    area.append(
      h('div', { class: 'settle-form' }, input,
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: save }, 'حفظ'),
        h('button', {
          class: 'btn btn-success btn-sm', type: 'button', disabled: remaining === 0,
          'aria-label': (owes ? 'دفع كامل المبلغ — ' : 'استلم كامل المبلغ — ') + s.name,
          onclick: function () { send({ done: true }, 'تمت تسوية كل مصروفات ' + s.name); },
        }, '✓ الكل')),
      h('div', { class: 'fin-settle-hint' }, 'يُوزَّع المبلغ تلقائياً على كل مصروفاته (الأقدم أولاً)، ويُحسب ما له من مبالغ مقابل ما عليه.'));
    return area;
  }

  function renderFinal() {
    var list = clear($('final-list'));
    var rows = S.data.summary.filter(function (s) { return s.paid || s.share; });
    if (!rows.length) {
      list.append(h('div', { class: 'empty' }, 'سيظهر هنا الحساب النهائي لكل شخص بعد إضافة المصروفات.'));
      return;
    }
    // invoices per person, oldest first
    var byPerson = {};
    S.data.invoices.slice().reverse().forEach(function (inv) {
      inv.members.forEach(function (m) { (byPerson[m.personId] = byPerson[m.personId] || []).push({ inv: inv, m: m }); });
    });
    var toPay = 0, toGet = 0;
    rows.forEach(function (s) { if (s.net < 0) toPay -= s.net; else toGet += s.net; });

    var card = h('div', { class: 'card fin-card' + (S.finalOpen ? ' open' : '') });
    card.append(h('button', {
      class: 'fin-card-head', type: 'button', 'aria-expanded': String(S.finalOpen), 'aria-controls': 'fin-people',
      onclick: function () { S.finalOpen = !S.finalOpen; renderFinal(); },
    },
    h('span', { class: 'fin-card-title' },
      h('b', null, '👥 الأشخاص (' + rows.length + ')'),
      h('small', null, S.finalOpen ? 'اضغط على أي شخص لعرض مصروفاته' : 'اضغط لعرض الحساب النهائي لكل شخص')),
    h('span', { class: 'chev', 'aria-hidden': 'true' }, '▼')));
    card.append(h('div', { class: 'fin-totals' },
      h('span', { class: 'neg-text' }, '▼ مجموع ما سيُدفع ', money(toPay)),
      h('span', { class: 'pos-text' }, '▲ مجموع ما سيُستلم ', money(toGet))));
    if (S.finalOpen) {
      var people = h('div', { class: 'fin-people', id: 'fin-people' });
      rows.forEach(function (s) { people.append(finalPerson(s, byPerson[s.personId] || [])); });
      card.append(people);
    }
    list.append(card);
  }

  // Admin-only "start a new trip" card at the bottom of the page.
  function renderReset() {
    var slot = clear($('reset-slot'));
    slot.hidden = !S.isAdmin;
    if (!S.isAdmin) return;
    slot.append(h('div', { class: 'card danger-zone' },
      h('h2', null, 'بدء رحلة جديدة'),
      h('p', { class: 'hint' }, 'امسح بيانات هذه الرحلة للبدء من جديد في عطلة قادمة. تُحفظ نسخة احتياطية تلقائياً على الخادم قبل المسح.'),
      h('button', { class: 'btn btn-danger btn-block', type: 'button', onclick: openReset }, '↺ إعادة ضبط البيانات')));
  }

  function openReset() {
    var m = openModal(true);
    var scope = 'invoices';
    var d = S.data;
    var options = [
      ['invoices', 'حذف المصروفات فقط', 'حذف كل المصروفات (' + d.invoices.length + ') والتسويات، مع الإبقاء على قائمة الأشخاص (' + d.people.length + ').'],
      ['all', 'حذف كل شيء', 'حذف كل المصروفات والتسويات وقائمة الأشخاص. تبدأ من صفحة فارغة تماماً.'],
    ];
    var list = h('div', { class: 'check-list', role: 'radiogroup', 'aria-label': 'ماذا تريد أن تحذف؟' });
    var confirmBtn = h('button', { class: 'btn btn-danger', type: 'button' }, 'نعم، احذف المصروفات');
    options.forEach(function (o) {
      var input = h('input', { type: 'radio', name: 'reset-scope', value: o[0] });
      input.checked = o[0] === scope;
      var row = h('label', { class: 'check-row radio' + (input.checked ? ' on' : '') },
        input, h('span', { class: 'box', 'aria-hidden': 'true' }, input.checked ? '✓' : ''),
        h('span', { class: 'label' }, h('b', null, o[1]), h('small', null, o[2])));
      input.addEventListener('change', function () {
        scope = o[0];
        list.querySelectorAll('.check-row').forEach(function (r) {
          var on = r.querySelector('input').checked;
          r.classList.toggle('on', on);
          r.querySelector('.box').textContent = on ? '✓' : '';
        });
        confirmBtn.textContent = scope === 'all' ? 'نعم، احذف كل شيء' : 'نعم، احذف المصروفات';
      });
      list.append(row);
    });
    confirmBtn.addEventListener('click', function () {
      confirmBtn.disabled = true;
      mutate('POST', '/api/reset', { scope: scope, confirm: 'RESET' }).then(function () {
        closeModal();
        S.expanded.clear();
        toast(scope === 'all' ? 'تم مسح كل البيانات. رحلة سعيدة!' : 'تم مسح المصروفات. الأشخاص كما هم.', 'success');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }).catch(function (e) { confirmBtn.disabled = false; toast(e.message, 'error'); });
    });
    m.sheet.append(
      sheetHead('إعادة ضبط البيانات'),
      h('div', { class: 'sheet-body' },
        h('p', { class: 'q' }, 'ماذا تريد أن تحذف؟'),
        list,
        h('div', { class: 'checkbar bad' }, '⚠ لا يمكن التراجع عن هذا من داخل التطبيق. تُحفظ نسخة احتياطية على الخادم في مجلد data/backups.')),
      h('div', { class: 'sheet-foot' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, 'إلغاء'),
        confirmBtn));
  }

  function renderFab() {
    var slot = clear($('fab-slot'));
    document.body.classList.toggle('has-fab', S.isAdmin);
    if (!S.isAdmin) return;
    slot.append(h('div', { class: 'fab-bar' },
      h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: function () { openWizard(null); } }, '+ إضافة مصروف')));
  }

  // ---------------------------------------------------------------------------
  // Modal sheet
  // ---------------------------------------------------------------------------
  var modal = null;
  function openModal(small) {
    closeModal();
    var sheet = h('div', { class: 'sheet' + (small ? ' small' : ''), role: 'dialog', 'aria-modal': 'true' });
    var overlay = h('div', { class: 'overlay' }, sheet);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
    $('modal-root').append(overlay);
    document.body.classList.add('modal-open');
    modal = { overlay: overlay, sheet: sheet, prevFocus: document.activeElement };
    return modal;
  }
  function closeModal() {
    if (!modal) return;
    var prev = modal.prevFocus;
    modal.overlay.remove();
    modal = null;
    document.body.classList.remove('modal-open');
    if (prev && prev.focus && document.body.contains(prev)) prev.focus();
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal) closeModal(); });

  function sheetHead(title, sub) {
    return h('div', { class: 'sheet-head' },
      h('div', null, h('h3', null, title), sub ? h('div', { class: 'step' }, sub) : null),
      h('button', { class: 'close-btn', type: 'button', 'aria-label': 'إغلاق', onclick: closeModal }, '✕'));
  }

  function confirmDialog(title, message, okLabel) {
    return new Promise(function (resolve) {
      var m = openModal(true);
      var done = function (v) { closeModal(); resolve(v); };
      m.sheet.append(
        sheetHead(title),
        h('div', { class: 'sheet-body' }, h('p', null, message)),
        h('div', { class: 'sheet-foot' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { done(false); } }, 'إلغاء'),
          h('button', { class: 'btn btn-danger', type: 'button', style: null, onclick: function () { done(true); } }, okLabel || 'حذف')));
    });
  }

  // ---------------------------------------------------------------------------
  // People dialogs
  // ---------------------------------------------------------------------------
  function openAddPerson() {
    var m = openModal(true);
    var input = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'مثال: محمد', autocomplete: 'off', id: 'person-name' });
    var err = h('div', { class: 'form-error', role: 'alert', hidden: true });
    var added = h('div', { class: 'hint', style: null });
    var btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'إضافة');
    var form = h('form', { novalidate: true },
      h('div', { class: 'sheet-body' },
        h('label', { class: 'field', for: 'person-name' }, 'اسم الشخص'), input, err, added),
      h('div', { class: 'sheet-foot' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, 'تم'), btn));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = input.value.trim();
      if (!name) { err.textContent = 'الاسم مطلوب.'; err.hidden = false; input.focus(); return; }
      btn.disabled = true;
      mutate('POST', '/api/people', { name: name }).then(function () {
        err.hidden = true;
        added.textContent = '✓ تمت إضافة «' + name + '». يمكنك إضافة شخص آخر.';
        input.value = '';
        input.focus();
      }).catch(function (e2) {
        err.textContent = e2.message; err.hidden = false;
      }).then(function () { btn.disabled = false; });
    });
    m.sheet.append(sheetHead('إضافة شخص'), form);
    input.focus();
  }

  function openEditPerson(p) {
    var m = openModal(true);
    var input = h('input', { class: 'input', type: 'text', maxlength: '40', value: p.name, autocomplete: 'off', id: 'person-name' });
    var err = h('div', { class: 'form-error', role: 'alert', hidden: true });
    var inUse = p.invoiceCount > 0;
    var form = h('form', { novalidate: true },
      h('div', { class: 'sheet-body' },
        h('label', { class: 'field', for: 'person-name' }, 'الاسم'), input, err,
        h('p', { class: 'hint', style: null }, inUse
          ? 'هذا الشخص مشارك في ' + p.invoiceCount + ' من المصروفات، لذلك لا يمكن حذفه حفاظاً على الحسابات. يمكنك تعديل اسمه.'
          : 'هذا الشخص غير مشارك في أي مصروف ويمكن حذفه.')),
      h('div', { class: 'sheet-foot' },
        h('button', {
          class: 'btn btn-danger', type: 'button', disabled: inUse,
          onclick: function () {
            confirmDialog('حذف شخص', 'هل تريد حذف «' + p.name + '» من قائمة الأشخاص؟').then(function (ok) {
              if (!ok) return;
              mutate('DELETE', '/api/people/' + p.id).then(function () { toast('تم حذف الشخص', 'success'); })
                .catch(function (e) { toast(e.message, 'error'); });
            });
          },
        }, 'حذف'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'حفظ')));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = input.value.trim();
      if (!name) { err.textContent = 'الاسم مطلوب.'; err.hidden = false; return; }
      mutate('PUT', '/api/people/' + p.id, { name: name }).then(function () {
        closeModal(); toast('تم حفظ الاسم', 'success');
      }).catch(function (e2) { err.textContent = e2.message; err.hidden = false; });
    });
    m.sheet.append(sheetHead('تعديل شخص'), form);
  }

  function deleteInvoice(inv) {
    confirmDialog('حذف مصروف', 'هل تريد حذف «' + inv.name + '»؟ سيتم حذف كل بيانات التقسيم والتسوية الخاصة به نهائياً.')
      .then(function (ok) {
        if (!ok) return;
        mutate('DELETE', '/api/invoices/' + inv.id).then(function () { toast('تم حذف المصروف', 'success'); })
          .catch(function (e) { toast(e.message, 'error'); });
      });
  }

  // ---------------------------------------------------------------------------
  // Add / edit invoice wizard
  // 1 participants → 2 name → 3 payers → 4 amount → 5 split (auto / manual) → save
  // ---------------------------------------------------------------------------
  var STEPS = 5;
  var W = null;
  var SUGGESTIONS = ['النقل', 'الإفطار', 'الغداء', 'العشاء', 'الفندق', 'البنزين', 'نشاط', 'مشتريات'];

  function openWizard(inv) {
    if (!S.data.people.length) { toast('أضف الأشخاص أولاً قبل إضافة مصروف.', 'error'); return; }
    W = {
      editId: inv ? inv.id : null,
      version: inv ? inv.version : null,
      step: 1,
      participants: new Set(inv ? inv.members.map(function (m) { return m.personId; }) : []),
      name: inv ? inv.name : '',
      description: inv ? inv.description : '',
      payers: new Set(inv ? inv.members.filter(function (m) { return m.paid > 0; }).map(function (m) { return m.personId; }) : []),
      total: inv ? plain(inv.total) : '',
      payerAmounts: {},
      mode: inv ? inv.splitMode : null,
      shares: {},
      convertedNote: false,
      error: '',
    };
    if (inv) inv.members.forEach(function (m) {
      if (m.paid > 0) W.payerAmounts[m.personId] = plain(m.paid);
      W.shares[m.personId] = plain(m.share);
    });
    openModal(false);
    renderWizard();
  }

  function orderedParticipants() {
    return S.data.people.filter(function (p) { return W.participants.has(p.id); });
  }
  function personName(id) {
    var p = S.data.people.find(function (x) { return x.id === id; });
    return p ? p.name : '';
  }

  function renderWizard() {
    if (!modal) return;
    var sheet = clear(modal.sheet);
    var titles = ['من شارك؟', 'اسم المصروف', 'من دفع؟', 'المبلغ', 'حساب التقسيم'];
    sheet.append(
      sheetHead(W.editId ? 'تعديل مصروف' : 'إضافة مصروف', 'الخطوة ' + W.step + ' من ' + STEPS + ' · ' + titles[W.step - 1]),
      h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i', { style: null })));
    sheet.querySelector('.progress i').style.width = (W.step / STEPS * 100) + '%';
    var body = h('div', { class: 'sheet-body' });
    var err = h('div', { class: 'checkbar bad', role: 'alert', hidden: !W.error }, W.error);
    W.errEl = err;
    [null, stepParticipants, stepName, stepPayers, stepAmount, stepSplit][W.step](body);
    body.append(err);
    var next = h('button', { class: 'btn btn-primary', type: 'button', onclick: wizardNext },
      W.step === 4 ? 'حساب التقسيم' : W.step === 5 ? (W.editId ? 'حفظ التعديلات' : 'حفظ المصروف') : 'التالي');
    W.nextBtn = next;
    sheet.append(body, h('div', { class: 'sheet-foot' },
      W.step > 1 ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { W.error = ''; W.step--; renderWizard(); } }, 'رجوع') : null,
      next));
    if (W.step === 5) updateSplitCheck();
    var first = body.querySelector('input[type=text]');
    if (first && W.step !== 5) first.focus();
  }

  function setError(msg) {
    W.error = msg || '';
    W.errEl.textContent = W.error;
    W.errEl.hidden = !W.error;
    if (msg) W.errEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function checkRow(label, checked, onToggle, extra) {
    var input = h('input', { type: 'checkbox' });
    input.checked = checked;
    var row = h('label', { class: 'check-row' + (checked ? ' on' : '') },
      input, h('span', { class: 'box', 'aria-hidden': 'true' }, checked ? '✓' : ''), h('span', { class: 'label' }, label), extra || null);
    input.addEventListener('change', function () {
      row.classList.toggle('on', input.checked);
      row.querySelector('.box').textContent = input.checked ? '✓' : '';
      onToggle(input.checked);
    });
    return row;
  }

  function stepParticipants(body) {
    var people = S.data.people;
    var counter = h('span');
    var updateCounter = function () { counter.textContent = 'تم اختيار ' + W.participants.size + ' من ' + people.length; };
    updateCounter();
    var allOn = people.every(function (p) { return W.participants.has(p.id); });
    body.append(
      h('p', { class: 'q' }, 'من شارك في هذا المصروف؟'),
      h('p', { class: 'q-sub' }, 'اختر كل من يجب أن يتقاسم هذا المصروف (بما في ذلك من دفع إن كان مشاركاً).'),
      h('div', { class: 'list-tools' }, counter,
        h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          onclick: function () {
            if (allOn) W.participants.clear(); else people.forEach(function (p) { W.participants.add(p.id); });
            renderWizard();
          },
        }, allOn ? 'إلغاء تحديد الكل' : 'تحديد الكل')));
    var list = h('div', { class: 'check-list' });
    people.forEach(function (p) {
      list.append(checkRow(p.name, W.participants.has(p.id), function (on) {
        if (on) W.participants.add(p.id); else W.participants.delete(p.id);
        updateCounter();
        if (W.error) setError('');
      }));
    });
    body.append(list);
  }

  function stepName(body) {
    var input = h('input', { class: 'input', type: 'text', maxlength: '60', id: 'inv-name', value: W.name, placeholder: 'مثال: غداء المطعم الأول', autocomplete: 'off' });
    input.addEventListener('input', function () { W.name = input.value; if (W.error) setError(''); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); wizardNext(); } });
    var chips = h('div', { class: 'chips' });
    SUGGESTIONS.forEach(function (s) {
      chips.append(h('button', { class: 'chip', type: 'button', onclick: function () { input.value = s; W.name = s; input.focus(); } }, s));
    });
    var desc = h('textarea', {
      class: 'input textarea', id: 'inv-desc', rows: '3', maxlength: '500',
      placeholder: 'مثال: 3 بيتزا، مشروبات، وحلويات', value: W.description,
    });
    var counter = h('span', { class: 'char-count' });
    var updateCount = function () { counter.textContent = Array.from(desc.value).length + ' / 500'; };
    desc.addEventListener('input', function () { W.description = desc.value; updateCount(); if (W.error) setError(''); });
    updateCount();
    body.append(h('label', { class: 'q', for: 'inv-name', style: null }, 'ما اسم المصروف؟'),
      h('p', { class: 'q-sub' }, 'اسم قصير وواضح يعرفه الجميع.'), input, chips,
      h('div', { class: 'desc-field' },
        h('div', { class: 'desc-head' },
          h('label', { class: 'field', for: 'inv-desc' }, 'الوصف ', h('span', { class: 'optional' }, '(اختياري)')),
          counter),
        desc));
  }

  function stepPayers(body) {
    body.append(h('p', { class: 'q' }, 'من دفع؟'),
      h('p', { class: 'q-sub' }, 'اختر شخصاً واحداً أو أكثر من المشاركين. ستُدخل المبالغ في الخطوة التالية.'));
    var list = h('div', { class: 'check-list' });
    orderedParticipants().forEach(function (p) {
      list.append(checkRow(p.name, W.payers.has(p.id), function (on) {
        if (on) W.payers.add(p.id); else W.payers.delete(p.id);
        if (W.error) setError('');
      }));
    });
    body.append(list);
  }

  function orderedPayers() {
    return orderedParticipants().filter(function (p) { return W.payers.has(p.id); });
  }

  function stepAmount(body) {
    var payers = orderedPayers();
    var total = h('input', { class: 'input big num-input', type: 'text', inputmode: 'decimal', id: 'inv-total', value: W.total, placeholder: '0', autocomplete: 'off' });
    var info = h('div', { class: 'checkbar info' });
    body.append(h('label', { class: 'q', for: 'inv-total', style: null }, 'كم المبلغ الإجمالي؟'),
      h('p', { class: 'q-sub' }, 'أرقام صحيحة فقط — أي كسر يُقرَّب للأعلى (5.1 تصبح 6).'), total);

    var refresh = function () {
      if (payers.length === 1) {
        var t = M.parseMoney(W.total);
        clear(info);
        append(info, [h('b', null, payers[0].name), ' دفع المبلغ كاملاً', t ? [': ', money(t)] : null]);
        return;
      }
      var tc = M.parseMoney(W.total);
      var sum = 0, bad = false;
      payers.forEach(function (p) {
        var c = M.parseMoney(W.payerAmounts[p.id] || '');
        if (c === null || c === 0) bad = true; else sum += c;
      });
      clear(info);
      info.className = 'checkbar ' + (tc && !bad && sum === tc ? 'ok' : 'info');
      info.append('مجموع ما دفعه الدافعون: ', money(sum));
      if (tc) {
        var d = tc - sum;
        if (d !== 0) info.append(' · ', h('b', null, d > 0 ? 'ناقص ' : 'زائد '), money(Math.abs(d)));
        else if (!bad) info.append(' ✓ يساوي الإجمالي');
      }
    };
    total.addEventListener('input', function () { W.total = total.value; total.classList.remove('invalid'); if (W.error) setError(''); refresh(); });
    total.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); wizardNext(); } });

    if (payers.length > 1) {
      var rows = h('div', { class: 'pay-rows' });
      body.append(h('p', { class: 'q', style: null }, 'كم دفع كل شخص؟'));
      body.lastChild.style.marginTop = '18px';
      payers.forEach(function (p) {
        var inp = h('input', {
          class: 'input num-input', type: 'text', inputmode: 'decimal', autocomplete: 'off',
          value: W.payerAmounts[p.id] || '', placeholder: '0', 'aria-label': 'المبلغ الذي دفعه ' + p.name,
        });
        inp.addEventListener('input', function () { W.payerAmounts[p.id] = inp.value; if (W.error) setError(''); refresh(); });
        rows.append(h('div', { class: 'pay-row' }, h('span', { class: 'who' }, p.name), inp));
      });
      body.append(rows);
    }
    body.append(info);
    refresh();
  }

  // Returns { paid: {id: cents} } for the current wizard state
  function payerCents() {
    var payers = orderedPayers();
    var out = {};
    if (payers.length === 1) out[payers[0].id] = M.parseMoney(W.total) || 0;
    else payers.forEach(function (p) { out[p.id] = M.parseMoney(W.payerAmounts[p.id] || '') || 0; });
    return out;
  }

  function applyEqualShares() {
    var ids = orderedParticipants().map(function (p) { return p.id; });
    var eq = M.equalSplit(M.parseMoney(W.total) || 0, ids);
    W.shares = {};
    ids.forEach(function (id) { W.shares[id] = plain(eq[id]); });
  }

  function stepSplit(body) {
    var parts = orderedParticipants();
    var totalC = M.parseMoney(W.total);
    var paid = payerCents();
    if (W.mode === 'equal' || !W.mode) { W.mode = 'equal'; applyEqualShares(); }
    else parts.forEach(function (p) { if (W.shares[p.id] === undefined) W.shares[p.id] = '0'; });

    var perHead = M.equalSplit(totalC, parts.map(function (p) { return p.id; }));
    var eqText = parts.length ? money(perHead[parts[parts.length - 1].id]) : '';

    body.append(h('div', { class: 'review' },
      h('b', null, W.name.trim()), ' · الإجمالي ', money(totalC), h('br'),
      W.description.trim() ? [h('span', { class: 'desc-text' }, W.description.trim()), h('br')] : null,
      'دفع: ', orderedPayers().map(function (p, i) { return [i ? '، ' : '', p.name + ' ', money(paid[p.id])]; }), h('br'),
      'المشاركون: ' + parts.length));

    var mkMode = function (key, title, sub) {
      return h('button', {
        class: 'mode' + (W.mode === key ? ' on' : ''), type: 'button', 'aria-pressed': String(W.mode === key),
        onclick: function () {
          if (key === 'equal') applyEqualShares();
          W.mode = key; W.convertedNote = false; setError(''); renderWizard();
        },
      }, h('b', null, title), h('small', null, sub));
    };
    body.append(h('div', { class: 'modes', role: 'group', 'aria-label': 'طريقة التقسيم' },
      mkMode('equal', 'الخيار الأول: تقسيم تلقائي', ['بالتساوي — ', eqText, ' لكل شخص (مقرَّب للأعلى)']),
      mkMode('manual', 'الخيار الثاني: تقسيم يدوي', 'أدخل حصة كل شخص بنفسك')));

    if (W.convertedNote) {
      body.append(h('div', { class: 'checkbar info', style: null }, 'عدّلت إحدى الحصص، لذلك تم التحويل إلى التقسيم اليدوي.'));
    }

    body.append(h('p', { class: 'hint' }, 'الرصيد = ما دفعه − حصته. ', h('span', { class: 'pos-text' }, 'الموجب يستلم'), '، ', h('span', { class: 'neg-text' }, 'السالب يدفع'), '.'));

    var rows = h('div', { class: 'share-rows' });
    W.balEls = {};
    parts.forEach(function (p) {
      var inp = h('input', {
        class: 'input num-input', type: 'text', inputmode: 'decimal', autocomplete: 'off',
        value: W.shares[p.id], 'aria-label': 'حصة ' + p.name,
      });
      var balSlot = h('span');
      W.balEls[p.id] = { slot: balSlot, input: inp };
      inp.addEventListener('input', function () {
        W.shares[p.id] = inp.value;
        if (W.mode === 'equal') {
          W.mode = 'manual'; W.convertedNote = true;
          // re-render to reflect the mode change, keeping focus on this input
          var pos = inp.selectionStart;
          renderWizard();
          var again = W.balEls[p.id].input; again.focus();
          try { again.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
          return;
        }
        updateSplitCheck();
      });
      rows.append(h('div', { class: 'share-row' },
        h('div', { class: 'top' },
          h('div', { class: 'who' }, p.name, h('small', null, 'دفع ', money(paid[p.id] || 0))),
          balSlot),
        h('div', { class: 'edit' }, h('label', null, 'حصته'), inp)));
    });
    body.append(rows);
    W.sumEl = h('div', { class: 'checkbar', role: 'status' });
    body.append(W.sumEl);
  }

  function updateSplitCheck() {
    var totalC = M.parseMoney(W.total) || 0;
    var paid = payerCents();
    var sum = 0, invalid = false;
    orderedParticipants().forEach(function (p) {
      var raw = String(W.shares[p.id] || '').trim();
      var c = raw === '' ? 0 : M.parseMoney(raw);
      var el = W.balEls[p.id];
      if (c === null) { invalid = true; el.input.classList.add('invalid'); clear(el.slot); return; }
      el.input.classList.remove('invalid');
      sum += c;
      clear(el.slot).append(balance((paid[p.id] || 0) - c));
    });
    var box = clear(W.sumEl);
    var diff = sum - totalC;
    var canSave = !invalid && sum > 0;
    box.className = 'checkbar ' + (!canSave ? 'bad' : diff === 0 ? 'ok' : 'warn');
    if (invalid) box.append('يوجد مبلغ غير صالح. استخدم أرقاماً موجبة فقط مثل 15');
    else if (sum === 0) box.append('مجموع الحصص يجب أن يكون أكبر من صفر.');
    else if (diff === 0) box.append('✓ مجموع الحصص ', money(sum), ' يساوي الإجمالي');
    else box.append('مجموع الحصص ', money(sum), ' والإجمالي ', money(totalC), ' — ',
      h('b', null, diff > 0 ? 'أكثر بـ ' : 'أقل بـ '), money(Math.abs(diff)), '. لا بأس، يمكنك الحفظ.');
    W.nextBtn.disabled = !canSave;
  }

  function wizardNext() {
    var n;
    if (W.step === 1) {
      if (!W.participants.size) return setError('يجب اختيار مشارك واحد على الأقل.');
      // payers must stay a subset of participants
      W.payers.forEach(function (id) { if (!W.participants.has(id)) W.payers.delete(id); });
    } else if (W.step === 2) {
      n = W.name.trim();
      if (!n) return setError('اسم المصروف مطلوب.');
      if (Array.from(n).length > 60) return setError('الاسم طويل جداً (الحد الأقصى 60 حرفاً).');
      if (Array.from(W.description.trim()).length > 500) return setError('الوصف طويل جداً (الحد الأقصى 500 حرف).');
    } else if (W.step === 3) {
      if (!W.payers.size) return setError('يجب اختيار دافع واحد على الأقل.');
    } else if (W.step === 4) {
      var t = M.parseMoney(W.total);
      if (!t) return setError('المبلغ غير صالح. أدخل رقماً أكبر من صفر مثل 100.');
      var payers = orderedPayers();
      if (payers.length > 1) {
        var sum = 0;
        for (var i = 0; i < payers.length; i++) {
          var c = M.parseMoney(W.payerAmounts[payers[i].id] || '');
          if (!c) return setError('أدخل مبلغاً صحيحاً أكبر من صفر لـ ' + payers[i].name + '.');
          sum += c;
        }
        if (sum !== t) return setError('مجموع ما دفعه الدافعون (' + M.formatAbs(sum) + ') لا يساوي المبلغ الإجمالي (' + M.formatAbs(t) + ').');
      }
    } else if (W.step === 5) {
      return saveInvoice();
    }
    W.error = '';
    W.step++;
    renderWizard();
  }

  function saveInvoice() {
    var parts = orderedParticipants();
    var paid = payerCents();
    var payload = {
      name: W.name.trim(),
      description: W.description.trim(),
      participantIds: parts.map(function (p) { return p.id; }),
      total: plain(M.parseMoney(W.total)),
      payers: orderedPayers().map(function (p) { return { personId: p.id, amount: plain(paid[p.id]) }; }),
      splitMode: W.mode,
    };
    if (W.mode === 'manual') {
      payload.shares = parts.map(function (p) {
        var raw = String(W.shares[p.id] || '').trim();
        return { personId: p.id, amount: raw === '' ? '0' : plain(M.parseMoney(raw)) };
      });
    }
    if (W.editId) payload.version = W.version;
    W.nextBtn.disabled = true;
    var req = W.editId ? mutate('PUT', '/api/invoices/' + W.editId, payload) : mutate('POST', '/api/invoices', payload);
    req.then(function (data) {
      var id = W.editId || (data.invoices[0] && data.invoices[0].id);
      closeModal();
      W = null;
      toast('تم حفظ المصروف', 'success');
      if (id) {
        S.expanded.add(id); renderInvoices();
        var el = document.querySelector('.invoice[data-id="' + id + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }).catch(function (e) {
      setError(e.message);
      W.nextBtn.disabled = false;
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  Promise.all([api('GET', '/api/session'), api('GET', '/api/state')]).then(function (r) {
    S.isAdmin = r[0].isAdmin; S.csrf = r[0].csrfToken; S.data = r[1];
    renderAll();
  }).catch(function (e) { toast(e.message, 'error'); });

  // Viewers get fresh data when they come back to the tab.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !modal && !S.isAdmin) refresh().catch(function () {});
  });
})();
