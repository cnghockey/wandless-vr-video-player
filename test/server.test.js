import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { saveAuth, loadAuth, signSession } from '../lib/auth.js';
import { Throttle } from '../lib/auth.js';
import { folderId } from '../lib/folders.js';
import { startServer, attachmentHeader } from '../server.js';

const PASSWORD = 'hunter22';
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

let base;
let srv;
let outsideFile;
let stateDir;
let F; // the media folder's id: every media URL is /media/<folder id>/<path in the folder>

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

const form = (fields) => ({
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

async function loginCookie() {
  const r = await request('POST', '/login', form({ password: PASSWORD }));
  assert.equal(r.status, 303);
  return r.headers['set-cookie'][0].split(';')[0];
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-srv-'));
  const media = path.join(base, 'media');
  const pub = path.join(base, 'public');
  stateDir = path.join(base, 'state');
  fs.mkdirSync(path.join(media, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(media, '.hidden'));
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(media, 'a.mp4'), bytes);
  fs.writeFileSync(path.join(media, 'sub', 'b.webm'), 'webm');
  fs.writeFileSync(path.join(media, 'notes.txt'), 'secret notes');
  fs.writeFileSync(path.join(media, '.hidden', 'c.mp4'), 'hidden');
  outsideFile = path.join(base, 'outside.mp4');
  fs.writeFileSync(outsideFile, 'outside the library');
  fs.writeFileSync(path.join(pub, 'index.html'), '<h1>hello</h1>');
  fs.writeFileSync(path.join(pub, 'core.js'), 'export {};');
  saveAuth(stateDir, PASSWORD);
  F = folderId(media);
  srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    mediaRoot: media,
    stateDir,
    appFile: path.join(pub, 'index.html'),
    throttle: new Throttle({ free: 3, baseMs: 60_000 }),
  });
});

after(async () => {
  await srv.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('everything is closed until login', async () => {
  const lib = await request('GET', '/api/library');
  assert.equal(lib.status, 401);
  const media = await request('GET', `/media/${F}/a.mp4`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(media.status, 401);
  assert.equal((await request('GET', '/api/folders')).status, 401);
  const page = await request('GET', '/', { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, '/login');
  const js = await request('GET', '/core.js');
  assert.equal(js.status, 401);
  const login = await request('GET', '/login');
  assert.equal(login.status, 200);
  assert.ok(login.body.toString().includes('type="password"'));
  assert.ok(!login.body.toString().includes('data-key='), 'a password (letters) gets no number keypad');
});

test('a wrong password gets no cookie; the right one gets a locked-down cookie', async () => {
  const bad = await request('POST', '/login', form({ password: 'nope-nope' }));
  assert.equal(bad.status, 401);
  assert.equal(bad.headers['set-cookie'], undefined);
  const ok = await request('POST', '/login', form({ password: PASSWORD }));
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/');
  const cookie = ok.headers['set-cookie'][0];
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=']) assert.ok(cookie.includes(flag), flag);
});

test('after login: page, script and library work, and hide non-video and hidden files', async () => {
  const cookie = await loginCookie();
  const h = { headers: { Cookie: cookie } };
  const page = await request('GET', '/', h);
  assert.equal(page.status, 200);
  assert.equal(page.body.toString(), '<h1>hello</h1>');
  const info = JSON.parse((await request('GET', '/api/info', h)).body.toString());
  assert.equal(info.locked, true);
  const dl = await request('GET', '/download/wandless.html', h);
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-disposition'], /attachment/);
  assert.equal(dl.body.toString(), '<h1>hello</h1>');
  const lib = JSON.parse((await request('GET', '/api/library', h)).body.toString());
  assert.deepEqual(lib.files.map((f) => f.path), ['a.mp4', 'sub/b.webm']);
  assert.equal(lib.files[0].size, 1000);
  assert.equal(lib.folder, F);
  const folders = JSON.parse((await request('GET', '/api/folders', h)).body.toString());
  assert.deepEqual(folders, { folders: [{ id: F, label: 'media' }] }, 'ids and names only: no folder paths');
  assert.equal((await request('GET', '/login', h)).status, 303); // already in: back to the app
});

test('media: ranges return exactly the bytes asked for', async () => {
  const h = (range) => ({ headers: { Cookie: cookieJar, ...(range ? { Range: range } : {}) } });
  const cookieJar = await loginCookie();
  const full = await request('GET', `/media/${F}/a.mp4`, h());
  assert.equal(full.status, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.ok(full.body.equals(bytes));

  const mid = await request('GET', `/media/${F}/a.mp4`, h('bytes=10-19'));
  assert.equal(mid.status, 206);
  assert.equal(mid.headers['content-range'], 'bytes 10-19/1000');
  assert.ok(mid.body.equals(bytes.subarray(10, 20)));

  const tail = await request('GET', `/media/${F}/a.mp4`, h('bytes=990-'));
  assert.ok(tail.body.equals(bytes.subarray(990)));
  const last = await request('GET', `/media/${F}/a.mp4`, h('bytes=-5'));
  assert.ok(last.body.equals(bytes.subarray(995)));

  const bad = await request('GET', `/media/${F}/a.mp4`, h('bytes=2000-'));
  assert.equal(bad.status, 416);
  assert.equal(bad.headers['content-range'], 'bytes */1000');

  const head = await request('HEAD', `/media/${F}/a.mp4`, h());
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '1000');
  assert.equal(head.body.length, 0);

  const sub = await request('GET', `/media/${F}/sub/b.webm`, h());
  assert.equal(sub.headers['content-type'], 'video/webm');
});

test('media with ?download: the same file, saved under its own name instead of played', async () => {
  const h = { headers: { Cookie: await loginCookie() } };
  const dl = await request('GET', `/media/${F}/a.mp4?download=1`, h);
  assert.equal(dl.status, 200);
  assert.ok(dl.body.equals(bytes));
  assert.equal(dl.headers['content-disposition'], `attachment; filename="a.mp4"; filename*=UTF-8''a.mp4`);
  assert.equal((await request('GET', `/media/${F}/a.mp4`, h)).headers['content-disposition'], undefined, 'plain playback: no download');
  assert.equal((await request('GET', `/media/${F}/a.mp4?download=1`)).status, 401, 'a download needs the login too');
  assert.equal((await request('GET', `/media/${F}/..%2Foutside.mp4?download=1`, h)).status, 404, 'and keeps the path rules');
});

test('attachmentHeader: a plain fallback name, and the exact name in UTF-8', () => {
  assert.equal(attachmentHeader('Été "x".mp4'), `attachment; filename="_t_ _x_.mp4"; filename*=UTF-8''%C3%89t%C3%A9%20%22x%22.mp4`);
});

test('media: nothing outside the library, no non-video files, no unknown folder', async () => {
  const h = { headers: { Cookie: await loginCookie() } };
  const tries = [
    `/media/${F}/..%2Foutside.mp4`,
    `/media/${F}/%2e%2e/outside.mp4`,
    `/media/${F}/sub%2F..%2F..%2Foutside.mp4`,
    `/media/${F}/${encodeURIComponent(outsideFile)}`,
    `/media/${F}/notes.txt`,
    `/media/${F}/a.mp4%00.txt`,
    `/media/${F}/`,
    `/media/${F}/nothing.mp4`,
    '/media/a.mp4', // no folder id
    '/media/0123456789/a.mp4', // a folder id that is not in the list
    `/media/${encodeURIComponent(path.dirname(outsideFile))}/outside.mp4`, // a folder path instead of an id
    '/media/',
  ];
  for (const t of tries) assert.equal((await request('GET', t, h)).status, 404, t);
  assert.equal((await request('GET', '/api/library?folder=0123456789', h)).status, 404, 'unknown folder id');
});

test('media: a symbolic link that points outside the library is refused', async (t) => {
  const link = path.join(base, 'media', 'link.mp4');
  try {
    fs.symlinkSync(outsideFile, link);
  } catch {
    return t.skip('this account cannot create symbolic links');
  }
  const h = { headers: { Cookie: await loginCookie() } };
  assert.equal((await request('GET', `/media/${F}/link.mp4`, h)).status, 404);
  const lib = JSON.parse((await request('GET', '/api/library', h)).body.toString());
  assert.ok(!lib.files.some((f) => f.name === 'link.mp4'));
  fs.rmSync(link);
});

test('the app is one file: no script, module or source routes exist', async () => {
  const h = { headers: { Cookie: await loginCookie() } };
  for (const t of [
    '/core.js',
    '/player.js',
    '/server.js',
    '/package.json',
    '/vendor/three/build/three.module.js',
    '/vendor/three/build/..%2F..%2F..%2Fserver.js',
    '/download/../server.js',
    '/download/other.html',
  ]) assert.equal((await request('GET', t, h)).status, 404, t);
});

test('a forged, expired or foreign cookie is refused', async () => {
  const good = (await loginCookie()).split('=')[1];
  const [exp, mac] = good.split('.');
  const secret = loadAuth(stateDir).secret;
  const cases = {
    'tampered mac': `${exp}.${mac.slice(0, -2)}AA`,
    'longer expiry': `${Number(exp) + 99999999}.${mac}`,
    expired: signSession(secret, -1000),
    'foreign secret': signSession('ff'.repeat(32), 60_000),
    empty: '',
  };
  for (const [name, value] of Object.entries(cases)) {
    const r = await request('GET', '/api/library', { headers: { Cookie: `vrp=${value}` } });
    assert.equal(r.status, 401, name);
  }
});

test('logout clears the cookie', async () => {
  const r = await request('POST', '/logout', { headers: { Cookie: await loginCookie() } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/login');
  assert.match(r.headers['set-cookie'][0], /vrp=;.*Max-Age=0/);
});

test('POST to a closed route and an oversize login body are refused', async () => {
  const cookie = await loginCookie();
  assert.equal((await request('POST', '/api/library', { headers: { Cookie: cookie } })).status, 405);
  const huge = await request('POST', '/login', form({ password: 'x'.repeat(10_000) }));
  assert.equal(huge.status, 413);
});

// Keep last: it locks the local address out.
test('three wrong passwords lock the address, even for the right password', async () => {
  for (let i = 0; i < 3; i++) await request('POST', '/login', form({ password: `wrong-${i}` }));
  const locked = await request('POST', '/login', form({ password: PASSWORD }));
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers['retry-after']) > 0);
  assert.equal(locked.headers['set-cookie'], undefined);
});
