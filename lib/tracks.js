// What a video holds besides its picture: its audio tracks, the subtitles inside it, and the subtitle files beside it.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { VIDEO_TYPES } from './library.js';

// Subtitles stored as text can be shown. Picture subtitles (DVD, Blu-ray) cannot: they would need text recognition.
export const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
export const SUBTITLE_FILES = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const SUBS_FOLDERS = new Set(['subs', 'sub', 'subtitles']);

// ffprobe is installed beside ffmpeg (both on the PATH, or both in the same folder).
export function ffprobeFor(ffmpeg) {
  if (!ffmpeg) return null;
  const dir = path.dirname(ffmpeg);
  const name = path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe');
  return dir === '.' && !ffmpeg.includes(path.sep) && !ffmpeg.includes('/') ? name : path.join(dir, name);
}

export const PROBE_ARGS = ['-v', 'error', '-show_entries',
  'format=duration,format_name,start_time:stream=index,codec_type,codec_name,channels,start_time:stream_tags=language,title'
  + ':stream_disposition=default,forced,hearing_impaired', '-of', 'json'];

// ffprobe's report -> { duration, audio, nativeSure, subtitles }.
// The headset browser plays ONE audio track by itself (`native`): in an MP4 the track marked default, in an MKV the
// first one. Older browsers may not follow the MP4 mark, so `nativeSure` is false when that mark is not on the first.
export function readTracks(report) {
  const streams = Array.isArray(report.streams) ? report.streams : [];
  const format = report.format || {};
  const base = Number(format.start_time) || 0;
  const tags = (s) => s.tags || {};
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s) => ({
    stream: s.index,
    codec: s.codec_name || '',
    channels: s.channels || 0,
    language: tags(s).language || '',
    title: tags(s).title || '',
    default: !!(s.disposition && s.disposition.default),
    start: Math.max(0, (Number(s.start_time) || 0) - base), // seconds after the start of the video
    native: false,
  }));
  const mp4 = /\b(mp4|mov)\b/.test(format.format_name || '');
  const marked = mp4 ? audio.findIndex((a) => a.default) : -1;
  if (audio.length) audio[marked > 0 ? marked : 0].native = true;
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle').map((s) => ({
    stream: s.index,
    codec: s.codec_name || '',
    language: tags(s).language || '',
    title: tags(s).title || '',
    forced: !!(s.disposition && s.disposition.forced),
    hi: !!(s.disposition && s.disposition.hearing_impaired),
    text: TEXT_SUBTITLES.has(s.codec_name),
  }));
  return { duration: Number(format.duration) || 0, audio, nativeSure: marked <= 0, subtitles };
}

// Reads the tracks of each video once (per file version) with ffprobe. Kept in memory and in `cacheFile`.
export class TrackProbe {
  constructor({ ffprobe, cacheFile = null, timeoutMs = 30_000 }) {
    Object.assign(this, { ffprobe, cacheFile, timeoutMs });
    this.known = new Map();
    this.inflight = new Map();
    this.probed = 0; // how many files ffprobe really read (the tests count it)
    if (cacheFile) {
      try {
        this.known = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))));
      } catch {
        // no cache yet
      }
    }
  }

  async get({ file, size, mtimeMs }) {
    const key = crypto.createHash('sha256').update(`${file}|${size}|${mtimeMs}`).digest('hex').slice(0, 24);
    if (this.known.has(key)) return this.known.get(key);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = this.#run(file).then((report) => {
      const tracks = readTracks(report);
      this.known.set(key, tracks);
      if (this.cacheFile) fs.promises.writeFile(this.cacheFile, JSON.stringify(Object.fromEntries(this.known))).catch(() => {});
      return tracks;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  #run(file) {
    this.probed++;
    return new Promise((resolve, reject) => {
      execFile(this.ffprobe, [...PROBE_ARGS, file], { timeout: this.timeoutMs, windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}

const readDir = async (dir) => {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const isSubtitleFile = (e) => e.isFile() && SUBTITLE_FILES.has(path.extname(e.name).toLowerCase());

// The subtitle files that belong to a video, as paths inside the folder (`rel` is the video's path there, with '/').
// Three places, the ones video tools use:
//   - beside the video, named like it: "Film.mkv" -> "Film.srt", "Film.en.srt", "Film.eng.hi.srt";
//   - in a Subs folder beside it: files named like the video, or every file when the video is alone in its folder;
//   - in Subs/<the video's name>/, as many downloads have them: "Subs/Film/2_English.srt".
// Each comes with `tag`, the words that name its language: what follows the video's name, or the whole file name.
// Links are skipped, so nothing outside the folder is ever read.
export async function findSubtitleFiles(root, rel, { max = 100 } = {}) {
  const dirRel = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  const dir = path.join(root, ...dirRel.split('/').filter(Boolean));
  const ext = path.posix.extname(rel);
  const base = path.posix.basename(rel, ext).toLowerCase();
  const join = (...parts) => [dirRel, ...parts].filter(Boolean).join('/');
  const out = [];
  const add = (relPath, name, whole) => {
    if (out.length >= max) return;
    const stem = name.slice(0, name.length - path.extname(name).length);
    out.push({ rel: relPath, tag: whole ? stem : stem.slice(base.length + 1) });
  };
  const named = (name) => name.toLowerCase().startsWith(`${base}.`);
  const entries = await readDir(dir);
  for (const e of entries) if (isSubtitleFile(e) && named(e.name)) add(join(e.name), e.name, false);
  const alone = entries.filter((e) => e.isFile() && VIDEO_TYPES[path.extname(e.name).toLowerCase()]).length === 1;
  for (const folder of entries.filter((e) => e.isDirectory() && SUBS_FOLDERS.has(e.name.toLowerCase()))) {
    const inSubs = await readDir(path.join(dir, folder.name));
    for (const e of inSubs) {
      if (isSubtitleFile(e) && (named(e.name) || alone)) add(join(folder.name, e.name), e.name, !named(e.name));
    }
    for (const own of inSubs.filter((e) => e.isDirectory() && e.name.toLowerCase() === base)) {
      for (const e of await readDir(path.join(dir, folder.name, own.name))) {
        if (isSubtitleFile(e)) add(join(folder.name, own.name, e.name), e.name, true);
      }
    }
  }
  return out;
}
