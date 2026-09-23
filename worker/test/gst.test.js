/**
 * GST arithmetic. Pure functions, so no server and no D1 — run with `npm test`.
 *
 * The assertions are mostly about exactness, not approximate correctness: a
 * ₹50 sticker price must ring up as exactly ₹50, and the tax figures printed
 * on an invoice must add up to the total printed below them. Off-by-a-paisa is
 * the whole class of bug these guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitInclusive, splitExclusive, splitByPlace, lineTax, invoiceTotals, roundOff, chargesTax,
  normalizeStateCode,
} from '../src/gst.js';

const REGULAR = { registration: 'regular', sellerState: '19', buyerState: '19',
                  defaultPriceMode: 'inclusive' };

// --- inclusive pricing (Indian retail MRP) ---------------------------------

test('inclusive split round-trips exactly', () => {
  // ₹50.00 at 18%: taxable 4237.29 -> 4237, tax is the remainder.
  const { taxable, tax } = splitInclusive(5000, 1800);
  assert.equal(taxable + tax, 5000, 'taxable + tax must equal the sticker price');
  assert.equal(taxable, 4237);
  assert.equal(tax, 763);
});

test('inclusive split never loses a paisa, at any amount or rate', () => {
  // The property that matters: a customer paying a round number must never see
  // a total a paisa off it.
  for (const rate of [0, 500, 1200, 1800, 2800]) {
    for (let amount = 1; amount <= 2000; amount++) {
      const { taxable, tax } = splitInclusive(amount, rate);
      assert.equal(taxable + tax, amount, `${amount}p at ${rate}bps`);
      assert.ok(tax >= 0, `negative tax at ${amount}p ${rate}bps`);
    }
  }
});

test('zero rate leaves the whole amount taxable', () => {
  assert.deepEqual(splitInclusive(5000, 0), { taxable: 5000, tax: 0 });
});

// --- exclusive pricing (B2B / wholesale) ----------------------------------

test('exclusive adds tax on top', () => {
  const { taxable, tax } = splitExclusive(10000, 1800);
  assert.equal(taxable, 10000);
  assert.equal(tax, 1800);
});

test('exclusive rounds half up', () => {
  // 333 * 18% = 59.94 -> 60
  assert.equal(splitExclusive(333, 1800).tax, 60);
});

// --- place of supply -------------------------------------------------------

test('same state splits into CGST and SGST halves that sum exactly', () => {
  const { cgst, sgst, igst } = splitByPlace(763, '19', '19');
  assert.equal(cgst + sgst, 763, 'halves must sum to the tax');
  assert.equal(igst, 0);
  // Odd amount: one side carries the extra paisa rather than both rounding.
  assert.equal(cgst, 381);
  assert.equal(sgst, 382);
});

test('different state is IGST, nothing else', () => {
  assert.deepEqual(splitByPlace(763, '19', '27'), { cgst: 0, sgst: 0, igst: 763 });
});

// --- state code canonicalisation -------------------------------------------

test('a canonical state code passes through zero-padded', () => {
  assert.equal(normalizeStateCode('19'), '19');
  assert.equal(normalizeStateCode('7'), '07', 'single digits are padded');
  assert.equal(normalizeStateCode('07'), '07');
  assert.equal(normalizeStateCode(19), '19', 'a number is accepted');
  assert.equal(normalizeStateCode(' 19 '), '19', 'surrounding whitespace is trimmed');
});

test('uncanonical spellings of a real state are normalised, not passed through', () => {
  // THE REGRESSION. splitByPlace compares codes as strings, so "19 " or "019"
  // compared unequal to the seller's own "19" and routed an intrastate sale
  // entirely to IGST — the wrong tax head on a filed return.
  for (const input of ['19 ', ' 19', '019']) {
    assert.equal(normalizeStateCode(input), '19', `${JSON.stringify(input)} is state 19`);
  }
});

test('a non-state-code is rejected rather than silently used', () => {
  for (const bad of ['nineteen', '1 9', '19a', '', '  ', 'NULL', '1.9', '-19', '19.0']) {
    assert.equal(normalizeStateCode(bad), null, `${JSON.stringify(bad)} is not a state code`);
  }
  assert.equal(normalizeStateCode(null), null);
  assert.equal(normalizeStateCode(undefined), null);
});

test('only real GST state numbers are accepted', () => {
  // 01-38 are the states and union territories; 97 is Other Territory and 99 is
  // Centre Jurisdiction.
  assert.equal(normalizeStateCode('01'), '01');
  assert.equal(normalizeStateCode('38'), '38');
  assert.equal(normalizeStateCode('97'), '97');
  assert.equal(normalizeStateCode('99'), '99');

  for (const out of ['00', '39', '50', '96', '98']) {
    assert.equal(normalizeStateCode(out), null, `${out} is not an assigned state code`);
  }
});

test('a normalised pair compares correctly for place of supply', () => {
  // The point of normalising: the same state written two ways must be local.
  const seller = normalizeStateCode('19');
  const buyer = normalizeStateCode('019');
  const { cgst, sgst, igst } = splitByPlace(1000, seller, buyer);
  assert.equal(igst, 0, 'the same state written differently must stay intrastate');
  assert.equal(cgst + sgst, 1000);
});

test('missing place of supply is treated as local', () => {
  // A walk-in counter sale has no stated place of supply; the seller's own
  // state is the correct default, not an interstate supply.
  const { cgst, sgst, igst } = splitByPlace(100, '19', '');
  assert.equal(igst, 0);
  assert.equal(cgst + sgst, 100);
});

// --- registration types ----------------------------------------------------

test('only a regular dealer charges tax', () => {
  assert.equal(chargesTax('regular'), true);
  assert.equal(chargesTax('composition'), false);
  assert.equal(chargesTax('unregistered'), false);
});

test('composition dealer emits no tax and the price is the taxable value', () => {
  // A composition dealer is forbidden from collecting GST; their document is a
  // bill of supply with no tax columns.
  const l = lineTax(
    { price_paise: 5000, qty: 2, gst_rate_bps: 1800 },
    { ...REGULAR, registration: 'composition' }
  );
  assert.equal(l.tax, 0);
  assert.equal(l.cgst + l.sgst + l.igst, 0);
  assert.equal(l.taxable, 10000, 'the whole amount is turnover');
});

test('unregistered emits no tax even with a rate set on the item', () => {
  // A stale rate left on an item must not leak tax onto the bill.
  const l = lineTax(
    { price_paise: 5000, qty: 1, gst_rate_bps: 2800 },
    { ...REGULAR, registration: 'unregistered' }
  );
  assert.equal(l.tax, 0);
  assert.equal(l.rateBps, 0);
});

// --- per-item price mode ---------------------------------------------------

test('a per-item price mode overrides the default', () => {
  const ctx = { ...REGULAR, defaultPriceMode: 'inclusive' };
  const inclusive = lineTax({ price_paise: 5000, qty: 1, gst_rate_bps: 1800 }, ctx);
  const exclusive = lineTax(
    { price_paise: 5000, qty: 1, gst_rate_bps: 1800, price_mode: 'exclusive' }, ctx
  );

  assert.equal(inclusive.taxable + inclusive.tax, 5000, 'inclusive: customer pays the sticker');
  assert.equal(exclusive.taxable, 5000, 'exclusive: tax goes on top');
  assert.equal(exclusive.taxable + exclusive.tax, 5900);
});

// --- invoice totals --------------------------------------------------------

test('invoice tax equals the sum of the printed line taxes', () => {
  // The reason tax is rounded per line: a customer can add up the lines.
  const lines = [
    lineTax({ price_paise: 333, qty: 3, gst_rate_bps: 1800 }, REGULAR),
    lineTax({ price_paise: 777, qty: 1, gst_rate_bps: 500 }, REGULAR),
    lineTax({ price_paise: 4999, qty: 2, gst_rate_bps: 1200 }, REGULAR),
  ];
  const t = invoiceTotals(lines, { roundOffEnabled: false });

  assert.equal(t.cgst, lines.reduce((s, l) => s + l.cgst, 0));
  assert.equal(t.sgst, lines.reduce((s, l) => s + l.sgst, 0));
  assert.equal(t.taxable, lines.reduce((s, l) => s + l.taxable, 0));
  assert.equal(t.total, t.taxable + t.cgst + t.sgst + t.igst);
});

test('inclusive invoice total equals the sum of sticker prices', () => {
  // Three ₹50 items at 18% must come to exactly ₹150, not ₹149.99.
  const lines = [1, 1, 1].map(qty =>
    lineTax({ price_paise: 5000, qty, gst_rate_bps: 1800 }, REGULAR));
  const t = invoiceTotals(lines, { roundOffEnabled: false });
  assert.equal(t.total, 15000);
});

// --- rounding --------------------------------------------------------------

test('round off goes to the nearest rupee and reports the adjustment', () => {
  assert.deepEqual(roundOff(10040), { total: 10000, adjustment: -40 });
  assert.deepEqual(roundOff(10060), { total: 10100, adjustment: 40 });
  assert.deepEqual(roundOff(10050), { total: 10100, adjustment: 50 }, 'half rounds up');
  assert.deepEqual(roundOff(10000), { total: 10000, adjustment: 0 });
});

test('round off can be switched off', () => {
  assert.deepEqual(roundOff(10040, false), { total: 10040, adjustment: 0 });
});

test('the round-off adjustment always reconciles the total', () => {
  // This is what the Round Off ledger account posts, so it has to be exact or
  // the books will not balance.
  for (let p = 9900; p <= 10100; p++) {
    const { total, adjustment } = roundOff(p);
    assert.equal(total - adjustment, p, `${p}p`);
    assert.equal(total % 100, 0, `${p}p should round to whole rupees`);
  }
});
