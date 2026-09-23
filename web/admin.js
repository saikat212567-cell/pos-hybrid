/**
 * Admin screen: item management and shop/GST settings.
 *
 * The admin token is held in a closure variable for the life of the tab and
 * nowhere else. Not in config.js, because the till page loads that file and the
 * till must never carry a token that can rewrite tax settings or read the books.
 * Not in localStorage either: it would outlive the tab and be readable by any
 * script that ever runs on this origin.
 *
 * MONEY IS INTEGER PAISE over the wire. The form takes rupees because that is
 * what a shopkeeper thinks in, and converts once, here.
 */

var Admin = (function () {
  var token = '';
  var items = [];

  var $ = function (id) { return document.getElementById(id); };
  var money = function (paise) { return (paise / 100).toFixed(2); };

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /**
   * Rupees typed by a human -> integer paise.
   *
   * Math.round, not truncation: "180.10" parses to 18009.999999999996 in binary
   * floating point, and truncating would silently record a paisa less. This is
   * the only place a float is allowed near money, and it ends here.
   */
  function rupeesToPaise(value) {
    var n = parseFloat(String(value).replace(/,/g, '').trim());
    if (!isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(CONFIG.API_BASE + path, Object.assign({}, opts, {
      headers: Object.assign({
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      }, opts.headers || {}),
    }));
  }

  function say(id, text, kind) {
    var el = $(id);
    el.textContent = text;
    el.className = 'msg ' + (kind || '');
  }

  /** Pull the server's message out of a failed response — it names the field. */
  async function errorText(res) {
    try {
      var body = await res.json();
      return body.error || ('HTTP ' + res.status);
    } catch (e) {
      return 'HTTP ' + res.status;
    }
  }

  // -------------------------------------------------------------------------
  // Gate
  // -------------------------------------------------------------------------

  async function unlock() {
    token = $('token').value.trim();
    if (!token) return say('gate-msg', 'Paste the admin token first.', 'bad');

    say('gate-msg', 'Checking…');
    try {
      // /settings is admin-only, so a 200 here proves the token is the admin one
      // and not the till token.
      var res = await api('/settings');
      if (res.status === 401) return say('gate-msg', 'That token was rejected.', 'bad');
      if (!res.ok) return say('gate-msg', await errorText(res), 'bad');

      $('gate').hidden = true;
      $('app').hidden = false;
      fillSettings(await res.json());
      loadItems();
    } catch (err) {
      say('gate-msg', 'Could not reach the API: ' + err.message, 'bad');
    }
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  async function loadItems() {
    try {
      // all=1 includes deactivated items; the till never sees those.
      var res = await api('/items?all=1');
      if (!res.ok) throw new Error(await errorText(res));
      items = await res.json();
      renderRows();
      $('status').textContent = items.length + ' items';
    } catch (err) {
      say('list-msg', 'Could not load the catalog: ' + err.message, 'bad');
    }
  }

  function renderRows() {
    $('rows').innerHTML = items.map(function (it) {
      // The TILL token in the image URL, never the admin one.
      //
      // A URL ends up in Cloudflare logs, in proxy logs, and in the Referer header
      // of anything the page later links to. The till token is already public by
      // design — it is in this file and extractable from the APK — and it opens
      // only catalog-read and sale-insert, so a product photo URL carrying it
      // leaks nothing new. The admin token gates the books and the tax settings,
      // and this page promises to keep it in memory only; putting it in an <img>
      // src broke that promise on every row.
      var img = it.image_key
        ? '<img class="thumb" alt="" loading="lazy" src="' +
          esc(CONFIG.API_BASE + '/images/' + it.image_key +
              '?t=' + encodeURIComponent(CONFIG.API_TOKEN)) + '">'
        : '<span class="thumb"></span>';

      return '<tr class="' + (it.is_active ? '' : 'inactive') + '">' +
        '<td>' + img + '</td>' +
        '<td>' + esc(it.name) +
          (it.is_active ? '' : ' <span class="tag">inactive</span>') + '</td>' +
        '<td>' + esc(it.code || '—') + '</td>' +
        '<td>' + esc(it.kind) + '</td>' +
        '<td>' + esc(it.tax_code || '—') + '</td>' +
        '<td class="r">' + (it.gst_rate_bps / 100) + '%</td>' +
        '<td class="r">' + money(it.price_paise) + '</td>' +
        '<td class="r">' + (it.kind === 'service' ? '—' : it.stock) + '</td>' +
        '<td class="r">' + (it.kind === 'service' ? '—' : money(it.stock_value_paise)) + '</td>' +
        '<td class="r">' +
          '<button data-stock="' + esc(it.id) + '">+ stock</button> ' +
          (it.is_active
            ? '<button class="danger" data-off="' + esc(it.id) + '">hide</button>'
            : '<button data-on="' + esc(it.id) + '">restore</button>') +
        '</td></tr>';
    }).join('') || '<tr><td colspan="10" class="note">No items yet.</td></tr>';
  }

  async function create() {
    var price = rupeesToPaise($('f-price').value);
    if (price === null) return say('create-msg', 'Price must be a number.', 'bad');

    var body = {
      id: $('f-id').value.trim().toLowerCase(),
      name: $('f-name').value.trim(),
      kind: $('f-kind').value,
      price: price,
      gst_rate_bps: parseInt($('f-rate').value, 10),
      tax_code: $('f-hsn').value.trim(),
      unit: $('f-unit').value,
    };
    if ($('f-code').value.trim()) body.code = $('f-code').value.trim();
    if ($('f-barcode').value.trim()) body.barcode = $('f-barcode').value.trim();
    if ($('f-cat').value.trim()) body.category = $('f-cat').value.trim();

    $('create').disabled = true;
    say('create-msg', 'Saving…');

    try {
      var res = await api('/items', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) return say('create-msg', await errorText(res), 'bad');

      // Image and opening stock are separate calls: each can fail on its own, and
      // the item existing is the part that matters. Reporting partial success
      // beats claiming the whole thing worked.
      var warnings = [];

      var file = $('f-img').files[0];
      if (file) {
        try { await uploadImage(body.id, file); }
        catch (e) { warnings.push('photo not saved (' + e.message + ')'); }
      }

      var qty = parseInt($('f-openqty').value, 10);
      var cost = rupeesToPaise($('f-opencost').value || '0');
      if (qty > 0) {
        if (body.kind === 'service') {
          warnings.push('opening stock skipped — a service holds no stock');
        } else {
          var sres = await api('/items/' + encodeURIComponent(body.id) + '/opening-stock', {
            method: 'POST', body: JSON.stringify({ qty: qty, cost_paise: cost || 0 }),
          });
          if (!sres.ok) warnings.push('opening stock failed (' + await errorText(sres) + ')');
        }
      }

      say('create-msg',
        'Added ' + body.name + (warnings.length ? ' — but ' + warnings.join('; ') : ''),
        warnings.length ? 'bad' : 'ok');
      resetForm();
      loadItems();
    } catch (err) {
      say('create-msg', err.message, 'bad');
    } finally {
      $('create').disabled = false;
    }
  }

  /**
   * Downscale, then upload.
   *
   * A phone photo is several megabytes and the server caps uploads at 2 MB. Doing
   * this in a canvas here means no image pipeline on the Worker and far less data
   * over what may be a slow counter connection. 800px is ample for a tile.
   */
  async function uploadImage(id, file) {
    var blob = await downscale(file, 800);
    var res = await fetch(CONFIG.API_BASE + '/items/' + encodeURIComponent(id) + '/image', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': blob.type },
      body: blob,
    });
    if (!res.ok) throw new Error(await errorText(res));
    return res.json();
  }

  function downscale(file, maxEdge) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

        // JPEG at 0.82: a product photo has no transparency to preserve, and PNG
        // would be several times the size for no visible gain.
        canvas.toBlob(function (blob) {
          blob ? resolve(blob) : reject(new Error('could not encode the image'));
        }, 'image/jpeg', 0.82);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('not a readable image'));
      };
      img.src = url;
    });
  }

  async function addStock(id) {
    var qtyStr = prompt('How many units of ' + id + ' are you adding?');
    if (qtyStr === null) return;
    var qty = parseInt(qtyStr, 10);
    if (!(qty > 0)) return say('list-msg', 'Quantity must be a positive whole number.', 'bad');

    var costStr = prompt('Total cost in ₹ for all ' + qty + ' units (not per unit):', '0');
    if (costStr === null) return;
    var cost = rupeesToPaise(costStr);
    if (cost === null) return say('list-msg', 'Cost must be a number.', 'bad');

    try {
      var res = await api('/items/' + encodeURIComponent(id) + '/opening-stock', {
        method: 'POST', body: JSON.stringify({ qty: qty, cost_paise: cost }),
      });
      if (!res.ok) return say('list-msg', await errorText(res), 'bad');
      say('list-msg', 'Added ' + qty + ' to ' + id + '.', 'ok');
      loadItems();
    } catch (err) {
      say('list-msg', err.message, 'bad');
    }
  }

  async function setActive(id, active) {
    try {
      var res = active
        ? await api('/items/' + encodeURIComponent(id), {
            method: 'PATCH', body: JSON.stringify({ is_active: 1 }),
          })
        : await api('/items/' + encodeURIComponent(id), { method: 'DELETE' });

      if (!res.ok) return say('list-msg', await errorText(res), 'bad');
      say('list-msg', (active ? 'Restored ' : 'Hid ') + id + '.', 'ok');
      loadItems();
    } catch (err) {
      say('list-msg', err.message, 'bad');
    }
  }

  function resetForm() {
    ['f-id', 'f-name', 'f-price', 'f-hsn', 'f-code', 'f-barcode', 'f-cat',
     'f-openqty', 'f-opencost', 'f-img'].forEach(function (id) { $(id).value = ''; });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  function fillSettings(s) {
    $('s-name').value = s.legal_name || '';
    $('s-gstin').value = s.gstin || '';
    $('s-state').value = s.state_code || '';
    $('s-reg').value = s.gst_registration || 'regular';
    $('s-pricemode').value = s.price_mode || 'inclusive';
    $('s-format').value = s.bill_format || '58mm';
    $('s-series').value = s.invoice_series || 'A';
    $('s-round').value = s.round_off_enabled === '0' ? '0' : '1';
    $('s-phone').value = s.phone || '';
    $('s-address').value = s.address || '';
    $('s-footer').value = s.bill_footer || '';
  }

  async function saveSettings() {
    var body = {
      legal_name: $('s-name').value.trim(),
      gstin: $('s-gstin').value.trim(),
      state_code: $('s-state').value.trim(),
      gst_registration: $('s-reg').value,
      price_mode: $('s-pricemode').value,
      bill_format: $('s-format').value,
      invoice_series: $('s-series').value.trim() || 'A',
      round_off_enabled: $('s-round').value,
      phone: $('s-phone').value.trim(),
      address: $('s-address').value.trim(),
      bill_footer: $('s-footer').value.trim(),
    };

    say('settings-msg', 'Saving…');
    try {
      var res = await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
      if (!res.ok) return say('settings-msg', await errorText(res), 'bad');
      fillSettings(await res.json());
      say('settings-msg', 'Saved.', 'ok');
    } catch (err) {
      say('settings-msg', err.message, 'bad');
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  $('unlock').addEventListener('click', unlock);
  $('token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') unlock();
  });

  $('create').addEventListener('click', create);
  $('reset').addEventListener('click', resetForm);
  $('save-settings').addEventListener('click', saveSettings);

  // A service has no unit to count and no stock, so those inputs are disabled
  // rather than silently ignored — a form that accepts input it will discard is
  // a form that lies.
  $('f-kind').addEventListener('change', function () {
    var service = $('f-kind').value === 'service';
    $('f-unit').value = service ? 'NA' : 'PCS';
    $('f-openqty').disabled = service;
    $('f-opencost').disabled = service;
    if (service) { $('f-openqty').value = ''; $('f-opencost').value = ''; }
  });

  $('rows').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.stock) addStock(b.dataset.stock);
    if (b.dataset.off) setActive(b.dataset.off, false);
    if (b.dataset.on) setActive(b.dataset.on, true);
  });

  $('token').focus();

  return { rupeesToPaise: rupeesToPaise };
})();
