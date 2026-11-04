// "Wandless.exe --self-test": the check the updater runs on a new download. It must pass on the REAL server with an empty state folder.
// It once expected 503 from the login page, which answers 200 ("No passcode yet"): no update could ever have been installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../server.js';
import { EXPECTED_LOGIN_STATUS, selfTestServer } from '../lib/self-test.js';

test('the self-test passes on the real server, with an empty state folder and no passcode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wandless-selftest-'));
  try {
    const appFile = path.join(dir, 'wandless.html');
    fs.writeFileSync(appFile, '<!doctype html>');
    await selfTestServer(startServer, { stateDir: path.join(dir, '.state'), appFile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the self-test refuses a server whose login page does not answer as expected, and still closes it', async () => {
  let closed = false;
  const fake = async () => ({ port: 1, close: async () => { closed = true; } }); // nothing listens on port 1: the request fails
  await assert.rejects(selfTestServer(fake, { stateDir: 'x', appFile: 'y' }));
  assert.equal(closed, true);
  assert.equal(EXPECTED_LOGIN_STATUS, 200);
});
