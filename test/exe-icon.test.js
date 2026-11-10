// scripts/exe-icon.mjs: the Wandless icon and name go into a real Windows program (this Node), nothing else lost.
// The real .exe is checked end to end by building it and running it (README, "Build the .exe").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { details, iconGroups, icoImages, setDetails, setIcon } from '../scripts/exe-icon.mjs';
import { NAME, TITLE } from '../lib/install.js';
import { NtExecutable, NtExecutableResource } from 'resedit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform !== 'win32';
const ICO = fs.readFileSync(path.join(ROOT, 'brand', 'wandless.ico'));
const resourceKinds = (exe) => NtExecutableResource.from(NtExecutable.from(exe, { ignoreCert: true })).entries.map((e) => e.type).sort();

test('the icon file holds the six Wandless images, as PNG', () => {
  const images = icoImages(ICO);
  assert.equal(images.length, 6);
  for (const bytes of images) assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG');
});

test('setIcon puts the six images into every icon group of a real program, and keeps its other resources', { skip: windows }, () => {
  const exe = fs.readFileSync(process.execPath);
  const before = iconGroups(exe);
  assert.ok(before.length >= 1, 'Node has an icon group of its own');
  const out = setIcon(exe, ICO);
  const after = iconGroups(out);
  assert.deepEqual(after.map((g) => [g.id, g.lang]), before.map((g) => [g.id, g.lang]), 'the same groups, replaced in place');
  const want = icoImages(ICO);
  for (const g of after) {
    assert.equal(g.images.length, 6);
    g.images.forEach((bytes, i) => assert.ok(bytes && bytes.equals(want[i]), `image ${i} is the Wandless image`));
  }
  assert.notDeepEqual(iconGroups(exe)[0].images.map((b) => b && b.length), after[0].images.map((b) => b.length), 'Node\'s own icon is gone');
  const kinds = resourceKinds(out);
  for (const kind of new Set(resourceKinds(exe))) assert.ok(kinds.includes(kind), `the resource type ${kind} is still there`);
});

test('setIcon: a file that is not a program, or an icon file with no image, is refused', () => {
  assert.throws(() => setIcon(Buffer.from('not a program'), ICO));
  assert.throws(() => setIcon(fs.readFileSync(process.execPath), Buffer.alloc(6, 0)));
});

const WANDLESS = { title: TITLE, name: NAME, version: '9.8.7' };

test('setDetails: Windows reads "Wandless VR Video Player" from the program, and Node only in the copyright line', { skip: windows }, () => {
  const exe = fs.readFileSync(process.execPath);
  const before = details(exe);
  assert.ok(before.length >= 1 && before.every((d) => /Node\.js/.test(d.texts.FileDescription)), 'the reader sees the name that Node gave it first');
  const out = setDetails(exe, WANDLESS);
  const after = details(out);
  assert.equal(after.length, before.length, 'the same language tables');
  for (const { texts, fileVersion } of after) {
    assert.equal(texts.FileDescription, 'Wandless VR Video Player'); // the Firewall prompt and Task Manager show this one
    assert.equal(texts.ProductName, 'Wandless VR Video Player');
    assert.equal(texts.CompanyName, 'Wandless');
    assert.equal(texts.OriginalFilename, 'Wandless.exe');
    assert.equal(texts.InternalName, 'Wandless');
    assert.equal(texts.FileVersion, '9.8.7');
    assert.equal(texts.ProductVersion, '9.8.7');
    assert.deepEqual(fileVersion, [9, 8, 7, 0]);
    assert.match(texts.LegalCopyright, /Wandless authors.*Node\.js contributors/);
    const naming = Object.entries(texts).filter(([, text]) => /node/i.test(text)).map(([key]) => key);
    assert.deepEqual(naming, ['LegalCopyright'], 'no other text names Node');
  }
  assert.deepEqual(iconGroups(out), iconGroups(exe), 'the icons are not touched');
  const kinds = resourceKinds(out);
  for (const kind of new Set(resourceKinds(exe))) assert.ok(kinds.includes(kind), `the resource type ${kind} is still there`);
});

test('setDetails after setIcon, as the build does: the program has the Wandless icon and the Wandless name', { skip: windows }, () => {
  const out = setDetails(setIcon(fs.readFileSync(process.execPath), ICO), WANDLESS);
  const want = icoImages(ICO);
  for (const g of iconGroups(out)) g.images.forEach((bytes, i) => assert.ok(bytes && bytes.equals(want[i])));
  for (const { texts } of details(out)) assert.equal(texts.FileDescription, 'Wandless VR Video Player');
});

test('setDetails: a program with no version resource gets one', { skip: windows }, () => {
  const nt = NtExecutable.from(fs.readFileSync(process.execPath), { ignoreCert: true });
  const res = NtExecutableResource.from(nt);
  res.entries = res.entries.filter((e) => e.type !== 16); // 16 = the version resource
  res.outputResource(nt);
  const bare = Buffer.from(nt.generate());
  assert.deepEqual(details(bare), [], 'the name is gone');
  const [made, ...more] = details(setDetails(bare, WANDLESS));
  assert.equal(more.length, 0);
  assert.equal(made.texts.FileDescription, 'Wandless VR Video Player');
  assert.deepEqual(made.fileVersion, [9, 8, 7, 0]);
});

test('setDetails: a version that is not x.y.z, or a file that is not a program, is refused', () => {
  const exe = fs.readFileSync(process.execPath);
  assert.throws(() => setDetails(exe, { ...WANDLESS, version: '9.8' }), /x\.y\.z/);
  assert.throws(() => setDetails(exe, { ...WANDLESS, version: 'v9.8.7' }), /x\.y\.z/);
  assert.throws(() => setDetails(Buffer.from('not a program'), WANDLESS));
});
