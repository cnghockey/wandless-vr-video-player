import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import {
  guessLayout, flatAspect, eyeRegion, flatUv, hemisphere, clampZoom, ZOOM_MIN, ZOOM_MAX,
  GestureTracker, remoteGrab, PokeDetector, panelLayout, PANEL_W, PANEL_H, LIST_SLOTS, SPEED_PRESETS, buttonAt,
  seekFraction, formatTime, STEREOS, describeInputs, aimAngles, dragAngles,
  inGestureZone, LOW_VIEW_ANGLE, SwipeDetector, SKIP_SECONDS, DoublePinch, pinchedPanelStays, PANEL_LOOK_AWAY, PANEL_GRACE_MS,
  PANEL_IDLE_MS, placeInView, listFolder, parentDir, fisheye, packedAlphaAt, FISHEYE_FOV, PROJECTIONS, HandsTogether,
  PRAYER_LOW_ANGLE, awayStep, isAway, AwayGuard, AWAY_END_MS,
} from '../public/core.js';

const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} is not near ${b}`);

test('guessLayout reads the file name', () => {
  assert.deepEqual(guessLayout('scene_180_LR.mp4'), { projection: 'vr180', stereo: 'sbs' });
  assert.deepEqual(guessLayout('scene_180x180_3dh.mp4'), { projection: 'vr180', stereo: 'sbs' });
  assert.deepEqual(guessLayout('scene_VR180_TB.mp4'), { projection: 'vr180', stereo: 'tb' });
  assert.deepEqual(guessLayout('scene_180_3dv.mp4'), { projection: 'vr180', stereo: 'tb' });
  assert.deepEqual(guessLayout('movie.mp4'), { projection: 'flat', stereo: 'mono' });
  assert.deepEqual(guessLayout('movie.HSBS.mkv'), { projection: 'flat', stereo: 'sbs' });
  assert.deepEqual(guessLayout('movie_OU.mp4'), { projection: 'flat', stereo: 'tb' });
});

test('guessLayout does not match words that only contain a token', () => {
  assert.deepEqual(guessLayout('Outlander_S01E01.mp4'), { projection: 'flat', stereo: 'mono' });
  assert.deepEqual(guessLayout('Blair_Witch.mp4'), { projection: 'flat', stereo: 'mono' });
  assert.deepEqual(guessLayout('1800_miles.mp4'), { projection: 'flat', stereo: 'mono' });
});

test('guessLayout uses the frame size for a VR180 file with no layout token', () => {
  assert.equal(guessLayout('a_180.mp4', 5760, 2880).stereo, 'sbs');
  assert.equal(guessLayout('a_180.mp4', 2880, 5760).stereo, 'tb');
  assert.equal(guessLayout('a_180.mp4', 3840, 3840).stereo, 'mono');
  assert.equal(guessLayout('a_180.mp4').stereo, 'mono');
  // A flat file is never guessed 3D from its size.
  assert.equal(guessLayout('wide.mp4', 3840, 1080).stereo, 'mono');
});

test('guessLayout: a 2:1 frame with no layout word is VR180 side by side; other shapes stay flat', () => {
  assert.deepEqual(guessLayout('clip.mp4', 4320, 2160), { projection: 'vr180', stereo: 'sbs' });
  assert.deepEqual(guessLayout('clip.mp4', 5760, 2880), { projection: 'vr180', stereo: 'sbs' });
  assert.deepEqual(guessLayout('clip.mp4', 2880, 1440), { projection: 'vr180', stereo: 'sbs' });
  assert.deepEqual(guessLayout('clip.mp4', 3840, 2160), { projection: 'flat', stereo: 'mono' }); // 16:9 4K
  assert.deepEqual(guessLayout('clip.mp4', 1920, 1080), { projection: 'flat', stereo: 'mono' });
  assert.deepEqual(guessLayout('clip.mp4', 3840, 1080), { projection: 'flat', stereo: 'mono' }); // ultra wide
  assert.deepEqual(guessLayout('clip.mp4', 2200, 1000), { projection: 'flat', stereo: 'mono' }); // 2.2:1, outside the band
  assert.deepEqual(guessLayout('clip.mp4'), { projection: 'flat', stereo: 'mono' }); // size not known yet
  // A layout word in the name beats the size.
  assert.deepEqual(guessLayout('clip_TB.mp4', 4320, 2160), { projection: 'flat', stereo: 'tb' });
  assert.deepEqual(guessLayout('clip_SBS.mp4', 4320, 2160), { projection: 'flat', stereo: 'sbs' });
});

test('guessLayout: fisheye lens names give the fisheye projection and the lens angle; "alpha" means a packed mask', () => {
  assert.deepEqual(guessLayout('scene_FISHEYE190_LR.mp4'), { projection: 'fisheye', stereo: 'sbs', fov: 190, alpha: false });
  assert.deepEqual(guessLayout('scene_MKX200.mp4'), { projection: 'fisheye', stereo: 'sbs', fov: 200, alpha: false });
  assert.deepEqual(guessLayout('scene_VRCA220_LR.mp4'), { projection: 'fisheye', stereo: 'sbs', fov: 220, alpha: false });
  assert.deepEqual(guessLayout('scene_FISHEYE190_alpha.mp4'), { projection: 'fisheye', stereo: 'sbs', fov: 190, alpha: true });
  assert.deepEqual(guessLayout('scene_alpha.mp4'), { projection: 'fisheye', stereo: 'sbs', fov: FISHEYE_FOV, alpha: true }, 'DeoVR alpha files are fisheye');
  assert.deepEqual(guessLayout('Alphabet_180_LR.mp4'), { projection: 'vr180', stereo: 'sbs' }, 'a word that only starts with alpha');
  assert.deepEqual(guessLayout('Angel Pass.mp4', 4320, 2160), { projection: 'vr180', stereo: 'sbs' }, 'no lens word: only the picture can tell');
});

test('flatAspect undoes a squeezed half-width or half-height 3D picture', () => {
  near(flatAspect('mono', 1920, 1080), 16 / 9);
  near(flatAspect('sbs', 3840, 1080), 16 / 9); // full SBS
  near(flatAspect('sbs', 1920, 1080), 16 / 9); // half SBS
  near(flatAspect('tb', 1920, 2160), 16 / 9); // full TB
  near(flatAspect('tb', 1920, 1080), 16 / 9); // half TB
  near(flatAspect('mono', 0, 0), 16 / 9);
});

test('eyeRegion: left eye is the left half or the top half', () => {
  assert.deepEqual(eyeRegion('mono', 'left'), { u0: 0, v0: 0, du: 1, dv: 1 });
  assert.deepEqual(eyeRegion('sbs', 'left'), { u0: 0, v0: 0, du: 0.5, dv: 1 });
  assert.deepEqual(eyeRegion('sbs', 'right'), { u0: 0.5, v0: 0, du: 0.5, dv: 1 });
  assert.deepEqual(eyeRegion('tb', 'left'), { u0: 0, v0: 0.5, du: 1, dv: 0.5 });
  assert.deepEqual(eyeRegion('tb', 'right'), { u0: 0, v0: 0, du: 1, dv: 0.5 });
});

test('flatUv follows the PlaneGeometry corner order', () => {
  assert.deepEqual([...flatUv({ u0: 0.5, v0: 0, du: 0.5, dv: 1 })], [0.5, 1, 1, 1, 0.5, 0, 1, 0]);
});

test('clampZoom keeps zoom in range', () => {
  assert.equal(clampZoom(0.01), ZOOM_MIN);
  assert.equal(clampZoom(99), ZOOM_MAX);
  assert.equal(clampZoom(1.7), 1.7);
});

const NX = 48;
const NY = 32;
const at = (arr, stride, i, j) => (j * (NX + 1) + i) * stride;

test('hemisphere at zoom 1: centre looks straight ahead, edges sit at 90 degrees', () => {
  const g = hemisphere({ zoom: 1, region: eyeRegion('mono', 'left') });
  const c = at(g.position, 3, NX / 2, NY / 2);
  near(g.position[c], 0);
  near(g.position[c + 1], 0);
  near(g.position[c + 2], -50);
  const left = at(g.position, 3, 0, NY / 2);
  near(g.position[left], -50);
  near(g.position[left + 2], 0);
  const cu = at(g.uv, 2, NX / 2, NY / 2);
  near(g.uv[cu], 0.5);
  near(g.uv[cu + 1], 0.5);
  near(g.uv[at(g.uv, 2, 0, 0)], 0);
  near(g.uv[at(g.uv, 2, NX, NY) + 1], 1);
});

test('hemisphere keeps every UV inside the eye region and every index in range', () => {
  for (const stereo of STEREOS) {
    for (const eye of ['left', 'right']) {
      const r = eyeRegion(stereo, eye);
      for (const zoom of [0.5, 1, 2.5, 4]) {
        const g = hemisphere({ zoom, region: r });
        const count = (NX + 1) * (NY + 1);
        assert.equal(g.position.length, count * 3);
        assert.ok(g.position.every(Number.isFinite));
        assert.ok(g.index.every((i) => i < count));
        for (let k = 0; k < g.uv.length; k += 2) {
          assert.ok(g.uv[k] >= r.u0 - 1e-6 && g.uv[k] <= r.u0 + r.du + 1e-6, `${stereo} ${eye} ${zoom} u`);
          assert.ok(g.uv[k + 1] >= r.v0 - 1e-6 && g.uv[k + 1] <= r.v0 + r.dv + 1e-6, `${stereo} ${eye} ${zoom} v`);
        }
      }
    }
  }
});

test('hemisphere zoom in: the picture is magnified by exactly the zoom factor', () => {
  const r = eyeRegion('mono', 'left');
  const g = hemisphere({ zoom: 2, region: r });
  // The mesh stays a half-sphere: the left edge is still at x = -50.
  near(g.position[at(g.position, 3, 0, NY / 2)], -50);
  // World yaw 45 degrees (mu 0.75) shows picture yaw 22.5 degrees (u 0.625).
  const k = at(g.uv, 2, (NX * 3) / 4, NY / 2);
  near(g.uv[k], 0.625);
  const pos = at(g.position, 3, (NX * 3) / 4, NY / 2);
  near(Math.atan2(g.position[pos], -g.position[pos + 2]), Math.PI / 4);
});

test('hemisphere zoom out: the whole picture shrinks to a smaller patch', () => {
  const g = hemisphere({ zoom: 0.5, region: eyeRegion('mono', 'left') });
  near(g.position[at(g.position, 3, 0, NY / 2)], -50 * Math.sin(Math.PI / 4));
  near(g.uv[at(g.uv, 2, 0, 0)], 0); // the picture corner is still the mesh corner
  near(g.uv[at(g.uv, 2, NX, NY)], 1);
});

// The texture point that a fisheye vertex shows, back to its direction: for the centre ring and the outer ring.
const FR = 36;
const FS = 72;
const fAt = (i, j) => (i * (FS + 1) + j);

test('fisheye at zoom 1: straight ahead shows the circle centre; 95 degrees off shows the circle edge', () => {
  const g = fisheye({ zoom: 1, region: eyeRegion('mono', 'left') });
  near(g.position[2], -50);
  near(g.uv[0], 0.5);
  near(g.uv[1], 0.5);
  const right = fAt(FR, 0); // outer ring, to the right
  const angle = Math.acos(-g.position[right * 3 + 2] / 50);
  near(angle, (FISHEYE_FOV / 2) * (Math.PI / 180));
  assert.ok(g.position[right * 3] > 0, 'the right of the picture is to your right');
  near(g.uv[right * 2], 1);
  near(g.uv[right * 2 + 1], 0.5);
  const up = fAt(FR, FS / 4); // outer ring, up
  assert.ok(g.position[up * 3 + 1] > 49, 'up is up');
  near(g.uv[up * 2], 0.5);
  near(g.uv[up * 2 + 1], 1, 1e-4); // v = 1 is the top of the picture
  const half = fAt(FR / 2, 0); // halfway out: half the angle, half the radius (equidistant lens)
  near(Math.acos(-g.position[half * 3 + 2] / 50), (FISHEYE_FOV / 4) * (Math.PI / 180));
  near(g.uv[half * 2], 0.75);
});

test('fisheye keeps UVs in the eye region; zoom in magnifies the centre, zoom out shrinks the cap', () => {
  for (const stereo of STEREOS) {
    for (const eye of ['left', 'right']) {
      const r = eyeRegion(stereo, eye);
      for (const zoom of [0.5, 1, 2, 4]) {
        const g = fisheye({ zoom, region: r, fov: 200 });
        assert.ok(g.index.every((i) => i < (FR + 1) * (FS + 1)));
        for (let k = 0; k < g.uv.length; k += 2) {
          assert.ok(g.uv[k] >= r.u0 - 1e-6 && g.uv[k] <= r.u0 + r.du + 1e-6, `${stereo} ${eye} ${zoom} u`);
          assert.ok(g.uv[k + 1] >= r.v0 - 1e-6 && g.uv[k + 1] <= r.v0 + r.dv + 1e-6, `${stereo} ${eye} ${zoom} v`);
        }
      }
    }
  }
  const z2 = fisheye({ zoom: 2, region: eyeRegion('mono', 'left') });
  const edge = fAt(FR, 0);
  near(Math.acos(-z2.position[edge * 3 + 2] / 50), (95 * Math.PI) / 180); // the cap stays whole...
  near(z2.uv[edge * 2], 0.75); // ...and shows only the inner half of the circle
  const z05 = fisheye({ zoom: 0.5, region: eyeRegion('mono', 'left') });
  near(Math.acos(-z05.position[edge * 3 + 2] / 50), (47.5 * Math.PI) / 180); // a smaller cap...
  near(z05.uv[edge * 2], 1); // ...with the whole circle on it
});

// The packing that two open-source DeoVR passthrough tools write (VRAutoMatte, vr2ar-converter-v3), in pixels:
// the mask at 40 %, cut into six pieces, each laid at its own place in the frame.
function packedPixel(eye, u, v, W = 4320, H = 2160) {
  const wOut = Math.floor((W * 4) / 10);
  const hOut = Math.floor((H * 4) / 10);
  const hw = Math.floor(wOut / 2);
  const hh = Math.floor(hOut / 2);
  const qw = Math.floor(wOut / 4);
  const xCtr = Math.floor(W / 2) - Math.floor(hw / 2);
  const yBot = H - hh;
  const xFar = W - qw;
  const mx = (eye === 'left' ? 0 : hw) + u * hw; // where the point is in the 40 % mask
  const my = v * hOut;
  const pieces = [ // [crop x, crop y, crop w, crop h, place x, place y]
    [0, 0, hw, hh, xCtr, yBot], [0, hh, hw, hh, xCtr, 0], [hw, 0, qw, hh, xFar, yBot],
    [wOut - qw, 0, qw, hh, 0, yBot], [hw, hh, qw, hh, xFar, 0], [wOut - qw, hh, qw, hh, 0, 0],
  ];
  const [cx, cy, , , px, py] = pieces.find(([x, y, w, h]) => mx >= x && mx < x + w && my >= y && my < y + h);
  return { x: px + (mx - cx), y: py + (my - cy) };
}

test('packedAlphaAt finds each eye\'s mask where the DeoVR packing tools put it, in all six pieces', () => {
  const points = [];
  for (const eye of ['left', 'right']) {
    for (const u of [0.05, 0.3, 0.49, 0.51, 0.7, 0.95]) for (const v of [0.05, 0.3, 0.49, 0.51, 0.7, 0.95]) points.push([eye, u, v]);
  }
  for (const [eye, u, v] of points) {
    const want = packedPixel(eye, u, v);
    const got = packedAlphaAt(eye, u, v);
    assert.ok(Math.abs(got.U * 4320 - want.x) < 1 && Math.abs(got.V * 2160 - want.y) < 1,
      `${eye} (${u}, ${v}): got ${(got.U * 4320).toFixed(1)},${(got.V * 2160).toFixed(1)} want ${want.x.toFixed(1)},${want.y.toFixed(1)}`);
  }
  for (const [eye, u, v] of points) {
    const { U, V } = packedAlphaAt(eye, u, v);
    assert.ok(U >= 0 && U <= 1 && V >= 0 && V <= 1, 'always inside the frame');
  }
});

test('the View page offers every projection and every 3D layout as its own button', () => {
  assert.deepEqual(PROJECTIONS, ['vr180', 'fisheye', 'flat']);
  const ids = panelLayout('view').buttons.map((b) => b.id);
  for (const id of [...PROJECTIONS.map((p) => `proj:${p}`), ...STEREOS.map((s) => `stereo:${s}`)]) assert.ok(ids.includes(id), id);
});

const hand = (x, y, z, gap = 0.01) => ({ thumb: [x - gap / 2, y, z], index: [x + gap / 2, y, z] });

test('GestureTracker: no hands means no event', () => {
  const t = new GestureTracker({ graceMs: 0, deadZone: 0 });
  assert.equal(t.update([null, null]), null);
  assert.equal(t.update([hand(0, 0, -0.4, 0.1), null]), null); // open hand
});

test('GestureTracker: one pinch is a grab measured from its start', () => {
  const t = new GestureTracker({ graceMs: 0, deadZone: 0 });
  const a = t.update([hand(0, 0, -0.4), null]);
  assert.equal(a.kind, 'grab');
  assert.equal(a.started, true);
  const b = t.update([hand(0.2, 0.1, -0.4), null]);
  assert.equal(b.started, false);
  assert.deepEqual(b.p0, a.p0);
  near(b.p[0], 0.2);
  assert.equal(t.update([hand(0.2, 0.1, -0.4, 0.1), null]), null); // opened
  assert.equal(t.update([hand(0.2, 0.1, -0.4), null]).started, true); // a new pinch is a new start
});

test('GestureTracker: a grab that changes hands restarts, so the object does not jump', () => {
  const t = new GestureTracker({ graceMs: 0, deadZone: 0 });
  t.update([hand(-0.3, 0, -0.4), null]);
  const b = t.update([null, hand(0.3, 0, -0.4)]); // left lets go, right pinches in the same frame
  assert.equal(b.kind, 'grab');
  assert.equal(b.started, true);
  near(b.p0[0], 0.3);
  near(b.p[0], 0.3);
});

test('GestureTracker: pinch has hysteresis', () => {
  const t = new GestureTracker({ graceMs: 0, deadZone: 0 });
  assert.equal(t.update([hand(0, 0, -0.4, 0.03), null]), null); // 3 cm: not yet a pinch
  assert.ok(t.update([hand(0, 0, -0.4, 0.01), null])); // 1 cm: pinch
  assert.ok(t.update([hand(0, 0, -0.4, 0.03), null])); // 3 cm: still held
  assert.equal(t.update([hand(0, 0, -0.4, 0.05), null]), null); // 5 cm: released
});

test('GestureTracker: two pinches give a spread ratio; the hand left pinching after them does nothing', () => {
  const t = new GestureTracker({ graceMs: 0, deadZone: 0 });
  const a = t.update([hand(-0.15, 0, -0.4), hand(0.15, 0, -0.4)]);
  assert.equal(a.kind, 'scale');
  assert.equal(a.started, true);
  near(a.ratio, 1);
  const b = t.update([hand(-0.3, 0, -0.4), hand(0.3, 0, -0.4)]);
  assert.equal(b.started, false);
  near(b.ratio, 2);
  const c = t.update([hand(-0.075, 0, -0.4), hand(0.075, 0, -0.4)]);
  near(c.ratio, 0.5);
  assert.equal(t.update([hand(-0.075, 0, -0.4), null]), null); // right hand lets go: the left one is blocked
  assert.equal(t.update([hand(-0.4, 0.1, -0.4), null]), null); // and moving it moves nothing
  assert.equal(t.update([hand(-0.4, 0.1, -0.4, 0.1), null]), null); // it lets go
  assert.equal(t.update([hand(-0.4, 0.1, -0.4), null]).started, true); // a fresh pinch counts again
});

test('GestureTracker: hands that start almost touching do not give a huge ratio', () => {
  const t = new GestureTracker({ graceMs: 0, deadZone: 0 });
  t.update([hand(-0.005, 0, -0.4), hand(0.005, 0, -0.4)]);
  const b = t.update([hand(-0.15, 0, -0.4), hand(0.15, 0, -0.4)]);
  near(b.ratio, 0.3 / 0.05);
});

test('remoteGrab: no hand move leaves the object alone', () => {
  const head = new Vector3(0, 0, 0);
  const out = remoteGrab(head, new Vector3(0, 0, -0.5), new Vector3(0, 0, -0.5), new Vector3(0, 0, -4));
  near(out.x, 0);
  near(out.z, -4);
});

test('remoteGrab: a quarter turn of the hand turns the object a quarter turn round the head', () => {
  const head = new Vector3(0, 0, 0);
  const out = remoteGrab(head, new Vector3(0, 0, -0.5), new Vector3(0.5, 0, 0), new Vector3(0, 0, -4));
  near(out.x, 4);
  near(out.z, 0);
});

test('remoteGrab: pushing the hand out pushes the object out, and the distance is clamped', () => {
  const head = new Vector3(0, 1, 0);
  const out = remoteGrab(head, new Vector3(0, 1, -0.5), new Vector3(0, 1, -1), new Vector3(0, 1, -4));
  near(out.z, -8);
  const far = remoteGrab(head, new Vector3(0, 1, -0.2), new Vector3(0, 1, -0.8), new Vector3(0, 1, -30));
  near(far.z, -40);
  const close = remoteGrab(head, new Vector3(0, 1, -0.8), new Vector3(0, 1, -0.1), new Vector3(0, 1, -3));
  near(close.z, -0.8);
});

test('PokeDetector fires once per push, never from behind or from the side', () => {
  const p = new PokeDetector();
  assert.equal(p.update(0.1, true), false);
  assert.equal(p.update(0.02, true), false);
  assert.equal(p.update(0.005, true), true);
  assert.equal(p.update(0.004, true), false); // held: no repeat
  assert.equal(p.update(0.1, true), false); // pull back: re-arm
  assert.equal(p.update(0.005, true), true);

  const behind = new PokeDetector();
  assert.equal(behind.update(-0.05, true), false);
  assert.equal(behind.update(0.005, true), false);

  const side = new PokeDetector();
  side.update(0.1, true);
  assert.equal(side.update(0.01, false), false); // slides in near the plane, outside the panel
  assert.equal(side.update(0.01, true), false); // then crosses onto a button: no fire
});

// Every page of the menu, with each number of choices and extra buttons it can have.
const PAGES = [
  ...[['view'], ['subs', 'view'], ['subs', 'audio', 'view'], ['view', 'reset', 'pass']].map((extras) => ['main', { extras }]),
  ['view', {}],
  ...[0, 1, 5, 6, 7, 13].flatMap((count) => [0, 6, 12].filter((start) => start < Math.max(count, 1))
    .flatMap((start) => ['subs', 'audio'].map((page) => [page, { count, start }]))),
];

test('on every menu page, the buttons and the texts stay inside the panel and never overlap', () => {
  for (const [page, opts] of PAGES) {
    const { buttons, texts } = panelLayout(page, opts);
    const boxes = [...buttons, ...texts];
    const where = `${page} ${JSON.stringify(opts)}`;
    for (const b of boxes) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= PANEL_W && b.y + b.h <= PANEL_H, `${where}: ${b.id}`);
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${where}: ${a.id} overlaps ${b.id}`);
      }
    }
    assert.equal(new Set(buttons.map((b) => b.id)).size, buttons.length, `${where}: one button per id`);
    for (const t of texts) assert.equal(buttonAt(buttons, t.x + t.w / 2, t.y + t.h / 2), null, `${where}: the ${t.id} text is not a button`);
  }
});

test('buttonAt and seekFraction', () => {
  const { buttons } = panelLayout('main');
  const play = buttons.find((b) => b.id === 'play');
  assert.equal(buttonAt(buttons, play.x + 5, play.y + 5).id, 'play');
  assert.equal(buttonAt(buttons, play.x + play.w + 7, play.y + 5), null); // the gap
  assert.equal(buttonAt(buttons, -5, -5), null);
  const bar = buttons.find((b) => b.id === 'seek');
  near(seekFraction(bar.x), 0);
  near(seekFraction(bar.x + bar.w / 2), 0.5);
  near(seekFraction(bar.x + bar.w), 1);
  near(seekFraction(bar.x + bar.w + 100), 1);
  near(seekFraction(bar.x - 50), 0);
});

test('every button is at least 52 px tall and 80 px wide, so a hand ray can hit it', () => {
  for (const [page, opts] of PAGES) {
    for (const b of panelLayout(page, opts).buttons) assert.ok(b.h >= 52 && b.w >= 80, `${page}: ${b.id} is ${b.w}x${b.h}`);
  }
});

test('the main page: the speed presets and the two speed steps; a list page shows six choices and pages through more', () => {
  const ids = panelLayout('main').buttons.map((b) => b.id);
  for (const s of SPEED_PRESETS) assert.ok(ids.includes(`speed:${s}`), `preset ${s}`);
  assert.ok(ids.includes('speed-down') && ids.includes('speed-up'));
  assert.ok(!ids.includes('speed:3'), 'no 3x preset: the + button reaches it');
  const items = (count, start) => panelLayout('subs', { count, start }).buttons.filter((b) => b.id.startsWith('item:')).map((b) => b.id);
  assert.deepEqual(items(4, 0), ['item:0', 'item:1', 'item:2', 'item:3']);
  assert.equal(items(20, 0).length, LIST_SLOTS);
  assert.deepEqual(items(8, 6), ['item:6', 'item:7']);
  const paging = (count) => panelLayout('audio', { count }).buttons.some((b) => b.id === 'next');
  assert.equal(paging(6), false, 'six choices fit: no page buttons');
  assert.equal(paging(7), true);
  const subsIds = panelLayout('subs', { count: 2 }).buttons.map((b) => b.id);
  assert.ok(subsIds.includes('earlier') && subsIds.includes('later'), 'the subtitle timing');
  assert.ok(!panelLayout('audio', { count: 2 }).buttons.some((b) => b.id === 'earlier'), 'no timing on the Audio page');
  const row = (extras) => panelLayout('main', { extras }).buttons.filter((b) => b.y === 208).map((b) => `${b.id}:${b.w}`);
  assert.deepEqual(row(['subs', 'audio', 'view']), ['subs:229', 'audio:229', 'view:229']);
  assert.deepEqual(row(['view', 'reset']), ['view:348', 'reset:348'], 'two buttons share the row');
});

test('describeInputs says whether hand tracking was granted and what input exists', () => {
  const hands = [{ hand: {}, targetRayMode: 'tracked-pointer' }, { hand: {}, targetRayMode: 'tracked-pointer' }];
  assert.equal(describeInputs(null), 'no VR session');
  assert.equal(describeInputs({ enabledFeatures: ['local', 'hand-tracking'], inputSources: hands }), 'hand-tracking ON | inputs: hand,hand');
  assert.equal(describeInputs({ enabledFeatures: ['local', 'layers'], inputSources: [] }), 'hand-tracking OFF | inputs: none');
  assert.equal(describeInputs({ enabledFeatures: ['local'], inputSources: [{ targetRayMode: 'tracked-pointer' }, { targetRayMode: 'gaze' }] }),
    'hand-tracking OFF | inputs: tracked-pointer,gaze');
  assert.equal(describeInputs({ inputSources: new Set([{ hand: {} }]) }), 'hand-tracking ? | inputs: hand'); // a browser with no enabledFeatures
  assert.equal(describeInputs({ enabledFeatures: ['hand-tracking'] }), 'hand-tracking ON | inputs: none');
});

test('aimAngles: forward is 0, right is positive yaw, up is positive pitch', () => {
  const head = { x: 0, y: 0, z: 0 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const f = aimAngles(head, [0, 0, -1]);
  near(f.yaw, 0);
  near(f.pitch, 0);
  near(aimAngles(head, [1, 0, 0]).yaw, Math.PI / 2);
  near(aimAngles(head, [-1, 0, 0]).yaw, -Math.PI / 2);
  near(aimAngles(head, [0, 1, -1]).pitch, Math.PI / 4);
  near(aimAngles(head, [0, -1, -1]).pitch, -Math.PI / 4);
  const moved = aimAngles({ x: 1, y: 2, z: 3 }, [1, 2, 2]); // one metre in front of a head that is not at the origin
  near(moved.yaw, 0);
  near(moved.pitch, 0);
  assert.deepEqual(aimAngles(head, [0, 0, 0]), { yaw: 0, pitch: 0 }); // the head itself: no NaN
});

test('dragAngles: the picture follows the hand, the short way round, with a pitch limit', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const d = dragAngles({ yaw: 0.5, pitch: 0 }, { yaw: 0, pitch: 0 }, { yaw: 0.2, pitch: 0.1 });
  near(d.yaw, 0.7);
  near(d.pitch, 0.1);
  const wrap = dragAngles({ yaw: 0, pitch: 0 }, { yaw: 3.1, pitch: 0 }, { yaw: -3.1, pitch: 0 });
  near(wrap.yaw, 2 * Math.PI - 6.2); // 0.083, not -6.2
  assert.equal(dragAngles({ yaw: 0, pitch: 0.7 }, { yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0.5 }).pitch, 0.8);
  assert.equal(dragAngles({ yaw: 0, pitch: -0.7 }, { yaw: 0, pitch: 0 }, { yaw: 0, pitch: -0.5 }).pitch, -0.8);
  const none = dragAngles({ yaw: 1, pitch: 0.2 }, { yaw: 0.3, pitch: 0.1 }, { yaw: 0.3, pitch: 0.1 });
  near(none.yaw, 1);
  near(none.pitch, 0.2);
});

test('GestureTracker: a one-hand pinch must last the grace time, then leave the dead zone, before it counts', () => {
  const t = new GestureTracker(); // defaults: 150 ms, 2 cm
  assert.equal(t.update([hand(0, 0, -0.4), null], 1000), null); // pinch begins
  assert.equal(t.update([hand(0.10, 0, -0.4), null], 1100), null); // 100 ms: still inside the grace time, even though it moved
  assert.equal(t.update([hand(0.10, 0, -0.4), null], 1160), null); // grace over: waiting for the dead zone, measured from here
  assert.equal(t.update([hand(0.11, 0, -0.4), null], 1180), null); // 1 cm: inside the dead zone
  const start = t.update([hand(0.13, 0, -0.4), null], 1200); // 3 cm: out
  assert.equal(start.kind, 'grab');
  assert.equal(start.started, true);
  near(start.p0[0], 0.13); // it starts from HERE: no jump
  near(start.p[0], 0.13);
  const next = t.update([hand(0.20, 0, -0.4), null], 1220);
  assert.equal(next.started, false);
  near(next.p0[0], 0.13);
  near(next.p[0], 0.20);
});

test('GestureTracker: a quick tap, or a small wiggle, never counts as a grab', () => {
  const tap = new GestureTracker();
  assert.equal(tap.update([hand(0, 0, -0.4), null], 1000), null);
  assert.equal(tap.update([hand(0.05, 0, -0.4), null], 1080), null);
  assert.equal(tap.update([hand(0.05, 0, -0.4, 0.1), null], 1120), null); // let go after 120 ms
  const wiggle = new GestureTracker();
  wiggle.update([hand(0, 0, -0.4), null], 0);
  for (let ms = 100; ms <= 3000; ms += 100) {
    const x = (ms / 100) % 2 ? 0.008 : -0.008; // 0.8 cm either side (1.6 cm end to end, inside the 2 cm dead zone), for 3 s
    assert.equal(wiggle.update([hand(x, 0, -0.4), null], ms), null, `at ${ms} ms`);
  }
});

test('GestureTracker: the first hand of a two-hand zoom does not nudge the picture while the second hand arrives', () => {
  const t = new GestureTracker();
  assert.equal(t.update([null, hand(0.2, 0, -0.4)], 1000), null); // right hand pinches first
  assert.equal(t.update([null, hand(0.3, 0, -0.4)], 1040), null); // and drifts 10 cm
  const zoom = t.update([hand(-0.2, 0, -0.4), hand(0.3, 0, -0.4)], 1080); // the left hand arrives 80 ms later
  assert.equal(zoom.kind, 'scale');
  assert.equal(zoom.started, true);
  near(zoom.ratio, 1);
});

test('GestureTracker: after a two-hand zoom, the hand still pinching moves nothing until it lets go', () => {
  const t = new GestureTracker();
  t.update([hand(-0.15, 0, -0.4), hand(0.15, 0, -0.4)], 1000);
  t.update([hand(-0.3, 0, -0.4), hand(0.3, 0, -0.4)], 1100);
  for (let ms = 1200; ms <= 2200; ms += 50) {
    assert.equal(t.update([null, hand(0.3 + (ms - 1200) / 5000, 0, -0.4)], ms), null, `at ${ms} ms`); // left let go, right keeps drifting
  }
  assert.equal(t.update([null, hand(0.3, 0, -0.4, 0.1)], 2300), null); // right lets go
  t.update([null, hand(0.3, 0, -0.4)], 2400); // a fresh pinch
  assert.equal(t.update([null, hand(0.3, 0, -0.4)], 2560), null); // past the grace time, dead zone starts here
  assert.equal(t.update([null, hand(0.35, 0, -0.4)], 2600).started, true);
});

// The head's view as unit vectors, looking `pitch` radians up (+) or down (-), facing -z, no roll.
const view = (pitch) => ({
  forward: { x: 0, y: Math.sin(pitch), z: -Math.cos(pitch) },
  up: { x: 0, y: Math.cos(pitch), z: Math.sin(pitch) },
});

test('inGestureZone: a hand you can see counts; the bottom quarter of the view, behind you and out of reach do not', () => {
  const head = { x: 0, y: 1.2, z: 0 };
  const ahead = view(0);
  assert.equal(inGestureZone([0.1, 1.15, -0.4], head, ahead), true, 'raised in front of the face');
  assert.equal(inGestureZone([0.25, 1.05, -0.45], head, ahead), true, 'a little low and to the side, 16 degrees down');
  assert.equal(inGestureZone([0, 0.9, -0.4], head, ahead), false, 'chest height: 37 degrees down, the bottom quarter of the view');
  assert.equal(inGestureZone([0.1, 0.5, -0.3], head, ahead), false, 'resting on the leg');
  assert.equal(inGestureZone([0, 1.1, 0.6], head, ahead), false, 'behind you');
  assert.equal(inGestureZone([0, 1.1, -1.2], head, ahead), false, 'out of reach');
  assert.ok(LOW_VIEW_ANGLE > 0.38 && LOW_VIEW_ANGLE < 0.5, 'about 25 degrees: the bottom quarter of the view');
});

test('inGestureZone follows the head: sitting back, looking down, turning, lying on the side', () => {
  const head = { x: 0, y: 1.2, z: 0 };
  // Sitting back and looking 30 degrees up: the lap is only 45 cm below the eyes (a world-height rule counted it),
  // but it is far below the line of sight.
  assert.equal(inGestureZone([0.1, 0.75, -0.35], head, view(0.52)), false, 'sitting back: a hand on the lap');
  assert.equal(inGestureZone([0, 1.34, -0.44], head, view(0.52)), true, 'sitting back: a hand raised into the view');
  assert.equal(inGestureZone([0, 0.75, -0.4], head, view(-0.785)), true, 'looking down at your hands: they count');
  const turned = { forward: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };
  assert.equal(inGestureZone([0.4, 1.15, 0], head, turned), true, 'after turning to face +x, a hand ahead of you');
  assert.equal(inGestureZone([-0.4, 1.15, 0], head, turned), false, 'after turning to face +x, a hand behind you');
  const lyingOnSide = { forward: { x: 0, y: 0, z: -1 }, up: { x: -1, y: 0, z: 0 } }; // the top of the head points to -x
  assert.equal(inGestureZone([-0.3, 1.2, -0.3], head, lyingOnSide), true, 'lying on the side: "up" in the view is -x');
  assert.equal(inGestureZone([0.3, 1.2, -0.3], head, lyingOnSide), false, 'lying on the side: +x is the bottom of the view');
});

test('DoublePinch: two quick pinches with one hand make a pair; the first one\'s info comes back', () => {
  const d = new DoublePinch();
  assert.equal(d.down(1000, { open: false }), null);
  d.up(1120);
  assert.deepEqual(d.down(1300, { open: true }), { open: false });
  d.up(1340);
  assert.equal(d.down(1400), null, 'a third quick pinch starts a new pair, it does not complete another');
});

test('DoublePinch: too slow, a long first pinch (a grab) and cancel() make no pair', () => {
  const slow = new DoublePinch();
  slow.down(0, { n: 1 });
  slow.up(100);
  assert.equal(slow.down(600, { n: 2 }), null, 'the second pinch 600 ms after the first');
  slow.up(700);
  assert.deepEqual(slow.down(900), { n: 2 }, 'but that late pinch can be the first of a new pair');
  const grab = new DoublePinch();
  grab.down(0);
  grab.up(400); // held 0.4 s: a grab, not a tap
  assert.equal(grab.down(440), null, 'the next pinch is soon enough, but the first one was held too long');
  const cancelled = new DoublePinch();
  cancelled.down(0);
  cancelled.up(100);
  cancelled.cancel();
  assert.equal(cancelled.down(200), null);
  const noRelease = new DoublePinch();
  noRelease.down(0);
  assert.equal(noRelease.down(200), null, 'a second start with no end between is not a pair');
});

test('pinchedPanelStays: looking away hides it, even with a hand on it; a hand on it beats the 8 s', () => {
  assert.equal(pinchedPanelStays({ angle: 0.2, idleMs: 60_000, busy: true }), true, 'a hand on it, you look at it');
  assert.equal(pinchedPanelStays({ angle: PANEL_LOOK_AWAY + 0.05, idleMs: 0, busy: true }), false, 'a hand near it, you looked away');
  assert.equal(pinchedPanelStays({ angle: 0.2, idleMs: 2000 }), true);
  assert.equal(pinchedPanelStays({ angle: PANEL_LOOK_AWAY + 0.05, idleMs: 2000 }), false, 'you looked away');
  assert.equal(pinchedPanelStays({ angle: 0.2, idleMs: PANEL_IDLE_MS + 1 }), false, 'nobody used it for 8 s');
});

test('pinchedPanelStays: looking away does not hide it for 1.5 s after it opened, or while or just after a pinch pressed it', () => {
  const away = { angle: PANEL_LOOK_AWAY + 0.3, idleMs: 0 };
  assert.equal(pinchedPanelStays({ ...away, sinceOpenMs: 100 }), true, 'it just opened: your head is still moving');
  assert.equal(pinchedPanelStays({ ...away, sinceOpenMs: PANEL_GRACE_MS }), false, 'the 1.5 s are over');
  assert.equal(pinchedPanelStays({ ...away, sincePressMs: 0 }), true, 'a pinch presses or scrubs it now');
  assert.equal(pinchedPanelStays({ ...away, sincePressMs: PANEL_GRACE_MS - 1 }), true, 'a pinch let go less than 1.5 s ago');
  assert.equal(pinchedPanelStays({ ...away, sincePressMs: PANEL_GRACE_MS }), false, 'a pinch let go 1.5 s ago');
  assert.equal(pinchedPanelStays({ ...away, busy: true, sinceOpenMs: 5000, sincePressMs: 5000 }), false, 'a hand near it is not a press');
  assert.equal(pinchedPanelStays({ angle: 0.2, idleMs: 9000, sinceOpenMs: 100, sincePressMs: 100 }), false, 'looking at it, nobody used it for 8 s: the grace is only for looking away');
});

test('placeInView: in front of you and a little lower, also when you sit back or look down', () => {
  const head = { x: 1, y: 1.2, z: 2 };
  const facing = { x: 0, z: -1 };
  const level = placeInView(head, facing, 0, { distance: 0.6, below: 0.26 });
  near(level[0], 1);
  near(level[1], 1.2 - 0.6 * Math.sin(0.26));
  near(level[2], 2 - 0.6 * Math.cos(0.26));
  const back = placeInView(head, facing, 0.5, { distance: 0.6, below: 0.26 });
  assert.ok(back[1] > 1.2, 'sitting back 29 degrees: the panel is above eye height, in your view');
  const down = placeInView(head, facing, -0.6, { distance: 0.6, below: 0.26 });
  near(Math.asin((down[1] - 1.2) / 0.6), -0.86);
  const clamped = placeInView(head, { x: 1, z: 0 }, -2, { distance: 1, below: 0 });
  near(Math.asin(clamped[1] - 1.2), -1.3);
  assert.ok(clamped[0] > 1, 'still on the side you face');
});

// Feed a straight stroke at about 70 Hz. `dir` is the detector direction, `motion` the way the hand really moves.
function stroke(det, { dir = 1, motion = 1, from = 0, metres, ms, startAt, up = 0, depth = 0 }) {
  let fired = 0;
  for (let t = 0; t <= ms; t += 14) {
    const f = t / ms;
    if (det.update({ side: from + motion * metres * f, up: up * f, depth: depth * f, now: startAt + t }, dir)) fired++;
  }
  return fired;
}

test('SwipeDetector: a quick clear swipe fires once, in either direction setting', () => {
  const right = new SwipeDetector();
  assert.equal(stroke(right, { dir: 1, motion: 1, metres: 0.25, ms: 200, startAt: 0 }), 1);
  assert.ok(right.last.distance >= 0.15 && right.last.speed >= 0.7);
  const left = new SwipeDetector();
  assert.equal(stroke(left, { dir: -1, motion: -1, metres: 0.25, ms: 200, startAt: 0 }), 1);
  assert.equal(SKIP_SECONDS, 30);
});

test('SwipeDetector: the wrong direction, a slow sweep, a short flick and a diagonal stroke do not fire', () => {
  assert.equal(stroke(new SwipeDetector(), { dir: 1, motion: -1, metres: 0.25, ms: 200, startAt: 0 }), 0, 'right hand swiping left');
  assert.equal(stroke(new SwipeDetector(), { dir: -1, motion: 1, metres: 0.25, ms: 200, startAt: 0 }), 0, 'left hand swiping right');
  assert.equal(stroke(new SwipeDetector(), { metres: 0.25, ms: 900, startAt: 0 }), 0, 'slow sweep');
  assert.equal(stroke(new SwipeDetector(), { metres: 0.20, ms: 330, startAt: 0 }), 0, 'long enough and in time, but only 0.61 m/s');
  assert.equal(stroke(new SwipeDetector(), { metres: 0.20, ms: 240, startAt: 0 }), 1, 'the same distance at 0.83 m/s fires');
  assert.equal(stroke(new SwipeDetector(), { metres: 0.10, ms: 100, startAt: 0 }), 0, 'short flick');
  assert.equal(stroke(new SwipeDetector(), { metres: 0.25, ms: 200, startAt: 0, up: 0.2 }), 0, 'as much up as across');
  assert.equal(stroke(new SwipeDetector(), { metres: 0.25, ms: 200, startAt: 0, depth: -0.2 }), 0, 'as much forward as across');
});

test('SwipeDetector: the stroke back is ignored; quick repeated flicks all count; one long sweep counts once', () => {
  const det = new SwipeDetector();
  assert.equal(stroke(det, { metres: 0.25, ms: 200, startAt: 0 }), 1);
  assert.equal(stroke(det, { motion: -1, from: 0.25, metres: 0.25, ms: 250, startAt: 214 }), 0, 'the return stroke');
  assert.equal(stroke(det, { metres: 0.25, ms: 200, startAt: 478 }), 1, 'a second flick 0.48 s after the first counts');
  assert.equal(stroke(det, { motion: -1, from: 0.25, metres: 0.25, ms: 250, startAt: 692 }), 0);
  assert.equal(stroke(det, { metres: 0.25, ms: 200, startAt: 956 }), 1, 'and a third');
  const sweep = new SwipeDetector();
  assert.equal(stroke(sweep, { metres: 0.7, ms: 850, startAt: 0 }), 1, 'one long sweep (70 cm at 0.8 m/s) counts once');
  const noReturn = new SwipeDetector();
  assert.equal(stroke(noReturn, { metres: 0.25, ms: 200, startAt: 0 }), 1);
  assert.equal(stroke(noReturn, { motion: -1, from: 0.25, metres: 0.02, ms: 100, startAt: 214 }), 0, 'back only 2 cm');
  assert.equal(stroke(noReturn, { from: 0.23, metres: 0.25, ms: 200, startAt: 328 }), 0, 'not back far enough: still the same stroke');
});

test('SwipeDetector: after a short return a new flick counts, but a wiggle at the end of a stroke does not', () => {
  const short = new SwipeDetector();
  assert.equal(stroke(short, { metres: 0.25, ms: 200, startAt: 0 }), 1);
  assert.equal(stroke(short, { motion: -1, from: 0.25, metres: 0.06, ms: 80, startAt: 214 }), 0, 'back 6 cm: armed again');
  assert.equal(stroke(short, { from: 0.19, metres: 0.21, ms: 200, startAt: 308 }), 1, 'a new 21 cm flick counts');
  const wiggle = new SwipeDetector();
  assert.equal(stroke(wiggle, { metres: 0.25, ms: 200, startAt: 0 }), 1);
  assert.equal(stroke(wiggle, { motion: -1, from: 0.25, metres: 0.05, ms: 50, startAt: 214 }), 0, 'back 5 cm');
  assert.equal(stroke(wiggle, { from: 0.2, metres: 0.05, ms: 50, startAt: 278 }), 0, 'forward 5 cm: only a wiggle, not a second skip');
});

test('SwipeDetector: reset() forgets a stroke that was cut short (the hand pinched, or left the zone)', () => {
  const det = new SwipeDetector();
  assert.equal(stroke(det, { metres: 0.125, ms: 100, startAt: 0 }), 0);
  det.reset();
  assert.equal(stroke(det, { from: 0.125, metres: 0.125, ms: 100, startAt: 112 }), 0, 'the two halves are not joined');
});

test('SwipeDetector: a near miss is recorded so the numbers can be shown and tuned', () => {
  const det = new SwipeDetector();
  stroke(det, { metres: 0.25, ms: 900, startAt: 0 });
  assert.ok(det.last.distance > 0.06 && det.last.speed < 0.8, JSON.stringify(det.last));
});

test('SwipeDetector: the numbers keep the peak speed even when the hand then slows down', () => {
  const det = new SwipeDetector();
  stroke(det, { metres: 0.12, ms: 70, startAt: 0 }); // fast: about 1.7 m/s, but too short to fire
  stroke(det, { from: 0.12, metres: 0.10, ms: 300, startAt: 84 }); // then it creeps on at about 0.3 m/s
  assert.ok(det.last.speed >= 1.5, `peak speed ${det.last.speed}`);
  assert.ok(det.last.distance >= 0.12, `peak distance ${det.last.distance}`);
});

test('SwipeDetector: the numbers shown are the peak distance and the peak speed of the stroke, and they age out', () => {
  const det = new SwipeDetector();
  // A hand that waits 300 ms, then swipes 0.30 m in 200 ms. Pairs that reach back to the wait are slower: the peak must not be one of those.
  for (let t = 0; t < 300; t += 14) det.update({ side: 0, up: 0, depth: 0, now: t }, 1);
  stroke(det, { metres: 0.30, ms: 200, startAt: 300 });
  assert.ok(det.last.speed >= 1.2, `peak speed ${det.last.speed}`); // the stroke is 1.5 m/s
  assert.ok(det.last.distance >= 0.15, `peak distance ${det.last.distance}`);
  const seen = det.last.at;
  det.update({ side: 0.30, up: 0, depth: 0, now: seen + 3000 }, 1); // 3 s later, hand at rest: nothing new
  assert.equal(det.last.at, seen);
  stroke(det, { from: 0.30, motion: 1, metres: 0.10, ms: 80, startAt: seen + 3100 });
  assert.ok(det.last.at > seen + 3000 && det.last.distance < 0.18, 'a new stroke replaces the old numbers after 2 s');
});

test('SwipeDetector.travel: how far the hand went one way in the last moments', () => {
  const det = new SwipeDetector();
  stroke(det, { dir: -1, motion: -1, metres: 0.12, ms: 140, startAt: 0 }); // too short to fire, but it moved 12 cm left
  near(det.travel(-1, 300, 140), 0.12, 1e-6);
  assert.equal(det.travel(1, 300, 140), 0, 'it did not move right');
  assert.equal(det.travel(-1, 300, 1000), 0, 'long ago: nothing in the last 0.3 s');
});

// One hand for HandsTogether in prayer pose, palm toward the middle, `x` metres from the middle; side -1 = left.
const prayerHand = (side, x) => ({
  palm: [side * (x + 0.004), -0.16, -0.4],
  middleTip: [side * x, -0.01, -0.4],
  thumb: [side * (x + 0.005), -0.1, -0.37], // the thumb lies along the index finger: not a pinch
  index: [side * x, -0.02, -0.4],
});
const prayer = (x = 0.015) => [prayerHand(-1, x), prayerHand(1, x)];
const holdFor = (h, hands, from, to) => { // feed the same hands every 20 ms; true if it fired
  let fired = false;
  for (let t = from; t <= to; t += 20) fired = h.update(hands, t) || fired;
  return fired;
};

test('HandsTogether: prayer hands held 0.2 s fire once; they fire again only after the palms are seen apart', () => {
  const h = new HandsTogether();
  assert.equal(h.update(prayer(), 1000), false, 'the palms just met');
  assert.equal(h.update(prayer(), 1150), false, 'held 0.15 s');
  assert.equal(h.update(prayer(), 1210), true, 'held 0.21 s: pause');
  assert.equal(holdFor(h, prayer(), 1230, 3000), false, 'held on, past the cooldown: no second toggle');
  assert.equal(h.update(prayer(0.2), 3020), false, 'the hands part');
  assert.equal(h.update(prayer(), 3100), false);
  assert.equal(h.update(prayer(), 3320), true, 'together again, held: play');
});

test('HandsTogether: a quick clap, the old diamond, a two-hand pinch or one hand never fire', () => {
  const clap = new HandsTogether();
  assert.equal(clap.update(prayer(), 0), false);
  assert.equal(clap.update(prayer(), 120), false);
  assert.equal(clap.update(prayer(0.2), 140), false, 'apart after 0.14 s: a clap, not a pause');
  const diamond = [-1, 1].map((side) => ({ // thumb tips and index tips touch, but the palms are 24 cm apart
    palm: [side * 0.12, -0.14, -0.39], middleTip: [side * 0.03, -0.02, -0.42], thumb: [side * 0.012, -0.13, -0.42], index: [side * 0.012, -0.03, -0.42],
  }));
  const pinches = prayer().map((hand) => ({ ...hand, thumb: hand.index.map((v, k) => v + (k ? 0 : 0.008)) })); // each hand pinching
  const steepled = [-1, 1].map((side) => ({ ...prayerHand(side, 0.015), palm: [side * 0.07, -0.16, -0.4] })); // tips touch, palms 14 cm apart
  const clasped = [-1, 1].map((side) => ({ ...prayerHand(side, 0.015), middleTip: [-side * 0.05, -0.12, -0.42] })); // fingers interlock
  for (const [name, hands] of [['diamond', diamond], ['two-hand pinch', pinches], ['steepled fingers', steepled],
    ['clasped hands', clasped], ['one hand', [prayerHand(-1, 0.015), null]]]) {
    assert.equal(holdFor(new HandsTogether(), hands, 0, 1000), false, name);
  }
});

test('HandsTogether: a hand lost for a moment (the hands hide each other) neither toggles nor re-arms', () => {
  const h = new HandsTogether();
  assert.equal(holdFor(h, prayer(), 0, 300), true, 'pause');
  const lostRight = [prayerHand(-1, 0.015), null];
  assert.equal(holdFor(h, lostRight, 320, 600), false, 'the right hand is lost');
  assert.equal(holdFor(h, prayer(), 620, 2000), false, 'it comes back, still together: no second toggle');
  const during = new HandsTogether();
  assert.equal(holdFor(during, prayer(), 0, 140), false);
  assert.equal(during.update(lostRight, 160), false, 'lost for a moment during the hold');
  assert.equal(during.update(prayer(), 180), false);
  assert.equal(during.update(prayer(), 220), true, 'the short loss did not restart the hold: 0.22 s since the palms met');
  const longLoss = new HandsTogether();
  assert.equal(holdFor(longLoss, prayer(), 0, 140), false);
  assert.equal(holdFor(longLoss, lostRight, 160, 500), false, 'lost for 0.34 s');
  assert.equal(longLoss.update(prayer(), 520), false, 'a long loss restarts the hold');
  assert.equal(longLoss.update(prayer(), 640), false);
  assert.equal(longLoss.update(prayer(), 740), true);
});

test('HandsTogether: palms the tracker holds 7 cm apart still count', () => {
  assert.equal(holdFor(new HandsTogether(), prayer(0.03), 0, 300), true);
});

test('prayer hands count down to chest height; hands in the lap still do not', () => {
  const head = { x: 0, y: 1.2, z: 0 };
  const ahead = view(0);
  assert.ok(PRAYER_LOW_ANGLE > 0.8 && PRAYER_LOW_ANGLE < 0.95, 'about 50 degrees');
  const chest = [0, 0.9, -0.4]; // 37 degrees below the line of sight
  assert.equal(inGestureZone(chest, head, ahead), false, 'too low for the other gestures');
  assert.equal(inGestureZone(chest, head, ahead, { lowAngle: PRAYER_LOW_ANGLE }), true, 'low enough for prayer hands');
  assert.equal(inGestureZone([0.1, 0.5, -0.3], head, ahead, { lowAngle: PRAYER_LOW_ANGLE }), false, 'in the lap: 66 degrees');
});

test('the menu has Home and X at the top of the main page, Back and X on the other pages, and a passthrough button', () => {
  const main = panelLayout('main').buttons;
  for (const id of ['home', 'close', 'play', 'back', 'fwd', 'seek']) assert.ok(main.some((b) => b.id === id), id);
  const close = main.find((b) => b.id === 'close');
  const home = main.find((b) => b.id === 'home');
  assert.ok(close.x + close.w >= PANEL_W - 30, 'the X is at the top right');
  assert.ok(home.x <= 30 && home.y === close.y, 'Home is at the top left, level with the X');
  assert.ok(close.w >= 56 && close.h >= 48, 'the X is big enough to press with a finger');
  for (const page of ['view', 'subs', 'audio']) {
    const b = panelLayout(page, { count: 3 }).buttons;
    const x = b.find((k) => k.id === 'close');
    const back = b.find((k) => k.id === 'menu');
    assert.ok(x && x.x === close.x && x.y === close.y, `${page}: the X in the same place`);
    assert.ok(back && back.x === home.x && back.y === home.y, `${page}: Back where Home is`);
  }
  assert.ok(panelLayout('view').buttons.some((b) => b.id === 'pass') && panelLayout('view').buttons.some((b) => b.id === 'reset'));
});

test('listFolder: the subfolders one level down (with video counts) and the videos at this level', () => {
  const files = ['top.mp4', 'Season 10/e1.mp4', 'Season 2/e1.mp4', 'Season 2/e2.mp4', 'Season 2/extras/x.mp4', 'b.mp4']
    .map((p) => ({ path: p, name: p.split('/').pop() }));
  const top = listFolder(files, '');
  assert.deepEqual(top.folders.map(({ name, count }) => ({ name, count })), [{ name: 'Season 2', count: 3 }, { name: 'Season 10', count: 1 }],
    'numeric order, counts include deeper videos');
  assert.deepEqual(top.files.map((f) => f.path), ['b.mp4', 'top.mp4']);
  const s2 = listFolder(files, 'Season 2');
  assert.deepEqual(s2.folders.map(({ name, count }) => ({ name, count })), [{ name: 'extras', count: 1 }]);
  assert.deepEqual(s2.files.map((f) => f.path), ['Season 2/e1.mp4', 'Season 2/e2.mp4']);
  assert.deepEqual(listFolder(files, 'Season'), { folders: [], files: [] }, 'a name that only starts the same is not the folder');
  assert.equal(parentDir('Season 2/extras'), 'Season 2');
  assert.equal(parentDir('Season 2'), '');
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(75), '1:15');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '0:00');
});

test('awayStep: the video pauses behind the Meta menu and plays again when you are back, only if it was playing', () => {
  // you open the menu while it plays: pause, and remember that this step paused it
  let s = awayStep('visible-blurred', { paused: false, away: false });
  assert.deepEqual(s, { pause: true, play: false, away: true });
  // the menu closes: play again, and forget
  s = awayStep('visible', { paused: true, away: s.away });
  assert.deepEqual(s, { pause: false, play: true, away: false });

  // menu, then you leave, then you come back: the second step must not lose the memory (it is paused by then)
  s = awayStep('visible-blurred', { paused: false, away: false });
  s = awayStep('hidden', { paused: true, away: s.away });
  assert.deepEqual(s, { pause: false, play: false, away: true });
  s = awayStep('visible', { paused: true, away: s.away });
  assert.equal(s.play, true);

  // a video you paused yourself stays paused: nothing to pause, nothing to resume
  s = awayStep('hidden', { paused: true, away: false });
  assert.deepEqual(s, { pause: false, play: false, away: false });
  s = awayStep('visible', { paused: true, away: s.away });
  assert.deepEqual(s, { pause: false, play: false, away: false });

  // "visible" with nothing paused by us does nothing, and an unknown word counts as visible
  assert.deepEqual(awayStep('visible', { paused: false, away: false }), { pause: false, play: false, away: false });
  assert.deepEqual(awayStep(undefined, { paused: false, away: false }), { pause: false, play: false, away: false });
});

// A fake video and a fake session end, so the real AwayGuard code runs with fake time (60 s costs no time).
function awayRig(paused = false) {
  const media = {
    paused,
    plays: 0,
    pause() { this.paused = true; },
    play() { this.paused = false; this.plays += 1; return Promise.resolve(); },
  };
  const events = [];
  let ended = 0;
  const guard = new AwayGuard({ media, endSession: () => { ended += 1; }, log: (type) => events.push(type) });
  return { media, guard, events, ended: () => ended };
}

test('AwayGuard: back in focus within 60 s, the video plays again and the session stays', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = awayRig();
    r.guard.change('visible-blurred');
    assert.equal(r.media.paused, true);
    mock.timers.tick(AWAY_END_MS - 1000);
    r.guard.change('visible');
    assert.equal(r.media.paused, false);
    mock.timers.tick(10 * AWAY_END_MS);
    assert.equal(r.ended(), 0, 'coming back cancels the end');
  } finally { mock.timers.reset(); }
});

test('AwayGuard: still out of focus after 60 s (the grey menu that never goes), the session ends once', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = awayRig();
    r.guard.change('visible-blurred');
    mock.timers.tick(AWAY_END_MS - 1);
    assert.equal(r.ended(), 0, 'not yet');
    mock.timers.tick(1);
    assert.equal(r.ended(), 1);
    assert.deepEqual(r.events, ['away-end']);
    mock.timers.tick(10 * AWAY_END_MS);
    assert.equal(r.ended(), 1, 'only once');
  } finally { mock.timers.reset(); }
});

test('AwayGuard: menu, then hidden, does not restart the 60 s; a video you paused stays paused but the session still ends', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = awayRig(true); // paused by the user before
    r.guard.change('visible-blurred');
    mock.timers.tick(40_000);
    r.guard.change('hidden');
    mock.timers.tick(20_000);
    assert.equal(r.ended(), 1, 'the clock runs from the first change');
    assert.equal(r.media.plays, 0, 'a video paused by the user is never started');
  } finally { mock.timers.reset(); }
});

test('AwayGuard: reset (a session starts or ends) cancels the end and the resume', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = awayRig();
    r.guard.change('hidden');
    r.guard.reset();
    mock.timers.tick(10 * AWAY_END_MS);
    assert.equal(r.ended(), 0);
    r.guard.change('visible');
    assert.equal(r.media.plays, 0, 'after reset nothing resumes by itself');
  } finally { mock.timers.reset(); }
});

test('AwayGuard: a failed resume is logged, not thrown; isAway only knows the two away words', async () => {
  const r = awayRig();
  r.media.play = () => Promise.reject(new Error('blocked'));
  r.guard.change('hidden');
  r.guard.change('visible');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(r.events.includes('resume-failed'));
  r.guard.reset();
  assert.equal(isAway('visible'), false);
  assert.equal(isAway(undefined), false);
  assert.equal(isAway('hidden') && isAway('visible-blurred'), true);
});
