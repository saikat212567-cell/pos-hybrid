/**
 * Bill rendering. Pure functions — given a sale and the settings, produce HTML.
 * No database, no I/O, so every layout and every registration type is testable
 * without a Worker.
 *
 * FOUR FORMATS, ONE RENDERER. 58mm, 80mm and A4 differ in page size, column
 * widths and how much detail fits — not in what the numbers mean. PDF is an
 * action the client takes on any of them (browser print-to-PDF, or Android's
 * PdfDocument), not a fifth layout.
 *
 * THREE DOCUMENT TYPES, decided by registration, because the heading is a legal
 * matter rather than a style choice:
 *
 *   regular       -> "Tax Invoice", tax columns, rate-wise breakup
 *   composition   -> "Bill of Supply", NO tax columns, plus the declaration
 *                    that the dealer is not eligible to collect tax
 *   unregistered  -> "Receipt", no tax anywhere
 *
 * Deriving all three from one template is deliberate: two templates would drift,
 * and the one that drifts is the one that gets a business fined.
 */

/** Paise -> "1234.50". The only place money becomes a decimal. */
export const money = paise => (paise / 100).toFixed(2);

/**
 * Basis points -> the rate as an invoice must state it. 1800 -> "18", 25 -> "0.25".
 *
 * Not `.toFixed(0)`: that renders the real 0.25% slab (rough diamonds, precious
 * stones) as "0", putting a 0% rate on an invoice beside a non-zero tax amount —
 * a document a tax officer would refuse. Not `.toFixed(2)` either, since "18.00%"
 * on every line is noise.
 *
 * Dividing by 100 is safe here because this is display, not money: the slabs are
 * a small closed set and none of them lands on a value a double cannot hold
 * exactly.
 */
export const ratePercent = rateBps => String(rateBps / 100);

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Amount in words — Indian numbering system.
//
// An Indian invoice conventionally states the total in words, and it groups as
// lakh and crore, not as million and billion: 150000 is "One Lakh Fifty
// Thousand", never "One Hundred Fifty Thousand". After the first three digits
// the grouping is in twos, which is why this cannot use a Western formatter.
// ---------------------------------------------------------------------------

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];

const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy',
  'Eighty', 'Ninety'];

/** 0-99. Teens are irregular in English, so they get their own lookup. */
function twoDigits(n) {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = ONES[n % 10];
  return ones ? `${tens} ${ones}` : tens;
}

/** 0-999. */
function threeDigits(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/**
 * Whole rupees to words, Indian system.
 *
 * Groups are crore, lakh, thousand, then the last three digits — so the
 * divisors are 10^7, 10^5, 10^3, which is the two-digit grouping that makes
 * this different from a Western implementation.
 */
export function rupeesInWords(rupees) {
  if (!Number.isInteger(rupees) || rupees < 0) return '';
  if (rupees === 0) return 'Zero';

  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;

  const parts = [];
  // Crores can exceed 999, so they recurse: 1,00,00,00,000 is "One Hundred
  // Crore". Everything below is bounded by its divisor.
  if (crore) parts.push(`${crore > 999 ? rupeesInWords(crore) : threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));

  return parts.join(' ');
}

/**
 * Full amount in words including paise, as an invoice states it.
 * e.g. 12345678 paise -> "Rupees One Lakh Twenty Three Thousand Four Hundred
 * Fifty Six and Seventy Eight Paise Only"
 */
export function amountInWords(paise) {
  if (!Number.isInteger(paise) || paise < 0) return '';
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;

  let s = `Rupees ${rupeesInWords(rupees)}`;
  if (p) s += ` and ${twoDigits(p)} Paise`;
  return `${s} Only`;
}

// ---------------------------------------------------------------------------
// Document type
// ---------------------------------------------------------------------------

/**
 * What this document is, legally, given the seller's registration.
 *
 * `showTax` gates every tax column and the rate-wise breakup at once, so there
 * is no path where a composition dealer's bill shows a tax figure.
 */
export function docType(registration) {
  if (registration === 'composition') {
    return {
      title: 'BILL OF SUPPLY',
      showTax: false,
      // Rule 5(1)(f) of the Composition Rules requires this wording on every
      // bill. Omitting it is the kind of thing that draws a penalty.
      declaration: 'Composition taxable person, not eligible to collect tax on supplies.',
    };
  }
  if (registration === 'unregistered') {
    return { title: 'RECEIPT', showTax: false, declaration: '' };
  }
  return { title: 'TAX INVOICE', showTax: true, declaration: '' };
}

/**
 * Tax grouped by rate, as a GST invoice must state it.
 *
 * Summed from the stored line figures rather than recomputed: these are the
 * numbers already recorded against the sale, and a bill that disagrees with the
 * books is worse than no bill.
 */
export function rateWise(lines) {
  const by = new Map();
  for (const l of lines) {
    const key = l.gst_rate_bps ?? 0;
    const g = by.get(key) ?? { rateBps: key, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    g.taxable += l.taxable_paise;
    g.cgst += l.cgst_paise;
    g.sgst += l.sgst_paise;
    g.igst += l.igst_paise;
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => a.rateBps - b.rateBps);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Page CSS per format.
 *
 * Thermal rolls are continuous, so height is `auto` — a fixed height would eject
 * a fixed length of paper for every bill regardless of how many lines it has.
 * Monospace because thermal printers are character devices and columns only
 * line up in a fixed-width font.
 */
const PAGE = {
  '58mm': { size: '58mm auto', width: '54mm', font: '9pt', family: 'monospace' },
  '80mm': { size: '80mm auto', width: '76mm', font: '10pt', family: 'monospace' },
  'a4': { size: 'A4', width: '190mm', font: '10pt', family: 'sans-serif' },
};

export const FORMATS = Object.keys(PAGE);

const css = format => {
  const p = PAGE[format] ?? PAGE['58mm'];
  return `
@page { size: ${p.size}; margin: ${format === 'a4' ? '10mm' : '2mm'}; }
* { box-sizing: border-box; }
body { width: ${p.width}; margin: 0 auto; font: ${p.font}/1.35 ${p.family};
       color: #000; background: #fff; }
/* Thermal printers are monochrome: greys either vanish or smear, so contrast
   has to come from weight and rules, not colour. */
table { width: 100%; border-collapse: collapse; }
th, td { padding: ${format === 'a4' ? '4px 6px' : '1px 0'}; vertical-align: top; }
.r { text-align: right; }
.c { text-align: center; }
.b { font-weight: bold; }
.hr { border-top: 1px dashed #000; margin: 3px 0; }
.hr2 { border-top: 1px solid #000; margin: 3px 0; }
.sm { font-size: 0.85em; }
.head { text-align: center; }
.tot td { padding-top: 2px; }
${format === 'a4' ? `
th { border-bottom: 1px solid #000; text-align: left; }
.box { border: 1px solid #000; padding: 6px; margin-bottom: 8px; }
.sign { margin-top: 28px; text-align: right; }
` : ''}
@media screen { body { padding: 8px; box-shadow: 0 0 0 1px #ccc; margin-top: 8px; } }
`;
};

/**
 * Render a bill.
 *
 * @param sale     row from `sales` plus a `lines` array from `sale_lines`
 * @param settings the settings object (registration, legal name, GSTIN, …)
 * @param format   '58mm' | '80mm' | 'a4'
 */
export function billHtml(sale, settings, format = '58mm') {
  const fmt = FORMATS.includes(format) ? format : '58mm';
  const doc = docType(settings.gst_registration ?? 'regular');
  const lines = sale.lines ?? [];
  const wide = fmt === 'a4';

  const header = `
<div class="head">
  <div class="b" style="font-size:1.25em">${esc(settings.legal_name || 'POS')}</div>
  ${settings.address ? `<div class="sm">${esc(settings.address)}</div>` : ''}
  ${settings.phone ? `<div class="sm">Ph: ${esc(settings.phone)}</div>` : ''}
  ${settings.gstin ? `<div class="sm">GSTIN: ${esc(settings.gstin)}</div>` : ''}
  <div class="hr2"></div>
  <div class="b">${doc.title}</div>
</div>
<table class="sm">
  <tr><td>No: ${esc(sale.invoice_no ?? '-')}</td>
      <td class="r">${esc(sale.sold_at ?? '')}</td></tr>
  ${sale.customer_gstin ? `<tr><td colspan="2">Customer GSTIN: ${esc(sale.customer_gstin)}</td></tr>` : ''}
  ${wide && sale.place_of_supply ? `<tr><td colspan="2">Place of supply: ${esc(sale.place_of_supply)}</td></tr>` : ''}
</table>
<div class="hr"></div>`;

  // Narrow rolls cannot fit per-line tax columns as well as name, qty, rate and
  // amount — so they show the taxable-inclusive amount per line and put the tax
  // in the rate-wise summary below, which is what the law actually requires.
  const itemRows = lines.map(l => {
    const amount = l.taxable_paise + l.cgst_paise + l.sgst_paise + l.igst_paise;
    if (wide) {
      return `<tr>
        <td>${esc(l.name)}</td>
        <td class="c">${esc(l.tax_code)}</td>
        <td class="c">${l.qty} ${esc(l.unit)}</td>
        <td class="r">${money(l.price_paise)}</td>
        <td class="r">${money(l.taxable_paise)}</td>
        ${doc.showTax ? `<td class="c">${ratePercent(l.gst_rate_bps)}%</td>
        <td class="r">${money(l.cgst_paise + l.sgst_paise + l.igst_paise)}</td>` : ''}
        <td class="r b">${money(amount)}</td>
      </tr>`;
    }
    // Two lines per item on a narrow roll: the name needs the full width.
    return `<tr><td colspan="3">${esc(l.name)}</td></tr>
      <tr>
        <td class="sm">${l.qty} ${esc(l.unit)} x ${money(l.price_paise)}</td>
        <td></td>
        <td class="r b">${money(amount)}</td>
      </tr>`;
  }).join('');

  const itemTable = wide
    ? `<table>
        <thead><tr>
          <th>Item</th><th class="c">HSN/SAC</th><th class="c">Qty</th>
          <th class="r">Rate</th><th class="r">Taxable</th>
          ${doc.showTax ? '<th class="c">GST</th><th class="r">Tax</th>' : ''}
          <th class="r">Amount</th>
        </tr></thead>
        <tbody>${itemRows}</tbody>
       </table>`
    : `<table>${itemRows}</table>`;

  // Only the figures that apply. A local sale has no IGST line and an
  // interstate one has no CGST/SGST lines; printing zeroes for the other half
  // makes a short bill harder to read for no gain.
  const totalRow = (label, value, bold = false) =>
    `<tr class="tot"><td${bold ? ' class="b"' : ''}>${label}</td>
     <td class="r${bold ? ' b' : ''}">${money(value)}</td></tr>`;

  // Every tax row is gated on `showTax` as well as on being non-zero. The
  // registration decides whether this document may state tax at all, so that
  // check comes first: a stale tax figure left on a row must not be able to put
  // a tax line onto a bill of supply.
  const totals = `
<div class="hr"></div>
<table>
  ${doc.showTax ? totalRow('Taxable', sale.taxable_paise) : ''}
  ${doc.showTax && sale.cgst_paise ? totalRow('CGST', sale.cgst_paise) : ''}
  ${doc.showTax && sale.sgst_paise ? totalRow('SGST', sale.sgst_paise) : ''}
  ${doc.showTax && sale.igst_paise ? totalRow('IGST', sale.igst_paise) : ''}
  ${sale.round_off_paise ? totalRow('Round off', sale.round_off_paise) : ''}
  ${totalRow('TOTAL', sale.total_paise, true)}
  <tr><td colspan="2" class="sm">${esc(sale.payment_mode ?? 'cash')}</td></tr>
</table>`;

  // The rate-wise breakup is what makes a tax invoice a tax invoice, and on a
  // narrow roll it is the ONLY place the GST rate appears — the per-line rate
  // column only exists on A4. So it is printed whenever tax applies, even for a
  // single rate. Suppressing it then (the old behaviour) left a thermal invoice
  // showing CGST/SGST amounts with the rate stated nowhere, which Rule 46(m)
  // does not permit.
  const groups = rateWise(lines)
  const breakup = doc.showTax && groups.length
    ? `<div class="hr"></div>
       <table class="sm">
         <tr class="b"><td>Rate</td><td class="r">Taxable</td>
             <td class="r">${sale.igst_paise ? 'IGST' : 'CGST'}</td>
             ${sale.igst_paise ? '' : '<td class="r">SGST</td>'}</tr>
         ${groups.map(g => `<tr>
           <td>${ratePercent(g.rateBps)}%</td>
           <td class="r">${money(g.taxable)}</td>
           <td class="r">${money(sale.igst_paise ? g.igst : g.cgst)}</td>
           ${sale.igst_paise ? '' : `<td class="r">${money(g.sgst)}</td>`}
         </tr>`).join('')}
       </table>`
    : '';

  const words = wide
    ? `<div class="sm" style="margin-top:6px"><b>Amount in words:</b>
       ${esc(amountInWords(sale.total_paise))}</div>`
    : '';

  const footer = `
<div class="hr"></div>
${doc.declaration ? `<div class="sm c b">${esc(doc.declaration)}</div>` : ''}
${settings.bill_footer ? `<div class="sm c">${esc(settings.bill_footer)}</div>` : ''}
${wide
  ? '<div class="sign">Authorised Signatory</div>'
  // "Thank you" is only a default for when the shop has set no footer of its
  // own. Printing both means a bill that says thank you twice.
  : (settings.bill_footer ? '' : '<div class="c sm">Thank you</div>')}`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<!-- The <title> is what a browser offers as the filename when saving to PDF,
     so it carries the document type and number rather than being decorative.
     It is not rendered on the page. -->
<title>${doc.title} ${esc(sale.invoice_no ?? '')}</title>
<style>${css(fmt)}</style>
</head><body>
${header}${itemTable}${totals}${breakup}${words}${footer}
</body></html>`;
}
