/**
 * POS till — fast sale entry.
 *
 * THE DESIGN PROBLEM: the counter's bottleneck is not the click, it is finding
 * the item. A grid of tiles is fine for twenty items and useless for four
 * hundred. But most Indian retail stock has no barcode, so a scanner alone is
 * not enough either.
 *
 * So one input owns the keyboard and never loses focus, and it disambiguates by
 * what was typed rather than by a mode the user has to remember:
 *
 *   12⏎         -> the item whose code is 12
 *   8901234⏎    -> exact barcode match (a scanner is just a fast keyboard
 *                  that ends with Enter, so it needs no special handling)
 *   rice⏎       -> first name match; the tiles below filter as you type
 *   3*12⏎       -> three of item 12. Same for 3*rice.
 *
 * Tiles stay for everything without a code, which is most of a real catalog, and
 * they are the only workable path on a touchscreen.
 *
 * MONEY IS INTEGER PAISE. Only formatting divides by 100.
 *
 * Classic script, not an ES module: a module is fetched under CORS rules and a
 * file:// page has an opaque origin, so every import fails and the page would
 * only work behind a web server. CONFIG and Bill come from the two scripts
 * loaded before this one.
 */

const $ = id => document.getElementById(id);
const money = paise => (paise / 100).toFixed(2);

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const api = (path, opts = {}) =>
  fetch(CONFIG.API_BASE + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${CONFIG.API_TOKEN}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });

/**
 * Fallback so the till is explorable before the Worker is reachable.
 *
 * Only ever used when NO real catalog has loaded yet — see loadItems(). These ids
 * do not exist server-side, so a sale of one is refused; showing them in place of
 * a catalog the till already had would strand the counter on a fake menu.
 */
const DEMO = [
  { id: 'demo-1', name: 'Espresso', price_paise: 250, stock: 100, code: '1', kind: 'good', gst_rate_bps: 1800, unit: 'PCS' },
  { id: 'demo-2', name: 'Cappuccino', price_paise: 375, stock: 100, code: '2', kind: 'good', gst_rate_bps: 1800, unit: 'PCS' },
  { id: 'demo-3', name: 'Croissant', price_paise: 295, stock: 40, code: '3', kind: 'good', gst_rate_bps: 500, unit: 'PCS' },
  { id: 'demo-4', name: 'Home Delivery', price_paise: 4000, stock: null, code: '9', kind: 'service', gst_rate_bps: 1800, unit: 'NA' },
];

let items = [];
let shop = {};
const cart = new Map();       // id -> { item, qty }
let lastId = null;            // what +/- adjusts
let lastSaleRef = null;       // what the reprint button reaches for

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** True once a real catalog has loaded, so a later failure cannot replace it. */
let haveRealCatalog = false;

async function loadItems() {
  try {
    const res = await api('/items');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items = await res.json();
    haveRealCatalog = true;
    setStatus(`Connected — ${items.length} items`, 'ok');
  } catch (err) {
    // Keep the real catalog if we ever had one. A single 500 or a dropped
    // connection used to replace it with the four demo items, whose ids do not
    // exist server-side — so every sale was then refused with "unknown or
    // inactive items", and because the catalog only reloads after a SUCCESSFUL
    // sale, the till could not recover. The counter was stuck on a fake menu
    // until someone reloaded the page.
    if (haveRealCatalog) {
      setStatus(`Offline — using the last known catalog (${err.message})`, 'warn');
    } else {
      items = DEMO;
      setStatus(`Offline — demo catalog, sales will be refused (${err.message})`, 'warn');
    }
  }
  renderGrid();
}

/**
 * How prices are read, and whether to round. Fetched at startup.
 *
 * Without this the first cart of the session would assume inclusive pricing. At
 * an exclusive-pricing shop that understates every on-screen total by the tax, so
 * the counter quotes one figure and the bill prints a higher one.
 *
 * On failure the previous values stand: a network blip must not silently change
 * how prices are interpreted.
 */
async function loadShop() {
  try {
    const res = await api('/shop');
    if (res.ok) shop = { ...shop, ...(await res.json()) };
  } catch {
    // Offline. Whatever was last known is better than a reset to a guess.
  }
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

/** A service has no stock to run out of; a good does. */
const inStock = it => it.kind === 'service' || (it.stock ?? 0) > 0;

const available = it =>
  it.kind === 'service' ? Infinity : (it.stock ?? 0);

/**
 * Tile image, or a coloured initial when there is none.
 *
 * Most items will never get a photo, so the no-image case has to look
 * deliberate rather than broken. The colour is derived from the name so the same
 * item is always the same colour — position-independent recognition is the whole
 * point of an image tile.
 */
function tileFace(it) {
  if (it.image_key) {
    const url = `${CONFIG.API_BASE}/images/${it.image_key}?t=${encodeURIComponent(CONFIG.API_TOKEN)}`;
    // loading="lazy" so a 400-item catalog does not fire 400 requests at once.
    return `<img src="${esc(url)}" alt="" loading="lazy" class="tile-img">`;
  }
  let h = 0;
  for (const ch of it.name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const initials = it.name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return `<div class="tile-img tile-initial" style="background:hsl(${h} 45% 88%);color:hsl(${h} 55% 28%)"
            aria-hidden="true">${esc(initials)}</div>`;
}

function visibleItems() {
  const { text } = parseEntry($('entry').value);
  if (!text) return items;
  const q = text.toLowerCase();
  // Code and barcode first: if the counter typed a code, that one item is what
  // they meant, and showing forty name-matches alongside it is noise.
  const exact = items.filter(it => it.code === text || it.barcode === text);
  if (exact.length) return exact;
  return items.filter(it =>
    it.name.toLowerCase().includes(q) || (it.code ?? '').startsWith(text));
}

function renderGrid() {
  const shown = visibleItems();

  $('grid').innerHTML = shown.map(it => `
    <button type="button" data-id="${esc(it.id)}" ${inStock(it) ? '' : 'disabled'}
            class="tile">
      ${tileFace(it)}
      <span class="tile-name">${esc(it.name)}</span>
      <span class="tile-price">₹${money(it.price_paise)}</span>
      <span class="tile-meta">${it.code ? `[${esc(it.code)}] ` : ''}${
        it.kind === 'service' ? 'service' : `${it.stock} ${esc(it.unit)}`}</span>
    </button>`).join('')
    || '<p class="empty">No matches. Press Esc to clear.</p>';
}

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------

/**
 * Split what was typed into a quantity and a lookup term.
 *
 * `3*rice` means three of rice. `*` rather than `x` because x is a letter that
 * appears in item names, and because it is on the numeric keypad every counter
 * already has.
 */
function parseEntry(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\d+)\s*\*\s*(.*)$/);
  if (m) return { qty: Math.max(1, parseInt(m[1], 10)), text: m[2].trim() };
  return { qty: 1, text: s };
}

/**
 * Find the item a typed term refers to.
 *
 * Order matters and is by decreasing certainty: an exact barcode is a scanner
 * saying precisely which item; an exact code is the counter saying it; a name is
 * a guess. Anything else would let a name containing "12" shadow item 12.
 */
function findItem(list, text) {
  if (!text) return null;
  const t = text.toLowerCase();
  return list.find(it => it.barcode && it.barcode === text)
    ?? list.find(it => it.code && it.code === text)
    ?? list.find(it => it.name.toLowerCase() === t)
    ?? list.find(it => it.name.toLowerCase().startsWith(t))
    ?? list.find(it => it.name.toLowerCase().includes(t))
    ?? null;
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

function add(id, qty = 1) {
  const it = items.find(x => x.id === id);
  if (!it) return flash('Unknown item', 'bad');

  const line = cart.get(id) ?? { item: it, qty: 0 };
  const want = line.qty + qty;

  // Refuse at the till rather than letting the server 409 later: the counter
  // finds out now, with the customer standing there, instead of at checkout.
  if (want > available(it)) {
    flash(`Only ${available(it)} ${it.name} in stock`, 'bad');
    if (line.qty === 0) return;
    line.qty = available(it);
  } else {
    line.qty = want;
  }

  cart.set(id, line);
  lastId = id;
  renderCart();
}

function setQty(id, qty) {
  const line = cart.get(id);
  if (!line) return;
  if (qty <= 0) {
    cart.delete(id);
    if (lastId === id) lastId = null;
  } else {
    line.qty = Math.min(qty, available(line.item));
  }
  renderCart();
}

/**
 * Cart totals, computed the same way the server does.
 *
 * Shown for the counter's benefit only — the server recomputes everything from
 * its own catalog and settings, and its figures are what get recorded. Matching
 * the method here keeps the displayed total from disagreeing with the printed
 * bill, but the server stays the authority.
 */
function cartTotals() {
  // Only a regular dealer charges GST. A composition dealer issues a bill of
  // supply and an unregistered business has no GSTIN, so both show no tax —
  // matching chargesTax() on the server, which is the authority. Without this
  // the till showed tax the server neither records nor prints, and on exclusive
  // pricing the on-screen total was higher than the amount actually charged.
  const chargesTax = (shop.gst_registration ?? 'regular') === 'regular';

  let taxable = 0, tax = 0, gross = 0;
  for (const { item, qty } of cart.values()) {
    const lineGross = item.price_paise * qty;
    gross += lineGross;

    if (!chargesTax) {
      // No tax, and the gross is the taxable value. Checked before the rate is
      // read so a stale rate on an item cannot leak tax onto a bill of supply.
      taxable += lineGross;
      continue;
    }

    const rate = item.gst_rate_bps ?? 0;
    const mode = item.price_mode ?? shop.price_mode ?? 'inclusive';

    if (mode === 'exclusive') {
      const t = Math.floor((lineGross * rate + 5000) / 10000);
      taxable += lineGross;
      tax += t;
    } else {
      const base = Math.floor((lineGross * 10000 + (10000 + rate) / 2) / (10000 + rate));
      taxable += base;
      tax += lineGross - base;
    }
  }
  const sum = taxable + tax;
  // Honour the shop's rounding setting rather than always rounding: a shop that
  // turned it off would see a rounded figure on screen and an unrounded one on
  // the bill.
  const rounded = shop.round_off_enabled === false ? sum : Math.round(sum / 100) * 100;
  return { taxable, tax, total: rounded, roundOff: rounded - sum };
}

function renderCart() {
  const lines = [...cart.values()];

  $('cart').innerHTML = lines.map(({ item, qty }) => `
    <li class="line${item.id === lastId ? ' line-last' : ''}">
      <span class="line-name">${esc(item.name)}</span>
      <button type="button" data-dec="${esc(item.id)}" aria-label="One less ${esc(item.name)}">−</button>
      <span class="line-qty">${qty}</span>
      <button type="button" data-inc="${esc(item.id)}" aria-label="One more ${esc(item.name)}">+</button>
      <span class="line-amt">${money(item.price_paise * qty)}</span>
      <button type="button" data-del="${esc(item.id)}" aria-label="Remove ${esc(item.name)}"
              class="line-del">×</button>
    </li>`).join('') || '<li class="empty">Type a code or tap an item</li>';

  const t = cartTotals();
  $('taxable').textContent = money(t.taxable);
  $('tax').textContent = money(t.tax);
  $('roundoff').textContent = money(t.roundOff);
  $('roundoff-row').hidden = t.roundOff === 0;
  $('total').textContent = money(t.total);
  $('count').textContent = lines.reduce((s, l) => s + l.qty, 0);
  $('charge').disabled = cart.size === 0;
}

let flashTimer;
function flash(msg, kind = '') {
  const el = $('flash');
  el.textContent = msg;
  el.className = 'flash ' + kind;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ''; el.className = 'flash'; }, 2500);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

async function charge() {
  if (!cart.size) return;

  // Only ids and quantities are sent. Price and tax come from the server's own
  // catalog — a client that could name its own price would let anyone holding
  // the till token sell at whatever they liked.
  const payload = {
    client_ref: crypto.randomUUID(),
    source: 'web',
    total: cartTotals().total,
    items: [...cart.values()].map(({ item, qty }) => ({ id: item.id, qty })),
    payment_mode: $('paymode').value,
  };

  $('charge').disabled = true;
  flash('Charging…');

  try {
    const res = await api('/sales', { method: 'POST', body: JSON.stringify(payload) });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // 409 means the world changed (someone else sold the last one). The cart
      // is left intact so the counter can adjust rather than re-ring everything.
      flash(body.error ?? `Failed (HTTP ${res.status})`, 'bad');
      $('charge').disabled = false;
      return;
    }

    lastSaleRef = payload.client_ref;
    const total = money(cartTotals().total);
    cart.clear();
    lastId = null;
    renderCart();
    flash(`Paid ₹${total} — F4 to print`, 'ok');

    $('reprint').disabled = false;
    $('share').disabled = false;

    // Auto-print if the shop wants it. Off by default: a counter testing the
    // till does not want a printer dialog on every sale.
    if ($('autoprint').checked) printBill();

    // Refresh the catalog AND the shop settings. Without the second, a till left
    // open across a settings change keeps computing with the pricing mode,
    // rounding rule and registration it saw at startup — so the counter quotes one
    // figure while the server records and prints another. A till stays open all
    // day; settings change mid-shift.
    loadShop().then(loadItems);
  } catch (err) {
    flash(`Not recorded: ${err.message}`, 'bad');
    $('charge').disabled = false;
  } finally {
    focusEntry();
  }
}

// ---------------------------------------------------------------------------
// Bill
// ---------------------------------------------------------------------------

async function fetchBill(format) {
  const res = await api(`/sales/${lastSaleRef}?format=${format}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function printBill() {
  if (!lastSaleRef) return flash('No sale to print', 'bad');
  try {
    Bill.printHtml(await fetchBill($('format').value));
  } catch (err) {
    flash(`Could not print: ${err.message}`, 'bad');
  }
}

async function shareBill() {
  if (!lastSaleRef) return flash('No sale to share', 'bad');
  try {
    const html = await fetchBill($('format').value);
    // Share sheet where available (phones, tablets), a new tab otherwise — from
    // which the browser's own "Save as PDF" is one step away. No PDF library.
    if (await Bill.shareHtml(html, 'bill.html')) return flash('Shared', 'ok');
    if (Bill.openHtml(html)) return flash('Opened — use Print → Save as PDF', 'ok');
    flash('Popup blocked; use Print instead', 'bad');
  } catch (err) {
    flash(`Could not share: ${err.message}`, 'bad');
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const focusEntry = () => { const e = $('entry'); e.focus(); e.select(); };

function submitEntry() {
  const { qty, text } = parseEntry($('entry').value);
  if (!text) return;

  const it = findItem(items, text);
  if (!it) return flash(`No item matching "${text}"`, 'bad');

  add(it.id, qty);
  $('entry').value = '';
  renderGrid();
}

$('entry').addEventListener('input', renderGrid);

$('entry').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitEntry(); }
  if (e.key === 'Escape') {
    e.preventDefault();
    // Empty field: Esc clears the whole cart, which is the "customer changed
    // their mind" case. With text in it, it just clears the field.
    if ($('entry').value) { $('entry').value = ''; renderGrid(); }
    else if (cart.size && confirm('Clear the cart?')) {
      cart.clear(); lastId = null; renderCart();
    }
  }
});

// Function keys are handled on the document so they work wherever focus is.
document.addEventListener('keydown', e => {
  if (e.key === 'F2') { e.preventDefault(); charge(); }
  if (e.key === 'F4') { e.preventDefault(); printBill(); }

  // +/- adjust the last line, but only when not typing into the entry field,
  // where a bare + is the start of `3*`-style input.
  if (document.activeElement !== $('entry') && lastId) {
    if (e.key === '+') { e.preventDefault(); setQty(lastId, (cart.get(lastId)?.qty ?? 0) + 1); }
    if (e.key === '-') { e.preventDefault(); setQty(lastId, (cart.get(lastId)?.qty ?? 0) - 1); }
  }
});

// Anything typed anywhere goes to the entry field. A scanner sends its
// characters to whatever has focus, and if that happens to be a button the input
// is lost — so focus is pulled back on any printable key.
document.addEventListener('keypress', e => {
  if (document.activeElement !== $('entry') &&
      !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    focusEntry();
  }
});

$('grid').addEventListener('click', e => {
  const b = e.target.closest('button[data-id]');
  if (b) { add(b.dataset.id); focusEntry(); }
});

$('cart').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const { inc, dec, del } = b.dataset;
  if (inc) setQty(inc, (cart.get(inc)?.qty ?? 0) + 1);
  if (dec) setQty(dec, (cart.get(dec)?.qty ?? 0) - 1);
  if (del) setQty(del, 0);
  focusEntry();
});

$('charge').addEventListener('click', charge);
$('reprint').addEventListener('click', printBill);
$('share').addEventListener('click', shareBill);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
renderCart();
// Shop settings first: they decide how prices are read, so loading them after the
// catalog would leave the first cart of the session computing totals with a
// guessed pricing mode.
loadShop().then(loadItems).then(focusEntry);
