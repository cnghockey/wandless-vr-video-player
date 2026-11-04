import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { startControl, pickFolderWithWindow } from '../lib/control.js';
import { startServer } from '../server.js';

// The control page: only this laptop's browser may use it, and what it saves works at once on the headset server.
let base;
let media;
let other;
let third;
let listFile;
let stateDir;
let logFile;
let app;
let control;
let picked = null; // what the stub folder window "picks"
let stopped = 0;
let clients = [];
let locked = true;
// A stand-in for lib/update.js: what the page asks of it, and what it was asked to do.
const updater = {
  checks: 0,
  applies: 0,
  why: 'There is no update to install.',
  status() {
    return { version: '0.1.0', state: this.why ? 'latest' : 'available', error: '', progress: null, latest: null, canInstall: true };
  },
  async check() {
    this.checks++;
    return this.status();
  },
  blocker() {
    return this.why;
  },
  async apply() {
    this.applies++;
  },
};

function call(method, urlPath, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: control.port, path: urlPath, method, headers: { Host: host ?? `127.0.0.1:${control.port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // the page itself, or the log
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
const change = (p, value = {}) => call('POST', p, { headers: { 'X-VR-Player': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const status = async () => (await call('GET', '/api/status')).json;

function headset(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: app.port, path: urlPath, method, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const logIn = (code) => headset('POST', '/login', {
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: code }).toString(),
});
const cookieOf = (r) => (r.headers['set-cookie'] || [''])[0].split(';')[0];

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-control-'));
  media = path.join(base, 'media');
  other = path.join(base, 'other');
  third = path.join(base, 'third');
  for (const d of [media, other, third]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(media, 'a.mp4'), Buffer.alloc(100, 1));
  fs.writeFileSync(path.join(media, 'notes.txt'), 'not a video');
  fs.writeFileSync(path.join(other, 'b.mp4'), Buffer.alloc(100, 2));
  fs.writeFileSync(path.join(other, 'c.mp4'), Buffer.alloc(100, 3));
  fs.writeFileSync(path.join(base, 'app.html'), '<h1>app</h1>');
  listFile = path.join(base, 'folders.txt');
  stateDir = path.join(base, 'state');
  logFile = path.join(stateDir, 'session-log.jsonl');
  // No password option on purpose: a caller that forgets it must get a LOCKED server.
  app = await startServer({ port: 0, host: '127.0.0.1', mediaRoot: media, stateDir, appFile: path.join(base, 'app.html') });
  control = await startControl({
    port: 0, listFile, roots: [media], stateDir, logFile,
    info: () => ({ addresses: ['192.168.1.20'], locked, previews: { state: 'making', done: 3, total: 9 }, formats: { state: 'waiting' }, clients }),
    reloadAuth: () => app.reloadAuth(),
    pickFolder: async () => picked,
    stop: () => { stopped++; },
    updater,
  });
});

after(async () => {
  await control.close();
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('only this laptop\'s own address gets an answer (no other name, no other port)', async () => {
  for (const host of ['evil.example:' + control.port, '192.168.1.20:' + control.port, '127.0.0.1:1', '127.0.0.1', 'localhost']) {
    const r = await call('GET', '/api/status', { host });
    assert.equal(r.status, 403, host);
    assert.equal(r.json.addresses, undefined, host);
  }
  assert.equal((await call('GET', '/api/status', { host: `localhost:${control.port}` })).status, 200);
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.text, /X-VR-Player/); // the page sends the header the server asks for
});

test('the page has a Donate card: Lightning only, the address, a pay link that sends no referrer, no request of its own', async () => {
  const { text } = await call('GET', '/');
  assert.match(text, /Bitcoin over Lightning only/);
  assert.match(text, /sats4ai@blink\.sv/);
  assert.match(text, /<a [^>]*href="https:\/\/pay\.blink\.sv\/sats4ai"[^>]*rel="noopener noreferrer"/);
  // Only a click by the owner leaves this PC: nothing on the page loads or fetches that address by itself.
  assert.doesNotMatch(text, /(fetch\(|XMLHttpRequest|<img|<script|<iframe|<link)[^\n]*pay\.blink\.sv/);
});

test('a change without the X-VR-Player header is refused and changes nothing', async () => {
  const plain = { 'Content-Type': 'text/plain' }; // what a form on another site can send
  const tries = [['/api/folders/add', { dir: other }], ['/api/passcode', { code: '1111' }], ['/api/stop', {}], ['/api/log/clear', {}],
    ['/api/update/check', {}], ['/api/update/apply', {}]];
  updater.why = '';
  for (const [p, value] of tries) {
    const r = await call('POST', p, { headers: plain, body: JSON.stringify(value) });
    assert.equal(r.status, 403, p);
  }
  assert.equal((await call('POST', '/api/stop', { headers: { 'X-VR-Player': '0' } })).status, 403);
  assert.equal(fs.existsSync(listFile), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'auth.json')), false);
  assert.equal(stopped, 0);
  assert.equal((await call('PUT', '/api/folders/add', { headers: { 'X-VR-Player': '1' } })).status, 405);
  for (const p of ['/api/stop', '/api/folders/remove', '/favicon.ico', '/api/update/check', '/api/update/apply']) assert.equal((await call('GET', p)).status, 404, p);
  assert.equal(stopped, 0);
  assert.deepEqual([updater.checks, updater.applies], [0, 0], 'no update was checked or started');
  updater.why = 'There is no update to install.';
});

test('add a folder: it goes into folders.txt once, under the notes header', async () => {
  const r = await change('/api/folders/add', { dir: other });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { dir: path.resolve(other), result: 'added' });
  const text = fs.readFileSync(listFile, 'utf8');
  assert.match(text, /^# Wandless/);
  assert.ok(text.endsWith(`${other}\r\n`));
  // The same folder in other spellings: quotes from "Copy as path", other case, a trailing backslash.
  for (const dir of [`"${other}"`, other.toUpperCase(), `${other}\\`]) {
    const again = await change('/api/folders/add', { dir });
    assert.equal(again.json.result, 'already in the list', dir);
  }
  assert.equal(fs.readFileSync(listFile, 'utf8'), text);
  for (const dir of [path.join(base, 'nothing-here'), path.join(media, 'a.mp4')]) {
    const bad = await change('/api/folders/add', { dir });
    assert.equal(bad.status, 400, dir);
    assert.match(bad.json.error, /Not a folder/);
  }
  assert.deepEqual((await change('/api/folders/add', { dir: '   ' })).json, { cancelled: true });
  assert.equal(fs.readFileSync(listFile, 'utf8'), text);
});

test('the folder window: the folder picked is added, and a cancel adds nothing', async () => {
  picked = third;
  assert.equal((await change('/api/folders/pick')).json.result, 'added');
  picked = null;
  const before = fs.readFileSync(listFile, 'utf8');
  assert.deepEqual((await change('/api/folders/pick')).json, { cancelled: true });
  assert.equal(fs.readFileSync(listFile, 'utf8'), before);
});

test('the folders list: found or not, how many videos, and only folders.txt lines can be removed', async () => {
  const gone = path.join(base, 'unplugged');
  fs.appendFileSync(listFile, `${gone}\r\n`);
  const { folders } = (await call('GET', '/api/folders')).json;
  const by = Object.fromEntries(folders.map((f) => [f.dir, f]));
  assert.deepEqual(by[path.resolve(media)], { dir: path.resolve(media), label: 'media', found: true, videos: 1, removable: false });
  assert.deepEqual(by[path.resolve(other)], { dir: path.resolve(other), label: 'other', found: true, videos: 2, removable: true });
  assert.deepEqual(by[path.resolve(gone)], { dir: path.resolve(gone), label: 'unplugged', found: false, videos: 0, removable: true });
  assert.equal(folders.length, 4);
});

test('remove a folder: its line goes, the notes and the other folders stay', async () => {
  fs.appendFileSync(listFile, '# my own note\r\n');
  const r = await change('/api/folders/remove', { dir: other.toUpperCase() });
  assert.equal(r.status, 200);
  const text = fs.readFileSync(listFile, 'utf8');
  assert.ok(!text.includes(other), 'the removed folder is gone');
  assert.ok(text.includes(third));
  assert.ok(text.includes('# my own note'));
  assert.match(text, /^# Wandless/);
  assert.equal((await change('/api/folders/remove', { dir: other })).status, 404);
  assert.equal((await change('/api/folders/remove', { dir: media })).status, 404); // a --root folder is not in the file
});

test('passcode: with none yet everything is locked; a saved one works at once; a new one ends old sessions', async () => {
  assert.equal((await headset('GET', '/api/library')).status, 401);
  const first = await headset('GET', '/login');
  assert.equal(first.status, 200);
  assert.match(first.text, /No passcode yet/);
  assert.equal((await logIn('')).status, 503);
  assert.deepEqual((await status()).passcode, { set: false });

  const bad = await change('/api/passcode', { code: '12ab', kind: 'passcode' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /digits only/);
  assert.equal((await change('/api/passcode', { code: '123', kind: 'passcode' })).status, 400);
  assert.equal(fs.existsSync(path.join(stateDir, 'auth.json')), false);

  assert.equal((await change('/api/passcode', { code: '2468', kind: 'passcode' })).status, 200);
  assert.deepEqual((await status()).passcode, { set: true, kind: 'passcode' });
  assert.match((await headset('GET', '/login')).text, /inputmode="numeric"/);
  assert.equal((await logIn('1357')).status, 401);
  const ok = await logIn('2468');
  assert.equal(ok.status, 303);
  const cookie = cookieOf(ok);
  assert.equal((await headset('GET', '/api/library', { headers: { Cookie: cookie } })).status, 200);

  assert.equal((await change('/api/passcode', { code: 'long words', kind: 'password' })).status, 200);
  assert.deepEqual((await status()).passcode, { set: true, kind: 'password' });
  assert.equal((await headset('GET', '/api/library', { headers: { Cookie: cookie } })).status, 401, 'the old session ended');
  assert.equal((await logIn('2468')).status, 401);
  const again = await logIn('long words');
  assert.equal(again.status, 303);
  assert.equal((await headset('GET', '/api/library', { headers: { Cookie: cookieOf(again) } })).status, 200);
});

test('status: what to type, the headsets (not this laptop), the background work, and the passcode off in open mode', async () => {
  clients = [{ ip: '127.0.0.1', at: Date.now() }, { ip: '::1', at: Date.now() }, { ip: '192.168.1.50', at: Date.now() - 90_000 }];
  const s = await status();
  assert.deepEqual(s.addresses, ['192.168.1.20']);
  assert.equal(s.headsets.length, 1);
  assert.equal(s.headsets[0].ip, '192.168.1.50');
  assert.ok(s.headsets[0].secondsAgo >= 90 && s.headsets[0].secondsAgo <= 91, String(s.headsets[0].secondsAgo));
  assert.deepEqual(s.previews, { state: 'making', done: 3, total: 9 });
  assert.deepEqual(s.formats, { state: 'waiting' });
  locked = false;
  assert.deepEqual((await status()).passcode, { off: true });
  locked = true;
});

test('gesture log: download it, then clear it', async () => {
  fs.rmSync(logFile, { force: true });
  assert.equal((await call('GET', '/api/log')).status, 404);
  assert.equal((await status()).log.bytes, 0);
  fs.writeFileSync(logFile, '{"type":"swipe"}\n');
  const r = await call('GET', '/api/log');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-disposition'], /^attachment; filename="session-log.jsonl"$/);
  assert.equal(r.text, '{"type":"swipe"}\n');
  assert.equal((await status()).log.bytes, 17);
  assert.equal((await change('/api/log/clear')).status, 200);
  assert.equal(fs.readFileSync(logFile, 'utf8'), '');
});

test('a body over 4 KB, or not JSON, is refused', async () => {
  const headers = { 'X-VR-Player': '1', 'Content-Type': 'application/json' };
  const big = await call('POST', '/api/folders/add', { headers, body: JSON.stringify({ dir: 'x'.repeat(5000) }) });
  assert.equal(big.status, 400);
  assert.equal(big.json.error, 'too large');
  const broken = await call('POST', '/api/folders/add', { headers, body: '{not json' });
  assert.equal(broken.status, 400);
  assert.equal(broken.json.error, 'not JSON');
});

// The real folder window needs a person. This stub prints the way add-folder.ps1 -PrintOnly does: the path
// must come back whole (accents, other scripts), and only when -PrintOnly arrives.
test('the folder window\'s answer comes back from PowerShell whole; a cancel or a failure is null', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const stub = (body) => {
    const file = path.join(base, `pick-${Math.random().toString(36).slice(2)}.ps1`);
    fs.writeFileSync(file, `param([switch]$PrintOnly)\r\nif (-not $PrintOnly) { exit 3 }\r\n${body}\r\n`);
    return file;
  };
  const utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';
  const named = stub(`${utf8}\r\n[Console]::Out.Write("D:\\Vid$([char]0xE9)os\\$([char]0x6620)$([char]0x753B) 2026")`);
  assert.equal(await pickFolderWithWindow(named), 'D:\\Vidéos\\映画 2026');
  assert.equal(await pickFolderWithWindow(stub('exit 0')), null);
  assert.equal(await pickFolderWithWindow(stub('exit 1')), null);
});

test('updates: the status shows the updater; "check" asks it; "update" starts only when it can, and answers at once', async () => {
  assert.deepEqual((await status()).update, updater.status());
  const checked = await change('/api/update/check');
  assert.equal(checked.status, 200);
  assert.equal(checked.json.state, 'latest');
  assert.equal(updater.checks, 1);
  const refused = await change('/api/update/apply');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'There is no update to install.');
  assert.equal(updater.applies, 0);
  updater.why = '';
  const started = await change('/api/update/apply');
  assert.equal(started.status, 202);
  assert.deepEqual(started.json, { started: true });
  assert.equal(updater.applies, 1);
  updater.why = 'There is no update to install.';
});

test('stop: it answers first, then stops', async () => {
  const r = await change('/api/stop');
  assert.deepEqual(r.json, { stopping: true });
  assert.equal(stopped, 0);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(stopped, 1);
});
