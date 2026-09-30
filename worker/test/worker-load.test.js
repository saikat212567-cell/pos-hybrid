import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Worker entrypoint exports a fetch handler', async () => {
  const worker = await import('../src/index.js');
  assert.equal(typeof worker.default?.fetch, 'function');
});

test('auth module exports middleware functions', async () => {
  const auth = await import('../src/auth.js');
  assert.equal(typeof auth.authenticateRequest, 'function');
  assert.equal(typeof auth.requireAuth, 'function');
});

test('TOTP counter serialization works for the RFC 6238 SHA-1 test vector', async t => {
  const { generateTotp } = await import('../src/auth.js');
  // RFC 6238 Appendix B: time 59 seconds, ASCII secret 12345678901234567890.
  t.mock.method(Date, 'now', () => 59_000);
  assert.equal(await generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 30, 8), '94287082');
});

test('auth rejection can use the linked JSON response helper', async () => {
  const { requireAuth } = await import('../src/auth.js');
  const response = requireAuth(null, 'settings.write');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

test('Worker answers OPTIONS without authentication or database access', async () => {
  const { default: worker } = await import('../src/index.js');
  const response = await worker.fetch(new Request('https://worker.test/settings', {
    method: 'OPTIONS',
  }), {});
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

async function assertSettingsRejectedWithoutDatabase(body, error) {
  const { default: worker } = await import('../src/index.js');
  const calls = [];
  const unexpectedDatabaseCall = method => () => {
    calls.push(method);
    throw new Error(`invalid settings must not call DB.${method}`);
  };
  const response = await worker.fetch(new Request('https://worker.test/settings', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer admin-token-x',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), {
    POS_ADMIN_TOKEN: 'admin-token-x',
    DB: {
      prepare: unexpectedDatabaseCall('prepare'),
      batch: unexpectedDatabaseCall('batch'),
    },
  });
  assert.deepEqual(calls, [], 'validation must precede settings reads and all writes');
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await response.json(), { error });
}

test('invalid FY settings are rejected before any database access', async () => {
  for (const fy_start of ['2026-04-01', 'April', '4-1-2026', '13-01', '04-32', '00-01', '']) {
    await assertSettingsRejectedWithoutDatabase(
      { fy_start, legal_name: 'must not persist' },
      'fy_start must be MM-DD, e.g. 04-01 for the Indian financial year',
    );
  }
});

test('invalid invoice series are rejected before any database access', async () => {
  for (const invoice_series of ['TOOLONG', 'A B', 'A@B', '', 'ABCDEF']) {
    await assertSettingsRejectedWithoutDatabase(
      { invoice_series, legal_name: 'must not persist' },
      'invoice_series must be 1-5 characters of letters, digits, - or /',
    );
  }
});

test('an empty settings update is rejected before any database access', async () => {
  await assertSettingsRejectedWithoutDatabase({}, 'no settings given');
});
