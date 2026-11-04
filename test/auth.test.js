import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAuth, loadAuth, verifyPassword, signSession, verifySession, Throttle, MIN_PASSWORD_LENGTH } from '../lib/auth.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vrp-auth-'));

test('saveAuth stores a hash, never the password', () => {
  const dir = tmp();
  saveAuth(dir, 'correct horse');
  const raw = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!raw.includes('correct horse'));
  const rec = loadAuth(dir);
  assert.ok(verifyPassword('correct horse', rec));
  assert.ok(!verifyPassword('correct horsf', rec));
  assert.ok(!verifyPassword('', rec));
  assert.ok(!verifyPassword('x'.repeat(5000), rec));
  assert.ok(!verifyPassword(undefined, rec));
});

test('a passcode has digits only; the kind is kept; an old file without a kind is a password', () => {
  const dir = tmp();
  assert.throws(() => saveAuth(dir, '12a4', { kind: 'passcode' }), /digits only/);
  assert.throws(() => saveAuth(dir, '123', { kind: 'passcode' }), /at least/);
  assert.throws(() => saveAuth(dir, '1234', { kind: 'pin' }), /Unknown kind/);
  assert.equal(loadAuth(dir), null, 'nothing was saved');
  saveAuth(dir, '2468', { kind: 'passcode' });
  const rec = loadAuth(dir);
  assert.equal(rec.kind, 'passcode');
  assert.ok(verifyPassword('2468', rec));
  assert.ok(!verifyPassword('2469', rec));
  saveAuth(dir, 'with letters');
  assert.equal(loadAuth(dir).kind, 'password', 'the default kind is a password');
  const old = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  delete old.kind;
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(old));
  assert.equal(loadAuth(dir).kind, 'password', 'a file from before passcodes keeps the full keyboard');
});

test('saveAuth refuses a password that is too short', () => {
  assert.throws(() => saveAuth(tmp(), 'a'.repeat(MIN_PASSWORD_LENGTH - 1)), /at least/);
  assert.equal(loadAuth(tmp()), null);
});

test('a new password gets a new salt and a new secret, so old sessions die', () => {
  const dir = tmp();
  saveAuth(dir, 'first-pass');
  const a = loadAuth(dir);
  const token = signSession(a.secret, 60_000);
  saveAuth(dir, 'first-pass');
  const b = loadAuth(dir);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.secret, b.secret);
  assert.ok(verifySession(a.secret, token));
  assert.ok(!verifySession(b.secret, token));
});

test('loadAuth returns null for a missing or damaged file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'auth.json'), '{not json');
  assert.equal(loadAuth(dir), null);
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"salt":"aa"}');
  assert.equal(loadAuth(dir), null);
});

test('sessions: valid, expired, tampered', () => {
  const secret = 'ab'.repeat(32);
  const now = 1_000_000;
  const token = signSession(secret, 5_000, now);
  assert.ok(verifySession(secret, token, now + 4_999));
  assert.ok(!verifySession(secret, token, now + 5_000)); // expired
  const [exp, mac] = token.split('.');
  assert.ok(!verifySession(secret, `${Number(exp) + 100000}.${mac}`, now)); // longer expiry, same mac
  assert.ok(!verifySession(secret, `${exp}.${mac.slice(0, -1)}A`, now));
  assert.ok(!verifySession(secret, `${exp}.`, now));
  assert.ok(!verifySession(secret, 'nodot', now));
  assert.ok(!verifySession(secret, undefined, now));
  assert.ok(!verifySession('cd'.repeat(32), token, now)); // another secret
});

test('Throttle: free tries, then a growing lock that is capped', () => {
  let t = 0;
  const th = new Throttle({ free: 3, baseMs: 1000, maxMs: 4000, now: () => t });
  th.fail('a');
  th.fail('a');
  assert.equal(th.wait('a'), 0); // 2 wrong tries: still free
  th.fail('a'); // 3rd wrong try: lock 1 s
  assert.equal(th.wait('a'), 1000);
  t += 1000;
  assert.equal(th.wait('a'), 0);
  th.fail('a'); // lock 2 s
  assert.equal(th.wait('a'), 2000);
  t += 2000;
  th.fail('a'); // lock 4 s
  assert.equal(th.wait('a'), 4000);
  t += 4000;
  th.fail('a'); // would be 8 s, capped at 4 s
  assert.equal(th.wait('a'), 4000);
});

test('Throttle: addresses are separate, and success clears the count', () => {
  const th = new Throttle({ free: 2, baseMs: 1000, now: () => 0 });
  th.fail('a');
  th.fail('a');
  assert.equal(th.wait('a'), 1000);
  assert.equal(th.wait('b'), 0);
  th.success('a');
  assert.equal(th.wait('a'), 0);
  th.fail('a');
  assert.equal(th.wait('a'), 0); // the count started again
});
