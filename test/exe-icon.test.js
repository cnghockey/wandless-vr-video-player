// scripts/exe-icon.mjs: the Wandless icon goes into a real Windows program (this Node), every icon group, nothing else lost.
// The real .exe is checked end to end by building it and running it (README, "Build the .exe").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { iconGroups, icoImages, setIcon } from '../scripts/exe-icon.mjs';
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
