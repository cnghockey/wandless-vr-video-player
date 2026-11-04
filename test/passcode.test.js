import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveAuth, loadAuth, verifyPassword } from '../lib/auth.js';
import { startServer } from '../server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let base;
let srv;

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: srv.port, path: urlPath, method, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const form = (password) => ({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-passcode-'));
  fs.mkdirSync(path.join(base, 'media'));
  fs.writeFileSync(path.join(base, 'app.html'), 'app');
  saveAuth(path.join(base, 'state'), '2468', { kind: 'passcode' });
  srv = await startServer({ port: 0, host: '127.0.0.1', mediaRoot: path.join(base, 'media'), stateDir: path.join(base, 'state'), appFile: path.join(base, 'app.html') });
});

after(async () => {
  await srv.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('a passcode login page has a number keypad and asks for the number keyboard', async () => {
  const page = (await request('GET', '/login')).body;
  assert.match(page, /inputmode="numeric"/);
  assert.match(page, /placeholder="Passcode"/);
  for (const d of '0123456789') assert.ok(page.includes(`data-key="${d}"`), `key ${d}`);
  assert.match(page, /id="del">Delete</);
  assert.match(page, /type="submit" class="key go">Unlock</);
  assert.ok(!/autofocus/.test(page), 'no autofocus: the system keyboard does not cover the keypad');
});

test('the passcode unlocks; a wrong one says "Wrong passcode."', async () => {
  const bad = await request('POST', '/login', form('2469'));
  assert.equal(bad.status, 401);
  assert.match(bad.body, /Wrong passcode\./);
  assert.match(bad.body, /data-key="5"/, 'the keypad is back for the next try');
  const ok = await request('POST', '/login', form('2468'));
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/');
});

const runSetPassword = (args, input) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-setpw-'));
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'set-password.js'), ...args], {
    input, encoding: 'utf8', env: { ...process.env, VR_STATE_DIR: dir }, timeout: 30_000,
  });
  return { ...r, dir, rec: loadAuth(dir) };
};

test('npm run set-password: a passcode by default, digits only; --password allows letters', () => {
  const ok = runSetPassword([], '2468\n');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.rec.kind, 'passcode');
  assert.ok(verifyPassword('2468', ok.rec));
  assert.match(ok.stdout, /number keypad/);
  const letters = runSetPassword([], 'ab12\n');
  assert.equal(letters.status, 1);
  assert.match(letters.stderr, /digits only/);
  assert.equal(letters.rec, null, 'nothing was saved');
  const short = runSetPassword([], '123\n');
  assert.equal(short.status, 1);
  assert.equal(short.rec, null);
  const text = runSetPassword(['--password'], 'open sesame\n');
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.rec.kind, 'password');
  assert.ok(verifyPassword('open sesame', text.rec));
  const fromPowerShell = runSetPassword([], '﻿1357\r\n'); // PowerShell pipes a byte order mark and CRLF
  assert.equal(fromPowerShell.status, 0, fromPowerShell.stderr);
  assert.ok(verifyPassword('1357', fromPowerShell.rec));
  for (const r of [ok, letters, short, text, fromPowerShell]) fs.rmSync(r.dir, { recursive: true, force: true });
});
