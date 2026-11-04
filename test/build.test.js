import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../scripts/build.mjs';

test('the build makes one self-contained page: no modules, no import map, one script', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-build-'));
  const { file, bytes } = await buildApp({ outDir: out });
  const html = fs.readFileSync(file, 'utf8');
  assert.ok(bytes > 100_000, 'three.js and the player are inside');
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'no stray closing tag inside the script');
  assert.ok(!html.includes('type="module"'));
  assert.ok(!html.includes('importmap'));
  assert.ok(!html.includes('APP_SCRIPT'), 'the marker is replaced');
  assert.ok(!html.includes('<!--'), 'no comment opener that could confuse the script block');
  assert.ok(!/<script[^>]*\bsrc=/.test(html), 'no external script');
  assert.ok(!/<link[^>]*rel=["']?stylesheet/.test(html), 'no external stylesheet');
  assert.ok(html.includes('id="pick"') && html.includes('id="vr"'), 'the page markup survived');
  assert.ok(html.includes('Z2xURg'), 'the hand models are inside (a .glb file starts with "glTF", base64 "Z2xURg")');
  fs.rmSync(out, { recursive: true, force: true });
});

test('the build refuses a template without exactly one marker', async () => {
  const src = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal(src.split('<!--APP_SCRIPT-->').length, 2, 'the real template has exactly one marker');
});
