/**
 * The web till's idempotency key, tested against the real web/app.js source.
 *
 * WHY THIS FILE EXISTS: the server's `client_ref` PRIMARY KEY makes a retried
 * sale a no-op instead of a double charge — but only if the client resends the
 * SAME key. web/app.js used to mint a fresh `crypto.randomUUID()` inside
 * charge() on every attempt, so a cashier pressing Charge again after a dropped
 * connection sent a NEW key for the same sale and the server recorded it twice.
 * The whole idempotency design was defeated from the client side.
 *
 * There is no browser and no DOM here, and app.js is a classic script rather
 * than a module (a file:// page has an opaque origin, so imports fail). So this
 * reads the source and asserts the structural properties that make the key
 * correct. That is weaker than driving a browser, but it fails on exactly the
 * regression that occurred, and it needs no toolchain the project does not have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, '..', '..', 'web', 'app.js'), 'utf8');

/** The body of a named function, by brace matching from its declaration. */
function functionBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `could not find ${declaration} in web/app.js`);

  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces after ${declaration}`);
}

const charge = functionBody(APP, 'async function charge()');

test('charge() does not mint a new idempotency key on every attempt', () => {
  // THE REGRESSION. `client_ref: crypto.randomUUID()` inline in the payload means
  // every press of Charge is a fresh key, so a retry after a lost response is
  // recorded as a second sale.
  assert.ok(!/client_ref:\s*crypto\.randomUUID\(\)/.test(charge),
    'charge() must not generate the client_ref inline in the payload');
});

test('charge() reuses a key held outside itself', () => {
  // The key has to outlive one attempt, so it must come from module state.
  assert.match(charge, /client_ref:\s*pendingRef/,
    'the payload should send the cart-scoped pendingRef');
  assert.match(APP, /^let pendingRef/m,
    'pendingRef must be module-level state, not a local');
});

test('the key is minted only when there is not one already', () => {
  // `if (!pendingRef) pendingRef = ...` is what makes a retry reuse it.
  assert.match(charge, /if\s*\(\s*!pendingRef\s*\)\s*pendingRef\s*=\s*crypto\.randomUUID\(\)/,
    'charge() should mint a key only when none is pending');
});

test('the key is cleared after a sale is recorded, not before', () => {
  // Cleared alongside cart.clear() on the success path. If it were cleared on
  // failure, a retry would get a new key and double-charge again.
  const success = charge.slice(charge.indexOf('cart.clear()'));
  assert.match(success, /resetPendingRef\(\)/,
    'the success path must clear the pending key');

  // And the failure path must NOT clear it.
  const failure = charge.slice(charge.indexOf('if (!res.ok)'), charge.indexOf('cart.clear()'));
  assert.ok(!/resetPendingRef\(\)/.test(failure),
    'the failure path must keep the key so a retry reuses it');
});

test('the network-error path also keeps the key', () => {
  // A thrown fetch is the likeliest way to lose a response while the sale was in
  // fact recorded — the case where reusing the key matters most.
  const catchBlock = charge.slice(charge.indexOf('} catch'));
  assert.ok(!/resetPendingRef\(\)/.test(catchBlock),
    'the catch block must not clear the key');
});

test('abandoning a cart drops the key', () => {
  // Esc-clears-cart is a different sale now, so the abandoned key must not carry
  // over to whatever the next customer buys.
  const esc = APP.slice(APP.indexOf("if (e.key === 'Escape')"));
  const clearBlock = esc.slice(0, esc.indexOf('});'));
  assert.match(clearBlock, /cart\.clear\(\);\s*resetPendingRef\(\)/,
    'clearing the cart should also reset the pending key');
});

test('resetPendingRef exists and nulls the key', () => {
  const fn = functionBody(APP, 'function resetPendingRef()');
  assert.match(fn, /pendingRef\s*=\s*null/);
});
