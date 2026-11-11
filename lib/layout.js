import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readFrames } from '../public/core.js';
import { scanLibrary } from './library.js';

// Reads a video's layout from its pictures, because the file name often says nothing: is each eye a fisheye
// circle, is a passthrough mask packed into the red corners (DeoVR's "_alpha" videos), or is the background one
// filled colour round the person (green, violet, black...)? The sums are in public/core.js: the page reads a file
// on the headset the same way.

export const SAMPLE_W = 128;
export const SAMPLE_H = 64;
const TIMES = [0.15, 0.3, 0.5, 0.7, 0.85]; // where the frames are taken, as parts of the length
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'buffer', maxBuffer: 1 << 24, windowsHide: true, ...opts }, (err, stdout, stderr) => {
    if (err) {
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    } else resolve({ stdout, stderr });
  });
});

// Duration and frame size from ffmpeg's own report (it ends with an error: no output file was named).
export async function readVideoInfo(ffmpeg, file) {
  let text = '';
  try {
    text = (await run(ffmpeg, ['-hide_banner', '-i', file], { timeout: 30_000 })).stderr.toString();
  } catch (err) {
    text = err.stderr ? err.stderr.toString() : '';
  }
  const d = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  const s = /Video: .*?(\d{2,5})x(\d{2,5})/.exec(text);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    width: s ? Number(s[1]) : 0,
    height: s ? Number(s[2]) : 0,
  };
}

export class LayoutProbe {
  constructor({ ffmpeg, cacheFile = null, timeoutMs = 60_000 }) {
    this.ffmpeg = ffmpeg;
    this.cacheFile = cacheFile;
    this.timeoutMs = timeoutMs;
    this.known = new Map();
    this.queue = Promise.resolve(); // one probe at a time: 8K decoding is heavy
    this.probed = 0; // how many files were really looked at (for tests)
    if (cacheFile) {
      try {
        this.known = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))));
      } catch {
        // no cache yet
      }
    }
  }

  // { fisheye, alpha, background } for a video file. Kept by file, size and date, so each version of a file is
  // looked at once. The number in front of the key counts the versions of the check: a new version makes every earlier
  // answer count as not known. 2: the background check. 3: a masked fisheye video whose lens ends well inside the eye
  // (a real file, read as flat with a black cut).
  async get({ file, size, mtimeMs }) {
    const key = crypto.createHash('sha256').update(`3|${file}|${size}|${mtimeMs}`).digest('hex').slice(0, 24);
    if (this.known.has(key)) return this.known.get(key);
    const job = this.queue.then(() => (this.known.has(key) ? this.known.get(key) : this.look(file)));
    this.queue = job.catch(() => {});
    const result = await job;
    this.known.set(key, result);
    if (this.cacheFile) {
      fs.promises.writeFile(this.cacheFile, JSON.stringify(Object.fromEntries(this.known))).catch(() => {});
    }
    return result;
  }

  async look(file) {
    this.probed++;
    const { duration, width, height } = await readVideoInfo(this.ffmpeg, file);
    if (!width || !height || Math.abs(width / height - 2) > 0.1) return { fisheye: false, alpha: false, background: null }; // not side-by-side 2:1
    const times = duration > 0 ? TIMES.map((f) => duration * f) : [1, 5, 10, 20, 30];
    const frames = [];
    for (const t of times) {
      const { stdout } = await run(this.ffmpeg, ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1',
        '-vf', `scale=${SAMPLE_W}:${SAMPLE_H}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: this.timeoutMs });
      if (stdout.length === SAMPLE_W * SAMPLE_H * 3) frames.push(stdout);
    }
    return readFrames(frames);
  }
}

// Look at every video of a folder in the background, so choosing one later gets the answer at once.
// Returns { checked, fisheye, alpha }: how many videos were checked, how many were fisheye, and how many were
// passthrough videos (a mask or a filled background). onProgress(done, total, alpha) runs after each file (the
// control page shows it).
export async function warmLayouts(root, probe, onProgress = () => {}) {
  const out = { checked: 0, fisheye: 0, alpha: 0 };
  const files = await scanLibrary(root);
  let done = 0;
  onProgress(0, files.length, 0);
  for (const f of files) {
    try {
      const file = path.join(root, f.path);
      const { mtimeMs } = await fs.promises.stat(file);
      const r = await probe.get({ file, size: f.size, mtimeMs });
      out.checked++;
      if (r.fisheye) out.fisheye++;
      if (r.alpha || r.background) out.alpha++;
    } catch {
      // a file that ffmpeg cannot read: the page keeps its guess from the name and size
    }
    onProgress(++done, files.length, out.alpha);
  }
  return out;
}
