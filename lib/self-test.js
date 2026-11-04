// What "Wandless.exe --self-test" checks (scripts/exe.js). The updater runs it on a new download before it puts the file in place:
// the server starts on a free port with an empty state folder, and its login page answers over HTTPS.
// With no passcode yet the page still answers 200 and says "No passcode yet" (test/control.test.js). The check lives here, and not in
// exe.js, so that test/self-test.test.js runs the same check against the real server. (It once asked for 503 and refused every update.)
import https from 'node:https';

export const EXPECTED_LOGIN_STATUS = 200;

export async function selfTestServer(startServer, { stateDir, appFile }) {
  const app = await startServer({ port: 0, host: '127.0.0.1', stateDir, appFile, folders: [] });
  let status;
  try {
    status = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: app.port, path: '/login', rejectUnauthorized: false }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
  } finally {
    await app.close();
  }
  if (status !== EXPECTED_LOGIN_STATUS) throw new Error(`the login page answered ${status}, not ${EXPECTED_LOGIN_STATUS}`);
}
