import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { saveAuth } from '../lib/auth.js';
import { folderId } from '../lib/folders.js';
import { startServer } from '../server.js';

// The /api/layout route, with a stand-in prober (the real one is tested in layout.test.js with ffmpeg).
let base;
let withProbe;
let without;
let asked;
let F;

function request(srv, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: srv.port, path: urlPath, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

function login(srv) {
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
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-layoutsrv-'));
  const media = path.join(base, 'media');
  fs.mkdirSync(media);
  fs.writeFileSync(path.join(media, 'pass.mp4'), 'video');
  fs.writeFileSync(path.join(media, 'broken.mp4'), 'video');
  fs.writeFileSync(path.join(base, 'outside.mp4'), 'video');
  fs.writeFileSync(path.join(base, 'app.html'), 'app');
  saveAuth(path.join(base, 'state'), 'hunter22');
  F = folderId(media);
  asked = [];
  const layoutProbe = {
    async get(info) {
      asked.push(info);
      if (info.file.endsWith('broken.mp4')) throw new Error('ffmpeg failed');
      return { fisheye: true, alpha: true };
    },
  };
  const common = { port: 0, host: '127.0.0.1', mediaRoot: media, stateDir: path.join(base, 'state'), appFile: path.join(base, 'app.html') };
  withProbe = await startServer({ ...common, layoutProbe });
  without = await startServer(common);
});

after(async () => {
  await withProbe.close();
  await without.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('/api/layout needs the login and keeps the path rules of /media/', async () => {
  assert.equal((await request(withProbe, `/api/layout/${F}/pass.mp4`)).status, 401);
  const h = { Cookie: await login(withProbe) };
  for (const t of [`/api/layout/${F}/..%2Foutside.mp4`, `/api/layout/${F}/nothing.mp4`, '/api/layout/pass.mp4', '/api/layout/0123456789/pass.mp4']) {
    assert.equal((await request(withProbe, t, h)).status, 404, t);
  }
  assert.equal(asked.length, 0, 'the prober was never asked about those');
});

test('/api/layout answers what the prober saw, and "not known" when it fails or there is none', async () => {
  const h = { Cookie: await login(withProbe) };
  const r = await request(withProbe, `/api/layout/${F}/pass.mp4`, h);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { known: true, fisheye: true, alpha: true });
  assert.ok(asked.at(-1).file.endsWith('pass.mp4') && asked.at(-1).size === 5 && asked.at(-1).mtimeMs > 0);
  assert.deepEqual(JSON.parse((await request(withProbe, `/api/layout/${F}/broken.mp4`, h)).body), { known: false });
  const h2 = { Cookie: await login(without) };
  assert.deepEqual(JSON.parse((await request(without, `/api/layout/${F}/pass.mp4`, h2)).body), { known: false });
});
