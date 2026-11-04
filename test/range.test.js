import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../lib/range.js';

test('parseRange: no header means no range', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('', 1000), null);
});

test('parseRange: closed, open and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=10-19', 1000), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=990-', 1000), { start: 990, end: 999 });
  assert.deepEqual(parseRange('bytes=-5', 1000), { start: 995, end: 999 });
  assert.deepEqual(parseRange('bytes=0-0', 1000), { start: 0, end: 0 });
});

test('parseRange: an end past the file is cut to the file', () => {
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
});

test('parseRange: unsatisfiable or malformed ranges are invalid', () => {
  for (const h of ['bytes=1000-', 'bytes=2000-3000', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'bytes=a-b',
    'bytes=0-1,5-6', 'items=0-5', 'bytes=0-5; x']) {
    assert.equal(parseRange(h, 1000), 'invalid', h);
  }
  assert.equal(parseRange('bytes=0-0', 0), 'invalid'); // empty file
});
