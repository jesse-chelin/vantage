'use strict';

// Server-side WebAuthn (Touch ID), authoritative, not a client-side gate.
//
// Registration verifies the attestation object, extracts the credential public
// key from the authenticator data, and stores it. Authentication verifies the
// signature over authenticatorData || SHA256(clientDataJSON) and, on success,
// issues a short-lived HMAC grant that the action runner requires for
// "danger" actions. No external dependencies: parsing uses lib/cbor.js and
// verification uses node:crypto.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { decodeFirst } = require('./cbor');

const DATA_DIR = process.env.VANTAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'webauthn.json');
const RP_NAME = 'Vantage';
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const GRANT_TTL_MS = 90 * 1000;

const PUBLIC_KEY_ALGS = [-7, -257]; // ES256, RS256

let store = null;
let loaded = false;
const challenges = new Map(); // challengeId -> { challenge, type, rpId, origin, expires }

const b64url = (value) => Buffer.from(value).toString('base64url');
const fromB64url = (value) => Buffer.from(String(value || ''), 'base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

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
  if (!Array.isArray(store.credentials)) store.credentials = [];
  if (typeof store.enabled !== 'boolean') store.enabled = store.credentials.length > 0;
  if (!store.userHandle) store.userHandle = b64url(crypto.randomBytes(16));
  if (!store.secret) store.secret = b64url(crypto.randomBytes(32));
  loaded = true;
  if (fresh) await save().catch(() => {});
  return store;
}

async function save() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function rpFromHost(hostHeader) {
  const hostname = String(hostHeader || '').split(':')[0].toLowerCase();
  if (!hostname) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return null; // IP literal
  return hostname;
}

function originFromRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

// --- authenticator data ----------------------------------------------------

function parseAuthData(buffer) {
  const buf = Buffer.from(buffer);
  if (buf.length < 37) throw new Error('authenticator data too short');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  let offset = 37;
  let aaguid = null;
  let credentialId = null;
  let credentialPublicKey = null;
  if (flags & 0x40) {
    aaguid = buf.subarray(offset, offset + 16);
    offset += 16;
    const idLength = buf.readUInt16BE(offset);
    offset += 2;
    credentialId = buf.subarray(offset, offset + idLength);
    offset += idLength;
    ({ value: credentialPublicKey } = decodeFirst(buf.subarray(offset)));
  }
  return { rpIdHash, flags, signCount, aaguid, credentialId, credentialPublicKey };
}

function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new Error('credential public key is not a COSE map');
  const kty = cose.get(1);
  if (kty === 2) {
    const curve = cose.get(-1);
    const name = { 1: 'P-256', 2: 'P-384', 3: 'P-521' }[curve];
    if (!name) throw new Error('unsupported EC curve');
    return { kty: 'EC', crv: name, x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) };
  }
  if (kty === 3) {
    return { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) };
  }
  if (kty === 1) {
    const name = { 6: 'Ed25519', 7: 'Ed448' }[cose.get(-1)];
    if (!name) throw new Error('unsupported OKP curve');
    return { kty: 'OKP', crv: name, x: b64url(cose.get(-2)) };
  }
  throw new Error('unsupported COSE key type');
}

function publicKeyObject(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function verifySignature(jwk, data, signature) {
  const digest = jwk.kty === 'OKP' ? null : 'sha256';
  return crypto.verify(digest, data, publicKeyObject(jwk), Buffer.from(signature));
}

function parseClientData(clientDataJSON) {
  return JSON.parse(fromB64url(clientDataJSON).toString('utf8'));
}

function checkClientData(clientData, type, expected) {
  if (clientData.type !== type) throw new Error(`unexpected ceremony "${clientData.type}"`);
  if (!Buffer.from(fromB64url(clientData.challenge)).equals(expected.challenge)) throw new Error('challenge mismatch');
  if (clientData.origin !== expected.origin) throw new Error('origin mismatch');
}

// --- registration ----------------------------------------------------------

async function registrationOptions(req) {
  const rpId = rpFromHost(req.headers.host);
  if (!rpId) throw Object.assign(new Error('Touch ID needs a hostname (open via http://localhost)'), { status: 400 });
  const s = await load();
  const challengeId = b64url(crypto.randomBytes(16));
  const challenge = crypto.randomBytes(32);
  challenges.set(challengeId, { challenge, type: 'register', rpId, origin: originFromRequest(req), expires: Date.now() + CHALLENGE_TTL_MS });
  return {
    challengeId,
    publicKey: {
      challenge: b64url(challenge),
      rp: { id: rpId, name: RP_NAME },
      user: { id: s.userHandle, name: 'vantage', displayName: 'Vantage' },
      pubKeyCredParams: PUBLIC_KEY_ALGS.map((alg) => ({ type: 'public-key', alg })),
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60_000,
      attestation: 'none',
    },
  };
}

async function verifyRegistration(body) {
  const pending = challenges.get(body.challengeId);
  challenges.delete(body.challengeId);
  if (!pending || pending.type !== 'register' || pending.expires < Date.now()) {
    throw Object.assign(new Error('registration challenge expired'), { status: 400 });
  }

  checkClientData(parseClientData(body.clientDataJSON), 'webauthn.create', pending);

  const { value: attestation } = decodeFirst(fromB64url(body.attestationObject));
  if (!(attestation instanceof Map)) throw Object.assign(new Error('invalid attestation object'), { status: 400 });
  const authData = parseAuthData(attestation.get('authData'));
  if (!authData.credentialPublicKey || !authData.credentialId) throw Object.assign(new Error('no credential in attestation'), { status: 400 });
  if (!(authData.flags & 0x01)) throw Object.assign(new Error('user presence flag not set'), { status: 400 });
  if (!Buffer.from(authData.rpIdHash).equals(sha256(pending.rpId))) throw Object.assign(new Error('rpIdHash mismatch'), { status: 400 });

  const s = await load();
  const credential = {
    id: b64url(authData.credentialId),
    publicKeyJwk: coseToJwk(authData.credentialPublicKey),
    signCount: authData.signCount,
    transports: Array.isArray(body.transports) ? body.transports : [],
    createdAt: new Date().toISOString(),
  };
  s.credentials = s.credentials.filter((c) => c.id !== credential.id).concat(credential);
  s.enabled = true;
  await save();
  return { ok: true, credentialId: credential.id, credentialCount: s.credentials.length };
}

// --- authentication --------------------------------------------------------

async function authenticationOptions(req) {
  const s = await load();
  if (!s.enabled || !s.credentials.length) throw Object.assign(new Error('No Touch ID credential registered'), { status: 409 });
  const rpId = rpFromHost(req.headers.host);
  const challengeId = b64url(crypto.randomBytes(16));
  const challenge = crypto.randomBytes(32);
  challenges.set(challengeId, { challenge, type: 'auth', rpId, origin: originFromRequest(req), expires: Date.now() + CHALLENGE_TTL_MS });
  return {
    challengeId,
    publicKey: {
      challenge: b64url(challenge),
      rpId,
      allowCredentials: s.credentials.map((c) => ({ id: c.id, type: 'public-key', transports: c.transports && c.transports.length ? c.transports : ['internal'] })),
      userVerification: 'required',
      timeout: 60_000,
    },
  };
}

async function verifyAuthentication(body) {
  const pending = challenges.get(body.challengeId);
  challenges.delete(body.challengeId);
  if (!pending || pending.type !== 'auth' || pending.expires < Date.now()) {
    throw Object.assign(new Error('authentication challenge expired'), { status: 400 });
  }

  const s = await load();
  const credential = s.credentials.find((c) => c.id === body.credentialId);
  if (!credential) throw Object.assign(new Error('unknown credential'), { status: 404 });

  checkClientData(parseClientData(body.clientDataJSON), 'webauthn.get', pending);

  const authData = Buffer.from(fromB64url(body.authenticatorData));
  const parsed = parseAuthData(authData);
  if (!Buffer.from(parsed.rpIdHash).equals(sha256(pending.rpId))) throw Object.assign(new Error('rpIdHash mismatch'), { status: 400 });
  if (!(parsed.flags & 0x01)) throw Object.assign(new Error('user presence flag not set'), { status: 400 });
  if (!(parsed.flags & 0x04)) throw Object.assign(new Error('user verification flag not set'), { status: 400 });

  const signedData = Buffer.concat([authData, sha256(fromB64url(body.clientDataJSON))]);
  if (!verifySignature(credential.publicKeyJwk, signedData, fromB64url(body.signature))) {
    throw Object.assign(new Error('signature verification failed'), { status: 401 });
  }

  credential.signCount = parsed.signCount;
  credential.lastUsedAt = new Date().toISOString();
  await save();
  return { ok: true, credentialId: credential.id, grant: issueGrant(), expiresAt: Date.now() + GRANT_TTL_MS };
}

// --- native (Secure Enclave) credentials -----------------------------------
//
// WKWebView can't do WebAuthn for localhost (no associated domain), so the
// native Mac app enrolls a Secure Enclave P-256 key. It signs a server-issued
// challenge with Touch ID gating, and the server verifies the ECDSA signature
// the same way it verifies a WebAuthn assertion.

async function nativeRegister(body) {
  const raw = fromB64url(body && body.publicKey);
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw Object.assign(new Error('publicKey must be an uncompressed P-256 point'), { status: 400 });
  }
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) };
  const s = await load();
  const credential = {
    id: b64url(raw.subarray(1, 33)),
    type: 'native',
    label: (body && body.name) || 'Touch ID',
    publicKeyJwk: jwk,
    signCount: 0,
    createdAt: new Date().toISOString(),
  };
  s.credentials = s.credentials.filter((c) => c.id !== credential.id).concat(credential);
  s.enabled = true;
  await save();
  return { ok: true, credentialId: credential.id, credentialCount: s.credentials.length };
}

async function nativeOptions() {
  const s = await load();
  const credential = s.credentials.find((c) => c.type === 'native');
  if (!s.enabled || !credential) {
    throw Object.assign(new Error('No native Touch ID credential registered'), { status: 409 });
  }
  const challengeId = b64url(crypto.randomBytes(16));
  const challenge = crypto.randomBytes(32);
  challenges.set(challengeId, { challenge, type: 'native', expires: Date.now() + CHALLENGE_TTL_MS });
  return { challengeId, challenge: b64url(challenge), credentialId: credential.id };
}

async function nativeVerify(body) {
  const pending = challenges.get(body && body.challengeId);
  challenges.delete(body && body.challengeId);
  if (!pending || pending.type !== 'native' || pending.expires < Date.now()) {
    throw Object.assign(new Error('native challenge expired'), { status: 400 });
  }
  const s = await load();
  const credential = s.credentials.find((c) => c.id === body.credentialId && c.type === 'native');
  if (!credential) throw Object.assign(new Error('unknown native credential'), { status: 404 });
  const key = crypto.createPublicKey({ key: credential.publicKeyJwk, format: 'jwk' });
  const ok = crypto.verify('sha256', pending.challenge, key, fromB64url(body.signature));
  if (!ok) throw Object.assign(new Error('native signature verification failed'), { status: 401 });
  credential.lastUsedAt = new Date().toISOString();
  await save();
  return { ok: true, credentialId: credential.id, grant: issueGrant(), expiresAt: Date.now() + GRANT_TTL_MS };
}

// --- action grants ---------------------------------------------------------

function issueGrant() {
  const expires = Date.now() + GRANT_TTL_MS;
  const payload = String(expires);
  const mac = crypto.createHmac('sha256', fromB64url(store.secret)).update(`action.${payload}`).digest('base64url');
  return `${payload}.${mac}`;
}

async function verifyGrant(grant) {
  if (!grant || typeof grant !== 'string') return false;
  const [payload, mac] = grant.split('.');
  if (!payload || !mac) return false;
  const expires = Number(payload);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = crypto.createHmac('sha256', fromB64url((await load()).secret)).update(`action.${payload}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- lifecycle -------------------------------------------------------------

async function status() {
  const s = await load();
  return {
    enabled: s.enabled,
    credentialCount: s.credentials.length,
    native: s.credentials.some((c) => c.type === 'native'),
    latest: s.credentials.length ? { createdAt: s.credentials.at(-1).createdAt } : null,
  };
}

async function isEnabled() {
  return (await load()).enabled;
}

async function disable() {
  const s = await load();
  s.credentials = [];
  s.enabled = false;
  await save();
  return { ok: true, enabled: false };
}

module.exports = {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  nativeRegister,
  nativeOptions,
  nativeVerify,
  verifyGrant,
  status,
  isEnabled,
  disable,
};
