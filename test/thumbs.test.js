import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFfmpeg, thumbFilter, thumbArgs, Thumbnailer, warmUp } from '../lib/thumbs.js';

test('thumbFilter: one eye of a 3D file, the layout read from the name; a 2:1 frame is VR180 side by side', () => {
  assert.match(thumbFilter('scene_180_LR.mp4'), /^crop=iw\/2:ih:0:0,scale=360:-2$/);
  assert.match(thumbFilter('movie_SBS.mp4'), /^crop=iw\/2:ih:0:0,/);
  assert.match(thumbFilter('movie_TB.mp4'), /^crop=iw:ih\/2:0:0,/);
  assert.match(thumbFilter('plain.mp4'), /between\(iw\/ih,1\.9,2\.1\)/);
});

test('thumbArgs: the file path is passed after -i, never as a bare word an option parser could read', () => {
  const args = thumbArgs({ input: 'C:\\v\\a.mp4', output: 'C:\\t\\o.jpg', name: 'a.mp4', seek: 5 });
  assert.equal(args[args.indexOf('-i') + 1], 'C:\\v\\a.mp4');
  assert.equal(args.at(-1), 'C:\\t\\o.jpg');
  assert.equal(args[args.indexOf('-ss') + 1], '5');
});

test('findFfmpeg: a bad path and no other candidates gives null, not an error', () => {
  assert.equal(findFfmpeg({ FFMPEG_PATH: 'C:/nowhere/ffmpeg.exe' }, []), null);
  assert.equal(findFfmpeg({}, []), null);
});

const ffmpeg = findFfmpeg();
const skip = ffmpeg ? false : 'ffmpeg not found on this machine';

// The size of a JPEG, read from its start-of-frame marker.
function jpegSize(buf) {
  assert.ok(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff, 'not a JPEG');
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no size marker');
}

let base;
let media;
let thumbs;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-thumbs-'));
  media = path.join(base, 'media');
  fs.mkdirSync(media);
  if (!ffmpeg) return;
  const make = (file, size, seconds) => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=10`, '-t', String(seconds), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(media, file)]);
  make('vr_sbs.mp4', '640x320', 8); // 2:1, no layout word: VR180 side by side
  make('flat.mp4', '640x360', 8); // 16:9
  make('short.mp4', '320x180', 2); // shorter than the 5 s seek
  fs.writeFileSync(path.join(media, 'broken.mp4'), 'this is not a video');
  thumbs = new Thumbnailer({ ffmpeg, dir: path.join(base, 'thumbs') });
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

const info = (name) => {
  const file = path.join(media, name);
  const st = fs.statSync(file);
  return { file, name, size: st.size, mtimeMs: st.mtimeMs };
};

test('a 2:1 file with no layout word gets ONE eye: a square preview', { skip }, async () => {
  const out = await thumbs.get(info('vr_sbs.mp4'));
  const { width, height } = jpegSize(fs.readFileSync(out));
  assert.deepEqual([width, height], [360, 360]);
});

test('a 16:9 file is not cropped', { skip }, async () => {
  const out = await thumbs.get(info('flat.mp4'));
  const { width, height } = jpegSize(fs.readFileSync(out));
  assert.equal(width, 360);
  assert.ok(height >= 200 && height <= 204, `height ${height}`);
});

test('a video shorter than 5 s still gets a preview (it falls back to the start)', { skip }, async () => {
  const out = await thumbs.get(info('short.mp4'));
  assert.ok(fs.statSync(out).size > 500);
});

test('a second request does not run ffmpeg again; two at once share one run', { skip }, async () => {
  const before = thumbs.spawned;
  const a = await thumbs.get(info('flat.mp4'));
  assert.equal(thumbs.spawned, before, 'cached on disk');
  fs.rmSync(a);
  const [x, y] = await Promise.all([thumbs.get(info('flat.mp4')), thumbs.get(info('flat.mp4'))]);
  assert.equal(x, y);
  assert.equal(thumbs.spawned, before + 1, 'one run for two requests');
});

test('a broken file gives null, and is not retried at once', { skip }, async () => {
  assert.equal(await thumbs.get(info('broken.mp4')), null);
  const after = thumbs.spawned;
  assert.equal(await thumbs.get(info('broken.mp4')), null);
  assert.equal(thumbs.spawned, after, 'the failure is remembered');
});

test('a changed file gets a new preview (the name depends on size and change time)', { skip }, async () => {
  const a = await thumbs.get(info('short.mp4'));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(media, 'short.mp4'), later, later);
  const b = await thumbs.get(info('short.mp4'));
  assert.notEqual(a, b);
});

test('warmUp makes previews for the whole library and counts them', { skip }, async () => {
  const fresh = new Thumbnailer({ ffmpeg, dir: path.join(base, 'thumbs2') });
  const result = await warmUp(media, fresh);
  assert.deepEqual(result, { made: 3, total: 4 }); // three real videos, one broken
});

test('the queue never runs more ffmpeg jobs at once than the limit', { skip }, async () => {
  const limited = new Thumbnailer({ ffmpeg, dir: path.join(base, 'thumbs3'), concurrency: 1 });
  let most = 0;
  const watch = setInterval(() => { most = Math.max(most, limited.running); }, 5);
  await Promise.all(['vr_sbs.mp4', 'flat.mp4', 'short.mp4'].map((n) => limited.get(info(n))));
  clearInterval(watch);
  assert.equal(most, 1);
});
