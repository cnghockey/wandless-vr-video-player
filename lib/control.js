// The control page: Wandless's settings in a browser on this laptop, so nobody needs a terminal.
// It answers only on 127.0.0.1, and only to requests that name 127.0.0.1 (or localhost) as the host: a web page you
// visit cannot reach it under another name. Every change is a POST with the X-VR-Player header, which a page from
// another site cannot send without the browser first asking this server (it never says yes).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveAuth, loadAuth } from './auth.js';
import { loadFolders, parseFolderList } from './folders.js';
import { scanLibrary } from './library.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'control.html');
export const LIST_HEADER = [
  '# Wandless: the video folders the headset may open. One folder per line.',
  '# Lines that start with # are notes. Quotes round a path are fine ("Copy as path" adds them).',
  '# Add or remove folders on the control page, or edit this file. The headset sees changes after a page reload.',
  '',
].join('\r\n');

const sameFolder = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Opens the normal Windows folder window on this laptop. Resolves with the folder picked, or null.
export function pickFolderWithWindow(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-PrintOnly'],
      { encoding: 'utf8', timeout: 10 * 60_000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

// port(): the port this page listens on (the Host check needs it).
// info(): what the running server knows: { addresses, locked, previews, formats, clients }.
// updater: lib/update.js, or null. page: this page's file (Wandless.exe keeps it in its own folder).
export function createControlHandler({ port, listFile, roots = [], stateDir, info, reloadAuth, pickFolder, stop, logFile, updater = null, page = PAGE }) {
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 4096) reject(new Error('too large'));
    });
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('not JSON'));
      }
    });
    req.on('error', reject);
  });

  const listed = () => {
    try {
      return parseFolderList(fs.readFileSync(listFile, 'utf8'));
    } catch {
      return [];
    }
  };

  function addToList(dir) {
    if (listed().some((d) => sameFolder(d, dir))) return 'already in the list';
    let text = fs.existsSync(listFile) ? fs.readFileSync(listFile, 'utf8') : LIST_HEADER;
    if (text && !text.endsWith('\n')) text += '\r\n';
    fs.writeFileSync(listFile, `${text}${dir}\r\n`);
    return 'added';
  }

  // Removes the folder's lines. Notes and the other folders stay as they are.
  function removeFromList(dir) {
    if (!fs.existsSync(listFile)) return false;
    const lines = fs.readFileSync(listFile, 'utf8').split(/\r?\n/);
    const keep = lines.filter((line) => {
      const [entry] = parseFolderList(line);
      return !entry || !sameFolder(entry, dir);
    });
    if (keep.length === lines.length) return false;
    fs.writeFileSync(listFile, keep.join('\r\n'));
    return true;
  }

  async function folders() {
    const { folders: found, missing } = loadFolders({ roots, listFile });
    const inList = listed();
    const removable = (dir) => inList.some((d) => sameFolder(d, dir));
    const out = [];
    for (const f of found) {
      out.push({ dir: f.dir, label: f.label, found: true, videos: (await scanLibrary(f.dir)).length, removable: removable(f.dir) });
    }
    for (const dir of missing) out.push({ dir, label: path.basename(dir) || dir, found: false, videos: 0, removable: removable(dir) });
    return { folders: out };
  }

  function status() {
    const now = info();
    const auth = loadAuth(stateDir);
    let logBytes = 0;
    try {
      logBytes = fs.statSync(logFile).size;
    } catch {
      // no log yet
    }
    return {
      addresses: now.addresses,
      passcode: !now.locked ? { off: true } : auth ? { set: true, kind: auth.kind } : { set: false },
      headsets: now.clients.filter((c) => !['127.0.0.1', '::1'].includes(c.ip))
        .map((c) => ({ ip: c.ip, secondsAgo: Math.round((Date.now() - c.at) / 1000) })),
      previews: now.previews,
      formats: now.formats,
      log: { bytes: logBytes },
      update: updater ? updater.status() : null,
    };
  }

  async function act(p, body) {
    if (p === '/api/folders/add' || p === '/api/folders/pick') {
      const dir = p === '/api/folders/pick' ? await pickFolder() : String(body.dir || '').trim().replace(/^"(.*)"$/, '$1');
      if (!dir) return [200, { cancelled: true }];
      let isDir = false;
      try {
        isDir = fs.statSync(dir).isDirectory();
      } catch {
        // not there
      }
      if (!isDir) return [400, { error: `Not a folder: ${dir}` }];
      return [200, { dir: path.resolve(dir), result: addToList(path.resolve(dir)) }];
    }
    if (p === '/api/folders/remove') {
      return removeFromList(String(body.dir || '')) ? [200, { removed: true }] : [404, { error: 'That folder is not in folders.txt.' }];
    }
    if (p === '/api/passcode') {
      try {
        saveAuth(stateDir, String(body.code || ''), { kind: body.kind === 'password' ? 'password' : 'passcode' });
      } catch (err) {
        return [400, { error: err.message }];
      }
      reloadAuth(); // the headset asks for the new one at once; old sessions end
      return [200, { saved: true }];
    }
    if (p === '/api/log/clear') {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, '');
      return [200, { cleared: true }];
    }
    if (p === '/api/stop') {
      setTimeout(stop, 300); // answer first
      return [200, { stopping: true }];
    }
    if (p === '/api/update/check' && updater) return [200, await updater.check()];
    if (p === '/api/update/apply' && updater) {
      const why = updater.blocker();
      if (why) return [409, { error: why }];
      updater.apply().catch(() => {}); // the page follows the progress, and any error, in the status
      return [202, { started: true }];
    }
    return [404, { error: 'Not found' }];
  }

  return async (req, res) => {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${port()}` && host !== `localhost:${port()}`) {
      return send(res, 403, { error: 'The control page answers only as 127.0.0.1 on this laptop.' });
    }
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    try {
      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'" });
        return res.end(fs.readFileSync(page));
      }
      if (req.method === 'GET' && p === '/api/status') return send(res, 200, status());
      if (req.method === 'GET' && p === '/api/folders') return send(res, 200, await folders());
      if (req.method === 'GET' && p === '/api/log') {
        if (!fs.existsSync(logFile)) return send(res, 404, { error: 'No log yet.' });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store',
          'Content-Disposition': 'attachment; filename="session-log.jsonl"' });
        return fs.createReadStream(logFile).pipe(res);
      }
      if (req.method === 'GET') return send(res, 404, { error: 'Not found' }); // a GET never changes anything
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (req.headers['x-vr-player'] !== '1') return send(res, 403, { error: 'A change needs the X-VR-Player header.' });
      const [code, value] = await act(p, await readJson(req));
      return send(res, code, value);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  };
}

// Listens on 127.0.0.1 only. port 0 = any free port (tests). Returns { port, close }.
export async function startControl({ port = 8440, ...options }) {
  let bound = port;
  const server = http.createServer(createControlHandler({ ...options, port: () => bound }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  bound = server.address().port;
  return {
    port: bound,
    close: () => new Promise((r) => {
      server.close(r);
      server.closeAllConnections(); // the page's open connection would hold the port
    }),
  };
}
