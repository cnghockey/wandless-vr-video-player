// The words of a subtitle track, as cues the page can show: from a subtitle file beside the video, or from the text
// subtitles inside the video (ffmpeg takes those out).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeText, parseSubtitles } from '../public/core.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // a subtitle file is text: a few hundred KB at most

// [{ start, end, text }] -> [[start, end, text]]: shorter to send.
export const packCues = (cues) => cues.map((c) => [Math.round(c.start * 1000) / 1000, Math.round(c.end * 1000) / 1000, c.text]);

// The cues of a subtitle file (SRT, WebVTT, ASS), whatever its text encoding.
export async function readSubtitleFile(file) {
  const { size } = await fs.promises.stat(file);
  if (size > MAX_FILE_BYTES) throw new Error('subtitle file too large');
  return parseSubtitles(decodeText(await fs.promises.readFile(file)));
}

// ffmpeg: every text subtitle track in `streams` into its own SRT file, in ONE reading of the video.
export function extractArgs({ input, streams, dir }) {
  return ['-v', 'error', '-nostdin', '-y', '-i', input,
    ...streams.flatMap((n) => ['-map', `0:${n}`, '-c:s', 'srt', '-f', 'srt', path.join(dir, `${n}.srt`)])];
}

// Takes the text subtitles out of videos, and keeps them on disk: `dir`/<file key>-<stream>.json.
// ffmpeg must read the whole video to find every subtitle (they are spread through it), so all the text tracks of a
// video come out in one run. One video at a time. A video that fails is not tried again for 10 minutes.
export class SubtitleExtractor {
  constructor({ ffmpeg, dir, timeoutMs = 15 * 60_000 }) {
    Object.assign(this, { ffmpeg, dir, timeoutMs });
    fs.mkdirSync(dir, { recursive: true });
    this.queue = Promise.resolve();
    this.inflight = new Map();
    this.failed = new Map();
    this.runs = 0; // how many times ffmpeg read a video (the tests count it)
  }

  #key({ file, size, mtimeMs }) {
    return crypto.createHash('sha256').update(`${file}|${size}|${mtimeMs}`).digest('hex').slice(0, 24);
  }

  #out(key, stream) {
    return path.join(this.dir, `${key}-${stream}.json`);
  }

  // Has every one of `streams` been taken out already?
  ready(info, streams) {
    const key = this.#key(info);
    return streams.every((n) => fs.existsSync(this.#out(key, n)));
  }

  // Start taking out the text tracks `streams` of a video (if not done yet). Resolves when done (true) or failed (false).
  extract(info, streams) {
    const key = this.#key(info);
    if (!streams.length || this.ready(info, streams)) return Promise.resolve(true);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const failedAt = this.failed.get(key);
    if (failedAt && Date.now() - failedAt < 600_000) return Promise.resolve(false);
    const job = this.queue.then(() => this.#run(info.file, key, streams)).then((ok) => {
      if (!ok) this.failed.set(key, Date.now());
      return ok;
    }, () => {
      this.failed.set(key, Date.now());
      return false;
    }).finally(() => this.inflight.delete(key));
    this.queue = job.catch(() => {});
    this.inflight.set(key, job);
    return job;
  }

  // The packed cues of one text track, taking the video's tracks out first if needed. null when that failed.
  async cues(info, stream, streams) {
    const out = this.#out(this.#key(info), stream);
    if (!fs.existsSync(out)) await this.extract(info, streams);
    try {
      return JSON.parse(await fs.promises.readFile(out, 'utf8'));
    } catch {
      return null;
    }
  }

  async #run(file, key, streams) {
    this.runs++;
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vrp-subs-'));
    try {
      const ok = await new Promise((resolve) => {
        execFile(this.ffmpeg, extractArgs({ input: file, streams, dir: tmp }), { timeout: this.timeoutMs, windowsHide: true }, (err) => resolve(!err));
      });
      if (!ok) return false;
      for (const n of streams) {
        let cues = [];
        try {
          cues = parseSubtitles(decodeText(await fs.promises.readFile(path.join(tmp, `${n}.srt`))));
        } catch {
          // a track with no words at all: ffmpeg wrote no file
        }
        const out = this.#out(key, n);
        await fs.promises.writeFile(`${out}.tmp`, JSON.stringify(packCues(cues)));
        await fs.promises.rename(`${out}.tmp`, out); // whole or not at all: a reader never sees half a file
      }
      return true;
    } finally {
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}
