/**
 * Financial year labelling. No server: a pure function, but one whose bugs only
 * show up for a few hours a day and only around 1 April, so it needs pinning
 * down explicitly rather than being noticed in production a year later.
 *
 * The label decides which invoice series a sale is numbered into, and GST
 * requires that numbering to be consecutive within the year the invoice belongs
 * to — so getting the boundary wrong keeps advancing a closed year's counter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fyLabel } from '../src/index.js';

const at = iso => new Date(iso);

test('a date well inside the year gets that year', () => {
  assert.equal(fyLabel(at('2026-09-22T12:00:00Z')), '26-27');
  assert.equal(fyLabel(at('2027-01-15T12:00:00Z')), '26-27', 'January belongs to the year that began in April');
});

test('the year rolls over on 1 April, not 1 January', () => {
  assert.equal(fyLabel(at('2027-03-31T06:00:00Z')), '26-27');
  assert.equal(fyLabel(at('2027-04-01T06:00:00Z')), '27-28');
});

test('an evening IST sale is filed in the correct year', () => {
  // 02:00 IST on 1 April 2027 is 20:30 UTC on 31 March. Reading UTC would file
  // this into 26-27, a year that has already closed.
  assert.equal(fyLabel(at('2027-03-31T20:30:00Z')), '27-28',
    'a sale after midnight IST belongs to the new year');

  // And the other side of the boundary: 23:00 IST on 31 March is still 26-27.
  assert.equal(fyLabel(at('2027-03-31T17:30:00Z')), '26-27');
});

test('every IST hour of 1 April lands in the new year', () => {
  // The whole failure window, not one sample: UTC 18:30 on 31 March through
  // 18:29 on 1 April is all 1 April in IST.
  for (let h = 0; h < 24; h++) {
    const utc = new Date(Date.UTC(2027, 2, 31, 18, 30) + h * 3600_000);
    assert.equal(fyLabel(utc), '27-28', `${utc.toISOString()} is 1 April IST`);
  }
});

test('the last IST hour of 31 March stays in the old year', () => {
  for (let h = 0; h < 24; h++) {
    const utc = new Date(Date.UTC(2027, 1, 28, 18, 30) + h * 3600_000);
    assert.equal(fyLabel(utc), '26-27', `${utc.toISOString()} is still 26-27`);
  }
});

test('the year start is configurable', () => {
  // A calendar financial year, for a business that uses one.
  assert.equal(fyLabel(at('2027-02-15T12:00:00Z'), '01-01'), '27-28');
  assert.equal(fyLabel(at('2026-12-31T12:00:00Z'), '01-01'), '26-27');
});

test('decade and century rollovers stay two digits', () => {
  assert.equal(fyLabel(at('2029-06-01T12:00:00Z')), '29-30');
  assert.equal(fyLabel(at('2099-06-01T12:00:00Z')), '99-00');
  assert.equal(fyLabel(at('2100-06-01T12:00:00Z')), '00-01');
});
