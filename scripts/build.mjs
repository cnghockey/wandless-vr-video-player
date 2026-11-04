// Builds ONE self-contained file: dist/wandless.html (page + player + three.js, no network needed).
// The laptop serves it, and you can also copy it to the headset and open it from storage.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<!--APP_SCRIPT-->';

export async function buildApp({ outDir = path.join(ROOT, 'dist') } = {}) {
  const result = await build({
    entryPoints: [path.join(ROOT, 'public', 'player.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
    loader: { '.glb': 'binary' }, // the hand models go inside the file, as bytes
  });
  // Inside an inline script, "</script" and "<!--" would end or confuse the script block.
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

  const template = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  if (template.split(MARKER).length !== 2) throw new Error(`index.html needs exactly one ${MARKER}`);
  const html = template.replace(MARKER, () => `<script>${js}</script>`); // function form: no "$&" surprises

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'wandless.html');
  fs.writeFileSync(file, html);
  return { file, bytes: Buffer.byteLength(html) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildApp()
    .then(({ file, bytes }) => console.log(`Built ${file} (${Math.round(bytes / 1024)} KB)`))
    .catch((err) => {
      console.error('Build failed:', err.message);
      process.exit(1);
    });
}
