import fs from 'node:fs';
import path from 'node:path';

export const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

// List the video files under `root`. Hidden folders and symbolic links are skipped.
// date: when the file came to this computer or last changed (the later of the two), for "newest first".
export async function scanLibrary(root, { maxFiles = 5000, maxDepth = 6 } = {}) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && VIDEO_TYPES[path.extname(e.name).toLowerCase()]) {
        try {
          const { size, mtimeMs, birthtimeMs } = await fs.promises.stat(full);
          const date = Math.round(Math.max(mtimeMs, birthtimeMs || 0));
          out.push({ path: path.relative(root, full).split(path.sep).join('/'), name: e.name, size, date });
        } catch {
          // the file vanished while scanning
        }
      }
    }
  }
  await walk(root, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
}

// Turn a URL path (already decoded) into a real file inside `root`, or null.
// Refuses "..", other drives, non-video files and symbolic links that point outside.
export const resolveMedia = (root, rel) => resolveInside(root, rel, VIDEO_TYPES);

// The same rules for any kind of file: `types` maps the allowed extensions to their content types.
export async function resolveInside(root, rel, types) {
  if (!rel || rel.includes('\0')) return null;
  const type = types[path.extname(rel).toLowerCase()];
  if (!type) return null;
  try {
    const realRoot = await fs.promises.realpath(root);
    const real = await fs.promises.realpath(path.resolve(realRoot, rel));
    const inside = path.relative(realRoot, real);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
    const st = await fs.promises.stat(real);
    return st.isFile() ? { file: real, size: st.size, type } : null;
  } catch {
    return null;
  }
}
