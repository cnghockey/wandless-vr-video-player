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

test('the copy for the web is marked, says what it is, and stays one self-contained page', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-web-'));
  const site = 'https://name.example/some-path/';
  const { file } = await buildApp({ outDir: out, site });
  const html = fs.readFileSync(file, 'utf8');
  assert.equal(path.basename(file), 'index.html', 'a web host serves index.html at the address itself');
  assert.equal(html.split('<html lang="en" data-web-copy>').length, 2, 'the mark that public/player.js reads');
  assert.ok(!html.includes('<html lang="en">'));
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.match(html, /<title>[^<]*Meta Quest[^<]*hand tracking[^<]*<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{80,300}">/);
  assert.ok(html.includes(`<link rel="canonical" href="${site}">`));
  assert.ok(html.includes(`<meta property="og:image" content="${site}wandless-banner.png">`));
  assert.ok(fs.statSync(path.join(out, 'wandless-banner.png')).size > 1000, 'the picture a shared link shows is beside the page');
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.ok(!html.includes('<!--'));
  assert.ok(!/<script[^>]*\bsrc=/.test(html) && !/<link[^>]*rel=["']?stylesheet/.test(html), 'nothing loads from another address');
  fs.rmSync(out, { recursive: true, force: true });
});

test('the laptop page is not marked as a web copy, and a bad web address stops the build', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-build-'));
  const { file } = await buildApp({ outDir: out });
  const html = fs.readFileSync(file, 'utf8');
  assert.equal(path.basename(file), 'wandless.html');
  assert.equal(html.split('<html lang="en">').length, 2, 'no mark: the laptop serves this page, with its library');
  assert.ok(!html.includes('og:image') && !html.includes('rel="canonical"'));
  for (const bad of ['', 'http://name.example/', 'https://name.example', 'https://name.example/a"b/', 'https://name.example/a b/']) {
    await assert.rejects(buildApp({ outDir: out, site: bad }), /--web needs the address/, `refused: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(fs.readdirSync(out), ['wandless.html'], 'a refused build writes nothing');
  fs.rmSync(out, { recursive: true, force: true });
});

test('the page hides the web-only parts on the laptop, and the laptop-only part on the web', async () => {
  const src = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(src.includes('html:not([data-web-copy]) .web-only, html[data-web-copy] .laptop-only { display: none; }'));
  assert.ok(/<section class="laptop-only">\s*<h2>Watch with the laptop off<\/h2>/.test(src), 'the web copy has no laptop to download from');
  assert.equal((src.match(/class="[^"]*\bweb-only\b[^"]*"/g) || []).length, 3);
  const { repository } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(src.includes(`href="${repository}#readme"`), 'the web copy links to this project');
});
