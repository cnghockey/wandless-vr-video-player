import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LayoutProbe, readVideoInfo, SAMPLE_W, SAMPLE_H } from '../lib/layout.js';
import { classifyFrames, findBackground, backgroundKeep, colourName, readFrames } from '../public/core.js';
import { findFfmpeg } from '../lib/thumbs.js';
import { makeFisheye, makeFullFrame, makeFilled } from './synthetic-video.js';

// A hand-made sample frame. corner(x, y) and inside(x, y) give the RGB of the corners and of the circles.
function frame({ corner = () => [0, 0, 0], inside = () => [60, 120, 200] } = {}) {
  const rgb = new Uint8Array(SAMPLE_W * SAMPLE_H * 3);
  for (let y = 0; y < SAMPLE_H; y++) {
    for (let x = 0; x < SAMPLE_W; x++) {
      const cx = x < SAMPLE_W / 2 ? SAMPLE_W / 4 : (3 * SAMPLE_W) / 4;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - SAMPLE_H / 2) / (SAMPLE_H / 2);
      rgb.set(d > 1 ? corner(x, y) : inside(x, y), (y * SAMPLE_W + x) * 3);
    }
  }
  return rgb;
}
const redSpots = (x, y) => (x % 8 === 0 && y % 4 === 0 ? [230, 10, 10] : [0, 0, 0]); // about 3 % of the corners

test('classifyFrames: black corners round lit circles = fisheye; mask red in the corners = packed mask', () => {
  assert.deepEqual(classifyFrames([frame(), frame(), frame()]), { fisheye: true, alpha: false });
  assert.deepEqual(classifyFrames([frame(), frame({ corner: redSpots }), frame()]), { fisheye: true, alpha: true });
});

test('classifyFrames: a full frame, a red wall, one dark frame or an all-dark video is not fisheye', () => {
  const lit = () => [140, 110, 90];
  assert.deepEqual(classifyFrames([frame({ corner: lit }), frame({ corner: lit }), frame({ corner: lit })]), { fisheye: false, alpha: false });
  const wall = (x) => (x % 3 ? [200, 30, 30] : [120, 120, 120]); // a red wall, with something else in it
  assert.deepEqual(classifyFrames([frame({ corner: wall }), frame({ corner: wall }), frame({ corner: wall })]), { fisheye: false, alpha: false });
  const dark = frame({ inside: () => [5, 5, 5] }); // a black frame: black corners too, but it proves nothing alone
  assert.deepEqual(classifyFrames([dark, frame({ corner: lit }), frame({ corner: lit })]), { fisheye: false, alpha: false });
  assert.deepEqual(classifyFrames([dark, dark, dark]), { fisheye: false, alpha: false });
  assert.deepEqual(classifyFrames([]), { fisheye: false, alpha: false });
});

// A hand-made side-by-side frame with a filled background: `fill(x, y)` gives the background's RGB, and a skin-coloured
// "person" stands in the lower middle of each eye (as in the real files: the band above and beside it stays clear).
function filled(fill) {
  const rgb = new Uint8Array(SAMPLE_W * SAMPLE_H * 3);
  for (let y = 0; y < SAMPLE_H; y++) {
    for (let x = 0; x < SAMPLE_W; x++) {
      const ex = x % (SAMPLE_W / 2);
      const person = ex > 22 && ex < 42 && y > 24;
      rgb.set(person ? [200, 150, 130] : fill(x, y), (y * SAMPLE_W + x) * 3);
    }
  }
  return rgb;
}
const even = (c) => () => c;
const noisy = (c, amount, seed = 1) => (x, y) => c.map((v, k) => Math.max(0, Math.min(255, v + Math.round(Math.sin((x * 7 + y * 13 + k * 5) * seed) * amount))));
const five = (make) => [1, 2, 3, 4, 5].map(make);

test('findBackground: the measured fills are found (green, violet, a grey-black, true black) with a cut just above their noise', () => {
  const green = findBackground(five(() => filled(even([2, 250, 74]))));
  assert.equal(green.kind, 'colour');
  assert.deepEqual(green.rgb, [2, 250, 74]);
  assert.equal(green.edge, 0.05, 'an even fill: the smallest cut');
  const violet = findBackground(five(() => filled(noisy([154, 47, 250], 3))));
  assert.equal(violet.kind, 'colour');
  assert.ok(violet.rgb.every((v, k) => Math.abs(v - [154, 47, 250][k]) <= 2), String(violet.rgb));
  const grey = findBackground(five((i) => filled(noisy(i % 2 ? [31, 32, 34] : [18, 18, 19], i % 2 ? 12 : 6, i))));
  assert.equal(grey.kind, 'black');
  assert.ok(grey.edge > 0.08 && grey.edge < 0.15, `the evenest frame sets the cut: ${grey.edge}`);
  const black = findBackground(five(() => filled(even([0, 0, 0]))));
  assert.deepEqual(black, { kind: 'black', rgb: [0, 0, 0], edge: 0.01 });
});

test('findBackground: no cut for a textured wall, a dark room, an even grey wall, a fill in only 2 of 5 frames, or no frames', () => {
  assert.equal(findBackground(five((i) => filled(noisy([40, 160, 60], 14, i)))), null, 'a green wall with texture (spread over 6)');
  assert.equal(findBackground(five((i) => filled(noisy([20, 18, 16], 30, i)))), null, 'a dark room: one dark colour fills 60 % of the band in 1 frame of 5');
  assert.equal(findBackground(five(() => filled(even([200, 196, 190])))), null, 'an even wall, not a saturated colour');
  assert.equal(findBackground(five(() => filled(even([30, 60, 80])))), null, 'an even but dull blue');
  const some = [1, 2, 3, 4, 5].map((i) => (i <= 2 ? filled(even([2, 250, 74])) : filled(noisy([90, 70, 60], 25, i))));
  assert.equal(findBackground(some), null, 'filled in 2 of 5 frames only');
  const part = (x, y) => (y < 13 && x % 32 < 30 ? [2, 250, 74] : noisy([90, 70, 60], 25)(x, y)); // green on 56 % of the band
  assert.equal(findBackground(five(() => filled(part))), null, 'an even green on less than 60 % of the band');
  assert.equal(findBackground([]), null);
});

test('backgroundKeep: the fill is cut, the person stays, the edge between is soft; black cuts only the dark', () => {
  const green = { kind: 'colour', rgb: [2, 250, 74], edge: 0.05 };
  assert.equal(backgroundKeep([2, 250, 74], green), 0);
  assert.equal(backgroundKeep([200, 150, 130], green), 1);
  const edge = backgroundKeep([52, 225, 88], green); // a pixel at the person's edge: a quarter person, three quarters green
  assert.ok(edge > 0.3 && edge < 0.9, String(edge));
  const violet = { kind: 'colour', rgb: [154, 47, 250], edge: 0.05 };
  assert.equal(backgroundKeep([154, 47, 250], violet), 0);
  assert.equal(backgroundKeep([200, 150, 130], violet), 1, 'skin is at 0.36 from this violet: far past the cut');
  const black = { kind: 'black', rgb: [18, 18, 19], edge: 0.13 };
  assert.equal(backgroundKeep([18, 18, 19], black), 0);
  assert.equal(backgroundKeep([200, 150, 130], black), 1);
});

test('colourName: what the page calls a background', () => {
  assert.equal(colourName([2, 250, 74]), 'green');
  assert.equal(colourName([154, 47, 250]), 'violet');
  assert.equal(colourName([20, 60, 240]), 'blue');
  assert.equal(colourName([18, 18, 19]), 'black');
  assert.equal(colourName([240, 30, 200]), 'pink');
});

test('classifyFrames: black corners round a person in the middle, black up to the circle edge, is a filled background, not fisheye', () => {
  const person = (x, y) => {
    const cx = x < SAMPLE_W / 2 ? SAMPLE_W / 4 : (3 * SAMPLE_W) / 4;
    return Math.hypot(x + 0.5 - cx, y + 0.5 - SAMPLE_H / 2) < SAMPLE_H * 0.3 ? [200, 150, 130] : [0, 0, 0];
  };
  const frames = five(() => frame({ inside: person }));
  assert.deepEqual(classifyFrames(frames), { fisheye: false, alpha: false });
  assert.equal(readFrames(frames).background.kind, 'black');
});

test('readFrames: a fisheye video keeps its mask, and its black corners are never a black background', () => {
  // As in the real files: the lens circle ends a little inside the eye's square (here at 94 %), so black fills most
  // of the band. The background check alone would call it a black background; readFrames does not ask it.
  const lens = (x, y) => {
    const cx = x < SAMPLE_W / 2 ? SAMPLE_W / 4 : (3 * SAMPLE_W) / 4;
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - SAMPLE_H / 2) / (SAMPLE_H / 2);
    return d > 0.94 ? [0, 0, 0] : [40 + ((x * 37 + y * 91) % 150), 60 + ((x * 53 + y * 17) % 120), 80 + ((x * 29 + y * 71) % 100)];
  };
  const frames = five(() => frame({ corner: () => [0, 0, 0], inside: lens }));
  assert.equal(findBackground(frames).kind, 'black', 'the trap: the corners alone look like a filled black background');
  assert.deepEqual(readFrames(frames), { fisheye: true, alpha: false, background: null });
  assert.equal(readFrames(five(() => filled(even([2, 250, 74])))).background.kind, 'colour');
});

const ffmpeg = findFfmpeg();
let dir;

before(() => {
  if (!ffmpeg) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-layout-'));
  makeFisheye(ffmpeg, path.join(dir, 'packed.mp4'), { mask: 'big' });
  makeFisheye(ffmpeg, path.join(dir, 'plain.mp4'));
  makeFullFrame(ffmpeg, path.join(dir, 'full.mp4'));
  makeFilled(ffmpeg, path.join(dir, 'green.mp4'), { colour: '0x02FA4A' });
  makeFilled(ffmpeg, path.join(dir, 'violet.mp4'), { colour: '0x9A2FFA' });
  makeFilled(ffmpeg, path.join(dir, 'black.mp4'), { colour: '0x101010' });
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15:d=1', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', path.join(dir, 'flat16x9.mp4')], { windowsHide: true });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const facts = (file) => {
  const st = fs.statSync(file);
  return { file, size: st.size, mtimeMs: st.mtimeMs };
};

test('readVideoInfo reads the length and frame size from ffmpeg', { skip: !ffmpeg && 'ffmpeg not found' }, async () => {
  const info = await readVideoInfo(ffmpeg, path.join(dir, 'packed.mp4'));
  assert.equal(info.width, 640);
  assert.equal(info.height, 320);
  assert.ok(info.duration > 0.9 && info.duration < 1.2, String(info.duration));
});

test('LayoutProbe with real ffmpeg: packed mask, plain fisheye, full frame and 16:9 are told apart', { skip: !ffmpeg && 'ffmpeg not found' }, async () => {
  const probe = new LayoutProbe({ ffmpeg });
  assert.deepEqual(await probe.get(facts(path.join(dir, 'packed.mp4'))), { fisheye: true, alpha: true, background: null });
  assert.deepEqual(await probe.get(facts(path.join(dir, 'plain.mp4'))), { fisheye: true, alpha: false, background: null });
  assert.deepEqual(await probe.get(facts(path.join(dir, 'full.mp4'))), { fisheye: false, alpha: false, background: null });
  assert.deepEqual(await probe.get(facts(path.join(dir, 'flat16x9.mp4'))), { fisheye: false, alpha: false, background: null });
});

test('LayoutProbe with real ffmpeg: green, violet and black filled backgrounds are found, with their colour', { skip: !ffmpeg && 'ffmpeg not found' }, async () => {
  const probe = new LayoutProbe({ ffmpeg });
  for (const [name, kind, rgb] of [['green.mp4', 'colour', [2, 250, 74]], ['violet.mp4', 'colour', [154, 47, 250]], ['black.mp4', 'black', [16, 16, 16]]]) {
    const r = await probe.get(facts(path.join(dir, name)));
    assert.equal(r.fisheye, false, name);
    assert.equal(r.background && r.background.kind, kind, `${name}: ${JSON.stringify(r)}`);
    assert.ok(r.background.rgb.every((v, k) => Math.abs(v - rgb[k]) <= 8), `${name}: ${r.background.rgb} (the video coding moves a colour a little)`);
  }
});

test('LayoutProbe: an answer cached before the background check counts as not known', { skip: !ffmpeg && 'ffmpeg not found' }, async () => {
  const cacheFile = path.join(dir, 'old-layouts.json');
  const f = facts(path.join(dir, 'green.mp4'));
  const oldKey = crypto.createHash('sha256').update(`${f.file}|${f.size}|${f.mtimeMs}`).digest('hex').slice(0, 24);
  fs.writeFileSync(cacheFile, JSON.stringify({ [oldKey]: { fisheye: false, alpha: false } }));
  const probe = new LayoutProbe({ ffmpeg, cacheFile });
  assert.equal((await probe.get(f)).background.kind, 'colour');
  assert.equal(probe.probed, 1, 'looked at again');
});

test('LayoutProbe looks at each file once, also across a restart (the cache file)', { skip: !ffmpeg && 'ffmpeg not found' }, async () => {
  const cacheFile = path.join(dir, 'layouts.json');
  const first = new LayoutProbe({ ffmpeg, cacheFile });
  const f = facts(path.join(dir, 'packed.mp4'));
  const [a, b] = await Promise.all([first.get(f), first.get(f)]); // two asks at once
  assert.deepEqual(a, b);
  await first.get(f);
  assert.equal(first.probed, 1, 'looked at once');
  await new Promise((r) => setTimeout(r, 200)); // the cache file is written in the background
  const second = new LayoutProbe({ ffmpeg, cacheFile });
  assert.deepEqual(await second.get(f), { fisheye: true, alpha: true, background: null });
  assert.equal(second.probed, 0, 'the restarted probe used the cache file');
  assert.deepEqual(await second.get({ ...f, mtimeMs: f.mtimeMs + 1000 }), { fisheye: true, alpha: true, background: null });
  assert.equal(second.probed, 1, 'a changed file is looked at again');
});
