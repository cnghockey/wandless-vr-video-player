import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { makeCert, ensureCert } from '../lib/cert.js';
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
  assert.equal(new Date(x.validTo).getTime(), NOW.getTime() + 825 * DAY);
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
  assert.equal(new Date(x.validTo).getTime(), now.getTime() + 825 * DAY); // in 2051
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

test('ensureCert keeps the certificate while the addresses stay, and makes a new one when they change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-cert-'));
  try {
    const a = ensureCert(dir, ['10.0.0.1']);
    assert.equal(ensureCert(dir, ['10.0.0.1']).cert, a.cert);
    const b = ensureCert(dir, ['10.0.0.2']);
    assert.notEqual(b.cert, a.cert);
    assert.match(new crypto.X509Certificate(b.cert).subjectAltName, /IP Address:10\.0\.0\.2$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
