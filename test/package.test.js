import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleExe } from '../scripts/package.mjs';

// The .exe's code, bundled as scripts/package.mjs does before node --build-sea. The .exe itself needs Node 25.5+.
let base;
before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-package-'));
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('no GitHub repository, no build: such a copy could never get an update', async () => {
  await assert.rejects(bundleExe({ outDir: base, repository: 'https://gitlab.com/someone/vr-player' }), /Set "repository" in package\.json/);
});

test('the bundle carries the version and the repository, and does not start the server by itself', async () => {
  const { file, app } = await bundleExe({ outDir: base, version: '9.8.7', repository: 'github:someone/vr-player' });
  assert.deepEqual(app, { version: '9.8.7', repository: 'github:someone/vr-player' });
  assert.equal(execFileSync(process.execPath, [file, '--version'], { encoding: 'utf8' }).trim(), '9.8.7');
  // Outside the .exe it refuses to run: no server, and no folders.txt written beside it.
  assert.throws(() => execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: 'pipe' }), /start of Wandless\.exe/);
  assert.equal(fs.existsSync(path.join(path.dirname(file), 'folders.txt')), false);
});
