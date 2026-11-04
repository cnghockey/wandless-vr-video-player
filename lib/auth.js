import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const authFile = (stateDir) => path.join(stateDir, 'auth.json');

export const MIN_PASSWORD_LENGTH = 4; // a headset PIN is allowed; the lockout slows guessing

function hashWith(password, salt) {
  return crypto.scryptSync(password.normalize('NFKC'), salt, 32, SCRYPT);
}

// Save a new password. A new cookie secret ends every open session.
// kind: 'passcode' (digits only: the login page shows a number keypad) or 'password' (any text, a full keyboard).
export function saveAuth(stateDir, password, { kind = 'password' } = {}) {
  if (kind !== 'passcode' && kind !== 'password') throw new Error(`Unknown kind: ${kind}`);
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The ${kind} needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (kind === 'passcode' && !/^[0-9]+$/.test(password)) throw new Error('A passcode has digits only (0-9).');
  fs.mkdirSync(stateDir, { recursive: true });
  const salt = crypto.randomBytes(16);
  const record = {
    salt: salt.toString('hex'),
    hash: hashWith(password, salt).toString('hex'),
    secret: crypto.randomBytes(32).toString('hex'),
    kind,
  };
  fs.writeFileSync(authFile(stateDir), JSON.stringify(record), { mode: 0o600 });
}

// A file saved before passcodes existed has no kind: it is a password (it may have letters).
export function loadAuth(stateDir) {
  try {
    const record = JSON.parse(fs.readFileSync(authFile(stateDir), 'utf8'));
    return record.salt && record.hash && record.secret ? { ...record, kind: record.kind === 'passcode' ? 'passcode' : 'password' } : null;
  } catch {
    return null;
  }
}

export function verifyPassword(password, record) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const given = hashWith(password, Buffer.from(record.salt, 'hex'));
  return crypto.timingSafeEqual(given, Buffer.from(record.hash, 'hex'));
}

const mac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');

// A session token is "<expiry ms>.<hmac of the expiry>". The server keeps no session list.
export function signSession(secret, ttlMs, now = Date.now()) {
  const exp = String(now + ttlMs);
  return `${exp}.${mac(secret, exp)}`;
}

export function verifySession(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(secret, exp));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;
  return Number(exp) > now;
}

// Slows password guessing. After `free` wrong tries from one address, each new
// wrong try locks that address for a longer time: base, 2x base, 4x base, up to max.
export class Throttle {
  constructor({ free = 5, baseMs = 30_000, maxMs = 900_000, now = Date.now } = {}) {
    Object.assign(this, { free, baseMs, maxMs, now });
    this.state = new Map();
  }

  // Milliseconds this address must still wait. 0 means it may try.
  wait(key) {
    const s = this.state.get(key);
    return s ? Math.max(0, s.lockedUntil - this.now()) : 0;
  }

  fail(key) {
    const s = this.state.get(key) || { fails: 0, lockedUntil: 0 };
    s.fails += 1;
    if (s.fails >= this.free) {
      const wait = Math.min(this.maxMs, this.baseMs * 2 ** (s.fails - this.free));
      s.lockedUntil = this.now() + wait;
    }
    this.state.set(key, s);
  }

  success(key) {
    this.state.delete(key);
  }
}
