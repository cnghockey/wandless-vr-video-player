// HTTPS server for the laptop. It streams your videos to the headset browser.
// Password: ON by default. Start with --no-password (npm run start:open) to turn it off for a test.
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRange } from './lib/range.js';
import { loadAuth, verifyPassword, signSession, verifySession, Throttle } from './lib/auth.js';
import { ensureCert, lanIps } from './lib/cert.js';
import { scanLibrary, resolveMedia, resolveInside } from './lib/library.js';
import { folderId, loadFolders } from './lib/folders.js';
import { findFfmpeg, canRun, Thumbnailer, warmUp } from './lib/thumbs.js';
import { LayoutProbe, warmLayouts } from './lib/layout.js';
import { startControl, pickFolderWithWindow, LIST_HEADER } from './lib/control.js';
import { ffprobeFor, TrackProbe, findSubtitleFiles } from './lib/tracks.js';
import { SubtitleExtractor, readSubtitleFile, packCues } from './lib/subtitles.js';
import { serveTrackWav } from './lib/audio.js';
import { cuesToSrt } from './public/core.js';
import { APP, Updater, parseRepo, oldFile } from './lib/update.js';
import { launch } from './lib/install.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'vrp';
const HTML = 'text/html; charset=utf-8';
const SUBTITLE_TYPES = { '.srt': 'text/plain', '.vtt': 'text/vtt', '.ass': 'text/plain', '.ssa': 'text/plain' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readBody(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The Wandless icon, for the pages the server writes itself.
const PAGE_ICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' rx='112' fill='%230f172a'/%3E%3Cg fill='none' stroke='%23f8fafc' stroke-width='60' stroke-linecap='round'%3E%3Cpath d='M148 410 L236 296'/%3E%3Cpath d='M364 410 L276 296'/%3E%3C/g%3E%3Cpath fill='%23f7931a' d='M256 66 C262 128 284 148 346 158 C284 168 262 188 256 252 C250 188 228 168 166 158 C228 148 250 128 256 66 Z'/%3E%3Ccircle cx='354' cy='92' r='11' fill='%23f7931a'/%3E%3Ccircle cx='168' cy='224' r='8' fill='%23f7931a'/%3E%3C/svg%3E">`;

// The page before the certificate warning (see redirectToHttps). target: the https address of the app. host: the
// address the warning will name, so the reader can check it.
function introPage(target, host) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wandless VR Video Player</title>
${PAGE_ICON}
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1116;color:#e8eaed;font:22px/1.45 system-ui,sans-serif}
  main{display:grid;gap:18px;width:min(620px,88vw);padding:24px 0}
  h1{margin:0;font-size:28px}
  p,ol{margin:0}
  li{margin:6px 0}
  b{color:#fff}
  a{display:block;text-align:center;padding:18px;border-radius:12px;background:#f7931a;color:#111;font-weight:600;text-decoration:none}
  .small{color:#9aa3b2;font-size:18px}
</style></head><body>
<main>
  <h1>Wandless VR Video Player</h1>
  <p>The next screen is a warning about the certificate. This is normal: your PC made its own certificate, and the browser cannot check it.</p>
  <ol>
    <li>Tap <b>Advanced</b>.</li>
    <li>Tap <b>Proceed to ${escapeHtml(host)}</b>. Check the address: it must be this one, the address of your PC.</li>
  </ol>
  <a href="${escapeHtml(target)}">Continue</a>
  <p class="small">You see this page once. After the passcode, bookmark the player: then you never type the address again.</p>
</main></body></html>`;
}

// kind 'passcode': a big number keypad on the page (easy to hit in VR), and the number keyboard if you tap the field.
// kind 'password': a text field and the full keyboard.
function loginPage(message = '', kind = 'password') {
  const passcode = kind === 'passcode';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => `<button type="button" class="key" data-key="${d}">${d}</button>`).join('');
  const keypad = passcode ? `
  <div class="keys">${keys}<button type="button" class="key" id="del">Delete</button><button type="button" class="key" data-key="0">0</button><button type="submit" class="key go">Unlock</button></div>
  <script>
    const code = document.getElementById('code');
    for (const k of document.querySelectorAll('[data-key]')) k.addEventListener('click', () => { code.value += k.dataset.key; });
    document.getElementById('del').addEventListener('click', () => { code.value = code.value.slice(0, -1); });
  </script>` : '<button type="submit">Unlock</button>';
  const field = passcode
    ? '<input type="password" id="code" name="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" required placeholder="Passcode">'
    : '<input type="password" name="password" autocomplete="current-password" autofocus required placeholder="Password">';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wandless VR Video Player</title>
${PAGE_ICON}
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1116;color:#e8eaed;font:20px system-ui,sans-serif}
  form{display:grid;gap:18px;width:min(420px,88vw)}
  h1{margin:0;font-size:28px}
  input,button{font:inherit;padding:16px;border-radius:12px;border:1px solid #3a4150;background:#171b22;color:inherit}
  input{text-align:center;letter-spacing:.3em}
  button{background:#f7931a;border:0;color:#111;font-weight:600;cursor:pointer}
  .keys{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .key{background:#232a36;color:#e8eaed;font-size:30px;padding:18px 0}
  .key.go{background:#f7931a;color:#111;font-size:22px}
  #del{font-size:20px}
  p{margin:0;color:#ff8a80;min-height:1.4em}
</style></head><body>
<form method="post" action="/login">
  <h1>Wandless VR Video Player</h1>
  ${field}
  <p>${escapeHtml(message)}</p>${keypad}
</form></body></html>`;
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const sendJson = (res, value, status = 200) => sendText(res, status, JSON.stringify(value), 'application/json');

// One event from the headset's gesture log, cut down to short plain values. Nothing else reaches the file.
function cleanEvent(e) {
  const out = {};
  if (!e || typeof e !== 'object' || Array.isArray(e)) return out;
  for (const [k, v] of Object.entries(e).slice(0, 12)) {
    if (!/^[a-z][a-zA-Z0-9-]{0,23}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 120);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

// "Save as" for a download: the plain name, and the exact name for browsers that read UTF-8 names (RFC 6266).
export function attachmentHeader(name) {
  const plain = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;

// Append to the log. Past 5 MB the log becomes *.old.jsonl (the one before is replaced) and a new one starts.
async function appendLog(file, text) {
  try {
    if ((await fs.promises.stat(file)).size > LOG_MAX_BYTES) await fs.promises.rename(file, file.replace(/\.jsonl$/, '.old.jsonl'));
  } catch {
    // no log yet
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, text);
}

function sendFile(res, file, type, headers = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!stat.isFile()) return sendText(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, ...headers });
  pipeline(fs.createReadStream(file), res, () => {});
}

// `password` defaults to true, so a caller that forgets the option gets a locked server.
export function createHandler({
  mediaRoot, // one video folder. Or `folders`:
  folders = null, // the video folders, [{ id, label, dir }], or a function that returns them (read on each request)
  stateDir,
  appFile = path.join(HERE, 'dist', 'wandless.html'),
  password = true,
  sessionHours = 12,
  throttle = new Throttle(),
  thumbnailer = null, // makes preview images. null = no previews
  layoutProbe = null, // reads fisheye and passthrough masks from the pictures. null = the page guesses from name and size
  trackProbe = null, // reads the audio and subtitle tracks (ffprobe). null = no track menus, only subtitle files
  subtitleExtractor = null, // takes text subtitles out of videos (ffmpeg). null = only subtitle files
  ffmpeg = null, // decodes another audio track for the headset. null = only the track the browser plays itself
  logFile = stateDir ? path.join(stateDir, 'session-log.jsonl') : null, // the headset's gesture log
}) {
  // Read again by handler.reloadAuth() when the control page saves a new passcode.
  // No passcode yet: everything stays locked, and the login page says to choose one on the laptop.
  let auth = password ? loadAuth(stateDir) : null;
  const one = mediaRoot ? [{ id: folderId(mediaRoot), label: path.basename(path.resolve(mediaRoot)), dir: path.resolve(mediaRoot) }] : [];
  const getFolders = typeof folders === 'function' ? folders : () => folders || one;

  // "<folder id>/<path in that folder>" -> the video file, or null. The headset never names a folder path.
  async function lookUp(rest) {
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const folder = getFolders().find((f) => f.id === rest.slice(0, slash));
    if (!folder) return null;
    const rel = rest.slice(slash + 1);
    const m = await resolveMedia(folder.dir, rel);
    return m ? { ...m, rel, root: folder.dir } : null;
  }

  // What the menus can offer for a video: its audio tracks, and its subtitles (files beside it, and text tracks
  // inside it). Asking also starts taking the text tracks out, so choosing one later in VR is quick.
  async function probe(m) {
    const { mtimeMs } = await fs.promises.stat(m.file);
    const info = { file: m.file, size: m.size, mtimeMs };
    try {
      return { info, probed: trackProbe ? await trackProbe.get(info) : null };
    } catch {
      return { info, probed: null }; // ffprobe could not read it: subtitle files only
    }
  }

  async function tracksFor(m) {
    const { info, probed } = await probe(m);
    const inside = probed && subtitleExtractor ? probed.subtitles.filter((s) => s.text) : [];
    if (inside.length) subtitleExtractor.extract(info, inside.map((s) => s.stream));
    const files = await findSubtitleFiles(m.root, m.rel);
    return {
      info,
      inside,
      answer: {
        duration: probed ? probed.duration : 0,
        audio: probed && ffmpeg ? probed.audio : [],
        nativeSure: probed ? probed.nativeSure : true,
        subtitles: [
          ...files.map((f) => ({ key: `file:${f.rel}`, source: 'file', tag: f.tag })),
          ...inside.map((s) => ({ key: `s:${s.stream}`, source: 'video', language: s.language, title: s.title, forced: s.forced, hi: s.hi })),
        ],
        pictureSubtitles: probed ? probed.subtitles.filter((s) => !s.text).length : 0,
      },
    };
  }

  // A subtitle choice's words: cues (JSON) for the page, or with `download` an SRT file named like the video
  // ("Film.eng.srt"), so it can go to the headset with the video and pair with it there.
  async function subtitles(res, m, key, download = false) {
    let cues;
    let tag;
    if (key.startsWith('file:')) {
      const rel = key.slice('file:'.length);
      const found = (await findSubtitleFiles(m.root, m.rel)).find((f) => f.rel === rel);
      if (!found) return sendText(res, 404, 'Not found');
      const real = await resolveInside(m.root, rel, SUBTITLE_TYPES); // the same path rules as the videos
      if (!real) return sendText(res, 404, 'Not found');
      try {
        cues = packCues(await readSubtitleFile(real.file));
      } catch {
        return sendText(res, 422, 'Cannot read this subtitle file');
      }
      tag = found.tag;
    } else {
      const s = /^s:(\d+)$/.exec(key);
      if (!s) return sendText(res, 404, 'Not found');
      const { info, inside } = await tracksFor(m);
      const track = inside.find((x) => x.stream === Number(s[1]));
      if (!track) return sendText(res, 404, 'Not found');
      cues = await subtitleExtractor.cues(info, track.stream, inside.map((x) => x.stream));
      if (!cues) return sendText(res, 422, 'ffmpeg could not read the subtitles');
      tag = [track.language, track.forced && 'forced', track.hi && 'sdh'].filter(Boolean).join('.') || `track${track.stream}`;
    }
    if (!download) return sendJson(res, { cues });
    return sendText(res, 200, cuesToSrt(cues), 'application/x-subrip; charset=utf-8',
      { 'Content-Disposition': attachmentHeader(`${path.parse(m.rel).name}${tag ? `.${tag}` : ''}.srt`) });
  }
  const ttlMs = sessionHours * 3_600_000;
  const isAuthed = (req) => !password || (!!auth && verifySession(auth.secret, parseCookies(req.headers.cookie)[COOKIE]));
  const NO_PASSCODE_YET = 'No passcode yet. On the laptop, open the Wandless control page and choose one.';
  const redirect = (res, where, headers = {}) => {
    res.writeHead(303, { Location: where, 'Cache-Control': 'no-store', ...headers });
    res.end();
  };

  async function login(req, res) {
    if (!auth) return sendText(res, 503, loginPage(NO_PASSCODE_YET, 'passcode'), HTML);
    const ip = req.socket.remoteAddress || 'unknown';
    const waitMs = throttle.wait(ip);
    if (waitMs > 0) {
      const secs = Math.ceil(waitMs / 1000);
      return sendText(res, 429, loginPage(`Too many tries. Wait ${secs} s.`, auth.kind), HTML, { 'Retry-After': String(secs) });
    }
    const given = new URLSearchParams(await readBody(req)).get('password') || '';
    if (!verifyPassword(given, auth)) {
      throttle.fail(ip);
      return sendText(res, 401, loginPage(`Wrong ${auth.kind}.`, auth.kind), HTML);
    }
    throttle.success(ip);
    const token = signSession(auth.secret, ttlMs);
    redirect(res, '/', {
      'Set-Cookie': `${COOKIE}=${token}; Max-Age=${Math.floor(ttlMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    });
  }

  // download: the browser saves the file (on the headset: its Download folder) instead of playing it.
  async function media(req, res, rest, download = false) {
    const m = await lookUp(rest);
    if (!m) return sendText(res, 404, 'Not found');
    const range = parseRange(req.headers.range, m.size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${m.size}` });
      return res.end();
    }
    const headers = { 'Content-Type': m.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' };
    if (download) headers['Content-Disposition'] = attachmentHeader(path.basename(m.file));
    let status = 200;
    let length = m.size;
    if (range) {
      status = 206;
      length = range.end - range.start + 1;
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${m.size}`;
    }
    headers['Content-Length'] = length;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    pipeline(fs.createReadStream(m.file, range ? { start: range.start, end: range.end } : undefined), res, () => {});
  }

  async function route(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

    let url;
    let p;
    try {
      url = new URL(req.url, 'https://local');
      p = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Bad URL');
    }
    const read = req.method === 'GET' || req.method === 'HEAD';

    if (p === '/login' || p === '/logout') {
      if (!password) return redirect(res, '/'); // nothing to log in to
      if (p === '/logout' && req.method === 'POST') {
        return redirect(res, '/login', { 'Set-Cookie': `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict` });
      }
      if (p === '/login') {
        if (read) {
          if (isAuthed(req)) return redirect(res, '/');
          return sendText(res, 200, auth ? loginPage('', auth.kind) : loginPage(NO_PASSCODE_YET, 'passcode'), HTML);
        }
        if (req.method === 'POST') return login(req, res);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (!isAuthed(req)) {
      if (read && (req.headers.accept || '').includes('text/html')) return redirect(res, '/login');
      return sendText(res, 401, JSON.stringify({ error: 'login required' }), 'application/json');
    }
    if (p === '/api/log' && req.method === 'POST' && logFile) {
      let events;
      try {
        events = JSON.parse(await readBody(req, 65_536));
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(400, 'Bad log');
      }
      if (!Array.isArray(events) || events.length > 300) throw new HttpError(400, 'Bad log');
      const logged = new Date().toISOString();
      await appendLog(logFile, events.map((e) => `${JSON.stringify({ ...cleanEvent(e), logged })}\n`).join(''));
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!read) throw new HttpError(405, 'Method not allowed');

    if (p === '/') return sendFile(res, appFile, HTML, { 'Cache-Control': 'no-store' });
    if (p === '/download/wandless.html') {
      return sendFile(res, appFile, HTML, {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="wandless.html"',
      });
    }
    if (p === '/api/info') {
      return sendText(res, 200, JSON.stringify({ locked: password, previews: !!thumbnailer }), 'application/json');
    }
    if (p.startsWith('/thumb/')) {
      if (!thumbnailer) return sendText(res, 404, 'Previews are off');
      const m = await lookUp(p.slice('/thumb/'.length)); // the same path rules as /media/
      if (!m) return sendText(res, 404, 'Not found');
      const { mtimeMs } = await fs.promises.stat(m.file);
      const jpg = await thumbnailer.get({ file: m.file, name: m.rel, size: m.size, mtimeMs });
      if (!jpg) return sendText(res, 404, 'No preview');
      return sendFile(res, jpg, 'image/jpeg', { 'Cache-Control': 'private, max-age=86400' });
    }
    if (p.startsWith('/api/layout/')) {
      const m = await lookUp(p.slice('/api/layout/'.length)); // the same path rules as /media/
      if (!m) return sendText(res, 404, 'Not found');
      if (!layoutProbe) return sendJson(res, { known: false });
      try {
        const { mtimeMs } = await fs.promises.stat(m.file);
        return sendJson(res, { known: true, ...(await layoutProbe.get({ file: m.file, size: m.size, mtimeMs })) });
      } catch {
        return sendJson(res, { known: false }); // ffmpeg could not read it: the page keeps its guess
      }
    }
    if (p.startsWith('/api/tracks/') || p.startsWith('/api/subtitles/') || p.startsWith('/api/audio/')) {
      const [, , kind] = p.split('/');
      const m = await lookUp(p.slice(`/api/${kind}/`.length)); // the same path rules as /media/
      if (!m) return sendText(res, 404, 'Not found');
      if (kind === 'tracks') return sendJson(res, (await tracksFor(m)).answer);
      if (kind === 'subtitles') return subtitles(res, m, url.searchParams.get('key') || '', url.searchParams.has('download'));
      const stream = Number(url.searchParams.get('stream'));
      const { probed } = await probe(m);
      const track = probed && ffmpeg ? probed.audio.find((a) => a.stream === stream) : null;
      if (!track) return sendText(res, 404, 'No such audio track');
      return serveTrackWav({ ffmpeg, file: m.file, stream, seconds: probed.duration, lead: track.start, req, res });
    }
    if (p === '/api/folders') {
      return sendJson(res, { folders: getFolders().map(({ id, label }) => ({ id, label })) }); // no paths: the ids are enough
    }
    if (p === '/api/library') {
      const list = getFolders();
      const want = url.searchParams.get('folder');
      const folder = want ? list.find((f) => f.id === want) : list[0];
      if (!folder) return sendJson(res, { error: 'no such folder' }, 404);
      return sendJson(res, { folder: folder.id, files: await scanLibrary(folder.dir) });
    }
    if (p.startsWith('/media/')) return media(req, res, p.slice('/media/'.length), url.searchParams.has('download'));
    return sendText(res, 404, 'Not found');
  }

  const handler = async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error('request failed:', err);
      if (res.headersSent) res.destroy();
      else sendText(res, err.status || 500, err.status ? err.message : 'Server error');
    }
  };
  // The control page saved a new passcode: use it now. Its new secret also ends every open session.
  handler.reloadAuth = () => {
    if (password) auth = loadAuth(stateDir);
  };
  return handler;
}

// Plain words for a failed TLS handshake, so a "secure connection failed" can be traced.
export function describeTlsError(err) {
  const code = err.code || '';
  if (code === 'ERR_SSL_HTTP_REQUEST') return 'the browser used http://. Use https://';
  if (/UNKNOWN_CA|CERTIFICATE_UNKNOWN|BAD_CERTIFICATE|CERTIFICATE_EXPIRED|UNKNOWN_CERTIFICATE/.test(code)) {
    return 'the browser refused the certificate. On the warning page tap Advanced, then Proceed';
  }
  if (code === 'ECONNRESET') return 'the connection was reset before the handshake ended';
  if (/NO_SHARED_CIPHER|UNSUPPORTED_PROTOCOL|WRONG_VERSION|PROTOCOL_VERSION/.test(code)) {
    return 'the browser and the server share no TLS version or cipher';
  }
  return err.message;
}

// Plain http (port 80): send the browser on to the https app, so typing only the laptop's address works.
// The address comes from the socket the browser reached, never from the Host header.
// The screen after it is the browser's certificate warning, and a new user stops there. So a browser's first visit gets a
// short page: what comes next, what to tap, and a Continue button to the https app. A cookie remembers the visit (a year):
// later visits go straight on, as every visit did up to 0.1.3. A program that does not ask for a page goes straight on too.
const INTRO_COOKIE = 'wandless_intro';
export function redirectToHttps(httpsPort) {
  return (req, res) => {
    const local = (req.socket.localAddress || '127.0.0.1').replace(/^::ffff:/, '');
    const host = local.includes(':') ? `[${local}]` : local;
    const target = `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}/`;
    const wantsPage = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (wantsPage && parseCookies(req.headers.cookie)[INTRO_COOKIE] !== '1') {
      return sendText(res, 200, introPage(target, host), HTML, { 'Set-Cookie': `${INTRO_COOKIE}=1; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax` });
    }
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    res.end();
  };
}

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => {
    server.off('error', reject);
    resolve();
  });
});

// `log` gets one line the first time each address connects, and one line for each failed handshake.
// `httpPort`: also answer plain http there with a redirect to the https app (null = no). A busy port is only logged.
export async function startServer({ port = 8443, host = '0.0.0.0', httpPort = null, stateDir, log = () => {}, ...rest }) {
  const handler = createHandler({ stateDir, ...rest });
  const server = https.createServer(ensureCert(stateDir), handler);
  const seen = new Set();
  const lastSeen = new Map(); // address -> when it last asked for something (the control page shows the headsets)
  server.on('connection', (socket) => {
    const ip = socket.remoteAddress;
    if (ip && !seen.has(ip)) {
      seen.add(ip);
      log(`Connection from ${ip}`);
    }
  });
  server.on('request', (req) => {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (ip) lastSeen.set(ip, Date.now());
  });
  server.on('tlsClientError', (err, socket) => {
    // A dropped socket forgets its peer. The raw socket cached the address when it connected.
    const ip = socket.remoteAddress || socket._parent?.remoteAddress || 'unknown address';
    log(`TLS failed from ${ip}: ${err.code || 'error'} (${describeTlsError(err)})`);
    socket.destroy();
  });
  await listen(server, port, host);
  const bound = server.address().port;
  let plain = null;
  if (httpPort !== null) {
    plain = http.createServer(redirectToHttps(bound));
    try {
      await listen(plain, httpPort, host);
    } catch (err) {
      log(`Port ${httpPort} is busy (${err.code}): type the full https:// address on the headset.`);
      plain = null;
    }
  }
  const closeOne = (s) => new Promise((r) => s.close(r));
  return {
    server,
    port: bound,
    httpPort: plain ? plain.address().port : null,
    reloadAuth: handler.reloadAuth,
    clients: () => [...lastSeen].map(([ip, at]) => ({ ip, at })), // every address that asked, with when it last did
    close: () => Promise.all([closeOne(server), plain && closeOne(plain)]),
  };
}

// After an update, the old copy may hold a port for a moment longer.
async function bind(start, tries) {
  for (;;) {
    try {
      return await start();
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || --tries <= 0) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// The file an update replaced: delete it once the old copy has ended.
async function removeOld(exe) {
  for (let i = 0; i < 20; i++) {
    try {
      return fs.rmSync(oldFile(exe), { force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// exe: the running Wandless.exe (scripts/exe.js), or null from the source folder.
// here: the folder with dist\, public\, scripts\, folders.txt and .state.
export async function main({ exe = null, here = HERE } = {}) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const locked = !argv.includes('--no-password');
  // The video folders: each --root, VR_ROOT, then every folder in folders.txt (read again on each request,
  // so a folder added there shows on the headset after a page reload). The first start with none of these
  // writes your Videos folder into folders.txt: an ordinary entry, which the control page can remove.
  const listFile = process.env.VR_FOLDERS_FILE || path.join(here, 'folders.txt');
  const roots = argv.flatMap((a, i) => (a === '--root' && argv[i + 1] ? [argv[i + 1]] : []));
  if (process.env.VR_ROOT) roots.push(process.env.VR_ROOT);
  const videos = path.join(os.homedir(), 'Videos');
  if (!roots.length && !fs.existsSync(listFile) && fs.existsSync(videos)) {
    fs.mkdirSync(path.dirname(listFile), { recursive: true });
    fs.writeFileSync(listFile, `${LIST_HEADER}${videos}\r\n`);
  }
  const readFolders = () => loadFolders({ roots, listFile });
  const port = Number(opt('port') || process.env.PORT || 8443);
  const httpSetting = opt('http-port') || process.env.HTTP_PORT || '80'; // 'off' = no plain-http helper
  const httpPort = httpSetting === 'off' ? null : Number(httpSetting);
  const stateDir = process.env.VR_STATE_DIR || path.join(here, '.state');
  const sessionHours = Number(process.env.VR_SESSION_HOURS || 12);
  const appFile = process.env.VR_APP_FILE || path.join(here, 'dist', 'wandless.html'); // another file: for tests
  const afterUpdate = argv.includes('--after-update') || argv.includes('--rolled-back'); // scripts/exe.js starts these

  const controlSetting = opt('control-port') || process.env.CONTROL_PORT || '8440'; // 'off' = no control page
  const openBrowser = !argv.includes('--no-open') && process.env.VR_OPEN !== '0';

  const { folders, missing } = readFolders();
  if (!fs.existsSync(appFile)) {
    console.error('The app is not built yet. Run:  npm run build');
    process.exit(1);
  }

  const stamp = () => new Date().toLocaleTimeString();
  const ffmpeg = findFfmpeg();
  const thumbnailer = ffmpeg ? new Thumbnailer({ ffmpeg, dir: path.join(stateDir, 'thumbs') }) : null;
  const layoutProbe = ffmpeg ? new LayoutProbe({ ffmpeg, cacheFile: path.join(stateDir, 'layouts.json') }) : null;
  const ffprobe = ffmpeg ? ffprobeFor(ffmpeg) : null;
  const trackProbe = ffprobe && canRun(ffprobe) ? new TrackProbe({ ffprobe, cacheFile: path.join(stateDir, 'tracks.json') }) : null;
  const subtitleExtractor = ffmpeg ? new SubtitleExtractor({ ffmpeg, dir: path.join(stateDir, 'subtitles') }) : null;
  const work = { // what the control page shows about the background work
    previews: thumbnailer ? { state: 'waiting', done: 0, total: 0 } : { state: 'off' },
    formats: layoutProbe ? { state: 'waiting', done: 0, total: 0, alpha: 0 } : { state: 'off' },
  };
  let headsetsSeen = 0;
  const app = await bind(() => startServer({
    folders: () => readFolders().folders, stateDir, port, httpPort, sessionHours, password: locked, appFile, thumbnailer, layoutProbe,
    trackProbe, subtitleExtractor, ffmpeg,
    log: (line) => {
      if (line.startsWith('Connection from ')) {
        const ip = line.slice('Connection from '.length).replace(/^::ffff:/, '');
        if (ip !== '127.0.0.1') console.log(`[${stamp()}] ${++headsetsSeen === 1 ? 'The headset connected' : 'A device connected'}: ${ip}`);
      } else console.log(`[${stamp()}] ${line}`);
    },
  }), afterUpdate ? 20 : 1);
  // What to type on the headset. With the port-80 helper, the bare address is enough. Read again on each use: Wi-Fi changes.
  const headsetAddresses = () => lanIps().map((ip) => (app.httpPort === 80 ? ip : `https://${ip}:${app.port}/`));

  let control = null;
  const repo = parseRepo(APP.repository);
  const updater = new Updater({
    version: APP.version,
    // Wandless.exe asks GitHub at each start (VR_UPDATES=off stops that). VR_UPDATE_URL: another place to ask (tests).
    url: process.env.VR_UPDATE_URL || (exe && repo && process.env.VR_UPDATES !== 'off' ? `https://api.github.com/repos/${repo}/releases/latest` : null),
    exe,
    // The new file is in place: free the ports, start it in a new window, and end this copy.
    restart: async () => {
      console.log(`[${stamp()}] The update is in place. Wandless starts again in a new window.`);
      app.server.closeAllConnections();
      await Promise.race([Promise.all([app.close(), control && control.close()]), new Promise((r) => setTimeout(r, 2000))]);
      try {
        await launch(exe, [...argv.filter((a) => !['--after-update', '--rolled-back', '--no-open'].includes(a)), '--after-update', '--no-open']);
      } catch (err) {
        console.log(`[${stamp()}] The new version did not start by itself (${err.message}). Start Wandless again from its shortcut.`);
        if (process.stdin.isTTY) {
          console.log('Press Enter to close this window.');
          await new Promise((r) => process.stdin.once('data', r));
        }
      }
      process.exit(0);
    },
  });
  if (controlSetting !== 'off') {
    try {
      control = await bind(() => startControl({
        port: Number(controlSetting), listFile, roots, stateDir, logFile: path.join(stateDir, 'session-log.jsonl'),
        page: path.join(here, 'public', 'control.html'), updater,
        info: () => ({ addresses: headsetAddresses(), locked, previews: work.previews, formats: work.formats, clients: app.clients() }),
        reloadAuth: app.reloadAuth,
        pickFolder: () => pickFolderWithWindow(path.join(here, 'scripts', 'add-folder.ps1')),
        stop: () => {
          console.log(`[${stamp()}] Stopped from the control page.`);
          process.exit(0);
        },
      }), afterUpdate ? 20 : 1);
    } catch (err) {
      console.log(`The control page could not start (${err.code || err.message}). Use --control-port <number>.`);
    }
  }
  const controlUrl = control ? `http://127.0.0.1:${control.port}/` : null;

  const passcode = !locked ? 'OFF (--no-password): anyone on this Wi-Fi can open your library'
    : loadAuth(stateDir) ? 'ON' : 'NOT SET YET: choose one on the control page';
  const addresses = headsetAddresses();
  console.log(`Wandless ${APP.version} is running. Close this window to stop it.\n`);
  if (controlUrl) console.log(`  Control page (this laptop):  ${controlUrl}${openBrowser ? '   (opened in your browser)' : ''}`);
  console.log(`  On the headset, type:        ${addresses.join('   or   ') || '(no network found)'}`);
  console.log(`  Passcode:                    ${passcode}`);
  console.log(`  Video folders:               ${folders.length ? folders.map((f) => f.label).join(', ') : 'none yet: add one on the control page'}`);
  for (const dir of missing) console.log(`  Not found, skipped:          ${dir}`);
  console.log('\nThe first time, the headset browser warns about the certificate: tap Advanced, then Proceed.\n');

  if (controlUrl && openBrowser) spawn('explorer.exe', [controlUrl], { detached: true, stdio: 'ignore' }).unref();

  if (exe && afterUpdate) {
    console.log(argv.includes('--rolled-back') ? `The update did not start on this PC: back on version ${APP.version}.\n` : `Updated to version ${APP.version}.\n`);
    removeOld(exe);
  }
  if (updater.url) {
    updater.check().then((s) => {
      if (s.state === 'available') console.log(`[${stamp()}] Version ${s.latest.version} is out. Open the control page to update.`);
    });
  }

  if (thumbnailer && folders.length) {
    warmUp(folders[0].dir, thumbnailer, (done, total) => { work.previews = { state: 'making', done, total }; })
      .then(({ made, total }) => {
        work.previews = { state: 'ready', done: made, total };
        console.log(`[${stamp()}] Previews ready: ${made} of ${total}`);
      })
      .catch((err) => console.log(`Previews stopped: ${err.message}`))
      .then(() => warmLayouts(folders[0].dir, layoutProbe, (done, total, alpha) => { work.formats = { state: 'checking', done, total, alpha }; }))
      .then(({ checked, alpha }) => {
        work.formats = { state: 'ready', done: checked, total: checked, alpha };
        console.log(`[${stamp()}] Video formats checked: ${checked} (${alpha} passthrough: a mask or a filled background)`);
      })
      .catch((err) => console.log(`Format check stopped: ${err.message}`));
  } else if (!thumbnailer) {
    console.log('Previews, audio tracks and the subtitles inside videos are off: ffmpeg was not found.');
    console.log('Set FFMPEG_PATH to the full path of ffmpeg.exe to turn them on.');
  }
  if (ffmpeg && !trackProbe) console.log(`Audio tracks and the subtitles inside videos are off: ${ffprobe} was not found beside ffmpeg.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? 'That port is in use. Use --port <number>.' : err.message);
    process.exit(1);
  });
}
