// Another audio track of a video, for the headset.
// The headset browser plays only one audio track of a video file, and it cannot switch to another one. So for another
// track, the laptop decodes that track with ffmpeg to plain 16-bit stereo sound at 48 kHz, sent as a WAV file. The page
// plays it in time with the muted video. Plain sound has a fixed number of bytes per second, so a byte position IS a
// time: the browser seeks in this WAV like in any file, and the laptop starts ffmpeg at that time.
import { spawn } from 'node:child_process';
import { parseRange } from './range.js';

export const RATE = 48000;
export const FRAME_BYTES = 4; // 2 channels of 16 bits
export const HEADER_BYTES = 44;
const MAX_PAD_BYTES = 60 * RATE * FRAME_BYTES; // a track that ends a little early is padded with silence, up to 60 s

// The 44-byte header of a WAV file with `dataBytes` of sound.
export function wavHeader(dataBytes) {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16); // the size of the format part
  h.writeUInt16LE(1, 20); // plain PCM
  h.writeUInt16LE(2, 22); // channels
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * FRAME_BYTES, 28); // bytes per second
  h.writeUInt16LE(FRAME_BYTES, 32);
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// The sound bytes for a track of `seconds`: whole frames, and small enough for the 32-bit sizes in the header (6 h).
export function wavDataBytes(seconds) {
  const frames = Math.ceil(Math.max(0, seconds) * RATE);
  return Math.min(frames, Math.floor((0xffffffff - 36) / FRAME_BYTES)) * FRAME_BYTES;
}

// ffmpeg: one audio stream of `input` from `from` seconds, as raw 16-bit stereo at 48 kHz on stdout.
export function pcmArgs({ input, stream, from = 0 }) {
  return ['-v', 'error', '-nostdin', ...(from > 0 ? ['-ss', from.toFixed(6)] : []), '-i', input,
    '-map', `0:${stream}`, '-vn', '-sn', '-dn', '-ac', '2', '-ar', String(RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
}

// Answers one request for the track's WAV: the header, then the sound, cut to exactly the bytes asked for.
// seconds: how long the video is. lead: when this track starts, in seconds from the start of the video (a track
// that starts late gets silence first, so the WAV's time is always the video's time).
// spawnFn: for tests. Returns nothing; ffmpeg stops when the browser drops the request.
export function serveTrackWav({ ffmpeg, file, stream, seconds, lead = 0, req, res, spawnFn = spawn }) {
  const dataBytes = wavDataBytes(seconds);
  const total = HEADER_BYTES + dataBytes;
  const range = parseRange(req.headers.range, total);
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=0' };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();

  let left = end - start + 1;
  if (start < HEADER_BYTES) {
    const part = wavHeader(dataBytes).subarray(start, Math.min(HEADER_BYTES, end + 1));
    res.write(part);
    left -= part.length;
  }
  if (left <= 0) return res.end();

  // The sound from the frame that holds the first byte asked for.
  const first = Math.max(start, HEADER_BYTES) - HEADER_BYTES;
  const frame = Math.floor(first / FRAME_BYTES);
  let skip = first - frame * FRAME_BYTES;
  const at = frame / RATE;
  const startLead = Math.max(0, lead);
  let silence = at < startLead ? Math.round((startLead - at) * RATE) * FRAME_BYTES : 0;
  const proc = spawnFn(ffmpeg, pcmArgs({ input: file, stream, from: at }), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let ended = false;
  const stop = () => {
    if (!ended) proc.kill();
  };
  res.on('close', stop);
  const exited = new Promise((resolve) => {
    proc.on('error', () => resolve(-1));
    proc.on('close', (code) => {
      ended = true;
      resolve(code);
    });
  });

  // The browser reads slower than ffmpeg writes: wait until it wants more, or is gone.
  const drained = () => new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
  // Writes `buf` within the bytes asked for. Resolves false when the browser is gone.
  const put = async (buf) => {
    let b = buf;
    if (skip) {
      const n = Math.min(skip, b.length);
      b = b.subarray(n);
      skip -= n;
    }
    if (b.length > left) b = b.subarray(0, left);
    if (!b.length) return !res.destroyed;
    left -= b.length;
    if (!res.write(b)) await drained();
    return !res.destroyed;
  };
  const zeros = Buffer.alloc(65536);

  (async () => {
    try {
      while (silence > 0 && left > 0) {
        const n = Math.min(silence, zeros.length);
        silence -= n;
        if (!(await put(zeros.subarray(0, n)))) return;
      }
      let sent = 0;
      for await (const chunk of proc.stdout) {
        sent += chunk.length;
        if (!(await put(chunk)) || left <= 0) break;
      }
      if (left <= 0) return res.end();
      const code = await exited;
      if (code !== 0 && !sent) return res.destroy(); // ffmpeg could not read the track: the page hears an error
      if (left > MAX_PAD_BYTES) return res.destroy(); // far shorter than its header said: do not send minutes of silence
      while (left > 0) {
        if (!(await put(zeros.subarray(0, Math.min(left, zeros.length))))) return;
      }
      res.end();
    } catch {
      res.destroy();
    } finally {
      stop();
    }
  })();
}
