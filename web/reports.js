/**
 * Reports dashboard — read-only admin screens for accounting reports, GSTR export,
 * and credit notes.
 *
 * MONEY IS INTEGER PAISE over the wire. Display divides by 100.
 */

var Reports = (function () {
  var token = '';
  var apiBase = CONFIG.API_BASE;

  var $ = function (id) { return document.getElementById(id); };
  var money = function (paise) { return (paise / 100).toFixed(2); };

  function api(path, opts) {
    opts = opts || {};
    return fetch(apiBase + path, Object.assign({}, opts, {
      headers: Object.assign({
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      }, opts.headers || {}),
    }));
  }

  async function errorText(res) {
    try { var body = await res.json(); return body.error || ('HTTP ' + res.status); }
    catch (e) { return 'HTTP ' + res.status; }
  }

  function say(id, text, kind) {
    var el = $(id);
    el.textContent = text;
    el.className = 'msg ' + (kind || '');
  }

  // Gate
  async function unlock() {
    token = $('token').value.trim();
    if (!token) return say('gate-msg', 'Paste the admin token first.', 'bad');

    say('gate-msg', 'Checking…');
    try {
      var res = await api('/reports/profit-loss');
      if (res.status === 401) return say('gate-msg', 'That token was rejected.', 'bad');
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');

      $('gate').hidden = true;
      $('app').hidden = false;
      loadReports();
    } catch (err) {
      say('gate-msg', 'Could not reach the API: ' + err.message, 'bad');
    }
  }

  // Tabs
  $('tabs').addEventListener('click', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('.tab').forEach(function (t) t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.section').forEach(function (s) s.classList.remove('active'));
    $('section-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'pnl') loadProfitLoss();
    if (tab.dataset.tab === 'balance') loadBalanceSheet();
    if (tab.dataset.tab === 'sales') loadSalesRegister();
    if (tab.dataset.tab === 'purchase') loadPurchaseRegister();
    if (tab.dataset.tab === 'cash') loadCashBook();
    if (tab.dataset.tab === 'stock') loadStockReport();
    if (tab.dataset.tab === 'gstr1') loadGSTR1();
    if (tab.dataset.tab === 'gstr3b') loadGSTR3B();
    if (tab.dataset.tab === 'credits') loadCredits();
  });

  // Period controls
  var fromInput = $('from');
  var toInput = $('to');

  // Current FY defaults
  function loadDates() {
    var now = new Date();
    var month = now.getMonth(); // 0-11
    var year = now.getFullYear();
    // FY starts April 1 (month 3)
    var fyStart = month >= 3 ? year : year - 1;
    var fyEnd = month >= 3 ? year + 1 : year;

    // Default to current month
    fromInput.value = fyStart + '-04-01';
    toInput.value = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  }
  loadDates();

  $('refresh').addEventListener('click', function () {
    var activeTab = document.querySelector('.tab.active').dataset.tab;
    if (activeTab === 'pnl') loadProfitLoss();
    if (activeTab === 'balance') loadBalanceSheet();
    if (activeTab === 'sales') loadSalesRegister();
    if (activeTab === 'purchase') loadPurchaseRegister();
    if (activeTab === 'cash') loadCashBook();
    if (activeTab === 'stock') loadStockReport();
  });

  $('download').addEventListener('click', function () {
    var activeTab = document.querySelector('.tab.active').dataset.tab;
    if (activeTab === 'pnl') downloadReport('profit-loss');
    if (activeTab === 'balance') downloadReport('balance-sheet');
    if (activeTab === 'sales') downloadReport('sales-register');
    if (activeTab === 'purchase') downloadReport('purchase-register');
    if (activeTab === 'cash') downloadReport('cash-book');
    if (activeTab === 'stock') downloadReport('stock');
    if (activeTab === 'gstr1') downloadGSTR('gstr1');
    if (activeTab === 'gstr3b') downloadGSTR('gstr3b');
  });

  // GSTR functions
  async function loadGSTR1() {
    $('refresh').textContent = 'Loading…';
    try {
      var period = fromInput.value ? fromInput.value.slice(0, 7) : '';
      var res = await api('/reports/gstr1?period=' + period);
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');
      var data = await res.json();
      showGSTR1(data, period);
    } catch (err) {
      say('gate-msg', err.message, 'bad');
    } finally {
      $('refresh').textContent = 'Refresh';
    }
  }

  function showGSTR1(data, period) {
    var tbody = $('sales-rows');
    tbody.innerHTML = '<tr><td colspan="7" class="note">GSTR-1 JSON exported. Use Download JSON to save.</td></tr>';
    say('gate-msg', 'GSTR-1 for ' + period + ': ' + (data.data ? 'Ready to download' : 'Validation failed'), 'ok');
  }

  async function loadGSTR3B() {
    $('refresh').textContent = 'Loading…';
    try {
      var period = fromInput.value ? fromInput.value.slice(0, 7) : '';
      var res = await api('/reports/gstr3b?period=' + period);
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');
      var data = await res.json();
      showGSTR3B(data, period);
    } catch (err) {
      say('gate-msg', err.message, 'bad');
    } finally {
      $('refresh').textContent = 'Refresh';
    }
  }

  function showGSTR3B(data, period) {
    $('sales-rows').innerHTML = '<tr><td colspan="7" class="note">GSTR-3B JSON exported. Use Download JSON to save.</td></tr>';
    say('gate-msg', 'GSTR-3B for ' + period + ': Ready to download', 'ok');
  }

  async function loadCredits() {
    $('refresh').textContent = 'Loading…';
    try {
      var res = await api('/credit-notes');
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');
      var data = await res.json();
      showCredits(data);
    } catch (err) {
      say('gate-msg', err.message, 'bad');
    } finally {
      $('refresh').textContent = 'Refresh';
    }
  }

  function showCredits(data) {
    $('sales-rows').innerHTML = '<tr><td colspan="7" class="note">Credit notes loaded. Use Download to export.</td></tr>';
    say('gate-msg', data.count + ' credit notes found', 'ok');
  }

  function downloadGSTR(endpoint) {
    var period = fromInput.value ? fromInput.value.slice(0, 7) : '';
    var url = '/reports/' + endpoint + '?period=' + period;
    var w = window.open('', '_blank');
    if (!w) { say('gate-msg', 'Popup blocked', 'bad'); return; }
    w.document.write('<pre>Loading…</pre>');
    fetch(apiBase + url, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.json())
      .then(d => {
        var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = endpoint + '_' + period + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(e => w.document.write('<pre>Error: ' + e.message + '</pre>'));
  }

  function periodParams() {
    return '?' + (fromInput.value ? 'from=' + fromInput.value : '') +
               (toInput.value ? '&to=' + toInput.value : '');
  }

  async function loadReports() {
    loadProfitLoss();
  }

  function renderPnl(data) {
    $('pl-total-revenue').textContent = money(data.revenue.total_paise);
    $('pl-cogs').textContent = money(data.cost_of_goods_sold_paise);
    $('pl-gross-profit').textContent = money(data.gross_profit_paise);
    $('pl-net-profit').textContent = money(data.net_profit_paise);

    var tbody = $('pl-items');
    var rows = [];

    rows.push('<tr><td colspan="3" style="font-weight:600">Revenue</td></tr>');
    if (data.revenue.goods_paise) rows.push('<tr><td>Goods</td><td class="r">' + money(data.revenue.goods_paise) + '</td><td></td></tr>');
    if (data.revenue.services_paise) rows.push('<tr><td>Services</td><td class="r">' + money(data.revenue.services_paise) + '</td><td></td></tr>');
    if (data.revenue.other_paise) rows.push('<tr><td>Other</td><td class="r">' + money(data.revenue.other_paise) + '</td><td></td></tr>');

    if (data.cost_of_goods_sold_paise) {
      rows.push('<tr><td colspan="3" style="font-weight:600">Cost of Goods Sold</td></tr>');
      rows.push('<tr><td>COGS</td><td class="r">' + money(data.cost_of_goods_sold_paise) + '</td><td></td></tr>');
    }

    if (data.expenses && data.expenses.length) {
      rows.push('<tr><td colspan="3" style="font-weight:600">Expenses</td></tr>');
      data.expenses.forEach(function (e) {
        rows.push('<tr><td>' + (e.name || e.code) + '</td><td class="r">' + money(e.amount_paise) + '</td><td></td></tr>');
      });
    }

    rows.push('<tr><td colspan="3" style="font-weight:600">Net Profit</td></tr>');
    rows.push('<tr><td>Net</td><td class="r">' + money(data.net_profit_paise) + '</td><td></td></tr>');

    tbody.innerHTML = rows.join('');
  }

  async function loadProfitLoss() {
    var url = '/reports/profit-loss' + periodParams();
    $('refresh').textContent = 'Loading…';
    try {
      var res = await api(url);
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');
      var data = await res.json();
      renderPnl(data);
    } catch (err) {
      say('gate-msg', err.message, 'bad');
    } finally {
      $('refresh').textContent = 'Refresh';
    }
  }

  function renderBalanceSheet(data) {
    $('bs-assets').textContent = money(data.totals.assets_paise);
    $('bs-liabilities').textContent = money(data.totals.liabilities_and_equity_paise - data.earnings_to_date_paise);
    $('bs-equity').textContent = money(data.totals.liabilities_and_equity_paise);

    // Assets table
    var at = $('bs-assets-table');
    var ar = [];
    ar.push('<tr><th>Account</th><th class="r">Balance</th></tr>');
    if (data.assets.cash_paise) ar.push('<tr><td>Cash</td><td class="r">' + money(data.assets.cash_paise) + '</td></tr>');
    if (data.assets.bank_paise) ar.push('<tr><td>Bank</td><td class="r">' + money(data.assets.bank_paise) + '</td></tr>');
    if (data.assets.sundry_debtors_paise) ar.push('<tr><td>Sundry Debtors</td><td class="r">' + money(data.assets.sundry_debtors_paise) + '</td></tr>');
    if (data.assets.stock_in_hand_paise) ar.push('<tr><td>Stock in Hand</td><td class="r">' + money(data.assets.stock_in_hand_paise) + '</td></tr>');
    if (data.assets.other_assets_paise) ar.push('<tr><td>Other Assets</td><td class="r">' + money(data.assets.other_assets_paise) + '</td></tr>');
    ar.push('<tr><td style="font-weight:600">Total Assets</td><td class="r">' + money(data.totals.assets_paise) + '</td></tr>');
    at.innerHTML = ar.join('');

    // Liabilities table
    var lt = $('bs-liabilities-table');
    var lr = [];
    lr.push('<tr><th>Account</th><th class="r">Balance</th></tr>');
    if (data.liabilities.sundry_creditors_paise) lr.push('<tr><td>Sundry Creditors</td><td class="r">' + money(data.liabilities.sundry_creditors_paise) + '</td></tr>');
    if (data.liabilities.other_liabilities_paise) lr.push('<tr><td>Other Liabilities</td><td class="r">' + money(data.liabilities.other_liabilities_paise) + '</td></tr>');
    if (data.equity.capital_paise) lr.push('<tr><td>Capital</td><td class="r">' + money(data.equity.capital_paise) + '</td></tr>');
    if (data.earnings_to_date_paise) lr.push('<tr><td>Earnings</td><td class="r">' + money(data.earnings_to_date_paise) + '</td></tr>');
    lr.push('<tr><td style="font-weight:600">Total Liabilities + Equity</td><td class="r">' + money(data.totals.liabilities_and_equity_paise) + '</td></tr>');
    lt.innerHTML = lr.join('');
  }

  async function loadBalanceSheet() {
    var url = '/reports/balance-sheet?as_of=' + (toInput.value || '');
    $('refresh').textContent = 'Loading…';
    try {
      var res = await api(url);
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');
      var data = await res.json();
      renderBalanceSheet(data);
    } catch (err) {
      say('gate-msg', err.message, 'bad');
    } finally {
      $('refresh').textContent = 'Refresh';
    }
  }

  function renderSalesRegister(data) {
    var tbody = $('sales-rows');
    if (!data.documents.length) return tbody.innerHTML = '<tr><td colspan="7" class="note">No sales in period</td></tr>';
    tbody.innerHTML = data.documents.map(function (d) {
      return '<tr><td>' + d.document_date.split('T')[0] + '</td>' +
        '<td>' + (d.document_no || '—') + '</td>' +
        '<td>' + d.document_ref.slice(0, 12) + '</td>' +
        '<td class="r">' + money(d.taxable_paise) + '</td>' +
        '<td class="r">' + money(d.cgst_paise) + '</td>' +
        '<td class="r">' + money(d.sgst_paise) + '</td>' +
        '<td class="r">' + money(d.total_paise) + '</td></tr>';
    }).join('');
  }

  async function loadSalesRegister() {
    var url = '/reports/sales-register' + periodParams();
    $('refresh').textContent = 'Loading…';
    try {
      var res = await api(url);
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');
      var data = await res.json();
      renderSalesRegister(data);
    } catch (err) {
      say('gate-msg', err.message, 'bad');
    } finally {
      $('refresh').textContent = 'Refresh';
    }
  }

  function renderPurchaseRegister(data) {
    var tbody = $('purchase-rows');
    if (!data.purchases.length) return tbody.innerHTML = '<tr><td colspan="7" class="note">No purchases in period</td></tr>';
    tbody.innerHTML = data.purchases.map(function (p) {
      return '<tr><td>' + p.invoice_date.split('T')[0] + '</td>' +
        '<td>' + (p.supplier_name || '—') + '</td>' +
        '<td>' + (p.supplier_inv_no || '—') + '</td>' +
        '<td class="r">' + money(p.taxable_paise) + '</td>' +
        '<td class="r">' + money(p.cgst_paise) + '</td>' +
        '<td class="r">' + money(p.sgst_paise) + '</td>' +
        '<td class="r">' + money(p.total_paise) + '</td></tr>';
    }).join('');
  }

  async function loadPurchaseRegister() {
    var url = '/reports/purchase-register' + periodParams();
    $('refresh').textContent = 'Loading…';
    try {
      var res = await api(url);
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');
      var data = await res.json();
      renderPurchaseRegister(data);
    } catch (err) {
      say('gate-msg', err.message, 'bad');
    } finally {
      $('refresh').textContent = 'Refresh';
    }
  }

  function renderCashBook(data) {
    $('cb-opening').textContent = money(data.opening_paise);
    $('cb-receipts').textContent = money(data.totals.receipts_paise);
    $('cb-payments').textContent = money(data.totals.payments_paise);
    $('cb-closing').textContent = money(data.closing_paise);

    var tbody = $('cash-rows');
    if (!data.entries.length) return tbody.innerHTML = '<tr><td colspan="6" class="note">No cash movements in period</td></tr>';
    tbody.innerHTML = data.entries.map(function (e) {
      return '<tr><td>' + e.date.split('T')[0] + '</td>' +
        '<td>' + e.type + '</td>' +
        '<td>' + (e.ref || e.voucher_id) + '</td>' +
        '<td class="r">' + money(e.receipt_paise) + '</td>' +
        '<td class="r">' + money(e.payment_paise) + '</td>' +
        '<td class="r">' + money(e.running_balance_paise) + '</td></tr>';
    }).join('');
  }

  async function loadCashBook() {
    var url = '/reports/cash-book' + periodParams();
    $('refresh').textContent = 'Loading…';
    try {
      var res = await api(url);
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');
      var data = await res.json();
      renderCashBook(data);
    } catch (err) {
      say('gate-msg', err.message, 'bad');
    } finally {
      $('refresh').textContent = 'Refresh';
    }
  }

  function renderStockReport(data) {
    $('stock-total').textContent = money(data.totalValuePaise);
    var tbody = $('stock-rows');
    if (!data.items.length) return tbody.innerHTML = '<tr><td colspan="3" class="note">No stock on hand</td></tr>';
    tbody.innerHTML = data.items.map(function (i) {
      return '<tr><td>' + (i.name || i.id) + '</td>' +
        '<td class="r">' + i.qty + ' ' + i.unit + '</td>' +
        '<td class="r">' + money(i.value_paise) + '</td></tr>';
    }).join('');
  }

  async function loadStockReport() {
    $('refresh').textContent = 'Loading…';
    try {
      var res = await api('/reports/stock');
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');
      var data = await res.json();
      renderStockReport(data);
    } catch (err) {
      say('gate-msg', err.message, 'bad');
    } finally {
      $('refresh').textContent = 'Refresh';
    }
  }

  function downloadReport(endpoint) {
    var url = '/reports/' + endpoint + (endpoint === 'stock' ? '' : periodParams());
    var w = window.open('', '_blank');
    if (!w) { say('gate-msg', 'Popup blocked', 'bad'); return; }
    w.document.write('<pre>Loading…</pre>');
    fetch(apiBase + url, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.json())
      .then(d => w.document.write('<pre>' + JSON.stringify(d, null, 2) + '</pre>'))
      .catch(e => w.document.write('<pre>Error: ' + e.message + '</pre>'));
  }

  // Init
  $('unlock').addEventListener('click', unlock);
  $('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });

  return {};
})();
