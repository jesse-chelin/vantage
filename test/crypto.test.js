'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Isolate all data files for this suite before the modules compute their paths.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-crypto-'));
process.env.VANTAGE_DATA_DIR = TMP;

const { decodeFirst } = require('../lib/cbor');
const push = require('../lib/push');
const webauthn = require('../lib/webauthn');

const b64url = (value) => Buffer.from(value).toString('base64url');

test('cbor decodes a COSE EC2-style map with numeric keys', () => {
  // {1: 2, -1: 1, -2: h'0102', -3: h'0304'}
  const bytes = Uint8Array.from([0xa4, 0x01, 0x02, 0x20, 0x01, 0x21, 0x42, 0x01, 0x02, 0x22, 0x42, 0x03, 0x04]);
  const { value } = decodeFirst(bytes);
  assert.ok(value instanceof Map);
  assert.equal(value.get(1), 2);
  assert.equal(value.get(-1), 1);
  assert.deepEqual([...value.get(-2)], [1, 2]);
  assert.deepEqual([...value.get(-3)], [3, 4]);
});

test('cbor decodes byte strings, text and negative tag values', () => {
  const { value } = decodeFirst(Uint8Array.from([0x82, 0x63, 0x66, 0x6f, 0x6f, 0x39, 0x03, 0xe7]));
  assert.deepEqual(value, ['foo', -1000]);
});

test('push.encrypt matches the RFC 8291 §5 worked example', () => {
  const subscription = {
    keys: {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
  };
  const body = push.encrypt(subscription, 'When I grow up, I want to be a watermelon', {
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  });
  assert.equal(
    b64url(body),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('push.encrypt rejects malformed subscription keys', () => {
  assert.throws(() => push.encrypt({ keys: { p256dh: 'AA', auth: 'AA' } }, 'x'), /p256dh/);
  assert.throws(() => push.encrypt({ keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: 'AA' } }, 'x'), /auth secret/);
});

test('webauthn refuses an IP-literal host for registration', async () => {
  await assert.rejects(webauthn.registrationOptions({ headers: { host: '127.0.0.1:8790' } }), /hostname/);
});

test('webauthn verifies a valid assertion and issues a verifiable grant', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = b64url('test-credential-1');
  fs.writeFileSync(
    path.join(TMP, 'webauthn.json'),
    JSON.stringify({
      enabled: true,
      secret: b64url(crypto.randomBytes(32)),
      userHandle: b64url(crypto.randomBytes(16)),
      credentials: [{ id: credentialId, publicKeyJwk: jwk, signCount: 0, transports: ['internal'] }],
    }),
  );

  const req = { headers: { host: 'localhost:8790' } };
  const options = await webauthn.authenticationOptions(req);
  const clientDataJSON = b64url(JSON.stringify({ type: 'webauthn.get', challenge: options.publicKey.challenge, origin: 'http://localhost:8790' }));
  const rpIdHash = crypto.createHash('sha256').update('localhost').digest();
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.alloc(4)]); // UP | UV, signCount 0
  const clientDataHash = crypto.createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest();
  const signature = crypto.sign('sha256', Buffer.concat([authData, clientDataHash]), privateKey);

  const result = await webauthn.verifyAuthentication({
    challengeId: options.challengeId,
    credentialId,
    authenticatorData: authData.toString('base64url'),
    clientDataJSON,
    signature: signature.toString('base64url'),
  });
  assert.ok(result.grant, 'expected a grant');
  assert.equal(await webauthn.verifyGrant(result.grant), true);
  assert.equal(await webauthn.verifyGrant('12345.deadbeef'), false);
  assert.equal(await webauthn.verifyGrant(''), false);
});

test('webauthn rejects a signature that does not match', async () => {
  // Reuse the credential registered above (the module caches its store).
  const credentialId = b64url('test-credential-1');
  const options = await webauthn.authenticationOptions({ headers: { host: 'localhost:8790' } });
  const clientDataJSON = b64url(JSON.stringify({ type: 'webauthn.get', challenge: options.publicKey.challenge, origin: 'http://localhost:8790' }));
  const rpIdHash = crypto.createHash('sha256').update('localhost').digest();
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.alloc(4)]);
  const wrongSignature = crypto.sign('sha256', Buffer.from('not the signed data'), crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);

  await assert.rejects(
    webauthn.verifyAuthentication({
      challengeId: options.challengeId,
      credentialId,
      authenticatorData: authData.toString('base64url'),
      clientDataJSON,
      signature: wrongSignature.toString('base64url'),
    }),
    /signature verification failed/,
  );
});

test('webauthn full registration → assertion → grant round-trip', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');

  const header = (major, length) => {
    if (length < 24) return Buffer.from([major | length]);
    if (length < 256) return Buffer.from([major | 24, length]);
    return Buffer.from([major | 25, length >> 8, length & 0xff]);
  };
  const cborUint = (n) => (n < 24 ? Buffer.from([n]) : Buffer.from([24, n]));
  const cborNeg = (v) => { const n = -1 - v; return n < 24 ? Buffer.from([0x20 | n]) : Buffer.from([0x38, n]); };
  const cborText = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([header(0x60, b.length), b]); };
  const cborBytes = (b) => Buffer.concat([header(0x40, b.length), b]);
  const cborMap = (pairs) => Buffer.concat([header(0xa0, pairs.length), ...pairs.flat()]);

  const coseKey = cborMap([
    [cborUint(1), cborUint(2)], // kty: EC2
    [cborUint(3), cborNeg(-7)], // alg: ES256
    [cborNeg(-1), cborUint(1)], // crv: P-256
    [cborNeg(-2), cborBytes(x)],
    [cborNeg(-3), cborBytes(y)],
  ]);

  const options = await webauthn.registrationOptions({ headers: { host: 'localhost:8790' } });
  const challenge = Buffer.from(options.publicKey.challenge, 'base64url');
  const clientDataJSON = b64url(JSON.stringify({ type: 'webauthn.create', challenge: options.publicKey.challenge, origin: 'http://localhost:8790' }));

  const credentialId = crypto.randomBytes(16);
  const rpIdHash = crypto.createHash('sha256').update('localhost').digest();
  const authData = Buffer.concat([
    rpIdHash,
    Buffer.from([0x41]), // AT | UP
    Buffer.alloc(4), // signCount
    Buffer.alloc(16), // aaguid
    Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]),
    credentialId,
    coseKey,
  ]);
  const attestationObject = cborMap([
    [cborText('fmt'), cborText('none')],
    [cborText('authData'), cborBytes(authData)],
    [cborText('attStmt'), cborMap([])],
  ]);

  const registered = await webauthn.verifyRegistration({
    challengeId: options.challengeId,
    attestationObject: b64url(attestationObject),
    clientDataJSON,
    transports: ['internal'],
  });
  assert.equal(registered.ok, true);

  const status = await webauthn.status();
  assert.equal(status.enabled, true);
  assert.ok(status.credentialCount >= 1);

  // Now authenticate with the registered credential.
  const authOptions = await webauthn.authenticationOptions({ headers: { host: 'localhost:8790' } });
  const authClientData = b64url(JSON.stringify({ type: 'webauthn.get', challenge: authOptions.publicKey.challenge, origin: 'http://localhost:8790' }));
  const authDataOut = Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.alloc(4)]);
  const hash = crypto.createHash('sha256').update(Buffer.from(authClientData, 'base64url')).digest();
  const signature = crypto.sign('sha256', Buffer.concat([authDataOut, hash]), privateKey);
  const result = await webauthn.verifyAuthentication({
    challengeId: authOptions.challengeId,
    credentialId: registered.credentialId,
    authenticatorData: authDataOut.toString('base64url'),
    clientDataJSON: authClientData,
    signature: signature.toString('base64url'),
  });
  assert.equal(await webauthn.verifyGrant(result.grant), true);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
