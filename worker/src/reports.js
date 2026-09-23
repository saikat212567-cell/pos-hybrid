/**
 * Read-only accounting reports.
 *
 * Report money is always integer paise. Dates supplied by the API are India
 * business dates; SQL receives UTC bounds for a half-open interval.
 */

import { trialBalance } from './ledger.js';
import { stockReport } from './fifo.js';

const IST_MINUTES = 330;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidReportPeriod extends Error {}

const dateOnly = date => date.toISOString().slice(0, 10);

function validDate(value, name) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new InvalidReportPeriod(`${name} must be YYYY-MM-DD`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new InvalidReportPeriod(`${name} is not a valid calendar date`);
  }
  return value;
}

const todayInIndia = () => dateOnly(new Date(Date.now() + IST_MINUTES * 60_000));

function fyStartDate(onOrBefore, fyStart = '04-01') {
  const day = validDate(onOrBefore, 'to');
  const mmdd = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(fyStart) ? fyStart : '04-01';
  const year = Number(day.slice(0, 4)) - (day.slice(5) < mmdd ? 1 : 0);
  return `${year}-${mmdd}`;
}

async function reportPeriod(db, options = {}) {
  const to = options.to ?? todayInIndia();
  if (options.from) return periodBounds({ from: options.from, to });
  const setting = await db.prepare("SELECT value FROM settings WHERE key = 'fy_start'").first();
  return periodBounds({ from: fyStartDate(to, setting?.value ?? '04-01'), to });
}

/** Convert an India calendar date to the UTC timestamp at its IST midnight. */
export function istStart(date) {
  const day = validDate(date, 'date');
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_MINUTES * 60_000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Normalise an inclusive business-date range to [from, to_exclusive).
 * `to` remains the supplied inclusive date in the response for UI display.
 */
export function periodBounds({ from = '1970-01-01', to = todayInIndia() } = {}) {
  const start = validDate(from, 'from');
  const end = validDate(to, 'to');
  if (start > end) throw new InvalidReportPeriod('from must not be after to');
  const next = new Date(`${end}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const toExclusiveDate = dateOnly(next);
  return {
    timezone: 'Asia/Kolkata',
    from: start,
    to: end,
    to_exclusive: toExclusiveDate,
    from_utc: istStart(start),
    to_exclusive_utc: istStart(toExclusiveDate),
  };
}

export function asOfBounds({ as_of = todayInIndia() } = {}) {
  const day = validDate(as_of, 'as_of');
  const { to_exclusive, to_exclusive_utc } = periodBounds({ from: day, to: day });
  return { as_of: day, to_exclusive, to_exclusive_utc };
}

const money = value => Number(value ?? 0);
const natural = (type, raw) => type === 'asset' || type === 'expense' ? money(raw) : -money(raw);
const sum = (rows, key) => rows.reduce((total, row) => total + money(row[key]), 0);
const accountSql = `
  SELECT a.code, a.name, a.type,
         COALESCE(SUM(CASE WHEN v.date < ? THEN vl.debit_paise - vl.credit_paise ELSE 0 END), 0) AS opening_raw_paise,
         COALESCE(SUM(CASE WHEN v.date >= ? AND v.date < ? THEN vl.debit_paise - vl.credit_paise ELSE 0 END), 0) AS movement_raw_paise,
         COALESCE(SUM(CASE WHEN v.date < ? THEN vl.debit_paise - vl.credit_paise ELSE 0 END), 0) AS closing_raw_paise
    FROM accounts a
    LEFT JOIN voucher_lines vl ON vl.account_code = a.code
    LEFT JOIN vouchers v ON v.id = vl.voucher_id
   GROUP BY a.code, a.name, a.type
   ORDER BY a.code`;

async function accountRolls(db, bounds, fromUtc = bounds.from_utc) {
  const { results } = await db.prepare(accountSql)
    .bind(fromUtc, fromUtc, bounds.to_exclusive_utc, bounds.to_exclusive_utc).all();
  return results.map(row => ({
    code: row.code, name: row.name, type: row.type,
    opening_paise: natural(row.type, row.opening_raw_paise),
    movement_paise: natural(row.type, row.movement_raw_paise),
    closing_paise: natural(row.type, row.closing_raw_paise),
  }));
}

const reportMeta = period => ({
  period: {
    timezone: period.timezone,
    from: period.from,
    to: period.to,
    to_exclusive: period.to_exclusive,
  },
  currency: 'INR',
  unit: 'paise',
});

/**
 * Raw debit/credit control report. Reuses trialBalance() rather than
 * reimplementing it; `net` stays the thing to assert on.
 *
 * Business dates (YYYY-MM-DD) are converted to half-open IST bounds. Anything
 * else is passed through verbatim, so a caller that already sends a raw
 * timestamp — as this route accepted before reports existed — keeps working.
 */
export async function reportTrialBalance(db, options = {}) {
  const { from, to } = options;
  if (!from && !to) {
    const tb = await trialBalance(db);
    return { ...tb, balanced: tb.net === 0 };
  }
  const businessDates = (!from || DATE_RE.test(from)) && (!to || DATE_RE.test(to));
  if (!businessDates) {
    const tb = await trialBalance(db, { from: from ?? null, to: to ?? null });
    return { ...tb, balanced: tb.net === 0 };
  }
  const period = periodBounds({ from: from ?? undefined, to: to ?? undefined });
  const tb = await trialBalance(db, { from: period.from_utc, to: period.to_exclusive_utc });
  return { ...reportMeta(period), ...tb, balanced: tb.net === 0 };
}

export async function reportProfitLoss(db, options = {}) {
  const period = await reportPeriod(db, options);
  const { results } = await db.prepare(
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(vl.debit_paise), 0) AS debit_paise,
            COALESCE(SUM(vl.credit_paise), 0) AS credit_paise
       FROM accounts a
       JOIN voucher_lines vl ON vl.account_code = a.code
       JOIN vouchers v ON v.id = vl.voucher_id
      WHERE a.type IN ('income', 'expense')
        AND v.date >= ? AND v.date < ?
      GROUP BY a.code, a.name, a.type
      ORDER BY a.code`
  ).bind(period.from_utc, period.to_exclusive_utc).all();

  const lines = results.map(row => ({
    code: row.code,
    name: row.name,
    type: row.type,
    amount_paise: row.type === 'income'
      ? money(row.credit_paise) - money(row.debit_paise)
      : money(row.debit_paise) - money(row.credit_paise),
  })).filter(row => row.amount_paise !== 0);
  const goods = lines.filter(row => row.code === '4000').reduce((s, r) => s + r.amount_paise, 0);
  const services = lines.filter(row => row.code === '4100').reduce((s, r) => s + r.amount_paise, 0);
  const otherRevenue = lines.filter(row => row.type === 'income' && !['4000', '4100'].includes(row.code))
    .reduce((s, r) => s + r.amount_paise, 0);
  const cogs = lines.find(row => row.code === '5000')?.amount_paise ?? 0;
  const expenses = lines.filter(row => row.type === 'expense' && row.code !== '5000');
  const totalRevenue = goods + services + otherRevenue;
  const totalExpenses = cogs + sum(expenses, 'amount_paise');

  const zeroCost = await db.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM cogs_allocations ca
       JOIN sale_lines sl ON sl.id = ca.sale_line_id
       JOIN sales s ON s.client_ref = sl.sale_ref
       JOIN stock_lots l ON l.id = ca.lot_id
      WHERE s.sold_at >= ? AND s.sold_at < ? AND l.cost_in_paise = 0
     ) AS found`
  ).bind(period.from_utc, period.to_exclusive_utc).first();

  return {
    ...reportMeta(period),
    revenue: {
      goods_paise: goods,
      services_paise: services,
      other_paise: otherRevenue,
      total_paise: totalRevenue,
    },
    cost_of_goods_sold_paise: cogs,
    gross_profit_paise: totalRevenue - cogs,
    expenses,
    total_other_expenses_paise: sum(expenses, 'amount_paise'),
    net_profit_paise: totalRevenue - totalExpenses,
    zero_cost_opening_stock_caveat: Boolean(zeroCost?.found),
  };
}

export async function reportBalanceSheet(db, options = {}) {
  const to = options.as_of ?? options.to ?? todayInIndia();
  const period = await reportPeriod(db, { from: options.from, to });
  const rolls = await accountRolls(db, period, period.from_utc);
  const closing = rolls.filter(row => row.closing_paise !== 0);
  const assets = closing.filter(row => row.type === 'asset');
  const liabilities = closing.filter(row => row.type === 'liability');
  const equity = closing.filter(row => row.type === 'equity');
  const income = closing.filter(row => row.type === 'income');
  const expenses = closing.filter(row => row.type === 'expense');
  const earnings = sum(income, 'closing_paise') - sum(expenses, 'closing_paise');
  const periodNetProfit = sum(income, 'movement_paise') - sum(expenses, 'movement_paise');
  const assetsTotal = sum(assets, 'closing_paise');
  const liabilitiesTotal = sum(liabilities, 'closing_paise');
  const postedEquity = sum(equity, 'closing_paise');
  const liabilitiesAndEquity = liabilitiesTotal + postedEquity + earnings;

  const group = codes => closing.filter(row => codes.includes(row.code));
  const grouped = codes => sum(group(codes), 'closing_paise');
  return {
    ...reportMeta(period),
    as_of: period.to,
    assets: {
      accounts: assets,
      cash_paise: grouped(['1000']),
      bank_paise: grouped(['1010']),
      sundry_debtors_paise: grouped(['1100']),
      stock_in_hand_paise: grouped(['1200']),
      input_gst_paise: grouped(['1300', '1310', '1320']),
      other_assets_paise: sum(assets, 'closing_paise') - grouped(['1000', '1010', '1100', '1200', '1300', '1310', '1320']),
    },
    liabilities: {
      accounts: liabilities,
      sundry_creditors_paise: grouped(['2000']),
      output_gst_paise: grouped(['2100', '2110', '2120']),
      other_liabilities_paise: sum(liabilities, 'closing_paise') - grouped(['2000', '2100', '2110', '2120']),
    },
    equity: {
      accounts: equity,
      capital_paise: grouped(['3000']),
      opening_stock_adjustment_paise: grouped(['3100']),
      other_equity_paise: sum(equity, 'closing_paise') - grouped(['3000', '3100']),
    },
    account_rolls: rolls,
    earnings_to_date_paise: earnings,
    period_net_profit_paise: periodNetProfit,
    totals: {
      assets_paise: assetsTotal,
      liabilities_and_equity_paise: liabilitiesAndEquity,
    },
    balanced: assetsTotal === liabilitiesAndEquity,
  };
}

export async function reportSalesRegister(db, options = {}) {
  const period = await reportPeriod(db, options);
  const { results } = await db.prepare(
    `SELECT 'sale' AS document_type, s.sold_at AS document_date,
            s.client_ref AS document_ref, s.invoice_no AS document_no,
            NULL AS original_invoice_no, s.place_of_supply, s.customer_gstin,
            s.taxable_paise, s.cgst_paise, s.sgst_paise, s.igst_paise,
            s.round_off_paise, s.total_paise, s.cogs_paise,
            s.payment_mode, 1 AS tax_adjusted
       FROM sales s
      WHERE s.sold_at >= ? AND s.sold_at < ?
      ORDER BY document_date, document_ref`
  ).bind(period.from_utc, period.to_exclusive_utc).all();
  const documents = results.map(row => ({
    ...row,
    taxable_paise: money(row.taxable_paise),
    cgst_paise: money(row.cgst_paise),
    sgst_paise: money(row.sgst_paise),
    igst_paise: money(row.igst_paise),
    round_off_paise: money(row.round_off_paise),
    total_paise: money(row.total_paise),
    cogs_paise: money(row.cogs_paise),
    gst_return_cgst_paise: money(row.cgst_paise),
    gst_return_sgst_paise: money(row.sgst_paise),
    gst_return_igst_paise: money(row.igst_paise),
    gst_not_recoverable_paise: 0,
  }));
  return {
    ...reportMeta(period),
    documents,
    count: documents.length,
    totals: {
      taxable_paise: sum(documents, 'taxable_paise'),
      cgst_paise: sum(documents, 'cgst_paise'),
      sgst_paise: sum(documents, 'sgst_paise'),
      igst_paise: sum(documents, 'igst_paise'),
      total_paise: sum(documents, 'total_paise'),
      cogs_paise: sum(documents, 'cogs_paise'),
      gst_return_cgst_paise: sum(documents, 'gst_return_cgst_paise'),
      gst_return_sgst_paise: sum(documents, 'gst_return_sgst_paise'),
      gst_return_igst_paise: sum(documents, 'gst_return_igst_paise'),
    },
    credit_notes: { available: false, todo: 'Add the documented credit_notes UNION when the refund migration lands.' },
  };
}

export async function reportPurchaseRegister(db, options = {}) {
  const period = await reportPeriod(db, options);
  const { results } = await db.prepare(
    `SELECT p.id AS purchase_id, p.invoice_date, p.supplier_name,
            p.supplier_gstin, p.supplier_inv_no, p.payment_mode,
            p.taxable_paise, p.cgst_paise, p.sgst_paise, p.igst_paise,
            p.total_paise,
            COALESCE(SUM(l.cost_in_paise), 0) AS stock_added_paise,
            COALESCE(SUM(pl.qty), 0) AS quantity_received
       FROM purchases p
       LEFT JOIN purchase_lines pl ON pl.purchase_id = p.id
       LEFT JOIN stock_lots l ON l.purchase_line_id = pl.id
      WHERE p.invoice_date >= ? AND p.invoice_date < ?
      GROUP BY p.id
      ORDER BY p.invoice_date, p.id`
  ).bind(period.from_utc, period.to_exclusive_utc).all();
  const purchases = results.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, key.endsWith('_paise') || key === 'quantity_received' ? money(value) : value])
  ));
  return { ...reportMeta(period), purchases, count: purchases.length,
    totals: {
      taxable_paise: sum(purchases, 'taxable_paise'), cgst_paise: sum(purchases, 'cgst_paise'),
      sgst_paise: sum(purchases, 'sgst_paise'), igst_paise: sum(purchases, 'igst_paise'),
      total_paise: sum(purchases, 'total_paise'), stock_added_paise: sum(purchases, 'stock_added_paise'),
    },
    purchase_returns: { available: false, todo: 'Add supplier debit notes when that feature is implemented.' },
  };
}

// Credit notes (return_to_stock / return_written_off / new_lot events) are not
// in this schema yet — see docs/phase3-refund-design.md. When migration 0004
// lands, UNION in return_allocations here exactly as that doc's stock_events
// CTE does, and exclude new_lot receipts from the plain stock_lots branch.
async function stockEvents(db, endUtc) {
  const { results } = await db.prepare(
    `SELECT l.product_id, l.received_at AS occurred_at, 'receipt' AS event_type,
            l.id AS event_id, l.qty_in AS qty_delta, l.cost_in_paise AS value_delta
       FROM stock_lots l
      WHERE l.received_at < ?
      UNION ALL
     SELECT sl.product_id, s.sold_at, 'sale', ca.id, -ca.qty, -ca.cost_paise
       FROM cogs_allocations ca
       JOIN sale_lines sl ON sl.id = ca.sale_line_id
       JOIN sales s ON s.client_ref = sl.sale_ref
      WHERE s.sold_at < ?
      ORDER BY occurred_at, event_type, event_id`
  ).bind(endUtc, endUtc).all();
  return results;
}

export async function reportStockRegister(db, options = {}) {
  const bounds = asOfBounds(options);
  const period = await reportPeriod(db, { from: options.from, to: bounds.as_of });
  const events = await stockEvents(db, bounds.to_exclusive_utc);
  const { results: products } = await db.prepare(
    `SELECT id, name, unit, tax_code FROM products WHERE kind = 'good' ORDER BY name`
  ).all();
  // returned_*/written_off_* stay 0 until migration 0004 adds return_allocations
  // events into stockEvents() above — there is nothing to return or write off yet.
  const byProduct = new Map(products.map(product => [product.id, {
    ...product, opening_qty: 0, opening_value_paise: 0, received_qty: 0,
    received_value_paise: 0, sold_qty: 0, sold_value_paise: 0,
    returned_qty: 0, returned_value_paise: 0, written_off_qty: 0,
    written_off_value_paise: 0, closing_qty: 0, closing_value_paise: 0, movements: [],
  }]));
  // Opening is everything before the period; received/sold are the period's own
  // movements; closing is opening plus those movements, i.e. every event up to
  // the as-of instant. Folding pre-period receipts into `received` would make a
  // one-day report claim the whole year's purchases.
  const startUtc = period.from_utc;
  for (const event of events) {
    const item = byProduct.get(event.product_id);
    if (!item) continue;
    const qty = money(event.qty_delta);
    const value = money(event.value_delta);
    item.closing_qty += qty;
    item.closing_value_paise += value;
    if (event.occurred_at < startUtc) {
      item.opening_qty += qty;
      item.opening_value_paise += value;
      continue;                      // not a movement of this period
    }
    if (event.event_type === 'receipt') {
      item.received_qty += qty; item.received_value_paise += value;
    } else if (event.event_type === 'sale') {
      item.sold_qty += -qty; item.sold_value_paise += -value;
    }
    item.movements.push({ ...event, qty_delta: qty, value_delta_paise: value });
  }
  const items = [...byProduct.values()];
  // A current snapshot also gets the direct lot rows as drill-down proof of the
  // closing total — alongside, never silently replacing it. If the two ever
  // disagree, that is exactly what reportStockIntegrity below exists to catch;
  // overwriting one with the other here would hide the disagreement instead.
  const isCurrent = !options.as_of || options.as_of === todayInIndia();
  const currentLots = isCurrent ? await stockReport(db) : undefined;
  const totals = {
    opening_qty: sum(items, 'opening_qty'), opening_value_paise: sum(items, 'opening_value_paise'),
    received_qty: sum(items, 'received_qty'), received_value_paise: sum(items, 'received_value_paise'),
    sold_qty: sum(items, 'sold_qty'), sold_value_paise: sum(items, 'sold_value_paise'),
    closing_qty: sum(items, 'closing_qty'), closing_value_paise: sum(items, 'closing_value_paise'),
  };
  const reconciliation = await reportStockIntegrity(db, { as_of: bounds.as_of });
  return { ...reportMeta(period), as_of: bounds.as_of, items, current_lots: currentLots, totals, reconciliation };
}

/**
 * Lot-subledger value versus the Stock in Hand control account, at the same
 * instant. A nonzero difference is an integrity failure, not rounding — see
 * docs/phase3-reports.md. Never overwrite one figure from the other.
 */
export async function reportStockIntegrity(db, options = {}) {
  const bounds = asOfBounds(options);
  const isCurrent = !options.as_of || options.as_of === todayInIndia();

  // Current: stock_lots.cost_remaining_paise is the live carrying value, with
  // no date filter (that is what "remaining" already means). Historical: that
  // column only reflects today's state, so reconstruct the as-of value from
  // the same immutable event stream the stock register uses.
  const fifoValue = isCurrent
    ? money((await db.prepare(
        'SELECT COALESCE(SUM(cost_remaining_paise), 0) AS value_paise FROM stock_lots'
      ).first())?.value_paise)
    : (await stockEvents(db, bounds.to_exclusive_utc))
        .reduce((total, row) => total + money(row.value_delta), 0);

  const ledger = await db.prepare(
    `SELECT COALESCE(SUM(vl.debit_paise - vl.credit_paise), 0) AS value_paise
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
      WHERE vl.account_code = '1200' AND v.date < ?`
  ).bind(bounds.to_exclusive_utc).first();
  const ledgerValue = money(ledger?.value_paise);

  return {
    as_of: bounds.as_of,
    currency: 'INR', unit: 'paise',
    fifo_stock_paise: fifoValue,
    stock_in_hand_paise: ledgerValue,
    difference_paise: fifoValue - ledgerValue,
    reconciled: fifoValue === ledgerValue,
  };
}

export async function reportCashBook(db, options = {}) {
  const period = await reportPeriod(db, options);
  const openingRow = await db.prepare(
    `SELECT COALESCE(SUM(vl.debit_paise - vl.credit_paise), 0) AS opening_paise
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
      WHERE vl.account_code = '1000' AND v.date < ?`
  ).bind(period.from_utc).first();
  const { results } = await db.prepare(
    `SELECT v.id AS voucher_id, v.date, v.type, v.ref, v.narration,
            vl.id AS line_id, vl.debit_paise AS receipt_paise,
            vl.credit_paise AS payment_paise,
            vl.debit_paise - vl.credit_paise AS movement_paise
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
      WHERE vl.account_code = '1000' AND v.date >= ? AND v.date < ?
      ORDER BY v.date, v.id, vl.id`
  ).bind(period.from_utc, period.to_exclusive_utc).all();
  let running = money(openingRow?.opening_paise);
  const entries = results.map(row => ({ ...row, receipt_paise: money(row.receipt_paise),
    payment_paise: money(row.payment_paise), movement_paise: money(row.movement_paise),
    running_balance_paise: running += money(row.movement_paise) }));
  return { ...reportMeta(period), account_code: '1000', opening_paise: money(openingRow?.opening_paise),
    entries, closing_paise: running,
    totals: { receipts_paise: sum(entries, 'receipt_paise'), payments_paise: sum(entries, 'payment_paise') } };
}

export async function reportDayBook(db, options = {}) {
  const period = await reportPeriod(db, options);
  const { results } = await db.prepare(
    `SELECT v.id AS voucher_id, v.date, v.type, v.ref, v.narration,
            vl.id AS line_id, vl.account_code, a.name AS account_name,
            vl.debit_paise, vl.credit_paise
       FROM vouchers v JOIN voucher_lines vl ON vl.voucher_id = v.id
       JOIN accounts a ON a.code = vl.account_code
      WHERE v.date >= ? AND v.date < ?
      ORDER BY v.date, v.id, vl.id`
  ).bind(period.from_utc, period.to_exclusive_utc).all();
  const groups = new Map();
  for (const row of results) {
    if (!groups.has(row.voucher_id)) groups.set(row.voucher_id, {
      voucher_id: row.voucher_id, date: row.date, type: row.type, ref: row.ref,
      narration: row.narration, debit_paise: 0, credit_paise: 0, lines: [],
    });
    const voucher = groups.get(row.voucher_id);
    const line = { ...row, debit_paise: money(row.debit_paise), credit_paise: money(row.credit_paise) };
    voucher.lines.push(line); voucher.debit_paise += line.debit_paise; voucher.credit_paise += line.credit_paise;
  }
  const vouchers = [...groups.values()];
  if (vouchers.some(voucher => voucher.debit_paise !== voucher.credit_paise)) {
    throw new Error('unbalanced voucher in day book');
  }
  return { ...reportMeta(period), vouchers, count: vouchers.length,
    totals: { debit_paise: sum(vouchers, 'debit_paise'), credit_paise: sum(vouchers, 'credit_paise') } };
}

