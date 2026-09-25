import { normalizeStateCode } from './gst.js';

const IST_OFFSET_MS = 330 * 60 * 1000;
const HSN = /^(?:\d{4}|\d{6}|\d{8})$/;
const UQC = /^[A-Za-z]+$/;
const INVOICE_NO = /^[A-Za-z0-9/-]{1,16}$/;

export class GstrError extends Error {
  constructor(message, status = 400, body = {}) {
    super(message);
    this.status = status;
    this.body = { error: message, ...body };
  }
}

const asRows = async statement => (await statement.all()).results;
const query = (db, sql, ...binds) => asRows(db.prepare(sql).bind(...binds));
const zeroTax = () => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });

/**
 * Convert integer paise without binary division. JSON has no fixed-scale number
 * type, so 25.10 serializes as 25.1, while remaining numerically ₹25.10.
 */
export function paiseToRupees(paise) {
  if (!Number.isSafeInteger(paise)) throw new TypeError('paise must be a safe integer');
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);
  return Number(`${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`);
}

const rateToPercent = bps => {
  if (!Number.isSafeInteger(bps)) throw new TypeError('gst_rate_bps must be an integer');
  const sign = bps < 0 ? '-' : '';
  const absolute = Math.abs(bps);
  return Number(`${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`);
};

const sqliteUtc = date => date.toISOString().replace('T', ' ').replace('.000Z', '');

/** Current filing period in India's business calendar, including UTC boundaries. */
export function currentPeriod(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return `${String(ist.getUTCMonth() + 1).padStart(2, '0')}${ist.getUTCFullYear()}`;
}

/** Validate a GST return period and calculate its IST calendar bounds in UTC. */
export function periodParts(period) {
  if (typeof period !== 'string' || !/^(0[1-9]|1[0-2])\d{4}$/.test(period)) {
    throw new GstrError('period must be MMYYYY, for example 042026');
  }
  const month = Number(period.slice(0, 2));
  const year = Number(period.slice(2));
  if (year === 0) throw new GstrError('period must contain a non-zero four-digit year');
  const from = new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS);
  const to = new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS);
  return { period, month, year, from: sqliteUtc(from), to: sqliteUtc(to) };
}

const settingsFor = async db => Object.fromEntries(
  (await query(db, 'SELECT key, value FROM settings')).map(row => [row.key, row.value])
);

const tableExists = async (db, name) => Boolean(await db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
).bind(name).first());

const canonicalPos = (value, fallback) => {
  const raw = value ?? fallback;
  const normalized = normalizeStateCode(raw);
  return typeof raw === 'string' && raw === normalized ? normalized : null;
};

const issue = (field, rows, message) => ({
  field,
  client_refs: [...new Set(rows.map(row => row.client_ref))],
  message,
});

/**
 * This is deliberately exposed through ?preflight=1 on the two export routes,
 * rather than a third route: the export's own validation sees the exact filing
 * period and cannot be skipped by a caller that downloads JSON directly.
 */
export async function preflight(db, settings, period) {
  const { from, to } = periodParts(period);
  const sales = await query(db,
    `SELECT client_ref, place_of_supply, invoice_no
       FROM sales WHERE sold_at >= ? AND sold_at < ?`, from, to);
  const lines = await query(db,
    `SELECT sl.sale_ref AS client_ref, sl.tax_code, sl.unit
       FROM sale_lines sl JOIN sales s ON s.client_ref = sl.sale_ref
      WHERE s.sold_at >= ? AND s.sold_at < ?`, from, to);
  const errors = [];
  const badPos = sales.filter(row => !canonicalPos(row.place_of_supply, settings.state_code));
  if (badPos.length) errors.push(issue(
    'place_of_supply', badPos,
    'place_of_supply must be a canonical GST state code; correct these documents before filing'
  ));
  const badInvoices = sales.filter(row => !INVOICE_NO.test(row.invoice_no ?? ''));
  if (badInvoices.length) errors.push(issue(
    'invoice_no', badInvoices,
    'invoice_no must be 1-16 letters, digits, hyphens or slashes'
  ));
  const badCodes = lines.filter(row => !HSN.test(row.tax_code ?? ''));
  if (badCodes.length) errors.push(issue(
    'tax_code', badCodes,
    'tax_code must be a 4, 6 or 8 digit HSN/SAC'
  ));
  const badUqc = lines.filter(row => !UQC.test(row.unit ?? ''));
  if (badUqc.length) errors.push(issue('unit', badUqc, 'UQC must contain letters only'));

  // TODO(refunds): This exact query is enabled when the separately-owned
  // 0004_refunds migration creates credit_notes. Do not add that schema here.
  if (await tableExists(db, 'credit_notes')) {
    const notes = await query(db,
      `SELECT client_ref, place_of_supply, note_no
         FROM credit_notes WHERE note_date >= ? AND note_date < ?`, from, to);
    const badNotePos = notes.filter(row => !canonicalPos(row.place_of_supply, settings.state_code));
    if (badNotePos.length) errors.push(issue(
      'credit_note.place_of_supply', badNotePos,
      'credit note place_of_supply must be a canonical GST state code'
    ));
    const badNotes = notes.filter(row => !INVOICE_NO.test(row.note_no ?? ''));
    if (badNotes.length) errors.push(issue(
      'credit_note.note_no', badNotes,
      'credit note number must be 1-16 letters, digits, hyphens or slashes'
    ));
  }

  return { ok: errors.length === 0, errors };
}

const add = (map, key, row) => {
  const existing = map.get(key) ?? {
    pos: row.pos,
    rate: row.gst_rate_bps,
    taxable_paise: 0,
    igst_paise: 0,
    cgst_paise: 0,
    sgst_paise: 0,
    cess_paise: 0,
  };
  for (const field of ['taxable_paise', 'igst_paise', 'cgst_paise', 'sgst_paise', 'cess_paise']) {
    existing[field] += row[field] ?? 0;
  }
  map.set(key, existing);
};

const portalTax = row => ({
  txval: paiseToRupees(row.taxable_paise),
  iamt: paiseToRupees(row.igst_paise),
  camt: paiseToRupees(row.cgst_paise),
  samt: paiseToRupees(row.sgst_paise),
  csamt: paiseToRupees(row.cess_paise ?? 0),
});

/** Table 7: B2C supplies, net of ordinary B2C credit notes when available. */
export async function b2csRows(db, settings, period) {
  const { from, to } = periodParts(period);
  const sales = await query(db,
    `SELECT s.place_of_supply AS pos, sl.gst_rate_bps,
            SUM(sl.taxable_paise) AS taxable_paise, SUM(sl.igst_paise) AS igst_paise,
            SUM(sl.cgst_paise) AS cgst_paise, SUM(sl.sgst_paise) AS sgst_paise
       FROM sales s JOIN sale_lines sl ON sl.sale_ref = s.client_ref
      WHERE s.sold_at >= ? AND s.sold_at < ?
        AND COALESCE(TRIM(s.customer_gstin), '') = ''
      GROUP BY s.place_of_supply, sl.gst_rate_bps`, from, to);
  const grouped = new Map();
  for (const row of sales) {
    const pos = canonicalPos(row.pos, settings.state_code);
    add(grouped, `${pos}:${row.gst_rate_bps}`, { ...row, pos, cess_paise: 0 });
  }

  // TODO(refunds): gstr1_table freezes the correct bucket at note issue. The
  // direct table check keeps this deployment compatible until 0004 exists.
  if (await tableExists(db, 'credit_notes')) {
    const notes = await query(db,
      `SELECT cn.place_of_supply AS pos, cnl.gst_rate_bps,
              -SUM(cnl.taxable_paise) AS taxable_paise, -SUM(cnl.igst_paise) AS igst_paise,
              -SUM(cnl.cgst_paise) AS cgst_paise, -SUM(cnl.sgst_paise) AS sgst_paise
         FROM credit_notes cn JOIN credit_note_lines cnl ON cnl.note_ref = cn.client_ref
        WHERE cn.note_date >= ? AND cn.note_date < ?
          AND cn.tax_adjusted = 1 AND cn.gstr1_table = 'b2cs_net'
        GROUP BY cn.place_of_supply, cnl.gst_rate_bps`, from, to);
    for (const row of notes) {
      const pos = canonicalPos(row.pos, settings.state_code);
      add(grouped, `${pos}:${row.gst_rate_bps}`, { ...row, pos, cess_paise: 0 });
    }
  }

  return [...grouped.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate).map(row => ({
    sply_ty: row.pos === settings.state_code ? 'INTRA' : 'INTER',
    pos: row.pos,
    typ: 'OE',
    rt: rateToPercent(row.rate),
    ...portalTax(row),
  }));
}

/** GSTR-1 B2B invoice rows; this data must never be quietly omitted from B2C. */
export async function b2bRows(db, settings, period) {
  const { from, to } = periodParts(period);
  const rows = await query(db,
    `SELECT s.client_ref, s.customer_gstin, s.invoice_no, s.sold_at, s.total_paise,
            s.place_of_supply AS pos, sl.gst_rate_bps, sl.taxable_paise, sl.igst_paise,
            sl.cgst_paise, sl.sgst_paise
       FROM sales s JOIN sale_lines sl ON sl.sale_ref = s.client_ref
      WHERE s.sold_at >= ? AND s.sold_at < ?
        AND COALESCE(TRIM(s.customer_gstin), '') <> ''
      ORDER BY s.customer_gstin, s.sold_at, s.client_ref, sl.id`, from, to);
  const invoices = new Map();
  for (const row of rows) {
    const invoice = invoices.get(row.client_ref) ?? {
      ctin: row.customer_gstin,
      inum: row.invoice_no,
      idt: documentDate(row.sold_at),
      val: paiseToRupees(row.total_paise),
      pos: canonicalPos(row.pos, settings.state_code),
      rchrg: 'N',
      inv_typ: 'R',
      itms: [],
    };
    invoice.itms.push({
      num: invoice.itms.length + 1,
      itm_det: { rt: rateToPercent(row.gst_rate_bps), ...portalTax(row) },
    });
    invoices.set(row.client_ref, invoice);
  }
  const buyers = new Map();
  for (const invoice of invoices.values()) {
    const buyer = buyers.get(invoice.ctin) ?? { ctin: invoice.ctin, inv: [] };
    const { ctin, ...portalInvoice } = invoice;
    buyer.inv.push(portalInvoice);
    buyers.set(invoice.ctin, buyer);
  }
  return [...buyers.values()];
}

/** Table 12 HSN/SAC summary, net of credit notes once their designed schema exists. */
export async function hsnRows(db, _settings, period) {
  const { from, to } = periodParts(period);
  const lines = await query(db,
    `SELECT sl.tax_code, sl.unit, sl.name, sl.gst_rate_bps,
            SUM(sl.qty) AS qty, SUM(sl.taxable_paise) AS taxable_paise,
            SUM(sl.igst_paise) AS igst_paise, SUM(sl.cgst_paise) AS cgst_paise,
            SUM(sl.sgst_paise) AS sgst_paise
       FROM sale_lines sl JOIN sales s ON s.client_ref = sl.sale_ref
      WHERE s.sold_at >= ? AND s.sold_at < ?
      GROUP BY sl.tax_code, sl.unit, sl.name, sl.gst_rate_bps`, from, to);
  const grouped = new Map();
  const addHsn = row => {
    const key = `${row.tax_code}:${row.unit}:${row.gst_rate_bps}`;
    const item = grouped.get(key) ?? { ...row, qty: 0, taxable_paise: 0, igst_paise: 0, cgst_paise: 0, sgst_paise: 0 };
    for (const field of ['qty', 'taxable_paise', 'igst_paise', 'cgst_paise', 'sgst_paise']) item[field] += row[field] ?? 0;
    grouped.set(key, item);
  };
  lines.forEach(addHsn);

  if (await tableExists(db, 'credit_notes')) {
    const credits = await query(db,
      `SELECT cnl.tax_code, cnl.unit, cnl.name, cnl.gst_rate_bps,
              -SUM(cnl.qty) AS qty, -SUM(cnl.taxable_paise) AS taxable_paise,
              -SUM(cnl.igst_paise) AS igst_paise, -SUM(cnl.cgst_paise) AS cgst_paise,
              -SUM(cnl.sgst_paise) AS sgst_paise
         FROM credit_notes cn JOIN credit_note_lines cnl ON cnl.note_ref = cn.client_ref
        WHERE cn.note_date >= ? AND cn.note_date < ? AND cn.tax_adjusted = 1
        GROUP BY cnl.tax_code, cnl.unit, cnl.name, cnl.gst_rate_bps`, from, to);
    credits.forEach(addHsn);
  }

  return [...grouped.values()].sort((a, b) => a.tax_code.localeCompare(b.tax_code)).map((row, index) => ({
    num: index + 1,
    hsn_sc: row.tax_code,
    desc: row.name,
    uqc: row.unit,
    qty: row.qty,
    rt: rateToPercent(row.gst_rate_bps),
    ...portalTax(row),
  }));
}

const seriesOf = invoiceNo => invoiceNo.slice(0, invoiceNo.lastIndexOf('/'));

/** Table 13 document issue ranges from documents actually issued in the period. */
export async function docIssueRows(db, _settings, period) {
  const { from, to } = periodParts(period);
  const sales = await query(db,
    `SELECT invoice_no FROM sales WHERE sold_at >= ? AND sold_at < ?`, from, to);
  const documents = sales.map(row => ({ type: 1, no: row.invoice_no }));
  if (await tableExists(db, 'credit_notes')) {
    const notes = await query(db,
      `SELECT note_no FROM credit_notes WHERE note_date >= ? AND note_date < ?`, from, to);
    documents.push(...notes.map(row => ({ type: 5, no: row.note_no })));
  }
  const groups = new Map();
  for (const document of documents) {
    const key = `${document.type}:${seriesOf(document.no)}`;
    const numbers = groups.get(key) ?? [];
    numbers.push(document.no);
    groups.set(key, numbers);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, numbers]) => {
    const [doc_num] = key.split(':');
    numbers.sort();
    return {
      doc_num: Number(doc_num),
      docs: [{ num: 1, from: numbers[0], to: numbers.at(-1), totnum: numbers.length, cancel: 0, net_issue: numbers.length }],
    };
  });
}

/** Registered-recipient credit notes, omitted until the refund migration exists. */
export async function cdnrRows(db, _settings, period) {
  if (!(await tableExists(db, 'credit_notes'))) return [];
  const { from, to } = periodParts(period);
  const rows = await query(db,
    `SELECT cn.client_ref, cn.customer_gstin, cn.note_no, cn.note_date,
            cn.original_invoice_no, cn.original_invoice_date, cn.total_paise,
            cnl.gst_rate_bps, cnl.taxable_paise, cnl.igst_paise, cnl.cgst_paise, cnl.sgst_paise
       FROM credit_notes cn JOIN credit_note_lines cnl ON cnl.note_ref = cn.client_ref
      WHERE cn.note_date >= ? AND cn.note_date < ?
        AND cn.tax_adjusted = 1 AND cn.gstr1_table = 'cdnr'
      ORDER BY cn.customer_gstin, cn.note_date, cn.client_ref, cnl.id`, from, to);
  const notes = new Map();
  for (const row of rows) {
    const note = notes.get(row.client_ref) ?? {
      ctin: row.customer_gstin,
      nt_num: row.note_no,
      nt_dt: documentDate(row.note_date),
      ntty: 'C',
      p_gst: 'N',
      rsn: '01',
      inum: row.original_invoice_no,
      idt: documentDate(row.original_invoice_date),
      val: paiseToRupees(row.total_paise),
      itms: [],
    };
    note.itms.push({ num: note.itms.length + 1, itm_det: { rt: rateToPercent(row.gst_rate_bps), ...portalTax(row) } });
    notes.set(row.client_ref, note);
  }
  const buyers = new Map();
  for (const note of notes.values()) {
    const buyer = buyers.get(note.ctin) ?? { ctin: note.ctin, nt: [] };
    buyer.nt.push(note);
    buyers.set(note.ctin, buyer);
  }
  return [...buyers.values()];
}

const documentDate = date => {
  const match = String(date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
};

const refusal = registration => {
  if (registration === 'composition') {
    return 'GSTR-1/GSTR-3B are unavailable for a composition dealer; file CMP-08 and GSTR-4 instead';
  }
  return 'GSTR-1/GSTR-3B are unavailable because an unregistered business has no GST return to file';
};

const envelope = (settings, period, data, validation) => ({
  gstin: settings.gstin ?? '',
  fp: period,
  data,
  validation,
});

const requireRegular = settings => {
  const registration = settings.gst_registration ?? 'regular';
  if (registration !== 'regular') throw new GstrError(refusal(registration), 422, { registration });
};

export async function gstr1(env, period, { preflightOnly = false } = {}) {
  const settings = await settingsFor(env.DB);
  requireRegular(settings);
  const validation = await preflight(env.DB, settings, period);
  if (preflightOnly || !validation.ok) {
    const body = envelope(settings, period, null, validation);
    if (!validation.ok && !preflightOnly) {
      throw new GstrError('GSTR-1 preflight failed; correct the listed documents before export', 422, body);
    }
    return body;
  }
  return envelope(settings, period, {
    b2b: await b2bRows(env.DB, settings, period),
    b2cs: await b2csRows(env.DB, settings, period),
    hsn_b2c: await hsnRows(env.DB, settings, period),
    doc_issue: await docIssueRows(env.DB, settings, period),
    cdnr: await cdnrRows(env.DB, settings, period),
  }, validation);
}

/** GSTR-3B derives net outward tax and ITC from posted ledger accounts. */
export async function gstr3b(env, period, { preflightOnly = false } = {}) {
  const settings = await settingsFor(env.DB);
  requireRegular(settings);
  const validation = await preflight(env.DB, settings, period);
  if (preflightOnly || !validation.ok) {
    const body = envelope(settings, period, null, validation);
    if (!validation.ok && !preflightOnly) {
      throw new GstrError('GSTR-3B preflight failed; correct the listed documents before export', 422, body);
    }
    return body;
  }
  const { from, to } = periodParts(period);
  const [row] = await query(env.DB,
    `SELECT
       COALESCE(SUM(CASE WHEN vl.account_code IN ('4000', '4100')
                         THEN vl.credit_paise - vl.debit_paise ELSE 0 END), 0) AS taxable_paise,
       COALESCE(SUM(CASE WHEN vl.account_code = '2120'
                         THEN vl.credit_paise - vl.debit_paise ELSE 0 END), 0) AS igst_paise,
       COALESCE(SUM(CASE WHEN vl.account_code = '2100'
                         THEN vl.credit_paise - vl.debit_paise ELSE 0 END), 0) AS cgst_paise,
       COALESCE(SUM(CASE WHEN vl.account_code = '2110'
                         THEN vl.credit_paise - vl.debit_paise ELSE 0 END), 0) AS sgst_paise,
       COALESCE(SUM(CASE WHEN vl.account_code = '1320'
                         THEN vl.debit_paise - vl.credit_paise ELSE 0 END), 0) AS input_igst_paise,
       COALESCE(SUM(CASE WHEN vl.account_code = '1300'
                         THEN vl.debit_paise - vl.credit_paise ELSE 0 END), 0) AS input_cgst_paise,
       COALESCE(SUM(CASE WHEN vl.account_code = '1310'
                         THEN vl.debit_paise - vl.credit_paise ELSE 0 END), 0) AS input_sgst_paise
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
      WHERE v.date >= ? AND v.date < ?`, from, to);
  const outward = portalTax(row);
  const itc = {
    txval: 0,
    iamt: paiseToRupees(row.input_igst_paise),
    camt: paiseToRupees(row.input_cgst_paise),
    samt: paiseToRupees(row.input_sgst_paise),
    csamt: 0,
  };
  return envelope(settings, period, {
    osup_det: outward,
    osup_zero: zeroTax(),
    nil_supplies: zeroTax(),
    isup_rev: zeroTax(),
    osup_nongst: zeroTax(),
    itc_elg: {
      imp_goods: zeroTax(), imp_services: zeroTax(), isrc: zeroTax(), isd: zeroTax(), oth: itc,
      itc_rev: zeroTax(), net_itc: itc, inelg: { rul_42_43: zeroTax(), others: zeroTax() },
    },
  }, validation);
}
