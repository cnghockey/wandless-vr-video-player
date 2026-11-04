// Wandless.exe starts here. scripts/package.mjs bundles this file, the server and its pages into one Windows program
// (Node's single-executable feature). The first run installs it for this Windows user; after that it starts Wandless.
//   --self-test   start the server on a free port, ask it for the login page, print the version (the updater runs this
//                 on a new download before it puts the file in place)
//   --version     print the version
//   --uninstall   remove Wandless (Settings > Apps runs this)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import sea from 'node:sea';
import { main, startServer } from '../server.js';
import { APP, isNewer, newFile, oldFile } from '../lib/update.js';
import { selfTestServer } from '../lib/self-test.js';
import {
  NAME, ASSETS, installDir, installedExe, sameFile, install, uninstall, register, launch, controlAnswers, openControlPage, stopRunning,
} from '../lib/install.js';

// Tests only: other folders for the shortcuts (never the real Desktop), another name for the Settings > Apps entry.
const testing = {
  linkDirs: process.env.VR_LINK_DIRS ? process.env.VR_LINK_DIRS.split('|') : undefined,
  key: process.env.VR_UNINSTALL_KEY || undefined,
};
const openPage = () => process.env.VR_OPEN !== '0' && openControlPage();

// Writes the pages into the folder, when they differ from the ones there (a new version brings new pages).
function writeAssets(dir) {
  for (const [key, rel] of Object.entries(ASSETS)) {
    const file = path.join(dir, rel);
    const bytes = Buffer.from(sea.getAsset(key));
    let same = false;
    try {
      same = fs.readFileSync(file).equals(bytes);
    } catch {
      // not there yet
    }
    if (!same) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
  }
}

async function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-player-test-'));
  try {
    writeAssets(dir);
    await selfTestServer(startServer, { stateDir: path.join(dir, '.state'), appFile: path.join(dir, ASSETS['wandless.html']) });
    console.log(JSON.stringify({ selfTest: 'ok', version: APP.version }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The installed copy's version, or null when none is installed or it gives no x.y.z answer (then this copy replaces it).
function installedVersion() {
  try {
    const v = execFileSync(installedExe(), ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true }).trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

// After an update, the new version could not start on this PC: put the version before back in place, and start it.
// This file runs, so it can only be renamed: it becomes the ".new" file, which the next update overwrites.
async function rollBack(err) {
  const exe = process.execPath;
  if (!process.argv.includes('--after-update') || !sameFile(exe, installedExe()) || !fs.existsSync(oldFile(exe))) return false;
  try {
    fs.rmSync(newFile(exe), { force: true });
    fs.renameSync(exe, newFile(exe));
  } catch {
    return false;
  }
  try {
    fs.renameSync(oldFile(exe), exe);
  } catch {
    fs.renameSync(newFile(exe), exe); // a program that fails is better than none
    return false;
  }
  console.error(`Version ${APP.version} did not start on this PC (${err.message}). ${NAME} goes back to the version before, in a new window.`);
  await launch(exe, ['--rolled-back', '--no-open']).catch(() => {});
  return true;
}

const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function removeAll() {
  console.log(`This removes ${NAME} from this PC: the program, its shortcuts, your passcode, your folder list and the previews.`);
  console.log('Your videos stay where they are.\n');
  if ((await ask('Type Y and press Enter to remove it: ')).trim().toLowerCase() !== 'y') {
    console.log('Nothing was removed.');
    return wait(3000);
  }
  if (await controlAnswers()) await stopRunning();
  await uninstall(testing);
  console.log(`\n${NAME} is removed.`);
  return wait(3000);
}

async function run() {
  const args = process.argv.slice(2);
  if (args.includes('--version')) return console.log(APP.version);
  if (!sea.isSea()) throw new Error('This file is the start of Wandless.exe. From the source folder, use npm start.');
  if (args.includes('--self-test')) return selfTest();
  if (args.includes('--uninstall')) return removeAll();
  const afterUpdate = args.includes('--after-update') || args.includes('--rolled-back');
  if (!afterUpdate && (await controlAnswers())) {
    console.log(`${NAME} is already running. Its control page opens in your browser.`);
    openPage();
    return wait(3000);
  }
  if (!sameFile(process.execPath, installedExe())) {
    // A copy outside the install folder: a new download, or an old one opened again. It installs itself only when no
    // copy is installed, or when it is newer than that copy: an old file never replaces a newer version.
    const installed = installedVersion();
    if (installed && !isNewer(APP.version, installed)) {
      console.log(`${NAME} ${installed} is installed. It starts now, in a new window.`);
      await launch(installedExe());
      return wait(3000);
    }
    const exe = await install({ version: APP.version, ...testing });
    console.log(`${NAME} ${APP.version} is installed in ${path.dirname(exe)}${installed ? ` (it replaces ${installed})` : ''}.`);
    console.log(`A ${NAME} shortcut is on your Desktop and in the Start menu.`);
    console.log('It starts now, in a new window. You can delete the file you downloaded.');
    await launch(exe);
    return wait(6000);
  }
  if (afterUpdate) await register(process.execPath, APP.version, testing.key).catch(() => {}); // Settings > Apps shows the new version
  writeAssets(installDir());
  return main({ exe: process.execPath, here: installDir() });
}

run().catch(async (err) => {
  console.error(`\n${NAME} stopped: ${err.code === 'EADDRINUSE' ? 'a port it needs is in use by another program' : err.message}`);
  if (await rollBack(err)) await wait(6000);
  else if (process.stdin.isTTY) await ask('Press Enter to close this window.');
  process.exit(1);
});
