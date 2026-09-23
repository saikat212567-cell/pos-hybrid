/**
 * Item management. Admin only — an item's GST rate and HSN code decide what a
 * legal document says, so this is not something a token shipped inside an APK
 * may change.
 *
 * Validation here is deliberately strict. A wrong GST rate is not a typo that
 * shows up as a broken screen: it silently produces months of incorrect
 * invoices and an incorrect return, and by the time anyone notices, the money
 * has been collected from customers at the wrong rate.
 */

/**
 * The real GST slabs, in basis points.
 *
 * A closed set, not a range: 15% is not a GST rate, and accepting it would let
 * a typo become a filed return. 3% covers gold and silver, 0.25% rough
 * diamonds — rare but real, so they belong in the list rather than forcing a
 * later migration.
 */
export const GST_SLABS_BPS = [0, 25, 300, 500, 1200, 1800, 2800];

/**
 * Unit Quantity Codes as GST returns require them. Not exhaustive — the full
 * list runs to dozens — but these cover retail and services, and an unknown
 * code is rejected rather than silently filed.
 */
export const UNITS = [
  'PCS', 'KGS', 'GMS', 'LTR', 'MLT', 'MTR', 'BOX', 'PAC', 'BAG', 'DOZ',
  'BTL', 'TUB', 'SET', 'PRS', 'NOS',
  'NA',   // services: nothing is being counted
];

const KINDS = ['good', 'service'];

/** Item ids and codes appear in URLs and are typed at a counter. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const CODE_RE = /^\d{1,6}$/;
const BARCODE_RE = /^[A-Za-z0-9._-]{4,32}$/;

class Invalid extends Error {}
const bad = msg => { throw new Invalid(msg); };

/**
 * Validate a full item. Returns a normalised row; throws Invalid with a message
 * naming the field, so the admin screen can show something useful rather than
 * "400".
 *
 * @param registration so a regular dealer is held to the HSN/SAC requirement
 *        while an unregistered shop, which issues no tax invoice, is not
 */
export function validateItem(body, { registration = 'regular', partial = false } = {}) {
  const out = {};
  const has = k => body[k] !== undefined && body[k] !== null;

  if (!partial || has('id')) {
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) {
      bad('id must be lowercase letters, digits, dash or underscore (max 63)');
    }
    out.id = body.id;
  }

  if (!partial || has('name')) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) bad('name is required (max 120 chars)');
    out.name = name;
  }

  if (!partial || has('kind')) {
    const kind = body.kind ?? 'good';
    if (!KINDS.includes(kind)) bad(`kind must be one of: ${KINDS.join(', ')}`);
    out.kind = kind;
  }

  if (!partial || has('price')) {
    // Integer paise. A float price is the start of every rounding bug in a POS.
    if (!Number.isInteger(body.price) || body.price < 0 || body.price > 100_000_000) {
      bad('price must be a non-negative integer in paise (max 10 lakh rupees)');
    }
    out.price = body.price;
  }

  if (!partial || has('gst_rate_bps')) {
    const rate = body.gst_rate_bps ?? 0;
    if (!GST_SLABS_BPS.includes(rate)) {
      bad(`gst_rate_bps must be a real GST slab: ${GST_SLABS_BPS.join(', ')}`);
    }
    out.gst_rate_bps = rate;
  }

  if (!partial || has('unit')) {
    const kind = out.kind ?? body.kind ?? 'good';
    const unit = body.unit ?? (kind === 'service' ? 'NA' : 'PCS');
    if (!UNITS.includes(unit)) bad(`unit must be a valid UQC: ${UNITS.join(', ')}`);
    out.unit = unit;
  }

  if (!partial || has('tax_code')) {
    const code = (body.tax_code ?? '').toString().trim();
    // 4, 6 or 8 digits — not "4 to 8". An HSN is 4, 6 or 8 digits and a SAC is
    // always 6, so a 5- or 7-digit value is a dropped or doubled keystroke, and
    // it would sit on filed invoices and in the GSTR-1 HSN summary where the
    // portal rejects it.
    if (code && !/^(\d{4}|\d{6}|\d{8})$/.test(code)) {
      bad('tax_code must be an HSN of 4, 6 or 8 digits, or a 6-digit SAC');
    }
    out.tax_code = code;
  }

  // A registered dealer's invoice must carry an HSN for goods or a SAC for
  // services. Enforced at creation because retrofitting codes across a catalog
  // after the first return is filed is far more painful than typing one now.
  //
  // Also enforced on a PATCH that sets tax_code explicitly: `has()` treats ''
  // as present, so without this a PATCH could blank the code on a registered
  // dealer's item and every later invoice for it would carry no HSN/SAC. Only a
  // patch that omits the field entirely leaves it alone.
  if (registration === 'regular' && (!partial || has('tax_code')) && !out.tax_code) {
    bad('tax_code (HSN for goods, SAC for services) is required for a GST-registered business');
  }

  if (has('code')) {
    const code = String(body.code).trim();
    if (!CODE_RE.test(code)) bad('code must be 1-6 digits');
    out.code = code;
  } else if (!partial) {
    out.code = null;
  }

  if (has('barcode')) {
    const bc = String(body.barcode).trim();
    if (!BARCODE_RE.test(bc)) bad('barcode must be 4-32 letters, digits, dot, dash or underscore');
    out.barcode = bc;
  } else if (!partial) {
    out.barcode = null;
  }

  if (has('price_mode')) {
    if (!['inclusive', 'exclusive'].includes(body.price_mode)) {
      bad('price_mode must be inclusive or exclusive');
    }
    out.price_mode = body.price_mode;
  } else if (!partial) {
    out.price_mode = null;   // follow the shop-wide setting
  }

  if (has('category')) {
    const c = String(body.category).trim();
    if (c.length > 40) bad('category must be at most 40 chars');
    out.category = c || 'general';
  } else if (!partial) {
    out.category = 'general';
  }

  // Restoring a hidden item. Only on a patch: a new item is always active, and
  // creating one pre-hidden would be a way to make an item nobody can find.
  if (partial && has('is_active')) {
    const v = body.is_active;
    if (v !== 0 && v !== 1 && v !== true && v !== false) {
      bad('is_active must be 0 or 1');
    }
    out.is_active = (v === 1 || v === true) ? 1 : 0;
  }

  if (!Object.keys(out).length) bad('no fields to update');
  return out;
}

export { Invalid };

/**
 * A service cannot hold stock, so `code`/`barcode` aside, the one thing that
 * must never happen is a lot against it. Callers check this before creating
 * opening stock.
 */
export const isService = row => row?.kind === 'service';
