import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { saveAuth } from '../lib/auth.js';
import { parseFolderList, loadFolders, folderId } from '../lib/folders.js';
import { startServer } from '../server.js';

let base;
let srv;
let listFile;
let logFile;
let A;
let B;
let C;

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: srv.port, path: urlPath, method, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function cookie() {
  const body = new URLSearchParams({ password: 'hunter22' }).toString();
  const r = await request('POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  return r.headers['set-cookie'][0].split(';')[0];
}

const json = (r) => JSON.parse(r.body.toString());

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-folders-'));
  A = path.join(base, 'films');
  B = path.join(base, 'vr180');
  C = path.join(base, 'later');
  for (const d of [A, B, C]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(A, 'a.mp4'), 'film a');
  fs.writeFileSync(path.join(B, 'b.mp4'), 'vr180 b');
  fs.writeFileSync(path.join(C, 'c.mp4'), 'later c');
  fs.writeFileSync(path.join(base, 'app.html'), 'app');
  listFile = path.join(base, 'folders.txt');
  fs.writeFileSync(listFile, `# my folders\r\n${A}\r\n\r\n"${B}"\r\n`);
  logFile = path.join(base, 'state', 'session-log.jsonl');
  saveAuth(path.join(base, 'state'), 'hunter22');
  srv = await startServer({
    port: 0, host: '127.0.0.1', httpPort: 0, stateDir: path.join(base, 'state'), appFile: path.join(base, 'app.html'),
    folders: () => loadFolders({ listFile }).folders, // read again on each request, like the real server
  });
});

after(async () => {
  await srv.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('parseFolderList: one folder per line; comments, blank lines and the quotes of "Copy as path" are removed', () => {
  assert.deepEqual(parseFolderList('# comment\r\nC:\\Videos\r\n\r\n  "D:\\VR 180"  \n  # indented comment\nE:\\x'), ['C:\\Videos', 'D:\\VR 180', 'E:\\x']);
  assert.deepEqual(parseFolderList(''), []);
});

test('loadFolders: --root folders first, each folder once (case ignored), missing ones reported, same names told apart', () => {
  const dupA = path.join(base, 'x', 'films');
  fs.mkdirSync(dupA, { recursive: true });
  const list = path.join(base, 'list2.txt');
  fs.writeFileSync(list, [A, B.toUpperCase(), path.join(base, 'gone'), dupA].join('\n'));
  const { folders, missing } = loadFolders({ roots: [B], listFile: list });
  assert.deepEqual(folders.map((f) => f.dir), [B, A, dupA]);
  assert.deepEqual(folders.map((f) => f.label), ['vr180', `${path.basename(base)}/films`, 'x/films']);
  assert.deepEqual(missing, [path.join(base, 'gone')]);
  assert.equal(folders[0].id, folderId(B.toUpperCase()), 'the same folder in other letter case has the same id');
  assert.match(folders[0].id, /^[0-9a-f]{10}$/);
  assert.deepEqual(loadFolders({ listFile: path.join(base, 'no-such-list.txt') }), { folders: [], missing: [] });
});

test('the headset gets folder ids and names, never paths, and each library lists its own folder', async () => {
  const h = { headers: { Cookie: await cookie() } };
  const { folders } = json(await request('GET', '/api/folders', h));
  assert.deepEqual(folders, [{ id: folderId(A), label: 'films' }, { id: folderId(B), label: 'vr180' }]);
  assert.ok(!JSON.stringify(folders).includes(path.basename(base)), 'no path is sent');
  const first = json(await request('GET', '/api/library', h));
  assert.equal(first.folder, folderId(A), 'no folder asked: the first one');
  assert.deepEqual(first.files.map((f) => f.path), ['a.mp4']);
  const second = json(await request('GET', `/api/library?folder=${folderId(B)}`, h));
  assert.deepEqual(second.files.map((f) => f.path), ['b.mp4']);
});

test('a file is served only through its own folder id', async () => {
  const h = { headers: { Cookie: await cookie() } };
  const ok = await request('GET', `/media/${folderId(B)}/b.mp4`, h);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.toString(), 'vr180 b');
  assert.equal((await request('GET', `/media/${folderId(A)}/b.mp4`, h)).status, 404, 'b.mp4 is not in folder A');
  assert.equal((await request('GET', `/media/${folderId(A)}/..%2Fvr180%2Fb.mp4`, h)).status, 404, 'no climbing from A into B');
  assert.equal((await request('GET', `/media/${folderId(C)}/c.mp4`, h)).status, 404, 'a folder that is not in the list');
});

test('folders.txt is read again on each request: a folder added shows at once, a folder removed closes at once', async () => {
  const h = { headers: { Cookie: await cookie() } };
  fs.appendFileSync(listFile, `${C}\r\n`);
  assert.deepEqual(json(await request('GET', '/api/folders', h)).folders.map((f) => f.label), ['films', 'vr180', 'later']);
  assert.equal((await request('GET', `/media/${folderId(C)}/c.mp4`, h)).status, 200);
  fs.writeFileSync(listFile, `${A}\r\n${B}\r\n`);
  assert.equal((await request('GET', `/media/${folderId(C)}/c.mp4`, h)).status, 404);
  assert.equal((await request('GET', `/api/library?folder=${folderId(C)}`, h)).status, 404);
});

test('plain http on the helper port sends the browser to the https app, whatever Host it claims', async () => {
  assert.ok(srv.httpPort > 0);
  const r = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.httpPort, path: '/anything?x=1', headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    }).on('error', reject);
  });
  assert.equal(r.status, 302);
  assert.equal(r.location, `https://127.0.0.1:${srv.port}/`);
});

// One request to the plain-http helper, as a browser sends it (it asks for a page) unless `headers` says otherwise.
const askHelper = (headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: srv.httpPort, path: '/', method, headers: { Accept: 'text/html,application/xhtml+xml', ...headers } }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, cookie: (res.headers['set-cookie'] || [])[0] || '', type: res.headers['content-type'], body }));
  });
  req.on('error', reject);
  req.end();
});

test('a browser\'s first visit to the helper port gets a short page about the certificate warning, then goes straight on', async () => {
  const first = await askHelper({ Host: 'evil.example' });
  assert.equal(first.status, 200);
  assert.match(first.type, /^text\/html/);
  assert.ok(first.body.includes(`<a href="https://127.0.0.1:${srv.port}/">Continue</a>`), 'the button goes to the https app');
  assert.match(first.body, /Tap <b>Advanced<\/b>/);
  assert.match(first.body, /Tap <b>Proceed to 127\.0\.0\.1<\/b>/, 'it names the address the warning will show');
  assert.ok(!first.body.includes('evil.example'), 'never the Host the browser claims');
  assert.match(first.cookie, /^wandless_intro=1; Max-Age=31536000; Path=\/; HttpOnly; SameSite=Lax$/);
  // The browser sends the cookie back: no page again.
  const next = await askHelper({ Cookie: 'other=2; wandless_intro=1' });
  assert.equal(next.status, 302);
  assert.equal(next.location, `https://127.0.0.1:${srv.port}/`);
  assert.equal(next.cookie, '');
  // Only a GET for a page gets the page.
  assert.equal((await askHelper({}, 'POST')).status, 302);
  assert.equal((await askHelper({ Accept: 'application/json' })).status, 302);
  assert.equal((await askHelper({ Cookie: 'wandless_intro=0' })).status, 200, 'another value is not a visit');
});

test('a busy helper port is only logged: the https app still starts', async () => {
  const lines = [];
  const other = await startServer({ port: 0, host: '127.0.0.1', httpPort: srv.httpPort, stateDir: path.join(base, 'state'),
    appFile: path.join(base, 'app.html'), mediaRoot: A, log: (l) => lines.push(l) });
  assert.equal(other.httpPort, null);
  assert.ok(other.port > 0);
  assert.match(lines.join('\n'), /busy/);
  await other.close();
});

test('the gesture log: login needed, plain short values only, a server time on each line', async () => {
  const events = [
    { type: 'menu-open', how: 'pinch', at: 123 },
    { type: 'swipe', hand: 'right', cm: 18, speed: 1.2, extra: { nested: true }, 'Bad Key': 1, long: 'x'.repeat(500) },
  ];
  const body = JSON.stringify(events);
  const anon = await request('POST', '/api/log', { headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(anon.status, 401);
  assert.ok(!fs.existsSync(logFile), 'nothing written for a stranger');
  const h = { 'Content-Type': 'application/json', Cookie: await cookie() };
  assert.equal((await request('POST', '/api/log', { headers: h, body })).status, 204);
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'how', 'logged', 'type']);
  assert.equal(lines[1].long.length, 120);
  assert.equal(lines[1].extra, undefined);
  assert.equal(lines[1]['Bad Key'], undefined);
  assert.match(lines[1].logged, /^\d{4}-\d\d-\d\dT/);
  assert.equal((await request('POST', '/api/log', { headers: h, body: '{"not":"a list"}' })).status, 400);
  assert.equal((await request('POST', '/api/log', { headers: h, body: JSON.stringify(Array(301).fill({ type: 'x' })) })).status, 400);
  assert.equal((await request('POST', '/api/log', { headers: h, body: 'x'.repeat(70_000) })).status, 413);
  assert.equal(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, 2, 'refused bodies wrote nothing');
});
