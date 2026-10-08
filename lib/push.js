'use strict';

// Web Push: VAPID + RFC 8291 (aes128gcm) payload encryption, no dependencies.
// Subscriptions live in data/push.json alongside a generated VAPID key pair.
// The encrypt() core is pure and injectable (sender key + salt) so it can be
// validated against the worked example in RFC 8291 §5 / Appendix A.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = process.env.VANTAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'push.json');
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const DEFAULT_TTL = 60;

let store = null;
let loaded = false;

const b64url = (value) => Buffer.from(value).toString('base64url');
const fromB64url = (value) => Buffer.from(String(value || ''), 'base64url');

function generateVapid() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
  return { publicKey: b64url(raw), privateJwk: jwk };
}

async function load() {
  if (loaded) return store;
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    raw = null;
  }
  const fresh = !raw || typeof raw !== 'object';
  store = fresh ? {} : raw;
  if (!Array.isArray(store.subscriptions)) store.subscriptions = [];
  if (!store.subject || store.subject === 'mailto:vantage@localhost') store.subject = SUBJECT;
  if (!store.vapid || !store.vapid.publicKey) store.vapid = generateVapid();
  loaded = true;
  if (fresh) await save().catch(() => {});
  return store;
}

async function save() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * Encrypt a payload for a subscription per RFC 8291.
 * `asPrivate` (sender ephemeral private key) and `salt` are injectable for tests.
 */
function encrypt(subscription, payload, { asPrivate, salt } = {}) {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  if (uaPublic.length !== 65) throw new Error('subscription p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('subscription auth secret must be 16 bytes');

  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(fromB64url(asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  if (asPublic.length !== 65) throw new Error('malformed sender public key');

  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const useSalt = salt ? fromB64url(salt) : crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, useSalt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, useSalt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const record = Buffer.concat([Buffer.from(String(payload), 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  const idlen = Buffer.from([asPublic.length]);
  return Buffer.concat([useSalt, rs, idlen, asPublic, ciphertext]);
}

function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: store.subject })));
  const data = `${header}.${claims}`;
  const key = crypto.createPrivateKey({ key: store.vapid.privateJwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64url(signature)}, k=${store.vapid.publicKey}`;
}

async function removeSubscription(endpoint) {
  const s = await load();
  const before = s.subscriptions.length;
  s.subscriptions = s.subscriptions.filter((sub) => sub.endpoint !== endpoint);
  if (s.subscriptions.length !== before) await save();
}

async function subscribe(subscription) {
  if (!subscription || !subscription.endpoint) throw Object.assign(new Error('subscription is required'), { status: 400 });
  const keys = subscription.keys || {};
  if (!keys.p256dh || !keys.auth) throw Object.assign(new Error('subscription keys are required'), { status: 400 });
  const s = await load();
  const entry = { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, createdAt: new Date().toISOString() };
  s.subscriptions = s.subscriptions.filter((sub) => sub.endpoint !== entry.endpoint).concat(entry);
  await save();
  return { ok: true, count: s.subscriptions.length };
}

async function unsubscribe(endpoint) {
  await removeSubscription(endpoint);
  return { ok: true };
}

async function sendPush(subscription, payload, { ttl = DEFAULT_TTL } = {}) {
  const body = encrypt(subscription, payload);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttl),
      'Content-Encoding': 'aes128gcm',
      'Content-Length': String(body.length),
      Authorization: vapidHeader(subscription.endpoint),
    },
    body,
  });
  if (response.status === 404 || response.status === 410) {
    await removeSubscription(subscription.endpoint);
    throw new Error(`subscription expired (${response.status})`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`push ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.status;
}

async function broadcast(title, body) {
  const s = await load();
  if (!s.subscriptions.length) return [];
  const payload = JSON.stringify({ title, body });
  const results = [];
  for (const subscription of [...s.subscriptions]) {
    try {
      results.push({ endpoint: subscription.endpoint.slice(0, 40), status: await sendPush(subscription, payload) });
    } catch (error) {
      results.push({ endpoint: subscription.endpoint.slice(0, 40), error: error.message });
    }
  }
  return results;
}

async function status() {
  const s = await load();
  return { publicKey: s.vapid.publicKey, subscriptions: s.subscriptions.length };
}

module.exports = { encrypt, subscribe, unsubscribe, broadcast, status, load, removeSubscription };
