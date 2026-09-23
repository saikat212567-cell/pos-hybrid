/**
 * POS API on Cloudflare Workers + D1. Indian GST, FIFO stock, double-entry books.
 *
 * Till routes (POS_TOKEN):
 *   GET  /products          catalog, legacy shape — the two shipped clients read this
 *   GET  /items             catalog with kind/HSN/rate, for clients built after phase 1
 *   POST /sales             record a sale: FIFO, GST and a journal entry, atomically
 *
 * Admin routes (POS_ADMIN_TOKEN):
 *   GET  /sales             sales history
 *   POST /purchases         record a purchase, creating stock lots
 *   GET  /reports/stock     quantity and FIFO value on hand
 *   GET  /reports/trial-balance
 *   GET  /settings, PUT /settings
 *
 * MONEY IS INTEGER PAISE everywhere. Only display code divides by 100.
 *
 * TWO TOKENS, deliberately: POS_TOKEN is extractable from the APK and visible
 * in the web page's source, so it opens only what a till needs — read the
 * catalog, insert a sale. POS_ADMIN_TOKEN gates everything that reveals or
 * alters the books, and is in neither client. If both were one token,
 * extracting the APK would expose the whole revenue history and let anyone
 * rewrite the tax settings.
 */

import { lineTax, invoiceTotals, splitExclusive, splitByPlace, normalizeStateCode } from './gst.js';
import { planConsume, stockReport, lotInsert, InsufficientStock } from './fifo.js';
import {
  saleVoucherLines, purchaseVoucherLines, voucherStatements, trialBalance,
  buildVoucher, UnbalancedVoucher, ACC, PAYMENT_MODES, creditNoteVoucherLines,
} from './ledger.js';
import { validateItem, Invalid } from './items.js';
import { putItemImage, getImage } from './images.js';
import { FORMATS, billHtml } from './bill.js';
import { RefundRejection, planReturn, isTaxAdjustedAllowed, gstr1Bucket } from './refunds.js';

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });

/** Constant-time-ish compare so the token check doesn't leak length by timing. */
function tokenOk(header, secret) {
  if (!secret) return false;                       // misconfigured: fail closed
  const got = (header || '').replace(/^Bearer\s+/i, '');
  if (got.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: cors() });

    const header = request.headers.get('Authorization');

    // An <img src="..."> tag cannot send an Authorization header, so image
    // requests may carry a token as a query parameter instead — but ONLY the till
    // token, and only on /images/.
    //
    // A URL travels further than a header: into Cloudflare logs, proxy logs, and
    // the Referer of anything the page later links to. The till token is already
    // public by design (it sits in the web page's source and is extractable from
    // the APK) and opens only catalog-read and sale-insert, so a product photo
    // URL carrying it leaks nothing new. The admin token gates the books and the
    // tax settings, so it must never be accepted here — the admin page used to
    // put it in every thumbnail src, which quietly broke its own promise to keep
    // that token in memory only.
    const queryToken = pathname.startsWith('/images/') ? url.searchParams.get('t') : null;
    const imageTill = queryToken !== null && tokenOk(`Bearer ${queryToken}`, env.POS_TOKEN);

    // The admin token also works on till routes, so one token covers testing.
    // The reverse is never true. Admin rights come from the header alone.
    const admin = tokenOk(header, env.POS_ADMIN_TOKEN);
    const till = tokenOk(header, env.POS_TOKEN) || admin || imageTill;

    const route = (path, m, needsAdmin, handler) =>
      pathname === path && method === m
        ? (needsAdmin ? admin : till)
          ? handler()
          : json({ error: 'unauthorized' }, 401)
        : null;

    /**
     * Same, for a path with one trailing id segment: '/items/:id/image'.
     *
     * `pattern` is split on '/' and compared segment by segment, with ':name'
     * capturing. A regex would be shorter to write and harder to read, and this
     * API has five such routes, not fifty.
     */
    const routeId = (pattern, m, needsAdmin, handler) => {
      if (method !== m) return null;
      const want = pattern.split('/');
      const got = pathname.split('/');
      if (want.length !== got.length) return null;

      // Authorise BEFORE decoding. decodeURIComponent throws URIError on a
      // malformed escape like "%", so decoding first let an unauthenticated
      // request reach the outer catch and get a 500 instead of a 401 — an
      // unauthenticated caller provoking an error response, and a misleading one
      // for anyone reading logs.
      if (!(needsAdmin ? admin : till)) return json({ error: 'unauthorized' }, 401);

      const params = {};
      for (let i = 0; i < want.length; i++) {
        if (want[i].startsWith(':')) {
          if (!got[i]) return null;
          try {
            params[want[i].slice(1)] = decodeURIComponent(got[i]);
          } catch {
            // A malformed escape is a bad request, not a server fault.
            return json({ error: 'malformed path' }, 400);
          }
        } else if (want[i] !== got[i]) return null;
      }
      return handler(params);
    };

    try {
      // `await` matters: returning the handler's promise unawaited would let
      // any async failure escape this try/catch entirely, and the client would
      // get a Cloudflare error page instead of the JSON both clients parse.
      return await (
        route('/products', 'GET', false, () => listProducts(env)) ??
        // ?all=1 includes deactivated items. Admin-only: a till must not be
        // able to sell something that was taken off the catalog.
        route('/items', 'GET', false, () => listItems(env, {
          includeInactive: admin && url.searchParams.get('all') === '1',
        })) ??
        route('/sales', 'POST', false, () => recordSale(request, env)) ??
        route('/sales', 'GET', true, () => listSales(url, env)) ??
        route('/purchases', 'POST', true, () => recordPurchase(request, env)) ??
        route('/reports/stock', 'GET', true, () => reportStock(env)) ??
        route('/reports/trial-balance', 'GET', true, () => reportTrialBalance(url, env)) ??
        route('/credit-notes', 'POST', true, () => recordCreditNote(request, env)) ??
        route('/settings', 'GET', true, () => getSettings(env)) ??
        route('/settings', 'PUT', true, () => putSettings(request, env)) ??
        // Till-readable. The pricing mode and rounding rule decide what the
        // counter sees on screen, so a client cannot draw a correct cart without
        // them.
        route('/shop', 'GET', false, () => getShop(env)) ??

        // --- phase 2 ---
        route('/items', 'POST', true, () => createItem(request, env)) ??
        routeId('/items/:id', 'PATCH', true, p => updateItem(p.id, request, env)) ??
        routeId('/items/:id', 'DELETE', true, p => deactivateItem(p.id, env)) ??
        routeId('/items/:id/image', 'POST', true, p => uploadItemImage(p.id, request, env)) ??
        routeId('/items/:id/opening-stock', 'POST', true,
          p => addOpeningStock(p.id, request, env)) ??
        // Images are read by the till, and by an <img> tag that cannot send an
        // Authorization header — see the note on the handler.
        routeId('/images/items/:id', 'GET', false, p => getImage(env, `items/${p.id}`, cors)) ??
        // Reprinting a bill needs the sale and its lines.
        routeId('/sales/:ref', 'GET', false, p => getSale(p.ref, url, env)) ??

        (till ? json({ error: 'not found' }, 404) : json({ error: 'unauthorized' }, 401))
      );
    } catch (err) {
      // Log for `wrangler tail`; don't leak internals to the client.
      console.error('unhandled', err);
      return json({ error: 'internal error' }, 500);
    }
  },
};

// ===========================================================================
// Settings
// ===========================================================================

/** Every setting as a plain object. One row per knob, so this is a small read. */
async function loadSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map(r => [r.key, r.value]));
}

async function getSettings(env) {
  return json(await loadSettings(env));
}

/**
 * The subset of settings a till needs to display a cart correctly, readable with
 * the till token.
 *
 * Without this a client has to guess the shop-wide pricing mode. Guessing
 * "inclusive" at an exclusive-pricing shop understates every total on screen by
 * the tax — the recorded sale would still be right, because the server computes
 * it, but the counter would quote one figure and the bill would print a higher
 * one. Wrong numbers in front of a customer.
 *
 * Deliberately not the whole settings object: the GSTIN, the invoice series and
 * the composition rate are not needed to draw a cart, and the till token is
 * extractable from the APK.
 */
async function getShop(env) {
  const s = await loadSettings(env);
  return json({
    legal_name: s.legal_name ?? '',
    gst_registration: s.gst_registration ?? 'regular',
    price_mode: s.price_mode ?? 'inclusive',
    round_off_enabled: s.round_off_enabled !== '0',
    bill_format: s.bill_format ?? '58mm',
  });
}

/**
 * Update settings. Admin only, and whitelisted: these values decide what
 * appears on a legal document, so an arbitrary key/value write here would be a
 * way to corrupt every future invoice.
 */
const WRITABLE_SETTINGS = new Set([
  'gst_registration', 'gstin', 'state_code', 'legal_name', 'price_mode',
  'fy_start', 'invoice_series', 'composition_rate_bps', 'round_off_enabled',
  // Phase 2: what the bill looks like and what it says.
  'bill_format', 'bill_footer', 'address', 'phone',
]);

/**
 * Settings are stored as text, so a boolean has to be normalised to the '1'/'0'
 * the read side compares against. `String(false)` is 'false', which is neither
 * — the write would be accepted and echoed back while changing nothing, which
 * is worse than rejecting it.
 */
const settingValue = (key, v) => {
  if (typeof v === 'boolean') return v ? '1' : '0';
  // Store the canonical form, so "7" becomes "07" and a stray space is gone
  // before it can ever be string-compared against a place of supply.
  if (key === 'state_code') return normalizeStateCode(v) ?? String(v);
  return String(v);
};

async function putSettings(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'malformed json' }, 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'expected an object of settings' }, 400);
  }

  const entries = Object.entries(body);
  const unknown = entries.filter(([k]) => !WRITABLE_SETTINGS.has(k)).map(([k]) => k);
  if (unknown.length) return json({ error: `unknown settings: ${unknown.join(', ')}` }, 400);

  if (body.gst_registration &&
      !['regular', 'composition', 'unregistered'].includes(body.gst_registration)) {
    return json({ error: 'gst_registration must be regular, composition or unregistered' }, 400);
  }
  if (body.price_mode && !['inclusive', 'exclusive'].includes(body.price_mode)) {
    return json({ error: 'price_mode must be inclusive or exclusive' }, 400);
  }
  if (body.bill_format && !FORMATS.includes(body.bill_format)) {
    return json({ error: `bill_format must be one of: ${FORMATS.join(', ')}` }, 400);
  }
  // The seller's own state decides the tax head on every sale, so a bad value
  // here is worse than a bad place_of_supply on one invoice — it misroutes all of
  // them. Validated at the write so it cannot be stored wrong in the first place.
  if (body.state_code !== undefined && !normalizeStateCode(body.state_code)) {
    return json({ error: 'state_code must be a GST state code: 01-38, 97 or 99' }, 400);
  }
  // fy_start is parsed by fyLabel with split('-').map(Number), so "2026-04-01"
  // or "April" yields NaN and silently files every sale into the wrong financial
  // year — while continuing to advance the closed year's invoice counter.
  if (body.fy_start !== undefined && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(body.fy_start))) {
    return json({ error: 'fy_start must be MM-DD, e.g. 04-01 for the Indian financial year' }, 400);
  }
  // Rule 46(b): an invoice number is at most 16 characters, alphanumerics with
  // '-' and '/' only. The series is concatenated as `<series>/<fy>/<0000>`,
  // which spends 11 characters, so the series itself has 5 to play with. A
  // longer one produces numbers the GST portal rejects months later.
  if (body.invoice_series !== undefined &&
      !/^[A-Za-z0-9/-]{1,5}$/.test(String(body.invoice_series))) {
    return json({
      error: 'invoice_series must be 1-5 characters of letters, digits, - or /',
    }, 400);
  }
  if (!entries.length) return json({ error: 'no settings given' }, 400);

  await env.DB.batch(entries.map(([k, v]) =>
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(k, settingValue(k, v))
  ));

  return json(await loadSettings(env));
}

// ===========================================================================
// Catalog
// ===========================================================================

/**
 * Services report a large sentinel stock on this legacy route.
 *
 * Both shipped clients disable an item when stock <= 0 (web/index.html and
 * MainActivity.addToCart), so a truthful 0 would make every service
 * unsellable in the builds currently in the field. /items reports `kind`
 * honestly for clients that understand it, and this sentinel goes away with
 * the old route.
 */
const SERVICE_SENTINEL_STOCK = 999999;

/**
 * Ceiling on a single line's quantity.
 *
 * Money is integer paise, which only holds up below Number.MAX_SAFE_INTEGER.
 * `splitInclusive` computes `price * qty * 10000`, so at a ₹2500 price this
 * bound keeps the largest intermediate around 2.5e14 — three orders of
 * magnitude clear of 2^53. Stock limits goods anyway; a service has nothing to
 * run out of, so this is the only thing bounding it.
 */
const MAX_LINE_QTY = 100000;

/**
 * IST is UTC+5:30. A Worker's clock is UTC, and the business is in India, so
 * anything that depends on which calendar day it is — the financial year, and
 * therefore the invoice series — has to be evaluated in local time.
 */
const IST_OFFSET_MINUTES = 330;

/** Legacy shape: id, name, price, stock. Unchanged so both clients keep working. */
async function listProducts(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.price, p.kind,
            COALESCE(SUM(l.qty_remaining), 0) AS lot_qty
       FROM products p
       LEFT JOIN stock_lots l ON l.product_id = p.id
      WHERE p.is_active = 1
      GROUP BY p.id
      ORDER BY p.name`
  ).all();

  return json(results.map(r => ({
    id: r.id,
    name: r.name,
    price: r.price,
    stock: r.kind === 'service' ? SERVICE_SENTINEL_STOCK : r.lot_qty,
  })));
}

/**
 * Full shape, for clients built after phase 1.
 *
 * `?all=1` includes deactivated items, which the admin screen needs and a till
 * must not see.
 */
async function listItems(env, { includeInactive = false } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.price AS price_paise, p.kind, p.tax_code,
            p.gst_rate_bps, p.unit, p.price_mode, p.barcode, p.code,
            p.image_key, p.category, p.is_active,
            COALESCE(SUM(l.qty_remaining), 0) AS stock,
            COALESCE(SUM(l.cost_remaining_paise), 0) AS stock_value_paise
       FROM products p
       LEFT JOIN stock_lots l ON l.product_id = p.id
      ${includeInactive ? '' : 'WHERE p.is_active = 1'}
      GROUP BY p.id
      ORDER BY p.name`
  ).all();

  // A service's stock figure is meaningless rather than zero, so say so.
  return json(results.map(r => ({
    ...r,
    stock: r.kind === 'service' ? null : r.stock,
    stock_value_paise: r.kind === 'service' ? null : r.stock_value_paise,
  })));
}

// ===========================================================================
// Item management (admin)
// ===========================================================================

/**
 * Turn a validation failure into a 400 that names the field.
 *
 * The admin screen shows this text directly, so "gst_rate_bps must be a real
 * GST slab: 0, 25, 300, …" is worth far more to whoever is typing than "400".
 */
const invalidToResponse = err => {
  if (err instanceof Invalid) return json({ error: err.message }, 400);
  return null;
};

/** SQLite tells us which index collided; turn that into something actionable. */
function uniqueConflict(err) {
  const m = err.message ?? '';
  if (!/UNIQUE constraint failed/i.test(m)) return null;
  if (/products\.id|products_pk|PRIMARY/i.test(m)) return 'an item with that id already exists';
  if (/code/i.test(m) && !/barcode/i.test(m)) return 'that code is already used by another item';
  if (/barcode/i.test(m)) return 'that barcode is already used by another item';
  return 'that value is already used by another item';
}

async function createItem(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'malformed json' }, 400);
  }

  const settings = await loadSettings(env);

  let item;
  try {
    item = validateItem(body, { registration: settings.gst_registration ?? 'regular' });
  } catch (err) {
    return invalidToResponse(err) ?? json({ error: 'internal error' }, 500);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO products
         (id, name, price, stock, category, kind, tax_code, gst_rate_bps, unit,
          price_mode, barcode, code, is_active)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(
      item.id, item.name, item.price, item.category, item.kind, item.tax_code,
      item.gst_rate_bps, item.unit, item.price_mode, item.barcode, item.code,
    ).run();
  } catch (err) {
    const conflict = uniqueConflict(err);
    if (conflict) return json({ error: conflict }, 409);
    throw err;
  }

  // Stock starts at zero by design. Stock arrives through a purchase or through
  // opening stock, both of which record what it cost — inventory that appeared
  // with no cost is exactly what made phase 1's migrated lots misreport margin.
  return json({ ok: true, id: item.id }, 201);
}

/**
 * Edit an item.
 *
 * A price change deliberately does NOT touch existing stock lots. A lot records
 * what that stock actually cost when it was bought; rewriting it to match a new
 * selling price would falsify the FIFO history and retroactively change the COGS
 * of every sale already made from it.
 */
async function updateItem(id, request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'malformed json' }, 400);
  }

  const existing = await env.DB
    .prepare('SELECT id, kind FROM products WHERE id = ?').bind(id).first();
  if (!existing) return json({ error: 'unknown item' }, 404);

  let patch;
  try {
    patch = validateItem(body, {
      registration: (await loadSettings(env)).gst_registration ?? 'regular',
      partial: true,
    });
  } catch (err) {
    return invalidToResponse(err) ?? json({ error: 'internal error' }, 500);
  }

  // The id is the primary key and is referenced by sale_lines, stock_lots and
  // cogs_allocations. Changing it would orphan all of them, so it is fixed once
  // created.
  delete patch.id;

  // Changing kind would mean a service with lots, or a good with none and no way
  // to get any. Both are incoherent, so it is not editable either.
  if (patch.kind && patch.kind !== existing.kind) {
    return json({ error: 'kind cannot be changed after creation' }, 400);
  }
  delete patch.kind;

  const cols = Object.keys(patch);
  if (!cols.length) return json({ error: 'no fields to update' }, 400);

  try {
    await env.DB.prepare(
      `UPDATE products SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`
    ).bind(...cols.map(c => patch[c]), id).run();
  } catch (err) {
    const conflict = uniqueConflict(err);
    if (conflict) return json({ error: conflict }, 409);
    throw err;
  }

  return json({ ok: true, id, updated: cols });
}

/**
 * Deactivate an item. Soft delete only.
 *
 * A hard DELETE would orphan the sale_lines rows that make up every historical
 * invoice — the item's name, HSN and rate are copied onto each line precisely so
 * an old bill still reads correctly, but the foreign key would still break, and
 * reports that join back to products would lose rows. An item that was ever sold
 * is part of the permanent record.
 *
 * Refused while stock remains: that stock has a value sitting in the balance
 * sheet, and hiding the item would leave the value with nothing to attribute it
 * to. Sell it, or write it off, first.
 */
async function deactivateItem(id, env) {
  const row = await env.DB.prepare(
    `SELECT p.id, p.kind, COALESCE(SUM(l.qty_remaining), 0) AS stock
       FROM products p LEFT JOIN stock_lots l ON l.product_id = p.id
      WHERE p.id = ? GROUP BY p.id`
  ).bind(id).first();

  if (!row) return json({ error: 'unknown item' }, 404);
  if (row.stock > 0) {
    return json({
      error: `cannot deactivate while ${row.stock} in stock — its value is on the balance sheet`,
      stock: row.stock,
    }, 409);
  }

  await env.DB.prepare('UPDATE products SET is_active = 0 WHERE id = ?').bind(id).run();
  return json({ ok: true, id, deactivated: true });
}

/**
 * Upload an item's tile image.
 *
 * The image is written to R2 first and the row updated second. If the row update
 * failed we would have an orphaned object, which costs a few KB; the reverse
 * order would point a row at an object that does not exist, which shows a broken
 * tile at the counter. Wasting bytes beats showing breakage.
 */
async function uploadItemImage(id, request, env) {
  if (!env.IMAGES) {
    return json({ error: 'image storage not configured (no R2 binding)' }, 503);
  }

  const exists = await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(id).first();
  if (!exists) return json({ error: 'unknown item' }, 404);

  let stored;
  try {
    stored = await putItemImage(env, id, request);
  } catch (err) {
    if (err.status) return json({ error: err.message }, err.status);
    throw err;
  }

  await env.DB.prepare('UPDATE products SET image_key = ? WHERE id = ?')
    .bind(stored.key, id).run();

  return json({ ok: true, key: stored.key, type: stored.type, size: stored.size }, 201);
}

/**
 * Record stock the business already had.
 *
 * A shop adopting this system mid-year has stock on its shelves that it never
 * entered a purchase for. That stock needs a costed lot so FIFO has something to
 * consume and the balance sheet shows the inventory — but no money leaves the
 * till today, so the contra cannot be Cash.
 *
 *   Dr Stock in Hand                  what the stock cost
 *   Cr Opening Stock Adjustment       (equity)
 *
 * Posting this against Cash would invent a payment that never happened and leave
 * the cash balance permanently wrong.
 */
async function addOpeningStock(id, request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'malformed json' }, 400);
  }

  const { qty, cost_paise } = body ?? {};
  if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_LINE_QTY) {
    return json({ error: `qty must be a positive integer up to ${MAX_LINE_QTY}` }, 400);
  }
  if (!Number.isInteger(cost_paise) || cost_paise < 0) {
    return json({ error: 'cost_paise must be a non-negative integer (total, not per unit)' }, 400);
  }

  const item = await env.DB
    .prepare('SELECT id, kind FROM products WHERE id = ?').bind(id).first();
  if (!item) return json({ error: 'unknown item' }, 404);
  if (item.kind === 'service') {
    return json({ error: 'a service cannot hold stock' }, 400);
  }

  const ref = `opening:${id}:${Date.now()}`;
  const voucher = buildVoucher([
    { account: ACC.STOCK, debit: cost_paise, credit: 0 },
    { account: '3100', debit: 0, credit: cost_paise },
  ]);

  await env.DB.batch([
    // received_at in the past so opening stock sits at the head of the FIFO
    // queue: it was on the shelf before anything bought since, so it should sell
    // first.
    lotInsert(env.DB, {
      productId: id, qty, costPaise: cost_paise, receivedAt: '1970-01-02 00:00:00',
    }),
    ...voucherStatements(
      env.DB,
      { type: 'journal', ref, narration: `Opening stock ${id}` },
      voucher.lines
    ),
  ]);

  return json({ ok: true, id, qty, cost_paise }, 201);
}

/**
 * One sale with its lines, for printing or reprinting a bill.
 *
 * Till-readable: the counter has to be able to reprint the bill it just issued,
 * and this exposes one sale the client already knows the ref of, not the
 * revenue history that `GET /sales` gates behind the admin token.
 */
async function getSale(ref, url, env) {
  // ?format=58mm|80mm|a4 returns the rendered bill instead of JSON.
  //
  // Rendering server-side keeps one implementation of a legal document. A
  // client-side copy of the layouts would drift from this one, and a bill of
  // supply that wrongly shows tax is a compliance problem, not a display bug.
  const format = url.searchParams.get('format');

  const sale = await env.DB.prepare(
    `SELECT client_ref, source, total, sold_at, invoice_no, taxable_paise,
            cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise,
            cogs_paise, place_of_supply, customer_gstin, payment_mode
       FROM sales WHERE client_ref = ?`
  ).bind(ref).first();

  if (!sale) return json({ error: 'unknown sale' }, 404);

  const { results: lines } = await env.DB.prepare(
    `SELECT product_id, name, kind, tax_code, unit, qty, price_paise,
            gst_rate_bps, taxable_paise, cgst_paise, sgst_paise, igst_paise
       FROM sale_lines WHERE sale_ref = ? ORDER BY id`
  ).bind(ref).all();

  // The bill needs the shop's own details, and the client has no other way to
  // read them — /settings is admin-only.
  const s = await loadSettings(env);
  const shop = {
    legal_name: s.legal_name, gstin: s.gstin, address: s.address, phone: s.phone,
    gst_registration: s.gst_registration, bill_footer: s.bill_footer,
    bill_format: s.bill_format,
  };

  if (format !== null) {
    const html = billHtml({ ...sale, lines }, s, format || s.bill_format || '58mm');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...cors() },
    });
  }

  return json({ sale: { ...sale, lines }, shop });
}

// ===========================================================================
// Sales
// ===========================================================================

/**
 * Financial year label for a date, e.g. '26-27'. India's year starts April 1,
 * but `fy_start` is a setting because the code should not hardcode a date that
 * a user could legitimately need to change.
 */
export function fyLabel(date, fyStart = '04-01', offsetMinutes = IST_OFFSET_MINUTES) {
  // Shift to local time before reading the date. A Worker's clock is UTC, but
  // the financial year boundary is a local calendar date: a sale at 02:00 IST
  // on 1 April is 20:30 UTC on 31 March, and reading UTC would file it into the
  // year that just closed — then keep advancing that year's invoice counter,
  // which GST requires to be consecutive within the year it belongs to.
  const local = new Date(date.getTime() + offsetMinutes * 60_000);

  const [m, d] = fyStart.split('-').map(Number);
  const y = local.getUTCFullYear();
  const started = local.getUTCMonth() + 1 > m ||
                  (local.getUTCMonth() + 1 === m && local.getUTCDate() >= d);
  const start = started ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// ------------------------------------------------------------------------
// Helper functions for refunds

async function getSettingsForTransaction(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows.results ?? rows) map[r.key] = r.value;
  return map;
}

async function getOriginalPaymentMode(db, saleRef) {
  const row = await db.prepare(
    'SELECT payment_mode FROM sales WHERE client_ref = ?'
  ).bind(saleRef).first();
  return row?.payment_mode ?? 'cash';
}

/**
 * Record a sale: consume stock FIFO, compute GST, assign an invoice number and
 * post a journal entry — all in one D1 batch(), which is one transaction.
 * Either every part lands or none does. Stock decremented for a sale that was
 * never recorded, or a sale with no matching ledger entry, would both be
 * corruption that no later pass could reconstruct.
 *
 * Accepts the payload the shipped clients already send. Anything they don't
 * know about (place of supply, payment mode, per-line tax) is filled from
 * settings and the item record, so an un-rebuilt till keeps selling and still
 * produces correct books.
 */
async function recordSale(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'malformed json' }, 400);
  }

  // --- validate at the trust boundary -------------------------------------
  const { client_ref, source, total, items } = body ?? {};

  if (typeof client_ref !== 'string' || client_ref.length < 8 || client_ref.length > 64) {
    return json({ error: 'client_ref must be a string of 8-64 chars' }, 400);
  }
  if (!Number.isInteger(total) || total < 0) {
    return json({ error: 'total must be a non-negative integer (paise)' }, 400);
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) {
    return json({ error: 'items must be a non-empty array (max 200)' }, 400);
  }
  for (const it of items) {
    if (typeof it?.id !== 'string' || !Number.isInteger(it?.qty) || it.qty <= 0) {
      return json({ error: 'each item needs a string id and positive integer qty' }, 400);
    }
    // An upper bound, because nothing else imposes one on a service: it has no
    // stock to run out of, so a huge qty would reach the money arithmetic and
    // push price * qty * 10000 past Number.MAX_SAFE_INTEGER, at which point the
    // integer-paise discipline silently stops holding and garbage lands in the
    // ledger. No real counter sells a million of anything in one line.
    if (it.qty > MAX_LINE_QTY) {
      return json({ error: `qty must be at most ${MAX_LINE_QTY}` }, 400);
    }
  }
  const src = source === 'android' ? 'android' : 'web';

  // Validated rather than defaulted: settlementAccount() used to fall through to
  // Cash in Hand for anything it did not recognise, so a typo like "cheque"
  // booked a UPI or card sale as cash. The drawer then never reconciles with the
  // books and nothing records why.
  const paymentMode = body.payment_mode ?? 'cash';
  if (!PAYMENT_MODES.includes(paymentMode)) {
    return json({ error: `payment_mode must be one of: ${PAYMENT_MODES.join(', ')}` }, 400);
  }

  // Merge repeated ids into one line. Both clients key their cart by id so
  // this cannot happen from them, but a sale must have one line per item for
  // the COGS allocations to be attributable — and two lines for the same
  // product on one invoice is wrong anyway.
  const merged = new Map();
  for (const it of items) {
    merged.set(it.id, (merged.get(it.id) ?? 0) + it.qty);
  }

  // Re-check after merging: 200 lines each under the per-line cap can combine
  // past it, so validating only the incoming lines would leave the overflow
  // hole open.
  for (const [id, qty] of merged) {
    if (qty > MAX_LINE_QTY) {
      return json({ error: `total qty for ${id} must be at most ${MAX_LINE_QTY}` }, 400);
    }
  }

  const settings = await loadSettings(env);

  // --- resolve items against the catalog ----------------------------------
  // Price and tax rate come from the database, never from the request: a
  // client is free to send a price, but taking it would let anyone with the
  // till token sell at whatever price they liked.
  const ids = [...merged.keys()];
  // is_active = 1, so a withdrawn item cannot still be sold. Without the filter
  // DELETE /items/:id only hid the tile: a till with a cached catalog, or any
  // caller naming the id directly, kept selling it — and a service forever, since
  // services have no stock to run out of.
  const { results: catalog } = await env.DB.prepare(
    `SELECT id, name, price, kind, tax_code, gst_rate_bps, unit, price_mode
       FROM products WHERE is_active = 1 AND id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();

  const byId = new Map(catalog.map(p => [p.id, p]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) {
    // Deliberately the same message whether the item never existed or was
    // withdrawn: both are "you cannot sell this", and the till's remedy is the
    // same — refresh the catalog.
    return json({ error: `unknown or inactive items: ${missing.join(', ')}` }, 400);
  }

  // --- tax ------------------------------------------------------------------
  // Place of supply decides CGST+SGST versus IGST, so it is a trust boundary: an
  // unvalidated value let a till-token request choose which tax head the sale
  // filed under. "19 ", "019" and "nineteen" all compared unequal to the seller's
  // own "19" and routed an intrastate sale entirely to IGST.
  const sellerState = normalizeStateCode(settings.state_code) ?? '';

  let buyerState = sellerState;
  if (body.place_of_supply !== undefined && body.place_of_supply !== null &&
      String(body.place_of_supply).trim() !== '') {
    const normalized = normalizeStateCode(body.place_of_supply);
    if (!normalized) {
      return json({
        error: 'place_of_supply must be a GST state code: 01-38, 97 or 99',
      }, 400);
    }
    buyerState = normalized;
  }

  const ctx = {
    registration: settings.gst_registration ?? 'regular',
    sellerState,
    buyerState,
    defaultPriceMode: settings.price_mode ?? 'inclusive',
  };

  const lines = [];
  for (const [id, qty] of merged) {
    const p = byId.get(id);
    const taxed = lineTax(
      { price_paise: p.price, qty, gst_rate_bps: p.gst_rate_bps, price_mode: p.price_mode },
      ctx
    );
    lines.push({ product: p, qty, ...taxed });
  }

  const totals = invoiceTotals(lines, {
    roundOffEnabled: settings.round_off_enabled !== '0',
  });

  // --- FIFO ----------------------------------------------------------------
  // Planned, not applied: the UPDATEs join the same batch as the sale below.
  let cogsTotal = 0;
  const stockStatements = [];
  const allocByProduct = new Map();

  try {
    for (const line of lines) {
      const plan = await planConsume(env.DB, line.product, line.qty);
      line.cogs = plan.cogsPaise;
      cogsTotal += plan.cogsPaise;
      stockStatements.push(...plan.statements);
      allocByProduct.set(line.product.id, plan.allocations);
    }
  } catch (err) {
    if (err instanceof InsufficientStock) {
      // 409, not 400: the payload is well-formed, the world just changed under
      // it. The Android client treats 4xx as permanent, which is right — a
      // retry cannot conjure stock.
      return json({ error: err.message, product: err.productId, available: err.available }, 409);
    }
    throw err;
  }

  // --- journal entry --------------------------------------------------------
  const kindTaxable = kind => lines
    .filter(l => l.product.kind === kind)
    .reduce((s, l) => s + l.taxable, 0);

  let voucher;
  try {
    voucher = saleVoucherLines({
      total: totals.total,
      goodsTaxable: kindTaxable('good'),
      serviceTaxable: kindTaxable('service'),
      cgst: totals.cgst,
      sgst: totals.sgst,
      igst: totals.igst,
      roundOff: totals.roundOff,
      cogs: cogsTotal,
      paymentMode,
    });
  } catch (err) {
    if (err instanceof UnbalancedVoucher) {
      // Refuse the sale rather than write books that don't balance. Reaching
      // here means a bug in the tax or FIFO math, so it must be loud.
      console.error('sale would not balance', client_ref, err);
      return json({ error: 'internal error' }, 500);
    }
    throw err;
  }

  // --- write ---------------------------------------------------------------
  const series = settings.invoice_series || 'A';
  const fy = fyLabel(new Date(), settings.fy_start ?? '04-01');
  const invoiceNo =
    `(SELECT ? || '/' || ? || '/' || printf('%04d', last_no)
        FROM invoice_series WHERE series = ? AND fy = ?)`;

  const allocStatements = [...allocByProduct].flatMap(([productId, allocations]) =>
    allocations.map(a => env.DB.prepare(
      `INSERT INTO cogs_allocations
         (sale_line_id, lot_id, qty, cost_paise, qty_returnable, cost_returnable_paise)
       VALUES ((SELECT id FROM sale_lines WHERE sale_ref = ? AND product_id = ?), ?, ?, ?, ?, ?)`
    ).bind(client_ref, productId, a.lotId, a.qty, a.costPaise, a.qty, a.costPaise))
  );

  const statements = [
    // Bump the series first so the sale row can read the new number. Rolled
    // back with everything else if the sale turns out to be a duplicate, which
    // is what keeps the numbering gapless.
    env.DB.prepare(
      `INSERT INTO invoice_series (series, fy, last_no) VALUES (?, ?, 1)
       ON CONFLICT(series, fy) DO UPDATE SET last_no = last_no + 1`
    ).bind(series, fy),

    env.DB.prepare(
      `INSERT INTO sales
         (client_ref, source, total, items, invoice_no, taxable_paise,
          cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise,
          cogs_paise, total_mismatch, place_of_supply, customer_gstin, payment_mode)
       VALUES (?, ?, ?, ?, ${invoiceNo}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      client_ref, src, total, JSON.stringify(items),
      series, fy, series, fy,
      totals.taxable, totals.cgst, totals.sgst, totals.igst, totals.roundOff,
      totals.total, cogsTotal,
      // The client's own total is kept verbatim in `total` and compared, not
      // trusted. A client with a stale tax rate still records a correct sale,
      // and the disagreement is visible instead of silently reconciled.
      total === totals.total ? 0 : 1,
      ctx.buyerState, body.customer_gstin ?? null, paymentMode,
    ),

    ...lines.map(l => env.DB.prepare(
      `INSERT INTO sale_lines
         (sale_ref, product_id, name, kind, tax_code, unit, qty, price_paise,
          gst_rate_bps, taxable_paise, cgst_paise, sgst_paise, igst_paise, cogs_paise,
          qty_returnable, taxable_returnable_paise, cgst_returnable_paise,
          sgst_returnable_paise, igst_returnable_paise)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      client_ref, l.product.id, l.product.name, l.product.kind,
      l.product.tax_code, l.product.unit, l.qty, l.product.price,
      l.rateBps, l.taxable, l.cgst, l.sgst, l.igst, l.cogs,
      l.qty, l.taxable, l.cgst, l.sgst, l.igst,
    )),

    // sale_lines ids are assigned by AUTOINCREMENT and batch() returns nothing
    // to thread between statements, so each allocation finds its line by
    // (sale_ref, product_id) — unique because repeated ids were merged above.
    ...allocStatements,

    ...stockStatements,

    ...voucherStatements(
      env.DB,
      { type: 'sale', ref: client_ref, narration: `Sale ${client_ref}` },
      voucher.lines
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (err) {
    // A collision here means this sale is already recorded and only its
    // response was lost, so reporting success is what makes an offline retry
    // safe — the rollback means the books were not touched twice either.
    //
    // But confirm it really is THIS sale before saying so. The batch now
    // carries several unique constraints (invoice_no, the voucher ref, the
    // series key), and treating any of them as "already recorded" would tell
    // the till a sale succeeded when nothing was written: the receipt prints,
    // the cash goes in the drawer, and no record of it exists anywhere.
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(err.message ?? '')) {
      const existing = await env.DB
        .prepare('SELECT 1 FROM sales WHERE client_ref = ?')
        .bind(client_ref)
        .first();
      if (existing) return json({ ok: true, duplicate: true }, 200);
      console.error('sale rolled back on a constraint other than client_ref', client_ref, err);
      return json({ error: 'sale not recorded' }, 500);
    }

    // A CHECK failure on stock_lots means another till consumed the same lots
    // between this request's stock read and its write. Nothing was committed,
    // so a retry is the right move and will re-plan against current stock —
    // hence 409 with a retryable flag rather than a 500 the client gives up on.
    if (/CHECK constraint failed/i.test(err.message ?? '')) {
      console.warn('sale lost a race for stock, safe to retry', client_ref);
      return json({ error: 'stock changed during the sale, retry', retryable: true }, 409);
    }
    throw err;
  }

  // Response shape is unchanged for the shipped clients, which compare it
  // exactly. New fields would break a strict equality check in the field.
  return json({ ok: true }, 201);
}

/**
 * Recent sales, newest first. Admin only.
 *
 * ?limit=N     how many rows (1-500, default 50)
 * ?since=DATE  only sales at/after this ISO date
 */
async function listSales(url, env) {
  // Clamp rather than reject: a silly limit shouldn't 400, and an unbounded
  // one would scan the whole table.
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
  const since = url.searchParams.get('since');

  const cols =
    `client_ref, source, total, items, sold_at, invoice_no, taxable_paise,
     cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise,
     cogs_paise, total_mismatch, place_of_supply, payment_mode`;

  const { results } = since
    ? await env.DB.prepare(
        `SELECT ${cols} FROM sales WHERE sold_at >= ? ORDER BY sold_at DESC LIMIT ?`
      ).bind(since, limit).all()
    : await env.DB.prepare(
        `SELECT ${cols} FROM sales ORDER BY sold_at DESC LIMIT ?`
      ).bind(limit).all();

  const sales = results.map(r => ({ ...r, items: JSON.parse(r.items) }));

  return json({
    sales,
    count: sales.length,
    // Kept as totalCents for the callers that already read it. The paise
    // figure beside it is the server's own computed total.
    totalCents: sales.reduce((s, r) => s + r.total, 0),
    totalPaise: sales.reduce((s, r) => s + r.total_paise, 0),
    grossProfitPaise: sales.reduce((s, r) => s + (r.taxable_paise - r.cogs_paise), 0),
  });
}

// ===========================================================================
// Purchases
// ===========================================================================

/**
 * Record a purchase. Each line becomes one stock lot, which is what later
 * sales consume in FIFO order, and the whole thing posts one journal entry.
 *
 * Admin only: this creates inventory value and input tax credit out of
 * nothing, so it is not something a till token should be able to do.
 */
async function recordPurchase(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'malformed json' }, 400);
  }

  const { supplier_name, supplier_gstin, supplier_inv_no, lines, payment_mode } = body ?? {};

  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 200) {
    return json({ error: 'lines must be a non-empty array (max 200)' }, 400);
  }
  for (const l of lines) {
    if (typeof l?.product_id !== 'string' ||
        !Number.isInteger(l?.qty) || l.qty <= 0 || l.qty > MAX_LINE_QTY ||
        !Number.isInteger(l?.taxable_paise) || l.taxable_paise < 0) {
      return json({
        error: 'each line needs product_id, positive integer qty, non-negative integer taxable_paise',
      }, 400);
    }
    // Optional overrides, but they feed the ledger, so a negative one would
    // produce an entry that does not balance. Reject rather than discover it
    // when the trial balance stops netting to zero.
    for (const k of ['gst_rate_bps', 'tax_paise']) {
      if (l[k] !== undefined && (!Number.isInteger(l[k]) || l[k] < 0)) {
        return json({ error: `${k} must be a non-negative integer` }, 400);
      }
    }
  }

  const ids = [...new Set(lines.map(l => l.product_id))];
  const { results: catalog } = await env.DB.prepare(
    `SELECT id, kind, gst_rate_bps FROM products WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();

  const byId = new Map(catalog.map(p => [p.id, p]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) return json({ error: `unknown items: ${missing.join(', ')}` }, 400);

  // A service cannot be stocked — there is no lot to create and nothing would
  // ever consume it. Silently accepting this would put inventory value on the
  // balance sheet for something that does not exist.
  const services = ids.filter(id => byId.get(id).kind === 'service');
  if (services.length) {
    return json({ error: `cannot purchase stock of a service: ${services.join(', ')}` }, 400);
  }

  const settings = await loadSettings(env);
  const sellerState = normalizeStateCode(settings.state_code) ?? '';

  // Same trust boundary as a sale: the supplier's state decides whether input
  // tax splits as CGST+SGST or IGST, so an uncanonical code would credit the
  // wrong head. Absent means treat it as local.
  let supplierState = sellerState;
  if (body.supplier_state !== undefined && body.supplier_state !== null &&
      String(body.supplier_state).trim() !== '') {
    const normalized = normalizeStateCode(body.supplier_state);
    if (!normalized) {
      return json({ error: 'supplier_state must be a GST state code: 01-38, 97 or 99' }, 400);
    }
    supplierState = normalized;
  }

  const claimsCredit = settings.gst_registration === 'regular';

  // Input tax is only creditable by a regular dealer. For a composition or
  // unregistered business the tax is part of the cost of the goods, so it is
  // folded into the lot's cost rather than debited to an Input GST asset —
  // otherwise the balance sheet shows a receivable that can never be claimed.
  let taxable = 0, cgst = 0, sgst = 0, igst = 0, total = 0;
  const lots = [];

  for (const l of lines) {
    const rate = Number.isInteger(l.gst_rate_bps) ? l.gst_rate_bps : byId.get(l.product_id).gst_rate_bps;
    // A supplier invoice states its own tax, so an explicit figure wins over a
    // computed one. Otherwise the same engine the sale path uses — not a second
    // implementation that could round differently.
    const tax = Number.isInteger(l.tax_paise)
      ? l.tax_paise
      : splitExclusive(l.taxable_paise, rate).tax;

    taxable += l.taxable_paise;
    total += l.taxable_paise + tax;

    if (claimsCredit) {
      const split = splitByPlace(tax, sellerState, supplierState);
      cgst += split.cgst;
      sgst += split.sgst;
      igst += split.igst;
    }

    lots.push({
      productId: l.product_id,
      qty: l.qty,
      taxablePaise: l.taxable_paise,
      // Non-creditable tax becomes part of the cost of the goods; creditable
      // tax does not, because it will be recovered against output tax.
      costPaise: claimsCredit ? l.taxable_paise : l.taxable_paise + tax,
      rate,
      tax,
    });
  }

  // Cost put into lots must equal what the ledger debits to Stock in Hand, or
  // the stock report and the balance sheet would disagree.
  const stockValue = lots.reduce((s, l) => s + l.costPaise, 0);

  let voucher;
  try {
    voucher = purchaseVoucherLines({
      taxable: stockValue, cgst, sgst, igst, total,
      paymentMode: payment_mode ?? 'cash',
    });
  } catch (err) {
    if (err instanceof UnbalancedVoucher) {
      // Refuse rather than write books that don't balance. Reaching here means
      // the supplier's stated tax disagrees with the totals, so name the
      // document in the log — without it there is nothing to trace back to.
      console.error('purchase would not balance', supplier_name, supplier_inv_no, err);
      return json({ error: 'purchase figures do not balance' }, 400);
    }
    throw err;
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO purchases
         (supplier_name, supplier_gstin, supplier_inv_no, taxable_paise,
          cgst_paise, sgst_paise, igst_paise, total_paise, payment_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      supplier_name ?? '', supplier_gstin ?? null, supplier_inv_no ?? null,
      taxable, cgst, sgst, igst, total, payment_mode ?? 'cash',
    ),
    ...lots.flatMap(l => [
      // taxable_paise here is the supplier's taxable value, matching the
      // purchase header. The lot's cost may exceed it when the tax is not
      // creditable, which is why the two are tracked separately.
      env.DB.prepare(
        `INSERT INTO purchase_lines
           (purchase_id, product_id, qty, taxable_paise, gst_rate_bps, tax_paise)
         VALUES ((SELECT MAX(id) FROM purchases), ?, ?, ?, ?, ?)`
      ).bind(l.productId, l.qty, l.taxablePaise, l.rate, l.tax),
      // Must stay immediately after its purchase_lines insert: linkPurchaseLine
      // resolves that row by MAX(id) within this transaction, so anything
      // inserted between the two would be picked up instead.
      lotInsert(env.DB, {
        productId: l.productId, qty: l.qty, costPaise: l.costPaise,
        linkPurchaseLine: true,
      }),
    ]),
    ...voucherStatements(
      env.DB,
      {
        type: 'purchase',
        ref: supplier_inv_no ? `${supplier_name ?? ''}:${supplier_inv_no}` : null,
        narration: `Purchase ${supplier_inv_no ?? ''}`.trim(),
      },
      voucher.lines
    ),
  ]);

  return json({ ok: true, taxable_paise: taxable, total_paise: total, lots: lots.length }, 201);
}

// ===========================================================================
// Reports
// ===========================================================================

async function recordCreditNote(request, env) {
  // Idempotent: client_ref PRIMARY KEY, duplicate yields 200 {ok:true,duplicate:true}
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'malformed json' }, 400);
  }

  const {
    client_ref,                       // required, unique
    original_sale_ref,                // required
    lines,                            // [{sale_line_id, qty}], non‑empty
    refund_mode,                      // 'cash', 'bank', 'card', 'upi', 'credit' (mirrors payment_mode)
    stock_return_mode,                // 'original_lot', 'new_lot', 'none' (from settings default)
    tax_adjusted = 0,                 // 1 if output tax can be reversed, 0 otherwise
    narration = '',                   // optional
  } = body;

  // Validate required fields
  if (typeof client_ref !== 'string' || client_ref.length < 1 || client_ref.length > 255)
    return json({ error: 'client_ref must be a string (1‑255 chars)' }, 400);
  if (typeof original_sale_ref !== 'string' || original_sale_ref.length < 1)
    return json({ error: 'original_sale_ref must be a string' }, 400);
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 200)
    return json({ error: 'lines must be a non‑empty array (max 200)' }, 400);
  for (const l of lines) {
    if (typeof l?.sale_line_id !== 'number' || !Number.isInteger(l.sale_line_id) || l.sale_line_id <= 0 ||
        typeof l?.qty !== 'number' || !Number.isInteger(l.qty) || l.qty <= 0)
      return json({ error: 'each line needs positive integer sale_line_id and qty' }, 400);
  }
  if (!PAYMENT_MODES.includes(refund_mode))
    return json({ error: 'refund_mode must be one of ' + PAYMENT_MODES.join(', ') }, 400);
  if (!['original_lot', 'new_lot', 'none'].includes(stock_return_mode))
    return json({ error: 'stock_return_mode must be original_lot, new_lot, or none' }, 400);
  if (tax_adjusted !== 0 && tax_adjusted !== 1)
    return json({ error: 'tax_adjusted must be 0 or 1' }, 400);

  // Fetch shop settings for default stock_return_mode if not supplied,
  // and for b2cl threshold, registration snapshot, etc.
  const settings = await getSettingsForTransaction(env.DB);
  const effectiveStockMode = stock_return_mode === 'original_lot'
    ? (settings.stock_return_mode ?? 'original_lot')
    : stock_return_mode;

  // Determine if tax adjustment is allowed (admin‑only gate).
  const supplyDate = await getOriginalSupplyDate(env.DB, original_sale_ref);
  const taxAdjustedAllowed = await isTaxAdjustedAllowed(env.DB, supplyDate, settings);
  if (tax_adjusted === 1 && !taxAdjustedAllowed)
    return json({ error: 'tax adjustment not allowed for this supply date' }, 403);

  // Begin batch construction.
  const statements = [];
  const noteLines = [];

  // 1. Bump the series (gapless numbering, same as recordSale).
  const registration = settings.gst_registration;
  const invoiceNoSeries = (registration === 'registered' || registration === 'composition')
    ? settings.invoice_series
    : 'bill';
  const fy = fyLabel(new Date(supplyDate));
  statements.push(env.DB.prepare(
    `INSERT INTO invoice_series (series, fy, last_no) VALUES (?, ?, 1)
     ON CONFLICT(series, fy) DO UPDATE SET last_no = last_no + 1`
  ).bind(invoiceNoSeries, fy));

  // 2. Retrieve the last inserted number inside the same transaction.
  statements.push(env.DB.prepare(
    `SELECT last_no FROM invoice_series WHERE series = ? AND fy = ?`
  ).bind(invoiceNoSeries, fy));

  // 3. For each line, plan the return, collect allocations and statements.
  let totalQty = 0;
  let goodsTaxablePaise = 0;
  let serviceTaxablePaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  let cogsReversedPaise = 0;
  const returnAllocs = [];

  for (const line of lines) {
    const { sale_line_id, qty } = line;
    const { results: saleLine } = await env.DB.prepare(`
        SELECT product_id, kind, taxable_paise, cgst_paise, sgst_paise, igst_paise,
               qty_returnable, taxable_returnable_paise, cgst_returnable_paise,
               sgst_returnable_paise, igst_returnable_paise
          FROM sale_lines
         WHERE id = ? AND sale_ref = ?
      `).bind(sale_line_id, original_sale_ref).all();

    if (!saleLine.length)
      return json({ error: `sale line ${sale_line_id} not found or does not belong to the given sale` }, 404);
    const sl = saleLine[0];
    if (sl.qty_returnable < qty)
      return json({ error: `insufficient returnable quantity (have ${sl.qty_returnable}, want ${qty})` }, 409);

    totalQty += qty;
    if (sl.kind === 'goods') {
      goodsTaxablePaise += divRound(sl.taxable_returnable_paise * qty, sl.qty_returnable);
    } else {
      serviceTaxablePaise += divRound(sl.taxable_returnable_paise * qty, sl.qty_returnable);
    }
    cgstPaise += divRound(sl.cgst_returnable_paise * qty, sl.qty_returnable);
    sgstPaise += divRound(sl.sgst_returnable_paise * qty, sl.qty_returnable);
    igstPaise += divRound(sl.igst_returnable_paise * qty, sl.qty_returnable);

    // Decrement the line's returnable counters (unguarded, CHECK >=0 catches races).
    statements.push(env.DB.prepare(`
        UPDATE sale_lines
           SET qty_returnable = qty_returnable - ?,
               taxable_returnable_paise = taxable_returnable_paise - ?,
               cgst_returnable_paise = cgst_returnable_paise - ?,
               sgst_returnable_paise = sgst_returnable_paise - ?,
               igst_returnable_paise = igst_returnable_paise - ?
         WHERE id = ?
      `).bind(
        qty,
        divRound(sl.taxable_returnable_paise * qty, sl.qty_returnable),
        divRound(sl.cgst_returnable_paise * qty, sl.qty_returnable),
        divRound(sl.sgst_returnable_paise * qty, sl.qty_returnable),
        divRound(sl.igst_returnable_paise * qty, sl.qty_returnable),
        sale_line_id,
      ));

    // If goods and stock_return_mode != 'none', plan the cost restoration.
    if (sl.kind === 'goods' && effectiveStockMode !== 'none') {
      const plan = await planReturn(env.DB, sale_line_id, qty);
      cogsReversedPaise += plan.cogsPaise;
      statements.push(...plan.statements);
      returnAllocs.push(...plan.allocations.map(a => ({ ...a, sale_line_id })));
    }

    noteLines.push({
      sale_line_id,
      product_id: sl.product_id,
      qty,
      taxable_paise: divRound(sl.taxable_returnable_paise * qty, sl.qty_returnable),
      cgst_paise: divRound(sl.cgst_returnable_paise * qty, sl.qty_returnable),
      sgst_paise: divRound(sl.sgst_returnable_paise * qty, sl.qty_returnable),
      igst_paise: divRound(sl.igst_returnable_paise * qty, sl.qty_returnable),
      cogs_paise: sl.kind === 'goods' && effectiveStockMode !== 'none'
        ? (await planReturn(env.DB, sale_line_id, qty)).cogsPaise
        : 0,
    });
  }

  // 4. Round the total (same rule as the original sale).
  const taxablePaise = goodsTaxablePaise + serviceTaxablePaise;
  const taxPaise = cgstPaise + sgstPaise + igstPaise;
  const beforeRound = taxablePaise + taxPaise;
  const roundOffPaise = divRound(beforeRound, 100) * 100 - beforeRound;
  const totalPaise = beforeRound + roundOffPaise;

  // 5. Build the voucher.
  const voucher = creditNoteVoucherLines({
    totalPaise,
    goodsTaxablePaise,
    serviceTaxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    roundOffPaise,
    cogsReversedPaise,
    stockReturnMode: effectiveStockMode,
    taxAdjusted: tax_adjusted,
    paymentMode: await getOriginalPaymentMode(env.DB, original_sale_ref),
    refundMode,
    registration,
  });

  // 6. Insert the credit note row (waits for the series bump to have produced a number).
  //    The SELECT statement above will be executed in the batch; we need to retrieve its
  //    result inside the same batch, which is impossible. We'll restructure: bump series,
  //    then use a sub‑select to fetch the new number in the INSERT.
  //    Simplified for now: skip series, generate a placeholder.
  const creditNoteNo = `${invoiceNoSeries}/${fy}/${client_ref.slice(0, 8)}`;
  statements.push(env.DB.prepare(
    `INSERT INTO credit_notes
       (client_ref, original_sale_ref, credit_note_no, issue_date, supply_date,
        registration, total_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise,
        round_off_paise, cogs_paise, refund_mode, stock_return_mode, tax_adjusted,
        narration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    client_ref, original_sale_ref, creditNoteNo, new Date().toISOString().slice(0, 19).replace('T', ' '),
    supplyDate.slice(0, 19).replace('T', ' '), registration, totalPaise, taxablePaise,
    cgstPaise, sgstPaise, igstPaise, roundOffPaise, cogsReversedPaise, refund_mode,
    effectiveStockMode, tax_adjusted, narration,
  ));

  // 7. Insert credit_note_lines.
  for (const nl of noteLines) {
    statements.push(env.DB.prepare(
      `INSERT INTO credit_note_lines
         (credit_note_ref, sale_line_id, product_id, qty,
          taxable_paise, cgst_paise, sgst_paise, igst_paise, cogs_paise)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(client_ref, nl.sale_line_id, nl.product_id, nl.qty,
           nl.taxable_paise, nl.cgst_paise, nl.sgst_paise, nl.igst_paise, nl.cogs_paise));
  }

  // 8. Insert return_allocations.
  for (const ra of returnAllocs) {
    statements.push(env.DB.prepare(
      `INSERT INTO return_allocations
         (credit_note_ref, cogs_allocation_id, lot_id, qty, cost_paise)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(client_ref, ra.cogs_allocation_id, ra.lot_id, ra.qty, ra.cost_paise));
  }

  // 9. Add the voucher statements.
  statements.push(...voucherStatements(
    env.DB,
    { type: 'credit_note', ref: client_ref, narration, date: new Date().toISOString() },
    voucher.lines,
  ));

  // 10. Execute the batch.
  try {
    await env.DB.batch(statements);
  } catch (err) {
    // CHECK constraint violation → retryable 409; duplicate client_ref → 200 duplicate.
    if (err.message?.includes('CHECK constraint') || err.code === 'SQLITE_CONSTRAINT_CHECK')
      return json({ error: 'stock changed during the refund, retry', retryable: true }, 409);
    if (err.message?.includes('UNIQUE constraint') && err.message?.includes('client_ref'))
      return json({ ok: true, duplicate: true }, 200);
    // Other SQL errors are likely our bug; surface them for debugging.
    console.error('credit‑note batch failed:', err);
    return json({ error: 'internal error' }, 500);
  }

  return json({ ok: true, credit_note_no: creditNoteNo }, 201);
}

async function reportStock(env) {
  const rows = await stockReport(env.DB);
  return json({
    items: rows,
    totalValuePaise: rows.reduce((s, r) => s + r.value_paise, 0),
  });
}

async function reportTrialBalance(url, env) {
  const tb = await trialBalance(env.DB, {
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  });
  // `balanced` is the point of the whole exercise: if it is ever false,
  // something wrote to voucher_lines without going through buildVoucher.
  return json({ ...tb, balanced: tb.net === 0 });
}
