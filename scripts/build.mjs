// Builds ONE self-contained file: dist/wandless.html (page + player + three.js, no network needed).
// The laptop serves it, and you can also copy it to the headset and open it from storage.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<!--APP_SCRIPT-->';

// The copy on the web: `node scripts/build.mjs --web https://name.example/path/` writes dist/site/index.html.
// The mark on <html> makes the page play only the files on the device that opens it, with no request to a server
// (public/player.js reads it). The other lines are the words that a search engine and a shared link show.
const HTML_TAG = '<html lang="en">';
const TITLE = '<title>Wandless VR Video Player</title>';
const ABOUT = 'A free, open-source VR video player for the Meta Quest. It runs in the Meta Quest Browser, and your hands '
  + 'are the whole remote: no controllers. It plays VR180 and flat video stored on the headset. Nothing to install.';

function webCopy(template, site) {
  if (!/^https:\/\/[A-Za-z0-9.-]+\/([A-Za-z0-9._~-]+\/)*$/.test(site)) {
    throw new Error('--web needs the address of the copy: https://..., with the last slash');
  }
  for (const part of [HTML_TAG, TITLE]) {
    if (template.split(part).length !== 2) throw new Error(`index.html needs exactly one ${part}`);
  }
  const head = [
    '<title>Wandless: a free VR video player for Meta Quest with hand tracking</title>',
    `<meta name="description" content="${ABOUT}">`,
    `<link rel="canonical" href="${site}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:title" content="Wandless VR Video Player">',
    `<meta property="og:description" content="${ABOUT}">`,
    `<meta property="og:url" content="${site}">`,
    `<meta property="og:image" content="${site}wandless-banner.png">`,
    '<meta name="twitter:card" content="summary_large_image">',
  ].join('\n');
  return template.replace(HTML_TAG, '<html lang="en" data-web-copy>').replace(TITLE, () => head);
}

// site: null for the laptop's page (wandless.html), or the address of the copy on the web (index.html + its banner).
export async function buildApp({ outDir = path.join(ROOT, 'dist'), site = null } = {}) {
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

  let template = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  if (template.split(MARKER).length !== 2) throw new Error(`index.html needs exactly one ${MARKER}`);
  if (site !== null) template = webCopy(template, site); // before the script goes in: its text is not searched
  const html = template.replace(MARKER, () => `<script>${js}</script>`); // function form: no "$&" surprises

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, site === null ? 'wandless.html' : 'index.html');
  fs.writeFileSync(file, html);
  if (site !== null) fs.copyFileSync(path.join(ROOT, 'brand', 'wandless-banner.png'), path.join(outDir, 'wandless-banner.png'));
  return { file, bytes: Buffer.byteLength(html) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const web = process.argv.indexOf('--web');
  buildApp(web < 0 ? {} : { outDir: path.join(ROOT, 'dist', 'site'), site: process.argv[web + 1] || '' })
    .then(({ file, bytes }) => console.log(`Built ${file} (${Math.round(bytes / 1024)} KB)`))
    .catch((err) => {
      console.error('Build failed:', err.message);
      process.exit(1);
    });
}
