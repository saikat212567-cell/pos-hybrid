/**
 * Item validation. Pure function, no server.
 *
 * The reason this is strict rather than permissive: a wrong GST rate does not
 * break a screen, it silently produces months of incorrect invoices and an
 * incorrect return, and the money has already been collected from customers at
 * the wrong rate by the time anyone notices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateItem, Invalid, GST_SLABS_BPS, UNITS } from '../src/items.js';

const GOOD = {
  id: 'basmati',
  name: 'Basmati Rice 1kg',
  price: 18000,
  gst_rate_bps: 500,
  tax_code: '1006',
  unit: 'KGS',
};

const rejects = (body, why, opts) =>
  assert.throws(() => validateItem(body, opts), Invalid, `should reject: ${why}`);

// --- the happy path --------------------------------------------------------

test('a complete item validates and normalises', () => {
  const out = validateItem(GOOD);
  assert.equal(out.id, 'basmati');
  assert.equal(out.price, 18000);
  assert.equal(out.kind, 'good', 'kind defaults to good');
  assert.equal(out.category, 'general');
  assert.equal(out.code, null, 'absent optionals become null, not undefined');
  assert.equal(out.barcode, null);
  assert.equal(out.price_mode, null, 'null means follow the shop-wide setting');
});

test('names are trimmed', () => {
  assert.equal(validateItem({ ...GOOD, name: '  Rice  ' }).name, 'Rice');
});

// --- GST rate --------------------------------------------------------------

test('only real GST slabs are accepted', () => {
  for (const rate of GST_SLABS_BPS) {
    assert.equal(validateItem({ ...GOOD, gst_rate_bps: rate }).gst_rate_bps, rate);
  }
});

test('a plausible but non-existent rate is rejected', () => {
  // 15% is not a GST slab. Accepting it would let a typo reach a filed return.
  rejects({ ...GOOD, gst_rate_bps: 1500 }, '15% is not a slab');
  rejects({ ...GOOD, gst_rate_bps: 1000 }, '10% is not a slab');
  rejects({ ...GOOD, gst_rate_bps: 18 }, '18 bps is 0.18%, not 18%');
  rejects({ ...GOOD, gst_rate_bps: -500 }, 'negative');
  rejects({ ...GOOD, gst_rate_bps: 5 }, 'looks like 5 but is 0.05%');
});

// --- HSN / SAC -------------------------------------------------------------

test('a registered dealer must give an HSN or SAC', () => {
  // Retrofitting codes across a catalog after the first return is filed is far
  // worse than being made to type one now.
  rejects({ ...GOOD, tax_code: '' }, 'no tax code for a regular dealer',
    { registration: 'regular' });
});

test('an unregistered business is not held to it', () => {
  // They issue no tax invoice, so there is nothing for the code to appear on.
  const out = validateItem({ ...GOOD, tax_code: '' }, { registration: 'unregistered' });
  assert.equal(out.tax_code, '');
});

test('a tax code must look like an HSN or SAC', () => {
  rejects({ ...GOOD, tax_code: 'abc' }, 'letters');
  rejects({ ...GOOD, tax_code: '12' }, 'too short');
  rejects({ ...GOOD, tax_code: '123456789' }, 'too long');
  assert.equal(validateItem({ ...GOOD, tax_code: '996813' }).tax_code, '996813', 'a 6-digit SAC');
});

test('only 4, 6 or 8 digit codes are accepted — not everything in between', () => {
  // An HSN is 4, 6 or 8 digits; a SAC is always 6. A 5- or 7-digit value is a
  // dropped or doubled keystroke, and it would sit on filed invoices and in the
  // GSTR-1 HSN summary, where the portal rejects it.
  for (const good of ['1006', '100610', '10061011']) {
    assert.equal(validateItem({ ...GOOD, tax_code: good }).tax_code, good,
      `${good} (${good.length} digits) is a real code length`);
  }
  for (const bad of ['10061', '1006101']) {
    rejects({ ...GOOD, tax_code: bad }, `${bad} is ${bad.length} digits, which no code is`);
  }
});

test('a PATCH cannot blank the tax code on a registered dealer\'s item', () => {
  // has() treats '' as present, so the creation-time requirement was skipped on
  // a patch and every later invoice for that item would carry no HSN/SAC.
  rejects({ tax_code: '' }, 'clearing the code on a regular dealer',
    { partial: true, registration: 'regular' });

  // Replacing it with a real code is fine.
  assert.equal(
    validateItem({ tax_code: '100610' }, { partial: true, registration: 'regular' }).tax_code,
    '100610');

  // And an unregistered business, which issues no tax invoice, may clear it.
  assert.equal(
    validateItem({ tax_code: '' }, { partial: true, registration: 'unregistered' }).tax_code,
    '');
});

// --- price -----------------------------------------------------------------

test('price must be integer paise', () => {
  rejects({ ...GOOD, price: 180.5 }, 'a fractional paisa');
  rejects({ ...GOOD, price: -1 }, 'negative');
  rejects({ ...GOOD, price: '18000' }, 'a string');
  rejects({ ...GOOD, price: undefined }, 'missing');
  assert.equal(validateItem({ ...GOOD, price: 0 }).price, 0, 'free is allowed');
});

// --- id, code, barcode -----------------------------------------------------

test('ids are restricted because they appear in URLs', () => {
  rejects({ ...GOOD, id: 'has space' }, 'a space');
  rejects({ ...GOOD, id: 'Caps' }, 'uppercase');
  rejects({ ...GOOD, id: '' }, 'empty');
  rejects({ ...GOOD, id: '-leading' }, 'a leading dash');
  rejects({ ...GOOD, id: 'a'.repeat(64) }, 'too long');
  assert.equal(validateItem({ ...GOOD, id: 'rice_1-kg' }).id, 'rice_1-kg');
});

test('a till code is a short number, a barcode is not', () => {
  // The distinction is the point: nobody types a 13-digit EAN at a counter.
  assert.equal(validateItem({ ...GOOD, code: '21' }).code, '21');
  assert.equal(validateItem({ ...GOOD, code: 21 }).code, '21', 'a number is coerced');
  rejects({ ...GOOD, code: 'a1' }, 'letters in a code');
  rejects({ ...GOOD, code: '1234567' }, 'too long to memorise');
  rejects({ ...GOOD, code: '' }, 'empty');
});

test('barcodes accept what a scanner actually emits', () => {
  assert.equal(validateItem({ ...GOOD, barcode: '8901234567890' }).barcode, '8901234567890');
  assert.equal(validateItem({ ...GOOD, barcode: 'ABC-123_x.1' }).barcode, 'ABC-123_x.1');
  rejects({ ...GOOD, barcode: 'ab' }, 'too short to be real');
  rejects({ ...GOOD, barcode: 'has space' }, 'a space');
});

// --- units -----------------------------------------------------------------

test('units must be real UQCs, since they go on a return', () => {
  for (const u of UNITS) {
    assert.equal(validateItem({ ...GOOD, unit: u }).unit, u);
  }
  rejects({ ...GOOD, unit: 'kg' }, 'lowercase is not the UQC');
  rejects({ ...GOOD, unit: 'bags' }, 'not a UQC');
});

test('a service defaults to the NA unit', () => {
  const out = validateItem({ ...GOOD, kind: 'service', unit: undefined });
  assert.equal(out.unit, 'NA', 'a service counts nothing');
});

test('a good defaults to PCS', () => {
  assert.equal(validateItem({ ...GOOD, unit: undefined }).unit, 'PCS');
});

// --- kind ------------------------------------------------------------------

test('kind must be good or service', () => {
  assert.equal(validateItem({ ...GOOD, kind: 'service' }).kind, 'service');
  rejects({ ...GOOD, kind: 'thing' }, 'not a kind');
});

// --- partial updates -------------------------------------------------------

test('a patch validates only what it contains', () => {
  const out = validateItem({ price: 19000 }, { partial: true });
  assert.deepEqual(out, { price: 19000 }, 'untouched fields must not be defaulted in');
});

test('a patch still rejects a bad value', () => {
  rejects({ gst_rate_bps: 1500 }, 'bad slab in a patch', { partial: true });
  rejects({ price: -5 }, 'negative price in a patch', { partial: true });
});

test('an empty patch is rejected rather than silently doing nothing', () => {
  rejects({}, 'nothing to update', { partial: true });
});

test('a patch does not require an HSN the way creation does', () => {
  // Otherwise renaming an item would demand a tax code be re-sent every time.
  const out = validateItem({ name: 'New Name' }, { partial: true, registration: 'regular' });
  assert.deepEqual(out, { name: 'New Name' });
});

test('is_active is patchable, for restoring a hidden item', () => {
  assert.equal(validateItem({ is_active: 1 }, { partial: true }).is_active, 1);
  assert.equal(validateItem({ is_active: false }, { partial: true }).is_active, 0);
  rejects({ is_active: 'yes' }, 'not a boolean', { partial: true });
});

test('is_active cannot be set at creation', () => {
  // Creating an item pre-hidden would be a way to make one nobody can find.
  const out = validateItem({ ...GOOD, is_active: 0 });
  assert.equal(out.is_active, undefined);
});

// --- price mode ------------------------------------------------------------

test('a per-item price mode is accepted, so one catalog can serve both', () => {
  assert.equal(validateItem({ ...GOOD, price_mode: 'exclusive' }).price_mode, 'exclusive');
  rejects({ ...GOOD, price_mode: 'sideways' }, 'not a mode');
});

// --- error messages --------------------------------------------------------

test('errors name the field, because a person is reading them', () => {
  // The admin screen shows these directly. "400" would tell a shopkeeper
  // nothing about which of fourteen inputs is wrong.
  try {
    validateItem({ ...GOOD, gst_rate_bps: 1500 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /gst_rate_bps/);
    assert.match(err.message, /1800/, 'and list the valid slabs');
  }
});
