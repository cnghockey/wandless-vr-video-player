import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WebXR only runs on a secure page, so the laptop serves HTTPS with its own certificate.
// The headset browser shows one warning the first time. Tap Advanced, then Proceed.

export function lanIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  return ips.sort();
}

// DER, the binary form of a certificate: each value is a tag, its length, then its bytes.
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const size = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) size.unshift(n % 256);
  const length = body.length < 0x80 ? [body.length] : [0x80 | size.length, ...size];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}
const seq = (...parts) => der(0x30, ...parts);
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (let n of rest) {
    const group = [n % 128];
    for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) group.unshift(0x80 | (n % 128));
    out.push(...group);
  }
  return der(0x06, Buffer.from(out));
};
// UTCTime before 2050, GeneralizedTime from then (RFC 5280).
const time = (date) => {
  const s = `${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(s.slice(2))) : der(0x18, Buffer.from(s));
};
const TRUE = Buffer.from([0x01, 0x01, 0xff]);
const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
const NAME = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('vr-player')))));
const DAY = 86_400_000;

// The same certificate `openssl req -x509` made before: RSA 2048, SHA-256, CN=vr-player, CA:TRUE, both key ids, and
// the names localhost, 127.0.0.1 and each address. Valid from a day before now (a headset clock a little behind
// still accepts it) for 825 days.
export function makeCert(ips, now = new Date()) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyId = crypto.createHash('sha1').update(publicKey.export({ type: 'pkcs1', format: 'der' })).digest();
  const serial = crypto.randomBytes(16);
  serial[0] = 0x40 | (serial[0] & 0x3f); // a positive number with no leading zero byte
  const ext = (id, value, critical = false) => seq(oid(id), ...(critical ? [TRUE] : []), der(0x04, value));
  const names = [der(0x82, Buffer.from('localhost')), ...['127.0.0.1', ...ips].map((ip) => der(0x87, Buffer.from(ip.split('.').map(Number))))];
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), // version 3
    der(0x02, serial),
    SHA256_RSA,
    NAME,
    seq(time(new Date(now.getTime() - DAY)), time(new Date(now.getTime() + 825 * DAY))),
    NAME,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(
      ext('2.5.29.14', der(0x04, keyId)), // subject key id
      ext('2.5.29.35', seq(der(0x80, keyId))), // authority key id
      ext('2.5.29.19', seq(TRUE), true), // basic constraints: CA:TRUE, critical
      ext('2.5.29.17', seq(...names)), // subject alternative names
    )),
  );
  const cert = seq(tbs, SHA256_RSA, der(0x03, Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}

// Each new certificate brings the browser warning back on the headset. So the certificate keeps every address the laptop
// has had since it was made (the newest MAX_ADDRESSES): an adapter that goes away and comes back (the Mobile hotspot, a
// cable), or a network you return to, does not make a new one. It is made again only for an address it does not name yet,
// or when less than RENEW_BEFORE of its life is left. tls-ips.json holds the addresses it names, the newest last. (Up to
// 0.1.3 it held the addresses of the last start, sorted, and any change of them made a new certificate. That file still reads.)
const MAX_ADDRESSES = 8;
const RENEW_BEFORE = 30 * DAY;

function namedAddresses(ipsFile) {
  try {
    const list = JSON.parse(fs.readFileSync(ipsFile, 'utf8'));
    return Array.isArray(list) ? list.filter((ip) => typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) : [];
  } catch {
    return [];
  }
}

function lastsLongEnough(certFile, now) {
  try {
    return Date.parse(new crypto.X509Certificate(fs.readFileSync(certFile)).validTo) - now.getTime() > RENEW_BEFORE;
  } catch {
    return false;
  }
}

// Return { key, cert } as strings.
export function ensureCert(stateDir, ips = lanIps(), now = new Date()) {
  fs.mkdirSync(stateDir, { recursive: true });
  const keyFile = path.join(stateDir, 'tls-key.pem');
  const certFile = path.join(stateDir, 'tls-cert.pem');
  const ipsFile = path.join(stateDir, 'tls-ips.json');
  const named = namedAddresses(ipsFile);

  const fresh = fs.existsSync(keyFile) && fs.existsSync(certFile) && ips.every((ip) => named.includes(ip)) && lastsLongEnough(certFile, now);

  if (!fresh) {
    const addresses = [...new Set([...named.filter((ip) => !ips.includes(ip)), ...ips])].slice(-MAX_ADDRESSES);
    const { key, cert } = makeCert(addresses, now);
    fs.writeFileSync(keyFile, key);
    fs.writeFileSync(certFile, cert);
    fs.writeFileSync(ipsFile, JSON.stringify(addresses));
  }
  return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') };
}
