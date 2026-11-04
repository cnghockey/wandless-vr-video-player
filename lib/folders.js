import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The video folders the headset may open. Nothing outside them is ever served.
// The headset never sends a folder path: it sends a short id, and the server looks the id up in this list.

// folders.txt: one folder per line. Blank lines and lines that start with # are skipped.
// Quotes round a path (Explorer's "Copy as path" adds them) are removed.
export function parseFolderList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter((line) => line && !line.startsWith('#'));
}

// Windows paths ignore case, so the id does too.
export const folderId = (dir) => crypto.createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 10);

// The --root folders first, then the folders in the list file, each folder once.
// Returns { folders: [{ id, label, dir }], missing: [dir] }. A missing folder (a drive that is not plugged in) is left out.
export function loadFolders({ roots = [], listFile = null } = {}) {
  let listed = [];
  if (listFile) {
    try {
      listed = parseFolderList(fs.readFileSync(listFile, 'utf8'));
    } catch {
      // no list file yet
    }
  }
  const seen = new Set();
  const folders = [];
  const missing = [];
  for (const raw of [...roots, ...listed]) {
    const dir = path.resolve(raw);
    const id = folderId(dir);
    if (seen.has(id)) continue;
    seen.add(id);
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      // not there
    }
    if (isDir) folders.push({ id, dir, label: path.basename(dir) || dir });
    else missing.push(dir);
  }
  // Two folders with the same name: show the folder above too, so they can be told apart.
  const names = folders.map((f) => f.label);
  for (const f of folders) {
    if (names.filter((n) => n === f.label).length > 1) f.label = `${path.basename(path.dirname(f.dir))}/${f.label}`;
  }
  return { folders, missing };
}
