/**
 * Bill rendering. Pure functions, so no server and no D1.
 *
 * Two things are being guarded here. First, amount-in-words: it uses the Indian
 * lakh/crore grouping, which a Western implementation gets wrong in a way that
 * looks plausible on small numbers and is wrong on every large one. Second, the
 * document type: a composition dealer's bill must not show tax and must carry a
 * specific declaration, and getting that wrong is a compliance problem rather
 * than a cosmetic one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rupeesInWords, amountInWords, docType, rateWise, billHtml, money, FORMATS,
} from '../src/bill.js';

// --- amount in words -------------------------------------------------------

test('small amounts read correctly', () => {
  assert.equal(rupeesInWords(0), 'Zero');
  assert.equal(rupeesInWords(1), 'One');
  assert.equal(rupeesInWords(15), 'Fifteen');
  assert.equal(rupeesInWords(20), 'Twenty');
  assert.equal(rupeesInWords(21), 'Twenty One');
  assert.equal(rupeesInWords(100), 'One Hundred');
  assert.equal(rupeesInWords(999), 'Nine Hundred Ninety Nine');
});

test('groups as lakh and crore, not million', () => {
  // The whole reason this is hand-written. A Western grouping would call
  // 150000 "One Hundred Fifty Thousand", which is not how an Indian invoice
  // reads.
  assert.equal(rupeesInWords(1000), 'One Thousand');
  assert.equal(rupeesInWords(100000), 'One Lakh');
  assert.equal(rupeesInWords(150000), 'One Lakh Fifty Thousand');
  assert.equal(rupeesInWords(10000000), 'One Crore');
  assert.equal(rupeesInWords(12345678),
    'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight');
});

test('the grouping switches to twos above a thousand', () => {
  // 99,999 is the last five-digit figure; 1,00,000 is where lakh begins.
  assert.equal(rupeesInWords(99999), 'Ninety Nine Thousand Nine Hundred Ninety Nine');
  assert.equal(rupeesInWords(100001), 'One Lakh One');
  assert.equal(rupeesInWords(1000000), 'Ten Lakh');
  assert.equal(rupeesInWords(9999999), 'Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine');
});

test('crores beyond 999 recurse', () => {
  assert.equal(rupeesInWords(10000000000), 'One Thousand Crore');
  assert.equal(rupeesInWords(1000000000), 'One Hundred Crore');
});

test('amount in words includes paise and the Only suffix', () => {
  assert.equal(amountInWords(12345678),
    'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only');
  assert.equal(amountInWords(50000), 'Rupees Five Hundred Only', 'whole rupees omit the paise clause');
  assert.equal(amountInWords(5), 'Rupees Zero and Five Paise Only');
  assert.equal(amountInWords(0), 'Rupees Zero Only');
});

test('words never contain double spaces or stray joins', () => {
  // A missing separator or an empty group is the classic bug in this kind of
  // function, and it only shows up at certain values.
  for (let r = 0; r < 2000; r++) {
    const w = rupeesInWords(r);
    assert.ok(!w.includes('  '), `double space at ${r}: "${w}"`);
    assert.equal(w, w.trim(), `untrimmed at ${r}: "${w}"`);
  }
  for (const r of [100000, 100001, 1000000, 10000000, 10000001, 10100000]) {
    const w = rupeesInWords(r);
    assert.ok(!w.includes('  '), `double space at ${r}: "${w}"`);
  }
});

test('rejects nonsense rather than inventing words', () => {
  assert.equal(rupeesInWords(-5), '');
  assert.equal(rupeesInWords(1.5), '');
  assert.equal(amountInWords(-1), '');
});

// --- document type ---------------------------------------------------------

test('a regular dealer issues a tax invoice with tax shown', () => {
  const d = docType('regular');
  assert.equal(d.title, 'TAX INVOICE');
  assert.equal(d.showTax, true);
  assert.equal(d.declaration, '');
});

test('a composition dealer issues a bill of supply with the declaration', () => {
  // Required wording. Its absence is what gets penalised.
  const d = docType('composition');
  assert.equal(d.title, 'BILL OF SUPPLY');
  assert.equal(d.showTax, false);
  assert.match(d.declaration, /not eligible to collect tax/i);
});

test('an unregistered business issues a plain receipt', () => {
  const d = docType('unregistered');
  assert.equal(d.title, 'RECEIPT');
  assert.equal(d.showTax, false);
});

// --- rate-wise breakup -----------------------------------------------------

test('lines group by GST rate and sum within each group', () => {
  const groups = rateWise([
    { gst_rate_bps: 1800, taxable_paise: 100, cgst_paise: 9, sgst_paise: 9, igst_paise: 0 },
    { gst_rate_bps: 500, taxable_paise: 200, cgst_paise: 5, sgst_paise: 5, igst_paise: 0 },
    { gst_rate_bps: 1800, taxable_paise: 300, cgst_paise: 27, sgst_paise: 27, igst_paise: 0 },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.rateBps), [500, 1800], 'sorted by rate');
  const g18 = groups.find(g => g.rateBps === 1800);
  assert.equal(g18.taxable, 400);
  assert.equal(g18.cgst, 36);
});

// --- rendering -------------------------------------------------------------

const SALE = {
  invoice_no: 'A/26-27/0042',
  sold_at: '2026-09-22 10:30:00',
  taxable_paise: 4237,
  cgst_paise: 381,
  sgst_paise: 382,
  igst_paise: 0,
  round_off_paise: 0,
  total_paise: 5000,
  payment_mode: 'cash',
  place_of_supply: '19',
  lines: [{
    name: 'Espresso', tax_code: '2202', unit: 'PCS', qty: 2, price_paise: 2500,
    gst_rate_bps: 1800, taxable_paise: 4237, cgst_paise: 381, sgst_paise: 382,
    igst_paise: 0,
  }],
};

const SETTINGS = {
  gst_registration: 'regular',
  legal_name: 'Test Shop',
  gstin: '19ABCDE1234F1Z5',
  address: '12 Market Road',
  phone: '9800000000',
};

test('every format renders a complete document with the key figures', () => {
  for (const f of FORMATS) {
    const html = billHtml(SALE, SETTINGS, f);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.ok(html.includes('</html>'), `${f}: unterminated`);
    assert.ok(html.includes('A/26-27/0042'), `${f}: missing invoice number`);
    assert.ok(html.includes('Test Shop'), `${f}: missing shop name`);
    assert.ok(html.includes('50.00'), `${f}: missing total`);
    assert.ok(html.includes('TAX INVOICE'), `${f}: missing document title`);
  }
});

test('page size matches the paper', () => {
  assert.match(billHtml(SALE, SETTINGS, '58mm'), /size: 58mm auto/);
  assert.match(billHtml(SALE, SETTINGS, '80mm'), /size: 80mm auto/);
  assert.match(billHtml(SALE, SETTINGS, 'a4'), /size: A4/);
});

test('thermal rolls are continuous, not fixed height', () => {
  // A fixed height would eject the same length of paper for a one-line bill as
  // for a twenty-line one.
  for (const f of ['58mm', '80mm']) {
    assert.match(billHtml(SALE, SETTINGS, f), /auto/, `${f} should be auto height`);
  }
});

test('an unknown format falls back rather than rendering nothing', () => {
  const html = billHtml(SALE, SETTINGS, 'thermal-9000');
  assert.match(html, /size: 58mm auto/);
});

test('a fractional GST rate is printed exactly, not truncated to 0%', () => {
  // 25 bps is the real 0.25% slab (rough diamonds, precious stones).
  // (25/100).toFixed(0) renders "0%", so the invoice would state a 0% rate
  // against a non-zero tax amount — a document a tax officer would refuse.
  const sale = {
    ...SALE,
    taxable_paise: 100000, cgst_paise: 125, sgst_paise: 125, total_paise: 100250,
    lines: [{
      name: 'Rough Diamond', tax_code: '7102', unit: 'CTS', qty: 1,
      price_paise: 100000, gst_rate_bps: 25,
      taxable_paise: 100000, cgst_paise: 125, sgst_paise: 125, igst_paise: 0,
    }],
  };

  for (const f of FORMATS) {
    const html = billHtml(sale, SETTINGS, f);
    if (html.includes('%')) {
      assert.ok(html.includes('0.25%'), `${f}: should state 0.25%, not a truncated rate`);
      assert.ok(!/>0%</.test(html), `${f}: printed 0% against a non-zero tax`);
    }
  }
});

test('whole-number rates stay free of a spurious decimal', () => {
  for (const [bps, want] of [[0, '0%'], [300, '3%'], [500, '5%'], [1200, '12%'], [1800, '18%'], [2800, '28%']]) {
    const sale = {
      ...SALE,
      lines: [{ ...SALE.lines[0], gst_rate_bps: bps }],
    };
    const html = billHtml(sale, SETTINGS, 'a4');
    assert.ok(html.includes(want), `${bps} bps should print as ${want}`);
    assert.ok(!html.includes(want.replace('%', '.0%')), `${bps} bps should not print a trailing .0`);
  }
});

test('A4 carries the full tax invoice apparatus', () => {
  const html = billHtml(SALE, SETTINGS, 'a4');
  assert.ok(html.includes('HSN/SAC'), 'A4 needs an HSN column');
  assert.ok(html.includes('2202'), 'the HSN itself');
  assert.ok(html.includes('Amount in words'), 'an Indian invoice states the total in words');
  assert.ok(html.includes('Rupees Fifty Only'), 'and the words themselves, matching the total');
  assert.ok(html.includes('Authorised Signatory'));
  assert.ok(html.includes('19ABCDE1234F1Z5'), 'seller GSTIN');
});

test("a composition dealer's bill shows no tax but does show the declaration", () => {
  const html = billHtml(SALE, { ...SETTINGS, gst_registration: 'composition' }, 'a4');
  assert.ok(html.includes('BILL OF SUPPLY'));
  assert.ok(!html.includes('TAX INVOICE'));
  assert.match(html, /not eligible to collect tax/i);
  // The tax column headers must be gone, not merely zeroed.
  assert.ok(!html.includes('>CGST<'), 'no CGST column on a bill of supply');
  assert.ok(!html.includes('Taxable</th>') || !html.includes('>GST<'),
    'no per-line GST column');
});

test('an unregistered receipt shows no tax at all', () => {
  const html = billHtml(SALE, { ...SETTINGS, gst_registration: 'unregistered' }, '58mm');
  assert.ok(html.includes('RECEIPT'));
  assert.ok(!html.includes('TAX INVOICE'));
});

test('an interstate bill shows IGST and omits CGST/SGST', () => {
  const inter = {
    ...SALE, cgst_paise: 0, sgst_paise: 0, igst_paise: 763, place_of_supply: '27',
    lines: [{ ...SALE.lines[0], cgst_paise: 0, sgst_paise: 0, igst_paise: 763 }],
  };
  const html = billHtml(inter, SETTINGS, 'a4');
  assert.ok(html.includes('IGST'));
  assert.ok(!html.includes('>CGST</td>'), 'no CGST row when there is none');
});

test('a single-rate narrow-roll invoice still states the rate somewhere', () => {
  // Rule 46(m) requires the rate of tax on a tax invoice. On 58mm/80mm the
  // per-line rate only prints when `wide`, and the rate-wise breakup table was
  // suppressed whenever there was only one rate — so a single-rate thermal
  // invoice showed CGST/SGST amounts with the rate stated nowhere on the
  // document.
  for (const f of ['58mm', '80mm']) {
    const html = billHtml(SALE, SETTINGS, f);
    assert.ok(html.includes(SALE.lines[0].cgst_paise > 0 ? 'CGST' : ''),
      `${f}: sanity check the fixture actually has tax`);
    assert.match(html, /18%/, `${f}: the 18% rate must be stated somewhere on the bill`);
  }
});

test('zero-value figures are omitted rather than printed as 0.00', () => {
  // A short bill is easier to read at a counter, and a printed 0.00 invites the
  // question of what it means.
  const html = billHtml(SALE, SETTINGS, '58mm');
  assert.ok(!html.includes('IGST'), 'no IGST row on a local sale');
  assert.ok(!html.includes('Round off'), 'no round-off row when it is zero');
});

test('a shop footer replaces the default thank-you rather than doubling it', () => {
  const withFooter = billHtml(SALE, { ...SETTINGS, bill_footer: 'Visit again' }, '58mm');
  assert.ok(withFooter.includes('Visit again'));
  assert.ok(!withFooter.includes('Thank you'), 'a bill should not thank the customer twice');

  const without = billHtml(SALE, SETTINGS, '58mm');
  assert.ok(without.includes('Thank you'), 'with no footer set, the default stands in');
});

test('round off appears when it is not zero', () => {
  const html = billHtml({ ...SALE, round_off_paise: -40 }, SETTINGS, '58mm');
  assert.ok(html.includes('Round off'));
});

test('a customer GSTIN is printed when present', () => {
  const html = billHtml({ ...SALE, customer_gstin: '27AAAAA0000A1Z5' }, SETTINGS, 'a4');
  assert.ok(html.includes('27AAAAA0000A1Z5'));
});

test('item names are escaped so a bill cannot be injected', () => {
  // Item names come from the database and the bill is rendered as HTML.
  const html = billHtml(
    { ...SALE, lines: [{ ...SALE.lines[0], name: '<script>alert(1)</script>' }] },
    SETTINGS, '58mm'
  );
  assert.ok(!html.includes('<script>alert'), 'raw script tag reached the output');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('shop details are escaped too', () => {
  const html = billHtml(SALE, { ...SETTINGS, legal_name: 'A & B <Traders>' }, '58mm');
  assert.ok(html.includes('A &amp; B &lt;Traders&gt;'));
});

test('a missing optional field renders without a blank label', () => {
  const html = billHtml(SALE, { gst_registration: 'regular' }, '58mm');
  assert.ok(!html.includes('GSTIN:'), 'no GSTIN label when there is no GSTIN');
  assert.ok(!html.includes('Ph:'), 'no phone label when there is no phone');
  assert.match(html, /^<!DOCTYPE html>/, 'still a valid document');
});

test('money formats paise as two decimals', () => {
  assert.equal(money(5000), '50.00');
  assert.equal(money(5), '0.05');
  assert.equal(money(0), '0.00');
  assert.equal(money(-40), '-0.40');
});
