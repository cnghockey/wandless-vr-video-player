import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, describeTlsError } from '../server.js';
import { findOpenssl } from './openssl.js';

let base;
let srv;
const lines = [];

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-diag-'));
  fs.mkdirSync(path.join(base, 'media'));
  fs.writeFileSync(path.join(base, 'app.html'), 'app');
  srv = await startServer({
    port: 0, host: '127.0.0.1', mediaRoot: path.join(base, 'media'), stateDir: path.join(base, 'state'),
    appFile: path.join(base, 'app.html'), password: false, log: (l) => lines.push(l),
  });
});

after(async () => {
  await srv.close();
  fs.rmSync(base, { recursive: true, force: true });
});

const ask = (options) => new Promise((resolve) => {
  const req = https.get({ host: '127.0.0.1', port: srv.port, path: '/', ...options }, (res) => { res.resume(); res.on('end', () => resolve('ok')); });
  req.on('error', (err) => resolve(err.code || err.message));
});
const settle = () => new Promise((r) => setTimeout(r, 150));

test('the first connection from an address is logged once, not on every request', async () => {
  lines.length = 0;
  await ask({ rejectUnauthorized: false });
  await ask({ rejectUnauthorized: false });
  await settle();
  assert.equal(lines.filter((l) => l.startsWith('Connection from 127.0.0.1')).length, 1);
});

test('a plain http:// request to the https port is named in the log', async () => {
  lines.length = 0;
  await new Promise((resolve) => {
    const s = net.connect(srv.port, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
    s.on('data', () => {});
    s.on('close', resolve);
    s.on('error', resolve);
  });
  await settle();
  const line = lines.find((l) => l.startsWith('TLS failed'));
  assert.ok(line, `got: ${lines.join(' | ')}`);
  assert.match(line, /127\.0\.0\.1/);
  assert.match(line, /ERR_SSL_HTTP_REQUEST/);
  assert.match(line, /Use https:\/\//);
});

test('a client that refuses the self-signed certificate is named in the log, with its address', { skip: !findOpenssl() && 'openssl is not on this PC' }, async () => {
  lines.length = 0;
  // openssl s_client with -verify_return_error sends a real TLS refusal, like a browser does.
  await new Promise((resolve) => {
    const child = spawn(findOpenssl(), ['s_client', '-connect', `127.0.0.1:${srv.port}`, '-verify_return_error'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end();
    child.on('close', resolve);
    child.on('error', resolve);
  });
  await settle();
  const line = lines.find((l) => l.startsWith('TLS failed'));
  assert.ok(line, `got: ${lines.join(' | ')}`);
  assert.match(line, /127\.0\.0\.1/);
  assert.match(line, /refused the certificate/);
});

test('describeTlsError falls back to the raw message', () => {
  assert.equal(describeTlsError({ code: 'ECONNRESET' }).includes('reset'), true);
  assert.equal(describeTlsError({ code: 'ERR_SSL_NO_SHARED_CIPHER' }).includes('no TLS version'), true);
  assert.equal(describeTlsError({ message: 'something odd' }), 'something odd');
});
