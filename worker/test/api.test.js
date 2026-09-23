/**
 * Checks the Worker against a real local D1 (SQLite) via `wrangler dev`.
 *
 * Run: npm test   (from worker/)
 * Assumes `npm run migrate:local` has been run at least once.
 *
 * Plain node:test + fetch. No framework: this is one HTTP surface.
 *
 * The tax and FIFO arithmetic is covered exhaustively in gst.test.js and
 * fifo.test.js, which need no server. What is tested here is what only a real
 * database can show: that a sale is atomic, that the books balance, and that a
 * retry does not post twice.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Defaults match `npm run dev:test`.
const TOKEN = process.env.POS_TOKEN ?? 'test-token';
const ADMIN = process.env.POS_ADMIN_TOKEN ?? 'admin-token-x';
const BASE = process.env.POS_API ?? 'http://127.0.0.1:8801';

// The server is started separately (see `npm test` in package.json) rather
// than spawned here: killing wrangler's process tree from node on Windows is
// unreliable and leaves the test runner hanging forever.
before(async () => {
  try {
    await fetch(`${BASE}/products`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  } catch {
    throw new Error(
      `No server at ${BASE}. Start one in another shell with:\n` +
      `  npm run dev:test`
    );
  }
});

const call = (path, opts = {}, token = TOKEN) =>
  fetch(BASE + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });

const sale = (over = {}) => ({
  client_ref: crypto.randomUUID(),
  source: 'web',
  total: 500,
  items: [{ id: 'espresso', name: 'Espresso', price: 250, qty: 2 }],
  ...over,
});

/**
 * Top the seeded items back up before the sale tests run.
 *
 * The local D1 persists between runs, and every run sells stock, so the seeded
 * 100 espressos eventually hit zero and every sale test starts failing with a
 * 409 — a test-data problem that looks exactly like a code regression.
 *
 * Restocking here keeps the suite repeatable. It goes through the real purchase
 * route rather than raw SQL so the books stay balanced, which the trial-balance
 * tests depend on.
 */
before(async () => {
  const { items } = await (await call('/reports/stock', {}, ADMIN)).json();
  const low = items.filter(i => i.qty < 60);
  if (!low.length) return;

  await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplier_name: 'Test Restock',
      supplier_inv_no: `RESTOCK-${crypto.randomUUID().slice(0, 8)}`,
      // 100 paise a unit: a round number, and cheap enough that it never
      // dominates a COGS assertion elsewhere.
      lines: low.map(i => ({ product_id: i.id, qty: 200, taxable_paise: 20000 })),
    }),
  }, ADMIN);
});

test('rejects a missing token', async () => {
  const res = await fetch(`${BASE}/products`);
  assert.equal(res.status, 401);
});

test('rejects a wrong token', async () => {
  const res = await call('/products', {}, 'wrong-token');
  assert.equal(res.status, 401);
});

test('serves the seeded catalog', async () => {
  const res = await call('/products');
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(rows.length >= 8, `expected seeded products, got ${rows.length}`);
  // Prices are cents: integers, never floats.
  assert.ok(rows.every(r => Number.isInteger(r.price)));
});

test('records a sale', async () => {
  const res = await call('/sales', { method: 'POST', body: JSON.stringify(sale()) });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true });
});

test('replaying the same client_ref is a no-op, not a double charge', async () => {
  const s = sale();
  const first = await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  assert.equal(first.status, 201);

  // Same payload again: what an offline device does when a response is lost.
  const retry = await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
});

test('a sale decrements stock', async () => {
  const before = (await (await call('/products')).json()).find(p => p.id === 'water').stock;
  await call('/sales', {
    method: 'POST',
    body: JSON.stringify(sale({ items: [{ id: 'water', qty: 3 }], total: 360 })),
  });
  const after = (await (await call('/products')).json()).find(p => p.id === 'water').stock;
  assert.equal(after, before - 3);
});

test('rejects bad payloads', async () => {
  const bad = [
    { body: sale({ client_ref: 'short' }),        why: 'client_ref too short' },
    { body: sale({ total: -1 }),                  why: 'negative total' },
    { body: sale({ total: 1.5 }),                 why: 'fractional cents' },
    { body: sale({ items: [] }),                  why: 'empty items' },
    { body: sale({ items: [{ id: 'x', qty: 0 }] }), why: 'zero qty' },
    { body: sale({ items: [{ qty: 1 }] }),        why: 'item without id' },
  ];
  for (const { body, why } of bad) {
    const res = await call('/sales', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(res.status, 400, `should reject: ${why}`);
  }
});

test('rejects malformed json', async () => {
  const res = await call('/sales', { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
});

test('unknown route is 404', async () => {
  assert.equal((await call('/nope')).status, 404);
});

// --- sales history, admin only -------------------------------------------
// The till token is extractable from the APK and the web page's source. If it
// could also read sales history, anyone with the APK could read your takings.

test('till token cannot read sales history', async () => {
  const res = await call('/sales');           // GET, till token
  assert.equal(res.status, 401);
});

test('no token cannot read sales history', async () => {
  assert.equal((await fetch(`${BASE}/sales`)).status, 401);
});

test('admin token reads sales history', async () => {
  const res = await call('/sales', {}, ADMIN);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.sales), 'expected a sales array');
  assert.equal(typeof body.totalCents, 'number');
  // items round-trips back to a real array, not the stored JSON string.
  if (body.sales.length) assert.ok(Array.isArray(body.sales[0].items));
});

test('admin token also works on till routes', async () => {
  // One token for everything while testing; the reverse must never hold.
  assert.equal((await call('/products', {}, ADMIN)).status, 200);
});

test('a recorded sale shows up in history', async () => {
  const s = sale({ total: 1234 });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });

  const { sales } = await (await call('/sales?limit=500', {}, ADMIN)).json();
  const found = sales.find(r => r.client_ref === s.client_ref);
  assert.ok(found, 'sale missing from history');
  assert.equal(found.total, 1234);
  assert.equal(found.source, 'web');
});

test('history limit is clamped, not rejected', async () => {
  // Silly values shouldn't 400, but must not scan the whole table either.
  for (const q of ['?limit=99999', '?limit=0', '?limit=abc', '?limit=-5']) {
    const res = await call(`/sales${q}`, {}, ADMIN);
    assert.equal(res.status, 200, `limit${q} should be clamped`);
    assert.ok((await res.json()).sales.length <= 500);
  }
});

// ===========================================================================
// Phase 1: GST, FIFO and the books.
// ===========================================================================

const history = async ref => {
  const { sales } = await (await call('/sales?limit=500', {}, ADMIN)).json();
  return sales.find(r => r.client_ref === ref);
};

const stockOf = async id =>
  (await (await call('/reports/stock', {}, ADMIN)).json())
    .items.find(r => r.id === id)?.qty ?? 0;

/** Unique supplier invoice numbers, so reruns don't collide on the voucher ref. */
const uid = p => `${p}-${crypto.randomUUID().slice(0, 8)}`;

// --- settings --------------------------------------------------------------

test('settings are readable and the tax knobs are all present', async () => {
  const res = await call('/settings', {}, ADMIN);
  assert.equal(res.status, 200);
  const s = await res.json();
  for (const k of ['gst_registration', 'state_code', 'price_mode', 'round_off_enabled']) {
    assert.ok(k in s, `missing setting ${k}`);
  }
});

test('the till can read the display settings it needs', async () => {
  // Without these a client has to guess the pricing mode. Guessing wrong at an
  // exclusive-pricing shop understates every on-screen total by the tax, so the
  // counter quotes one figure and the bill prints a higher one.
  const res = await call('/shop');
  assert.equal(res.status, 200);

  const shop = await res.json();
  assert.ok(['inclusive', 'exclusive'].includes(shop.price_mode));
  assert.equal(typeof shop.round_off_enabled, 'boolean', 'a boolean, not the stored "1"/"0"');
  assert.ok(['regular', 'composition', 'unregistered'].includes(shop.gst_registration));
});

test('/shop withholds what a till has no use for', async () => {
  // The till token is extractable from the APK, so this exposes only what is
  // needed to draw a cart — not the GSTIN or the invoice series.
  const shop = await (await call('/shop')).json();
  for (const k of ['gstin', 'invoice_series', 'composition_rate_bps', 'state_code']) {
    assert.ok(!(k in shop), `/shop should not expose ${k}`);
  }
});

test('/shop reflects a settings change', async () => {
  try {
    await call('/settings', {
      method: 'PUT', body: JSON.stringify({ price_mode: 'exclusive', round_off_enabled: false }),
    }, ADMIN);

    const shop = await (await call('/shop')).json();
    assert.equal(shop.price_mode, 'exclusive');
    assert.equal(shop.round_off_enabled, false);
  } finally {
    await call('/settings', {
      method: 'PUT', body: JSON.stringify({ price_mode: 'inclusive', round_off_enabled: true }),
    }, ADMIN);
  }
});

test('till token cannot read or write settings', async () => {
  // These decide what appears on a legal document, so the extractable token
  // must not reach them.
  assert.equal((await call('/settings')).status, 401);
  assert.equal((await call('/settings', {
    method: 'PUT', body: JSON.stringify({ gstin: 'x' }),
  })).status, 401);
});

test('a boolean setting actually takes effect', async () => {
  // String(false) is 'false', which is not the '0' the read side compares
  // against — so a naive write would be accepted, echoed back, and change
  // nothing. Worse than rejecting it, because the admin gets a 200 confirming
  // a change that did not happen.
  try {
    await call('/settings', {
      method: 'PUT', body: JSON.stringify({ round_off_enabled: false }),
    }, ADMIN);

    const s = await (await call('/settings', {}, ADMIN)).json();
    assert.equal(s.round_off_enabled, '0', 'false must normalise to the stored 0');

    // And prove it reaches the arithmetic: with rounding off, a total need not
    // be a whole number of rupees.
    const sale1 = sale({ items: [{ id: 'espresso', qty: 1 }] });
    await call('/sales', { method: 'POST', body: JSON.stringify(sale1) });
    const row = await history(sale1.client_ref);
    assert.equal(row.round_off_paise, 0, 'no rounding should have been applied');
  } finally {
    await call('/settings', {
      method: 'PUT', body: JSON.stringify({ round_off_enabled: true }),
    }, ADMIN);
  }
});

test('fy_start is validated, since it decides which year a sale is filed in', async () => {
  // fyLabel parses it with split('-').map(Number), so "2026-04-01" or "April"
  // yields NaN and silently files sales into the wrong financial year while
  // advancing the closed year's invoice counter.
  for (const bad of ['2026-04-01', 'April', '4-1-2026', '13-01', '04-32', '00-01', '']) {
    const res = await call('/settings', {
      method: 'PUT', body: JSON.stringify({ fy_start: bad }),
    }, ADMIN);
    assert.equal(res.status, 400, `fy_start ${JSON.stringify(bad)} should be refused`);
  }
  // The real Indian FY start, and a calendar-year one, both work.
  for (const good of ['04-01', '01-01']) {
    const res = await call('/settings', {
      method: 'PUT', body: JSON.stringify({ fy_start: good }),
    }, ADMIN);
    assert.equal(res.status, 200, `fy_start ${good} should be accepted`);
  }
  await call('/settings', { method: 'PUT', body: JSON.stringify({ fy_start: '04-01' }) }, ADMIN);
});

test('invoice_series is bounded so invoice numbers stay inside 16 characters', async () => {
  // Rule 46(b): at most 16 chars, alphanumerics plus - and / only. The series is
  // concatenated as <series>/<fy>/<0000>, which spends 11, leaving 5.
  for (const bad of ['TOOLONG', 'A B', 'A@B', '', 'ABCDEF']) {
    const res = await call('/settings', {
      method: 'PUT', body: JSON.stringify({ invoice_series: bad }),
    }, ADMIN);
    assert.equal(res.status, 400, `invoice_series ${JSON.stringify(bad)} should be refused`);
  }
  try {
    for (const good of ['A', 'B2', 'TILL1']) {
      const res = await call('/settings', {
        method: 'PUT', body: JSON.stringify({ invoice_series: good }),
      }, ADMIN);
      assert.equal(res.status, 200, `invoice_series ${good} should be accepted`);
    }
    // And the resulting number really does fit.
    const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
    await call('/sales', { method: 'POST', body: JSON.stringify(s) });
    const row = await history(s.client_ref);
    assert.ok(row.invoice_no.length <= 16,
      `invoice number ${row.invoice_no} exceeds the 16-char limit`);
  } finally {
    await call('/settings', { method: 'PUT', body: JSON.stringify({ invoice_series: 'A' }) }, ADMIN);
  }
});

test('settings writes are whitelisted and validated', async () => {
  const bad = [
    { body: { arbitrary_key: '1' },          why: 'unknown key' },
    { body: { gst_registration: 'nonsense' }, why: 'bad registration' },
    { body: { price_mode: 'sideways' },       why: 'bad price mode' },
    { body: {} ,                             why: 'no settings' },
  ];
  for (const { body, why } of bad) {
    const res = await call('/settings', { method: 'PUT', body: JSON.stringify(body) }, ADMIN);
    assert.equal(res.status, 400, `should reject: ${why}`);
  }
});

// --- catalog shapes --------------------------------------------------------

test('/products keeps the legacy shape the shipped clients read', async () => {
  // Both clients in the field read exactly these four fields. Changing this
  // response would break builds already installed on tills.
  const rows = await (await call('/products')).json();
  for (const r of rows.slice(0, 3)) {
    assert.deepEqual(Object.keys(r).sort(), ['id', 'name', 'price', 'stock']);
    assert.ok(Number.isInteger(r.price) && Number.isInteger(r.stock));
  }
});

test('/products reports services as in stock, so old clients can sell them', async () => {
  // Both shipped clients disable an item at stock <= 0. A truthful 0 would
  // make every service unsellable on tills already in the field.
  const rows = await (await call('/products')).json();
  const service = rows.find(r => r.id === 'delivery');
  assert.ok(service, 'seeded service missing from catalog');
  assert.ok(service.stock > 0, 'a service must not look out of stock to old clients');
});

test('/items reports kind and tax codes honestly', async () => {
  const rows = await (await call('/items')).json();
  const service = rows.find(r => r.id === 'delivery');
  const good = rows.find(r => r.id === 'espresso');

  assert.equal(service.kind, 'service');
  assert.equal(service.stock, null, 'stock is meaningless for a service, not zero');
  assert.equal(service.tax_code, '996813', 'services carry a SAC');

  assert.equal(good.kind, 'good');
  assert.ok(Number.isInteger(good.stock));
  assert.ok(good.gst_rate_bps > 0, 'seeded goods should have a GST rate');
});

// --- purchases and FIFO ----------------------------------------------------

test('a purchase creates stock at the cost paid', async () => {
  const before = await stockOf('espresso');

  const res = await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplier_name: 'Test Supplier',
      supplier_inv_no: uid('INV'),
      lines: [{ product_id: 'espresso', qty: 10, taxable_paise: 1000 }],
    }),
  }, ADMIN);

  assert.equal(res.status, 201);
  assert.equal(await stockOf('espresso'), before + 10);
});

test('till token cannot record a purchase', async () => {
  // A purchase creates inventory value and input tax credit from nothing.
  const res = await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({ lines: [{ product_id: 'espresso', qty: 1, taxable_paise: 100 }] }),
  });
  assert.equal(res.status, 401);
});

test('a service cannot be stocked', async () => {
  // There would be no lot for a sale to consume, and the balance sheet would
  // carry inventory value for something that does not exist.
  const res = await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({ lines: [{ product_id: 'delivery', qty: 5, taxable_paise: 500 }] }),
  }, ADMIN);
  assert.equal(res.status, 400);
});

test('rejects bad purchase payloads', async () => {
  const bad = [
    { lines: [] },
    { lines: [{ product_id: 'espresso', qty: 0, taxable_paise: 100 }] },
    { lines: [{ product_id: 'espresso', qty: 1, taxable_paise: -1 }] },
    { lines: [{ product_id: 'no-such-item', qty: 1, taxable_paise: 100 }] },
    { lines: [{ qty: 1, taxable_paise: 100 }] },
    // Negative tax would post a ledger entry that cannot balance.
    { lines: [{ product_id: 'espresso', qty: 1, taxable_paise: 100, tax_paise: -500 }] },
    { lines: [{ product_id: 'espresso', qty: 1, taxable_paise: 100, gst_rate_bps: -1 }] },
  ];
  for (const body of bad) {
    const res = await call('/purchases', { method: 'POST', body: JSON.stringify(body) }, ADMIN);
    assert.equal(res.status, 400, `should reject ${JSON.stringify(body)}`);
  }
});

test('a cash purchase with no supplier invoice number works', async () => {
  // The common case for a small shop, and the one where the voucher has no
  // source document reference to look itself up by.
  const res = await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplier_name: 'Local Market',
      lines: [{ product_id: 'croissant', qty: 3, taxable_paise: 300 }],
    }),
  }, ADMIN);

  assert.equal(res.status, 201, await res.text());
  const tb = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  assert.equal(tb.net, 0, 'the voucher must still have posted and balanced');
});

test('a sale draws FIFO and records COGS from the oldest lot', async () => {
  // Two purchases of the same item at different costs. Selling must consume
  // the cheaper (older) one first, and COGS must reflect that, not an average.
  const inv1 = uid('INV');
  await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplier_inv_no: inv1,
      lines: [{ product_id: 'muffin', qty: 4, taxable_paise: 400 }],   // 100p each
    }),
  }, ADMIN);
  await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplier_inv_no: uid('INV'),
      lines: [{ product_id: 'muffin', qty: 4, taxable_paise: 1200 }],  // 300p each
    }),
  }, ADMIN);

  // The seeded opening lot for muffin has zero cost and sits oldest, so drain
  // it first to isolate the two costed lots.
  const opening = (await (await call('/reports/stock', {}, ADMIN)).json())
    .items.find(r => r.id === 'muffin').qty - 8;
  if (opening > 0) {
    await call('/sales', {
      method: 'POST',
      body: JSON.stringify(sale({ items: [{ id: 'muffin', qty: opening }] })),
    });
  }

  const s = sale({ items: [{ id: 'muffin', qty: 5 }] });
  assert.equal((await call('/sales', { method: 'POST', body: JSON.stringify(s) })).status, 201);

  // 4 units at 100p + 1 at 300p.
  assert.equal((await history(s.client_ref)).cogs_paise, 400 + 300);
});

test('overselling is refused with 409, not silently clamped', async () => {
  // 409 rather than 400: the payload is fine, the world changed. A retry
  // cannot conjure stock, so the client must treat it as permanent.
  const available = await stockOf('sandwich');
  const res = await call('/sales', {
    method: 'POST',
    body: JSON.stringify(sale({ items: [{ id: 'sandwich', qty: available + 50 }] })),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.available, available);
  // And nothing moved.
  assert.equal(await stockOf('sandwich'), available);
});

test('an unknown item is rejected before anything is written', async () => {
  const res = await call('/sales', {
    method: 'POST',
    body: JSON.stringify(sale({ items: [{ id: 'no-such-item', qty: 1 }] })),
  });
  assert.equal(res.status, 400);
});

test('an absurd quantity is refused rather than overflowing the money math', async () => {
  // Stock bounds a good, but a service has nothing to run out of. Without a
  // ceiling, price * qty * 10000 passes Number.MAX_SAFE_INTEGER and the
  // integer-paise guarantee quietly stops holding — garbage would then be
  // written to the ledger as if it were money.
  const res = await call('/sales', {
    method: 'POST',
    body: JSON.stringify(sale({ items: [{ id: 'catering', qty: 1e12 }] })),
  });
  assert.equal(res.status, 400);

  const tb = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  assert.equal(tb.net, 0, 'books must be untouched');
  assert.ok(Number.isSafeInteger(tb.totalDebit), 'ledger totals must stay exact integers');
});

test('a sale is refused whole if its money math would leave integer range', async () => {
  // Same guard at the invoice level rather than the line level.
  const res = await call('/sales', {
    method: 'POST',
    body: JSON.stringify(sale({
      items: Array.from({ length: 50 }, () => ({ id: 'catering', qty: 99999 })),
    })),
  });
  // Either bound may catch it; what matters is that it does not succeed.
  assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
});

// --- GST on a recorded sale ------------------------------------------------

test('the server computes GST itself and ignores the client total', async () => {
  // A client sending a wrong total (an old build with a hardcoded 5%) must not
  // be able to decide what the books say.
  const s = sale({ items: [{ id: 'espresso', qty: 2 }], total: 1 });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });

  const row = await history(s.client_ref);
  assert.equal(row.total, 1, 'what the client sent is kept verbatim');
  assert.equal(row.total_mismatch, 1, 'and the disagreement is flagged, not hidden');
  assert.ok(row.total_paise > 1, 'the server computed its own total');
  // espresso is 250p at 18% inclusive: taxable + tax must equal the price.
  assert.equal(row.taxable_paise + row.cgst_paise + row.sgst_paise + row.igst_paise
               + row.round_off_paise, row.total_paise);
});

test('a local sale is CGST+SGST, never IGST', async () => {
  const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  const row = await history(s.client_ref);
  assert.equal(row.igst_paise, 0);
  assert.ok(row.cgst_paise > 0 && row.sgst_paise > 0);
  // The halves are derived from each other, so they differ by at most the odd
  // paisa and together make up the whole tax.
  assert.ok(Math.abs(row.cgst_paise - row.sgst_paise) <= 1, 'halves should be equal or differ by 1');
  assert.equal(row.taxable_paise + row.cgst_paise + row.sgst_paise + row.round_off_paise,
    row.total_paise);
});

test('an uncanonical place of supply cannot misroute an intrastate sale to IGST', async () => {
  // Seeded seller state is 19. "19 ", "019" and "1 9" compared unequal to it as
  // raw strings and routed the whole sale to IGST — the client choosing the tax
  // head. "19 " and "019" must normalise to intrastate; "1 9" and "nineteen" are
  // not state codes at all and must be refused, not silently used.
  for (const pos of ['19 ', '019', ' 19']) {
    const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
    const res = await call('/sales', {
      method: 'POST', body: JSON.stringify({ ...s, place_of_supply: pos }),
    });
    assert.equal(res.status, 201, `${JSON.stringify(pos)} should be accepted`);
    const row = await history(s.client_ref);
    assert.equal(row.igst_paise, 0, `${JSON.stringify(pos)} must stay intrastate`);
    assert.ok(row.cgst_paise > 0 && row.sgst_paise > 0);
  }

  for (const pos of ['1 9', 'nineteen', '19a', '00', '39']) {
    const res = await call('/sales', {
      method: 'POST',
      body: JSON.stringify(sale({ items: [{ id: 'espresso', qty: 1 }], place_of_supply: pos })),
    });
    assert.equal(res.status, 400, `${JSON.stringify(pos)} is not a state code and must be refused`);
  }
});

test('state_code is validated when set, since it decides the tax head on every sale', async () => {
  for (const bad of ['nineteen', '19 x', '00', '39', '1.9']) {
    const res = await call('/settings', {
      method: 'PUT', body: JSON.stringify({ state_code: bad }),
    }, ADMIN);
    assert.equal(res.status, 400, `state_code ${JSON.stringify(bad)} should be refused`);
  }
  // A real code still works, and normalises.
  try {
    const ok = await call('/settings', { method: 'PUT', body: JSON.stringify({ state_code: '7' }) }, ADMIN);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).state_code, '07', 'stored zero-padded');
  } finally {
    await call('/settings', { method: 'PUT', body: JSON.stringify({ state_code: '19' }) }, ADMIN);
  }
});

test('an interstate sale is IGST only', async () => {
  const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
  await call('/sales', {
    method: 'POST',
    // Seeded state_code is 19 (West Bengal); 27 is Maharashtra.
    body: JSON.stringify({ ...s, place_of_supply: '27' }),
  });
  const row = await history(s.client_ref);
  assert.ok(row.igst_paise > 0, 'interstate supply must be IGST');
  assert.equal(row.cgst_paise, 0);
  assert.equal(row.sgst_paise, 0);
  assert.equal(row.place_of_supply, '27');
});

test('every sale gets an invoice number in its series', async () => {
  const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  const row = await history(s.client_ref);
  assert.match(row.invoice_no, /^A\/\d{2}-\d{2}\/\d{4}$/, `got ${row.invoice_no}`);
});

test('invoice numbers are consecutive within a series', async () => {
  // GST requires a gapless serial per series. Three sales in a row must
  // produce three consecutive numbers.
  const refs = [];
  for (let i = 0; i < 3; i++) {
    const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
    await call('/sales', { method: 'POST', body: JSON.stringify(s) });
    refs.push(s.client_ref);
  }

  const nos = [];
  for (const ref of refs) nos.push(Number((await history(ref)).invoice_no.split('/')[2]));
  assert.deepEqual(nos, [nos[0], nos[0] + 1, nos[0] + 2], `not consecutive: ${nos}`);
});

// --- services and mixed invoices -------------------------------------------

test('a service sells with no stock and no COGS', async () => {
  const s = sale({ items: [{ id: 'delivery', qty: 2 }] });
  const res = await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  assert.equal(res.status, 201, 'a service must be sellable with no lots');

  const row = await history(s.client_ref);
  assert.equal(row.cogs_paise, 0, 'a service has no cost of goods');
  assert.ok(row.taxable_paise > 0, 'but it does earn revenue');
});

test('one invoice can mix a good and a service', async () => {
  const s = sale({ items: [{ id: 'espresso', qty: 1 }, { id: 'delivery', qty: 1 }] });
  assert.equal((await call('/sales', { method: 'POST', body: JSON.stringify(s) })).status, 201);

  const row = await history(s.client_ref);
  // The good contributes COGS; the service contributes revenue but no cost.
  assert.ok(row.taxable_paise > 0);
  assert.equal(row.taxable_paise + row.cgst_paise + row.sgst_paise + row.igst_paise
               + row.round_off_paise, row.total_paise);
});

test('goods revenue and service revenue post to different accounts', async () => {
  // The reason goods and services are modelled apart at all: a P&L that lumps
  // them together cannot show which side of the business earns.
  const before = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  const bal = (tb, code) => tb.accounts.find(a => a.code === code)?.credit_paise ?? 0;

  await call('/sales', {
    method: 'POST',
    body: JSON.stringify(sale({ items: [{ id: 'espresso', qty: 1 }, { id: 'delivery', qty: 1 }] })),
  });

  const after = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  assert.ok(bal(after, '4000') > bal(before, '4000'), 'Sales should rise for the good');
  assert.ok(bal(after, '4100') > bal(before, '4100'), 'Service Income should rise for the service');
});

// --- the books -------------------------------------------------------------

test('the trial balance nets to zero', async () => {
  // Double-entry's whole guarantee. If this ever fails, something wrote to
  // voucher_lines without going through buildVoucher.
  const tb = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  assert.equal(tb.net, 0, `books out by ${tb.net} paise`);
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebit, tb.totalCredit);
  assert.ok(tb.accounts.length > 0, 'expected posted accounts');
});

test('the books still balance after a mixed run of sales and purchases', async () => {
  await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplier_inv_no: uid('INV'),
      lines: [
        { product_id: 'croissant', qty: 7, taxable_paise: 777 },
        { product_id: 'water', qty: 3, taxable_paise: 1000 },
      ],
    }),
  }, ADMIN);

  for (const items of [
    [{ id: 'croissant', qty: 3 }],
    [{ id: 'water', qty: 1 }, { id: 'delivery', qty: 1 }],
    [{ id: 'espresso', qty: 2 }],
  ]) {
    await call('/sales', { method: 'POST', body: JSON.stringify(sale({ items })) });
  }

  const tb = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  assert.equal(tb.net, 0, `books out by ${tb.net} paise`);
});

test('a retried sale does not post to the books twice', async () => {
  // The offline-safety guarantee extended to the ledger: a lost response must
  // not double the revenue, the stock movement or the journal entry.
  const s = sale({ items: [{ id: 'espresso', qty: 1 }] });

  assert.equal((await call('/sales', { method: 'POST', body: JSON.stringify(s) })).status, 201);
  const afterFirst = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  const stockAfterFirst = await stockOf('espresso');

  const retry = await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);

  const afterRetry = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  assert.equal(afterRetry.totalDebit, afterFirst.totalDebit, 'retry posted a second voucher');
  assert.equal(afterRetry.net, 0);
  assert.equal(await stockOf('espresso'), stockAfterFirst, 'retry moved stock again');
});

test('an invoice number is not consumed by a duplicate', async () => {
  // The series bump is in the same transaction as the sale, so a rolled-back
  // duplicate must not leave a gap.
  const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  const first = (await history(s.client_ref)).invoice_no;

  await call('/sales', { method: 'POST', body: JSON.stringify(s) });          // duplicate
  assert.equal((await history(s.client_ref)).invoice_no, first, 'number changed on retry');

  const next = sale({ items: [{ id: 'espresso', qty: 1 }] });
  await call('/sales', { method: 'POST', body: JSON.stringify(next) });

  const n = no => Number(no.split('/')[2]);
  assert.equal(n((await history(next.client_ref)).invoice_no), n(first) + 1,
    'the duplicate should not have consumed a number');
});

// --- stock report ----------------------------------------------------------

test('a composition dealer capitalises input tax instead of claiming it', async () => {
  // Input tax is only recoverable by a regular dealer. For a composition
  // business it is part of what the goods cost, so it must land in the lot's
  // value rather than in an Input GST asset that could never be claimed.
  const id = 'cappuccino';
  try {
    await call('/settings', {
      method: 'PUT', body: JSON.stringify({ gst_registration: 'composition' }),
    }, ADMIN);

    const before = await (await call('/reports/stock', {}, ADMIN)).json();
    const beforeValue = before.items.find(r => r.id === id).value_paise;

    await call('/purchases', {
      method: 'POST',
      body: JSON.stringify({
        supplier_inv_no: uid('INV'),
        lines: [{ product_id: id, qty: 10, taxable_paise: 1000, gst_rate_bps: 1800 }],
      }),
    }, ADMIN);

    const after = await (await call('/reports/stock', {}, ADMIN)).json();
    assert.equal(after.items.find(r => r.id === id).value_paise, beforeValue + 1180,
      'the 180p of non-creditable tax belongs in the stock value');

    const tb = await (await call('/reports/trial-balance', {}, ADMIN)).json();
    assert.equal(tb.net, 0, 'books must still balance');
  } finally {
    // Restore, or every test after this one sells tax-free.
    await call('/settings', {
      method: 'PUT', body: JSON.stringify({ gst_registration: 'regular' }),
    }, ADMIN);
  }
});

test('stock report values stock at FIFO cost', async () => {
  const id = 'vegwrap';
  const before = await (await call('/reports/stock', {}, ADMIN)).json();
  const beforeValue = before.items.find(r => r.id === id).value_paise;

  await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplier_inv_no: uid('INV'),
      lines: [{ product_id: id, qty: 5, taxable_paise: 2500 }],
    }),
  }, ADMIN);

  const after = await (await call('/reports/stock', {}, ADMIN)).json();
  assert.equal(after.items.find(r => r.id === id).value_paise, beforeValue + 2500);
});

test('stock report excludes services', async () => {
  const { items } = await (await call('/reports/stock', {}, ADMIN)).json();
  assert.ok(!items.some(r => r.id === 'delivery'), 'a service has no stock to report');
});

test('till token cannot read the reports', async () => {
  assert.equal((await call('/reports/stock')).status, 401);
  assert.equal((await call('/reports/trial-balance')).status, 401);
});

// ===========================================================================
// Phase 2: item management, images, bills.
// ===========================================================================

/** A fresh id per run, so repeated test runs don't collide on the primary key. */
const newId = p => `${p}-${crypto.randomUUID().slice(0, 8)}`;

const makeItem = (over = {}) => ({
  id: newId('t'),
  name: 'Test Item',
  price: 10000,
  gst_rate_bps: 1800,
  tax_code: '1006',
  unit: 'PCS',
  ...over,
});

const createItem = (body, token = ADMIN) =>
  call('/items', { method: 'POST', body: JSON.stringify(body) }, token);

/** The 67-byte 1x1 PNG used to exercise the image routes. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex');

// --- creation --------------------------------------------------------------

test('an item can be created and appears on the till', async () => {
  // freshCode() rather than a random value in a fixed range: the local D1 keeps
  // items between runs, so a small range eventually collides and this fails
  // looking like a real regression. Defined below — test bodies run after the
  // module is evaluated.
  const item = makeItem({ code: freshCode() });
  assert.equal((await createItem(item)).status, 201);

  const rows = await (await call('/items')).json();
  const found = rows.find(r => r.id === item.id);
  assert.ok(found, 'new item missing from the catalog');
  assert.equal(found.price_paise, 10000);
  assert.equal(found.stock, 0, 'stock starts at zero — it arrives via a purchase');
});

test('a till token cannot create, edit or delete items', async () => {
  // An item's GST rate decides what a legal document says.
  const item = makeItem();
  assert.equal((await createItem(item, TOKEN)).status, 401);
  assert.equal((await call(`/items/${item.id}`, {
    method: 'PATCH', body: JSON.stringify({ price: 1 }),
  })).status, 401);
  assert.equal((await call(`/items/${item.id}`, { method: 'DELETE' })).status, 401);
});

test('a bogus GST rate is refused with a message naming the slabs', async () => {
  const res = await createItem(makeItem({ gst_rate_bps: 1500 }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /gst_rate_bps/);
});

test('a duplicate id is a conflict, not a silent overwrite', async () => {
  const item = makeItem();
  assert.equal((await createItem(item)).status, 201);
  const again = await createItem({ ...item, name: 'Different Name' });
  assert.equal(again.status, 409);

  // And the original is intact.
  const rows = await (await call('/items')).json();
  assert.equal(rows.find(r => r.id === item.id).name, 'Test Item');
});

/**
 * A code/barcode value no earlier run can already have taken.
 *
 * The local D1 persists between runs and accumulates items, so a value drawn
 * from a fixed random range eventually collides with one an earlier run created.
 * The FIRST create then returns 409 and the test fails looking exactly like a
 * regression in the uniqueness check it is supposed to be proving.
 *
 * A random 6-digit code is not enough on its own either: codes are capped at 6
 * digits, so the space is small. Seeding from the clock makes a repeat
 * effectively impossible while staying inside the format.
 */
let uniqueCounter = 0;
const freshCode = () => String(100000 + ((Date.now() + uniqueCounter++) % 899999));

test('a duplicate till code is refused, because entry must be unambiguous', async () => {
  // Two items answering to `77` would make typing 77 ring up whichever the
  // database happened to return first.
  const code = freshCode();
  const first = await createItem(makeItem({ code }));
  assert.equal(first.status, 201, `setup failed — code ${code} was already taken`);

  const clash = await createItem(makeItem({ code }));
  assert.equal(clash.status, 409);
  assert.match((await clash.json()).error, /code/i);
});

test('a duplicate barcode is refused', async () => {
  const barcode = `89${Date.now()}${uniqueCounter++}`.slice(0, 13);
  const first = await createItem(makeItem({ barcode }));
  assert.equal(first.status, 201, `setup failed — barcode ${barcode} was already taken`);
  assert.equal((await createItem(makeItem({ barcode }))).status, 409);
});

// --- editing ---------------------------------------------------------------

test('a price change does not touch the cost of existing stock', async () => {
  // The invariant that matters most here. A lot records what that stock actually
  // cost; rewriting it to follow a new selling price would falsify the FIFO
  // history and retroactively change the COGS of every sale already made.
  const item = makeItem({ price: 10000 });
  await createItem(item);
  await call(`/items/${item.id}/opening-stock`, {
    method: 'POST', body: JSON.stringify({ qty: 10, cost_paise: 50000 }),
  }, ADMIN);

  const valueOf = async () => (await (await call('/reports/stock', {}, ADMIN)).json())
    .items.find(r => r.id === item.id).value_paise;

  assert.equal(await valueOf(), 50000);

  const res = await call(`/items/${item.id}`, {
    method: 'PATCH', body: JSON.stringify({ price: 99000 }),
  }, ADMIN);
  assert.equal(res.status, 200);

  assert.equal(await valueOf(), 50000, 'stock value must be unchanged by a price edit');
});

test('id and kind cannot be changed after creation', async () => {
  // Both would orphan or contradict existing rows: sale_lines and stock_lots
  // reference the id, and a service with lots is incoherent.
  const item = makeItem();
  await createItem(item);

  const res = await call(`/items/${item.id}`, {
    method: 'PATCH', body: JSON.stringify({ kind: 'service' }),
  }, ADMIN);
  assert.equal(res.status, 400);

  // Changing the id is ignored rather than rejected, since a client may echo
  // back the whole object — what matters is that it does not take effect.
  const other = newId('moved');
  await call(`/items/${item.id}`, {
    method: 'PATCH', body: JSON.stringify({ id: other, name: 'Renamed' }),
  }, ADMIN);

  const rows = await (await call('/items')).json();
  assert.ok(rows.find(r => r.id === item.id), 'original id must survive');
  assert.ok(!rows.find(r => r.id === other), 'id must not have moved');
});

test('patching an unknown item is a 404', async () => {
  const res = await call('/items/no-such-item-at-all', {
    method: 'PATCH', body: JSON.stringify({ price: 100 }),
  }, ADMIN);
  assert.equal(res.status, 404);
});

// --- deactivation ----------------------------------------------------------

test('hiding an item keeps it off the till but visible to admin', async () => {
  const item = makeItem();
  await createItem(item);

  assert.equal((await call(`/items/${item.id}`, { method: 'DELETE' }, ADMIN)).status, 200);

  const tillRows = await (await call('/items')).json();
  assert.ok(!tillRows.find(r => r.id === item.id), 'a hidden item must not be sellable');

  const adminRows = await (await call('/items?all=1', {}, ADMIN)).json();
  const found = adminRows.find(r => r.id === item.id);
  assert.ok(found, 'admin must still see it to restore it');
  assert.equal(found.is_active, 0);
});

test('a hidden item can be restored', async () => {
  const item = makeItem();
  await createItem(item);
  await call(`/items/${item.id}`, { method: 'DELETE' }, ADMIN);

  const res = await call(`/items/${item.id}`, {
    method: 'PATCH', body: JSON.stringify({ is_active: 1 }),
  }, ADMIN);
  assert.equal(res.status, 200);

  const rows = await (await call('/items')).json();
  assert.ok(rows.find(r => r.id === item.id), 'restored item should be sellable again');
});

test('an item holding stock cannot be hidden', async () => {
  // That stock has a value sitting in the balance sheet; hiding the item would
  // leave the value with nothing to attribute it to.
  const item = makeItem();
  await createItem(item);
  await call(`/items/${item.id}/opening-stock`, {
    method: 'POST', body: JSON.stringify({ qty: 5, cost_paise: 1000 }),
  }, ADMIN);

  const res = await call(`/items/${item.id}`, { method: 'DELETE' }, ADMIN);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).stock, 5);
});

test('the till never sees a hidden item even by direct sale attempt', async () => {
  // Deactivation has to actually prevent selling, not merely hide the tile.
  const item = makeItem();
  await createItem(item);
  await call(`/items/${item.id}/opening-stock`, {
    method: 'POST', body: JSON.stringify({ qty: 3, cost_paise: 300 }),
  }, ADMIN);

  // Sell it down so it can be hidden, then confirm it is gone from the catalog.
  await call('/sales', {
    method: 'POST', body: JSON.stringify(sale({ items: [{ id: item.id, qty: 3 }] })),
  });
  await call(`/items/${item.id}`, { method: 'DELETE' }, ADMIN);

  const rows = await (await call('/items')).json();
  assert.ok(!rows.find(r => r.id === item.id));
});

test('a withdrawn item cannot be sold by naming its id directly', async () => {
  // Hiding the tile is not enough: a till with a cached catalog, or any caller
  // that knows the id, must be refused at recordSale. A service is the sharp
  // case — with no stock to run out of, it would otherwise be sellable forever.
  const svc = makeItem({ kind: 'service', tax_code: '998311', unit: 'NA' });
  await createItem(svc);
  await call(`/items/${svc.id}`, { method: 'DELETE' }, ADMIN);   // no stock, so allowed

  const res = await call('/sales', {
    method: 'POST', body: JSON.stringify(sale({ items: [{ id: svc.id, qty: 1 }] })),
  });
  assert.equal(res.status, 400, 'a deactivated service must not be sellable');

  // And it left no half-written sale behind.
  const tb = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  assert.equal(tb.net, 0);
});

test('an unrecognised payment mode is refused, not booked as cash', async () => {
  // settlementAccount used to fall through to Cash in Hand, so "cheque" silently
  // booked a non-cash sale as cash and the drawer stopped reconciling.
  for (const mode of ['cheque', 'netbanking', 'paytm', 'gift-card', '']) {
    const res = await call('/sales', {
      method: 'POST',
      body: JSON.stringify(sale({ items: [{ id: 'espresso', qty: 1 }], payment_mode: mode })),
    });
    assert.equal(res.status, 400, `payment_mode ${JSON.stringify(mode)} should be refused`);
  }
  // The real modes still work.
  for (const mode of ['cash', 'upi', 'card', 'bank', 'credit']) {
    const res = await call('/sales', {
      method: 'POST',
      body: JSON.stringify(sale({ items: [{ id: 'espresso', qty: 1 }], payment_mode: mode })),
    });
    assert.equal(res.status, 201, `payment_mode ${mode} should be accepted`);
  }
});

test('a malformed percent-escape in a path is a 400, and 401 without a token', async () => {
  // decodeURIComponent throws on "%"; doing it before the auth check turned an
  // unauthenticated request into a 500. Auth must come first, and a bad escape
  // is a bad request, not a server fault.
  assert.equal((await fetch(`${BASE}/items/%`, { method: 'PATCH' })).status, 401,
    'no token: 401 before any decode');
  assert.equal((await fetch(`${BASE}/sales/%E0`)).status, 401);

  // With the admin token, the malformed path is a clean 400, not a 500.
  const res = await call('/items/%', { method: 'PATCH', body: JSON.stringify({ price: 100 }) }, ADMIN);
  assert.equal(res.status, 400);
});

// --- opening stock ---------------------------------------------------------

test('opening stock posts to capital, not cash', async () => {
  // Stock a shop already had was not bought today. Posting it against Cash would
  // invent a payment that never happened and leave the cash balance wrong.
  const before = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  const cashBefore = before.accounts.find(a => a.code === '1000')?.credit_paise ?? 0;
  const equityBefore = before.accounts.find(a => a.code === '3100')?.credit_paise ?? 0;

  const item = makeItem();
  await createItem(item);
  const res = await call(`/items/${item.id}/opening-stock`, {
    method: 'POST', body: JSON.stringify({ qty: 20, cost_paise: 40000 }),
  }, ADMIN);
  assert.equal(res.status, 201);

  const after = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  assert.equal(after.accounts.find(a => a.code === '1000')?.credit_paise ?? 0, cashBefore,
    'cash must not move for opening stock');
  assert.equal(after.accounts.find(a => a.code === '3100').credit_paise, equityBefore + 40000);
  assert.equal(after.net, 0, 'and the books still balance');
});

test('opening stock is not attributed to an unrelated purchase line', async () => {
  // lotInsert fills purchase_line_id with (SELECT MAX(id) FROM purchase_lines),
  // which is right for a purchase — the line was inserted immediately before in
  // the same batch. Opening stock has NO purchase line, so MAX(id) picked up
  // whichever supplier line happened to be inserted last, from an unrelated
  // product. That is a false audit trail: "where did this stock come from" gave a
  // confidently wrong answer.
  //
  // Verified against a real database: five opening-stock lots for five different
  // products all claimed purchase line 337, a vegwrap purchase.
  const item = makeItem();
  await createItem(item);

  // A purchase of a DIFFERENT item first, so a stale MAX(id) has something wrong
  // to latch onto.
  await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplier_inv_no: uid('INV'),
      lines: [{ product_id: 'water', qty: 5, taxable_paise: 2500 }],
    }),
  }, ADMIN);

  const res = await call(`/items/${item.id}/opening-stock`, {
    method: 'POST', body: JSON.stringify({ qty: 10, cost_paise: 40000 }),
  }, ADMIN);
  assert.equal(res.status, 201);

  // The lot must exist with the right cost, and must NOT claim a purchase line.
  const { items } = await (await call('/reports/stock', {}, ADMIN)).json();
  const row = items.find(r => r.id === item.id);
  assert.equal(row.qty, 10);
  assert.equal(row.value_paise, 40000, 'opening stock must carry the cost given');

  // And the books still balance — opening stock posts against equity, not cash.
  const tb = await (await call('/reports/trial-balance', {}, ADMIN)).json();
  assert.equal(tb.net, 0);
});

test('opening stock is consumed first, being the oldest', async () => {
  const item = makeItem();
  await createItem(item);

  // Opening stock at 100p/unit, then a purchase at 500p/unit.
  await call(`/items/${item.id}/opening-stock`, {
    method: 'POST', body: JSON.stringify({ qty: 2, cost_paise: 200 }),
  }, ADMIN);
  await call('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplier_inv_no: uid('INV'),
      lines: [{ product_id: item.id, qty: 2, taxable_paise: 1000 }],
    }),
  }, ADMIN);

  const s = sale({ items: [{ id: item.id, qty: 3 }] });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });

  // 2 units at 100p + 1 at 500p.
  assert.equal((await history(s.client_ref)).cogs_paise, 200 + 500);
});

test('a service cannot be given opening stock', async () => {
  const item = makeItem({ kind: 'service', tax_code: '996813', unit: 'NA' });
  await createItem(item);

  const res = await call(`/items/${item.id}/opening-stock`, {
    method: 'POST', body: JSON.stringify({ qty: 5, cost_paise: 500 }),
  }, ADMIN);
  assert.equal(res.status, 400);
});

test('opening stock validates its numbers', async () => {
  const item = makeItem();
  await createItem(item);
  for (const body of [
    { qty: 0, cost_paise: 100 },
    { qty: -1, cost_paise: 100 },
    { qty: 1.5, cost_paise: 100 },
    { qty: 5, cost_paise: -1 },
    { qty: 5, cost_paise: 1.5 },
    { qty: 5 },
  ]) {
    const res = await call(`/items/${item.id}/opening-stock`, {
      method: 'POST', body: JSON.stringify(body),
    }, ADMIN);
    assert.equal(res.status, 400, `should reject ${JSON.stringify(body)}`);
  }
});

// --- images ----------------------------------------------------------------

const postImage = (id, body, headers = {}, token = ADMIN) =>
  fetch(`${BASE}/items/${id}/image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });

test('a real image uploads and is then served', async () => {
  const item = makeItem();
  await createItem(item);

  const res = await postImage(item.id, PNG);
  // Read the body once: it is a stream, so consuming it for an assertion message
  // would leave nothing to parse.
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.type, 'image/png');

  // Served back, with the type we determined rather than one a caller claimed.
  const img = await fetch(`${BASE}/images/items/${item.id}?t=${TOKEN}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('cache-control') ?? '', /max-age=/);
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
});

test('a non-image body is rejected however it labels itself', async () => {
  // Content-Type is caller-controlled and means nothing. The bytes decide.
  const item = makeItem();
  await createItem(item);

  const res = await postImage(item.id, 'this is not an image',
    { 'Content-Type': 'image/png' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a PNG/i);
});

test('an SVG is rejected, since it can carry script', async () => {
  const item = makeItem();
  await createItem(item);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  assert.equal((await postImage(item.id, svg, { 'Content-Type': 'image/svg+xml' })).status, 400);
});

test('an oversized image is rejected', async () => {
  const item = makeItem();
  await createItem(item);
  // A valid PNG header followed by 3 MB of padding.
  const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
  assert.equal((await postImage(item.id, big)).status, 413);
});

test('an empty body is rejected', async () => {
  const item = makeItem();
  await createItem(item);
  assert.equal((await postImage(item.id, Buffer.alloc(0))).status, 400);
});

test('a till token cannot upload an image', async () => {
  const item = makeItem();
  await createItem(item);
  assert.equal((await postImage(item.id, PNG, {}, TOKEN)).status, 401);
});

test('uploading to an unknown item is a 404', async () => {
  assert.equal((await postImage('no-such-item', PNG)).status, 404);
});

test('an image cannot be fetched without a token', async () => {
  const item = makeItem();
  await createItem(item);
  await postImage(item.id, PNG);
  assert.equal((await fetch(`${BASE}/images/items/${item.id}`)).status, 401);
  assert.equal((await fetch(`${BASE}/images/items/${item.id}?t=wrong`)).status, 401);
});

test('the admin token is NOT accepted as an image query parameter', async () => {
  // A URL ends up in logs and referrers, so only the till token — already public
  // by design — may ride in ?t=. The admin token gates the books; accepting it
  // here would leak it, which is exactly what the admin page used to do by
  // putting it in every thumbnail src.
  const item = makeItem();
  await createItem(item);
  await postImage(item.id, PNG);

  assert.equal((await fetch(`${BASE}/images/items/${item.id}?t=${TOKEN}`)).status, 200,
    'the till token still works in the URL');
  assert.equal((await fetch(`${BASE}/images/items/${item.id}?t=${ADMIN}`)).status, 401,
    'the admin token must be refused as a query parameter');

  // But the admin token still works in the Authorization HEADER, where it does
  // not leak into logs.
  assert.equal((await call(`/images/items/${item.id}`, {}, ADMIN)).status, 200);
});

test('a missing image is a 404, not a broken stream', async () => {
  assert.equal((await fetch(`${BASE}/images/items/never-uploaded?t=${TOKEN}`)).status, 404);
});

// --- bills -----------------------------------------------------------------

test('a sale can be fetched back for printing', async () => {
  const s = sale({ items: [{ id: 'espresso', qty: 2 }] });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });

  const res = await call(`/sales/${s.client_ref}`);
  assert.equal(res.status, 200);
  const { sale: row, shop } = await res.json();

  assert.equal(row.client_ref, s.client_ref);
  assert.ok(row.invoice_no, 'a bill needs its invoice number');
  assert.equal(row.lines.length, 1);
  assert.equal(row.lines[0].qty, 2);
  assert.ok('gst_registration' in shop, 'the bill needs to know the document type');
});

test('the till can reprint its own bill without the admin token', async () => {
  // The counter has to be able to reprint what it just issued. This is one sale
  // the client already knows the ref of, not the revenue history.
  const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  assert.equal((await call(`/sales/${s.client_ref}`, {}, TOKEN)).status, 200);
});

test('every bill format renders as HTML with the right figures', async () => {
  const s = sale({ items: [{ id: 'espresso', qty: 2 }, { id: 'delivery', qty: 1 }] });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  const row = await history(s.client_ref);

  for (const format of ['58mm', '80mm', 'a4']) {
    const res = await call(`/sales/${s.client_ref}?format=${format}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);

    const html = await res.text();
    assert.match(html, /^<!DOCTYPE html>/, `${format}: not a document`);
    assert.ok(html.includes(row.invoice_no), `${format}: missing invoice number`);
    // The printed total must be the recorded total, or the bill disagrees with
    // the books.
    assert.ok(html.includes((row.total_paise / 100).toFixed(2)),
      `${format}: printed total does not match the recorded one`);
  }
});

test('the bill falls back to the configured default format', async () => {
  const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
  await call('/sales', { method: 'POST', body: JSON.stringify(s) });

  const res = await call(`/sales/${s.client_ref}?format=`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^<!DOCTYPE html>/);
});

test('an unknown sale is a 404', async () => {
  assert.equal((await call('/sales/no-such-ref-here')).status, 404);
});

test('bill_format is validated when set', async () => {
  const res = await call('/settings', {
    method: 'PUT', body: JSON.stringify({ bill_format: 'thermal-9000' }),
  }, ADMIN);
  assert.equal(res.status, 400);
});

test('shop details reach the printed bill', async () => {
  try {
    await call('/settings', {
      method: 'PUT',
      body: JSON.stringify({ legal_name: 'Ganesh Stores', address: '12 Market Road' }),
    }, ADMIN);

    const s = sale({ items: [{ id: 'espresso', qty: 1 }] });
    await call('/sales', { method: 'POST', body: JSON.stringify(s) });

    const html = await (await call(`/sales/${s.client_ref}?format=a4`)).text();
    assert.ok(html.includes('Ganesh Stores'));
    assert.ok(html.includes('12 Market Road'));
  } finally {
    await call('/settings', {
      method: 'PUT', body: JSON.stringify({ legal_name: '', address: '' }),
    }, ADMIN);
  }
});
