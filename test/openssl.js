// The openssl command, for the tests that check our certificate with another tool. null = not on this PC.
// Wandless itself does not need openssl.
import { execFileSync } from 'node:child_process';

export function findOpenssl() {
  for (const bin of ['openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe']) {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // try the next one
    }
  }
  return null;
}
