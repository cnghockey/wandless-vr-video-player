import test from 'node:test';
import assert from 'node:assert/strict';
import { Color } from 'three';
import { JOINT_NAMES, createHandMesh, updateHandMesh } from '../public/hands.js';

// A fake three.js hand. Joint i sits at x = i, so the slot a sphere lands in is easy to check.
const fakeHand = (visibleNames, { visible = true } = {}) => ({
  visible,
  joints: Object.fromEntries(JOINT_NAMES.map((name, i) => [name, {
    visible: visibleNames.includes(name),
    jointRadius: 0.01,
    getWorldPosition(v) { return v.set(i, 0, 0); },
  }])),
});

// Read the matrix numbers directly: Matrix4.decompose() reports scale 1 for a zero-scale matrix.
const slot = (mesh, i) => {
  const a = mesh.instanceMatrix.array;
  const o = i * 16;
  return { x: a[o + 12], size: Math.hypot(a[o], a[o + 1], a[o + 2]) };
};
const colorOf = (mesh, i) => {
  const c = new Color();
  mesh.getColorAt(i, c);
  return c.getHex();
};

test('there are 25 named joints and the tips are where the code expects', () => {
  assert.equal(JOINT_NAMES.length, 25);
  assert.equal(JOINT_NAMES[4], 'thumb-tip');
  assert.equal(JOINT_NAMES[9], 'index-finger-tip');
  assert.equal(new Set(JOINT_NAMES).size, 25);
});

test('all joints visible: every sphere sits in its own slot', () => {
  const mesh = createHandMesh();
  assert.equal(updateHandMesh(mesh, fakeHand(JOINT_NAMES), false), 25);
  for (let i = 0; i < 25; i++) {
    const s = slot(mesh, i);
    assert.equal(s.x, i, `slot ${i} position`);
    assert.ok(s.size > 0, `slot ${i} is shown`);
  }
});

test('only the thumb joints reported: the fingers stay hidden, the thumb stays in its slots', () => {
  const mesh = createHandMesh();
  const thumb = JOINT_NAMES.slice(0, 5);
  assert.equal(updateHandMesh(mesh, fakeHand(thumb), false), 5);
  for (let i = 0; i < 5; i++) assert.ok(slot(mesh, i).size > 0);
  for (let i = 5; i < 25; i++) assert.equal(slot(mesh, i).size, 0, `slot ${i} hidden`);
});

test('the index fingertip alone is drawn at its own slot, not at slot 0 (the three.js bug)', () => {
  const mesh = createHandMesh();
  assert.equal(updateHandMesh(mesh, fakeHand(['index-finger-tip']), false), 1);
  const tip = slot(mesh, 9);
  assert.equal(tip.x, 9);
  assert.ok(tip.size > 0);
  assert.equal(slot(mesh, 0).size, 0, 'the wrist slot stays empty');
});

test('a joint that comes back is drawn again, and a lost joint is hidden again', () => {
  const mesh = createHandMesh();
  updateHandMesh(mesh, fakeHand(['index-finger-tip']), false);
  updateHandMesh(mesh, fakeHand(['index-finger-tip', 'ring-finger-tip']), false);
  assert.ok(slot(mesh, 19).size > 0);
  updateHandMesh(mesh, fakeHand(['ring-finger-tip']), false);
  assert.equal(slot(mesh, 9).size, 0);
  assert.ok(slot(mesh, 19).size > 0);
});

test('an untracked hand, a missing hand and a hand with no joints yet show nothing', () => {
  const mesh = createHandMesh();
  updateHandMesh(mesh, fakeHand(JOINT_NAMES), false);
  assert.equal(updateHandMesh(mesh, fakeHand(JOINT_NAMES, { visible: false }), false), 0);
  for (let i = 0; i < 25; i++) assert.equal(slot(mesh, i).size, 0);
  assert.equal(updateHandMesh(mesh, null, false), 0);
  assert.equal(updateHandMesh(mesh, { visible: true, joints: {} }, false), 0);
});

test('the two pinch fingertips are bigger and turn orange only while pinching', () => {
  const mesh = createHandMesh();
  updateHandMesh(mesh, fakeHand(JOINT_NAMES), false);
  assert.equal(colorOf(mesh, 4), 0xffd54a);
  assert.equal(colorOf(mesh, 9), 0xffd54a);
  assert.equal(colorOf(mesh, 14), 0xffffff);
  assert.ok(slot(mesh, 9).size > slot(mesh, 14).size);
  updateHandMesh(mesh, fakeHand(JOINT_NAMES), true);
  assert.equal(colorOf(mesh, 4), 0xf7931a);
  assert.equal(colorOf(mesh, 9), 0xf7931a);
  assert.equal(colorOf(mesh, 14), 0xffffff, 'other joints do not change');
});
