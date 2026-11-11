// Pure logic for the player. No DOM. Runs in the headset browser and in node tests.
import { Vector3, Quaternion } from 'three';

// ---------------------------------------------------------------- layout guess

const words = (name) =>
  ' ' + name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, ' ') + ' ';
const hasWord = (n, list) => list.some((w) => n.includes(` ${w} `));

// Guess projection and stereo layout from the file name, then from the frame size.
// projection: 'vr180' | 'fisheye' | 'flat'. stereo: 'mono' | 'sbs' | 'tb'.
// A fisheye name also gives the lens angle (fov, degrees) and whether a passthrough mask is packed in (alpha).
export function guessLayout(name, width = 0, height = 0) {
  const n = words(name);
  const lr = hasWord(n, ['lr', 'sbs', '3dh', 'hsbs', 'fsbs']);
  const tb = hasWord(n, ['tb', 'ou', '3dv', 'htb', 'ftb']);
  const alpha = hasWord(n, ['alpha']); // DeoVR's name for a passthrough video with a packed mask: always fisheye
  const fov = hasWord(n, ['vrca220', 'fisheye220']) ? 220
    : hasWord(n, ['mkx200', 'mkx', 'fisheye200']) ? 200
      : hasWord(n, ['fisheye180']) ? 180
        : hasWord(n, ['fisheye', 'fisheye190', 'f190', 'rf52']) || alpha ? FISHEYE_FOV : 0;
  if (fov) return { projection: 'fisheye', stereo: tb ? 'tb' : 'sbs', fov, alpha };
  const projection = hasWord(n, ['180', '180x180', 'vr180', '180vr']) ? 'vr180' : 'flat';
  let stereo = lr ? 'sbs' : tb ? 'tb' : 'mono';
  if (projection === 'vr180' && !lr && !tb && width > 0 && height > 0) {
    const ar = width / height;
    stereo = ar >= 1.8 ? 'sbs' : ar <= 0.6 ? 'tb' : 'mono';
  }
  // A 2:1 frame with no layout word is almost always VR180 side by side. A flat 2:1 film is rare.
  if (projection === 'flat' && !lr && !tb && width > 0 && height > 0) {
    const ar = width / height;
    if (ar >= 1.9 && ar <= 2.1) return { projection: 'vr180', stereo: 'sbs' };
  }
  return { projection, stereo };
}

// Screen aspect (width / height) of ONE eye for a flat video.
// A half-width SBS or half-height TB file stores a squeezed picture; undo the squeeze.
export function flatAspect(stereo, width, height) {
  if (!width || !height) return 16 / 9;
  if (stereo === 'sbs') {
    const perEye = width / 2 / height;
    return perEye < 1.2 ? width / height : perEye;
  }
  if (stereo === 'tb') {
    const perEye = width / (height / 2);
    return perEye > 2.5 ? width / height : perEye;
  }
  return width / height;
}

// Sub-rectangle of the video texture for one eye. v = 1 is the TOP of the picture
// (three.js flips video textures). Top-bottom: the left eye is the top half.
export function eyeRegion(stereo, eye) {
  if (stereo === 'sbs') return { u0: eye === 'left' ? 0 : 0.5, v0: 0, du: 0.5, dv: 1 };
  if (stereo === 'tb') return { u0: 0, v0: eye === 'left' ? 0.5 : 0, du: 1, dv: 0.5 };
  return { u0: 0, v0: 0, du: 1, dv: 1 };
}

// UVs for a PlaneGeometry (order: top-left, top-right, bottom-left, bottom-right).
export function flatUv(region) {
  const { u0, v0, du, dv } = region;
  return new Float32Array([u0, v0 + dv, u0 + du, v0 + dv, u0, v0, u0 + du, v0]);
}

// ---------------------------------------------------------------- VR180 zoom

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

// Build the VR180 half-sphere for one eye.
// zoom > 1: the mesh stays a half-sphere and shows the centre 1/zoom of the picture.
// zoom < 1: the picture stays whole and the mesh shrinks to zoom * 180 degrees.
// Both keep the picture fixed in the world, so a head turn feels normal.
export function hemisphere({ zoom, region, radius = 50, nx = 48, ny = 32 }) {
  const span = Math.min(zoom, 1);
  const shown = zoom > 1 ? 1 / zoom : 1;
  const count = (nx + 1) * (ny + 1);
  const position = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const index = new Uint32Array(nx * ny * 6);
  let p = 0;
  let t = 0;
  for (let j = 0; j <= ny; j++) {
    const mv = j / ny;
    const pitch = (mv - 0.5) * Math.PI * span;
    for (let i = 0; i <= nx; i++) {
      const mu = i / nx;
      const yaw = (mu - 0.5) * Math.PI * span;
      position[p++] = radius * Math.sin(yaw) * Math.cos(pitch);
      position[p++] = radius * Math.sin(pitch);
      position[p++] = -radius * Math.cos(yaw) * Math.cos(pitch);
      uv[t++] = region.u0 + region.du * (0.5 + (mu - 0.5) * shown);
      uv[t++] = region.v0 + region.dv * (0.5 + (mv - 0.5) * shown);
    }
  }
  let k = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      index.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  return { position, uv, index };
}

// ---------------------------------------------------------------- fisheye (VR180 filmed and kept as fisheye circles)

export const FISHEYE_FOV = 190; // degrees across the circle, when the file name names no other lens

// Build the fisheye picture for one eye: a sphere cap, each point textured from where the lens put it in the circle
// (equidistant fisheye: the distance from the circle centre grows evenly with the angle from straight ahead).
// The circle fills the eye's square. zoom works like hemisphere(): above 1 the centre of the circle is shown
// bigger on the same cap; below 1 the whole circle is shown on a smaller cap.
export function fisheye({ zoom, region, fov = FISHEYE_FOV, radius = 50, rings = 36, segments = 72 }) {
  const maxAngle = (fov / 2) * (Math.PI / 180);
  const span = Math.min(zoom, 1);
  const shown = zoom > 1 ? 1 / zoom : 1;
  const count = (rings + 1) * (segments + 1);
  const position = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const index = new Uint32Array(rings * segments * 6);
  let p = 0;
  let t = 0;
  for (let i = 0; i <= rings; i++) {
    const f = i / rings; // 0 = straight ahead, 1 = the edge of the circle
    const angle = f * maxAngle * span;
    const r = 0.5 * f * shown; // distance from the circle centre, in eye widths
    for (let j = 0; j <= segments; j++) {
      const around = (j / segments) * Math.PI * 2; // 0 = to the right, PI / 2 = up
      position[p++] = radius * Math.sin(angle) * Math.cos(around);
      position[p++] = radius * Math.sin(angle) * Math.sin(around);
      position[p++] = -radius * Math.cos(angle);
      uv[t++] = region.u0 + region.du * (0.5 + r * Math.cos(around));
      uv[t++] = region.v0 + region.dv * (0.5 + r * Math.sin(around));
    }
  }
  let k = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      index.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  return { position, uv, index };
}

// A passthrough video made for DeoVR ("_alpha") packs each eye's cut-out mask into the dark corners round the two
// fisheye circles: the mask at 40 % size, in the red channel (red = the person, black = the room), in six pieces.
// The left eye's top half sits in the bottom-centre gap and its bottom half in the top-centre gap. The right eye's
// four quarters sit in the four outer corners, each in the opposite corner.
// eye: 'left' | 'right'. (u, v): a point in that eye's square, 0..1, v down. Returns where its mask value is,
// as a fraction of the whole side-by-side frame (U across, V down). The player's shader does the same sums.
export function packedAlphaAt(eye, u, v) {
  const V = v < 0.5 ? 0.8 + v * 0.4 : (v - 0.5) * 0.4;
  if (eye === 'left') return { U: 0.4 + u * 0.2, V };
  return { U: u < 0.5 ? 0.9 + u * 0.2 : (u - 0.5) * 0.2, V };
}

// ---------------------------------------------------------------- what the pictures say
// The laptop reads these from its files (lib/layout.js), the page from a file on the headset: small RGB frames
// (width x height x 3) of a side-by-side 2:1 video, taken at different times.

// Fisheye: in EVERY frame the corners outside both circles are black or mask red (90 % or more), some frame shows
// a lit picture inside the circles, and some frame is lit right up to the circles' edge (half the ring just inside
// it, or more). One dark scene alone proves nothing, so a full-frame video with one dark frame stays full frame.
// The edge ring tells a fisheye picture (it fills its circle: 43 to 75 % lit there, 64 % or more in some frame, on
// 5 real files) from a black filled background round a person in the middle (black up to the edge too).
// A lens that ends well inside the eye's square lights less of the ring. A real masked file of 2026-11-11 reached 47 %
// at most (its lens ends at about 91 % of the eye), and went by as flat with a black cut. A mask in the corners is
// proof of a fisheye video by itself (a black background has no red there), so with a clear mask (2 % or more of the
// corners are red in some frame; that file: 27 % at most) a ring of 30 % is enough.
// Packed mask: a fisheye video with mask red in the corners of some frame (a plain fisheye video has pure black
// corners).
const RING_MIN = 0.5;
const RING_MIN_WITH_MASK = 0.3;
const CLEAR_MASK_RED = 0.02;
export function classifyFrames(frames, width = 128, height = 64) {
  const stats = frames.map((rgb) => {
    let corner = 0;
    let blackOrRed = 0;
    let red = 0;
    let inner = 0;
    let lit = 0;
    let ring = 0;
    let ringLit = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const centreX = x < width / 2 ? width / 4 : (3 * width) / 4;
        const d = Math.hypot(x + 0.5 - centreX, y + 0.5 - height / 2) / (height / 2); // 1 = the circle edge
        const i = (y * width + x) * 3;
        const r = rgb[i];
        const g = rgb[i + 1];
        const b = rgb[i + 2];
        if (d > 1.05) {
          corner++;
          const isRed = r > 100 && g < 70 && b < 70;
          if (isRed) red++;
          if (isRed || Math.max(r, g, b) < 30) blackOrRed++;
        } else if (d < 0.8) {
          inner++;
          if (Math.max(r, g, b) >= 30) lit++;
        } else if (d > 0.85 && d < 0.98) {
          ring++;
          if (Math.max(r, g, b) >= 30) ringLit++;
        }
      }
    }
    return { dark: blackOrRed / corner, red: red / corner, lit: lit / inner, ring: ringLit / ring };
  });
  const ringMin = stats.some((s) => s.red >= CLEAR_MASK_RED) ? RING_MIN_WITH_MASK : RING_MIN;
  const fisheye = stats.length > 0 && stats.every((s) => s.dark >= 0.9) && stats.some((s) => s.lit > 0.2) && stats.some((s) => s.ring >= ringMin);
  return { fisheye, alpha: fisheye && stats.some((s) => s.red > 0.003) };
}

// The colour measures of the background cut, on sRGB values 0..1. The player's shader does the same sums.
const cbcr = ([r, g, b]) => [-0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
const brightness = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// How wide the soft edge of the cut is: a colour by its CbCr distance, black by its brightness.
export const CUT_WIDTH = { colour: 0.14, black: 0.05 };

// A passthrough video made with a filled background: one even colour round the person (often green, violet or
// black) where other videos carry a mask. It shows in the band where a background shows round a person: the top
// fifth of each eye and its outer side strips. In at least 3 of 5 frames one colour must fill 60 % of that band.
// A colour must also be even: a filled colour has a spread of 0 to 3 here, a real wall or sky 8 or more, so it may
// spread 6 at most. For black, the share alone decides: dark rooms filled 12 to 36 % of the band, black fills 66 to
// 100 %. (Measured on 30 VR videos, 2026-10-28: the 5 filled ones found, none of the 25 others.)
// Not for fisheye videos: their black corners fill the band too (readFrames skips them).
// Returns null, or { kind: 'colour' | 'black', rgb: [r, g, b], edge }. The cut starts at `edge`: just above the
// noise of the background itself (in its evenest frame), as a CbCr distance (colour) or a brightness (black).
export function findBackground(frames, width = 128, height = 64) {
  const half = width / 2;
  const band = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ex = x % half;
      if (y < height * 0.2 || ex < half * 0.08 || ex >= half * 0.92) band.push((y * width + x) * 3);
    }
  }
  const near = (rgb, i, c) => Math.abs(rgb[i] - c[0]) <= 28 && Math.abs(rgb[i + 1] - c[1]) <= 28 && Math.abs(rgb[i + 2] - c[2]) <= 28;
  const per = frames.map((rgb) => {
    const bins = new Map(); // the band's most common colour, in steps of 16
    let top = 0;
    let topKey = 0;
    for (const i of band) {
      const k = ((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4);
      const n = (bins.get(k) || 0) + 1;
      bins.set(k, n);
      if (n > top) [top, topKey] = [n, k];
    }
    const c = [((topKey >> 8) & 15) * 16 + 8, ((topKey >> 4) & 15) * 16 + 8, (topKey & 15) * 16 + 8];
    let n = 0;
    const sum = [0, 0, 0];
    const sq = [0, 0, 0];
    for (const i of band) {
      if (!near(rgb, i, c)) continue;
      n++;
      for (let k = 0; k < 3; k++) {
        sum[k] += rgb[i + k];
        sq[k] += rgb[i + k] ** 2;
      }
    }
    const mean = sum.map((s) => s / Math.max(1, n));
    const spread = Math.max(...sq.map((s, k) => Math.sqrt(Math.max(0, s / Math.max(1, n) - mean[k] ** 2))));
    return { rgb, c, mean, spread, share: n / Math.max(1, band.length) };
  });
  const isBlack = (m) => Math.max(...m) <= 40;
  const saturated = (m) => Math.max(...m) >= 90 && (Math.max(...m) - Math.min(...m)) / Math.max(...m) >= 0.5;
  const fits = (p) => p.share >= 0.6 && (isBlack(p.mean) || (p.spread <= 6 && saturated(p.mean)));
  const ok = per.filter(fits);
  let group = [];
  for (const a of ok) {
    const same = ok.filter((b) => a.mean.every((v, k) => Math.abs(v - b.mean[k]) <= 20));
    if (same.length > group.length) group = same;
  }
  if (!frames.length || group.length < Math.ceil(frames.length * 0.6)) return null;
  const rgb = [0, 1, 2].map((k) => Math.round(group.reduce((s, p) => s + p.mean[k], 0) / group.length));
  const kind = isBlack(rgb) ? 'black' : 'colour';
  const key = cbcr(rgb.map((v) => v / 255));
  const evenest = group.reduce((a, b) => (b.spread < a.spread ? b : a));
  const values = [];
  for (const i of band) {
    if (!near(evenest.rgb, i, evenest.c)) continue;
    const px = [evenest.rgb[i] / 255, evenest.rgb[i + 1] / 255, evenest.rgb[i + 2] / 255];
    values.push(kind === 'black' ? brightness(px) : Math.hypot(...cbcr(px).map((v, k) => v - key[k])));
  }
  values.sort((a, b) => a - b);
  const noise = values[Math.floor((values.length - 1) * 0.98)] || 0;
  const edge = kind === 'black' ? Math.min(0.2, noise + 0.01) : Math.min(0.15, Math.max(0.05, noise * 2));
  return { kind, rgb, edge: Math.round(edge * 1000) / 1000 };
}

// { fisheye, alpha, background } from the frames. A fisheye video gets no background check: its black corners look
// like a black background (they did on 4 of 5 real fisheye files, 2026-10-28). Its passthrough kind is the mask.
export function readFrames(frames, width = 128, height = 64) {
  const { fisheye, alpha } = classifyFrames(frames, width, height);
  return { fisheye, alpha, background: fisheye ? null : findBackground(frames, width, height) };
}

// How much of a pixel (sRGB 0..255) stays with a filled background cut: 0 = cut, 1 = kept. The shader's sums.
export function backgroundKeep([r, g, b], { kind, rgb, edge }) {
  const px = [r / 255, g / 255, b / 255];
  const key = cbcr(rgb.map((v) => v / 255));
  const value = kind === 'black' ? brightness(px) : Math.hypot(...cbcr(px).map((v, k) => v - key[k]));
  return smoothstep(edge, edge + CUT_WIDTH[kind], value);
}

// The key's CbCr, for the shader (the same sums as above).
export const keyCbCr = (rgb) => cbcr(rgb.map((v) => v / 255));

// "green", "violet", "black"...: what the page calls a background colour.
export function colourName([r, g, b]) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (max <= 40) return 'black';
  if (!d) return max > 200 ? 'white' : 'grey';
  let h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  h = (h + 360) % 360;
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 195) return 'cyan';
  if (h < 255) return 'blue';
  if (h < 290) return 'violet';
  return 'pink';
}

// ---------------------------------------------------------------- hand gestures

const PINCH_ON = 0.022; // metres between thumb tip and index tip
const PINCH_OFF = 0.04;
const MIN_SPREAD = 0.05; // ignore a two-hand start with the hands almost touching

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

// Reads two hands each frame and says what the pinches mean.
// hands[i] = null | { thumb: [x,y,z], index: [x,y,z] } in world metres. `now` = time in ms.
// Returns null, or an event measured against the point where the gesture started:
//   { kind: 'grab',  started, p0, p }              one hand pinching
//   { kind: 'scale', started, ratio, mid0, mid }   two hands pinching, ratio = spread / start spread
// `started` is true on the first frame, so the caller records the object's start state then.
// Three guards stop a relaxed or careless hand from moving the picture:
//   - a one-hand pinch must last `graceMs` before it counts, so the first hand of a two-hand zoom does nothing alone;
//   - then the hand must travel `deadZone` metres before the grab starts. It starts from there, with no jump;
//   - after a two-hand gesture, the hand that is still pinching does nothing until it lets go.
export class GestureTracker {
  constructor({ graceMs = 150, deadZone = 0.02 } = {}) {
    this.graceMs = graceMs;
    this.deadZone = deadZone;
    this.pinching = [false, false];
    this.since = [0, 0]; // when each pinch began
    this.blocked = -1; // a hand that must let go before it counts again
    this.kind = 'none'; // what is being reported now: 'none' | 'grab' | 'scale'
    this.hand = -1;
    this.anchor = null;
    this.pending = null; // a one-hand pinch past its grace time, waiting to leave the dead zone
  }

  update(hands, now = 0) {
    const pts = [null, null];
    for (let i = 0; i < 2; i++) {
      const h = hands[i];
      let on = false;
      if (h) {
        const d = dist(h.thumb, h.index);
        on = this.pinching[i] ? d < PINCH_OFF : d < PINCH_ON;
      }
      if (on && !this.pinching[i]) this.since[i] = now;
      this.pinching[i] = on;
      if (!on && this.blocked === i) this.blocked = -1;
      if (on) pts[i] = mid(h.thumb, h.index);
    }
    if (this.kind === 'scale' && pts.filter(Boolean).length === 1) this.blocked = pts[0] ? 0 : 1;
    const use = pts.map((p, i) => (this.blocked === i ? null : p));

    if (use[0] && use[1]) {
      this.pending = null;
      const spread = Math.max(dist(use[0], use[1]), MIN_SPREAD);
      const centre = mid(use[0], use[1]);
      const started = this.kind !== 'scale';
      this.kind = 'scale';
      this.hand = -1;
      if (started) this.anchor = { spread, mid: centre };
      return { kind: 'scale', started, ratio: spread / this.anchor.spread, mid0: this.anchor.mid, mid: centre };
    }

    if (use[0] || use[1]) {
      const hand = use[0] ? 0 : 1;
      const p = use[hand];
      if (this.kind === 'grab' && this.hand === hand) return { kind: 'grab', started: false, p0: this.anchor.p, p };
      this.kind = 'none';
      this.hand = -1;
      if (now - this.since[hand] < this.graceMs) {
        this.pending = null;
        return null;
      }
      if (!this.pending || this.pending.hand !== hand) this.pending = { hand, p };
      if (dist(p, this.pending.p) < this.deadZone) return null;
      this.kind = 'grab';
      this.hand = hand;
      this.anchor = { p }; // start here, so the picture does not jump
      this.pending = null;
      return { kind: 'grab', started: true, p0: p, p };
    }

    this.kind = 'none';
    this.hand = -1;
    this.anchor = null;
    this.pending = null;
    return null;
  }
}

// Far grab: turn the object round the head by the hand's angle, and scale its
// distance by the hand's change of distance. A hand move of 20 cm then moves a
// screen 5 m away a long way, and the screen follows the hand direction.
export function remoteGrab(head, p0, p, objectStart, minDist = 0.8, maxDist = 40) {
  const v0 = new Vector3().subVectors(p0, head);
  const v = new Vector3().subVectors(p, head);
  const q = new Quaternion().setFromUnitVectors(v0.clone().normalize(), v.clone().normalize());
  const k = v.length() / Math.max(v0.length(), 0.1);
  const out = new Vector3().subVectors(objectStart, head).applyQuaternion(q).multiplyScalar(k);
  const len = out.length();
  if (len > 0) out.multiplyScalar(Math.min(maxDist, Math.max(minDist, len)) / len);
  return out.add(head);
}

export const SCREEN_SCALE_MIN = 0.3;
export const SCREEN_SCALE_MAX = 6;
export const clampScreenScale = (s) => Math.min(SCREEN_SCALE_MAX, Math.max(SCREEN_SCALE_MIN, s));

// ---------------------------------------------------------------- control panel

// Finger poke: fires once when a fingertip pushes through the panel from the front.
export class PokeDetector {
  constructor({ arm = 0.04, fire = 0.012 } = {}) {
    this.arm = arm;
    this.fire = fire;
    this.armed = false;
  }

  // z = fingertip distance in front of the panel plane (+ = in front).
  update(z, inBounds) {
    if (z > this.arm) {
      this.armed = true;
      return false;
    }
    if (!inBounds) {
      this.armed = false;
      return false;
    }
    if (this.armed && z < this.fire) {
      this.armed = false;
      return true;
    }
    return false;
  }
}

export const PANEL_W = 720;
export const PANEL_H = 288;
export const PROJECTIONS = ['vr180', 'fisheye', 'flat'];
export const STEREOS = ['mono', 'sbs', 'tb'];
export const SPEED_PRESETS = [1, 1.25, 1.5, 1.75, 2];
export const LIST_SLOTS = 6; // the Subtitles and Audio pages show six choices at a time

const box = (id, x, y, w, h) => ({ id, x, y, w, h });

// The menu has pages. All are the same size, in canvas pixels.
//   'main':  Home, -10 s, play, +10 s, X / the time, the seek bar, the length / slower, the speed, faster, the speed
//            presets / a row of up to three buttons, `extras`, in order (for example ['subs', 'audio', 'view']).
//   'subs', 'audio': Back, the title, X / `count` choices, six at a time from `start` / page buttons when there are
//            more than six; the Subtitles page also has Earlier and Later (the subtitle timing).
//   'view':  Back, the title, X / projection / 3D layout / Reset view and Passthrough.
// Returns { buttons, texts }: a button can be pressed; a text is a place where the menu writes (the time, a title).
export function panelLayout(page = 'main', { extras = ['view'], count = 0, start = 0 } = {}) {
  const buttons = [];
  const texts = [];
  if (page === 'main') {
    buttons.push(box('home', 8, 8, 112, 64), box('back', 128, 8, 112, 64), box('play', 248, 8, 160, 64), box('fwd', 416, 8, 112, 64),
      box('close', 600, 8, 112, 64), box('seek', 104, 80, 512, 52), box('speed-down', 8, 140, 80, 60), box('speed-up', 192, 140, 80, 60));
    SPEED_PRESETS.forEach((s, i) => buttons.push(box(`speed:${s}`, 280 + i * 88, 140, 80, 60)));
    texts.push(box('time', 8, 80, 88, 52), box('duration', 624, 80, 88, 52), box('speed', 96, 140, 88, 60));
    const row = extras.slice(0, 3);
    const w = Math.floor((704 - 8 * (row.length - 1)) / row.length);
    row.forEach((id, i) => buttons.push(box(id, 8 + i * (w + 8), 208, w, 72)));
    return { buttons, texts };
  }
  buttons.push(box('menu', 8, 8, 112, 64), box('close', 600, 8, 112, 64));
  texts.push(box('title', 128, 8, 464, 64));
  if (page === 'view') {
    PROJECTIONS.forEach((p, i) => buttons.push(box(`proj:${p}`, 120 + i * 200, 80, 192, 64)));
    STEREOS.forEach((s, i) => buttons.push(box(`stereo:${s}`, 120 + i * 200, 152, 192, 64)));
    buttons.push(box('reset', 8, 224, 348, 56), box('pass', 364, 224, 348, 56));
    texts.push(box('label-proj', 8, 80, 104, 64), box('label-stereo', 8, 152, 104, 64));
    return { buttons, texts };
  }
  for (let k = 0; k < LIST_SLOTS && start + k < count; k++) {
    buttons.push(box(`item:${start + k}`, 8 + (k % 3) * 237, 80 + Math.floor(k / 3) * 72, k % 3 === 2 ? 230 : 229, 64));
  }
  if (count > LIST_SLOTS) {
    buttons.push(box('prev', 8, 224, 96, 56), box('next', 208, 224, 96, 56));
    texts.push(box('pages', 112, 224, 88, 56));
  }
  if (page === 'subs') {
    buttons.push(box('earlier', 360, 224, 112, 56), box('later', 600, 224, 112, 56));
    texts.push(box('delay', 480, 224, 112, 56));
  }
  return { buttons, texts };
}

export function buttonAt(buttons, x, y) {
  return buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
}

const SEEK_BAR = panelLayout('main').buttons.find((b) => b.id === 'seek');
export function seekFraction(x) {
  return Math.min(1, Math.max(0, (x - SEEK_BAR.x) / SEEK_BAR.w));
}

// ---------------------------------------------------------------- speed

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 3;
export const SPEED_STEP = 0.05;
export const clampSpeed = (rate) => Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(rate) || 1)) * 100) / 100;
// One step slower (-1) or faster (+1), on the 0.05 grid: 1.6 -> 1.65.
export const stepSpeed = (rate, direction) => clampSpeed(Math.round(rate / SPEED_STEP + direction) * SPEED_STEP);
export const formatSpeed = (rate) => `${Number(clampSpeed(rate).toFixed(2))}×`;

// What the headset gave this page: was hand tracking granted, and which kinds of input exist.
// "hand-tracking OFF" with "inputs: none" or "tracked-pointer" means the site has no hand permission.
export function describeInputs(session) {
  if (!session) return 'no VR session';
  const features = session.enabledFeatures;
  const hand = Array.isArray(features) ? (features.includes('hand-tracking') ? 'ON' : 'OFF') : '?';
  const kinds = [...(session.inputSources || [])].map((s) => (s.hand ? 'hand' : s.targetRayMode || 'input'));
  return `hand-tracking ${hand} | inputs: ${kinds.length ? kinds.join(',') : 'none'}`;
}

// The headset tells the page when you are not looking: the Meta menu is open ("visible-blurred"), or you left ("hidden").
// The video must not play on behind the menu. It pauses then, and plays again when you are back ("visible"), but only
// if it was playing when you left: a video you paused yourself stays paused.
// away: true when an earlier step paused the video. Pass back what this step returns.
export const isAway = (visibility) => visibility === 'visible-blurred' || visibility === 'hidden';
export function awayStep(visibility, { paused, away }) {
  if (!isAway(visibility)) return { pause: false, play: !!away, away: false };
  return { pause: !paused, play: false, away: !!away || !paused };
}

// A report of 2026-11-09 (Quest 3S): the Meta menu was opened, the Wi-Fi changed, Done pressed, and the picture stayed
// grey behind the menu bar. Nothing brought it back. Only a restart of the headset did. The page cannot close the
// headset's menu. It can end its own session, so the headset shows the Browser again and "Watch in VR" is one tap away.
// After 60 s out of focus (menu or hidden) the session ends. Back in focus before that: nothing ends.
export const AWAY_END_MS = 60_000;

// media: the video (paused, pause(), play()). endSession: ends the VR session. log(type, data): optional.
export class AwayGuard {
  constructor({ media, endSession, log = () => {}, endAfterMs = AWAY_END_MS }) {
    Object.assign(this, { media, endSession, log, endAfterMs, paused: false, timer: null });
  }

  // The headset reported a new visibility state.
  change(visibility) {
    const step = awayStep(visibility, { paused: this.media.paused, away: this.paused });
    this.paused = step.away;
    if (step.pause) this.media.pause();
    if (step.play) Promise.resolve(this.media.play()).catch((err) => this.log('resume-failed', { message: err.message }));
    if (!isAway(visibility)) return this.stopTimer();
    // The clock starts when you first leave. A change from menu to hidden does not restart it.
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.log('away-end', { seconds: this.endAfterMs / 1000 });
        this.endSession();
      }, this.endAfterMs);
    }
  }

  // A session starts or ends: forget everything, so nothing plays or ends later by itself.
  reset() {
    this.paused = false;
    this.stopTimer();
  }

  stopTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------- panel reveal and VR180 turn

export const PANEL_LOOK_AWAY = 0.6; // radians, about 35 degrees between your line of sight and the panel
export const PANEL_IDLE_MS = 8000;

export const PANEL_GRACE_MS = 1500;
// The start-up menu shows on the first starts only: you learn the double pinch, then it stops being in the way.
// (The log of 2026-11-03: 5 of 5 start-up menus were closed by a pinch, after 2.5 s in the middle.)
export const START_MENU_TIMES = 3;

// A panel you opened with a double pinch hides when you look away (more than about 35 degrees), even with a hand on
// it: a hand that rests near the panel must not hold it in front of the film. Two short exceptions, 1.5 s each: just
// after it opened (your head is still moving from the double pinch), and while a pinch presses it or just after one
// did (you look up at the picture while you scrub). The log of 2026-11-03: 4 of 7 look-away closes came within 1.2 s
// of a press, and 4 of 7 were followed by a new double pinch within 3 s.
// While you look at it, a hand on it keeps it; with no hand on it, it stays for 8 s after a hand last used it.
export function pinchedPanelStays({ angle, idleMs, busy = false, sinceOpenMs = Infinity, sincePressMs = Infinity }) {
  if (angle >= PANEL_LOOK_AWAY) return Math.min(sinceOpenMs, sincePressMs) < PANEL_GRACE_MS;
  return busy || idleMs < PANEL_IDLE_MS;
}

// Where a panel or a message goes: `distance` metres from the head, `below` radians under your line of sight.
// It follows the way you face (heading: a level unit vector) and how far you look up or down (pitch),
// so it is in front of you when you sit up, sit back or lie down.
export function placeInView(head, heading, pitch, { distance, below }) {
  const p = Math.max(-1.3, Math.min(1.2, pitch - below));
  return [head.x + heading.x * Math.cos(p) * distance, head.y + Math.sin(p) * distance, head.z + heading.z * Math.cos(p) * distance];
}

// Two quick pinches with one hand, like a double click. The player uses it to open and close the menu.
// down(now, info) is a pinch starting, up(now) a pinch ending. down() returns the first pinch's `info` when the
// pair is complete, else null. The first pinch must end within `maxHoldMs` (a longer pinch is a grab),
// and the second must start within `maxGapMs` of the first.
export class DoublePinch {
  constructor({ maxGapMs = 450, maxHoldMs = 350 } = {}) {
    this.maxGapMs = maxGapMs;
    this.maxHoldMs = maxHoldMs;
    this.first = null; // { at, info, released }
  }

  down(now, info = {}) {
    const f = this.first;
    if (f && f.released && now - f.at <= this.maxGapMs) {
      this.first = null; // a third pinch starts a new pair
      return f.info;
    }
    this.first = { at: now, info, released: false };
    return null;
  }

  up(now) {
    const f = this.first;
    if (!f || f.released) return;
    if (now - f.at <= this.maxHoldMs) f.released = true;
    else this.first = null;
  }

  cancel() {
    this.first = null;
  }
}

export const VR180_PITCH_LIMIT = 0.8;

// Direction from the head to a point: yaw (+ = to the right) and pitch (+ = up), in radians.
export function aimAngles(head, point) {
  const dx = point[0] - head.x;
  const dy = point[1] - head.y;
  const dz = point[2] - head.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return { yaw: 0, pitch: 0 }; // no direction (atan2 would say 180 degrees)
  return { yaw: Math.atan2(dx, -dz), pitch: Math.asin(dy / length) };
}

// Grab the VR180 picture and turn it: it follows the hand's change of direction (a0 to a).
export function dragAngles(start, a0, a) {
  const dyaw = Math.atan2(Math.sin(a.yaw - a0.yaw), Math.cos(a.yaw - a0.yaw)); // the short way round
  const pitch = Math.min(VR180_PITCH_LIMIT, Math.max(-VR180_PITCH_LIMIT, start.pitch + (a.pitch - a0.pitch)));
  return { yaw: start.yaw + dyaw, pitch };
}

// ---------------------------------------------------------------- gesture zone and swipe

// A flick of the right hand skips forward 1 min. A flick of the left hand goes back 30 s.
// Forward was 30 s up to 0.1.1. The log of 2026-11-04 to 11-10: 265 of 284 flicks went forward, and 150 of those were
// in a run (two or more, each within 2.5 s of the one before). Back stays short: it is for the moment you just missed.
const SKIP_FORWARD_SECONDS = 60;
const SKIP_BACK_SECONDS = 30;
export const flickSeconds = (hand) => (hand === 'right' ? SKIP_FORWARD_SECONDS : -SKIP_BACK_SECONDS);

// The message after a skip. seconds: the total of a run of skips, + = forward.
// "+1 min >>", "+3 min >>", "<< -30 s", "<< -1 min 30 s".
export function skipLabel(seconds) {
  const total = Math.abs(seconds);
  const min = Math.floor(total / 60);
  const s = total % 60;
  const amount = [min && `${min} min`, s && `${s} s`].filter(Boolean).join(' ');
  return seconds > 0 ? `+${amount} >>` : `<< -${amount}`;
}

export const LOW_VIEW_ANGLE = 0.44; // radians, about 25 degrees: the bottom quarter of what you see

// Only a hand you can see counts for pinch, zoom, turn, grab and swipe. A hand in the bottom quarter of your view
// (more than about 25 degrees below your line of sight), behind you or out of reach is ignored. A hand resting on
// your leg is ignored: relaxed fingers often rest within 2 cm of the thumb and look like a pinch.
// The zone turns with your head, so it works when you sit up, sit back or lie down.
// point = [x, y, z] of the hand. head = the head position. view = { forward, up }: unit vectors of the head.
export function inGestureZone(point, head, view, { lowAngle = LOW_VIEW_ANGLE, maxReach = 0.9 } = {}) {
  const dx = point[0] - head.x;
  const dy = point[1] - head.y;
  const dz = point[2] - head.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0 || length > maxReach) return false;
  const ahead = dx * view.forward.x + dy * view.forward.y + dz * view.forward.z; // + = in front of your face
  const above = dx * view.up.x + dy * view.up.y + dz * view.up.z; // + = above your line of sight
  return ahead >= -0.1 && Math.asin(Math.max(-1, Math.min(1, above / length))) >= -lowAngle;
}

// A swipe: a quick, clear, mostly sideways flick of an open hand, in ONE direction (+1 = to your right, -1 = to your left).
// The player uses it inward, from the edge toward the centre: the right hand flicks left, the left hand flicks right.
// The stroke back the other way is ignored. After a swipe, the next one needs a NEW stroke: the hand must first come
// back `rearm` metres. So flicks repeated quickly all count, and one long sweep counts once.
// sample = { side, up, depth, now }: where the hand is across your body (+ = right), its height, its distance
// away from your face (metres), and the time (ms). Call reset() whenever the hand is not usable.
export class SwipeDetector {
  constructor({ distance = 0.15, maxMs = 350, minSpeed = 0.7, cooldownMs = 250, windowMs = 450, rearm = 0.04 } = {}) {
    Object.assign(this, { distance, maxMs, minSpeed, cooldownMs, windowMs, rearm });
    this.samples = [];
    this.cooldownUntil = 0;
    this.furthest = null; // after a swipe: how far the hand went the swipe way. null = armed
    this.last = null; // the strongest stroke of the last moments: { distance, speed, at }
  }

  reset() {
    this.samples.length = 0; // a hand that leaves and comes back starts fresh: it is armed again
    this.furthest = null;
  }

  update(sample, direction) {
    const s = this.samples;
    s.push(sample);
    while (s.length && sample.now - s[0].now > this.windowMs) s.shift();
    if (this.furthest !== null) { // after a swipe: wait for the hand to come back
      if ((sample.side - this.furthest) * direction > 0) this.furthest = sample.side;
      else if ((this.furthest - sample.side) * direction >= this.rearm) this.furthest = null;
    }
    let fired = false;
    for (const old of s) {
      const dt = sample.now - old.now;
      if (dt <= 0 || dt > this.maxMs) continue;
      const along = (sample.side - old.side) * direction; // metres moved the swipe way
      if (along < 0.04) continue;
      const speed = along / (dt / 1000);
      const across = Math.max(Math.abs(sample.up - old.up), Math.abs(sample.depth - old.depth));
      if (along >= 0.06) {
        // Keep the peak distance and the peak speed of this stroke, for the panel. They reset after 2 s of calm.
        if (!this.last || sample.now - this.last.at > 2000) this.last = { distance: along, speed, at: sample.now };
        else this.last = { distance: Math.max(this.last.distance, along), speed: Math.max(this.last.speed, speed), at: sample.now };
      }
      const clear = along >= this.distance && speed >= this.minSpeed && along >= 2 * across;
      if (clear && this.furthest === null && sample.now >= this.cooldownUntil) fired = true;
    }
    // The stroke stays in the samples (the other hand's swipe check reads it): it cannot fire again, because
    // the hand must first come back.
    if (fired) {
      this.cooldownUntil = sample.now + this.cooldownMs;
      this.furthest = sample.side;
    }
    return fired;
  }

  // How far the hand moved `direction` (+1 right, -1 left) in the last `ms` milliseconds, metres.
  travel(direction, ms, now) {
    let most = 0;
    for (const a of this.samples) {
      if (now - a.now > ms) continue;
      for (const b of this.samples) if (b.now > a.now) most = Math.max(most, (b.side - a.side) * direction);
    }
    return most;
  }
}

// Prayer hands count lower than other gestures: you press your palms together at chest height. Hands in your lap
// are still further down (60 degrees and more below where you look).
export const PRAYER_LOW_ANGLE = 0.87; // radians, about 50 degrees below the line of sight

// Pause and play: prayer hands, like a clap that stays. Both palms press together (their centres close) and the
// middle fingertips touch. Neither hand pinches, so a two-hand pinch zoom never counts. It fires when held for
// `holdMs` (a quick clap does nothing), and again only after the palms are seen apart. The tracker tends to hold
// touching hands a little apart, and touching hands can hide each other from the headset's cameras: a hand that is
// lost for less than `gapMs` keeps the hold going, and a lost hand never re-arms it.
// hands: [a, b], each null or { palm, middleTip, thumb, index }: points [x, y, z] in metres. now: ms.
export class HandsTogether {
  constructor({ palms = 0.09, tips = 0.07, apart = 0.12, open = 0.035, holdMs = 200, gapMs = 200, cooldownMs = 1000 } = {}) {
    Object.assign(this, { palms, tips, apart, open, holdMs, gapMs, cooldownMs });
    this.since = null; // when the hands came together
    this.lastTogether = 0;
    this.waiting = false; // fired: wait until the palms are seen apart
    this.cooldownUntil = 0;
  }

  update([a, b], now) {
    if (!a || !b) {
      if (this.since !== null && now - this.lastTogether > this.gapMs) this.since = null;
      return false;
    }
    const palmGap = dist(a.palm, b.palm);
    if (this.waiting) {
      if (palmGap > this.apart) this.waiting = false;
      return false;
    }
    const together = palmGap < this.palms && dist(a.middleTip, b.middleTip) < this.tips
      && dist(a.thumb, a.index) > this.open && dist(b.thumb, b.index) > this.open;
    if (!together) {
      this.since = null; // seen apart: a clap that did not stay
      return false;
    }
    if (this.since === null) this.since = now;
    this.lastTogether = now;
    if (now - this.since < this.holdMs || now < this.cooldownUntil) return false;
    this.waiting = true;
    this.since = null;
    this.cooldownUntil = now + this.cooldownMs;
    return true;
  }
}

// Passthrough on: a VR180 picture covers your whole front view, so it becomes this see-through (1 = solid)
// and the room shows through it. A flat screen stays solid: the room is all round it.
export const SEE_THROUGH = 0.5;

// ---------------------------------------------------------------- the video list

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// How the page orders the list: 'name', 'new' or 'old' (newest or oldest first), 'big' or 'small' (largest or
// smallest first). Items have { name, date, size } (date: ms). Ties keep the name order. key: the name to sort by
// ('path' for a search, whose results show their path).
export function compareBy(how, key = 'name') {
  const names = (a, b) => byName(a[key] || '', b[key] || '');
  if (how === 'new') return (a, b) => (b.date || 0) - (a.date || 0) || names(a, b);
  if (how === 'old') return (a, b) => (a.date || 0) - (b.date || 0) || names(a, b);
  if (how === 'big') return (a, b) => (b.size || 0) - (a.size || 0) || names(a, b);
  if (how === 'small') return (a, b) => (a.size || 0) - (b.size || 0) || names(a, b);
  return names;
}

// One level of a video folder, for the page. files = [{ path: 'a/b/c.mp4', name, size, date }] with '/' between parts.
// dir = '' (the top) or 'a/b'. Returns the subfolders one level down and the videos at this level, both in the
// order `how`. A subfolder has the number of videos under it, their total size and the date of the newest one.
export function listFolder(files, dir, how = 'name') {
  const prefix = dir ? `${dir}/` : '';
  const sub = new Map();
  const here = [];
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      here.push(f);
      continue;
    }
    const name = rest.slice(0, slash);
    const s = sub.get(name) || { name, count: 0, size: 0, date: 0 };
    s.count++;
    s.size += f.size || 0;
    s.date = Math.max(s.date, f.date || 0);
    sub.set(name, s);
  }
  const order = compareBy(how);
  return { folders: [...sub.values()].sort(order), files: here.sort(order) };
}

export const parentDir = (dir) => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');

// 3.4 GB, 850 MB. Units of 1024, like Windows File Explorer.
export function formatSize(bytes) {
  if (!(bytes >= 0)) return '';
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1073741824) return `${Math.round(bytes / 1048576)} MB`;
  const gb = bytes / 1073741824;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

// ---------------------------------------------------------------- subtitles

// Windows-1252 bytes 0x80 to 0x9F. Node's TextDecoder reads them as Latin-1 control codes, so ’ œ … € would be lost.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f'
  + '\u0090‘’“”•–—˜™š›œ\u009džŸ';

// The text of a subtitle file from its bytes: UTF-8 (with or without a BOM), UTF-16 with a BOM, else Windows-1252
// (many older .srt files, French ones among them, are not UTF-8).
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    let out = '';
    for (const x of b) out += x >= 0x80 && x < 0xa0 ? CP1252[x - 0x80] : String.fromCharCode(x);
    return out;
  }
}

// The plain words of one subtitle: no <i>, <font> or {\an8} marks, no HTML entities, no empty lines.
export function cleanCueText(text) {
  return text.replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lrm;|&rlm;|[‎‏]/g, '')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

const STAMP = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})`;
const TIMING = new RegExp(String.raw`^\s*${STAMP}\s*-->\s*${STAMP}`);
const toSeconds = (h, m, s, ms) => Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

function parseSrtVtt(src) {
  const cues = [];
  let cue = null;
  for (const line of src.split('\n')) {
    const m = TIMING.exec(line);
    if (m) {
      if (cue) {
        if (/^\d+$/.test(cue.lines.at(-1) || '')) cue.lines.pop(); // the next cue's number, with no blank line before it
        cues.push(cue);
      }
      cue = { start: toSeconds(m[1], m[2], m[3], m[4]), end: toSeconds(m[5], m[6], m[7], m[8]), lines: [] };
    } else if (!line.trim()) {
      if (cue) cues.push(cue);
      cue = null;
    } else if (cue) cue.lines.push(line);
  }
  if (cue) cues.push(cue);
  return cues.map(({ start, end, lines }) => ({ start, end, text: cleanCueText(lines.join('\n')) }));
}

const ASS_FIELDS = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
function assSeconds(t) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/.exec((t || '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`) : NaN;
}

function parseAss(src) {
  const cues = [];
  let fields = ASS_FIELDS;
  let events = false;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      events = /^\[events\]$/i.test(line);
      continue;
    }
    if (!events) continue;
    const format = /^format\s*:(.*)$/i.exec(line);
    if (format) {
      fields = format[1].split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    const dialogue = /^dialogue\s*:(.*)$/i.exec(line);
    if (!dialogue) continue;
    const parts = dialogue[1].split(',');
    const field = (name) => {
      const i = fields.indexOf(name);
      return i < 0 ? '' : name === 'text' ? parts.slice(i).join(',') : parts[i] || ''; // the text is last and may hold commas
    };
    const text = field('text');
    if (/\\p[1-9]/.test(text)) continue; // a drawing, not words
    cues.push({ start: assSeconds(field('start')), end: assSeconds(field('end')), text: cleanCueText(text.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ')) });
  }
  return cues;
}

// SRT, WebVTT or ASS/SSA text -> [{ start, end, text }], in seconds, sorted by start. Cues with no words are dropped.
export function parseSubtitles(text) {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const ass = /^\s*\[script info\]/i.test(src) || (/^\[events\]/im.test(src) && /^dialogue\s*:/im.test(src));
  return (ass ? parseAss(src) : parseSrtVtt(src))
    .filter((c) => c.text && Number.isFinite(c.start) && c.end > c.start)
    .sort((a, b) => a.start - b.start);
}

// The words to show at `t` seconds: every cue that covers t, in order. '' when there are none.
export function cueText(cues, t) {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) { // the first cue that starts after t
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo - 1; i >= 0 && i >= lo - 30; i--) if (cues[i].end > t) out.unshift(cues[i].text);
  return out.join('\n');
}

// Breaks subtitle words into lines no wider than maxWidth (measure(text) gives the width). The cue's own line breaks
// stay. At most maxLines lines.
export function wrapLines(text, maxWidth, measure, maxLines = 3) {
  const out = [];
  for (const part of text.split('\n')) {
    let line = '';
    for (const word of part.split(/\s+/).filter(Boolean)) {
      const longer = line ? `${line} ${word}` : word;
      if (!line || measure(longer) <= maxWidth) line = longer;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out.slice(0, maxLines);
}

// ---------------------------------------------------------------- languages and track names

const B_CODES = { fre: 'fra', ger: 'deu', chi: 'zho', dut: 'nld', cze: 'ces', gre: 'ell', rum: 'ron', slo: 'slk', baq: 'eus',
  may: 'msa', per: 'fas', arm: 'hye', geo: 'kat', ice: 'isl', mac: 'mkd', alb: 'sqi', bur: 'mya', tib: 'bod', wel: 'cym',
  scc: 'srp', scr: 'hrv' };
const NOT_A_LANGUAGE = new Set(['und', 'unk', 'mis', 'mul', 'zxx', 'qaa', 'none']);
const ALIASES = { frc: 'fr-CA' }; // Jellyfin and OpenSubtitles name Canadian French subtitle files ".frc"
let displayNames;
const languageNames = () => {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      displayNames = null;
    }
  }
  return displayNames;
};

// A language code from a file name or a track ('fr', 'fre', 'fra', 'fr-CA', 'eng') as a short standard tag ('fr',
// 'fr-CA', 'en'), or '' when it is not a language.
export function languageTag(code) {
  const c = String(code || '').trim().replace(/_/g, '-').toLowerCase();
  if (!c || NOT_A_LANGUAGE.has(c) || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(c)) return '';
  if (ALIASES[c]) return ALIASES[c];
  const [lang, ...rest] = c.split('-');
  try {
    return new Intl.Locale([B_CODES[lang] || lang, ...rest].join('-')).toString();
  } catch {
    return '';
  }
}

// 'fre' -> 'French', 'fr-CA' -> 'Canadian French'. '' when the code is not a known language.
export function languageName(code) {
  const tag = languageTag(code);
  const names = languageNames();
  if (!tag || !names) return '';
  try {
    const name = names.of(tag);
    return name && name.toLowerCase() !== tag.toLowerCase() ? name : '';
  } catch {
    return '';
  }
}

// The main language only, for matching a remembered choice: 'fr-CA', 'fre' and 'fra' -> 'fr'.
export const baseLanguage = (code) => languageTag(code).split('-')[0];

const COMMON = ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'nb', 'fi', 'pl', 'cs', 'sk', 'hu', 'ro', 'el', 'tr',
  'ru', 'uk', 'ar', 'he', 'zh', 'ja', 'ko', 'th', 'vi', 'id', 'ms', 'hi', 'bn', 'bg', 'hr', 'sr', 'sl', 'et', 'lv', 'lt', 'ca',
  'eu', 'gl', 'fil', 'ta', 'te', 'kn', 'ml', 'fa', 'ur', 'is', 'ga', 'cy', 'sq', 'mk', 'bs', 'af', 'sw'];
const NATIVE = { francais: 'fr', français: 'fr', espanol: 'es', español: 'es', deutsch: 'de', italiano: 'it', portugues: 'pt',
  português: 'pt', nederlands: 'nl', svenska: 'sv', dansk: 'da', norsk: 'no', suomi: 'fi', polski: 'pl' };
let byEnglishName;
// 'english' -> 'en': subtitle files named like "2_English.srt".
function languageFromName(word) {
  if (!byEnglishName) {
    byEnglishName = new Map(Object.entries(NATIVE));
    for (const code of COMMON) {
      const name = languageName(code).toLowerCase();
      if (name && !byEnglishName.has(name)) byEnglishName.set(name, code);
    }
  }
  return byEnglishName.get(word.toLowerCase()) || '';
}

// The words after the video's name in a subtitle file name (".eng.hi" of "Film.eng.hi.srt"), or a whole name in a
// Subs folder ("2_English"): { language, hi, forced, extra }. hi = for the hard of hearing (SDH).
export function readSubtitleTag(tag) {
  let language = '';
  let hi = false;
  let forced = false;
  const extra = [];
  for (const word of String(tag || '').split(/[\s._[\]()]+/).filter(Boolean)) {
    const w = word.toLowerCase();
    if (w === 'forced') forced = true;
    else if (['sdh', 'cc', 'hoh'].includes(w) || (w === 'hi' && language)) hi = true; // alone, "hi" is Hindi
    else if (/^\d+$/.test(w) || w === 'default' || w === 'full') continue;
    else if (!language && (languageFromName(w) || (w.length <= 6 && languageName(w)))) language = languageFromName(w) || word;
    else extra.push(word);
  }
  return { language, hi, forced, extra: extra.join(' ') };
}

// The words of a subtitle file's name that tell its language, for a file picked on the headset: what follows the
// video's own name ("Film.en.srt" with "Film.mkv" -> "en"), else the language and flag words at the end of the name
// ("Film.2016.720p.en.forced" -> "en.forced"), else the whole name when it has no dot ("2_English").
// A movie title must not count: "Bad" in "Batman.Bad.Blood" is also a language code (Banda).
export function subtitleTag(subName, videoName = '') {
  const base = subName.replace(/\.[^.]+$/, '');
  const video = videoName.replace(/\.[^.]+$/, '');
  if (video && base.toLowerCase() === video.toLowerCase()) return '';
  if (video && base.toLowerCase().startsWith(`${video.toLowerCase()}.`)) return base.slice(video.length + 1);
  const parts = base.split('.');
  if (parts.length === 1) return base;
  const tail = [];
  for (let i = parts.length - 1; i > 0; i--) {
    const w = parts[i].toLowerCase();
    if (!['forced', 'sdh', 'cc', 'hoh', 'hi'].includes(w) && !languageFromName(w) && !(w.length <= 3 && languageName(w))) break;
    tail.unshift(parts[i]);
  }
  return tail.join('.');
}

// Cues ([start, end, text], seconds) as an SRT file, so a laptop video's subtitles can go to the headset with it.
export function cuesToSrt(cues) {
  const time = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const two = (n) => String(n).padStart(2, '0');
    return `${two(Math.floor(ms / 3_600_000))}:${two(Math.floor(ms / 60_000) % 60)}:${two(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`;
  };
  return cues.map(([start, end, text], i) => `${i + 1}\r\n${time(start)} --> ${time(end)}\r\n${text.replace(/\r?\n/g, '\r\n')}\r\n`).join('\r\n');
}

// A subtitle choice for the menu: its language, its flags, and a label people read ("English (SDH)").
// s: from the laptop: { source: 'video', language, title, forced, hi } or { source: 'file', tag }.
export function describeSubtitle(s) {
  const fromTag = s.source === 'file' ? readSubtitleTag(s.tag) : { language: '', hi: false, forced: false, extra: '' };
  const language = s.language && languageTag(s.language) ? s.language : fromTag.language;
  const hi = !!(s.hi || fromTag.hi);
  const forced = !!(s.forced || fromTag.forced);
  const lang = languageName(language);
  const title = (s.title || '').trim() || fromTag.extra;
  let label = title && (!lang || title.toLowerCase().includes(lang.toLowerCase())) ? title : [lang, title].filter(Boolean).join(' · ');
  if (!label) label = s.source === 'file' ? 'Subtitle file' : 'Subtitles';
  if (forced && !/forced/i.test(label)) label += ' (forced)';
  if (hi && !/sdh|hearing|\bcc\b|\bhi\b/i.test(label)) label += ' (SDH)';
  return { ...s, language, hi, forced, label };
}

const CHANNELS = { 1: 'mono', 2: 'stereo', 6: '5.1', 7: '6.1', 8: '7.1' };
// An audio track for the menu: "English · 5.1", "French · stereo", "Commentary · stereo".
export function audioLabel(a, i = 0) {
  const lang = languageName(a.language);
  const title = (a.title || '').trim();
  const name = (title && (!lang || title.toLowerCase().includes(lang.toLowerCase())) ? title : [lang, title].filter(Boolean).join(' · '))
    || `Track ${i + 1}`;
  const ch = CHANNELS[a.channels] || (a.channels ? `${a.channels} ch` : '');
  return ch && !name.includes(ch) ? `${name} · ${ch}` : name;
}

// Two choices with the same label get a number: "English", "English 2".
export function numberSameLabels(labels) {
  const seen = new Map();
  return labels.map((label) => {
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} ${n}`;
  });
}

// The choices in the order the menu shows them: the languages in `langs` first (your last choice, then the
// browser's languages), then the rest in the file's order.
export function orderByLanguage(options, langs) {
  const rank = (o) => {
    const i = langs.indexOf(baseLanguage(o.language));
    return i < 0 ? langs.length : i;
  };
  return options.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map(({ o }) => o);
}

// The subtitle to switch on for a remembered choice ({ lang, hi, forced }), or null (none, or not in this video).
export function pickSubtitle(options, pref) {
  if (!pref || !pref.lang) return null;
  const same = options.filter((o) => baseLanguage(o.language) === pref.lang);
  return same.find((o) => o.hi === !!pref.hi && o.forced === !!pref.forced) || same.find((o) => !o.forced) || same[0] || null;
}

// ---------------------------------------------------------------- another audio track, in time with the video

// One check of the laptop's audio track against the video (the page runs it 4 times a second).
// drift = audio time - video time, in seconds. Apart by more than 0.15 s (after a seek, or while one of them loaded:
// you would see the lips move out of time): jump to the video's time. A little apart: play the audio up to 5 %
// slower or faster until it is in time again (too little to hear).
// Returns { jump, rate }: jump = set the audio's time to the video's; rate = the audio's speed now.
export function syncAudio(drift, rate) {
  if (!Number.isFinite(drift) || Math.abs(drift) > 0.15) return { jump: true, rate };
  if (Math.abs(drift) < 0.03) return { jump: false, rate };
  return { jump: false, rate: rate * (1 - Math.max(-0.05, Math.min(0.05, drift))) };
}
