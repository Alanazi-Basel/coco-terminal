'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell, Notification, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { execFile, spawn: cpSpawn } = require('child_process');
const { Client: SSH2Client } = require('ssh2');
const pty = require('node-pty');
const { Store } = require('./store');
const { buildSpawn, defaultShell } = require('./shell-integration');

// Keep upgrades on the same local-only data directory even if product metadata changes.
// The environment override is useful for isolated development and test profiles.
app.setPath('userData', process.env.COCO_USER_DATA_DIR || path.join(app.getPath('appData'), 'coco-terminal'));
app.setAboutPanelOptions({
  applicationName: 'Coco',
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
  copyright: `Copyright © ${new Date().getFullYear()} Coco`,
  iconPath: path.join(__dirname, '..', '..', 'assets', 'icon-source.png'),
});

let win = null;
let store = null;
const ptys = new Map(); // tabId -> pty process
let updateTimer = null;
let updateInitialTimer = null;
let updateConfigured = false;
let updateChecking = false;
let automaticUpdates = false;

// --- quit / restore coordination ---
let quitting = false;
let allowQuit = false;

function createWindow() {
  const isMac = process.platform === 'darwin';
  const windowOptions = {
    width: 1200,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: isMac ? '#00000000' : '#111411',
    transparent: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (isMac) {
    windowOptions.vibrancy = 'under-window';
    windowOptions.visualEffectState = 'active';
    windowOptions.trafficLightPosition = { x: 14, y: 18 };
  } else {
    // Keep native minimize/maximize/close controls while allowing Coco's
    // toolbar to occupy the title-bar surface on Windows and Linux.
    windowOptions.titleBarOverlay = { color: '#111411', symbolColor: '#dce6de', height: 46 };
  }
  win = new BrowserWindow(windowOptions);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    openTrustedExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  // Surface renderer diagnostics only in development.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (_e, details) => {
      console.log(`[renderer:${details.level || 'log'}] ${details.message || ''}`);
    });
  }
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[renderer gone]', details.reason);
  });

  win.on('close', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    handleQuitRequest();
  });
}

// Save according to the user's persistent setting. Closing never opens a prompt.
async function handleQuitRequest() {
  if (quitting) return;
  quitting = true;
  try {
    await win.webContents.executeJavaScript('window.coco && window.coco.prepareQuit ? window.coco.prepareQuit() : Promise.resolve()');
  } catch {}
  finishQuit();
}

function finishQuit() {
  allowQuit = true;
  cleanupProcesses();
  app.quit();
}
function cleanupProcesses() {
  if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
  if (updateInitialTimer) { clearTimeout(updateInitialTimer); updateInitialTimer = null; }
  for (const p of ptys.values()) { try { p.kill(); } catch {} }
  ptys.clear();
  for (const connection of sftpConns.values()) { try { connection.client.end(); } catch {} }
  sftpConns.clear();
  for (const child of tunnels.values()) { try { child.kill(); } catch {} }
  tunnels.clear();
}
// Immediate, dialog-free shutdown — used for signals (pkill/relaunch) so the old
// instance never lingers as a black zombie window waiting on the quit dialog.
let forcing = false;
function forceQuit() {
  if (forcing) return; forcing = true;
  allowQuit = true;
  const done = () => {
    cleanupProcesses();
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
    try { app.exit(0); } catch {}
    setTimeout(() => { try { process.exit(0); } catch {} }, 80);
  };
  // best-effort final save (works for SIGTERM/SIGINT; SIGKILL can't be caught)
  try {
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.executeJavaScript('window.coco && window.coco.flushSave && window.coco.flushSave()').then(done, done);
      setTimeout(done, 400); // don't wait forever
    } else done();
  } catch { done(); }
}
process.on('SIGTERM', forceQuit);
process.on('SIGINT', forceQuit);
process.on('SIGHUP', forceQuit);

// ---------------- IPC: PTY lifecycle ----------------
ipcMain.handle('pty:spawn', (event, { tabId, cwd, command, history, ssh }) => {
  let shell, args, env, startCwd;

  if (ssh && ssh.host) {
    // SSH shell or SFTP file-transfer session. Prompts happen inside the pty.
    const target = ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host;
    args = [];
    if (ssh.mode === 'sftp') {
      shell = 'sftp';
      if (ssh.port && String(ssh.port) !== '22') args.push('-P', String(ssh.port)); // sftp uses -P
      if (ssh.identity) args.push('-i', ssh.identity);
      args.push('-o', 'StrictHostKeyChecking=accept-new', target);
    } else {
      shell = 'ssh';
      if (ssh.port && String(ssh.port) !== '22') args.push('-p', String(ssh.port));
      if (ssh.identity) args.push('-i', ssh.identity);
      args.push('-o', 'ServerAliveInterval=30', '-o', 'StrictHostKeyChecking=accept-new', target);
    }
    env = { ...process.env, TERM_PROGRAM: 'coco' };
    startCwd = os.homedir();
  } else {
    const integrationDir = path.join(app.getPath('userData'), 'shell-integration');
    ({ shell, args, env } = buildSpawn(integrationDir, process.env));

    // seed restored command history into a per-session histfile (loaded silently by the rc)
    if (history && history.length) {
      try {
        const histDir = path.join(app.getPath('userData'), 'hist');
        fs.mkdirSync(histDir, { recursive: true });
        const hf = path.join(histDir, String(tabId).replace(/[^\w.-]/g, '_'));
        fs.writeFileSync(hf, history.slice(-300).join('\n') + '\n');
        env.COCO_RESTORE_HIST = hf;
      } catch {}
    }
    startCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  }

  const previous = ptys.get(tabId);
  if (previous) { try { previous.kill(); } catch {} ptys.delete(tabId); }
  let p;
  try {
    p = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: startCwd,
      env,
    });
  } catch (error) {
    return { ok: false, error: `Could not start ${shell}: ${error.message || error}` };
  }

  p.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', { tabId, data });
  });
  p.onExit(({ exitCode }) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { tabId, exitCode });
    ptys.delete(tabId);
  });

  ptys.set(tabId, p);

  if (command) {
    p.write(command + '\r');
  }
  return { ok: true, shell, cwd: startCwd };
});

ipcMain.on('pty:input', (event, { tabId, data }) => {
  const p = ptys.get(tabId);
  if (p) p.write(data);
});

ipcMain.on('pty:resize', (event, { tabId, cols, rows }) => {
  const p = ptys.get(tabId);
  if (p && cols > 0 && rows > 0) {
    try { p.resize(cols, rows); } catch {}
  }
});

ipcMain.on('pty:kill', (event, { tabId }) => {
  const p = ptys.get(tabId);
  if (p) { try { p.kill(); } catch {} ptys.delete(tabId); }
});

ipcMain.on('notification:show', (_event, { tabId, title, body }) => {
  const notificationTitle = String(title || 'coco');
  const notificationBody = String(body || '');
  const openTab = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('notification:open', { tabId });
  };
  if (Notification.isSupported()) {
    try {
      const notification = new Notification({
        title: notificationTitle,
        body: notificationBody,
        silent: false,
        sound: 'default',
      });
      notification.on('click', openTab);
      notification.show();
      return;
    } catch {}
  }
  // Development Electron builds can occasionally lack Notification Center
  // registration on macOS. Keep a native fallback so completion is still
  // visible instead of silently disappearing.
  if (process.platform === 'darwin') {
    const script = `display notification ${JSON.stringify(notificationBody)} with title ${JSON.stringify(notificationTitle)} sound name "Glass"`;
    execFile('/usr/bin/osascript', ['-e', script], () => {});
  }
});

function claudeExecutable() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.cmd'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'claude.cmd') : '',
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

ipcMain.handle('claude:notification-status', async () => {
  if (!claudeExecutable()) return { ok: false, missing: true, error: 'Claude Code is not installed.' };
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return { ok: true, enabled: settings.preferredNotifChannel === 'terminal_bell' };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, enabled: false };
    return { ok: false, error: 'Could not read Claude settings.' };
  }
});

ipcMain.handle('claude:enable-notifications', async () => {
  if (!claudeExecutable()) return { ok: false, missing: true, error: 'Claude Code is not installed.' };
  try {
    const settingsDir = path.join(os.homedir(), '.claude');
    const settingsPath = path.join(settingsDir, 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    settings.preferredNotifChannel = 'terminal_bell';
    fs.mkdirSync(settingsDir, { recursive: true });
    const tempPath = settingsPath + '.coco-tmp';
    fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tempPath, settingsPath);
    return { ok: true, enabled: true };
  } catch {
    return { ok: false, error: 'Could not update Claude settings.' };
  }
});
ipcMain.handle('claude:disable-notifications', async () => {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    if (settings.preferredNotifChannel === 'terminal_bell') delete settings.preferredNotifChannel;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const tempPath = settingsPath + '.coco-tmp';
    fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tempPath, settingsPath);
    return { ok: true, enabled: false };
  } catch {
    return { ok: false, error: 'Could not update Claude settings.' };
  }
});

// ---------------- IPC: persistence ----------------
ipcMain.handle('store:get', (event, key) => store.get(key, null));
ipcMain.handle('store:set', (event, { key, value }) => { store.set(key, value); return true; });
ipcMain.handle('store:delete', (event, key) => { store.delete(key); return true; });

// ---- clickable file paths ----
function expandHome(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }
// Given raw text that may include trailing junk (e.g. "/a/b file.txt: error"),
// return the LONGEST leading path that actually exists on disk (handles spaces).
function resolveExisting(cwd, raw) {
  if (!raw) return null;
  let s = raw.replace(/\s+$/, '');
  let guard = 0;
  while (s.length && guard++ < 64) {
    const cand = s.replace(/[\s.,:;)\]}>'"]+$/, ''); // drop trailing punctuation/space
    if (!cand) break;
    let abs;
    try { abs = path.resolve(cwd || os.homedir(), expandHome(cand)); } catch { break; }
    try { const st = fs.statSync(abs); return { abs, len: cand.length, isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs }; } catch {}
    const trimmed = cand.replace(/\s*\S+$/, ''); // remove the last whitespace-delimited token
    if (trimmed === cand) break; // single token that doesn't exist
    s = trimmed;
  }
  return null;
}
// Scan one line of terminal text and return every existing path in it (greedy,
// left-to-right, non-overlapping). Handles spaces, unicode, multi-column ls, ls -la.
function scanLineForPaths(cwd, text) {
  if (!text) return [];
  const out = [];
  let cursor = -1;
  for (let i = 0; i < text.length && out.length < 40; i++) {
    if (i <= cursor) continue;
    const prev = i === 0 ? undefined : text[i - 1];
    const isBoundary = prev === undefined || /[\s([{<'"=,]/.test(prev);
    if (!isBoundary) continue;
    if (/[\s)\]}>'"]/.test(text[i])) continue;
    const raw = text.slice(i);
    if (raw.startsWith('//')) continue;
    const r = resolveExisting(cwd, raw);
    if (r) { out.push({ start: i, len: r.len, isDir: r.isDir }); cursor = i + r.len - 1; }
  }
  return out;
}
ipcMain.handle('path:scan-line', (e, { cwd, text }) => scanLineForPaths(cwd, text));
ipcMain.handle('path:resolve', (e, { cwd, raw }) => { const r = resolveExisting(cwd, raw); return r ? { len: r.len, isDir: r.isDir } : null; });
ipcMain.handle('path:preview', (e, { cwd, raw }) => {
  const r = resolveExisting(cwd, raw);
  if (!r) return null;
  const info = { abs: r.abs, isDir: r.isDir, size: r.size, mtimeMs: r.mtimeMs, name: path.basename(r.abs) };
  try {
    if (r.isDir) {
      const all = fs.readdirSync(r.abs);
      info.count = all.length;
      info.entries = all.slice(0, 24);
    } else {
      const ext = path.extname(r.abs).toLowerCase();
      info.ext = ext || '(no ext)';
      info.isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif'].includes(ext);
      if (info.isImage && r.size <= 12 * 1024 * 1024) {
        const mimes = { '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' };
        const mime = mimes[ext] || 'image/' + ext.slice(1);
        info.dataUrl = `data:${mime};base64,${fs.readFileSync(r.abs).toString('base64')}`;
      } else if (!info.isImage && r.size < 512 * 1024) {
        const buf = fs.readFileSync(r.abs);
        if (buf.includes(0)) info.binary = true;
        else info.snippet = buf.toString('utf8').split('\n').slice(0, 16).join('\n');
      }
    }
  } catch {}
  return info;
});
ipcMain.handle('path:open', async (e, { cwd, raw, reveal }) => {
  const r = resolveExisting(cwd, raw);
  if (!r) return { ok: false, error: 'not found' };
  if (reveal) { shell.showItemInFolder(r.abs); return { ok: true }; }
  const err = await shell.openPath(r.abs);
  return { ok: !err, error: err || undefined };
});

ipcMain.handle('directory:open-with', async (_event, cwd) => {
  const dir = path.resolve(String(cwd || os.homedir()));
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'not a directory' };
  } catch {
    return { ok: false, error: 'directory not found' };
  }
  const home = os.homedir();
  const localApps = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const platformApps = {
    darwin: [
      { label: 'Cursor', path: '/Applications/Cursor.app' },
      { label: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app' },
      { label: 'Zed', path: '/Applications/Zed.app' },
      { label: 'Sublime Text', path: '/Applications/Sublime Text.app' },
    ],
    win32: [
      { label: 'Cursor', path: path.join(localApps, 'Programs', 'cursor', 'Cursor.exe') },
      { label: 'Visual Studio Code', path: path.join(localApps, 'Programs', 'Microsoft VS Code', 'Code.exe') },
      { label: 'Visual Studio Code', path: path.join(programFiles, 'Microsoft VS Code', 'Code.exe') },
      { label: 'Sublime Text', path: path.join(programFiles, 'Sublime Text', 'sublime_text.exe') },
    ],
    linux: [
      { label: 'Cursor', path: '/usr/bin/cursor' },
      { label: 'Visual Studio Code', path: '/usr/bin/code' },
      { label: 'Zed', path: '/usr/bin/zed' },
      { label: 'Sublime Text', path: '/usr/bin/subl' },
    ],
  };
  const seen = new Set();
  const apps = (platformApps[process.platform] || platformApps.linux)
    .filter((item) => fs.existsSync(item.path) && !seen.has(item.label) && seen.add(item.label));
  const fileManager = process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' ? 'File Explorer' : 'File Manager';
  const buttons = [`Open in ${fileManager}`, ...apps.map((item) => `Open in ${item.label}`), `Reveal in ${fileManager}`, 'Choose App…', 'Cancel'];
  const cancelId = buttons.length - 1;
  const { response } = await dialog.showMessageBox(win, {
    type: 'none', title: 'Open Directory', message: path.basename(dir) || dir, detail: dir,
    buttons, defaultId: 0, cancelId, noLink: true,
  });
  if (response === cancelId) return { ok: false, cancelled: true };
  if (response === 0) {
    const error = await shell.openPath(dir);
    return { ok: !error, error: error || undefined };
  }
  if (response <= apps.length) {
    const selected = apps[response - 1].path;
    if (process.platform === 'darwin') {
      return new Promise((resolve) => execFile('/usr/bin/open', ['-a', selected, dir], (error) => {
        resolve(error ? { ok: false, error: error.message } : { ok: true });
      }));
    }
    try {
      const child = cpSpawn(selected, [dir], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  if (response === apps.length + 1) {
    shell.showItemInFolder(dir);
    return { ok: true };
  }
  const picker = {
    title: 'Choose an application',
    defaultPath: process.platform === 'darwin' ? '/Applications' : process.platform === 'win32' ? programFiles : '/usr/bin',
    properties: ['openFile'],
  };
  if (process.platform === 'darwin') picker.filters = [{ name: 'Applications', extensions: ['app'] }];
  if (process.platform === 'win32') picker.filters = [{ name: 'Applications', extensions: ['exe', 'cmd', 'bat'] }];
  const picked = await dialog.showOpenDialog(win, picker);
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
  if (process.platform === 'darwin') {
    return new Promise((resolve) => execFile('/usr/bin/open', ['-a', picked.filePaths[0], dir], (error) => {
      resolve(error ? { ok: false, error: error.message } : { ok: true });
    }));
  }
  try {
    const child = cpSpawn(picked.filePaths[0], [dir], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

function runGit(cwd, args, timeout = 12000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error) {
        error.gitMessage = String(stderr || stdout || error.message || '').trim();
        reject(error);
      } else resolve(String(stdout || '').trim());
    });
  });
}

async function readGitStatus(cwd) {
  const dir = path.resolve(String(cwd || os.homedir()));
  let root;
  try { root = await runGit(dir, ['rev-parse', '--show-toplevel']); }
  catch { return { ok: false, repository: false }; }

  const optional = async (args) => {
    try { return await runGit(root, args); } catch { return ''; }
  };
  const [branchName, shortHead, localSubject, upstream, remote, porcelain] = await Promise.all([
    optional(['branch', '--show-current']),
    optional(['rev-parse', '--short', 'HEAD']),
    optional(['log', '-1', '--pretty=%s']),
    optional(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    optional(['remote', 'get-url', 'origin']),
    optional(['status', '--porcelain=v1']),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await optional(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
    const [left, right] = counts.split(/\s+/).map((value) => Number(value) || 0);
    ahead = left;
    behind = right;
  }
  const remoteHead = upstream ? await optional(['rev-parse', '--short', upstream]) : '';
  const remoteSubject = upstream ? await optional(['log', '-1', '--pretty=%s', upstream]) : '';
  const changes = porcelain ? porcelain.split('\n').filter(Boolean).map((line) => {
    const code = line.slice(0, 2);
    const index = code[0];
    const worktree = code[1];
    const kind = code === '??' ? 'untracked'
      : index === 'A' || worktree === 'A' ? 'added'
      : index === 'D' || worktree === 'D' ? 'deleted'
      : index === 'R' || worktree === 'R' ? 'renamed'
      : 'modified';
    return { code, path: line.slice(3), kind, staged: index !== ' ' && index !== '?' };
  }) : [];
  const staged = changes.filter((change) => change.staged).length;
  const untracked = changes.filter((change) => change.kind === 'untracked').length;
  const unstaged = changes.length - staged - untracked;
  return {
    ok: true,
    repository: true,
    root,
    branch: branchName || shortHead || 'HEAD',
    localHead: shortHead,
    localSubject,
    upstream,
    remoteHead,
    remoteSubject,
    remote,
    github: /(?:github\.com[:/])/i.test(remote),
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    changes,
  };
}

ipcMain.handle('git:status', (_event, cwd) => readGitStatus(cwd));
ipcMain.handle('git:action', async (_event, { cwd, action }) => {
  const status = await readGitStatus(cwd);
  if (!status.ok) return { ok: false, error: 'This directory is not a Git repository.' };
  const actions = {
    pull: [['pull', '--ff-only']],
    push: status.upstream ? [['push']] : (status.remote ? [['push', '-u', 'origin', status.branch]] : [['push']]),
    sync: [['pull', '--ff-only'], ['push']],
  };
  const commands = actions[action];
  if (!commands) return { ok: false, error: 'Unknown Git action.' };
  try {
    const output = [];
    for (const args of commands) output.push(await runGit(status.root, args, 120000));
    return { ok: true, output: output.filter(Boolean).join('\n'), status: await readGitStatus(status.root) };
  } catch (error) {
    return { ok: false, error: error.gitMessage || error.message || 'Git command failed.', status: await readGitStatus(status.root) };
  }
});

// ---------------- local domains (reverse proxy on :80) ----------------
const proxyPaths = () => ({
  script: path.join(app.getPath('userData'), 'coco-proxy.cjs'),
  map: path.join(app.getPath('userData'), 'proxy-map.json'),
  pid: path.join(app.getPath('userData'), 'coco-proxy.pid'),
  log: path.join(app.getPath('userData'), 'coco-proxy.log'),
});

// project info for the domain prompt: app name (package.json/composer) + saved .coco-domain
ipcMain.handle('project:info', (e, cwd) => {
  const out = { name: path.basename(cwd || ''), saved: null };
  try { const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); if (pkg.name) out.name = String(pkg.name).split('/').pop(); } catch {}
  try { if (!out.name) { const c = JSON.parse(fs.readFileSync(path.join(cwd, 'composer.json'), 'utf8')); if (c.name) out.name = String(c.name).split('/').pop(); } } catch {}
  try { out.saved = JSON.parse(fs.readFileSync(path.join(cwd, '.coco-domain'), 'utf8')); } catch {}
  return out;
});
ipcMain.handle('project:saveDomain', (e, { cwd, data }) => {
  try { fs.writeFileSync(path.join(cwd, '.coco-domain'), JSON.stringify(data, null, 2) + '\n'); return { ok: true }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
function proxyAlive() {
  try { const pid = parseInt(fs.readFileSync(proxyPaths().pid, 'utf8'), 10); if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } } catch { return false; }
}
ipcMain.handle('proxy:status', () => ({ running: proxyAlive() }));
ipcMain.handle('proxy:setmap', (e, map) => { try { fs.writeFileSync(proxyPaths().map, JSON.stringify(map || {}, null, 2)); return { ok: true }; } catch (err) { return { ok: false, error: String(err.message || err) }; } });
function diagnoseProxyFail(port) {
  let logTail = ''; try { logTail = fs.readFileSync(proxyPaths().log, 'utf8').trim().split('\n').slice(-3).join(' '); } catch {}
  if (/EADDRINUSE/.test(logTail)) return `Port ${port} is already in use. Free it, or set a different proxy port in Settings.`;
  if (/EACCES|permission denied/i.test(logTail)) return `Port ${port} needs administrator access. Use port 8080 or another port above 1024 in Settings.`;
  return logTail || 'the proxy did not start';
}
function waitForProxy(port, resolve) {
  let tries = 0;
  const iv = setInterval(() => {
    tries++;
    if (proxyAlive()) { clearInterval(iv); resolve({ ok: true }); }
    else if (tries >= 16) { clearInterval(iv); resolve({ ok: false, error: diagnoseProxyFail(port) }); }
  }, 250);
}
function launchProxyDirect(port, paths, resolve) {
  let logFd;
  try {
    logFd = fs.openSync(paths.log, 'a');
    const child = cpSpawn(process.execPath, [paths.script, paths.map, paths.pid], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, COCO_PROXY_PORT: String(port), ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    return resolve({ ok: false, error: error.message || String(error) });
  } finally {
    if (logFd !== undefined) try { fs.closeSync(logFd); } catch {}
  }
  waitForProxy(port, resolve);
}
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\\\''") + "'";
}
ipcMain.handle('proxy:enable', (event, port) => new Promise((resolve) => {
  const PORT = Number(port) || 80;
  const P = proxyPaths();
  try {
    fs.copyFileSync(path.join(__dirname, 'proxy.cjs'), P.script); // ship the proxy out of asar
    if (!fs.existsSync(P.map)) fs.writeFileSync(P.map, '{}');
    try { fs.writeFileSync(P.log, ''); } catch {}
    try { fs.unlinkSync(P.pid); } catch {}
  } catch (err) { return resolve({ ok: false, error: String(err.message || err) }); }
  if (proxyAlive()) return resolve({ ok: true, already: true });
  if (process.platform !== 'darwin' || PORT >= 1024) return launchProxyDirect(PORT, P, resolve);
  // detach via background + /dev/null stdin (nohup is unavailable under osascript)
  const sh = `env COCO_PROXY_PORT=${PORT} ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(P.script)} ${shellQuote(P.map)} ${shellQuote(P.pid)} >${shellQuote(P.log)} 2>&1 </dev/null &`;
  const osa = `do shell script ${JSON.stringify(sh)} with administrator privileges`;
  execFile('osascript', ['-e', osa], (err) => {
    if (err) return resolve({ ok: false, error: /User canceled|-128/.test(String(err)) ? 'cancelled' : err.message });
    waitForProxy(PORT, resolve);
  });
}));
ipcMain.handle('proxy:disable', () => new Promise((resolve) => {
  let pid = 0; try { pid = parseInt(fs.readFileSync(proxyPaths().pid, 'utf8'), 10); } catch {}
  if (!pid) return resolve({ ok: true });
  const finish = () => { try { fs.unlinkSync(proxyPaths().pid); } catch {} resolve({ ok: true }); };
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', `do shell script "kill ${pid} 2>/dev/null; true" with administrator privileges`], finish);
  } else {
    try { process.kill(pid); } catch {}
    finish();
  }
}));
function openTrustedExternal(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return false;
    shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
}
ipcMain.on('domains:open', (_event, url) => openTrustedExternal(url));
// is something actually listening on 127.0.0.1:<port>?
ipcMain.handle('port:check', (e, port) => new Promise((resolve) => {
  const p = Number(port); if (!p) return resolve(false);
  const sock = new net.Socket(); let done = false;
  const fin = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
  sock.setTimeout(500);
  sock.once('connect', () => fin(true));
  sock.once('timeout', () => fin(false));
  sock.once('error', () => fin(false));
  try { sock.connect(p, '127.0.0.1'); } catch { fin(false); }
}));

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (event, text) => clipboard.writeText(String(text || '')));

ipcMain.handle('shortcuts:commands', () => COMMANDS);
ipcMain.handle('shortcuts:set', (event, bindings) => { buildAppMenu(bindings || {}); return true; });
// While recording a shortcut, strip the app menu so its accelerators don't fire.
ipcMain.handle('shortcuts:capture', (event, on) => { if (on) Menu.setApplicationMenu(null); else buildAppMenu(); return true; });

// ---------------- SFTP (ssh2) ----------------
const sftpConns = new Map(); // id -> { client, sftp }
let sftpSeq = 0;
function sortEntries(a, b) { return (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name); }

ipcMain.handle('sftp:connect', (e, opts) => new Promise((resolve) => {
  const client = new SSH2Client();
  let done = false;
  const finish = (r) => { if (!done) { done = true; resolve(r); } };
  client.on('ready', () => {
    client.sftp((err, sftp) => {
      if (err) { finish({ ok: false, error: err.message }); try { client.end(); } catch {} return; }
      const id = 'sftp' + (++sftpSeq);
      sftpConns.set(id, { client, sftp });
      const remove = () => sftpConns.delete(id);
      client.once('close', remove);
      client.once('end', remove);
      sftp.realpath('.', (e2, abs) => finish({ ok: true, id, home: e2 ? '.' : abs }));
    });
  });
  client.on('error', (err) => finish({ ok: false, error: err.message }));
  client.on('keyboard-interactive', (n, i, l, prompts, cb) => cb(opts.password ? prompts.map(() => opts.password) : []));
  const cfg = { host: opts.host, port: Number(opts.port) || 22, username: opts.user || os.userInfo().username, readyTimeout: 15000, tryKeyboard: true };
  if (opts.identity) { try { cfg.privateKey = fs.readFileSync(opts.identity); } catch {} }
  if (opts.passphrase) cfg.passphrase = opts.passphrase;
  if (opts.password) cfg.password = opts.password;
  if (process.env.SSH_AUTH_SOCK) cfg.agent = process.env.SSH_AUTH_SOCK;
  try { client.connect(cfg); } catch (err) { finish({ ok: false, error: String(err.message || err) }); }
}));
ipcMain.handle('sftp:list', (e, { id, path: p }) => new Promise((resolve) => {
  const c = sftpConns.get(id); if (!c) return resolve({ ok: false, error: 'not connected' });
  c.sftp.realpath(p || '.', (er, abs) => {
    const dir = er ? (p || '.') : abs;
    c.sftp.readdir(dir, (err, list) => {
      if (err) return resolve({ ok: false, error: err.message });
      const entries = list.map((it) => ({ name: it.filename, type: it.longname[0] === 'd' ? 'dir' : it.longname[0] === 'l' ? 'link' : 'file', size: it.attrs.size, mtime: it.attrs.mtime * 1000 })).sort(sortEntries);
      resolve({ ok: true, dir, entries });
    });
  });
}));
ipcMain.handle('sftp:download', (e, { id, remote, local }) => new Promise((resolve) => {
  const c = sftpConns.get(id); if (!c) return resolve({ ok: false, error: 'not connected' });
  c.sftp.fastGet(remote, local, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true, local }));
}));
ipcMain.handle('sftp:upload', (e, { id, local, remote }) => new Promise((resolve) => {
  const c = sftpConns.get(id); if (!c) return resolve({ ok: false, error: 'not connected' });
  c.sftp.fastPut(local, remote, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true, remote }));
}));
ipcMain.handle('sftp:mkdir', (e, { id, path: p }) => new Promise((r) => { const c = sftpConns.get(id); if (!c) return r({ ok: false }); c.sftp.mkdir(p, (err) => r(err ? { ok: false, error: err.message } : { ok: true })); }));
ipcMain.handle('sftp:delete', (e, { id, path: p, isDir }) => new Promise((r) => { const c = sftpConns.get(id); if (!c) return r({ ok: false }); (isDir ? c.sftp.rmdir : c.sftp.unlink).call(c.sftp, p, (err) => r(err ? { ok: false, error: err.message } : { ok: true })); }));
ipcMain.handle('sftp:disconnect', (e, { id }) => { const c = sftpConns.get(id); if (c) { try { c.client.end(); } catch {} sftpConns.delete(id); } return true; });

// local filesystem for the SFTP browser's left pane
ipcMain.handle('fs:list', (e, { path: p }) => {
  try {
    const dir = p && fs.existsSync(p) ? p : os.homedir();
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).map((d) => {
      let size = 0, mtime = 0; try { const st = fs.statSync(path.join(dir, d.name)); size = st.size; mtime = st.mtimeMs; } catch {}
      return { name: d.name, type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file', size, mtime };
    }).sort(sortEntries);
    return { ok: true, dir, parent: path.dirname(dir), entries };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('fs:home', () => os.homedir());

// ---------------- port forwarding (ssh -N) ----------------
const tunnels = new Map(); // id -> child
ipcMain.handle('tunnel:start', (e, cfg) => {
  try {
    const args = ['-N', '-o', 'ServerAliveInterval=30', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes'];
    if (cfg.sshPort && String(cfg.sshPort) !== '22') args.push('-p', String(cfg.sshPort));
    if (cfg.identity) args.push('-i', cfg.identity);
    const fwd = `${cfg.localPort}:${cfg.remoteHost || 'localhost'}:${cfg.remotePort}`;
    args.push(cfg.type === 'R' ? '-R' : '-L', fwd, cfg.sshUser ? `${cfg.sshUser}@${cfg.sshHost}` : cfg.sshHost);
    const existing = tunnels.get(cfg.id);
    if (existing) { try { existing.kill(); } catch {} tunnels.delete(cfg.id); }
    const child = cpSpawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-64 * 1024); });
    child.on('exit', (code) => { tunnels.delete(cfg.id); if (win && !win.isDestroyed()) win.webContents.send('tunnel:exit', { id: cfg.id, code, error: errBuf.trim() }); });
    tunnels.set(cfg.id, child);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('tunnel:stop', (e, { id }) => { const c = tunnels.get(id); if (c) { try { c.kill(); } catch {} tunnels.delete(id); } return true; });
ipcMain.handle('tunnel:running', () => [...tunnels.keys()]);

ipcMain.handle('ssh:keygen', (event, { name, type, passphrase, comment }) => new Promise((resolve) => {
  try {
    const safe = String(name || '').replace(/[^\w.@-]/g, '_') || 'id_coco';
    const sshDir = path.join(os.homedir(), '.ssh');
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(sshDir, safe);
    if (fs.existsSync(keyPath)) { resolve({ ok: false, error: `A key file "${safe}" already exists in ~/.ssh.` }); return; }
    const t = type === 'rsa' ? 'rsa' : 'ed25519';
    const args = ['-t', t, '-f', keyPath, '-N', passphrase || '', '-C', comment || '', '-q'];
    if (t === 'rsa') args.push('-b', '4096');
    execFile('ssh-keygen', args, (err) => {
      if (err) { resolve({ ok: false, error: err.message }); return; }
      let pub = '';
      try { pub = fs.readFileSync(keyPath + '.pub', 'utf8').trim(); } catch {}
      try { fs.chmodSync(keyPath, 0o600); } catch {}
      resolve({ ok: true, path: keyPath, pub, name: safe });
    });
  } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
}));

ipcMain.handle('dialog:pick-key', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Select SSH private key',
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('os:info', () => ({
  home: os.homedir(),
  user: os.userInfo().username,
  host: os.hostname().replace(/\.local$/, ''),
  shell: defaultShell(process.env, process.platform),
  platform: process.platform,
  version: app.getVersion(),
}));

function embeddedUpdateConfigPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app-update.yml') : '';
}
function configuredUpdateUrl() {
  return String(process.env.COCO_UPDATE_URL || '').trim();
}
function isPortableWindowsBuild() {
  return process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_DIR;
}
async function checkForUpdates({ manual = false } = {}) {
  if (updateChecking) return { ok: false, busy: true };
  if (!app.isPackaged) {
    if (manual) await dialog.showMessageBox(win, { type: 'info', title: 'Updates', message: 'Update checks are available in the packaged app.' });
    return { ok: false, development: true };
  }
  if (isPortableWindowsBuild()) {
    if (manual) await dialog.showMessageBox(win, {
      type: 'info', title: 'Windows portable beta',
      message: 'Automatic installation is not available in this portable build.',
      detail: 'Download the newest Windows version from coco-holding.com/terminal. Installable updates will begin with the native NSIS release.',
    });
    return { ok: false, portable: true };
  }
  if (!updateConfigured) {
    if (manual) await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Updates are not configured',
      message: 'This build does not have a release feed yet.',
      detail: 'Publish this platform build to the Tarout release bucket so its public update feed is embedded.',
    });
    return { ok: false, configured: false };
  }
  updateChecking = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (manual) {
      const available = !!(result && result.downloadPromise);
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Updates',
        message: available ? `Coco ${result.updateInfo.version} is downloading.` : 'Coco is up to date.',
        detail: available ? 'You will be asked to restart when the update is ready.' : `You are using version ${app.getVersion()}.`,
      });
    }
    return { ok: true };
  } catch (error) {
    if (manual) await dialog.showMessageBox(win, { type: 'error', title: 'Update check failed', message: 'Coco could not check for updates.', detail: String(error.message || error) });
    return { ok: false, error: String(error.message || error) };
  } finally {
    updateChecking = false;
  }
}
function scheduleAutomaticUpdates() {
  if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
  if (updateInitialTimer) { clearTimeout(updateInitialTimer); updateInitialTimer = null; }
  if (!automaticUpdates || !updateConfigured || !app.isPackaged) return;
  updateInitialTimer = setTimeout(() => {
    updateInitialTimer = null;
    checkForUpdates();
  }, 12000);
  updateTimer = setInterval(() => checkForUpdates(), 6 * 60 * 60 * 1000);
  if (updateTimer.unref) updateTimer.unref();
}
function setAutomaticUpdates(enabled) {
  automaticUpdates = !!enabled;
  store.set('update-preferences', { automatic: automaticUpdates });
  scheduleAutomaticUpdates();
  return { ok: true, enabled: automaticUpdates, configured: updateConfigured, packaged: app.isPackaged };
}
async function configureUpdates() {
  const updateUrl = configuredUpdateUrl();
  const embeddedConfig = embeddedUpdateConfigPath();
  updateConfigured = !isPortableWindowsBuild() && (!!updateUrl || (!!embeddedConfig && fs.existsSync(embeddedConfig)));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (!updateConfigured) return;
  // Production builds use electron-builder's signed-in app-update.yml. An
  // explicit environment URL remains available for controlled release tests.
  if (updateUrl) autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: `Coco ${info.version} is ready to install.`,
      detail: 'Restart now to apply the update. Your workspace and terminal sessions will be saved first.',
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      try { await win.webContents.executeJavaScript('window.coco && window.coco.prepareQuit ? window.coco.prepareQuit() : Promise.resolve()'); } catch {}
      allowQuit = true;
      cleanupProcesses();
      autoUpdater.quitAndInstall();
    }
  });
  autoUpdater.on('error', (error) => console.error('[updater]', error && error.message || error));
  const preferences = store.get('update-preferences', {});
  if (typeof preferences.automatic === 'boolean') {
    automaticUpdates = preferences.automatic;
  } else if (app.isPackaged) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Keep Coco up to date?',
      message: 'Allow Coco to check for and download signed updates automatically?',
      detail: 'Updates install after you approve a restart, or on the next normal quit. You can change this later in Settings.',
      buttons: ['Allow automatic updates', 'Not now'],
      defaultId: 0,
      cancelId: 1,
    });
    automaticUpdates = response === 0;
    store.set('update-preferences', { automatic: automaticUpdates });
  }
  scheduleAutomaticUpdates();
}
ipcMain.handle('updates:status', () => ({ ok: true, enabled: automaticUpdates, configured: updateConfigured, packaged: app.isPackaged, version: app.getVersion() }));
ipcMain.handle('app:info', () => ({ name: app.getName(), version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.handle('updates:set-automatic', (_event, enabled) => setAutomaticUpdates(enabled));
ipcMain.handle('updates:check', () => checkForUpdates({ manual: true }));

// ---------------- app lifecycle ----------------
// One instance only — a second launch focuses the existing window instead of
// stacking a new window over a stale one.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(() => {
    store = new Store(path.join(app.getPath('userData'), 'data'));
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    buildAppMenu();
    createWindow();
    configureUpdates();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('before-quit', (e) => {
  if (!allowQuit) {
    e.preventDefault();
    handleQuitRequest();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Single source of truth for commands + their default shortcuts.
// `group` places them in a menu; editable ones appear in the Shortcuts editor.
const COMMANDS = [
  { id: 'new-tab', label: 'New Terminal', accel: 'CmdOrCtrl+T', group: 'Terminal' },
  { id: 'new-local', label: 'New Local Terminal', accel: 'CmdOrCtrl+L', group: 'Terminal' },
  { id: 'new-host', label: 'New Remote Session', accel: 'CmdOrCtrl+Shift+H', group: 'Terminal' },
  { id: 'new-folder', label: 'New Folder', accel: 'CmdOrCtrl+Shift+N', group: 'Terminal' },
  { id: 'duplicate', label: 'Duplicate Terminal', accel: 'CmdOrCtrl+Shift+D', group: 'Terminal' },
  { id: 'close-tab', label: 'Close Pane', accel: 'CmdOrCtrl+W', group: 'Terminal' },
  { id: 'rename-tab', label: 'Rename', accel: 'CmdOrCtrl+R', group: 'Terminal' },
  { id: 'copy-path', label: 'Copy Current Path', accel: 'CmdOrCtrl+Shift+C', group: 'Terminal' },
  { id: 'open-finder', label: 'Open Directory With…', accel: 'CmdOrCtrl+Shift+O', group: 'Terminal' },
  { id: 'copy-output', label: 'Copy Last Command Output', accel: 'CmdOrCtrl+Shift+Y', group: 'Terminal' },
  { id: 'broadcast', label: 'Broadcast Input to All Panes', accel: 'CmdOrCtrl+Shift+B', group: 'Split' },
  { id: 'prev-block', label: 'Previous Command', accel: 'CmdOrCtrl+Up', group: 'Split' },
  { id: 'next-block', label: 'Next Command', accel: 'CmdOrCtrl+Down', group: 'Split' },
  { id: 'save-workspace', label: 'Save Current Layout', accel: 'CmdOrCtrl+Shift+S', group: 'View' },
  { id: 'workspaces', label: 'Workspaces…', accel: '', group: 'View' },
  { id: 'tunnels', label: 'Port Forwarding…', accel: '', group: 'View' },
  { id: 'domains', label: 'Local Domains…', accel: 'CmdOrCtrl+Shift+E', group: 'View' },
  { id: 'split-right', label: 'Split Right', accel: 'CmdOrCtrl+\\', group: 'Split' },
  { id: 'split-down', label: 'Split Down', accel: 'CmdOrCtrl+Shift+\\', group: 'Split' },
  { id: 'focus-next-pane', label: 'Focus Next Pane', accel: 'CmdOrCtrl+]', group: 'Split' },
  { id: 'focus-prev-pane', label: 'Focus Previous Pane', accel: 'CmdOrCtrl+[', group: 'Split' },
  { id: 'next-tab', label: 'Next Terminal', accel: 'Ctrl+Tab', group: 'Split' },
  { id: 'prev-tab', label: 'Previous Terminal', accel: 'Ctrl+Shift+Tab', group: 'Split' },
  { id: 'palette', label: 'Command Palette', accel: 'CmdOrCtrl+K', group: 'View' },
  { id: 'themes', label: 'Themes', accel: 'CmdOrCtrl+P', group: 'View' },
  { id: 'toggle-dock', label: 'Toggle Dock', accel: 'CmdOrCtrl+B', group: 'View' },
  { id: 'toggle-layout', label: 'Sidebar / Top-bar Layout', accel: 'CmdOrCtrl+Shift+L', group: 'View' },
  { id: 'focus-filter', label: 'Filter Sessions', accel: 'CmdOrCtrl+Shift+F', group: 'View' },
  { id: 'font-up', label: 'Increase Font', accel: 'CmdOrCtrl+Plus', group: 'View' },
  { id: 'font-down', label: 'Decrease Font', accel: 'CmdOrCtrl+-', group: 'View' },
  { id: 'find', label: 'Find', accel: 'CmdOrCtrl+F', group: 'Edit' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts…', accel: 'CmdOrCtrl+,', group: 'View' },
];

function loadBindings() {
  try { return (store.get('state', {}) || {}).settings?.keybindings || {}; } catch { return {}; }
}

function buildAppMenu(bindings = loadBindings()) {
  const send = (id) => () => win && win.webContents.send(`menu:${id}`);
  const cmd = (id) => {
    const c = COMMANDS.find((x) => x.id === id);
    const accel = bindings[id] !== undefined ? bindings[id] : c.accel;
    const item = { label: c.label, click: send(id) };
    if (accel) item.accelerator = accel;
    return item;
  };
  const switches = [];
  for (let i = 1; i <= 9; i++) {
    switches.push({ label: `Focus Pane ${i}`, accelerator: `CmdOrCtrl+${i}`, click: () => win && win.webContents.send('menu:switch', i - 1) });
  }

  const viewItems = [
    cmd('palette'), cmd('themes'), cmd('toggle-dock'), cmd('toggle-layout'), cmd('focus-filter'),
    { type: 'separator' },
    cmd('save-workspace'), cmd('workspaces'), cmd('tunnels'), cmd('domains'),
    { type: 'separator' },
    cmd('font-up'), cmd('font-down'),
    { type: 'separator' },
  ];
  if (!app.isPackaged) viewItems.push({ role: 'toggleDevTools' });
  viewItems.push({ role: 'togglefullscreen' });
  const template = [
    {
      label: 'coco',
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { label: 'Check for Updates…', click: () => checkForUpdates({ manual: true }) },
        { type: 'separator' },
        cmd('shortcuts'),
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        cmd('new-tab'), cmd('new-local'), cmd('new-host'), cmd('new-folder'), cmd('duplicate'), cmd('close-tab'),
        { type: 'separator' },
        cmd('rename-tab'), cmd('copy-path'), cmd('open-finder'), cmd('copy-output'),
      ],
    },
    {
      label: 'Split',
      submenu: [
        cmd('split-right'), cmd('split-down'), cmd('broadcast'),
        { type: 'separator' },
        cmd('focus-next-pane'), cmd('focus-prev-pane'), cmd('next-tab'), cmd('prev-tab'),
        cmd('prev-block'), cmd('next-block'),
        { type: 'separator' }, ...switches,
      ],
    },
    {
      label: 'View',
      submenu: viewItems,
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' }, cmd('find'),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
