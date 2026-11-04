import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { saveAuth } from '../lib/auth.js';
import { folderId } from '../lib/folders.js';
import { startServer } from '../server.js';

// The routes are tested with a fake preview maker, so these tests do not need ffmpeg.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
let base;
let withPreviews;
let withoutPreviews;
let calls;
let F; // the media folder's id

function request(srv, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: srv.port, path: urlPath, method, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function login(srv) {
  const body = new URLSearchParams({ password: 'hunter22' }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: srv.port, path: '/login', method: 'POST', rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
    });
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-thumbsrv-'));
  const media = path.join(base, 'media');
  fs.mkdirSync(path.join(media, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(media, 'a.mp4'), 'video');
  fs.writeFileSync(path.join(media, 'sub', 'b.mp4'), 'video');
  fs.writeFileSync(path.join(media, 'broken.mp4'), 'video');
  fs.writeFileSync(path.join(media, 'notes.txt'), 'text');
  fs.writeFileSync(path.join(base, 'outside.mp4'), 'video');
  fs.writeFileSync(path.join(base, 'app.html'), 'app');
  const jpg = path.join(base, 'fake.jpg');
  fs.writeFileSync(jpg, JPEG);
  calls = [];
  const thumbnailer = { async get(info) { calls.push(info); return info.name === 'broken.mp4' ? null : jpg; } };
  saveAuth(path.join(base, 'state'), 'hunter22');
  F = folderId(media);
  const common = { port: 0, host: '127.0.0.1', mediaRoot: media, stateDir: path.join(base, 'state'), appFile: path.join(base, 'app.html') };
  withPreviews = await startServer({ ...common, thumbnailer });
  withoutPreviews = await startServer({ ...common });
});

after(async () => {
  await withPreviews.close();
  await withoutPreviews.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('/thumb needs the login like everything else', async () => {
  assert.equal((await request(withPreviews, 'GET', `/thumb/${F}/a.mp4`)).status, 401);
  assert.equal(calls.length, 0, 'no preview was made for a stranger');
});

test('/thumb returns the image, passes the relative path as the name, and sends the file facts', async () => {
  const cookie = await login(withPreviews);
  const r = await request(withPreviews, 'GET', `/thumb/${F}/sub/b.mp4`, { Cookie: cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.match(r.headers['cache-control'], /private/);
  assert.ok(r.body.equals(JPEG));
  const call = calls.at(-1);
  assert.equal(call.name, 'sub/b.mp4');
  assert.equal(call.size, 5);
  assert.ok(call.file.endsWith(path.join('sub', 'b.mp4')) && call.mtimeMs > 0);
});

test('/thumb refuses paths outside the library, non-video files and missing files', async () => {
  const cookie = await login(withPreviews);
  const before = calls.length;
  for (const t of [`/thumb/${F}/..%2Foutside.mp4`, `/thumb/${F}/%2e%2e/outside.mp4`, `/thumb/${F}/notes.txt`, `/thumb/${F}/nothing.mp4`,
    `/thumb/${F}/`, `/thumb/${F}/a.mp4%00.txt`, '/thumb/a.mp4', '/thumb/0123456789/a.mp4', '/thumb/']) {
    assert.equal((await request(withPreviews, 'GET', t, { Cookie: cookie })).status, 404, t);
  }
  assert.equal(calls.length, before, 'ffmpeg was never asked about those paths');
});

test('/thumb answers 404 when the preview maker cannot make one', async () => {
  const cookie = await login(withPreviews);
  assert.equal((await request(withPreviews, 'GET', `/thumb/${F}/broken.mp4`, { Cookie: cookie })).status, 404);
});

test('without a preview maker, /thumb is 404 and /api/info says previews are off', async () => {
  const cookie = await login(withoutPreviews);
  assert.equal((await request(withoutPreviews, 'GET', `/thumb/${F}/a.mp4`, { Cookie: cookie })).status, 404);
  assert.equal(JSON.parse((await request(withoutPreviews, 'GET', '/api/info', { Cookie: cookie })).body.toString()).previews, false);
  assert.equal(JSON.parse((await request(withPreviews, 'GET', '/api/info', { Cookie: await login(withPreviews) })).body.toString()).previews, true);
});
