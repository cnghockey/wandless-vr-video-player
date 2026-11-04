// Set or change the passcode (digits: the headset shows a number keypad). Run:  npm run set-password
// For a password with letters instead (a full keyboard):  npm run set-password -- --password
// A new passcode or password ends every open session on the headset.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { saveAuth, MIN_PASSWORD_LENGTH } from './lib/auth.js';

const stateDir = process.env.VR_STATE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '.state');
const CTRL_C = String.fromCharCode(3);
const DELETE = String.fromCharCode(127);

function askHidden(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Piped input (a script): read one plain line. PowerShell puts a byte order mark before piped text: drop it.
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', (line) => {
        rl.close();
        resolve(line.replace(/^﻿/, '').replace(/\r$/, ''));
      });
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let text = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(text);
        }
        if (ch === CTRL_C) process.exit(130);
        if (ch === DELETE || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const kind = process.argv.includes('--password') ? 'password' : 'passcode';
const first = await askHidden(kind === 'passcode' ? `New passcode (digits only, at least ${MIN_PASSWORD_LENGTH}): ` : 'New password: ');
if (first.length < MIN_PASSWORD_LENGTH) {
  console.error(`Too short. Use at least ${MIN_PASSWORD_LENGTH} ${kind === 'passcode' ? 'digits' : 'characters'}. Nothing was saved.`);
  process.exit(1);
}
if (kind === 'passcode' && !/^[0-9]+$/.test(first)) {
  console.error('Use digits only (0-9). Nothing was saved. For a password with letters, run:  npm run set-password -- --password');
  process.exit(1);
}
if (process.stdin.isTTY) {
  const second = await askHidden(`Same ${kind} again: `);
  if (second !== first) {
    console.error(`The two ${kind}s differ. Nothing was saved.`);
    process.exit(1);
  }
}
saveAuth(stateDir, first, { kind });
console.log(kind === 'passcode'
  ? 'Passcode saved. The headset shows a number keypad.'
  : 'Password saved. The headset shows a full keyboard.');
console.log('Restart the server if it is running: close its window, then start it again.');
console.log('The server locks out an address after repeated wrong tries, so a short passcode is fine on your home network.');
process.exit(0);
