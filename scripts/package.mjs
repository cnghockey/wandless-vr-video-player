// Builds release\Wandless.exe: Node itself, the server and its pages in one Windows program, with Node's
// single-executable feature. Run it with Node 25.5 or newer (node --build-sea): npm run package
// Then attach release\Wandless.exe to a GitHub release tagged v<the version in package.json>.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from './build.mjs';
import { setIcon } from './exe-icon.mjs';
import { ASSETS } from '../lib/install.js';
import { ASSET, parseRepo } from '../lib/update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One CommonJS file with everything the program runs. Inside the .exe, __dirname is the program's folder, so the
// modules' own file paths point there (none of them is read: scripts/exe.js gives main() the folder).
// The "#bundle" ending: server.js runs main() by itself when its own address is the started file's address. A file's
// address never has a "#" part, so inside the bundle that never happens (scripts/exe.js calls main()).
// version, repository: others than package.json's, for the update tests.
// No GitHub repository = no build: the .exe asks it for updates, and a copy that cannot ask could never get the fix.
export async function bundleExe({ outDir = path.join(ROOT, 'release'), version, repository } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const app = { version: version || pkg.version, repository: repository || pkg.repository || null };
  if (!parseRepo(app.repository)) {
    throw new Error('Set "repository" in package.json to the GitHub repository, for example "https://github.com/<owner>/<name>": '
      + 'Wandless.exe asks it for updates.');
  }
  const file = path.join(outDir, 'work', 'vr-player.cjs');
  await build({
    entryPoints: [path.join(ROOT, 'scripts', 'exe.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: file,
    logLevel: 'silent',
    define: { __VR_APP__: JSON.stringify(app), 'import.meta.url': '__vrpUrl' },
    banner: { js: 'var __vrpUrl = require("node:url").pathToFileURL(require("node:path").join(__dirname, "vr-player.cjs")).href + "#bundle";' },
  });
  return { file, app };
}

export async function packageExe({ outDir = path.join(ROOT, 'release'), version, repository } = {}) {
  if (tooOld) {
    throw new Error(`Build the .exe with Node 25.5 or newer (it has node --build-sea). This is Node ${process.versions.node}.\n`
      + 'Run "node scripts/get-build-node.mjs" once: it puts one in .tools\\node\\ for building only.');
  }
  await buildApp();
  const { file, app } = await bundleExe({ outDir, version, repository });
  const exe = path.join(outDir, ASSET);
  const config = path.join(outDir, 'work', 'sea-config.json');
  fs.writeFileSync(config, JSON.stringify({
    main: file,
    output: exe,
    disableExperimentalSEAWarning: true,
    assets: Object.fromEntries(Object.entries(ASSETS).map(([key, rel]) => [key, path.join(ROOT, rel)])),
  }, null, 2));
  fs.rmSync(exe, { force: true });
  execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
  // Node's icon goes, the Wandless icon comes (Explorer, the taskbar, Settings > Apps). The app inside stays: the program is run in the checks.
  fs.writeFileSync(exe, setIcon(fs.readFileSync(exe), fs.readFileSync(path.join(ROOT, 'brand', 'wandless.ico'))));
  const bytes = fs.readFileSync(exe);
  return { exe, version: app.version, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

// The Node that scripts/get-build-node.mjs puts in this folder, when the running one is too old to build.
const BUILD_NODE = path.join(ROOT, '.tools', 'node', 'node.exe');
const [major, minor] = process.versions.node.split('.').map(Number);
const tooOld = major < 25 || (major === 25 && minor < 5);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && tooOld && fs.existsSync(BUILD_NODE)) {
  try {
    execFileSync(BUILD_NODE, process.argv.slice(1), { stdio: 'inherit' });
  } catch {
    process.exit(1);
  }
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv.includes('--version') ? process.argv[process.argv.indexOf('--version') + 1] : undefined;
  packageExe({ version })
    .then((r) => console.log(`Built ${r.exe}\n  version ${r.version}, ${(r.bytes / 1024 / 1024).toFixed(1)} MB\n  sha256 ${r.sha256}`))
    .catch((err) => {
      console.error(`Package failed: ${err.message}`);
      process.exit(1);
    });
}
