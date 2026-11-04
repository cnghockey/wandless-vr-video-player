// Gets a Node that can build Wandless.exe (Node 25.5 and newer have node --build-sea), for building only. It goes
// into .tools\node\ in this folder and changes nothing else on the PC: the Node you have stays as it is.
// It takes the newest LTS release, or the newest release, from nodejs.org, and checks its SHA-256 against the list
// nodejs.org publishes for that release. Run: node scripts/get-build-node.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, '.tools');
const DIST = 'https://nodejs.org/dist';
const enough = (v) => {
  const [major, minor] = v.replace(/^v/, '').split('.').map(Number);
  return major > 25 || (major === 25 && minor >= 5);
};

const releases = (await (await fetch(`${DIST}/index.json`)).json()).filter((r) => enough(r.version) && r.files.includes('win-x64-zip'));
const release = releases.find((r) => r.lts) || releases[0];
if (!release) throw new Error('nodejs.org lists no release with node --build-sea for Windows x64.');
const name = `node-${release.version}-win-x64`;
console.log(`Node ${release.version}${release.lts ? ` (LTS ${release.lts})` : ''}`);

const sums = await (await fetch(`${DIST}/${release.version}/SHASUMS256.txt`)).text();
const want = (sums.split('\n').find((line) => line.endsWith(`  ${name}.zip`)) || '').split(' ')[0];
if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`SHASUMS256.txt has no line for ${name}.zip`);
const res = await fetch(`${DIST}/${release.version}/${name}.zip`);
if (!res.ok) throw new Error(`The download failed (${res.status})`);
const zip = Buffer.from(await res.arrayBuffer());
const got = crypto.createHash('sha256').update(zip).digest('hex');
if (got !== want) throw new Error(`The download does not match nodejs.org's checksum (${got}, not ${want}). Nothing was unpacked.`);
console.log(`SHA-256 checked: ${got}`);

fs.mkdirSync(TOOLS, { recursive: true });
const zipFile = path.join(TOOLS, `${name}.zip`);
fs.writeFileSync(zipFile, zip);
fs.rmSync(path.join(TOOLS, name), { recursive: true, force: true });
// Windows' own tar (10 and newer) reads zip files. Its full path: from Git Bash, "tar" is GNU tar, which does not.
execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipFile, '-C', TOOLS]);
fs.rmSync(zipFile);
fs.rmSync(path.join(TOOLS, 'node'), { recursive: true, force: true });
fs.renameSync(path.join(TOOLS, name), path.join(TOOLS, 'node'));
console.log(`Ready: ${path.join(TOOLS, 'node', 'node.exe')} (${execFileSync(path.join(TOOLS, 'node', 'node.exe'), ['--version'], { encoding: 'utf8' }).trim()})`);
console.log('npm run package now builds the .exe with it.');
