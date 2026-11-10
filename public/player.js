import * as THREE from 'three';
import { createHandMesh, updateHandMesh, JOINT_NAMES } from './hands.js';
import { addMeshHand, handMaterial, HAND_COLOR, PINCH_COLOR } from './handmesh.js';
import {
  guessLayout, flatAspect, eyeRegion, flatUv, hemisphere, fisheye, FISHEYE_FOV, clampZoom, GestureTracker, remoteGrab,
  clampScreenScale, PokeDetector, PANEL_W, PANEL_H, panelLayout, buttonAt, seekFraction, LIST_SLOTS,
  formatTime, describeInputs, pinchedPanelStays, PANEL_LOOK_AWAY, START_MENU_TIMES, placeInView, aimAngles,
  dragAngles, inGestureZone, SwipeDetector, SKIP_SECONDS, DoublePinch, HandsTogether, PRAYER_LOW_ANGLE, SEE_THROUGH, listFolder, parentDir,
  SPEED_PRESETS, SPEED_MIN, SPEED_MAX, clampSpeed, stepSpeed, formatSpeed, compareBy, formatSize, cueText, wrapLines, decodeText,
  parseSubtitles, describeSubtitle, audioLabel, numberSameLabels, orderByLanguage, pickSubtitle, baseLanguage, syncAudio,
  readFrames, keyCbCr, CUT_WIDTH, colourName, subtitleTag, AwayGuard,
} from './core.js';

const $ = (id) => document.getElementById(id);

const FRAMEBUFFER_SCALE = 1.5; // sharper video, more GPU work. Lower it if the headset runs hot.
const SCREEN_HEIGHT = 2; // metres, flat screen at scale 1
const SCREEN_START = new THREE.Vector3(0, 0, -3);

const state = {
  projection: 'vr180',
  stereo: 'sbs',
  zoom: 1, // zoom now on screen (smoothed)
  zoomTarget: 1,
  screenPos: SCREEN_START.clone(),
  screenScale: 1,
  yaw: 0, // VR180 picture turned by the hand: + = to the right, radians
  pitch: 0, // + = up
  passthrough: false, // this is a passthrough session: the real room can show
  roomOn: true, // passthrough session only: the room shows (true) or is hidden in black (false)
  fov: FISHEYE_FOV, // fisheye only: the lens angle, degrees
  alpha: false, // fisheye only: a passthrough video with its cut-out mask packed in the red corners
  background: null, // a passthrough video with a filled background, cut in your room: { kind, rgb, edge } (core.js)
};

// ------------------------------------------------------------------ video + renderer

const video = document.createElement('video');
video.playsInline = true;
video.preload = 'auto';

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true }); // alpha: passthrough needs a transparent background
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
renderer.xr.setFramebufferScaleFactor(FRAMEBUFFER_SCALE);
renderer.xr.setFoveation(0);
renderer.domElement.style.display = 'none';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);

const texture = new THREE.VideoTexture(video);
texture.colorSpace = THREE.SRGBColorSpace;

// A passthrough session with passthrough OFF: a black sphere round your head hides the real room.
// It is drawn before the picture, so the picture stays on top of it.
const roomCover = new THREE.Mesh(
  new THREE.SphereGeometry(40, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, depthWrite: false, toneMapped: false }),
);
roomCover.renderOrder = -2;
roomCover.frustumCulled = false;
roomCover.visible = false;
scene.add(roomCover);

// ------------------------------------------------------------------ the picture

const world = new THREE.Group();
scene.add(world);
let eyeMeshes = [];
const head = new THREE.Vector3();
const headDir = new THREE.Vector3(); // where the head looks
const headUp = new THREE.Vector3(0, 1, 0); // the top of the head: "up" in what you see
const headQuat = new THREE.Quaternion();
const heading = new THREE.Vector3(0, 0, -1); // which way the user faces, level (used to place the panel)
let viewPitch = 0; // how far you look up (+) or down (-), radians

function clearWorld() {
  for (const { mesh } of eyeMeshes) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  world.clear();
  eyeMeshes = [];
}

// The curved picture of one eye: a half-sphere (VR180), or a sphere cap drawn from a fisheye circle.
const curved = (region) => (state.projection === 'fisheye'
  ? fisheye({ zoom: state.zoom, region, fov: state.fov })
  : hemisphere({ zoom: state.zoom, region }));

// A passthrough video's mask: on (1) it cuts the picture out, so the room shows round the person. Both eyes share it.
const packedOn = { value: 0 };
// A filled background, cut in your room: mode 0 = off, 1 = a colour, 2 = black. cbcr: the colour's CbCr.
// range: where the soft cut starts and ends (a CbCr distance, or a brightness).
const cut = { mode: { value: 0 }, cbcr: { value: new THREE.Vector2() }, range: { value: new THREE.Vector2() } };

// Teach a picture material its cut-outs: the mask from the red corners (packedAlphaAt() in core.js), or a filled
// background (backgroundKeep() in core.js: the same sums, on the colour as filmed).
function readCutOut(material, eye, region) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPacked = packedOn;
    shader.uniforms.uRightEye = { value: eye === 'right' ? 1 : 0 };
    shader.uniforms.uRegion = { value: new THREE.Vector4(region.u0, region.v0, region.du, region.dv) };
    shader.uniforms.uCut = cut.mode;
    shader.uniforms.uCutCbCr = cut.cbcr;
    shader.uniforms.uCutRange = cut.range;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uPacked;
uniform float uRightEye;
uniform vec4 uRegion;
uniform float uCut;
uniform vec2 uCutCbCr;
uniform vec2 uCutRange;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
if (uPacked > 0.5) {
  vec2 e = (vMapUv - uRegion.xy) / uRegion.zw; // where in this eye's square: 0..1, y up
  float down = 1.0 - e.y;
  float V = down < 0.5 ? 0.8 + down * 0.4 : (down - 0.5) * 0.4;
  float U = uRightEye < 0.5 ? 0.4 + e.x * 0.2 : (e.x < 0.5 ? 0.9 + e.x * 0.2 : (e.x - 0.5) * 0.2);
  diffuseColor.a *= texture2D(map, vec2(U, 1.0 - V)).r;
}
if (uCut > 0.5) {
  vec3 s = sRGBTransferOETF(vec4(diffuseColor.rgb, 1.0)).rgb; // the colour as filmed, 0..1
  float far = uCut < 1.5
    ? distance(vec2(-0.1687 * s.r - 0.3313 * s.g + 0.5 * s.b, 0.5 * s.r - 0.4187 * s.g - 0.0813 * s.b), uCutCbCr)
    : dot(s, vec3(0.2126, 0.7152, 0.0722));
  if (uCut < 1.5) {
    // the person's edge: take out the background colour's tint (grey near the cut, none past it)
    float tint = 1.0 - smoothstep(uCutRange.x, uCutRange.y + 0.08, far);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), tint);
  }
  diffuseColor.a *= smoothstep(uCutRange.x, uCutRange.y, far);
}`);
  };
}

// Left eye = layer 1, right eye = layer 2, 2D = layer 0 (both eyes).
function rebuild() {
  clearWorld();
  const eyes = state.stereo === 'mono'
    ? [{ eye: 'left', layer: 0 }]
    : [{ eye: 'left', layer: 1 }, { eye: 'right', layer: 2 }];
  for (const { eye, layer } of eyes) {
    const region = eyeRegion(state.stereo, eye);
    let geometry;
    if (state.projection !== 'flat') {
      const g = curved(region);
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(g.position, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2).setUsage(THREE.DynamicDrawUsage));
      geometry.setIndex(new THREE.BufferAttribute(g.index, 1));
    } else {
      geometry = new THREE.PlaneGeometry(1, 1);
      geometry.setAttribute('uv', new THREE.BufferAttribute(flatUv(region), 2));
    }
    // transparent: so a VR180 picture can be see-through in passthrough. At opacity 1 it looks the same as solid.
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false, depthWrite: false, transparent: true });
    readCutOut(material, eye, region);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(layer);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    world.add(mesh);
    eyeMeshes.push({ region, mesh });
  }
  applyFlatTransform();
  applyRoom();
}

// Passthrough session: the room shows, or the black sphere hides it. With the room showing, a passthrough video
// is cut out round the person (by its mask, or by its filled background); any other VR180 or fisheye picture
// (which covers your whole front view) is see-through. A flat screen stays solid. A plain VR session never shows
// the room.
function applyRoom() {
  const roomShows = state.passthrough && state.roomOn;
  roomCover.visible = state.passthrough && !state.roomOn;
  packedOn.value = roomShows && state.alpha && state.projection === 'fisheye' ? 1 : 0;
  const bg = roomShows && !packedOn.value ? state.background : null;
  cut.mode.value = bg ? (bg.kind === 'black' ? 2 : 1) : 0;
  if (bg) {
    cut.cbcr.value.set(...keyCbCr(bg.rgb));
    cut.range.value.set(bg.edge, bg.edge + CUT_WIDTH[bg.kind]);
  }
  const seeThrough = roomShows && state.projection !== 'flat' && !packedOn.value && !cut.mode.value;
  for (const { mesh } of eyeMeshes) mesh.material.opacity = seeThrough ? SEE_THROUGH : 1;
}

function refreshZoomGeometry() {
  for (const { region, mesh } of eyeMeshes) {
    const g = curved(region);
    const { position, uv } = mesh.geometry.attributes;
    position.array.set(g.position);
    position.needsUpdate = true;
    uv.array.set(g.uv);
    uv.needsUpdate = true;
  }
}

// Flat mode: the screen is one object. VR180 and fisheye: the curved picture follows the head each frame.
function applyFlatTransform() {
  if (state.projection !== 'flat') {
    world.scale.setScalar(1);
    world.rotation.set(state.pitch, -state.yaw, 0, 'YXZ'); // content moves right when yaw grows
    return;
  }
  const aspect = flatAspect(state.stereo, video.videoWidth, video.videoHeight);
  world.scale.set(aspect * SCREEN_HEIGHT * state.screenScale, SCREEN_HEIGHT * state.screenScale, 1);
  world.position.copy(state.screenPos);
  world.lookAt(head);
}

function resetView() {
  state.zoomTarget = 1;
  state.screenPos.copy(SCREEN_START);
  state.screenScale = 1;
  state.yaw = 0;
  state.pitch = 0;
  applyFlatTransform();
}

// ------------------------------------------------------------------ control panel

const panelCanvas = document.createElement('canvas');
panelCanvas.width = PANEL_W;
panelCanvas.height = PANEL_H;
const ctx = panelCanvas.getContext('2d');
const panelTexture = new THREE.CanvasTexture(panelCanvas);
panelTexture.colorSpace = THREE.SRGBColorSpace;

const PANEL_WIDTH_M = 0.34; // at 0.6 m: about 32 by 13 degrees of your view
const PANEL_HEIGHT_M = (PANEL_WIDTH_M * PANEL_H) / PANEL_W;
const PANEL_MARGIN_M = 0.05; // a ray this close to the edge counts as on the panel: a near miss presses and closes nothing
const panel = new THREE.Mesh(
  new THREE.PlaneGeometry(PANEL_WIDTH_M, PANEL_HEIGHT_M),
  new THREE.MeshBasicMaterial({ map: panelTexture, toneMapped: false, transparent: true, opacity: 0 }),
);
panel.visible = false; // it appears when you double pinch, and is placed where you look
panel.renderOrder = 6; // over the subtitles
scene.add(panel);
// how: 'pinch' = a double pinch: it hides when you look away, or 8 s after a hand last used it. 'start' = shown for
// 5 s when VR starts, so you know it is there: then it hides, unless a hand is using it.
const panelState = { shown: false, how: 'pinch', opacity: 0, holdUntil: 0, place: false, openedAt: 0, usedAt: 0, pressedAt: -Infinity };

// Gesture numbers, for tuning. A small second plane under the panel, shown only when the page box is ticked.
const debugCanvas = document.createElement('canvas');
debugCanvas.width = PANEL_W;
debugCanvas.height = 100;
const debugCtx = debugCanvas.getContext('2d');
const debugTexture = new THREE.CanvasTexture(debugCanvas);
debugTexture.colorSpace = THREE.SRGBColorSpace;
const DEBUG_HEIGHT_M = (PANEL_WIDTH_M * 100) / PANEL_W;
const debugPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(PANEL_WIDTH_M, DEBUG_HEIGHT_M),
  new THREE.MeshBasicMaterial({ map: debugTexture, toneMapped: false, transparent: true, opacity: 0 }),
);
debugPlane.position.set(0, -(PANEL_HEIGHT_M + DEBUG_HEIGHT_M) / 2 - 0.004, 0);
debugPlane.visible = false;
panel.add(debugPlane);
let debugOn = false;

// Put the panel 0.6 m from the head, 15 degrees below where you look, turned to face you.
function placePanel() {
  panel.position.fromArray(placeInView(head, heading, viewPitch, { distance: 0.6, below: 0.26 }));
  panel.lookAt(head);
  panel.updateMatrixWorld(); // the rays and pokes of this frame read it
}

function openPanel(how, now) {
  Object.assign(panelState, { shown: true, how, place: true, openedAt: now, usedAt: now });
  Object.assign(menu, { page: 'main', start: 0 }); // it always opens on the main page
  logEvent('menu-open', { how });
}

function closePanel(why, extra = {}) {
  if (!panelState.shown) return;
  panelState.shown = false;
  logEvent('menu-close', { why, ...extra });
}

const toPanel = new THREE.Vector3();
function angleToPanel() {
  toPanel.subVectors(panel.position, head).normalize();
  return Math.acos(Math.max(-1, Math.min(1, toPanel.dot(headDir))));
}

// A short message in front of you: "+30 s >>" after a swipe. It fades out by itself.
const toastCanvas = document.createElement('canvas');
toastCanvas.width = 512;
toastCanvas.height = 160;
const toastCtx = toastCanvas.getContext('2d');
const toastTexture = new THREE.CanvasTexture(toastCanvas);
toastTexture.colorSpace = THREE.SRGBColorSpace;
const toast = new THREE.Mesh(
  new THREE.PlaneGeometry(0.32, 0.1),
  new THREE.MeshBasicMaterial({ map: toastTexture, toneMapped: false, transparent: true, opacity: 0, depthTest: false }),
);
toast.visible = false;
toast.renderOrder = 10;
scene.add(toast);
const toastState = { opacity: 0, until: 0 };

function showToast(text, now) {
  toastCtx.clearRect(0, 0, 512, 160);
  toastCtx.fillStyle = 'rgba(16, 20, 27, 0.88)';
  toastCtx.beginPath();
  if (toastCtx.roundRect) toastCtx.roundRect(0, 0, 512, 160, 40);
  else toastCtx.rect(0, 0, 512, 160);
  toastCtx.fill();
  toastCtx.fillStyle = '#f7931a';
  toastCtx.font = 'bold 76px system-ui, sans-serif';
  toastCtx.textAlign = 'center';
  toastCtx.textBaseline = 'middle';
  toastCtx.fillText(text, 256, 84);
  toastTexture.needsUpdate = true;
  toast.position.fromArray(placeInView(head, heading, viewPitch, { distance: 1.0, below: 0.12 }));
  toast.lookAt(head);
  toastState.opacity = 1;
  toastState.until = now + 900;
}

// ------------------------------------------------------------------ subtitles and audio tracks

// What the laptop found for the video shown: its audio tracks and its subtitle choices, with labels and addresses.
// audioChoice: the audio track that plays. nativeSure: false when the browser may play another track by itself.
const tracks = { audio: [], subtitles: [], nativeSure: true, audioChoice: null };
// The subtitles: the choice (null = off), its cues, the timing change in seconds (+ = later), the words drawn now.
const subs = { choice: null, cues: [], loading: false, delay: 0, shown: '' };

const SUB_W = 1280;
const SUB_H = 256;
const subCanvas = document.createElement('canvas');
subCanvas.width = SUB_W;
subCanvas.height = SUB_H;
const subCtx = subCanvas.getContext('2d');
const subTexture = new THREE.CanvasTexture(subCanvas);
subTexture.colorSpace = THREE.SRGBColorSpace;
const subtitle = new THREE.Mesh(
  new THREE.PlaneGeometry(1, SUB_H / SUB_W),
  new THREE.MeshBasicMaterial({ map: subTexture, toneMapped: false, transparent: true, depthTest: false, depthWrite: false }),
);
subtitle.renderOrder = 2; // over the picture, under the menu
subtitle.frustumCulled = false;
subtitle.visible = false;
scene.add(subtitle);

// The words at the bottom of the subtitle canvas, each line on a dark band.
function drawSubtitle(text) {
  subCtx.clearRect(0, 0, SUB_W, SUB_H);
  subCtx.font = 'bold 54px system-ui, sans-serif';
  subCtx.textAlign = 'center';
  subCtx.textBaseline = 'middle';
  const lines = wrapLines(text, SUB_W - 80, (s) => subCtx.measureText(s).width, 3);
  const lineH = 78;
  let y = SUB_H - lines.length * lineH;
  for (const line of lines) {
    const w = Math.min(SUB_W, subCtx.measureText(line).width + 40);
    subCtx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    subCtx.beginPath();
    if (subCtx.roundRect) subCtx.roundRect((SUB_W - w) / 2, y + 4, w, lineH - 8, 14);
    else subCtx.rect((SUB_W - w) / 2, y + 4, w, lineH - 8);
    subCtx.fill();
    subCtx.fillStyle = '#ffffff';
    subCtx.fillText(line, SUB_W / 2, y + lineH / 2 + 1);
    y += lineH;
  }
  subTexture.needsUpdate = true;
}

const subUp = new THREE.Vector3();
const subFront = new THREE.Vector3();
const subTarget = new THREE.Vector3();

// Where the words go. A flat screen: over the bottom of the picture. A VR180 picture: in front of you, a little low,
// following where you look slowly. While the menu shows, just above the menu, so you can read them as you change them.
function placeSubtitle(dt) {
  const text = subs.cues.length ? cueText(subs.cues, video.currentTime - subs.delay) : '';
  if (text !== subs.shown) {
    subs.shown = text;
    drawSubtitle(text);
  }
  subtitle.visible = !!text;
  if (!text) {
    subtitle.userData.placed = false; // the next words appear where you look, with no slide
    return;
  }
  if (panel.visible) {
    subUp.set(0, 1, 0).applyQuaternion(panel.quaternion);
    subtitle.position.copy(panel.position).addScaledVector(subUp, PANEL_HEIGHT_M / 2 + 0.065);
    subtitle.quaternion.copy(panel.quaternion);
    subtitle.scale.setScalar(0.54);
    subtitle.userData.placed = false;
  } else if (state.projection === 'flat') {
    const h = SCREEN_HEIGHT * state.screenScale;
    subUp.set(0, 1, 0).applyQuaternion(world.quaternion);
    subFront.set(0, 0, 1).applyQuaternion(world.quaternion);
    subtitle.position.copy(world.position).addScaledVector(subUp, -0.34 * h).addScaledVector(subFront, 0.01);
    subtitle.quaternion.copy(world.quaternion);
    subtitle.scale.setScalar(1.19 * h); // 4 % above the bottom edge, a line about 7 % of the screen high
  } else {
    subTarget.fromArray(placeInView(head, heading, viewPitch, { distance: 1.4, below: 0.3 }));
    if (subtitle.userData.placed) subtitle.position.lerp(subTarget, 1 - Math.exp(-dt * 2.5));
    else subtitle.position.copy(subTarget);
    subtitle.userData.placed = true;
    subtitle.lookAt(head);
    subtitle.scale.setScalar(1.25);
  }
}

// Another audio track: the laptop sends it as a WAV that plays in time with the muted video (see lib/audio.js).
const sideAudio = new Audio();
sideAudio.preload = 'auto';
let sideOn = false;

function useSideAudio(url) {
  sideOn = !!url;
  video.muted = sideOn;
  if (!url) {
    sideAudio.pause();
    sideAudio.removeAttribute('src');
    sideAudio.load();
    return;
  }
  sideAudio.src = url;
  sideAudio.playbackRate = video.playbackRate;
  sideAudio.currentTime = video.currentTime;
  if (!video.paused) sideAudio.play().catch(() => {});
}

video.addEventListener('pause', () => sideAudio.pause());
video.addEventListener('playing', () => { // at once, not at the next check: else the sound starts up to 0.25 s late
  if (!sideOn) return;
  if (Math.abs(sideAudio.currentTime - video.currentTime) > 0.05) sideAudio.currentTime = video.currentTime;
  sideAudio.play().catch(() => {});
});
video.addEventListener('seeking', () => {
  if (sideOn) sideAudio.currentTime = video.currentTime; // fetch the new place together with the video
});
video.addEventListener('ratechange', () => {
  sideAudio.playbackRate = video.playbackRate;
});
sideAudio.addEventListener('error', () => {
  if (!sideOn) return;
  logEvent('audio-error', { code: sideAudio.error ? sideAudio.error.code : null });
  chooseAudio(tracks.audio.find((a) => a.native) || null);
  showError('That audio track could not play. The video plays its own sound.');
});
// Four times a second: the audio follows the video. It waits while the video loads, and catches up after a seek.
setInterval(() => {
  if (!sideOn) return;
  if (video.paused || video.readyState < 3) {
    if (!sideAudio.paused) sideAudio.pause();
    return;
  }
  const drift = sideAudio.currentTime - video.currentTime;
  if (sideAudio.paused) {
    if (Math.abs(drift) > 0.05) sideAudio.currentTime = video.currentTime;
    sideAudio.play().catch(() => {});
    return;
  }
  if (sideAudio.readyState < 3) return; // still loading after a jump
  const { jump, rate } = syncAudio(drift, video.playbackRate);
  if (jump) sideAudio.currentTime = video.currentTime;
  sideAudio.playbackRate = rate;
}, 250);

// Quick skips the same way add up on the message ("+60 s >>", "+90 s >>"), so you see each one count.
let skipRun = { seconds: 0, at: -Infinity };
function skip(seconds, now) {
  const end = Number.isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.min(end, Math.max(0, video.currentTime + seconds));
  const same = Math.sign(seconds) === Math.sign(skipRun.seconds) && now - skipRun.at < 2500;
  skipRun = { seconds: same ? skipRun.seconds + seconds : seconds, at: now };
  showToast(skipRun.seconds > 0 ? `+${skipRun.seconds} s >>` : `<< ${skipRun.seconds} s`, now);
}

// The menu's pages: 'main', 'subs', 'audio', 'view' (see panelLayout in core.js). start: the first choice shown on
// the Subtitles and Audio pages, six at a time.
const menu = { page: 'main', start: 0 };
const PROJ_NAME = { vr180: 'VR180', fisheye: 'Fisheye', flat: 'Flat screen' };
const STEREO_NAME = { mono: '2D', sbs: 'Side by side', tb: 'Top-bottom' };

// The choices on the Subtitles page (Off first) and on the Audio page.
const subtitleChoices = () => [null, ...tracks.subtitles];
const menuChoices = () => (menu.page === 'subs' ? subtitleChoices() : menu.page === 'audio' ? tracks.audio : []);

// The bottom row of the main page: Subtitles and Audio when the video has them, then View, then Reset view and
// Passthrough while there is room.
function mainExtras() {
  const row = [];
  if (tracks.subtitles.length) row.push('subs');
  if (tracks.audio.length > 1) row.push('audio');
  row.push('view');
  if (row.length < 3) row.push('reset');
  if (row.length < 3 && state.passthrough) row.push('pass');
  return row;
}

const currentLayout = () => panelLayout(menu.page, { extras: mainExtras(), count: menuChoices().length, start: menu.start });
const subtitleName = () => (subs.loading ? 'Loading...' : subs.choice ? subs.choice.label : 'Off');

// A label with a line break is drawn on two lines.
function labelFor(id) {
  if (id === 'home') return 'Home';
  if (id === 'close') return 'X';
  if (id === 'menu') return '‹ Back';
  if (id === 'back') return '-10 s';
  if (id === 'fwd') return '+10 s';
  if (id === 'play') return video.paused ? 'Play' : 'Pause';
  if (id === 'speed-down') return '−';
  if (id === 'speed-up') return '+';
  if (id.startsWith('speed:')) return formatSpeed(Number(id.slice('speed:'.length)));
  if (id === 'subs') return `Subtitles\n${subtitleName()}`;
  if (id === 'audio') return `Audio\n${tracks.audioChoice ? tracks.audioChoice.label : ''}`;
  if (id === 'view') return `View\n${PROJ_NAME[state.projection]} · ${state.stereo === 'mono' ? '2D' : '3D'}`;
  if (id === 'reset') return 'Reset view';
  if (id === 'pass') return `Passthrough\n${state.passthrough ? (state.roomOn ? 'On' : 'Off') : 'only in room view'}`;
  if (id.startsWith('proj:')) return PROJ_NAME[id.slice('proj:'.length)];
  if (id.startsWith('stereo:')) return STEREO_NAME[id.slice('stereo:'.length)];
  if (id === 'prev') return '‹';
  if (id === 'next') return '›';
  if (id === 'earlier') return 'Earlier';
  if (id === 'later') return 'Later';
  if (id.startsWith('item:')) {
    const choice = menuChoices()[Number(id.slice('item:'.length))];
    return choice ? choice.label : 'Off';
  }
  return id;
}

// The words in the places that are not buttons.
function textFor(id) {
  if (id === 'time') return formatTime(video.currentTime);
  if (id === 'duration') return formatTime(video.duration);
  if (id === 'speed') return formatSpeed(video.playbackRate);
  if (id === 'title') return { subs: 'Subtitles', audio: 'Audio', view: 'View' }[menu.page] || '';
  if (id === 'pages') return `${Math.floor(menu.start / LIST_SLOTS) + 1} / ${Math.ceil(menuChoices().length / LIST_SLOTS)}`;
  if (id === 'delay') return `Timing\n${subs.delay ? `${subs.delay > 0 ? '+' : '−'}${Math.abs(subs.delay).toFixed(1)} s` : 'normal'}`;
  if (id === 'label-proj') return 'Picture';
  if (id === 'label-stereo') return '3D';
  return '';
}

// Is a button on (orange), or greyed (it can do nothing now)?
function buttonState(id) {
  const rate = video.playbackRate;
  const n = Number(id.slice(id.indexOf(':') + 1));
  const active = (id === 'play' && !video.paused)
    || (id.startsWith('speed:') && Math.abs(n - rate) < 0.001)
    || (id === 'pass' && state.passthrough && state.roomOn)
    || id === `proj:${state.projection}` || id === `stereo:${state.stereo}`
    || (id.startsWith('item:') && menuChoices()[n] === (menu.page === 'subs' ? subs.choice : tracks.audioChoice));
  const greyed = (id === 'pass' && !state.passthrough)
    || (id === 'speed-down' && rate <= SPEED_MIN) || (id === 'speed-up' && rate >= SPEED_MAX)
    || (id === 'prev' && menu.start === 0) || (id === 'next' && menu.start + LIST_SLOTS >= menuChoices().length)
    || ((id === 'earlier' || id === 'later') && !subs.choice);
  return { active, greyed };
}

// Shortens a label with "..." until it fits.
function fit(text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}...`).width > width) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

function fillRound(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

function drawPanel(hoverId, now) {
  const { buttons, texts } = currentLayout();
  const hold = now < panelState.holdUntil; // the first seconds of VR: the seek row says how to open this menu again
  ctx.fillStyle = '#10141b';
  ctx.fillRect(0, 0, PANEL_W, PANEL_H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of buttons) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    if (b.id === 'seek') {
      if (hold) {
        ctx.fillStyle = '#e8eaed';
        ctx.font = 'bold 24px system-ui, sans-serif';
        ctx.fillText('Double pinch opens this menu', cx, cy);
        continue;
      }
      const frac = video.duration ? video.currentTime / video.duration : 0;
      ctx.fillStyle = '#232a36';
      fillRound(b.x, cy - 6, b.w, 12, 6);
      ctx.fillStyle = '#f7931a';
      fillRound(b.x, cy - 6, Math.max(12, b.w * frac), 12, 6);
      ctx.beginPath();
      ctx.arc(b.x + b.w * frac, cy, 14, 0, Math.PI * 2);
      ctx.fillStyle = hoverId === 'seek' ? '#ffffff' : '#e8eaed';
      ctx.fill();
      continue;
    }
    const { active, greyed } = buttonState(b.id);
    ctx.fillStyle = greyed ? '#171b22' : active ? '#f7931a' : hoverId === b.id ? '#3a4a6a' : '#232a36';
    fillRound(b.x, b.y, b.w, b.h, 12);
    ctx.fillStyle = greyed ? '#566071' : active ? '#111' : '#e8eaed';
    const lines = labelFor(b.id).split('\n');
    if (lines.length === 2) {
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.fillText(fit(lines[0], b.w - 16), cx, cy - 14);
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText(fit(lines[1], b.w - 16), cx, cy + 14);
    } else {
      const big = ['speed-down', 'speed-up', 'prev', 'next'].includes(b.id);
      ctx.font = `bold ${big ? 40 : b.w < 100 ? 24 : 26}px system-ui, sans-serif`;
      ctx.fillText(fit(lines[0], b.w - 12), cx, cy + (big ? 2 : 0));
    }
  }
  for (const t of texts) {
    if (hold && (t.id === 'time' || t.id === 'duration')) continue;
    const lines = textFor(t.id).split('\n');
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    ctx.fillStyle = t.id === 'speed' ? '#f7931a' : t.id === 'title' ? '#e8eaed' : '#9aa4b5';
    if (lines.length === 2) {
      ctx.font = '18px system-ui, sans-serif';
      ctx.fillText(lines[0], cx, cy - 12);
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText(fit(lines[1], t.w - 4), cx, cy + 12);
    } else {
      ctx.font = t.id === 'title' ? 'bold 28px system-ui, sans-serif' : t.id === 'speed' ? 'bold 26px system-ui, sans-serif' : '22px system-ui, sans-serif';
      ctx.fillText(fit(lines[0], t.w - 4), cx, cy);
    }
  }
  panelTexture.needsUpdate = true;
}

// The gesture numbers, on their own plane. Only drawn when the page box is ticked.
function drawDebug() {
  debugCtx.fillStyle = '#10141b';
  debugCtx.fillRect(0, 0, PANEL_W, 100);
  debugCtx.textAlign = 'center';
  debugCtx.textBaseline = 'middle';
  debugCtx.fillStyle = '#9aa4b5';
  debugCtx.font = '22px system-ui, sans-serif';
  debugCtx.fillText(hudText || 'hands: waiting', PANEL_W / 2, 22);
  debugCtx.font = '20px system-ui, sans-serif';
  debugCtx.fillText(`${describeInputs(renderer.xr.getSession())} | ray ${rayText}`, PANEL_W / 2, 52);
  debugCtx.fillText(`last swipe: ${swipeText || '--'}`, PANEL_W / 2, 80);
  debugTexture.needsUpdate = true;
}

function act(id, canvasX) {
  if (id === 'home') closeVideo();
  else if (id === 'close') closePanel('x');
  else if (id === 'menu') Object.assign(menu, { page: 'main', start: 0 });
  else if (id === 'subs' || id === 'audio' || id === 'view') {
    menu.page = id;
    const at = Math.max(0, menuChoices().indexOf(id === 'subs' ? subs.choice : tracks.audioChoice));
    menu.start = Math.floor(at / LIST_SLOTS) * LIST_SLOTS; // the list opens where your choice is
  } else if (id === 'pass') {
    if (state.passthrough) {
      state.roomOn = !state.roomOn;
      applyRoom();
    }
  } else if (id === 'play') (video.paused ? video.play() : video.pause());
  else if (id === 'back') video.currentTime = Math.max(0, video.currentTime - 10);
  else if (id === 'fwd') video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
  else if (id === 'seek') {
    if (Number.isFinite(video.duration)) video.currentTime = seekFraction(canvasX) * video.duration;
  } else if (id === 'speed-down' || id === 'speed-up') setSpeed(stepSpeed(video.playbackRate, id === 'speed-up' ? 1 : -1));
  else if (id.startsWith('speed:')) setSpeed(Number(id.slice('speed:'.length)));
  else if (id.startsWith('proj:')) {
    userTouched = true;
    setLayout(id.slice('proj:'.length), state.stereo);
  } else if (id.startsWith('stereo:')) {
    userTouched = true;
    setLayout(state.projection, id.slice('stereo:'.length));
  } else if (id === 'reset') resetView();
  else if (id === 'prev') menu.start = Math.max(0, menu.start - LIST_SLOTS);
  else if (id === 'next') {
    if (menu.start + LIST_SLOTS < menuChoices().length) menu.start += LIST_SLOTS;
  } else if (id === 'earlier' || id === 'later') {
    if (subs.choice) subs.delay = Math.round((subs.delay + (id === 'later' ? 0.5 : -0.5)) * 10) / 10;
  } else if (id.startsWith('item:')) {
    const choice = menuChoices()[Number(id.slice('item:'.length))];
    if (menu.page === 'subs') chooseSubtitle(choice || null, { remember: true });
    else if (choice) chooseAudio(choice, { remember: true });
  }
}

// ------------------------------------------------------------------ hands

const hands = [0, 1].map((i) => {
  const hand = renderer.xr.getHand(i);
  hand.addEventListener('connected', (e) => { hand.userData.handedness = e.data.handedness; });
  scene.add(hand);
  return hand;
});
const handMeshes = hands.map(() => { // the joint spheres: shown until the smooth hand is ready, and for tuning
  const mesh = createHandMesh();
  mesh.renderOrder = 7;
  scene.add(mesh);
  return mesh;
});
const handSkins = hands.map((hand) => { // the smooth hands
  const skin = { material: handMaterial(), ready: false, model: null };
  skin.model = addMeshHand(hand, skin.material, () => { skin.ready = true; });
  return skin;
});
let hudText = ''; // one line on the panel: joints reported per hand and the thumb-to-index gap
const tracker = new GestureTracker();
const pokers = [new PokeDetector(), new PokeDetector()];
const doublePinch = [new DoublePinch(), new DoublePinch()];
const pinchEvents = []; // the headset's pinches (select events), handled in order in the next frame
const lowPinch = [false, false]; // per hand: pinching while ignored (for the log)
const swipers = [new SwipeDetector(), new SwipeDetector()];
const handsTogether = new HandsTogether();
const inZone = [false, false]; // per hand: in your view (counts) or in the bottom quarter, resting low (ignored)
const prayerZone = [false, false]; // per hand: high enough for prayer hands (down to chest height)
const belowSight = [0, 0]; // per hand: degrees below your line of sight (for the log)
const handPlace = [null, null]; // per hand: { below: degrees under your line of sight, away: cm from your head }, or null (for the log)
// Your hands are drawn only while you use them: while a hand pinches or aims at the menu, while the menu shows, and
// always with the gesture numbers on. They fade out half a second after.
const handShow = [0, 0]; // per hand: how solid it is drawn now, 0..1
const handUsedAt = [-Infinity, -Infinity];
let nearAt = 0; // the log of hands held close together: when the last line was written, and how many in a row
let nearCount = 0;
let swipeText = ''; // third panel line: the last swipe of each hand, distance and speed
const handLabel = (hand) => ({ left: 'L', right: 'R' }[hand.userData.handedness] || '?');
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// Pointer rays. The headset gives each hand an aiming ray, and a pinch fires "select".
// Point at a panel button and pinch to press it. This works from a distance, like the Quest menus.
const raycaster = new THREE.Raycaster();
const rayOrigin = new THREE.Vector3();
const rayDir = new THREE.Vector3();
const rayHit = [null, null]; // per hand: { id, x, y, origin, point } while its ray meets the panel
const rayPress = [null, null]; // per hand: what a held pinch presses ('panel' = between buttons)
let rayText = '';
const seekX = [null, null];

const controllers = [0, 1].map((i) => {
  const controller = renderer.xr.getController(i);
  controller.addEventListener('selectstart', () => {
    pinchEvents.push({ i, down: true, onPanel: !!rayHit[i] });
    pressRay(i);
  });
  controller.addEventListener('selectend', () => {
    pinchEvents.push({ i, down: false });
    rayPress[i] = null;
    seekX[i] = null;
  });
  scene.add(controller);
  return controller;
});
const beams = [0, 1].map(() => {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xf7931a }));
  line.frustumCulled = false;
  line.visible = false;
  scene.add(line);
  return line;
});
const cursors = [0, 1].map(() => {
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf7931a }));
  dot.visible = false;
  scene.add(dot);
  return dot;
});

const panelPlane = new THREE.Plane();
const panelNormal = new THREE.Vector3();
const panelCentre = new THREE.Vector3();
const rayPoint = new THREE.Vector3();

// Where a hand's ray meets the panel, or null. The panel edge has a margin: a ray just off the panel counts as on
// it (no button), so a near miss neither presses a button nor closes the panel.
function aimAtPanel(controller) {
  controller.updateMatrixWorld(true); // the pose arrives as a matrix: use this frame's, not last frame's
  rayOrigin.setFromMatrixPosition(controller.matrixWorld);
  rayDir.set(0, 0, -1).transformDirection(controller.matrixWorld);
  panelNormal.set(0, 0, 1).transformDirection(panel.matrixWorld); // the panel's front faces you
  if (rayDir.dot(panelNormal) >= 0) return null; // the ray runs away from the panel, or along it
  panelPlane.setFromNormalAndCoplanarPoint(panelNormal, panelCentre.setFromMatrixPosition(panel.matrixWorld));
  raycaster.set(rayOrigin, rayDir);
  if (!raycaster.ray.intersectPlane(panelPlane, rayPoint)) return null;
  const local = panel.worldToLocal(rayPoint.clone());
  if (Math.abs(local.x) > PANEL_WIDTH_M / 2 + PANEL_MARGIN_M || Math.abs(local.y) > PANEL_HEIGHT_M / 2 + PANEL_MARGIN_M) return null;
  const x = (local.x / PANEL_WIDTH_M + 0.5) * PANEL_W;
  const y = (0.5 - local.y / PANEL_HEIGHT_M) * PANEL_H;
  const button = buttonAt(currentLayout().buttons, x, y);
  return { id: button ? button.id : null, x, y, origin: rayOrigin.clone(), point: rayPoint.clone() };
}

function pressRay(i) {
  const hit = rayHit[i];
  rayPress[i] = hit ? (hit.id || 'panel') : null; // a pinch that starts on the panel never moves the picture
  if (hit && hit.id) {
    logEvent('press', { id: hit.id, by: 'ray' });
    act(hit.id, hit.x);
  }
}

function showBeam(i) {
  const hit = rayHit[i];
  beams[i].visible = cursors[i].visible = !!hit;
  if (!hit) return;
  const position = beams[i].geometry.attributes.position;
  position.setXYZ(0, hit.origin.x, hit.origin.y, hit.origin.z);
  position.setXYZ(1, hit.point.x, hit.point.y, hit.point.z);
  position.needsUpdate = true;
  cursors[i].position.copy(hit.point);
}

function jointPosition(hand, name) {
  const joint = hand.joints[name];
  return joint && joint.visible ? joint.getWorldPosition(new THREE.Vector3()) : null;
}

let gestureStart = null;

function handleGesture(ev) {
  if (state.projection !== 'flat') { // VR180 and fisheye: turn and zoom the picture round you
    if (ev.kind === 'grab') {
      // One hand: grab the picture and turn it. It follows the hand's change of direction.
      if (ev.started) gestureStart = { yaw: state.yaw, pitch: state.pitch };
      const turned = dragAngles(gestureStart, aimAngles(head, ev.p0), aimAngles(head, ev.p));
      state.yaw = turned.yaw;
      state.pitch = turned.pitch;
      applyFlatTransform();
      return;
    }
    // Two hands: zoom.
    if (ev.started) gestureStart = { zoom: state.zoomTarget };
    state.zoomTarget = clampZoom(gestureStart.zoom * ev.ratio);
    return;
  }
  if (ev.started) gestureStart = { pos: state.screenPos.clone(), scale: state.screenScale };
  if (ev.kind === 'grab') {
    state.screenPos.copy(remoteGrab(head, v3(ev.p0), v3(ev.p), gestureStart.pos));
  } else {
    state.screenScale = clampScreenScale(gestureStart.scale * ev.ratio);
    state.screenPos.copy(remoteGrab(head, v3(ev.mid0), v3(ev.mid), gestureStart.pos));
  }
  applyFlatTransform();
}

let lastHover = null;
let lastDraw = 0;
let lastTime = 0;

function frame(time) {
  if (!renderer.xr.isPresenting) return;
  const dt = Math.min(0.1, Math.max(0, (time - lastTime) / 1000));
  lastTime = time;
  const xrCamera = renderer.xr.getCamera();
  xrCamera.getWorldPosition(head);
  xrCamera.getWorldDirection(headDir);
  headUp.set(0, 1, 0).applyQuaternion(xrCamera.getWorldQuaternion(headQuat));
  if (Math.hypot(headDir.x, headDir.z) > 0.3) heading.set(headDir.x, 0, headDir.z).normalize();
  viewPitch = Math.asin(Math.max(-1, Math.min(1, headDir.y)));

  const tips = hands.map((hand) => {
    if (!hand.visible) return null;
    const thumb = jointPosition(hand, 'thumb-tip');
    const index = jointPosition(hand, 'index-finger-tip');
    return thumb && index ? { thumb: thumb.toArray(), index: index.toArray() } : null;
  });

  // Pointer rays against the panel, only while the panel is solid enough to use.
  const usable = panelState.opacity > 0.6;
  for (let i = 0; i < 2; i++) {
    rayHit[i] = usable && controllers[i].visible ? aimAtPanel(controllers[i]) : null;
    showBeam(i);
    if (rayPress[i] === 'seek' && rayHit[i] && rayHit[i].id === 'seek' && rayHit[i].x !== seekX[i]) {
      seekX[i] = rayHit[i].x;
      act('seek', rayHit[i].x); // drag along the bar to scrub
    }
  }
  rayText = controllers.map((c, i) => (c.visible ? (rayHit[i] ? rayHit[i].id || 'panel' : '-') : 'no ray')).join(' / ');

  // Only a hand you can see counts: not one in the bottom quarter of your view, such as a hand resting on your leg.
  // Relaxed fingers often rest within 2 cm of the thumb and look like a pinch. The knuckles stand for the hand.
  const view = { forward: headDir, up: headUp };
  for (let i = 0; i < 2; i++) {
    const at = hands[i].visible
      ? jointPosition(hands[i], 'middle-finger-phalanx-proximal') || jointPosition(hands[i], 'wrist')
      : null;
    inZone[i] = !!at && inGestureZone(at.toArray(), head, view);
    prayerZone[i] = !!at && inGestureZone(at.toArray(), head, view, { lowAngle: PRAYER_LOW_ANGLE });
    if (at) belowSight[i] = Math.round(-Math.asin(Math.max(-1, Math.min(1, at.clone().sub(head).normalize().dot(headUp)))) * 180 / Math.PI);
    handPlace[i] = at ? { below: belowSight[i], away: Math.round(at.distanceTo(head) * 100) } : null;
  }

  // The headset's pinches, in order. Two quick pinches with one hand open the menu where you look (or close it).
  // One pinch that is not on the menu closes it, like a tap outside a menu. Only a hand in your view counts.
  for (const e of pinchEvents.splice(0)) {
    if (!e.down) {
      doublePinch[e.i].up(time);
      continue;
    }
    const where = e.onPanel ? 'menu' : inZone[e.i] ? 'view' : 'low';
    logEvent('pinch', { hand: handLabel(hands[e.i]), where, ...(where === 'low' ? handPlace[e.i] : null) }); // low: how far below, how far away
    if (e.onPanel || !inZone[e.i]) {
      doublePinch[e.i].cancel();
      continue;
    }
    const first = doublePinch[e.i].down(time, { open: panelState.shown });
    if (first) {
      if (first.open) closePanel('double-pinch'); // it was open: the pair closes it (the first pinch usually did already)
      else openPanel('pinch', time);
    } else if (panelState.shown && usable && time - panelState.openedAt > 400) {
      closePanel('pinch');
    }
  }

  // A hand that is aiming at the panel is clicking. It does not zoom, turn or grab.
  const ev = tracker.update(tips.map((tip, i) => (!inZone[i] || rayHit[i] || rayPress[i] ? null : tip)), time);
  if (ev) handleGesture(ev);

  // Swipe: a quick sideways flick of an open hand, from the edge toward the centre of your body.
  // The right hand flicking left skips forward 30 s. The left hand flicking right goes back 30 s.
  // The stroke back outward is ignored. A pinching hand, a hand out of view and a hand aiming at the panel do not count.
  const across = { x: -heading.z, z: heading.x }; // across your body, + = to your right
  const inwardOf = (i) => (hands[i].userData.handedness === 'right' ? -1 : 1); // the right hand moves left, the left hand right
  const flicked = [false, false];
  for (let i = 0; i < 2; i++) {
    const side = hands[i].userData.handedness;
    const wrist = hands[i].visible ? jointPosition(hands[i], 'wrist') : null;
    const open = (side === 'left' || side === 'right') && wrist && inZone[i] && !tracker.pinching[i] && !rayHit[i] && !rayPress[i];
    if (!open) {
      swipers[i].reset();
      continue;
    }
    const dx = wrist.x - head.x;
    const dz = wrist.z - head.z;
    const sample = { side: dx * across.x + dz * across.z, up: wrist.y - head.y, depth: dx * heading.x + dz * heading.z, now: time };
    flicked[i] = swipers[i].update(sample, inwardOf(i));
  }
  // Checked after both hands moved this frame: both hands moving in at once (to press them together) is not a skip.
  for (let i = 0; i < 2; i++) {
    if (!flicked[i]) continue;
    const side = hands[i].userData.handedness;
    if (swipers[1 - i].travel(inwardOf(1 - i), 400, time) > 0.06) {
      logEvent('swipe-ignored', { hand: side, why: 'both hands moved in' });
      continue;
    }
    skip(side === 'right' ? SKIP_SECONDS : -SKIP_SECONDS, time);
    const peak = swipers[i].last;
    logEvent('swipe', { hand: side, cm: peak ? Math.round(peak.distance * 100) : null, speed: peak ? +peak.speed.toFixed(2) : null });
  }

  // Pause and play: prayer hands (both palms pressed together, held a moment, like a clap that stays).
  // They count down to chest height, lower than the other gestures. Hands in your lap still do not.
  const poses = hands.map((hand, i) => {
    if (!tips[i]) return null;
    const wrist = jointPosition(hand, 'wrist');
    const knuckle = jointPosition(hand, 'middle-finger-phalanx-proximal');
    const middleTip = jointPosition(hand, 'middle-finger-tip');
    if (!wrist || !knuckle || !middleTip) return null;
    return { palm: wrist.add(knuckle).multiplyScalar(0.5).toArray(), middleTip: middleTip.toArray(), thumb: tips[i].thumb, index: tips[i].index };
  });
  const gapCm = (p, q) => Math.round(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 1000) / 10;
  if (handsTogether.update(poses.map((p, i) => (p && prayerZone[i] && !rayPress[i] ? p : null)), time)) {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    showToast(video.paused ? 'Paused' : 'Playing', time);
    logEvent('hands-together', { action: video.paused ? 'pause' : 'play', palms: gapCm(poses[0].palm, poses[1].palm), tips: gapCm(poses[0].middleTip, poses[1].middleTip) });
  }
  // For tuning: while both hands are close together, note what the tracker reports (at most every 0.3 s, 20 in a row).
  if (poses[0] && poses[1]) {
    const palms = gapCm(poses[0].palm, poses[1].palm);
    if (palms > 20) nearCount = 0;
    else if (palms <= 15 && time - nearAt >= 300 && nearCount < 20) {
      nearAt = time;
      nearCount++;
      const both = (f) => hands.map((hand, i) => `${handLabel(hand)} ${f(i)}`).join(' / ');
      logEvent('hands-near', {
        palms, tips: gapCm(poses[0].middleTip, poses[1].middleTip),
        open: both((i) => gapCm(poses[i].thumb, poses[i].index)), below: both((i) => belowSight[i]),
        zone: both((i) => (prayerZone[i] ? 'on' : 'off')),
      });
    }
  }

  const shown = hands.map((hand, i) => updateHandMesh(handMeshes[i], hand, tracker.pinching[i] || !!rayPress[i]));
  for (let i = 0; i < 2; i++) {
    if (debugOn || panel.visible || tracker.pinching[i] || rayHit[i] || rayPress[i]) handUsedAt[i] = time;
    handShow[i] += ((time - handUsedAt[i] < 500 ? 1 : 0) - handShow[i]) * (1 - Math.exp(-dt * 10));
    const drawn = handShow[i] > 0.02;
    const skin = handSkins[i];
    skin.model.visible = drawn && skin.ready;
    skin.material.opacity = handShow[i];
    skin.material.emissive.setHex(tracker.pinching[i] || rayPress[i] ? PINCH_COLOR : HAND_COLOR);
    handMeshes[i].visible = drawn && (!skin.ready || debugOn);
    handMeshes[i].material.opacity = handShow[i];
  }
  hudText = hands.map((hand, i) => {
    const who = handLabel(hand);
    if (!hand.visible) return `${who} --`;
    const t = tips[i];
    const gap = t ? `${(Math.hypot(t.thumb[0] - t.index[0], t.thumb[1] - t.index[1], t.thumb[2] - t.index[2]) * 100).toFixed(1)}cm` : 'no tips';
    // * = pinching. on = in your view, so it counts. off = in the bottom quarter of your view (or away), so it is ignored.
    return `${who} ${shown[i]}/${JOINT_NAMES.length} ${gap}${tracker.pinching[i] ? '*' : ''} ${inZone[i] ? 'on' : 'off'}`;
  }).join('   ');
  swipeText = swipers.map((swiper, i) => {
    const last = swiper.last && time - swiper.last.at < 3000 ? swiper.last : null;
    return `${handLabel(hands[i])} ${last ? `${Math.round(last.distance * 100)}cm ${last.speed.toFixed(1)}m/s` : '--'}`;
  }).join('   ');

  // For the log: a hand that pinches while it is ignored (low or out of view). It moves nothing.
  for (let i = 0; i < 2; i++) {
    const t = tips[i];
    const gap = !inZone[i] && t ? Math.hypot(t.thumb[0] - t.index[0], t.thumb[1] - t.index[1], t.thumb[2] - t.index[2]) : 1;
    const pinched = lowPinch[i] ? gap < 0.04 : gap < 0.022;
    if (pinched && !lowPinch[i]) logEvent('ignored-pinch', { hand: handLabel(hands[i]), ...handPlace[i] });
    lowPinch[i] = pinched;
  }

  // Finger pokes on the panel. A pinch is never a poke.
  let hover = rayHit[0] && rayHit[0].id ? rayHit[0].id : rayHit[1] && rayHit[1].id ? rayHit[1].id : null;
  for (let i = 0; i < 2; i++) {
    const tip = tips[i];
    if (!tip || ev || !usable) {
      pokers[i].armed = false;
      continue;
    }
    const local = panel.worldToLocal(v3(tip.index));
    const inBounds = Math.abs(local.x) <= PANEL_WIDTH_M / 2 && Math.abs(local.y) <= PANEL_HEIGHT_M / 2;
    const x = (local.x / PANEL_WIDTH_M + 0.5) * PANEL_W;
    const y = (0.5 - local.y / PANEL_HEIGHT_M) * PANEL_H;
    const button = inBounds ? buttonAt(currentLayout().buttons, x, y) : null;
    if (button && local.z < 0.08) hover = button.id;
    if (pokers[i].update(local.z, button !== null)) {
      logEvent('press', { id: button.id, by: 'poke' });
      panelState.pressedAt = time;
      act(button.id, x);
    }
  }

  if (state.projection !== 'flat') {
    world.position.copy(head);
    if (state.zoom !== state.zoomTarget) {
      const d = state.zoomTarget - state.zoom;
      state.zoom = Math.abs(d) < 0.001 ? state.zoomTarget : state.zoom + d * 0.3;
      refreshZoomGeometry();
    }
  }

  // The panel. Only a double pinch opens it (looking down did too, until 2026-10-30: it opened by accident). It shows
  // where you look, and hides when you look away (not in the first 1.5 s, nor while or just after a pinch presses it) or
  // 8 s after a hand last used it. The X, Home and a pinch elsewhere close it too.
  const busy = usable && (hover !== null || rayHit.some(Boolean) || rayPress.some(Boolean));
  if (busy) panelState.usedAt = time;
  if (rayPress.some(Boolean)) panelState.pressedAt = time; // a held pinch on the panel: a press or a scrub
  if (panelState.shown && panelState.place) { // place it first: the close rules below measure where it is
    placePanel();
    panelState.place = false;
  }
  if (panelState.shown && time >= panelState.holdUntil) {
    if (panelState.how === 'start' && !busy) closePanel('start-over');
    else {
      panelState.how = 'pinch'; // the start-up menu a hand took over stays, as if you had opened it
      const angle = angleToPanel();
      const stays = pinchedPanelStays({
        angle, idleMs: time - panelState.usedAt, busy, sinceOpenMs: time - panelState.openedAt, sincePressMs: time - panelState.pressedAt,
      });
      // deg: how far you looked from the menu, for tuning the 35 degrees
      if (!stays) closePanel(angle >= PANEL_LOOK_AWAY ? 'look-away' : 'idle', { deg: Math.round(angle * 180 / Math.PI) });
    }
  }
  panelState.opacity += ((panelState.shown ? 1 : 0) - panelState.opacity) * (1 - Math.exp(-dt * 12));
  panel.visible = panelState.opacity > 0.02;
  panel.material.opacity = panelState.opacity;
  if (time > toastState.until) toastState.opacity = Math.max(0, toastState.opacity - dt * 2.5);
  toast.visible = toastState.opacity > 0.02;
  toast.material.opacity = toastState.opacity;

  roomCover.position.copy(head); // passthrough off: the black sphere follows your head
  placeSubtitle(dt);

  debugPlane.visible = debugOn;
  debugPlane.material.opacity = panelState.opacity;
  if (panel.visible && (hover !== lastHover || time - lastDraw > 250)) {
    drawPanel(hover, time);
    if (debugOn) drawDebug();
    lastHover = hover;
    lastDraw = time;
  }
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);

let sessionStartedAt = 0;

// You open the Meta menu, or leave to change the Wi-Fi: the video pauses, and plays again when you are back.
// The headset does not stop it: the sound would run on behind the menu. Away for 60 s: the session ends (see AwayGuard).
const away = new AwayGuard({
  media: video,
  endSession: () => {
    const open = renderer.xr.getSession();
    if (open) open.end().catch(() => {});
  },
  log: (type, data) => logEvent(type, data),
});

renderer.xr.addEventListener('sessionstart', () => {
  away.reset();
  const session = renderer.xr.getSession();
  session.addEventListener('visibilitychange', () => {
    logEvent('visibility', { state: session.visibilityState, page: document.visibilityState });
    away.change(session.visibilityState);
  });
  const blend = renderer.xr.getEnvironmentBlendMode();
  state.passthrough = !!blend && blend !== 'opaque'; // an immersive-ar session: the real room can show
  state.roomOn = true; // and it starts with the room showing
  applyFlatTransform();
  applyRoom();
  const now = performance.now();
  const startMenuSeen = Number(recall('vr-start-menu')) || 0; // no storage: it shows every time
  if (startMenuSeen < START_MENU_TIMES) {
    remember('vr-start-menu', String(startMenuSeen + 1));
    openPanel('start', now);
    panelState.holdUntil = now + 5000; // show the panel for 5 s so you know it is there
  }
  sessionStartedAt = now;
  logEvent('start', { mode: state.passthrough ? 'passthrough' : 'vr', projection: state.projection, stereo: state.stereo,
    cut: state.background ? state.background.kind : 'none' });
  setTimeout(() => logEvent('inputs', { inputs: describeInputs(renderer.xr.getSession()) }), 3000); // hands connect after the start
  video.play().catch((err) => showError(`Cannot start playback: ${err.message}`));
});
renderer.xr.addEventListener('sessionend', () => {
  video.pause();
  away.reset();
  state.passthrough = false;
  applyRoom();
  panelState.shown = false;
  panelState.opacity = 0;
  toastState.opacity = 0;
  logEvent('end', { minutes: +((performance.now() - sessionStartedAt) / 60000).toFixed(1) });
  flushLog();
});

// A small record of what the hands did, kept on the laptop in .state/session-log.jsonl, so the gestures can be
// tuned from facts. Only when the laptop serves this page. It holds no video names.
const canLog = location.protocol === 'https:' || location.protocol === 'http:';
const logQueue = [];

function logEvent(type, data = {}) {
  if (!canLog) return;
  logQueue.push({ type, at: Date.now(), ...data });
  if (logQueue.length > 200) logQueue.shift();
}

function flushLog() {
  if (!logQueue.length) return;
  fetch('/api/log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true,
    body: JSON.stringify(logQueue.splice(0)),
  }).catch(() => {});
}
if (canLog) setInterval(flushLog, 10_000);

// ------------------------------------------------------------------ page

let label = '';
let userTouched = false;
let blobUrl = null;
let allFiles = [];
let selectedPath = null;
let seen = null; // what the pictures say: { fisheye, alpha, background }, from the laptop or (a headset file) this page
let cutTouched = false; // you chose the room-view cut yourself: the pictures no longer change it
let shownKey = null; // which video the page shows now: its laptop path, or a blob address

// Remembered on this headset only: the folder and subfolder you had open, the order, the speed, your languages.
const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch { /* no storage here */ }
};
const recall = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

function showError(text) {
  $('error').textContent = text;
}

function setReady(text) {
  $('ready').textContent = text;
}

function updateReady() {
  if (!video.videoWidth) return;
  const facts = [`${video.videoWidth} × ${video.videoHeight}`, Number.isFinite(video.duration) ? formatTime(video.duration) : ''].filter(Boolean).join(' · ');
  setReady((state.alpha && state.projection === 'fisheye') || state.background
    ? `Ready · ${facts}. A passthrough video: tap Watch in your room to see the person in your room.`
    : `Ready · ${facts}. Check the picture settings, then tap Watch in VR.`);
}

function setLayout(projection, stereo) {
  state.projection = projection;
  state.stereo = stereo;
  $('proj').value = projection;
  $('stereo').value = stereo;
  $('alpha-row').hidden = projection !== 'fisheye';
  renderCut();
  rebuild();
}

// The room-view cut: the filled background found in the pictures (on by itself), or a black one you choose.
// A fisheye or flat video gets the choice only when the pictures found a background (a fisheye one has its mask).
const MANUAL_BLACK = { kind: 'black', rgb: [0, 0, 0], edge: 0.08 };
function renderCut() {
  const found = seen && seen.background;
  const choices = [['', 'Show all of the picture']];
  if (found) choices.push(['found', `Remove the ${colourName(found.rgb)} background`]);
  if (!found || found.kind !== 'black') choices.push(['black', 'Remove a black background']);
  $('cut').replaceChildren(...choices.map(([value, text]) => option(value, text)));
  $('cut').value = !state.background ? '' : state.background === found ? 'found' : 'black';
  $('cut-row').hidden = !found && state.projection !== 'vr180';
}

// The layout: what the pictures say, else the lens words in the file name, else the frame size.
function applyGuess() {
  if (!cutTouched) state.background = (seen && seen.background) || null;
  if (!userTouched) {
    const g = guessLayout(label, video.videoWidth, video.videoHeight);
    const fromPictures = seen && seen.fisheye && g.projection !== 'fisheye';
    state.fov = g.fov || FISHEYE_FOV;
    state.alpha = fromPictures ? seen.alpha : !!g.alpha || !!(seen && seen.alpha);
    $('alpha').checked = state.alpha;
    if (fromPictures) setLayout('fisheye', 'sbs');
    else setLayout(g.projection, g.stereo);
  }
  renderCut();
  applyRoom();
  updateReady();
}

// A file on this headset: its layout from its pictures, as the laptop reads its own files (lib/layout.js). Five small
// frames from a hidden second copy of the video, so the one you watch is not touched. null = not 2:1, or no answer.
async function lookAtPictures(url) {
  const probe = Object.assign(document.createElement('video'), { muted: true, preload: 'auto', src: url });
  const canvas = Object.assign(document.createElement('canvas'), { width: 128, height: 64 });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  const event = (name) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${name}`)), 8000);
    probe.addEventListener(name, () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  try {
    await event('loadedmetadata');
    if (Math.abs(probe.videoWidth / probe.videoHeight - 2) > 0.1 || !Number.isFinite(probe.duration)) return null;
    const frames = [];
    for (const part of [0.15, 0.3, 0.5, 0.7, 0.85]) {
      const seeked = event('seeked');
      probe.currentTime = probe.duration * part;
      await seeked;
      g.drawImage(probe, 0, 0, 128, 64);
      const rgba = g.getImageData(0, 0, 128, 64).data;
      const rgb = new Uint8Array(128 * 64 * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) rgb.set(rgba.subarray(i, i + 3), j);
      frames.push(rgb);
    }
    return readFrames(frames);
  } catch {
    return null;
  } finally {
    probe.removeAttribute('src');
    probe.load();
  }
}

// ---- speed: kept for the next video

let speed = clampSpeed(Number(recall('vr-speed')) || 1);

function setSpeed(rate) {
  speed = clampSpeed(rate);
  video.defaultPlaybackRate = speed; // a new video starts at this speed too
  video.playbackRate = speed;
  remember('vr-speed', String(speed));
  renderSpeed();
}

function renderSpeed() {
  $('speed').textContent = formatSpeed(speed);
  for (const b of $('speed-presets').children) b.classList.toggle('on', Number(b.dataset.speed) === speed);
  $('speed-down').disabled = speed <= SPEED_MIN;
  $('speed-up').disabled = speed >= SPEED_MAX;
}

$('speed-presets').replaceChildren(...SPEED_PRESETS.map((s) => {
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: formatSpeed(s) });
  b.dataset.speed = String(s);
  b.addEventListener('click', () => setSpeed(s));
  return b;
}));
$('speed-down').addEventListener('click', () => setSpeed(stepSpeed(speed, -1)));
$('speed-up').addEventListener('click', () => setSpeed(stepSpeed(speed, 1)));

// ---- audio tracks and subtitles

const option = (value, text) => Object.assign(document.createElement('option'), { value: String(value), textContent: text });

// The menus on the video's page. The VR menu reads the same `tracks` and `subs`.
function renderTrackChoices() {
  $('audio-row').hidden = tracks.audio.length < 2;
  $('audio').replaceChildren(...tracks.audio.map((a, i) => option(i, a.label)));
  $('audio').value = String(tracks.audio.indexOf(tracks.audioChoice));
  $('subs-row').hidden = !tracks.subtitles.length && !blobUrl;
  $('subs').replaceChildren(option('', 'Off'), ...tracks.subtitles.map((s, i) => option(i, s.label)));
  $('subs').value = subs.choice ? String(tracks.subtitles.indexOf(subs.choice)) : '';
  $('subs-file-row').hidden = !blobUrl;
}

// Plays an audio track: the video's own sound when the browser plays that track by itself, else the laptop's copy.
// A track you chose (sure = true) never trusts a guess about which track the browser plays.
function chooseAudio(choice, { remember: keep = false, sure = false } = {}) {
  tracks.audioChoice = choice;
  const own = !choice || (choice.native && (tracks.nativeSure || !sure));
  useSideAudio(own ? null : choice.url);
  if (keep && choice && baseLanguage(choice.language)) remember('vr-audio-lang', baseLanguage(choice.language));
  $('audio').value = String(tracks.audio.indexOf(choice));
  if (keep) logEvent('audio', { own });
}

// A laptop video's chosen subtitles can go to the headset with it, as an SRT file named like the video.
function renderSaveSubs() {
  const c = subs.choice;
  $('save-subs-row').hidden = !(c && c.url);
  if (c && c.url) $('save-subs').href = `${c.url}&download=1`;
}

// Shows a subtitle choice (null = off). Its words come from the laptop, or from a file picked on this headset.
async function chooseSubtitle(choice, { remember: keep = false } = {}) {
  Object.assign(subs, { choice, cues: [], delay: 0, loading: false });
  $('subs').value = choice ? String(tracks.subtitles.indexOf(choice)) : '';
  renderSaveSubs();
  if (keep) {
    const lang = choice ? baseLanguage(choice.language) : '';
    if (!choice) remember('vr-subs', '"off"');
    else if (lang) remember('vr-subs', JSON.stringify({ lang, hi: choice.hi, forced: choice.forced }));
    logEvent('subtitles', { on: !!choice });
  }
  if (!choice) return;
  if (choice.cues) {
    subs.cues = choice.cues;
    return;
  }
  subs.loading = true;
  let cues = null;
  try {
    const res = await fetch(choice.url, { credentials: 'same-origin' });
    if (res.ok) cues = (await res.json()).cues.map(([start, end, text]) => ({ start, end, text }));
  } catch { /* shown below */ }
  if (subs.choice !== choice) return; // you chose something else meanwhile
  subs.loading = false;
  if (!cues) {
    showError('These subtitles could not load.');
    chooseSubtitle(null);
    return;
  }
  choice.cues = cues;
  subs.cues = cues;
}

// The laptop's audio tracks and subtitles for a video, then your remembered choices.
// base: the video's address after /media/ (the folder id and the encoded path).
async function loadTracks(base) {
  let t = null;
  try {
    const res = await fetch(`/api/tracks/${base}`, { credentials: 'same-origin' });
    if (res.ok) t = await res.json();
  } catch { /* no tracks: the video plays as it is */ }
  if (!t || shownKey !== base) return;
  const audio = t.audio.map((a, i) => ({ ...a, label: audioLabel(a, i), url: `/api/audio/${base}?stream=${a.stream}` }));
  numberSameLabels(audio.map((a) => a.label)).forEach((l, i) => { audio[i].label = l; });
  let pref = null;
  try {
    pref = JSON.parse(recall('vr-subs') || 'null');
  } catch { /* nothing remembered */ }
  const langs = [pref && pref.lang, ...(navigator.languages || [])].map((l) => baseLanguage(l)).filter(Boolean);
  const subtitles = orderByLanguage(t.subtitles.map(describeSubtitle), [...new Set(langs)])
    .map((s) => ({ ...s, url: `/api/subtitles/${base}?key=${encodeURIComponent(s.key)}` }));
  numberSameLabels(subtitles.map((s) => s.label)).forEach((l, i) => { subtitles[i].label = l; });
  Object.assign(tracks, { audio, subtitles, nativeSure: t.nativeSure });
  const lang = recall('vr-audio-lang');
  const wanted = lang ? audio.find((a) => baseLanguage(a.language) === lang) : null;
  chooseAudio(wanted || audio.find((a) => a.native) || null, { sure: !!wanted });
  chooseSubtitle(pref && pref.lang ? pickSubtitle(subtitles, pref) : null);
  renderTrackChoices();
}

function resetTracks() {
  useSideAudio(null);
  Object.assign(tracks, { audio: [], subtitles: [], nativeSure: true, audioChoice: null });
  Object.assign(subs, { choice: null, cues: [], loading: false, delay: 0 });
  renderTrackChoices();
  renderSaveSubs();
}

$('audio').addEventListener('change', () => chooseAudio(tracks.audio[Number($('audio').value)] || null, { remember: true, sure: true }));
$('subs').addEventListener('change', () => chooseSubtitle($('subs').value === '' ? null : tracks.subtitles[Number($('subs').value)], { remember: true }));
// A subtitle file for a video from this headset: read here, never sent anywhere. Returns its choice, or null.
async function addSubtitleFile(file) {
  const cues = parseSubtitles(decodeText(new Uint8Array(await file.arrayBuffer())));
  if (!cues.length) {
    showError(`${file.name} holds no subtitles that this player can read (SRT, WebVTT or ASS).`);
    return null;
  }
  const choice = { ...describeSubtitle({ source: 'file', tag: subtitleTag(file.name, label) }), label: file.name, cues };
  tracks.subtitles.push(choice);
  renderTrackChoices();
  return choice;
}
$('subs-file').addEventListener('change', async () => {
  const file = $('subs-file').files[0];
  $('subs-file').value = '';
  if (!file) return;
  showError('');
  const choice = await addSubtitleFile(file);
  if (choice) chooseSubtitle(choice);
});

// ---- the video's page

// layoutUrl: the laptop's /api/layout address for this video. It reads the pictures with ffmpeg (fisheye? a mask?).
// base: the video's laptop address after /media/, for its tracks. A laptop video can also be downloaded to the
// headset, for watching later with no laptop.
function choose({ url, name, isBlob = false, layoutUrl = null, base = null, thumb = null, facts = '' }) {
  resetTracks();
  $('save-video-row').hidden = isBlob;
  if (!isBlob) $('save-video').href = `${url}?download=1`;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = isBlob ? url : null;
  shownKey = base || url;
  label = name;
  userTouched = false;
  seen = null;
  cutTouched = false;
  state.background = null;
  showError('');
  $('title').textContent = name;
  $('facts').textContent = facts;
  $('sheet-thumb').hidden = !thumb;
  if (thumb) $('sheet-thumb').src = thumb;
  else $('sheet-thumb').removeAttribute('src');
  setReady('Loading...');
  $('sheet').hidden = false;
  resetView();
  state.zoom = 1;
  video.src = url;
  video.load(); // the frame size is unknown again until loadedmetadata
  video.defaultPlaybackRate = speed;
  video.playbackRate = speed;
  renderTrackChoices();
  applyGuess(); // from the name for now
  if (layoutUrl) {
    fetch(layoutUrl, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((info) => {
        if (!info || !info.known || video.getAttribute('src') !== url) return; // not known, or you chose another video
        seen = info;
        applyGuess();
      })
      .catch(() => {});
  }
  if (isBlob) {
    lookAtPictures(url).then((info) => {
      if (!info || video.getAttribute('src') !== url) return; // no answer, or you chose another video
      seen = info;
      applyGuess();
    });
  }
  if (base) loadTracks(base);
  $('sheet-close').focus({ preventScroll: true });
}

// Home (or the X of the video's page): stop the video, forget it, leave VR, back to the list.
function closeVideo() {
  resetTracks();
  video.pause();
  video.removeAttribute('src');
  video.load(); // this also stops the download
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
  label = '';
  shownKey = null;
  selectedPath = null;
  seen = null;
  state.background = null;
  $('sheet').hidden = true;
  $('save-video-row').hidden = true;
  showError('');
  setReady('');
  resetView();
  state.zoom = 1;
  renderList();
  const session = renderer.xr.getSession();
  if (session) session.end();
}

$('sheet-close').addEventListener('click', closeVideo);
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) closeVideo(); // a tap beside the box
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sheet').hidden) closeVideo();
});

video.addEventListener('loadedmetadata', () => {
  applyGuess(); // the frame size is known now
  updateReady();
  applyFlatTransform();
});

video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return; // Home emptied it
  setReady('');
  const code = video.error && video.error.code;
  showError(code === 3 || code === 4
    ? 'The headset browser cannot play this file. Convert it to MP4 (H.264 or H.265 video, AAC sound).'
    : `Video error ${code || ''}`);
});

$('proj').addEventListener('change', () => {
  userTouched = true;
  setLayout($('proj').value, state.stereo);
});
$('stereo').addEventListener('change', () => {
  userTouched = true;
  setLayout(state.projection, $('stereo').value);
});
$('alpha').addEventListener('change', () => {
  userTouched = true;
  state.alpha = $('alpha').checked;
  applyRoom();
  updateReady();
});
$('cut').addEventListener('change', () => {
  cutTouched = true;
  state.background = { found: seen && seen.background, black: MANUAL_BLACK }[$('cut').value] || null;
  applyRoom();
  updateReady();
});

// One pick can hold the video and its subtitle files (press and hold the first file, then tap the others). The
// subtitles are read here; your remembered language chooses among them, else the first one shows.
$('pick').addEventListener('change', async () => {
  const files = [...$('pick').files];
  $('pick').value = '';
  const isSubtitle = (f) => /\.(srt|vtt|ass|ssa)$/i.test(f.name);
  const file = files.find((f) => !isSubtitle(f));
  if (!file) {
    if (files.length) showStatus('Pick the video too: its subtitle files go with it.');
    return;
  }
  showStatus('');
  selectedPath = null;
  renderList();
  choose({ url: URL.createObjectURL(file), name: file.name, isBlob: true, facts: `${formatSize(file.size)} · on this headset` });
  const key = shownKey;
  const added = [];
  for (const s of files.filter(isSubtitle)) {
    const choice = await addSubtitleFile(s);
    if (choice) added.push(choice);
  }
  if (!added.length || shownKey !== key) return; // none, or you chose another video meanwhile
  let pref = null;
  try {
    pref = JSON.parse(recall('vr-subs') || 'null');
  } catch { /* nothing remembered */ }
  chooseSubtitle((pref && pref.lang && pickSubtitle(added, pref)) || added[0]);
});

// ---- the laptop's library

let previewsOn = false; // the laptop can make preview images (it found ffmpeg)
let folders = []; // the laptop's video folders: [{ id, label }]
let folderNow = null; // the id of the folder shown
let currentDir = ''; // the subfolder shown, '' = the top of the folder
let sortBy = recall('vr-sort') || 'name';
$('sort').value = sortBy;
if ($('sort').value !== sortBy) sortBy = $('sort').value = 'name'; // a value this page does not know

const encodedPath = (f) => `${folderNow}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
const fileUrl = (kind, f) => `/${kind}/${encodedPath(f)}`;

// 26 Oct, or 26 Oct 2024 for another year.
function formatDay(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
}

function card(build, onClick, picked = false) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card';
  button.classList.toggle('picked', picked);
  build(button);
  button.addEventListener('click', onClick);
  li.appendChild(button);
  return li;
}

function textLine(className, text) {
  const el = document.createElement(className === 'name' ? 'span' : 'small');
  el.className = className;
  el.textContent = text;
  return el;
}

function videoCard(f, title) {
  const facts = [formatSize(f.size), formatDay(f.date)].filter(Boolean).join(' · ');
  return card((button) => {
    if (previewsOn) {
      const img = document.createElement('img');
      img.loading = 'lazy'; // only the previews you scroll to are requested
      img.alt = '';
      img.src = fileUrl('thumb', f);
      img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('div'), { className: 'box', textContent: '▶' })));
      button.appendChild(img);
    } else {
      button.appendChild(Object.assign(document.createElement('div'), { className: 'box', textContent: '▶' }));
    }
    button.append(textLine('name', title), textLine('meta', facts));
  }, () => {
    selectedPath = `${folderNow}/${f.path}`;
    renderList();
    choose({ url: fileUrl('media', f), name: f.path, layoutUrl: fileUrl('api/layout', f), base: encodedPath(f),
      thumb: previewsOn ? fileUrl('thumb', f) : null, facts });
  }, `${folderNow}/${f.path}` === selectedPath);
}

function folderCard(title, detail, onClick, up = false) {
  return card((button) => {
    const box = document.createElement('div');
    box.className = 'box';
    if (up) box.textContent = '↑ Up';
    else box.appendChild(Object.assign(document.createElement('div'), { className: 'folder-icon' }));
    button.append(box, textLine('name', title), textLine('meta', detail));
  }, onClick);
}

function openDir(dir) {
  currentDir = dir;
  remember('vr-dir', dir);
  $('filter').value = '';
  renderList();
  window.scrollTo(0, 0);
}

// Where you are: the folder, then each subfolder. Tap one to go back to it.
function renderCrumbs(searching) {
  const nav = $('crumbs');
  nav.replaceChildren();
  if (searching) return;
  const parts = currentDir ? currentDir.split('/') : [];
  const top = folders.find((f) => f.id === folderNow);
  const steps = [{ label: top ? top.label : 'Folder', dir: '' }, ...parts.map((p, i) => ({ label: p, dir: parts.slice(0, i + 1).join('/') }))];
  steps.forEach((s, i) => {
    if (i) nav.append(' / ');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.label;
    b.disabled = i === steps.length - 1; // where you are now
    b.addEventListener('click', () => openDir(s.dir));
    nav.appendChild(b);
  });
}

// No search: the subfolders and videos of this level. A search: every match in the folder, with its path.
// Both in the order you chose.
function renderList() {
  const q = $('filter').value.trim().toLowerCase();
  const list = $('list');
  list.replaceChildren();
  renderCrumbs(!!q);
  if (q) {
    const found = allFiles.filter((x) => x.path.toLowerCase().includes(q)).sort(compareBy(sortBy, 'path'));
    for (const f of found.slice(0, 300)) list.appendChild(videoCard(f, f.path));
  } else {
    const level = listFolder(allFiles, currentDir, sortBy);
    if (currentDir) list.appendChild(folderCard('Up one folder', parentDir(currentDir) || 'the top', () => openDir(parentDir(currentDir)), true));
    for (const s of level.folders) {
      list.appendChild(folderCard(s.name, `${s.count} video${s.count === 1 ? '' : 's'} · ${formatSize(s.size)}`,
        () => openDir(currentDir ? `${currentDir}/${s.name}` : s.name)));
    }
    for (const f of level.files.slice(0, 300)) list.appendChild(videoCard(f, f.name));
  }
  if (!list.children.length) list.textContent = allFiles.length ? 'No video matches your search.' : 'No videos in this folder.';
}

async function loadFolder(id, dir = '') {
  folderNow = id;
  currentDir = dir;
  remember('vr-folder', id);
  remember('vr-dir', dir);
  $('folder').value = id;
  $('list').textContent = 'Loading...';
  const res = await fetch(`/api/library?folder=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    location.href = '/login';
    return;
  }
  if (!res.ok) {
    $('list').textContent = 'This folder is not on the laptop list any more. Reload the page.';
    return;
  }
  allFiles = (await res.json()).files;
  if (currentDir && !allFiles.some((f) => f.path.startsWith(`${currentDir}/`))) currentDir = ''; // that subfolder is gone
  renderList();
}

async function loadLibrary() {
  try {
    const res = await fetch('/api/folders', { credentials: 'same-origin' });
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
    folders = (await res.json()).folders;
    $('folder').replaceChildren(...folders.map((f) => option(f.id, f.label)));
    const saved = recall('vr-folder');
    const start = folders.find((f) => f.id === saved) || folders[0];
    if (!start) {
      $('list').textContent = 'The laptop lists no video folder. Add one on the laptop: Wandless control page, Add a folder.';
      return;
    }
    await loadFolder(start.id, start.id === saved ? recall('vr-dir') || '' : '');
  } catch (err) {
    $('list').textContent = `Cannot load the library: ${err.message}`;
  }
}
$('filter').addEventListener('input', renderList);
$('sort').addEventListener('change', () => {
  sortBy = $('sort').value;
  remember('vr-sort', sortBy);
  renderList();
});
$('folder').addEventListener('change', () => {
  loadFolder($('folder').value).catch((err) => { $('list').textContent = `Cannot load the folder: ${err.message}`; });
});

// ---- tabs, VR buttons, start

function showTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const id of ['library', 'headset', 'help']) $(id).hidden = id !== name;
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

function showStatus(text) {
  $('status').textContent = text;
  $('status').hidden = !text;
}
if (!window.isSecureContext) showStatus('This page is not secure, so VR cannot start. Open the https:// address.');
else if (!navigator.xr) showStatus('This browser has no WebXR. Use the Meta Quest Browser.');

// Two ways in: plain VR, and VR with passthrough (the real room behind the picture) when the browser offers it.
// Passthrough is a different kind of session, so it is chosen here, before you go in.
async function startSession(mode) {
  showError('');
  try {
    // A session the headset still holds from before (you left with the Meta menu) is ended first. The headset
    // allows one session at a time, so a left-over one could keep you from the full picture.
    const stale = renderer.xr.getSession();
    if (stale) await stale.end().catch(() => {});
    const session = await navigator.xr.requestSession(mode, {
      optionalFeatures: ['local-floor', 'bounded-floor', 'layers', 'hand-tracking'],
    });
    await renderer.xr.setSession(session);
  } catch (err) {
    showError(`Could not start ${mode === 'immersive-ar' ? 'room view' : 'VR'}: ${err.message}`);
  }
}

async function setupEnterButtons() {
  const holder = $('vr');
  const add = (text, mode, small = '', second = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    if (small) button.appendChild(Object.assign(document.createElement('small'), { textContent: small }));
    button.classList.toggle('second', second);
    if (mode) button.addEventListener('click', () => startSession(mode));
    else button.disabled = true;
    holder.appendChild(button);
  };
  if (!navigator.xr) return add('VR is not available here', null);
  try {
    const vr = await navigator.xr.isSessionSupported('immersive-vr');
    add(vr ? 'Watch in VR' : 'VR is not available here', vr ? 'immersive-vr' : null);
    if (await navigator.xr.isSessionSupported('immersive-ar')) add('Watch in your room', 'immersive-ar', 'passthrough', true);
  } catch {
    add('VR is not allowed here', null);
  }
}
setupEnterButtons();

try {
  debugOn = localStorage.getItem('vr-debug') === '1';
} catch { /* no storage here: keep it off */ }
$('debug').checked = debugOn;
$('debug').addEventListener('change', () => {
  debugOn = $('debug').checked;
  remember('vr-debug', debugOn ? '1' : '0');
});

setLayout(state.projection, state.stereo);
renderSpeed();

// Served by the laptop (http or https): show the library. Opened from a file on the headset: local files only.
if (location.protocol === 'https:' || location.protocol === 'http:') {
  $('save-offline').hidden = false;
  $('bookmark-tip').hidden = false;
  fetch('/api/info', { credentials: 'same-origin' })
    .then((res) => res.json())
    .then((info) => {
      $('lock').hidden = !info.locked;
      previewsOn = !!info.previews;
      renderList();
    })
    .catch(() => {});
  loadLibrary();
} else {
  $('tab-library').hidden = true;
  $('offline-note').hidden = false;
  showTab('headset');
}
