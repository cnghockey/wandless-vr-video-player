// Makes small test videos with ffmpeg. Not a test file itself.
import { execFileSync } from 'node:child_process';

const disc = (cx, cy, r) => `lte(hypot(mod(X,EYE)-${cx},Y-${cy}),${r})`; // commas are safe inside the '...' quotes

// Masks, as fractions of an eye's square: discs where the "person" is.
export const MASKS = {
  // one big disc in the middle of each eye
  big: [[0.5, 0.5, 0.3]],
  // three small discs round the middle (top left, top right, bottom left): the fourth place stays empty,
  // so a piece put back in the wrong place shows as a disc where there should be none
  three: [[0.44, 0.44, 0.035], [0.56, 0.44, 0.035], [0.44, 0.56, 0.035]],
};

// A side-by-side fisheye video: each eye a blue-grey disc filling its square, black corners. With `mask`, the mask
// is packed into the corners the way DeoVR passthrough tools do it (VRAutoMatte's filter graph: 40 % size,
// red only, black made clear, six pieces laid over the corners).
export function makeFisheye(ffmpeg, out, { width = 640, fps = 15, seconds = 1, mask = null } = {}) {
  const W = width;
  const H = width / 2;
  const eye = H;
  const inCircle = disc(eye / 2, eye / 2, eye / 2).replaceAll('EYE', eye);
  const base = `[0:v]format=rgb24,geq=r='if(${inCircle},60,0)':g='if(${inCircle},120,0)':b='if(${inCircle},200,0)'`;
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${seconds}`];
  let graph;
  if (!mask) {
    graph = `${base},format=yuv420p[out]`;
  } else {
    const lum = MASKS[mask].map(([u, v, r]) => disc(u * eye, v * eye, r * eye).replaceAll('EYE', eye)).join('+');
    const wOut = Math.floor((W * 4) / 10);
    const hOut = Math.floor((H * 4) / 10);
    const hw = Math.floor(wOut / 2);
    const hh = Math.floor(hOut / 2);
    const qw = Math.floor(wOut / 4);
    const xCtr = Math.floor(W / 2) - Math.floor(hw / 2);
    const yBot = H - hh;
    const xFar = W - qw;
    const crops = [[0, 0, hw, hh], [0, hh, hw, hh], [hw, 0, qw, hh], [wOut - qw, 0, qw, hh], [hw, hh, hw, hh], [wOut - qw, hh, qw, hh]];
    const places = [[xCtr, yBot], [xCtr, 0], [xFar, yBot], [0, yBot], [xFar, 0], [0, 0]];
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${seconds}`);
    graph = [
      `${base}[base]`,
      `[1:v]format=gray,geq=lum='255*(${lum})',format=rgb24,scale=${wOut}:${hOut},format=rgba,`
        + 'colorchannelmixer=rr=1:rg=0:rb=0:ra=0:gr=0:gg=0:gb=0:ga=0:br=0:bg=0:bb=0:ba=0:ar=0:ag=0:ab=0:aa=1,'
        + 'colorkey=color=black:similarity=0.1,split=6[o1][o2][o3][o4][o5][o6]',
      ...crops.map(([x, y, w, h], i) => `[o${i + 1}]crop=${w}:${h}:${x}:${y}[s${i + 1}]`),
      ...places.map(([x, y], i) => `${i ? `[a${i - 1}]` : '[base]'}[s${i + 1}]overlay=${x}:${y}${i < 5 ? `[a${i}]` : ',format=yuv420p[out]'}`),
    ].join(';');
  }
  execFileSync(ffmpeg, [...args, '-filter_complex', graph, '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', out], { windowsHide: true });
  return out;
}

// A side-by-side passthrough video with a filled background: one colour everywhere except a "person" (a box in the
// lower middle of each eye, as such videos have them; skin-coloured, or `person`). Colours: ffmpeg's 0xRRGGBB.
export function makeFilled(ffmpeg, out, { colour = '0x02FA4A', person = '0xC89682', width = 640, fps = 15, seconds = 2 } = {}) {
  const eye = width / 2;
  const box = (x0) => `drawbox=x=${x0 + eye * 0.35}:y=${eye * 0.4}:w=${eye * 0.3}:h=${eye * 0.6}:color=${person}:t=fill`;
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=${width}x${eye}:r=${fps}:d=${seconds}`,
    '-vf', `${box(0)},${box(eye)}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', out], { windowsHide: true });
  return out;
}

// A full-frame side-by-side video (colour everywhere, no fisheye circles).
export function makeFullFrame(ffmpeg, out, { width = 640, fps = 15, seconds = 1 } = {}) {
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${width / 2}:r=${fps}:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', out], { windowsHide: true });
  return out;
}
