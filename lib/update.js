// Updates for Wandless.exe. At each start it asks GitHub for the latest release. When that release is newer, the
// control page offers it. "Update now" downloads the new Wandless.exe, checks its size and SHA-256 against what
// GitHub lists, runs it once to see that it starts on this PC, puts it in place of the running file, and restarts.
// GitHub is trusted as it is: there is no signature of our own (the founder's choice, 2026-10-27).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const ASSET = 'Wandless.exe'; // the file in each GitHub release (GitHub turns a space in a name into a dot)

// This copy's version and repository. Wandless.exe has them built in (scripts/package.mjs); the source folder reads
// package.json.
export const APP = typeof __VR_APP__ === 'object' ? __VR_APP__ : JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// A GitHub repository as package.json may name it -> "owner/repo", else null: "owner/repo", "github:owner/repo",
// https, ssh or git URLs (with or without "git+" and ".git"), and "git@github.com:owner/repo.git".
export function parseRepo(repository) {
  const url = (typeof repository === 'string' ? repository : repository?.url || '').trim();
  const m = /^(?:github:|(?:git\+)?(?:https|ssh|git):\/\/(?:git@)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

const numbers = (v) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim()) || []).slice(1).map(Number);

// Is version a newer than version b? A tag that is not x.y.z is never newer.
export function isNewer(a, b) {
  const [x, y] = [numbers(a), numbers(b)];
  if (x.length !== 3 || y.length !== 3) return false;
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i] > y[i];
}

// The latest release: { version, notes, page, asset: { url, size, digest } or null }. null when there is none yet.
export async function latestRelease({ url, version, fetchFn = fetch, timeoutMs = 15_000 }) {
  const res = await fetchFn(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Wandless/${version}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const r = await res.json();
  const asset = (r.assets || []).find((a) => a.name === ASSET && Number.isSafeInteger(a.size) && a.size > 0);
  return {
    version: String(r.tag_name || '').replace(/^v/, ''),
    notes: String(r.body || '').slice(0, 4000),
    page: /^https:\/\/github\.com\//.test(r.html_url || '') ? r.html_url : null,
    asset: asset ? { url: asset.browser_download_url, size: asset.size, digest: asset.digest || null } : null,
  };
}

// Saves the download and checks it as it comes: never more than `size` bytes, exactly `size` at the end, and the
// SHA-256 that GitHub lists (when it lists one). A file that fails a check is deleted.
export async function downloadChecked({ url, size, digest, file, fetchFn = fetch, onProgress = () => {}, timeoutMs = 30 * 60_000 }) {
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': 'Wandless' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) throw new Error(`the download failed (${res.status})`);
    const hash = crypto.createHash('sha256');
    let done = 0;
    const check = new Transform({
      transform(chunk, _encoding, next) {
        done += chunk.length;
        if (done > size) return next(new Error('the download is larger than GitHub said'));
        hash.update(chunk);
        onProgress(done, size);
        return next(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), check, fs.createWriteStream(file));
    if (done !== size) throw new Error(`the download stopped early (${done} of ${size} bytes)`);
    if (digest && `sha256:${hash.digest('hex')}` !== digest) throw new Error('the download does not match the checksum GitHub lists');
  } catch (err) {
    removeQuietly(file);
    throw err;
  }
}

// A file that could not be deleted (an antivirus may still hold it) is overwritten by the next try. Its error must
// never hide the real one.
function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // the next try overwrites it
  }
}

// Runs the new file once with --self-test: it starts its server on a free port, asks itself for the login page, and
// prints its version as the last line, in JSON. Resolves with that version.
export function selfTest(exe, timeoutMs = 60_000) {
  const didNotStart = (reason) => new Error(`the new version did not start on this PC (${String(reason).trim().split('\n').pop()})`);
  return new Promise((resolve, reject) => {
    try {
      execFile(exe, ['--self-test'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) return reject(didNotStart(stderr || err.message));
        try {
          return resolve(JSON.parse(stdout.trim().split('\n').pop()).version);
        } catch {
          return reject(new Error('the new version did not answer its self-test'));
        }
      });
    } catch (err) {
      reject(didNotStart(err.message)); // Windows refuses a file that is not a program at once: "spawn UNKNOWN" is thrown here, not given to the callback
    }
  });
}

export const newFile = (exe) => exe.replace(/\.exe$/i, '.new.exe');
export const oldFile = (exe) => exe.replace(/\.exe$/i, '.old.exe');

// Windows lets a program's .exe be renamed while it runs, but not replaced. So the running file becomes
// "<name>.old.exe" and the new one takes its name. The new version deletes the old file once it runs.
export function swapIn(exe) {
  const old = oldFile(exe);
  fs.rmSync(old, { force: true });
  fs.renameSync(exe, old);
  try {
    fs.renameSync(newFile(exe), exe);
  } catch (err) {
    fs.renameSync(old, exe);
    throw err;
  }
}

const BUSY = ['checking', 'downloading', 'testing', 'restarting'];

// url: where to ask (GitHub's "latest release"), or null (no checks). exe: the running Wandless.exe, or null (the
// source folder: it can check, but only the .exe installs). restart(): starts the new file, then ends this one.
// States: off, waiting, checking, latest, unknown (could not ask), available, downloading, testing, restarting.
export class Updater {
  constructor({ version, url, exe = null, restart = () => {}, fetchFn = fetch, test = selfTest }) {
    Object.assign(this, { version, url, exe, restart, fetchFn, test });
    this.state = url ? 'waiting' : 'off';
    this.latest = null;
    this.error = '';
    this.progress = null;
  }

  status() {
    const l = this.latest;
    return {
      version: this.version,
      state: this.state,
      error: this.error,
      progress: this.progress,
      latest: l && { version: l.version, notes: l.notes, page: l.page, size: l.asset ? l.asset.size : 0 },
      canInstall: !!this.exe,
    };
  }

  async check() {
    if (!this.url || BUSY.includes(this.state)) return this.status();
    this.state = 'checking';
    this.error = '';
    try {
      const r = await latestRelease({ url: this.url, version: this.version, fetchFn: this.fetchFn });
      this.latest = r && isNewer(r.version, this.version) ? r : null;
      this.state = this.latest ? 'available' : 'latest';
      if (this.latest && !this.latest.asset) this.error = `Version ${r.version} has no ${ASSET} to download yet.`;
    } catch (err) {
      this.state = 'unknown';
      this.error = `Could not ask GitHub for updates: ${err.cause?.code || err.message}`;
    }
    return this.status();
  }

  // Why "Update now" cannot run now, or '' when it can.
  blocker() {
    if (this.state !== 'available' || !this.latest.asset) return 'There is no update to install.';
    if (!this.exe) return 'Only Wandless.exe updates itself. This copy runs from the source folder: update it with Git.';
    return '';
  }

  async apply() {
    const why = this.blocker();
    if (why) throw new Error(why);
    const next = newFile(this.exe);
    const { asset, version } = this.latest;
    this.error = '';
    try {
      this.state = 'downloading';
      this.progress = { done: 0, total: asset.size };
      await downloadChecked({ ...asset, file: next, fetchFn: this.fetchFn, onProgress: (done) => { this.progress = { done, total: asset.size }; } });
      this.state = 'testing';
      const got = await this.test(next);
      if (got !== version) throw new Error(`the new file says it is version ${got}, not ${version}`);
      swapIn(this.exe);
      this.state = 'restarting';
      this.restart();
    } catch (err) {
      this.state = 'available';
      this.progress = null;
      this.error = `The update failed: ${err.message}.`;
      removeQuietly(next);
      throw err;
    }
  }
}
