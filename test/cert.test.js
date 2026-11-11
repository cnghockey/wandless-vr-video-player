import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { makeCert, ensureCert, CERT_DAYS } from '../lib/cert.js';
import { findOpenssl } from './openssl.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-27T12:00:00Z');

test('the certificate has the shape the headset accepted from openssl req -x509', () => {
  const { key, cert } = makeCert(['192.168.1.51', '10.0.0.7'], NOW);
  const x = new crypto.X509Certificate(cert);
  assert.equal(x.subject, 'CN=vr-player');
  assert.equal(x.issuer, 'CN=vr-player');
  assert.equal(x.subjectAltName, 'DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.51, IP Address:10.0.0.7');
  assert.equal(x.ca, true);
  assert.equal(x.publicKey.asymmetricKeyType, 'rsa');
  assert.equal(x.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(new Date(x.validFrom).getTime(), NOW.getTime() - DAY);
  assert.equal(CERT_DAYS, 3650, '10 years: its end brings the warning back, so it is far away');
  assert.equal(new Date(x.validTo).getTime(), NOW.getTime() + CERT_DAYS * DAY);
  assert.ok(x.verify(x.publicKey), 'signed with its own key');
  assert.ok(x.checkIssued(x));
  assert.ok(x.checkPrivateKey(crypto.createPrivateKey(key)), 'the key belongs to the certificate');
  assert.match(key, /^-----BEGIN PRIVATE KEY-----/);
  assert.notEqual(new crypto.X509Certificate(makeCert([], NOW).cert).serialNumber, x.serialNumber, 'a new serial each time');
});

test('a date from 2050 on is written in the long form, and still reads back', () => {
  const now = new Date('2049-06-01T00:00:00Z');
  const x = new crypto.X509Certificate(makeCert([], now).cert);
  assert.equal(new Date(x.validFrom).getTime(), now.getTime() - DAY);
  assert.equal(new Date(x.validTo).getTime(), now.getTime() + CERT_DAYS * DAY); // in 2059
});

test('a client that trusts the certificate connects; the names cover localhost and each address, no other', async () => {
  const { key, cert } = makeCert(['192.168.1.51']);
  const server = https.createServer({ key, cert }, (req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const peer = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port: server.address().port, ca: cert }, () => {
        resolve(socket.getPeerCertificate());
        socket.end();
      });
      socket.on('error', reject);
    });
    assert.equal(tls.checkServerIdentity('127.0.0.1', peer), undefined);
    assert.equal(tls.checkServerIdentity('192.168.1.51', peer), undefined);
    assert.equal(tls.checkServerIdentity('localhost', peer), undefined);
    assert.ok(tls.checkServerIdentity('192.168.1.52', peer) instanceof Error);
    const body = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: server.address().port, ca: cert }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    assert.equal(body, 'ok');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ensureCert runs in a new folder each time. names(): the addresses a certificate names, as the browser reads them.
const inTempDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-cert-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const names = (cert) => new crypto.X509Certificate(cert).subjectAltName.split(', ')
  .filter((n) => n.startsWith('IP Address:')).map((n) => n.slice('IP Address:'.length)).filter((ip) => ip !== '127.0.0.1');

test('ensureCert keeps the certificate while the addresses stay, and makes a new one for an address it does not name', () => {
  inTempDir((dir) => {
    const a = ensureCert(dir, ['10.0.0.1'], NOW);
    assert.equal(ensureCert(dir, ['10.0.0.1'], NOW).cert, a.cert);
    const b = ensureCert(dir, ['10.0.0.2'], NOW);
    assert.notEqual(b.cert, a.cert);
    assert.deepEqual(names(b.cert), ['10.0.0.1', '10.0.0.2'], 'the new one still names the old address');
  });
});

test('ensureCert: an address that goes away and comes back (a hotspot, a cable, a network you return to) does not make a new certificate', () => {
  inTempDir((dir) => {
    const home = ensureCert(dir, ['192.168.1.20'], NOW);
    const withHotspot = ensureCert(dir, ['192.168.1.20', '192.168.137.1'], NOW);
    assert.notEqual(withHotspot.cert, home.cert, 'the hotspot is a new address: one new certificate');
    assert.equal(ensureCert(dir, ['192.168.1.20'], NOW).cert, withHotspot.cert, 'the hotspot is off again');
    assert.equal(ensureCert(dir, ['192.168.137.1'], NOW).cert, withHotspot.cert, 'the laptop is on the hotspot only');
    assert.equal(ensureCert(dir, ['192.168.1.20', '192.168.137.1'], NOW).cert, withHotspot.cert, 'the hotspot is on again');
    assert.equal(ensureCert(dir, [], NOW).cert, withHotspot.cert, 'no network at all (the laptop is offline)');
  });
});

test('ensureCert names at most the 8 newest addresses', () => {
  inTempDir((dir) => {
    const all = Array.from({ length: 10 }, (_, i) => `10.0.0.${i + 1}`);
    let last;
    for (const ip of all) last = ensureCert(dir, [ip], NOW);
    assert.deepEqual(names(last.cert), all.slice(2), 'the 2 oldest are gone');
    const again = ensureCert(dir, ['10.0.0.1'], NOW);
    assert.notEqual(again.cert, last.cert, 'a dropped address is new again');
    assert.ok(names(again.cert).includes('10.0.0.1'));
    assert.equal(names(again.cert).length, 8);
  });
});

test('ensureCert makes a new certificate when less than 30 days are left, and not before', () => {
  inTempDir((dir) => {
    const a = ensureCert(dir, ['10.0.0.1'], NOW);
    assert.equal(ensureCert(dir, ['10.0.0.1'], new Date(NOW.getTime() + (CERT_DAYS - 31) * DAY)).cert, a.cert, '31 days left');
    const b = ensureCert(dir, ['10.0.0.1'], new Date(NOW.getTime() + (CERT_DAYS - 29) * DAY));
    assert.notEqual(b.cert, a.cert, '29 days left');
    assert.equal(new Date(new crypto.X509Certificate(b.cert).validTo).getTime(), NOW.getTime() + (CERT_DAYS - 29 + CERT_DAYS) * DAY);
    assert.deepEqual(names(b.cert), ['10.0.0.1']);
    const c = ensureCert(dir, ['10.0.0.1'], new Date(NOW.getTime() + 3 * CERT_DAYS * DAY));
    assert.notEqual(c.cert, b.cert, 'long out of date');
  });
});

test('ensureCert keeps the certificate of 0.1.3 (its address file holds the last addresses, sorted): no new warning after the update', () => {
  inTempDir((dir) => {
    const { key, cert } = makeCert(['10.0.0.1', '192.168.1.20'], NOW);
    fs.writeFileSync(path.join(dir, 'tls-key.pem'), key);
    fs.writeFileSync(path.join(dir, 'tls-cert.pem'), cert);
    fs.writeFileSync(path.join(dir, 'tls-ips.json'), JSON.stringify(['10.0.0.1', '192.168.1.20']));
    assert.equal(ensureCert(dir, ['192.168.1.20'], NOW).cert, cert);
    assert.equal(ensureCert(dir, ['10.0.0.1', '192.168.1.20'], NOW).cert, cert);
  });
});

test('ensureCert: a broken or foreign address file, or no key file, makes a new certificate and no crash', () => {
  inTempDir((dir) => {
    let before = ensureCert(dir, ['10.0.0.1'], NOW);
    for (const content of ['not json', '{"a":1}', '[1, null, "x", "10.0.0.1.5"]', '']) {
      fs.writeFileSync(path.join(dir, 'tls-ips.json'), content);
      const after = ensureCert(dir, ['10.0.0.1'], NOW);
      assert.notEqual(after.cert, before.cert, `the file said ${JSON.stringify(content)}`);
      assert.deepEqual(names(after.cert), ['10.0.0.1']);
      before = after;
    }
    fs.rmSync(path.join(dir, 'tls-key.pem'));
    const last = ensureCert(dir, ['10.0.0.1'], NOW);
    assert.notEqual(last.cert, before.cert, 'no key file');
    assert.ok(new crypto.X509Certificate(last.cert).checkPrivateKey(crypto.createPrivateKey(last.key)));
  });
});

const openssl = findOpenssl();
test('openssl reads it as the same kind of certificate it made itself', { skip: !openssl && 'openssl is not on this PC' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-cert-'));
  try {
    const file = path.join(dir, 'cert.pem');
    fs.writeFileSync(file, makeCert(['192.168.1.20']).cert);
    const text = execFileSync(openssl, ['x509', '-in', file, '-noout', '-text'], { encoding: 'utf8' });
    assert.match(text, /Signature Algorithm: sha256WithRSAEncryption/);
    assert.match(text, /Public-Key: \(2048 bit\)/);
    assert.match(text, /X509v3 Basic Constraints: critical\s+CA:TRUE/);
    assert.match(text, /DNS:localhost, IP Address:127\.0\.0\.1, IP Address:192\.168\.1\.20/);
    const ski = /Subject Key Identifier:\s*\n\s*([0-9A-F:]+)/.exec(text);
    const aki = /Authority Key Identifier:\s*\n\s*(?:keyid:)?([0-9A-F:]+)/.exec(text);
    assert.ok(ski && aki, text);
    assert.equal(aki[1], ski[1]);
    assert.match(execFileSync(openssl, ['verify', '-CAfile', file, file], { encoding: 'utf8' }), /: OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
