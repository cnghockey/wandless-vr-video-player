import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { saveAuth } from '../lib/auth.js';
import { folderId } from '../lib/folders.js';
import { findFfmpeg } from '../lib/thumbs.js';
import { ffprobeFor, TrackProbe, readTracks } from '../lib/tracks.js';
import { SubtitleExtractor } from '../lib/subtitles.js';
import { RATE, FRAME_BYTES, HEADER_BYTES, wavDataBytes } from '../lib/audio.js';
import { startServer } from '../server.js';
import { parseSubtitles } from '../public/core.js';

// The track routes with REAL ffmpeg and ffprobe, on small made-up videos:
//   film.mkv: audio 440 Hz (English), audio 880 Hz (French), two text subtitle tracks;
//   subtitle files beside it, in Subs/film/, a stray one in Subs/, an old Windows-1252 French one;
//   marked.mp4: an MP4 whose second audio track carries the default mark.
// (ffmpeg cannot make picture subtitles from text, so readTracks gets a written-out ffprobe report for those.)
const ffmpeg = findFfmpeg();
const skip = !ffmpeg && 'ffmpeg not found';
let base;
let srv;
let bare;
let F;
let extractor;
const SRT_EN = '1\n00:00:01,000 --> 00:00:03,000\nHello <i>there</i>\n\n2\n00:00:04,500 --> 00:00:06,000\nSecond line\n';
const SRT_FR = '1\n00:00:01,000 --> 00:00:02,000\nBonjour\n';

function request(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: server.port, path: urlPath, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function login(server) {
  const body = new URLSearchParams({ password: 'hunter22' }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: server.port, path: '/login', method: 'POST', rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const run = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true });

// How many times the left channel crosses zero per second: twice the tone's frequency.
function toneHz(pcm) {
  let crossings = 0;
  let prev = 0;
  const frames = Math.floor(pcm.length / FRAME_BYTES);
  for (let i = 0; i < frames; i++) {
    const v = pcm.readInt16LE(i * FRAME_BYTES);
    if (i && (v >= 0) !== (prev >= 0)) crossings++;
    prev = v;
  }
  return crossings / 2 / (frames / RATE);
}

before(async () => {
  if (!ffmpeg) return;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-tracks-'));
  const media = path.join(base, 'media');
  const work = path.join(base, 'work');
  for (const d of [media, work, path.join(media, 'Subs', 'film'), path.join(media, 'solo', 'Subs')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, 'en.srt'), SRT_EN);
  fs.writeFileSync(path.join(work, 'fr.srt'), SRT_FR);
  const tone = (hz) => ['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=10`];
  run(['-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=5:d=10', ...tone(440), ...tone(880),
    '-i', path.join(work, 'en.srt'), '-i', path.join(work, 'fr.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fre', '-metadata:s:a:1', 'title=French dub',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fre', '-disposition:s:1', 'forced', path.join(media, 'film.mkv')]);
  run(['-i', path.join(media, 'film.mkv'), '-map', '0:v', '-map', '0:a', '-c', 'copy', '-disposition:a:0', '0', '-disposition:a:1', 'default',
    path.join(media, 'marked.mp4')]);
  // A track that starts 1 s after the video (an audio delay set when the file was made).
  run(['-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=5:d=4', '-itsoffset', '1', ...tone(660),
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '4', path.join(media, 'late.mkv')]);
  // Noise: a shift in time cannot hide behind a tone that repeats.
  run(['-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=5:d=8', '-f', 'lavfi', '-i', 'anoisesrc=d=8:c=pink:r=48000:a=0.3:seed=7',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(media, 'noise.mkv')]);
  fs.writeFileSync(path.join(media, 'film.en.srt'), SRT_EN);
  // An old French file in Windows-1252: "l'été" with a curly apostrophe (0x92) and é (0xE9).
  fs.writeFileSync(path.join(media, 'film.fr.srt'), Buffer.concat([Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nl'),
    Buffer.from([0x92, 0xe9, 0x74, 0xe9]), Buffer.from('\r\n')]));
  fs.writeFileSync(path.join(media, 'Subs', 'film', '2_English.srt'), SRT_EN);
  fs.writeFileSync(path.join(media, 'Subs', 'stray.srt'), SRT_EN); // two videos in this folder: not film's
  fs.writeFileSync(path.join(media, 'filmmaker.en.srt'), SRT_EN); // starts like "film", but it is another name
  fs.writeFileSync(path.join(media, 'notes.txt'), 'not a subtitle');
  fs.copyFileSync(path.join(media, 'marked.mp4'), path.join(media, 'solo', 'only.mp4'));
  fs.writeFileSync(path.join(media, 'solo', 'Subs', 'English.srt'), SRT_EN); // alone in its folder: this is its file
  fs.writeFileSync(path.join(base, 'outside.srt'), SRT_EN);
  fs.writeFileSync(path.join(base, 'app.html'), 'app');
  const stateDir = path.join(base, 'state');
  saveAuth(stateDir, 'hunter22');
  F = folderId(media);
  extractor = new SubtitleExtractor({ ffmpeg, dir: path.join(stateDir, 'subtitles') });
  const common = { port: 0, host: '127.0.0.1', mediaRoot: media, stateDir, appFile: path.join(base, 'app.html') };
  srv = await startServer({ ...common, trackProbe: new TrackProbe({ ffprobe: ffprobeFor(ffmpeg) }), subtitleExtractor: extractor, ffmpeg });
  bare = await startServer(common); // no ffmpeg at all
});

after(async () => {
  if (!ffmpeg) return;
  await srv.close();
  await bare.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('readTracks: picture subtitles are not text; which audio track the browser plays by itself', () => {
  const report = (format, audioMarks) => ({
    format: { format_name: format, duration: '60.5', start_time: '0.5' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'hevc' },
      ...audioMarks.map((d, i) => ({ index: 1 + i, codec_type: 'audio', codec_name: 'eac3', channels: 6, start_time: '0.52', tags: { language: 'eng' }, disposition: { default: d } })),
      { index: 9, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'fre' }, disposition: { forced: 1 } },
      { index: 10, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'SDH' }, disposition: { hearing_impaired: 1 } },
    ],
  });
  const mkv = readTracks(report('matroska,webm', [0, 1]));
  assert.equal(mkv.duration, 60.5);
  assert.deepEqual(mkv.audio.map((a) => a.native), [true, false], 'an MKV plays its first track, whatever the marks');
  assert.equal(mkv.nativeSure, true);
  assert.ok(Math.abs(mkv.audio[0].start - 0.02) < 1e-9, 'a track start is counted from the start of the video');
  assert.deepEqual(mkv.subtitles.map(({ stream, text, forced, hi }) => ({ stream, text, forced, hi })),
    [{ stream: 9, text: false, forced: true, hi: false }, { stream: 10, text: true, forced: false, hi: true }]);
  const mp4 = readTracks(report('mov,mp4,m4a,3gp,3g2,mj2', [0, 0, 1]));
  assert.deepEqual(mp4.audio.map((a) => a.native), [false, false, true], 'an MP4 plays the track marked default');
  assert.equal(mp4.nativeSure, false, 'older browsers may play the first one: not sure');
  assert.equal(readTracks(report('mov,mp4,m4a,3gp,3g2,mj2', [1, 0])).nativeSure, true);
  assert.deepEqual(readTracks(report('mov,mp4,m4a,3gp,3g2,mj2', [0, 0])).audio.map((a) => a.native), [true, false], 'no mark: the first');
  assert.deepEqual(readTracks({}), { duration: 0, audio: [], nativeSure: true, subtitles: [] });
});

const json = async (server, urlPath, cookie) => {
  const r = await request(server, urlPath, { Cookie: cookie });
  assert.equal(r.status, 200, `${urlPath}: ${r.body}`);
  return JSON.parse(r.body.toString());
};

test('the track routes need the login', { skip }, async () => {
  for (const t of [`/api/tracks/${F}/film.mkv`, `/api/subtitles/${F}/film.mkv?key=s:3`, `/api/audio/${F}/film.mkv?stream=2`]) {
    assert.equal((await request(srv, t)).status, 401, t);
  }
});

test('/api/tracks: the audio tracks, the subtitle files in their three places, the text tracks, and the picture ones counted', { skip }, async () => {
  const t = await json(srv, `/api/tracks/${F}/film.mkv`, await login(srv));
  for (let i = 0; i < 100 && extractor.runs === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(extractor.runs, 1, 'asking for the tracks starts taking out the text subtitles, before anyone asks for them');
  assert.ok(Math.abs(t.duration - 10) < 0.2, `duration ${t.duration}`);
  assert.deepEqual(t.audio.map(({ stream, language, title, channels, native }) => ({ stream, language, title, channels, native })), [
    { stream: 1, language: 'eng', title: '', channels: 1, native: true },
    { stream: 2, language: 'fre', title: 'French dub', channels: 1, native: false },
  ]);
  assert.equal(t.nativeSure, true, 'an MKV plays its first track');
  assert.deepEqual(t.subtitles, [
    { key: 'file:film.en.srt', source: 'file', tag: 'en' },
    { key: 'file:film.fr.srt', source: 'file', tag: 'fr' },
    { key: 'file:Subs/film/2_English.srt', source: 'file', tag: '2_English' },
    { key: 's:3', source: 'video', language: 'eng', title: '', forced: false, hi: false },
    { key: 's:4', source: 'video', language: 'fre', title: '', forced: true, hi: false },
  ]);
  assert.equal(t.pictureSubtitles, 0);
  const solo = await json(srv, `/api/tracks/${F}/solo/only.mp4`, await login(srv));
  assert.deepEqual(solo.subtitles, [{ key: 'file:solo/Subs/English.srt', source: 'file', tag: 'English' }], 'a video alone in its folder owns its Subs folder');
});

test('/api/tracks on an MP4 whose second track is marked default: that one plays, and the page is told it is not sure', { skip }, async () => {
  const t = await json(srv, `/api/tracks/${F}/marked.mp4`, await login(srv));
  assert.deepEqual(t.audio.map((a) => a.native), [false, true]);
  assert.equal(t.nativeSure, false);
});

test('/api/subtitles: a file beside the video, an old Windows-1252 one, and a text track from inside the video', { skip }, async () => {
  const cookie = await login(srv);
  const file = await json(srv, `/api/subtitles/${F}/film.mkv?key=${encodeURIComponent('file:film.en.srt')}`, cookie);
  assert.deepEqual(file.cues, [[1, 3, 'Hello there'], [4.5, 6, 'Second line']]);
  const old = await json(srv, `/api/subtitles/${F}/film.mkv?key=${encodeURIComponent('file:film.fr.srt')}`, cookie);
  assert.deepEqual(old.cues, [[1, 2, 'l’été']]);
  const inSubs = await json(srv, `/api/subtitles/${F}/film.mkv?key=${encodeURIComponent('file:Subs/film/2_English.srt')}`, cookie);
  assert.equal(inSubs.cues.length, 2);
  const inside = await json(srv, `/api/subtitles/${F}/film.mkv?key=s:3`, cookie);
  assert.deepEqual(inside.cues, [[1, 3, 'Hello there'], [4.5, 6, 'Second line']], 'the same words and times as the file put in');
  const fr = await json(srv, `/api/subtitles/${F}/film.mkv?key=s:4`, cookie);
  assert.deepEqual(fr.cues, [[1, 2, 'Bonjour']]);
  assert.equal(extractor.runs, 1, 'ffmpeg read the video ONCE for both tracks (asking for the tracks started it)');
});

test('/api/subtitles?download: an SRT file named like the video, with the same words, for the headset', { skip }, async () => {
  const cookie = await login(srv);
  for (const [key, name] of [['file:film.en.srt', 'film.en.srt'], ['file:Subs/film/2_English.srt', 'film.2_English.srt'], ['s:4', 'film.fre.forced.srt']]) {
    const url = `/api/subtitles/${F}/film.mkv?key=${encodeURIComponent(key)}`;
    const r = await request(srv, `${url}&download=1`, { Cookie: cookie });
    assert.equal(r.status, 200, key);
    assert.match(r.headers['content-type'], /^application\/x-subrip; charset=utf-8/);
    assert.equal(r.headers['content-disposition'], `attachment; filename="${name}"; filename*=UTF-8''${name}`, key);
    const back = parseSubtitles(r.body.toString('utf8')).map((c) => [c.start, c.end, c.text]);
    assert.deepEqual(back, (await json(srv, url, cookie)).cues, `${key}: the same cues as the page gets`);
  }
  assert.equal((await request(srv, `/api/subtitles/${F}/film.mkv?key=${encodeURIComponent('file:../film.en.srt')}&download=1`, { Cookie: cookie })).status, 404);
  assert.equal((await request(srv, `/api/subtitles/${F}/film.mkv?key=s:3&download=1`)).status, 401, 'the login is needed');
});

test('/api/subtitles refuses keys that are not this video\'s subtitles', { skip }, async () => {
  const cookie = await login(srv);
  for (const key of ['file:../outside.srt', 'file:Subs/stray.srt', 'file:notes.txt', 'file:film.mkv', 'file:Subs/film/../../../outside.srt',
    's:1', 's:5', 's:99', 's:-1', 's:3x', 'x', '']) {
    const r = await request(srv, `/api/subtitles/${F}/film.mkv?key=${encodeURIComponent(key)}`, { Cookie: cookie });
    assert.equal(r.status, 404, key);
  }
  for (const t of [`/api/subtitles/${F}/..%2Foutside.srt?key=s:3`, `/api/tracks/${F}/..%2Foutside.mp4`, `/api/tracks/${F}/notes.txt`]) {
    assert.equal((await request(srv, t, { Cookie: cookie })).status, 404, t);
  }
});

test('/api/audio: a WAV of the chosen track, its length the video\'s, in time at any byte', { skip }, async () => {
  const cookie = await login(srv);
  const url = (stream) => `/api/audio/${F}/film.mkv?stream=${stream}`;
  const { duration } = await json(srv, `/api/tracks/${F}/film.mkv`, cookie);
  const total = HEADER_BYTES + wavDataBytes(duration);
  const head = await request(srv, url(2), { Cookie: cookie, Range: 'bytes=0-43' });
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-range'], `bytes 0-43/${total}`);
  assert.equal(head.headers['content-type'], 'audio/wav');
  const h = head.body;
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(h.readUInt16LE(22), 2);
  assert.equal(h.readUInt32LE(24), RATE);
  assert.equal(h.readUInt32LE(40), total - HEADER_BYTES);
  // 1 s of sound from 5 s in: the French track is the 880 Hz tone, the English one 440 Hz.
  const at5 = HEADER_BYTES + 5 * RATE * FRAME_BYTES;
  const slice = (stream, from, bytes) => request(srv, url(stream), { Cookie: cookie, Range: `bytes=${from}-${from + bytes - 1}` });
  const fr = await slice(2, at5, RATE * FRAME_BYTES);
  assert.equal(fr.status, 206);
  assert.equal(fr.body.length, RATE * FRAME_BYTES);
  assert.ok(Math.abs(toneHz(fr.body) - 880) < 5, `French track ${toneHz(fr.body)} Hz`);
  const en = await slice(1, at5, RATE * FRAME_BYTES);
  assert.ok(Math.abs(toneHz(en.body) - 440) < 5, `English track ${toneHz(en.body)} Hz`);
  // A range that starts in the middle of a frame gets the same bytes, moved by those 3 bytes.
  const odd = await slice(2, at5 + 3, 1000);
  assert.ok(odd.body.equals(fr.body.subarray(3, 1003)), 'byte-exact inside a frame');
  const whole = await request(srv, url(2), { Cookie: cookie });
  assert.equal(whole.status, 200);
  assert.equal(whole.body.length, total);
  // The same moment from the whole WAV and from a request that starts at 3 s (ffmpeg seeks then): they line up to
  // well under a millisecond. Noise, because a shift could hide behind a tone that repeats.
  const noise = `/api/audio/${F}/noise.mkv?stream=1`;
  const all = (await request(srv, noise, { Cookie: cookie })).body;
  const at3 = HEADER_BYTES + 3 * RATE * FRAME_BYTES;
  const later = (await request(srv, noise, { Cookie: cookie, Range: `bytes=${at3}-${at3 + RATE * FRAME_BYTES - 1}` })).body;
  const left = (buf, frameIndex) => buf.readInt16LE(frameIndex * FRAME_BYTES);
  let best = { lag: 0, err: Infinity };
  for (let lag = -2000; lag <= 2000; lag++) {
    let err = 0;
    for (let k = 2000; k < 4000; k++) err += (left(all, at3 / FRAME_BYTES + k + lag) - left(later, k)) ** 2; // `all` holds the header too
    if (err < best.err) best = { lag, err };
  }
  assert.ok(Math.abs(best.lag) <= RATE / 1000, `the decode after a seek is ${best.lag} samples (${(best.lag / 48).toFixed(2)} ms) off`);
  // The end: the last bytes exist, past the end is refused.
  assert.equal((await request(srv, url(2), { Cookie: cookie, Range: `bytes=${total - 10}-` })).body.length, 10);
  assert.equal((await request(srv, url(2), { Cookie: cookie, Range: `bytes=${total}-` })).status, 416);
});

test('/api/audio: a track that starts 1 s late gets 1 s of silence first, so the WAV keeps the video\'s time', { skip }, async () => {
  const cookie = await login(srv);
  const t = await json(srv, `/api/tracks/${F}/late.mkv`, cookie);
  assert.ok(Math.abs(t.audio[0].start - 1) < 0.05, `the track starts at ${t.audio[0].start} s`);
  const url = `/api/audio/${F}/late.mkv?stream=1`;
  const quiet = (await request(srv, url, { Cookie: cookie, Range: `bytes=${HEADER_BYTES}-${HEADER_BYTES + 0.9 * RATE * FRAME_BYTES - 1}` })).body;
  assert.ok(quiet.length > 0 && quiet.every((b) => b === 0), 'the first 0.9 s are silent');
  const from = HEADER_BYTES + 0.5 * RATE * FRAME_BYTES; // a request that starts in the silence and runs into the sound
  const mixed = (await request(srv, url, { Cookie: cookie, Range: `bytes=${from}-${from + 1.5 * RATE * FRAME_BYTES - 1}` })).body;
  assert.ok(mixed.subarray(0, 0.4 * RATE * FRAME_BYTES).every((b) => b === 0), 'still silent until 1 s');
  assert.ok(Math.abs(toneHz(mixed.subarray(0.6 * RATE * FRAME_BYTES)) - 660) < 8, `then the tone: ${toneHz(mixed.subarray(0.6 * RATE * FRAME_BYTES))} Hz`);
  const sound = (await request(srv, url, { Cookie: cookie, Range: `bytes=${HEADER_BYTES + 2 * RATE * FRAME_BYTES}-${HEADER_BYTES + 3 * RATE * FRAME_BYTES - 1}` })).body;
  assert.ok(Math.abs(toneHz(sound) - 660) < 5, `at 2 s: ${toneHz(sound)} Hz`);
});

test('/api/audio refuses a stream that is not an audio track, and a server with no ffmpeg has no tracks', { skip }, async () => {
  const cookie = await login(srv);
  for (const s of ['0', '3', '99', 'x', '']) {
    assert.equal((await request(srv, `/api/audio/${F}/film.mkv?stream=${s}`, { Cookie: cookie })).status, 404, `stream ${s}`);
  }
  const c2 = await login(bare);
  const t = await json(bare, `/api/tracks/${F}/film.mkv`, c2);
  assert.deepEqual(t.audio, [], 'no ffprobe: no audio menu');
  assert.deepEqual(t.subtitles.map((s) => s.key), ['file:film.en.srt', 'file:film.fr.srt', 'file:Subs/film/2_English.srt'], 'the files still work');
  assert.equal((await request(bare, `/api/audio/${F}/film.mkv?stream=2`, { Cookie: c2 })).status, 404);
  assert.equal((await request(bare, `/api/subtitles/${F}/film.mkv?key=s:3`, { Cookie: c2 })).status, 404);
  assert.equal((await json(bare, `/api/subtitles/${F}/film.mkv?key=${encodeURIComponent('file:film.en.srt')}`, c2)).cues.length, 2);
});

test('the library lists each video with a date for "newest first"', { skip }, async () => {
  const lib = await json(srv, '/api/library', await login(srv));
  const film = lib.files.find((f) => f.path === 'film.mkv');
  const { mtimeMs } = fs.statSync(path.join(base, 'media', 'film.mkv'));
  assert.ok(film.date >= Math.round(mtimeMs) - 1 && film.date <= Date.now(), `date ${film.date}`);
});
