// Wandless.exe on Windows: its folder, the first-run install, the shortcuts, the Settings > Apps entry, the uninstall,
// and starting a copy in a new window. The source folder (npm start) uses none of this except launch().
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const NAME = 'Wandless';
// The name Settings > Apps shows, so a stranger knows what the program does. NAME stays short: it is a folder and a file name.
export const TITLE = 'Wandless VR Video Player';
// The files inside Wandless.exe, and where they go in its folder: the same places as in the source folder.
export const ASSETS = { 'wandless.html': 'dist/wandless.html', 'control.html': 'public/control.html', 'add-folder.ps1': 'scripts/add-folder.ps1' };
const UNINSTALL_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\';

// %LOCALAPPDATA%\Wandless: the program, its settings (folders.txt, .state) and its pages, in one folder for this
// Windows user. No administrator rights needed.
export const installDir = (env = process.env) => path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), NAME);
export const installedExe = (env = process.env) => path.join(installDir(env), `${NAME}.exe`);
export const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Runs a short PowerShell script. Values go in as environment variables, so no quoting can break them.
function powershell(script, values = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, ...values }, windowsHide: true, encoding: 'utf8', timeout: 60_000 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
  });
}

// Starts a program in a console window of its own, and returns at once. It keeps running when this program ends.
// (Node starts a "detached" program with no window at all.) VR_WINDOW=hidden: no window (tests).
export function launch(exe, args = []) {
  return powershell(
    `$a = @{ FilePath = $env:VRP_EXE; WorkingDirectory = (Split-Path $env:VRP_EXE) }
     if ($env:VRP_ARGS) { $a.ArgumentList = $env:VRP_ARGS }
     if ($env:VR_WINDOW -eq 'hidden') { $a.WindowStyle = 'Hidden' }
     Start-Process @a`,
    { VRP_EXE: exe, VRP_ARGS: args.map(quoteArg).join(' ') },
  );
}

// One argument on a Windows command line: in quotes when it has a space or a quote (a folder path can).
const quoteArg = (a) => (a && !/[\s"]/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);

// The shortcuts: on the Desktop (Windows knows where it is, also when OneDrive holds it) and in the Start menu.
// linkDirs: other folders, for the tests.
const LINK_DIRS = `$dirs = if ($env:VRP_DIRS) { $env:VRP_DIRS -split '\\|' } else { @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) }`;

export function makeShortcuts(exe, linkDirs) {
  return powershell(
    `${LINK_DIRS}
     $shell = New-Object -ComObject WScript.Shell
     foreach ($dir in $dirs) {
       $link = $shell.CreateShortcut((Join-Path $dir "$env:VRP_NAME.lnk"))
       $link.TargetPath = $env:VRP_EXE
       $link.WorkingDirectory = Split-Path $env:VRP_EXE
       $link.Description = 'Watch your videos on a Meta Quest'
       $link.Save()
     }`,
    { VRP_EXE: exe, VRP_NAME: NAME, VRP_DIRS: linkDirs ? linkDirs.join('|') : '' },
  );
}

// Only a shortcut that points at this program goes: one of the same name that you made for something else stays.
export function removeShortcuts(exe, linkDirs) {
  return powershell(
    `${LINK_DIRS}
     $shell = New-Object -ComObject WScript.Shell
     foreach ($dir in $dirs) {
       $link = Join-Path $dir "$env:VRP_NAME.lnk"
       if ((Test-Path -LiteralPath $link) -and ($shell.CreateShortcut($link).TargetPath -eq $env:VRP_EXE)) { Remove-Item -LiteralPath $link }
     }`,
    { VRP_EXE: exe, VRP_NAME: NAME, VRP_DIRS: linkDirs ? linkDirs.join('|') : '' },
  );
}

// The entry in Settings > Apps, so Wandless can be removed like any program. key: another name, for the tests.
export function register(exe, version, key = NAME) {
  return powershell(
    `$k = $env:VRP_KEY
     New-Item -Path $k -Force | Out-Null
     Set-ItemProperty -Path $k -Name DisplayName -Value $env:VRP_TITLE
     Set-ItemProperty -Path $k -Name DisplayVersion -Value $env:VRP_VERSION
     Set-ItemProperty -Path $k -Name Publisher -Value $env:VRP_NAME
     Set-ItemProperty -Path $k -Name DisplayIcon -Value $env:VRP_EXE
     Set-ItemProperty -Path $k -Name InstallLocation -Value (Split-Path $env:VRP_EXE)
     Set-ItemProperty -Path $k -Name UninstallString -Value ('"' + $env:VRP_EXE + '" --uninstall')
     Set-ItemProperty -Path $k -Name NoModify -Value 1 -Type DWord
     Set-ItemProperty -Path $k -Name NoRepair -Value 1 -Type DWord`,
    { VRP_KEY: UNINSTALL_KEY + key, VRP_NAME: NAME, VRP_TITLE: TITLE, VRP_VERSION: version, VRP_EXE: exe },
  );
}

export function unregister(key = NAME) {
  return powershell('if (Test-Path -LiteralPath $env:VRP_KEY) { Remove-Item -LiteralPath $env:VRP_KEY -Recurse }', { VRP_KEY: UNINSTALL_KEY + key });
}

// Does a Wandless control page answer on this PC? Then Wandless runs.
export function controlAnswers(port = Number(process.env.CONTROL_PORT) || 8440) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: `127.0.0.1:${port}` }, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

export function openControlPage(port = Number(process.env.CONTROL_PORT) || 8440) {
  spawn('explorer.exe', [`http://127.0.0.1:${port}/`], { detached: true, stdio: 'ignore' }).unref();
}

// Stops a running Wandless through its control page, and waits until the page no longer answers.
export async function stopRunning(port = Number(process.env.CONTROL_PORT) || 8440) {
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/stop', method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'X-VR-Player': '1', 'Content-Type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.end('{}');
  });
  for (let i = 0; i < 40 && (await controlAnswers(port)); i++) await new Promise((r) => setTimeout(r, 250));
}

// A downloaded Wandless.exe, run for the first time: it copies itself into the install folder, adds the shortcuts and
// the Settings > Apps entry. Returns the installed file. Wandless must not run (its file could not be replaced).
// The copy is the program's bytes only, as an installer writes them. fs.copyFileSync would also copy the "downloaded
// from the internet" mark, and Windows would then check the installed copy as a new download: SmartScreen warns once,
// on the file you downloaded.
export async function install({ from = process.execPath, version, env = process.env, linkDirs, key } = {}) {
  const exe = installedExe(env);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  await pipeline(fs.createReadStream(from), fs.createWriteStream(exe));
  await makeShortcuts(exe, linkDirs);
  await register(exe, version, key);
  return exe;
}

// Removes the shortcuts, the Settings > Apps entry and the install folder: the program, the passcode, the folder list,
// the previews. The videos stay. A running file cannot be deleted, so a hidden PowerShell waits for this program to
// end, then deletes the folder. (Started by Start-Process: a PowerShell that Node starts "detached" has no console,
// and then it runs nothing at all.) Only a folder named "Wandless" that holds Wandless.exe is ever deleted.
export async function uninstall({ env = process.env, linkDirs, key, waitFor = process.pid } = {}) {
  const dir = installDir(env);
  await removeShortcuts(installedExe(env), linkDirs);
  await unregister(key);
  if (path.basename(dir) !== NAME || !fs.existsSync(installedExe(env))) return false;
  const later = 'Wait-Process -Id $env:VRP_PID -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath $env:VRP_DIR -Recurse -Force';
  await powershell(
    "Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-NonInteractive', '-EncodedCommand', $env:VRP_LATER",
    { VRP_PID: String(waitFor), VRP_DIR: dir, VRP_LATER: Buffer.from(later, 'utf16le').toString('base64') },
  );
  return true;
}
