// Preview images for the video list: one frame per video, made by ffmpeg and kept on disk.
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { guessLayout } from '../public/core.js';
import { scanLibrary, resolveMedia } from './library.js';

const CANDIDATES = ['ffmpeg', 'C:\\Program Files\\Jellyfin\\Server\\ffmpeg.exe'];

// Does this program start? (ffmpeg and ffprobe answer -version.)
export function canRun(bin) {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// Find an ffmpeg that runs. The FFMPEG_PATH setting wins. Returns its path, or null.
export function findFfmpeg(env = process.env, candidates = CANDIDATES) {
  return [env.FFMPEG_PATH, ...candidates].filter(Boolean).find(canRun) || null;
}

// The picture filter: keep ONE eye of a 3D file (left half or top half), then shrink to 360 px wide.
// A 2:1 frame with no layout word is VR180 side by side: the same rule the player uses.
export function thumbFilter(name) {
  const { stereo } = guessLayout(name);
  const eye = stereo === 'sbs'
    ? 'crop=iw/2:ih:0:0'
    : stereo === 'tb'
      ? 'crop=iw:ih/2:0:0'
      : "crop='if(between(iw/ih,1.9,2.1),iw/2,iw)':ih:0:0";
  return `${eye},scale=360:-2`;
}

export function thumbArgs({ input, output, name, seek }) {
  return ['-v', 'error', '-y', '-ss', String(seek), '-i', input, '-vf', thumbFilter(name), '-frames:v', '1', '-q:v', '4', output];
}

// Makes previews, a few at a time, and remembers them: the file name is a hash of the path, size and change time.
// A video that fails is not tried again for 10 minutes.
export class Thumbnailer {
  constructor({ ffmpeg, dir, concurrency = 2, timeoutMs = 45_000 }) {
    Object.assign(this, { ffmpeg, dir, concurrency, timeoutMs });
    fs.mkdirSync(dir, { recursive: true });
    this.running = 0;
    this.queue = [];
    this.inflight = new Map();
    this.failed = new Map();
    this.spawned = 0; // how many ffmpeg runs started (the tests count it)
  }

  async get({ file, name, size, mtimeMs }) {
    const key = crypto.createHash('sha1').update(`${file}|${size}|${mtimeMs}`).digest('hex');
    const out = path.join(this.dir, `${key}.jpg`);
    if (fs.existsSync(out)) return out;
    const failedAt = this.failed.get(key);
    if (failedAt && Date.now() - failedAt < 600_000) return null;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = this.#enqueue(() => this.#make(file, name, out)).then((ok) => {
      this.inflight.delete(key);
      if (!ok) this.failed.set(key, Date.now());
      return ok ? out : null;
    });
    this.inflight.set(key, job);
    return job;
  }

  #enqueue(task) {
    return new Promise((resolve) => {
      this.queue.push({ task, resolve });
      this.#pump();
    });
  }

  #pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const { task, resolve } = this.queue.shift();
      this.running++;
      task()
        .then(resolve, () => resolve(false))
        .finally(() => {
          this.running--;
          this.#pump();
        });
    }
  }

  async #make(file, name, out) {
    for (const seek of [5, 0]) { // 5 s in avoids a black first frame; a shorter video falls back to the start
      const temp = `${out}.${process.pid}.tmp.jpg`;
      const ran = await this.#run(thumbArgs({ input: file, output: temp, name, seek }));
      if (ran && fs.existsSync(temp) && fs.statSync(temp).size > 0) {
        fs.renameSync(temp, out);
        return true;
      }
      fs.rmSync(temp, { force: true });
    }
    return false;
  }

  #run(args) {
    this.spawned++;
    return new Promise((resolve) => {
      execFile(this.ffmpeg, args, { timeout: this.timeoutMs, windowsHide: true }, (err) => resolve(!err));
    });
  }
}

// Make the previews for the whole library in the background, one at a time. Returns how many exist.
// onProgress(done, total) runs after each file (the control page shows it).
export async function warmUp(mediaRoot, thumbnailer, onProgress = () => {}) {
  const files = await scanLibrary(mediaRoot);
  let made = 0;
  let done = 0;
  onProgress(0, files.length);
  for (const f of files) {
    const real = await resolveMedia(mediaRoot, f.path);
    if (real) {
      const { mtimeMs } = await fs.promises.stat(real.file);
      if (await thumbnailer.get({ file: real.file, name: f.path, size: real.size, mtimeMs })) made++;
    }
    onProgress(++done, files.length);
  }
  return { made, total: files.length };
}
