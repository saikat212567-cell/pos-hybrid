/**
 * Double-entry posting.
 *
 * One rule, enforced before anything is written: debits equal credits. An
 * unbalanced entry is worse than a rejected request — it silently corrupts
 * every report derived from it, and it is found months later by an accountant
 * rather than immediately by a test. So `buildVoucher` throws instead.
 *
 * Accounts are referenced by code (see the chart of accounts seeded in
 * 0002_foundation.sql), not by name, so renaming "Sundry Debtors" does not
 * break posting logic.
 */

export const ACC = {
  CASH: '1000',
  BANK: '1010',
  DEBTORS: '1100',
  STOCK: '1200',
  INPUT_CGST: '1300',
  INPUT_SGST: '1310',
  INPUT_IGST: '1320',
  CREDITORS: '2000',
  OUTPUT_CGST: '2100',
  OUTPUT_SGST: '2110',
  OUTPUT_IGST: '2120',
  SALES: '4000',
  SERVICE_INCOME: '4100',
  COGS: '5000',
  ROUND_OFF: '5900',
};

/** Where the money lands (or is owed from) for a given payment mode. */
/**
 * The payment modes that may be recorded, and the account each settles against.
 *
 * Exported so callers validate against this map rather than keeping their own
 * list that can drift from it. An unrecognised mode used to fall through to
 * Cash in Hand, so a typo ("cheque", "netbanking") silently booked a non-cash
 * sale as cash — the cash balance then never reconciles with the drawer, and
 * nothing in the books shows why.
 */
export const SETTLEMENT_ACCOUNTS = {
  cash: ACC.CASH,
  bank: ACC.BANK,
  card: ACC.BANK,
  upi: ACC.BANK,
  credit: ACC.DEBTORS,   // unpaid: the customer owes us
};

export const PAYMENT_MODES = Object.keys(SETTLEMENT_ACCOUNTS);

/**
 * Where the money lands for a given payment mode.
 *
 * Throws on an unknown mode rather than defaulting. Callers validate first, so
 * reaching this means a bug, and a loud failure beats a quietly wrong ledger.
 */
export const settlementAccount = mode => {
  const account = SETTLEMENT_ACCOUNTS[mode];
  if (!account) throw new Error(`unknown payment mode: ${mode}`);
  return account;
};

export class UnbalancedVoucher extends Error {}

const dr = (account, paise) => ({ account, debit: paise, credit: 0 });
const cr = (account, paise) => ({ account, debit: 0, credit: paise });

/**
 * Validate and prepare a voucher for writing.
 *
 * Zero-value lines are dropped before balancing: a bill with no goods should
 * not carry a COGS line of 0, and a ledger full of zeroes is harder to read
 * with no information gained.
 *
 * @returns {{lines: Array, total: number}} lines with both sides equal
 * @throws {UnbalancedVoucher}
 */
export function buildVoucher(lines) {
  // Negative amounts are rejected, not filtered. A predicate of `> 0` would
  // silently delete them, and two negatives on opposite sides would cancel out
  // — passing the balance check while posting an entry for the wrong total.
  // This function exists to be the one place a malformed entry is caught, so it
  // has to fail loudly rather than quietly repair.
  const bad = lines.find(l => l.debit < 0 || l.credit < 0);
  if (bad) {
    throw new UnbalancedVoucher(
      `negative amount on ${bad.account}: debit ${bad.debit}, credit ${bad.credit}`
    );
  }

  const kept = lines.filter(l => l.debit !== 0 || l.credit !== 0);

  const debits = kept.reduce((s, l) => s + l.debit, 0);
  const credits = kept.reduce((s, l) => s + l.credit, 0);

  if (debits !== credits) {
    throw new UnbalancedVoucher(
      `debits ${debits} != credits ${credits} (${kept.length} lines)`
    );
  }
  if (kept.length === 0) throw new UnbalancedVoucher('voucher has no lines');

  return { lines: kept, total: debits };
}

/**
 * Journal entry for a sale.
 *
 * Revenue is credited to two different accounts by line kind, which is the
 * main practical reason to model goods and services separately at all: a P&L
 * that lumps them together cannot show which side of the business earns.
 *
 * The COGS/Stock pair is omitted entirely on a services-only bill rather than
 * posted as zeroes.
 *
 *   Dr Cash/Bank/Debtors   total actually payable
 *   Cr Sales               taxable value of goods lines
 *   Cr Service Income      taxable value of service lines
 *   Cr Output CGST/SGST/IGST
 *   Dr/Cr Round Off        the rounding adjustment
 *   Dr COGS                FIFO cost   } goods only
 *   Cr Stock in Hand       FIFO cost   }
 */
export function saleVoucherLines({
  total, goodsTaxable, serviceTaxable, cgst, sgst, igst, roundOff, cogs, paymentMode,
}) {
  return buildVoucher([
    dr(settlementAccount(paymentMode), total),
    cr(ACC.SALES, goodsTaxable),
    cr(ACC.SERVICE_INCOME, serviceTaxable),
    cr(ACC.OUTPUT_CGST, cgst),
    cr(ACC.OUTPUT_SGST, sgst),
    cr(ACC.OUTPUT_IGST, igst),
    // Rounding up collects a few paise more than the lines justify, so the
    // difference is income (a credit); rounding down is a cost. One signed
    // number, two possible sides.
    roundOff >= 0 ? cr(ACC.ROUND_OFF, roundOff) : dr(ACC.ROUND_OFF, -roundOff),
    dr(ACC.COGS, cogs),
    cr(ACC.STOCK, cogs),
  ]);
}

/**
 * Journal entry for a purchase.
 *
 * Input GST is debited to an asset, not added to stock value: it is
 * recoverable against output tax, so treating it as inventory cost would
 * overstate both stock and later COGS.
 *
 *   Dr Stock in Hand       taxable value
 *   Dr Input CGST/SGST/IGST
 *   Cr Cash/Bank/Creditors total payable
 */
export function purchaseVoucherLines({ taxable, cgst, sgst, igst, total, paymentMode }) {
  return buildVoucher([
    dr(ACC.STOCK, taxable),
    dr(ACC.INPUT_CGST, cgst),
    dr(ACC.INPUT_SGST, sgst),
    dr(ACC.INPUT_IGST, igst),
    cr(settlementAccount(paymentMode), total),
  ]);
}

/**
 * Statements that write a voucher and its lines.
 *
 * D1's batch() returns nothing to thread between statements, so the lines cannot
 * be given the voucher's id directly — it has to be resolved by sub-select.
 *
 * MAX(id) is that sub-select, matching the pattern lotInsert() already uses. It
 * is correct because batch() is ONE transaction executed in order: the voucher
 * INSERT immediately precedes its line INSERTs, so MAX(id) is that voucher, and
 * a concurrent transaction's uncommitted rows are not visible. It also stays
 * correct if a caller ever posts two vouchers in one batch, since each group of
 * lines runs after its own voucher.
 *
 * It replaces a sub-select on (type, ref), which was WRONG for a null ref. A
 * cash purchase with no supplier invoice number has ref = NULL — the common case
 * for a small shop buying from a local market — and `WHERE type = ? AND ref IS
 * NULL` matches the FIRST such voucher, not the one just inserted. So the second
 * null-ref purchase's lines were attached to the first purchase's voucher.
 *
 * The partial index `UNIQUE (type, ref) WHERE ref IS NOT NULL` does not
 * constrain null refs, so nothing prevented two of them existing, and the trial
 * balance still netted to zero because every line was present and balanced —
 * just on the wrong voucher. Silent misattribution that no aggregate check could
 * detect. See test/ledger.test.js.
 *
 * Idempotency is unaffected: it comes from the caller's own primary key
 * (sales.client_ref) plus the (type, ref) unique index on the voucher INSERT
 * itself, neither of which this touches.
 */
export function voucherStatements(db, { type, ref, narration, date }, lines) {
  const vid = `(SELECT MAX(id) FROM vouchers)`;

  return [
    db.prepare(
      `INSERT INTO vouchers (type, ref, narration, date)
       VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    ).bind(type, ref ?? null, narration ?? '', date ?? null),

    ...lines.map(l =>
      db.prepare(
        `INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise)
         VALUES (${vid}, ?, ?, ?)`
      ).bind(l.account, l.debit, l.credit)
    ),
  ];
}

/**
 * Trial balance: every account with a movement, and the net of all of them.
 *
 * `net` exists to be asserted on. Double-entry's whole guarantee is that it is
 * zero; if it ever is not, something wrote to voucher_lines without going
 * through buildVoucher.
 */
export async function trialBalance(db, { from = null, to = null } = {}) {
  const where = [];
  const binds = [];
  if (from) { where.push('v.date >= ?'); binds.push(from); }
  if (to)   { where.push('v.date <= ?'); binds.push(to); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { results } = await db
    .prepare(
      `SELECT a.code, a.name, a.type,
              COALESCE(SUM(vl.debit_paise), 0)  AS debit_paise,
              COALESCE(SUM(vl.credit_paise), 0) AS credit_paise
         FROM voucher_lines vl
         JOIN vouchers v ON v.id = vl.voucher_id
         JOIN accounts a ON a.code = vl.account_code
         ${clause}
         GROUP BY a.code
         HAVING debit_paise > 0 OR credit_paise > 0
         ORDER BY a.code`
    )
    .bind(...binds)
    .all();

  const totalDebit = results.reduce((s, r) => s + r.debit_paise, 0);
  const totalCredit = results.reduce((s, r) => s + r.credit_paise, 0);

  return {
    accounts: results.map(r => ({ ...r, balance_paise: r.debit_paise - r.credit_paise })),
    totalDebit,
    totalCredit,
    net: totalDebit - totalCredit,   // must be 0
  };
}
