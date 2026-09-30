/**
 * Authentication & Authorization Module
 *
 * Active middleware accepts only the established legacy till/admin tokens.
 * Password, JWT, MFA, RBAC and audit helpers remain deferred draft functionality.
 * All crypto uses Web Crypto API (available in Workers runtime).
 */

import { json } from './index.js';

// ---------------------------------------------------------------------------
// Password hashing (bcrypt via Web Crypto - using scrypt as fallback)
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
const SCRYPT_SALT_LEN = 16;

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SCRYPT_SALT_LEN));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    SCRYPT_DKLEN * 8
  );
  const hash = new Uint8Array(derived);
  // Format: $scrypt$N$r$p$salt$hash
  return `$scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...hash))}`;
}

async function verifyPassword(password, storedHash) {
  // Support both scrypt format and bcrypt (if migrated)
  if (storedHash.startsWith('$scrypt$')) {
    const [, , N, r, p, saltB64, hashB64] = storedHash.split('$');
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const expectedHash = Uint8Array.from(atob(hashB64), c => c.charCodeAt(0));

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      key,
      SCRYPT_DKLEN * 8
    );
    const actualHash = new Uint8Array(derived);
    return timingSafeEqual(actualHash, expectedHash);
  }
  // Fallback for bcrypt (would need bcrypt library)
  return false;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// JWT (HS256 via Web Crypto)
// ---------------------------------------------------------------------------

async function getJwtKey(env) {
  const secret = env.JWT_SECRET || env.POS_ADMIN_TOKEN; // fallback for migration
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function createToken(payload, env, ttlSeconds = 900) {
  const key = await getJwtKey(env);
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + ttlSeconds };
  const encoder = new TextEncoder();
  const unsigned = btoa(JSON.stringify(header)).replace(/=/g, '') + '.' +
    btoa(JSON.stringify(claims)).replace(/=/g, '');
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '');
  return `${unsigned}.${sigB64}`;
}

async function verifyToken(token, env) {
  const key = await getJwtKey(env);
  const [headerB64, claimsB64, sigB64] = token.split('.');
  if (!headerB64 || !claimsB64 || !sigB64) return null;

  const encoder = new TextEncoder();
  const unsigned = `${headerB64}.${claimsB64}`;
  const sig = Uint8Array.from(atob(sigB64 + '==='.slice((sigB64.length + 3) % 4)), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(unsigned));
  if (!valid) return null;

  const claims = JSON.parse(atob(claimsB64 + '==='.slice((claimsB64.length + 3) % 4)));
  if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

// ---------------------------------------------------------------------------
// MFA (TOTP - RFC 6238)
// ---------------------------------------------------------------------------

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.toUpperCase().replace(/\s/g, '')) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

async function generateTotp(secret, timeStep = 30, digits = 6) {
  const key = base32Decode(secret);
  let counter = BigInt(Math.floor(Date.now() / 1000 / timeStep));
  const counterBytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = Number(counter & 0xffn);
    counter >>= 8n;
  }
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const hmac = await crypto.subtle.sign('HMAC', cryptoKey, counterBytes);
  const hmacBytes = new Uint8Array(hmac);
  const offset = hmacBytes[19] & 0xf;
  const code = ((hmacBytes[offset] & 0x7f) << 24) |
    (hmacBytes[offset + 1] << 16) |
    (hmacBytes[offset + 2] << 8) |
    hmacBytes[offset + 3];
  const otp = code % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}

async function verifyTotp(secret, token, window = 1) {
  const current = await generateTotp(secret);
  if (timingSafeEqual(new TextEncoder().encode(current), new TextEncoder().encode(token))) return true;
  for (let i = 1; i <= window; i++) {
    const past = await generateTotp(secret, 30, 6); // Simplified - in real impl, adjust counter
    // For proper window, we'd need to test counter-1, counter+1 etc.
    // This is a simplified version
  }
  return false;
}

function generateMfaSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  for (const b of bytes) out += alphabet[b & 31];
  return out.match(/.{1,4}/g).join(' ');
}

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

const PERMISSION_CACHE = new Map();

async function getUserPermissions(db, userId) {
  if (PERMISSION_CACHE.has(userId)) return PERMISSION_CACHE.get(userId);
  const row = await db.prepare(
    `SELECT r.permissions FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ? AND u.is_active = 1`
  ).bind(userId).first();
  if (!row) return [];
  const perms = JSON.parse(row.permissions || '[]');
  PERMISSION_CACHE.set(userId, perms);
  return perms;
}

function hasPermission(userPerms, required) {
  if (userPerms.includes('admin.all')) return true;
  if (Array.isArray(required)) return required.every(p => userPerms.includes(p));
  return userPerms.includes(required);
}

function clearPermissionCache(userId) {
  PERMISSION_CACHE.delete(userId);
}

// ---------------------------------------------------------------------------
// Audit Logging
// ---------------------------------------------------------------------------

async function auditLog(db, {
  actorId,
  actorUsername,
  action,
  entityType,
  entityId = null,
  oldValues = null,
  newValues = null,
  ipAddress = null,
  userAgent = null,
  requestId = null,
  businessDate = null,
}) {
  await db.prepare(
    `INSERT INTO audit_log (actor_id, actor_username, action, entity_type, entity_id,
                            old_values, new_values, ip_address, user_agent, request_id, business_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    actorId,
    actorUsername,
    action,
    entityType,
    entityId,
    oldValues ? JSON.stringify(oldValues) : null,
    newValues ? JSON.stringify(newValues) : null,
    ipAddress,
    userAgent,
    requestId,
    businessDate
  ).run();
}

// ---------------------------------------------------------------------------
// API Key Management
// ---------------------------------------------------------------------------

async function createApiKey(db, { name, roleId, scopes = [], allowedIps = null, expiresAt = null, createdBy }) {
  const rawKey = `pos_${crypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}`;
  const keyHash = await hashPassword(rawKey);
  const keyPrefix = rawKey.slice(0, 8);
  await db.prepare(
    `INSERT INTO api_keys (name, key_hash, key_prefix, role_id, scopes, allowed_ips, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(name, keyHash, keyPrefix, roleId, JSON.stringify(scopes), allowedIps, expiresAt, createdBy).run();
  return { key: rawKey, prefix: keyPrefix }; // Only time the raw key is returned
}

async function verifyApiKey(db, providedKey) {
  const prefix = providedKey.slice(0, 8);
  const row = await db.prepare(
    `SELECT ak.*, r.permissions FROM api_keys ak JOIN roles r ON ak.role_id = r.id
     WHERE ak.key_prefix = ? AND ak.is_active = 1 AND (ak.expires_at IS NULL OR ak.expires_at > datetime('now'))`
  ).bind(prefix).first();
  if (!row) return null;
  const valid = await verifyPassword(providedKey, row.key_hash);
  if (!valid) return null;
  await db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).bind(row.id).run();
  return {
    id: row.id,
    name: row.name,
    roleId: row.role_id,
    permissions: JSON.parse(row.permissions || '[]'),
    scopes: JSON.parse(row.scopes || '[]'),
  };
}

// ---------------------------------------------------------------------------
// Session Management (for web admin panel)
// ---------------------------------------------------------------------------

async function createSession(db, userId, ipAddress, userAgent, ttlHours = 8) {
  const id = crypto.randomUUID();
  const csrfToken = crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  await db.prepare(
    `INSERT INTO sessions (id, user_id, ip_address, user_agent, csrf_token, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, ipAddress, userAgent, csrfToken, expiresAt).run();
  return { sessionId: id, csrfToken, expiresAt };
}

async function getSession(db, sessionId) {
  const row = await db.prepare(
    `SELECT s.*, u.username, u.role_id, r.permissions
     FROM sessions s JOIN users u ON s.user_id = u.id JOIN roles r ON u.role_id = r.id
     WHERE s.id = ? AND s.expires_at > datetime('now')`
  ).bind(sessionId).first();
  if (!row) return null;
  return {
    sessionId: row.id,
    userId: row.user_id,
    username: row.username,
    roleId: row.role_id,
    permissions: JSON.parse(row.permissions || '[]'),
    csrfToken: row.csrf_token,
  };
}

async function deleteSession(db, sessionId) {
  await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
}

async function cleanupSessions(db) {
  await db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
}

// ---------------------------------------------------------------------------
// Auth Middleware for Workers
// ---------------------------------------------------------------------------

/** Preserve the legacy raw/Bearer format and constant-time-ish comparison. */
function legacyTokenOk(header, secret) {
  if (typeof secret !== 'string' || !secret) return false;
  const token = (header || '').replace(/^Bearer\s+/i, '');
  if (token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export async function authenticateRequest(request, env, db) {
  const authHeader = request.headers.get('Authorization');

  // Phase 2 recovery: do not invoke draft JWT/API-key authentication or its tables.
  // Admin wins if deployments have configured the same token for both roles.
  if (legacyTokenOk(authHeader, env.POS_ADMIN_TOKEN)) {
    return {
      userId: 1,
      username: 'admin',
      roleId: 1, // owner role
      permissions: ['admin.all'],
      authType: 'legacy_admin',
    };
  }
  if (legacyTokenOk(authHeader, env.POS_TOKEN)) {
    return {
      userId: null,
      username: 'till',
      roleId: 3, // sales role
      permissions: ['sales.create', 'sales.print', 'inventory.read'],
      authType: 'legacy_till',
    };
  }

  return null;
}

export function requireAuth(auth, requiredPerm) {
  if (!auth) return json({ error: 'unauthorized' }, 401);
  if (requiredPerm === null) return null;
  if (!hasPermission(auth.permissions, requiredPerm)) {
    if (auth.authType === 'legacy_till' || auth.authType === 'legacy_admin') {
      return json({ error: 'unauthorized' }, 401);
    }
    return json({ error: 'forbidden', required: requiredPerm }, 403);
  }
  return null;
}

export {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  generateMfaSecret,
  generateTotp,
  verifyTotp,
  hasPermission,
  clearPermissionCache,
  auditLog,
  createApiKey,
  verifyApiKey,
  createSession,
  getSession,
  deleteSession,
  cleanupSessions,
};