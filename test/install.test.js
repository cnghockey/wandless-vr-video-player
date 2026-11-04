import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  NAME, installDir, installedExe, makeShortcuts, removeShortcuts, register, unregister, controlAnswers, stopRunning, install, uninstall, launch,
} from '../lib/install.js';

// Windows only. Shortcuts go into temporary folders (never the real Desktop) and the Settings > Apps entry has a test
// name, removed at the end.
const windows = process.platform === 'win32' ? false : 'Windows only';
let base;
const KEY = `Wandless test ${process.pid}`;
// Reads back what Windows stored. UTF-8 out, so an accented letter in a path comes back whole.
const ps = (script, values = {}) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`], { env: { ...process.env, ...values }, encoding: 'utf8', windowsHide: true }).trim();
const linkTarget = (file) => ps('(New-Object -ComObject WScript.Shell).CreateShortcut($env:F).TargetPath', { F: file });
const entry = (key) => {
  const json = ps(`$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + $env:K
    if (Test-Path -LiteralPath $k) { Get-ItemProperty -LiteralPath $k | Select-Object DisplayName, DisplayVersion, Publisher, DisplayIcon, InstallLocation, UninstallString, NoModify, NoRepair | ConvertTo-Json }`, { K: key });
  return json ? JSON.parse(json) : null;
};

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-install-'));
});

after(async () => {
  if (!windows) await unregister(KEY);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the install folder is "Wandless" in the user\'s local app data', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' };
  assert.equal(installDir(env), path.join('C:\\Users\\someone\\AppData\\Local', NAME));
  assert.equal(installedExe(env), path.join('C:\\Users\\someone\\AppData\\Local', NAME, 'Wandless.exe'));
});

test('shortcuts: made in each folder, pointing at the program; then removed, but never one for something else', { skip: windows }, async () => {
  const dirs = [path.join(base, 'Desktop'), path.join(base, 'Start Menu')];
  for (const d of dirs) fs.mkdirSync(d);
  const exe = path.join(base, 'Program Files é', 'Wandless.exe');
  await makeShortcuts(exe, dirs);
  for (const d of dirs) assert.equal(linkTarget(path.join(d, 'Wandless.lnk')), exe, d);
  const mine = path.join(base, 'My Desktop'); // a "Wandless" shortcut of your own, to the source folder's launcher
  fs.mkdirSync(mine);
  await makeShortcuts(path.join(base, 'start-vr-player.cmd'), [mine]);
  await removeShortcuts(exe, [...dirs, mine]);
  for (const d of dirs) assert.equal(fs.existsSync(path.join(d, 'Wandless.lnk')), false, d);
  assert.equal(linkTarget(path.join(mine, 'Wandless.lnk')), path.join(base, 'start-vr-player.cmd'), 'yours stays');
});

test('the Settings > Apps entry: name, version, icon, and the uninstall command; then removed', { skip: windows }, async () => {
  const exe = path.join(base, 'Clément', 'Wandless.exe');
  await register(exe, '1.2.3', KEY);
  assert.deepEqual(entry(KEY), {
    DisplayName: 'Wandless VR Video Player', DisplayVersion: '1.2.3', Publisher: 'Wandless', DisplayIcon: exe, InstallLocation: path.dirname(exe),
    UninstallString: `"${exe}" --uninstall`, NoModify: 1, NoRepair: 1,
  });
  await register(exe, '1.2.4', KEY);
  assert.equal(entry(KEY).DisplayVersion, '1.2.4', 'an update changes the version shown');
  await unregister(KEY);
  assert.equal(entry(KEY), null);
});

test('install copies the program into the folder, with shortcuts and the entry; uninstall removes all of it', { skip: windows }, async () => {
  const env = { LOCALAPPDATA: path.join(base, 'Local') };
  const links = [path.join(base, 'links')];
  fs.mkdirSync(links[0]);
  const download = path.join(base, 'Downloads', 'Wandless.exe');
  fs.mkdirSync(path.dirname(download));
  fs.writeFileSync(download, 'the program');
  fs.writeFileSync(`${download}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n'); // what a browser adds to a download
  const exe = await install({ from: download, version: '0.3.0', env, linkDirs: links, key: KEY });
  assert.equal(exe, installedExe(env));
  assert.equal(fs.readFileSync(exe, 'utf8'), 'the program');
  assert.equal(fs.existsSync(`${exe}:Zone.Identifier`), false, 'the installed copy has no download mark');
  assert.equal(fs.existsSync(`${download}:Zone.Identifier`), true, 'the control: such a mark is visible this way');
  assert.equal(linkTarget(path.join(links[0], 'Wandless.lnk')), exe);
  assert.equal(entry(KEY).UninstallString, `"${exe}" --uninstall`);
  fs.writeFileSync(path.join(installDir(env), 'folders.txt'), 'D:\\Videos\r\n');
  fs.mkdirSync(path.join(installDir(env), '.state'));

  // The uninstaller is the running program (here: one that runs until its input closes): the folder goes only once
  // it has ended.
  const running = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const ended = new Promise((r) => running.on('exit', r));
  try {
    assert.equal(await uninstall({ env, linkDirs: links, key: KEY, waitFor: running.pid }), true);
    assert.equal(fs.existsSync(path.join(links[0], 'Wandless.lnk')), false);
    assert.equal(entry(KEY), null);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(fs.existsSync(installDir(env)), true, 'still there while the program runs');
  } finally {
    running.stdin.end();
    await ended;
  }
  for (let i = 0; i < 40 && fs.existsSync(installDir(env)); i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(fs.existsSync(installDir(env)), false, 'gone after it ended');
  assert.equal(fs.readFileSync(download, 'utf8'), 'the program', 'the downloaded file is not touched');
});

test('uninstall deletes no folder that does not hold Wandless.exe', { skip: windows }, async () => {
  const env = { LOCALAPPDATA: path.join(base, 'Other') };
  fs.mkdirSync(installDir(env), { recursive: true });
  fs.writeFileSync(path.join(installDir(env), 'my file.txt'), 'keep me');
  assert.equal(await uninstall({ env, linkDirs: [base], key: KEY, waitFor: process.pid }), false);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.readFileSync(path.join(installDir(env), 'my file.txt'), 'utf8'), 'keep me');
});

test('launch: the program it starts gets the arguments, and keeps running after the one that started it ends', { skip: windows }, async () => {
  const note = path.join(base, 'launched.json');
  const program = path.join(base, 'program.js');
  // Waits until its starter has ended, then writes down its arguments.
  fs.writeFileSync(program, `const fs = require('fs');
    const wait = () => { try { process.kill(Number(process.env.STARTER), 0); setTimeout(wait, 100); } catch { fs.writeFileSync(${JSON.stringify(note)}, JSON.stringify(process.argv.slice(2))); } };
    setTimeout(wait, 100);`);
  const starter = path.join(base, 'starter.mjs');
  fs.writeFileSync(starter, `import { launch } from ${JSON.stringify(new URL('../lib/install.js', import.meta.url).href)};
    process.env.STARTER = String(process.pid);
    await launch(process.execPath, [${JSON.stringify(program)}, '--after-update', '--no-open', '--root', 'C:\\\\My Videos\\\\', 'say "hi"']);`);
  const run = spawn(process.execPath, [starter], { env: { ...process.env, VR_WINDOW: 'hidden' }, stdio: 'ignore' });
  const code = await new Promise((r) => run.on('exit', r));
  assert.equal(code, 0);
  for (let i = 0; i < 40 && !fs.existsSync(note); i++) await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(JSON.parse(fs.readFileSync(note, 'utf8')), ['--after-update', '--no-open', '--root', 'C:\\My Videos\\', 'say "hi"'],
    'it ran on after its starter ended, with each argument whole');
});

test('a running Wandless is found by its control page, and stopped through it', async () => {
  let stops = 0;
  const page = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/status') return res.writeHead(200).end('{}');
    if (req.method === 'POST' && req.url === '/api/stop' && req.headers['x-vr-player'] === '1') {
      stops++;
      res.writeHead(200).end('{"stopping":true}');
      return setTimeout(() => { page.close(); page.closeAllConnections(); }, 300);
    }
    return res.writeHead(404).end();
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  const { port } = page.address();
  try {
    assert.equal(await controlAnswers(port), true);
    await stopRunning(port);
    assert.equal(stops, 1);
    assert.equal(await controlAnswers(port), false, 'it waited until the page was gone');
  } finally {
    page.close();
    page.closeAllConnections();
  }
});
