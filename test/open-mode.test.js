import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { folderId } from '../lib/folders.js';
import { startServer } from '../server.js';

// Password OFF (testing mode): no login, no cookie, everything open.
let base;
let srv;
let F; // the media folder's id

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port: srv.port, path: urlPath, method, headers, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-open-'));
  const media = path.join(base, 'media');
  fs.mkdirSync(media);
  fs.writeFileSync(path.join(media, 'a.mp4'), Buffer.alloc(500, 7));
  fs.writeFileSync(path.join(media, 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(base, 'outside.mp4'), 'outside');
  fs.writeFileSync(path.join(base, 'app.html'), '<h1>open</h1>');
  // No auth.json exists in the state folder: open mode must not need one.
  F = folderId(media);
  srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    mediaRoot: media,
    stateDir: path.join(base, 'state'),
    appFile: path.join(base, 'app.html'),
    password: false,
  });
});

after(async () => {
  await srv.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('open mode: page, info, library and media need no login', async () => {
  const page = await request('GET', '/', { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.equal(page.body.toString(), '<h1>open</h1>');
  const info = JSON.parse((await request('GET', '/api/info')).body.toString());
  assert.equal(info.locked, false);
  const lib = JSON.parse((await request('GET', '/api/library')).body.toString());
  assert.deepEqual(lib.files.map((f) => f.path), ['a.mp4']);
  const part = await request('GET', `/media/${F}/a.mp4`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.body.length, 10);
});

test('open mode: login and logout just go back to the app', async () => {
  for (const [method, p] of [['GET', '/login'], ['POST', '/login'], ['POST', '/logout']]) {
    const r = await request(method, p);
    assert.equal(r.status, 303, `${method} ${p}`);
    assert.equal(r.headers.location, '/');
    assert.equal(r.headers['set-cookie'], undefined);
  }
});

test('open mode keeps the path rules: nothing outside the library, no other file types', async () => {
  for (const t of [`/media/${F}/..%2Foutside.mp4`, `/media/${F}/notes.txt`, `/media/${F}/nothing.mp4`, '/media/a.mp4', '/core.js', '/server.js']) {
    assert.equal((await request('GET', t)).status, 404, t);
  }
});
