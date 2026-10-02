import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/admin.js', import.meta.url), 'utf8');

function fixture() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; },
      focus() {}, querySelectorAll() { return this.inputs || []; },
    });
    return elements.get(id);
  };
  const calls = [];
  const responses = [];
  let confirmed = true;
  const context = vm.createContext({
    document: { getElementById: get }, window: { addEventListener() {} },
    CONFIG: { API_BASE: 'https://test.invalid', API_TOKEN: 'till' },
    crypto: { randomUUID: () => 'stable-refund-key' },
    confirm: () => confirmed,
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected request');
      return typeof response === 'function' ? response() : response;
    },
  });
  vm.runInContext(source, context);
  const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  const sale = { client_ref: 'sale-a', invoice_no: 'A/26-27/0001', total_paise: 200,
    lines: [{ sale_line_id: 7, name: '<img onerror=alert(1)>', kind: 'good', qty: 2, qty_returnable: 2 }] };
  return { get, calls, responses, reply, sale,
    confirm(value) { confirmed = value; },
    async unlock() {
      get('token').value = 'admin-secret';
      responses.push(reply({}), reply([]));
      await get('unlock').listeners.click();
    },
    async load() {
      get('refund-ref').value = 'sale-a';
      responses.push(reply({ sale }));
      await get('refund-load').listeners.click();
      get('refund-lines').inputs = [{ value: '1', dataset: { refundLine: '7' } }];
      get('refund-mode').value = 'cash';
      get('refund-mode').selectedOptions = [{ textContent: 'Cash' }];
      get('refund-reason').value = 'return';
    },
    submit() { return get('refund-submit').listeners.click(); },
  };
}

test('refund unknown-result retry freezes body and key, uses admin auth, blocks duplicate clicks', async () => {
  const f = fixture();
  await f.unlock();
  await f.load();
  assert.match(f.get('refund-lines').innerHTML, /&lt;img/);
  let fail;
  f.responses.push(() => new Promise((resolve, reject) => { fail = reject; }));
  const sending = f.submit();
  await f.submit();
  assert.equal(f.calls.filter(c => c.url.endsWith('/credit-notes')).length, 1);
  assert.equal(f.get('refund-ref').disabled, true);
  fail(new Error('Lost response'));
  await sending;
  assert.match(f.get('refund-msg').textContent, /Result unknown/);
  assert.equal(f.get('refund-editor').disabled, true);
  f.get('refund-mode').value = 'bank';
  f.get('refund-lines').inputs[0].value = '2';
  await f.get('refund-load').listeners.click();
  f.responses.push(f.reply({ ok: true, duplicate: true, credit_note_no: 'CN/26-27/0001' }), f.reply([]));
  await f.submit();
  const posts = f.calls.filter(c => c.url.endsWith('/credit-notes'));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body, posts[1].body);
  assert.equal(posts[0].headers.Authorization, 'Bearer admin-secret');
  const payload = JSON.parse(posts[0].body);
  assert.deepEqual(payload.lines, [{ sale_line_id: 7, qty: 1 }]);
  assert.equal(payload.tax_adjusted, 0);
  assert.equal(payload.stock_return_mode, 'original_lot');
  assert.equal(f.get('refund-submit').disabled, true);
  assert.match(f.get('refund-msg').textContent, /confirmed existing refund/);
});

test('invalid quantities and cancelled confirmation do not submit; changing reference invalidates sale', async () => {
  const f = fixture();
  await f.load();
  for (const value of ['-1', '1.5', '3', 'NaN', '0']) {
    f.get('refund-lines').inputs[0].value = value;
    await f.submit();
  }
  f.get('refund-lines').inputs[0].value = '1';
  f.confirm(false);
  await f.submit();
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  f.get('refund-ref').value = 'sale-b';
  f.get('refund-ref').listeners.input();
  f.confirm(true);
  await f.submit();
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(f.get('refund-submit').disabled, true);
});

test('stale load response never reinstates the previous sale', async () => {
  const f = fixture();
  let complete;
  f.get('refund-ref').value = 'sale-a';
  f.responses.push(() => new Promise(resolve => { complete = resolve; }));
  const loading = f.get('refund-load').listeners.click();
  f.get('refund-ref').value = 'sale-b';
  f.get('refund-ref').listeners.input();
  complete(f.reply({ sale: f.sale }));
  await loading;
  assert.equal(f.get('refund-submit').disabled, true);
  assert.equal(f.get('refund-editor').hidden, true);
});

test('explicit conflict requires refresh, whereas malformed success retains frozen retry', async () => {
  const f = fixture();
  await f.load();
  f.responses.push(f.reply({ ok: true }));
  await f.submit();
  assert.match(f.get('refund-msg').textContent, /Result unknown/);
  assert.equal(f.get('refund-ref').disabled, true);
  f.responses.push(f.reply({ error: 'returnable figures changed' }, 409));
  await f.submit();
  assert.equal(f.get('refund-ref').disabled, false);
  assert.equal(f.get('refund-submit').disabled, true);
  assert.match(f.get('refund-msg').textContent, /Load the sale again/);
});
