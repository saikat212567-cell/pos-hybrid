import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticateRequest, createToken, requireAuth } from '../src/auth.js';

const legacyEnv = { POS_TOKEN: 'test-token', POS_ADMIN_TOKEN: 'admin-token-x' };

function request(authorization, extraHeaders = {}) {
  return new Request('https://worker.test/products', {
    headers: {
      ...(authorization === undefined ? {} : { Authorization: authorization }),
      ...extraHeaders,
    },
  });
}

async function authenticateWithoutDatabase(req, env = legacyEnv) {
  const calls = [];
  const db = new Proxy({}, {
    get(_target, property) {
      calls.push(property);
      throw new Error(`legacy authentication must not access DB.${String(property)}`);
    },
  });
  try {
    return await authenticateRequest(req, env, db);
  } finally {
    assert.deepEqual(calls, [], 'authentication must not access draft auth tables');
  }
}

for (const [label, token, authType] of [
  ['till', legacyEnv.POS_TOKEN, 'legacy_till'],
  ['admin', legacyEnv.POS_ADMIN_TOKEN, 'legacy_admin'],
]) {
  test(`${label} credentials accept raw and case-insensitive Bearer tokens without JWT configuration`, async () => {
    for (const header of [token, `Bearer ${token}`, `bearer ${token}`, `bEaReR\t  ${token}`]) {
      const auth = await authenticateWithoutDatabase(request(header));
      assert.equal(auth?.authType, authType, header);
      assert.equal(auth.username, label);
    }
  });
}

test('legacy authentication does not inspect JWT configuration or require a database binding', async () => {
  const env = {
    ...legacyEnv,
    get JWT_SECRET() { throw new Error('JWT authentication is deferred'); },
  };
  assert.equal((await authenticateRequest(request('Bearer test-token'), env))?.authType, 'legacy_till');
  assert.equal(await authenticateRequest(request('Bearer malformed.jwt.token'), env), null);
});

test('admin takes precedence when both configured legacy tokens are identical', async () => {
  const auth = await authenticateWithoutDatabase(request('shared-token'), {
    POS_TOKEN: 'shared-token', POS_ADMIN_TOKEN: 'shared-token',
  });
  assert.equal(auth?.authType, 'legacy_admin');
  assert.deepEqual(auth.permissions, ['admin.all']);
});

test('missing and unconfigured credentials fail closed', async () => {
  for (const env of [{}, { POS_TOKEN: '', POS_ADMIN_TOKEN: '' }, legacyEnv]) {
    for (const header of [undefined, '', 'Bearer']) {
      assert.equal(await authenticateWithoutDatabase(request(header), env), null);
    }
  }
  for (const env of [{}, { POS_TOKEN: '', POS_ADMIN_TOKEN: '' }]) {
    for (const header of ['test-token', 'Bearer test-token', 'admin-token-x', 'Bearer admin-token-x']) {
      assert.equal(await authenticateWithoutDatabase(request(header), env), null);
    }
  }
});

test('legacy tokens do not cross-fallback when only one credential is configured', async () => {
  assert.equal(await authenticateWithoutDatabase(request('admin-token-x'), { POS_TOKEN: 'test-token' }), null);
  assert.equal(await authenticateWithoutDatabase(request('test-token'), { POS_ADMIN_TOKEN: 'admin-token-x' }), null);
});

test('invalid credentials and malformed JWT-like headers return null rather than throwing', async () => {
  for (const header of [
    'wrong-token', 'Test-token', 'test-token-extra', 'Bearer wrong-token',
    'Bearer Test-token', 'Bearertest-token', 'Basic test-token', 'Bearer Bearer test-token',
    'Bearer test-token, admin-token-x', 'Bearer .', 'Bearer a.b.c', 'Bearer !!!.@@@.###',
    'Bearer a.b.c.d', 'pos_invalid-api-key',
  ]) {
    assert.equal(await authenticateWithoutDatabase(request(header)), null, header);
  }
});

test('API-key-only credentials remain disabled without reading auth tables', async () => {
  for (const value of ['pos_invalid-api-key', '!!!', legacyEnv.POS_TOKEN, legacyEnv.POS_ADMIN_TOKEN]) {
    assert.equal(await authenticateWithoutDatabase(request(undefined, { 'X-API-Key': value })), null);
    assert.equal(await authenticateWithoutDatabase(request('Bearer invalid', { 'X-API-Key': value })), null);
  }
});

test('a signed JWT remains disabled even when JWT configuration exists', async () => {
  const env = { ...legacyEnv, JWT_SECRET: 'legacy-auth-test-secret-not-for-production' };
  const token = await createToken({ sub: 1 }, env);
  assert.equal(await authenticateWithoutDatabase(request(`Bearer ${token}`), env), null);
});

test('an unused API-key header does not override valid legacy credentials', async () => {
  for (const [token, type] of [[legacyEnv.POS_TOKEN, 'legacy_till'], [legacyEnv.POS_ADMIN_TOKEN, 'legacy_admin']]) {
    const auth = await authenticateWithoutDatabase(request(token, { 'X-API-Key': 'pos_unused' }));
    assert.equal(auth?.authType, type);
  }
});

test('legacy tokens are opaque, including configured values that resemble JWTs or API keys', async () => {
  for (const token of ['a.b.c', 'pos_legacy-token']) {
    const auth = await authenticateWithoutDatabase(request(`Bearer ${token}`), { POS_TOKEN: token });
    assert.equal(auth?.authType, 'legacy_till');
  }
});

test('till permissions are limited to catalog read, sale creation and single-bill printing', async () => {
  const auth = await authenticateWithoutDatabase(request(legacyEnv.POS_TOKEN));
  assert.deepEqual([...auth.permissions].sort(), ['inventory.read', 'sales.create', 'sales.print']);
  for (const permission of ['inventory.read', 'sales.create', 'sales.print']) {
    assert.equal(requireAuth(auth, permission), null);
  }
  for (const permission of [
    'sales.read', 'sales.refund', 'settings.read', 'settings.write', 'reports.view', 'reports.gstr',
    'users.read', 'users.write', 'parties.read', 'parties.write', 'inventory.write', 'admin.all',
  ]) {
    const response = requireAuth(auth, permission);
    assert.equal(response?.status, 401, permission);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
});

test('an authenticated null permission allows access without making anonymous access public', async () => {
  for (const auth of [
    { authType: 'legacy_till', permissions: [] },
    { authType: 'legacy_admin', permissions: ['admin.all'] },
    { authType: 'jwt', permissions: [] },
  ]) {
    assert.equal(requireAuth(auth, null), null);
  }
  for (const permission of [null, 'sales.create', []]) {
    const response = requireAuth(null, permission);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
});

test('insufficient legacy auth returns 401 while nonlegacy helper callers retain 403', async () => {
  for (const authType of ['legacy_till', 'legacy_admin', 'jwt', 'api_key']) {
    const response = requireAuth({ authType, permissions: [] }, 'settings.read');
    const legacy = authType.startsWith('legacy_');
    assert.equal(response.status, legacy ? 401 : 403);
    assert.deepEqual(await response.json(), legacy
      ? { error: 'unauthorized' }
      : { error: 'forbidden', required: 'settings.read' });
  }
});

test('permission arrays require every permission and admin retains full access', async () => {
  const till = await authenticateWithoutDatabase(request(legacyEnv.POS_TOKEN));
  const admin = await authenticateWithoutDatabase(request(legacyEnv.POS_ADMIN_TOKEN));
  assert.equal(requireAuth(till, ['sales.create', 'sales.print']), null);
  assert.equal(requireAuth(till, ['sales.create', 'settings.write'])?.status, 401);
  assert.equal(requireAuth(admin, ['settings.write', 'reports.view', 'users.read']), null);
});
