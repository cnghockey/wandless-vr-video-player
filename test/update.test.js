import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ASSET, APP, parseRepo, isNewer, latestRelease, downloadChecked, swapIn, newFile, oldFile, selfTest, Updater } from '../lib/update.js';

// A stand-in for GitHub: the "latest release" answer, and the file behind a redirect, as GitHub serves it.
let base;
let gh;
let api;
let release = null; // what /latest answers (null = 404)
let latestStatus = 200;
let body = Buffer.alloc(0); // the file's bytes
let cut = 0; // send this many bytes fewer, then end the response
const NEW = Buffer.from('the new Wandless.exe');
const sha = (b) => `sha256:${crypto.createHash('sha256').update(b).digest('hex')}`;

const releaseOf = (version, file = NEW, extra = {}) => ({
  tag_name: `v${version}`,
  body: 'What changed',
  html_url: `https://github.com/someone/vr-player/releases/tag/v${version}`,
  assets: [
    { name: 'notes.txt', size: 5, browser_download_url: `${api}/nothing` },
    { name: ASSET, size: file.length, digest: sha(file), browser_download_url: `${api}/download/${ASSET}` },
  ],
  ...extra,
});

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-update-'));
  gh = http.createServer((req, res) => {
    if (req.url === '/latest') {
      if (!release) return res.writeHead(404).end('{"message":"Not Found"}');
      res.writeHead(latestStatus, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(release));
    }
    if (req.url === `/download/${ASSET}`) return res.writeHead(302, { Location: '/objects/123' }).end();
    if (req.url === '/objects/123') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(body.subarray(0, body.length - cut));
    }
    return res.writeHead(404).end();
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${gh.address().port}`;
});

after(async () => {
  await new Promise((r) => gh.close(r));
  fs.rmSync(base, { recursive: true, force: true });
});

test('the repository name comes from the usual package.json forms', () => {
  for (const url of ['https://github.com/someone/vr-player', 'https://github.com/someone/vr-player.git', 'git+https://github.com/someone/vr-player.git',
    'github:someone/vr-player', 'https://github.com/someone/vr-player/', 'someone/vr-player', ' someone/vr-player ',
    'git@github.com:someone/vr-player.git', 'git+ssh://git@github.com/someone/vr-player.git', 'ssh://git@github.com/someone/vr-player',
    'git://github.com/someone/vr-player.git']) {
    assert.equal(parseRepo(url), 'someone/vr-player', url);
  }
  assert.equal(parseRepo({ type: 'git', url: 'https://github.com/a-b/c.d' }), 'a-b/c.d');
  for (const url of ['', undefined, 'https://gitlab.com/a/b', 'https://github.com/only-owner', 'https://github.com/a/b/c', 'http://github.com/a/b',
    'gitlab:a/b', 'git@gitlab.com:a/b.git', 'github.com/a/b', 'a/b/c']) {
    assert.equal(parseRepo(url), null, String(url));
  }
  assert.match(APP.version, /^\d+\.\d+\.\d+$/, 'the source folder reads its version from package.json');
});

test('a newer version is one with a bigger number, part by part; anything else is not newer', () => {
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('v0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.10.0', '0.9.9'), true, 'numbers, not text');
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.1.1', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('0.2.0-beta.1', '0.1.0'), false);
  assert.equal(isNewer('latest', '0.1.0'), false);
  assert.equal(isNewer('0.2', '0.1.0'), false);
});

test('the latest release: version, notes, page and the .exe; no release yet is null; an error is an error', async () => {
  release = releaseOf('0.2.0');
  const r = await latestRelease({ url: `${api}/latest`, version: '0.1.0' });
  assert.deepEqual(r, {
    version: '0.2.0', notes: 'What changed', page: 'https://github.com/someone/vr-player/releases/tag/v0.2.0',
    asset: { url: `${api}/download/${ASSET}`, size: NEW.length, digest: sha(NEW) },
  });
  release = releaseOf('0.2.0', NEW, { html_url: 'https://evil.example/x' });
  assert.equal((await latestRelease({ url: `${api}/latest`, version: '0.1.0' })).page, null, 'only a github.com page is linked');
  release = releaseOf('0.2.0', NEW, { assets: [{ name: ASSET, size: 0, browser_download_url: 'x' }] });
  assert.equal((await latestRelease({ url: `${api}/latest`, version: '0.1.0' })).asset, null, 'an empty file is no file');
  release = null;
  assert.equal(await latestRelease({ url: `${api}/latest`, version: '0.1.0' }), null);
  release = releaseOf('0.2.0');
  latestStatus = 403;
  await assert.rejects(latestRelease({ url: `${api}/latest`, version: '0.1.0' }), /GitHub answered 403/);
  latestStatus = 200;
});

test('a download is kept only when its size and SHA-256 are what GitHub lists; it follows the redirect', async () => {
  const file = path.join(base, 'dl.exe');
  body = NEW;
  const seen = [];
  await downloadChecked({ url: `${api}/download/${ASSET}`, size: NEW.length, digest: sha(NEW), file, onProgress: (d, t) => seen.push([d, t]) });
  assert.deepEqual(fs.readFileSync(file), NEW);
  assert.deepEqual(seen.at(-1), [NEW.length, NEW.length]);
  fs.rmSync(file);

  await downloadChecked({ url: `${api}/download/${ASSET}`, size: NEW.length, digest: null, file });
  assert.deepEqual(fs.readFileSync(file), NEW, 'no digest listed: the size check is enough');
  fs.rmSync(file);

  body = Buffer.from('the new Wandless.exf'); // same size, one byte changed
  await assert.rejects(downloadChecked({ url: `${api}/download/${ASSET}`, size: NEW.length, digest: sha(NEW), file }), /does not match the checksum/);
  assert.equal(fs.existsSync(file), false);

  body = NEW;
  cut = 3;
  await assert.rejects(downloadChecked({ url: `${api}/download/${ASSET}`, size: NEW.length, digest: sha(NEW), file }), /stopped early/);
  assert.equal(fs.existsSync(file), false);
  cut = 0;

  body = Buffer.concat([NEW, Buffer.from('more')]);
  await assert.rejects(downloadChecked({ url: `${api}/download/${ASSET}`, size: NEW.length, digest: sha(NEW), file }), /larger than GitHub said/);
  assert.equal(fs.existsSync(file), false);

  await assert.rejects(downloadChecked({ url: `${api}/nothing`, size: 5, digest: null, file }), /failed \(404\)/);
  assert.equal(fs.existsSync(file), false);
  body = NEW;
});

test('swapIn: the new file takes the name, the old one is kept beside it; a missing new file changes nothing', () => {
  const exe = path.join(base, 'Wandless.exe');
  fs.writeFileSync(exe, 'old');
  fs.writeFileSync(newFile(exe), 'new');
  fs.writeFileSync(oldFile(exe), 'from the update before');
  swapIn(exe);
  assert.equal(fs.readFileSync(exe, 'utf8'), 'new');
  assert.equal(fs.readFileSync(oldFile(exe), 'utf8'), 'old');
  assert.equal(fs.existsSync(newFile(exe)), false);
  assert.throws(() => swapIn(exe));
  assert.equal(fs.readFileSync(exe, 'utf8'), 'new', 'put back');
  assert.equal(fs.existsSync(oldFile(exe)), false);
});

test('swapIn works while the .exe runs (Windows refuses to overwrite it, but lets it be renamed)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(base, 'running-'));
  const exe = path.join(dir, 'Wandless.exe');
  fs.copyFileSync(process.execPath, exe); // any program will do: a copy of node
  const child = spawn(exe, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  try {
    assert.throws(() => fs.writeFileSync(exe, 'x'), /EBUSY|EPERM/, 'a running .exe cannot be overwritten');
    fs.writeFileSync(newFile(exe), 'new');
    swapIn(exe);
    assert.equal(fs.readFileSync(exe, 'utf8'), 'new');
    assert.equal(fs.statSync(oldFile(exe)).size, fs.statSync(process.execPath).size);
    assert.equal(child.exitCode, null, 'still running, from the renamed file');
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
});

function updaterFor(dir, options = {}) {
  const exe = path.join(dir, 'Wandless.exe');
  fs.writeFileSync(exe, 'old');
  const restarts = [];
  const u = new Updater({ version: '0.1.0', url: `${api}/latest`, exe, restart: () => restarts.push(Date.now()), test: async () => '0.2.0', ...options });
  return { u, exe, restarts };
}

test('Updater: a newer release is offered; "Update now" downloads, tests, swaps, then restarts', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'u-'));
  const tested = [];
  const { u, exe, restarts } = updaterFor(dir, { test: async (file) => { tested.push(fs.readFileSync(file, 'utf8')); return '0.2.0'; } });
  assert.equal(u.status().state, 'waiting');
  release = releaseOf('0.2.0');
  body = NEW;
  const s = await u.check();
  assert.equal(s.state, 'available');
  assert.deepEqual(s.latest, { version: '0.2.0', notes: 'What changed', page: 'https://github.com/someone/vr-player/releases/tag/v0.2.0', size: NEW.length });
  assert.equal(s.canInstall, true);
  await u.apply();
  assert.deepEqual(tested, [NEW.toString()], 'the self-test ran on the downloaded file, before the swap');
  assert.equal(fs.readFileSync(exe, 'utf8'), NEW.toString());
  assert.equal(fs.readFileSync(oldFile(exe), 'utf8'), 'old');
  assert.equal(restarts.length, 1);
  assert.equal(u.status().state, 'restarting');
  assert.deepEqual(u.status().progress, { done: NEW.length, total: NEW.length });
  await assert.rejects(u.apply(), /no update to install/, 'a second press does nothing');
  assert.equal(restarts.length, 1);
});

test('Updater: the same or an older release is "latest"; GitHub out of reach is "unknown"; no url is "off"', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'u-'));
  const { u } = updaterFor(dir);
  for (const v of ['0.1.0', '0.0.9']) {
    release = releaseOf(v);
    assert.equal((await u.check()).state, 'latest', v);
  }
  release = null;
  assert.equal((await u.check()).state, 'latest', 'no release yet');
  const closed = http.createServer(); // a free port with nobody on it
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const away = new Updater({ version: '0.1.0', url: `http://127.0.0.1:${port}/latest` });
  const s = await away.check();
  assert.equal(s.state, 'unknown');
  assert.match(s.error, /^Could not ask GitHub for updates: ECONNREFUSED/);
  const off = new Updater({ version: '0.1.0', url: null });
  assert.equal((await off.check()).state, 'off');
});

test('Updater: a failed self-test, a wrong version or a bad download leaves the running file alone', async () => {
  release = releaseOf('0.2.0');
  body = NEW;
  for (const [why, options, prepare, want] of [
    ['the new file does not start', { test: async () => { throw new Error('the new version did not start on this PC (boom)'); } }, () => {}, /did not start on this PC \(boom\)/],
    ['it reports another version', { test: async () => '0.1.5' }, () => {}, /says it is version 0\.1\.5, not 0\.2\.0/],
    ['the checksum differs', {}, () => { body = Buffer.from('the new Wandless.exf'); }, /does not match the checksum/],
  ]) {
    const dir = fs.mkdtempSync(path.join(base, 'u-'));
    const { u, exe, restarts } = updaterFor(dir, options);
    await u.check();
    prepare();
    await assert.rejects(u.apply(), want, why);
    assert.equal(fs.readFileSync(exe, 'utf8'), 'old', why);
    assert.equal(fs.existsSync(newFile(exe)), false, why);
    assert.equal(fs.existsSync(oldFile(exe)), false, why);
    assert.equal(restarts.length, 0, why);
    const s = u.status();
    assert.equal(s.state, 'available', `${why}: it can be tried again`);
    assert.match(s.error, /^The update failed: /, why);
    body = NEW;
  }
});

test('Updater: a file that cannot be deleted after a failed try neither hides the reason nor blocks the next try', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'u-'));
  // The self-test fails, and the downloaded file is then held (here: replaced by a folder with a file in it, which
  // rmSync cannot delete, as an antivirus scan can hold a file).
  const { u, exe } = updaterFor(dir, {
    test: async (file) => {
      fs.rmSync(file);
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, 'held'), 'x');
      throw new Error('the new version did not start on this PC (boom)');
    },
  });
  release = releaseOf('0.2.0');
  body = NEW;
  await u.check();
  await assert.rejects(u.apply(), /boom/);
  assert.equal(u.status().state, 'available', 'it can be tried again');
  assert.match(u.status().error, /boom/);
  assert.equal(fs.readFileSync(exe, 'utf8'), 'old');
  fs.rmSync(newFile(exe), { recursive: true });
});

test('Updater: a check during an update changes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'u-'));
  const { u } = updaterFor(dir);
  release = releaseOf('0.2.0');
  await u.check();
  u.state = 'downloading';
  release = null;
  assert.equal((await u.check()).state, 'downloading');
  assert.equal(u.latest.version, '0.2.0');
});

test('Updater: from the source folder it can check, but never installs', async () => {
  release = releaseOf('0.2.0');
  const u = new Updater({ version: '0.1.0', url: `${api}/latest`, exe: null });
  const s = await u.check();
  assert.equal(s.state, 'available');
  assert.equal(s.canInstall, false);
  await assert.rejects(u.apply(), /Only Wandless\.exe updates itself/);
  release = releaseOf('0.2.0', NEW, { assets: [] });
  const bare = await new Updater({ version: '0.1.0', url: `${api}/latest`, exe: path.join(base, 'x.exe') }).check();
  assert.equal(bare.state, 'available');
  assert.match(bare.error, /has no Wandless\.exe to download yet/);
});

// A file that is not a program: Windows refuses to start it, and Node throws "spawn UNKNOWN" at once (Node 24 and 26 both). The control page must show the
// plain message ("did not start on this PC"), not the raw error. The stubbed self-tests above never reached this.
test('the self-test of a file that is not a program says so in plain words', { skip: process.platform !== 'win32' }, async () => {
  const file = path.join(base, 'not a program.exe');
  fs.writeFileSync(file, 'not a program at all');
  await assert.rejects(selfTest(file, 20_000), /^Error: the new version did not start on this PC \(/);
});
