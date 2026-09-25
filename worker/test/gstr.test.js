/**
 * GSTR-1 / GSTR-3B builder unit tests. Pure: no server, no D1 — the database
 * is a tiny fake that answers the exact SQL these builders run.
 *
 * The assertions that matter most are about money: portal JSON is in rupees to
 * two decimals, but every internal figure is integer paise, so the paise->rupee
 * conversion is the one place a rounding bug could put a wrong number on a filed
 * return. It is checked exhaustively rather than by example.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  paiseToRupees, periodParts, currentPeriod, b2csRows, hsnRows, docIssueRows, cdnrRows,
  preflight, gstr1, gstr3b, GstrError,
} from '../src/gstr.js';

// --- paise -> rupees, the money-safety core --------------------------------

test('paiseToRupees keeps two decimals as a JSON number, never a float divide', () => {
  assert.equal(paiseToRupees(2510), 25.1, '25.10 serializes as 25.1 but equals 25.10');
  assert.equal(paiseToRupees(2500), 25);
  assert.equal(paiseToRupees(1), 0.01);
  assert.equal(paiseToRupees(99), 0.99);
  assert.equal(paiseToRupees(100), 1);
  assert.equal(paiseToRupees(0), 0);
});

test('paiseToRupees carries a negative figure rather than clamping it', () => {
  // A net-negative period (credit notes exceed sales) is legal and must survive.
  assert.equal(paiseToRupees(-2510), -25.1);
  assert.equal(paiseToRupees(-1), -0.01);
  assert.equal(paiseToRupees(-100), -1);
});

test('paiseToRupees is exact for every paise value in a rupee, both signs', () => {
  // The failure mode being ruled out: 4237/100 = 42.37, but 419/100 = 4.19 only
  // by luck of binary representation. Build the string and there is no luck.
  for (let rupees = 0; rupees < 200; rupees++) {
    for (let paise = 0; paise < 100; paise++) {
      const total = rupees * 100 + paise;
      const expected = Number(`${rupees}.${String(paise).padStart(2, '0')}`);
      assert.equal(paiseToRupees(total), expected, `${total}p`);
      if (total > 0) assert.equal(paiseToRupees(-total), -expected, `-${total}p`);
    }
  }
});

test('paiseToRupees never emits a fractional paisa', () => {
  for (const paise of [1, 33, 12345, 99999999, -777]) {
    const rupees = paiseToRupees(paise);
    assert.ok(Number.isInteger(Math.round(rupees * 100)), `${paise}p round-trips`);
    assert.equal(Math.round(rupees * 100), paise, `${paise}p reconstructs exactly`);
  }
});

test('paiseToRupees refuses a non-integer, so no float can leak in', () => {
  assert.throws(() => paiseToRupees(25.5), TypeError);
  assert.throws(() => paiseToRupees(Number.MAX_SAFE_INTEGER + 2), TypeError);
});

// --- period validation ------------------------------------------------------

test('period is MMYYYY, not YYYY-MM', () => {
  const p = periodParts('042026');
  assert.equal(p.month, 4);
  assert.equal(p.year, 2026);
});

test('period bounds are the IST calendar month expressed in UTC', () => {
  // April 2026 in IST starts 2026-03-31 18:30 UTC and ends a month later.
  const p = periodParts('042026');
  assert.equal(p.from, '2026-03-31 18:30:00');
  assert.equal(p.to, '2026-04-30 18:30:00');
});

test('the default period follows the IST calendar, not UTC', () => {
  // The sharp case: for the first 5.5 hours of an Indian month the UTC month is
  // still the previous one, so a UTC default would export the wrong return to
  // anyone who omitted ?period= early on the 1st.
  assert.equal(currentPeriod(new Date('2026-04-01T00:30:00Z')), '042026',
    '06:00 IST on 1 April is April, and UTC agrees');
  assert.equal(currentPeriod(new Date('2026-03-31T19:00:00Z')), '042026',
    '00:30 IST on 1 April is April, though UTC still says March');
  assert.equal(currentPeriod(new Date('2026-03-31T18:00:00Z')), '032026',
    '23:30 IST on 31 March is still March');
});

test('a malformed period is a 400, not silently coerced', () => {
  for (const bad of ['2026-04', '4-2026', '132026', '002026', '42026', '0420260', 'April', '', '040000']) {
    assert.throws(() => periodParts(bad), GstrError, `${JSON.stringify(bad)} must be rejected`);
  }
});

// --- a fake D1 that answers only the SQL the builders run -------------------

/**
 * The builders issue a handful of distinct queries. This fake dispatches on a
 * substring of the SQL and returns canned rows, so the aggregation logic is
 * tested without a database. `tables` decides whether credit_notes "exists".
 */
function fakeDb({ settings = {}, sales = [], saleLines = [], creditNotes = [], creditNoteLines = [], voucherRow = null, tables = ['sales', 'sale_lines'] } = {}) {
  const within = (rows, dateKey) => rows; // date filtering is the caller's concern here
  const handlers = [
    [/FROM settings/, () => Object.entries(settings).map(([key, value]) => ({ key, value }))],
    [/FROM sqlite_master/, sql => tables], // handled specially below
    [/SELECT s\.place_of_supply AS pos/, () => aggregate(saleLines, sales, false)],
    [/SELECT cn\.place_of_supply AS pos/, () => aggregate(creditNoteLines, creditNotes, true)],
    [/SELECT s\.client_ref, s\.customer_gstin, s\.invoice_no/, () => joinLines(sales.filter(s => (s.customer_gstin ?? '').trim()), saleLines)],
    [/SELECT sl\.tax_code, sl\.unit, sl\.name/, () => hsnAgg(saleLines)],
    [/SELECT cnl\.tax_code, cnl\.unit, cnl\.name/, () => hsnAgg(creditNoteLines, true)],
    [/SELECT invoice_no FROM sales/, () => sales.map(s => ({ invoice_no: s.invoice_no }))],
    [/SELECT note_no FROM credit_notes/, () => creditNotes.map(c => ({ note_no: c.note_no }))],
    [/FROM credit_notes cn JOIN credit_note_lines cnl.*gstr1_table = 'cdnr'/s, () => joinCdnr(creditNotes, creditNoteLines)],
    [/SELECT client_ref, place_of_supply, invoice_no/, () => sales.map(s => ({ client_ref: s.client_ref, place_of_supply: s.place_of_supply, invoice_no: s.invoice_no }))],
    [/SELECT sl\.sale_ref AS client_ref, sl\.tax_code/, () => saleLines.map(l => ({ client_ref: l.sale_ref, tax_code: l.tax_code, unit: l.unit }))],
    [/SELECT client_ref, place_of_supply, note_no/, () => creditNotes.map(c => ({ client_ref: c.client_ref, place_of_supply: c.place_of_supply, note_no: c.note_no }))],
    [/COALESCE\(SUM\(CASE WHEN vl\.account_code/, () => [voucherRow ?? {}]],
  ];

  const run = sql => {
    for (const [pattern, fn] of handlers) if (pattern.test(sql)) return fn(sql);
    throw new Error(`unhandled SQL in fake: ${sql.slice(0, 80)}`);
  };

  return {
    prepare(sql) {
      return {
        bind(...binds) { return this; },
        async all() { return { results: run(sql) }; },
        async first() {
          if (/FROM sqlite_master/.test(sql)) {
            // bind() captured the table name; re-derive from the canned list.
            return tables.includes('credit_notes') ? { 1: 1 } : null;
          }
          const rows = run(sql);
          return rows[0] ?? null;
        },
      };
    },
  };

  function aggregate(lines, headers, negate) {
    const byRef = new Map(headers.map(h => [h.client_ref, h]));
    const groups = new Map();
    for (const line of lines) {
      const header = byRef.get(line.sale_ref ?? line.note_ref);
      if (!header) continue;
      if (negate && !(header.tax_adjusted === 1 && header.gstr1_table === 'b2cs_net')) continue;
      if (!negate && (header.customer_gstin ?? '').trim() !== '') continue;
      const key = `${header.place_of_supply}:${line.gst_rate_bps}`;
      const g = groups.get(key) ?? { pos: header.place_of_supply, gst_rate_bps: line.gst_rate_bps, taxable_paise: 0, igst_paise: 0, cgst_paise: 0, sgst_paise: 0 };
      const s = negate ? -1 : 1;
      g.taxable_paise += s * line.taxable_paise;
      g.igst_paise += s * (line.igst_paise ?? 0);
      g.cgst_paise += s * (line.cgst_paise ?? 0);
      g.sgst_paise += s * (line.sgst_paise ?? 0);
      groups.set(key, g);
    }
    return [...groups.values()];
  }

  function joinLines(headers, lines) {
    const out = [];
    for (const h of headers) {
      for (const l of lines.filter(l => l.sale_ref === h.client_ref)) {
        out.push({ ...h, ...l, pos: h.place_of_supply });
      }
    }
    return out;
  }

  function hsnAgg(lines, negate) {
    const groups = new Map();
    for (const l of lines) {
      const key = `${l.tax_code}:${l.unit}:${l.gst_rate_bps}`;
      const g = groups.get(key) ?? { tax_code: l.tax_code, unit: l.unit, name: l.name, gst_rate_bps: l.gst_rate_bps, qty: 0, taxable_paise: 0, igst_paise: 0, cgst_paise: 0, sgst_paise: 0 };
      const s = negate ? -1 : 1;
      g.qty += s * l.qty;
      g.taxable_paise += s * l.taxable_paise;
      g.igst_paise += s * (l.igst_paise ?? 0);
      g.cgst_paise += s * (l.cgst_paise ?? 0);
      g.sgst_paise += s * (l.sgst_paise ?? 0);
      groups.set(key, g);
    }
    return [...groups.values()];
  }

  function joinCdnr(headers, lines) {
    const out = [];
    for (const h of headers.filter(h => h.tax_adjusted === 1 && h.gstr1_table === 'cdnr')) {
      for (const l of lines.filter(l => l.note_ref === h.client_ref)) {
        out.push({ ...h, ...l });
      }
    }
    return out;
  }
}

const REGULAR = { gst_registration: 'regular', state_code: '19', gstin: '19ABCDE1234F1Z5' };

// --- b2cs aggregation --------------------------------------------------------

test('b2cs groups B2C sales by place of supply and rate, in rupees', async () => {
  const db = fakeDb({
    settings: REGULAR,
    sales: [{ client_ref: 'a', place_of_supply: '19', customer_gstin: null }],
    saleLines: [
      { sale_ref: 'a', gst_rate_bps: 1800, taxable_paise: 4237, cgst_paise: 381, sgst_paise: 382, igst_paise: 0 },
      { sale_ref: 'a', gst_rate_bps: 500, taxable_paise: 1000, cgst_paise: 25, sgst_paise: 25, igst_paise: 0 },
    ],
  });
  const rows = await b2csRows(db, REGULAR, '042026');
  assert.equal(rows.length, 2);
  const eighteen = rows.find(r => r.rt === 18);
  assert.equal(eighteen.sply_ty, 'INTRA');
  assert.equal(eighteen.pos, '19');
  assert.equal(eighteen.typ, 'OE');
  assert.equal(eighteen.txval, 42.37);
  assert.equal(eighteen.camt, 3.81);
  assert.equal(eighteen.samt, 3.82);
});

test('a customer GSTIN routes a sale to B2B, out of b2cs, and is never dropped', async () => {
  const shared = {
    settings: REGULAR,
    sales: [
      { client_ref: 'b2b', place_of_supply: '27', customer_gstin: '27AAAAA0000A1Z5', invoice_no: 'A/26-27/0002', sold_at: '2026-04-10', total_paise: 11800 },
      { client_ref: 'b2c', place_of_supply: '19', customer_gstin: null, invoice_no: 'A/26-27/0001' },
    ],
    saleLines: [
      { sale_ref: 'b2b', gst_rate_bps: 1800, taxable_paise: 10000, igst_paise: 1800, cgst_paise: 0, sgst_paise: 0, tax_code: '1006', unit: 'KGS', id: 1 },
      { sale_ref: 'b2c', gst_rate_bps: 1800, taxable_paise: 4237, cgst_paise: 381, sgst_paise: 382, igst_paise: 0, tax_code: '1006', unit: 'KGS' },
    ],
  };
  const b2c = await b2csRows(fakeDb(shared), REGULAR, '042026');
  assert.equal(b2c.length, 1, 'the B2B sale must not appear in b2cs');
  assert.equal(b2c[0].pos, '19');

  const full = await gstr1({ DB: fakeDb(shared) }, '042026');
  assert.equal(full.data.b2b.length, 1, 'the B2B sale must appear in b2b');
  assert.equal(full.data.b2b[0].ctin, '27AAAAA0000A1Z5');
  assert.equal(full.data.b2b[0].inv[0].itms[0].itm_det.iamt, 18);
});

test('b2cs nets ordinary credit notes and carries a net-negative figure', async () => {
  const db = fakeDb({
    settings: REGULAR,
    tables: ['sales', 'sale_lines', 'credit_notes', 'credit_note_lines'],
    sales: [{ client_ref: 's1', place_of_supply: '19', customer_gstin: null }],
    saleLines: [{ sale_ref: 's1', gst_rate_bps: 1800, taxable_paise: 1000, cgst_paise: 90, sgst_paise: 90, igst_paise: 0 }],
    creditNotes: [{ client_ref: 'c1', place_of_supply: '19', tax_adjusted: 1, gstr1_table: 'b2cs_net' }],
    creditNoteLines: [{ note_ref: 'c1', gst_rate_bps: 1800, taxable_paise: 3000, cgst_paise: 270, sgst_paise: 270, igst_paise: 0 }],
  });
  const rows = await b2csRows(db, REGULAR, '042026');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].txval, -20, 'net taxable is 1000 - 3000 = -2000 paise, carried negative');
  assert.equal(rows[0].camt, -1.8);
});

// --- HSN summary -------------------------------------------------------------

test('hsn summary groups by code and reports quantity, rate and tax', async () => {
  const db = fakeDb({
    settings: REGULAR,
    saleLines: [
      { sale_ref: 'a', tax_code: '1006', unit: 'KGS', name: 'Rice', gst_rate_bps: 500, qty: 3, taxable_paise: 3000, cgst_paise: 75, sgst_paise: 75, igst_paise: 0 },
      { sale_ref: 'b', tax_code: '1006', unit: 'KGS', name: 'Rice', gst_rate_bps: 500, qty: 2, taxable_paise: 2000, cgst_paise: 50, sgst_paise: 50, igst_paise: 0 },
    ],
  });
  const rows = await hsnRows(db, REGULAR, '042026');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hsn_sc, '1006');
  assert.equal(rows[0].uqc, 'KGS');
  assert.equal(rows[0].qty, 5);
  assert.equal(rows[0].rt, 5);
  assert.equal(rows[0].txval, 50);
});

// --- doc issue ---------------------------------------------------------------

test('doc_issue reports the issued invoice-number range for its series', async () => {
  const db = fakeDb({
    settings: REGULAR,
    sales: [
      { invoice_no: 'A/26-27/0001' }, { invoice_no: 'A/26-27/0002' }, { invoice_no: 'A/26-27/0003' },
    ],
  });
  const rows = await docIssueRows(db, REGULAR, '042026');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].doc_num, 1, 'invoices are document type 1');
  assert.equal(rows[0].docs[0].from, 'A/26-27/0001');
  assert.equal(rows[0].docs[0].to, 'A/26-27/0003');
  assert.equal(rows[0].docs[0].totnum, 3);
});

// --- credit note buckets -----------------------------------------------------

test('cdnr is empty when the refund schema does not yet exist', async () => {
  const db = fakeDb({ settings: REGULAR }); // tables excludes credit_notes
  assert.deepEqual(await cdnrRows(db, REGULAR, '042026'), []);
});

test('cdnr carries a registered-buyer credit note once the schema exists', async () => {
  const db = fakeDb({
    settings: REGULAR,
    tables: ['sales', 'sale_lines', 'credit_notes', 'credit_note_lines'],
    creditNotes: [{
      client_ref: 'c1', customer_gstin: '27AAAAA0000A1Z5', note_no: 'CN/26-27/0001',
      note_date: '2026-04-15', original_invoice_no: 'A/25-26/0009', original_invoice_date: '2026-03-01',
      total_paise: 11800, tax_adjusted: 1, gstr1_table: 'cdnr',
    }],
    creditNoteLines: [{ note_ref: 'c1', gst_rate_bps: 1800, taxable_paise: 10000, igst_paise: 1800, cgst_paise: 0, sgst_paise: 0, id: 1 }],
  });
  const rows = await cdnrRows(db, REGULAR, '042026');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ctin, '27AAAAA0000A1Z5');
  assert.equal(rows[0].nt[0].ntty, 'C');
  assert.equal(rows[0].nt[0].nt_dt, '15-04-2026', 'portal dates are dd-mm-yyyy');
  assert.equal(rows[0].nt[0].itms[0].itm_det.iamt, 18);
});

// --- validation / preflight --------------------------------------------------

test('preflight fails loudly on a malformed place of supply and names the document', async () => {
  const db = fakeDb({
    settings: REGULAR,
    sales: [
      { client_ref: 'good', place_of_supply: '19', invoice_no: 'A/26-27/0001' },
      { client_ref: 'bad', place_of_supply: 'nineteen', invoice_no: 'A/26-27/0002' },
    ],
    saleLines: [
      { sale_ref: 'good', tax_code: '1006', unit: 'KGS' },
      { sale_ref: 'bad', tax_code: '1006', unit: 'KGS' },
    ],
  });
  const result = await preflight(db, REGULAR, '042026');
  assert.equal(result.ok, false);
  const posError = result.errors.find(e => e.field === 'place_of_supply');
  assert.ok(posError, 'the bad place of supply must be reported');
  assert.deepEqual(posError.client_refs, ['bad']);
});

test('preflight catches a malformed HSN and a non-letter UQC', async () => {
  const db = fakeDb({
    settings: REGULAR,
    sales: [{ client_ref: 'a', place_of_supply: '19', invoice_no: 'A/26-27/0001' }],
    saleLines: [{ sale_ref: 'a', tax_code: '10061', unit: 'PCS2' }],
  });
  const result = await preflight(db, REGULAR, '042026');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === 'tax_code'), 'a 5-digit code is not a real HSN');
  assert.ok(result.errors.some(e => e.field === 'unit'), 'a UQC must be letters only');
});

test('preflight passes clean data', async () => {
  const db = fakeDb({
    settings: REGULAR,
    sales: [{ client_ref: 'a', place_of_supply: '19', invoice_no: 'A/26-27/0001' }],
    saleLines: [{ sale_ref: 'a', tax_code: '1006', unit: 'KGS' }],
  });
  assert.deepEqual(await preflight(db, REGULAR, '042026'), { ok: true, errors: [] });
});

// --- composition / unregistered refusal --------------------------------------

test('a composition dealer is refused GSTR-1 with a CMP-08 pointer, not an empty return', async () => {
  const db = fakeDb({ settings: { ...REGULAR, gst_registration: 'composition' } });
  await assert.rejects(() => gstr1({ DB: db }, '042026'), err => {
    assert.ok(err instanceof GstrError);
    assert.equal(err.status, 422);
    assert.match(err.message, /CMP-08/);
    return true;
  });
});

test('an unregistered business is refused with a distinct message', async () => {
  const db = fakeDb({ settings: { ...REGULAR, gst_registration: 'unregistered' } });
  await assert.rejects(() => gstr3b({ DB: db }, '042026'), err => {
    assert.equal(err.status, 422);
    assert.match(err.message, /unregistered/);
    return true;
  });
});

// --- gstr3b from the ledger --------------------------------------------------

test('gstr3b reads net outward tax and ITC from posted accounts', async () => {
  const db = fakeDb({
    settings: REGULAR,
    sales: [{ client_ref: 'a', place_of_supply: '19', invoice_no: 'A/26-27/0001' }],
    saleLines: [{ sale_ref: 'a', tax_code: '1006', unit: 'KGS' }],
    voucherRow: {
      taxable_paise: 100000, igst_paise: 0, cgst_paise: 9000, sgst_paise: 9000,
      input_igst_paise: 0, input_cgst_paise: 2000, input_sgst_paise: 2000,
    },
  });
  const out = await gstr3b({ DB: db }, '042026');
  assert.equal(out.data.osup_det.txval, 1000);
  assert.equal(out.data.osup_det.camt, 90);
  assert.equal(out.data.itc_elg.net_itc.camt, 20);
  assert.equal(out.fp, '042026');
  assert.equal(out.gstin, '19ABCDE1234F1Z5');
});

test('gstr3b carries a net-negative outward figure rather than clamping to zero', async () => {
  const db = fakeDb({
    settings: REGULAR,
    sales: [], saleLines: [],
    voucherRow: {
      taxable_paise: -50000, igst_paise: 0, cgst_paise: -4500, sgst_paise: -4500,
      input_igst_paise: 0, input_cgst_paise: 0, input_sgst_paise: 0,
    },
  });
  const out = await gstr3b({ DB: db }, '042026');
  assert.equal(out.data.osup_det.txval, -500, 'reclaimable tax is not silently discarded');
  assert.equal(out.data.osup_det.camt, -45);
});

// --- envelope shape ----------------------------------------------------------

test('gstr1 returns the documented envelope with gstin, fp, data and validation', async () => {
  const db = fakeDb({
    settings: REGULAR,
    sales: [{ client_ref: 'a', place_of_supply: '19', customer_gstin: null, invoice_no: 'A/26-27/0001' }],
    saleLines: [{ sale_ref: 'a', gst_rate_bps: 1800, taxable_paise: 4237, cgst_paise: 381, sgst_paise: 382, igst_paise: 0, tax_code: '1006', unit: 'KGS', name: 'Rice', qty: 1 }],
  });
  const out = await gstr1({ DB: db }, '042026');
  assert.deepEqual(Object.keys(out).sort(), ['data', 'fp', 'gstin', 'validation']);
  assert.deepEqual(Object.keys(out.data).sort(), ['b2b', 'b2cs', 'cdnr', 'doc_issue', 'hsn_b2c']);
  assert.equal(out.validation.ok, true);
});
