'use strict';
/* coco renderer — terminals organized inside dock folders */

const API = window.cocoAPI;
const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const WebLinksAddon = window.WebLinksAddon.WebLinksAddon;
const SearchAddon = window.SearchAddon.SearchAddon;
const SerializeAddon = window.SerializeAddon.SerializeAddon;
const ic = window.icon;
const githubMark = (size = 13) => `<svg class="github-mark" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="M12 .5C5.63.5.5 5.78.5 12.3c0 5.21 3.29 9.63 7.86 11.19.58.11.79-.26.79-.57v-2.23c-3.2.71-3.88-1.4-3.88-1.4-.52-1.37-1.28-1.73-1.28-1.73-1.05-.74.08-.72.08-.72 1.16.08 1.77 1.22 1.77 1.22 1.03 1.81 2.7 1.29 3.36.99.1-.77.4-1.29.73-1.59-2.55-.3-5.24-1.31-5.24-5.83 0-1.29.45-2.34 1.19-3.17-.12-.3-.52-1.5.11-3.13 0 0 .97-.32 3.17 1.21A10.75 10.75 0 0 1 12 6.14c.98 0 1.95.14 2.86.4 2.2-1.53 3.17-1.21 3.17-1.21.63 1.63.23 2.83.11 3.13.74.83 1.19 1.88 1.19 3.17 0 4.53-2.69 5.53-5.25 5.82.42.37.78 1.09.78 2.2v3.27c0 .31.21.69.79.57a11.8 11.8 0 0 0 7.85-11.19C23.5 5.78 18.37.5 12 .5Z"/></svg>`;

let OS = { home: '', user: 'user', host: 'computer', platform: 'darwin', shell: '' };

// ---------------- state ----------------
const state = {
  themeId: window.COCO_DEFAULT_THEME,
  fontSize: 13.5,
  dockCollapsed: false,
  selectedFolderId: null,
  tree: [],
  keys: [],          // saved SSH identity files: { id, name, path }
  commands: [],      // routine-command library: cmd-folder / command nodes
  layouts: [],       // reusable saved split layouts
  workspaceProfiles: [],
  activeWorkspaceId: 'global',
  tunnels: [],       // saved port forwards: { id, name, type, localPort, remoteHost, remotePort, sshHost, sshUser, sshPort, keyId }
  domains: [],       // local domains: { id, domain, port, auto }
  proxyOn: false,    // is the :80 reverse proxy running
  filter: '',
  layoutMode: 'dock', // 'dock' (sidebar) | 'topbar'
  settings: { confirmDelete: true, restoreSessions: true, restoreHistory: true, gitIntegration: true, commandsEnabled: true, directoryPreviews: true, handwritingFont: 'Chalkboard SE', writeSound: true, domainTld: '.local', noProxyPrompt: false, proxyPort: 80, rtlText: true, claudeDetection: true, desktopNotifications: true },
};
// handwriting fonts available on macOS (Supplemental fonts)
const HAND_FONTS = ['Chalkboard SE', 'Bradley Hand', 'Comic Sans MS', 'Chalkduster', 'Apple Chancery', 'SignPainter', 'Snell Roundhand', 'Trattatello', 'Brush Script MT'];
const live = new Map();      // sessionId -> { term, fit, search, pane, dead }
let activeId = null;
let broadcast = false;       // type-to-all-panes mode
let restoreResolved = false;
let idCounter = 1;
const uid = (p) => `${p}-${Date.now().toString(36)}-${idCounter++}`;

function isClaudeCommand(command) {
  const plain = String(command || '').trim();
  return /(?:^|(?:&&|\|\||;|\|)\s*|(?:command|exec)\s+)(?:"[^"]*\/claude"|'[^']*\/claude'|(?:\S*\/)?claude)(?=\s|$)/.test(plain);
}

function isClaudePrintCommand(command) {
  return /(?:^|\s)(?:-p|--print)(?=\s|$)/.test(String(command || ''));
}

function setClaudeState(node, entry, next) {
  if (!entry || entry.claudeState === next) return;
  if (next) entry.claudeState = next;
  else delete entry.claudeState;
  renderTree();
  if (node.id === activeId) updateStatus();
}

function claudeComplete(node, entry) {
  if (!entry || !entry.claudeState || entry.claudeState === 'complete') return;
  if (entry._claudeCompleteTimer) {
    clearTimeout(entry._claudeCompleteTimer);
    entry._claudeCompleteTimer = null;
  }
  setClaudeState(node, entry, 'complete');
  if (state.settings.desktopNotifications !== false) {
    API.notify({
      tabId: node.id,
      title: 'Claude completed',
      body: `${node.name || 'Terminal'} is ready for you.`,
    });
  }
}

function scheduleClaudeCompletion(node, entry) {
  if (state.settings.claudeDetection === false || !entry || !entry.claudeActive || entry.claudeState !== 'working' || !entry._claudeOutputSeen) return;
  if (entry._claudeCompleteTimer) clearTimeout(entry._claudeCompleteTimer);
  const request = entry._claudeRequest;
  // Claude Code does not reliably emit its configured terminal bell. A quiet
  // period after streamed output is therefore coco's independent completion
  // signal. Eight seconds avoids treating normal pauses and tool hand-offs as
  // a completed answer.
  entry._claudeCompleteTimer = setTimeout(() => {
    entry._claudeCompleteTimer = null;
    if (!live.has(node.id) || entry._claudeRequest !== request) return;
    if (entry.claudeActive && entry.claudeState === 'working' && entry._claudeOutputSeen) claudeComplete(node, entry);
  }, 8000);
}

// ---------------- persistence ----------------
async function loadState() {
  const s = await API.storeGet('state');
  if (!s) {
    state.commands = defaultCommands();
    state.workspaceProfiles = [{ id: 'global', name: 'Default', tree: [], keys: [], commands: state.commands, domains: [], openIds: [], layout: null, activeId: null }];
    return { openIds: [], activeId: null, savedLayout: null };
  }
  state.themeId = s.themeId || state.themeId;
  state.fontSize = s.fontSize || state.fontSize;
  state.dockCollapsed = !!s.dockCollapsed;
  state.selectedFolderId = s.selectedFolderId || null;
  state.layouts = Array.isArray(s.layouts) ? s.layouts : (Array.isArray(s.workspaces) ? s.workspaces : []);
  state.tunnels = Array.isArray(s.tunnels) ? s.tunnels : [];
  state.layoutMode = s.layoutMode === 'topbar' ? 'topbar' : 'dock';
  if (s.settings) state.settings = Object.assign(state.settings, s.settings);
  state.workspaceProfiles = Array.isArray(s.workspaceProfiles) && s.workspaceProfiles.length ? s.workspaceProfiles : [{
    id: 'global', name: 'Default',
    tree: Array.isArray(s.tree) ? s.tree : [],
    keys: Array.isArray(s.keys) ? s.keys : [],
    commands: Array.isArray(s.commands) ? s.commands : defaultCommands(),
    domains: Array.isArray(s.domains) ? s.domains : [],
    openIds: s.openIds || [], layout: s.layout || null, activeId: s.activeId || null,
  }];
  if (!state.workspaceProfiles.some((workspace) => workspace.id === 'global')) {
    state.workspaceProfiles.unshift({ id: 'global', name: 'Default', tree: [], keys: [], commands: defaultCommands(), domains: [], openIds: [], layout: null, activeId: null });
  }
  const defaultWorkspace = state.workspaceProfiles.find((workspace) => workspace.id === 'global');
  if (defaultWorkspace && (!defaultWorkspace.name || defaultWorkspace.name === 'Global')) defaultWorkspace.name = 'Default';
  state.activeWorkspaceId = state.workspaceProfiles.some((workspace) => workspace.id === s.activeWorkspaceId) ? s.activeWorkspaceId : 'global';
  const workspace = state.workspaceProfiles.find((item) => item.id === state.activeWorkspaceId);
  state.tree = workspace.tree || [];
  state.keys = workspace.keys || [];
  state.commands = workspace.commands || defaultCommands();
  state.domains = workspace.domains || [];
  return { openIds: workspace.openIds || [], activeId: workspace.activeId || null, savedLayout: workspace.layout || null };
}
function activeWorkspace() { return state.workspaceProfiles.find((workspace) => workspace.id === state.activeWorkspaceId); }
function syncActiveWorkspace() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  Object.assign(workspace, {
    tree: state.tree, keys: state.keys, commands: state.commands, domains: state.domains,
    layout, openIds: [...live.keys()], activeId,
  });
}
function persist() {
  syncActiveWorkspace();
  return API.storeSet('state', {
    themeId: state.themeId, fontSize: state.fontSize,
    dockCollapsed: state.dockCollapsed, selectedFolderId: state.selectedFolderId,
    settings: state.settings, layouts: state.layouts, workspaceProfiles: state.workspaceProfiles,
    activeWorkspaceId: state.activeWorkspaceId, tunnels: state.tunnels,
    layoutMode: state.layoutMode, layout, openIds: [...live.keys()], activeId,
  });
}
function workspaceBufferKey() { return `buffers:${state.activeWorkspaceId}`; }
// A few starter routine commands so the dropdown isn't empty on first run.
function defaultCommands() {
  const systemCommands = OS.platform === 'win32'
    ? [
        { id: uid('cmd'), type: 'command', name: 'Disk usage', command: 'Get-Volume' },
        { id: uid('cmd'), type: 'command', name: 'Top processes', command: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 20' },
      ]
    : OS.platform === 'linux'
      ? [
          { id: uid('cmd'), type: 'command', name: 'Disk usage', command: 'df -h' },
          { id: uid('cmd'), type: 'command', name: 'Top processes', command: 'ps aux --sort=-%cpu | head -20' },
        ]
      : [
          { id: uid('cmd'), type: 'command', name: 'Disk usage', command: 'df -h' },
          { id: uid('cmd'), type: 'command', name: 'Top processes', command: 'top -o cpu' },
        ];
  return [
    { id: uid('cmd'), type: 'command', name: 'Clear screen', command: OS.platform === 'win32' ? 'Clear-Host' : 'clear' },
    {
      id: uid('cmdf'), type: 'cmd-folder', name: 'Git', expanded: true, children: [
        { id: uid('cmd'), type: 'command', name: 'Status', command: 'git status' },
        { id: uid('cmd'), type: 'command', name: 'Pull', command: 'git pull' },
        { id: uid('cmd'), type: 'command', name: 'Log (graph)', command: 'git log --oneline --graph --all -20' },
      ],
    },
    {
      id: uid('cmdf'), type: 'cmd-folder', name: 'System', expanded: false, children: systemCommands,
    },
  ];
}
function autosave() { if (restoreResolved) persist(); }

// Heavy per-terminal data (scrollback + command history) saved separately, throttled.
function capturePlainTranscript(entry, maxLines = 1200) {
  try {
    const buffer = entry.term.buffer.active;
    const end = buffer.length;
    const start = Math.max(0, end - maxLines);
    const lines = [];
    for (let y = start; y < end; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      lines.push(line.translateToString(true).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''));
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length && !lines[0].trim()) lines.shift();
    return lines.join('\n');
  } catch {
    return '';
  }
}

function captureSession(id) {
  const e = live.get(id), r = findNode(id);
  if (!e || !r) return null;
  let buffer = '';
  let interactive = false;
  let transcript = '';
  try {
    interactive = !!e.claudeActive || e.term.buffer.active.type === 'alternate';
    if (interactive) transcript = capturePlainTranscript(e);
    buffer = interactive && e._preInteractiveBuffer != null
      ? e._preInteractiveBuffer
      : e.serialize.serialize({ scrollback: 1000, excludeAltBuffer: true, excludeModes: true });
  } catch {}
  return {
    version: 3,
    buffer,
    interactive,
    transcript,
    interactiveApp: e.claudeActive || e.claudeState ? 'Claude Code' : '',
    history: r.node.history || [],
    cwd: r.node.cwd,
    name: r.node.name,
  };
}

function unsafeRestoreBuffer(restore) {
  if (!restore || !restore.buffer) return false;
  if (restore.interactive && restore.version !== 2) return true;
  const data = restore.buffer;
  const visible = data.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
  return /Claude\s+Code\s+v\d/.test(visible)
    || /\x1b\[\?1049h|\x1b\[\?1004h|\x1b\[\?100[0-3]h/.test(data);
}

function cleanLegacyTranscript(data) {
  if (!data) return '';
  return String(data)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1].trim()))
    .join('\n')
    .trim();
}

function writeRestoredTranscript(term, restore, theme) {
  const transcript = restore.transcript || (unsafeRestoreBuffer(restore) ? cleanLegacyTranscript(restore.buffer) : '');
  if (!transcript) return false;
  const dim = theme.ui.dim;
  const rgb = `${parseInt(dim.slice(1,3),16)};${parseInt(dim.slice(3,5),16)};${parseInt(dim.slice(5,7),16)}`;
  const appName = restore.interactiveApp || 'interactive session';
  term.write(`\x1b[38;2;${rgb}m── Restored ${appName} transcript ──\x1b[0m\r\n`);
  term.write(transcript.replace(/\r?\n/g, '\r\n'));
  term.write(`\r\n\x1b[38;2;${rgb}m── Previous session ends · fresh shell below ──\x1b[0m\r\n`);
  return true;
}
function persistBuffers() {
  if (!restoreResolved) return Promise.resolve();
  const data = {};
  for (const id of live.keys()) {
    const e = live.get(id);
    let c;
    if (e._dirty || !e._cap) { c = captureSession(id); if (c) { e._cap = c; e._dirty = false; } } // only re-serialize changed panes
    else c = e._cap;
    if (!c) continue;
    data[id] = c;
  }
  return API.storeSet(workspaceBufferKey(), data);
}
// Debounced/throttled buffer save: prompt after output settles, but never per-keystroke.
let _bufTimer = null, _bufLast = 0;
function scheduleBufferSave() {
  if (!restoreResolved || _bufTimer) return;
  const delay = (Date.now() - _bufLast) > 2500 ? 250 : 1200;
  _bufTimer = setTimeout(() => { _bufTimer = null; _bufLast = Date.now(); persistBuffers(); }, delay);
}

// bridge for the main process
window.coco = {
  openCount: () => live.size,
  prepareQuit: async () => {
    if (state.settings.restoreSessions !== false) await persistBuffers();
    else { removeEphemeral(); API.storeDelete(workspaceBufferKey()); }
    restoreResolved = true;
    await persist();
    return live.size;
  },
  // last-moment save on SIGTERM — awaited by main so the file write actually completes
  flushSave: async () => { try { await Promise.all([persistBuffers(), persist()]); } catch {} return true; },
};

// ---------------- tree helpers ----------------
function findNode(id, nodes = state.tree, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parent, list: nodes, index: i };
    if (n.type === 'folder') {
      const r = findNode(id, n.children, n);
      if (r) return r;
    }
  }
  return null;
}
const isLeaf = (n) => n.type === 'session' || n.type === 'host';
function eachSession(fn, nodes = state.tree) {
  for (const n of nodes) {
    if (isLeaf(n)) fn(n);
    else if (n.type === 'folder') eachSession(fn, n.children);
  }
}
function removeEphemeral(nodes = state.tree) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.type === 'session' && !n.pinned) nodes.splice(i, 1);
    else if (n.type === 'folder') removeEphemeral(n.children);
  }
}

// ---------------- themes ----------------
const DEFAULT_FONT = "'SF Mono','JetBrains Mono',Menlo,Monaco,monospace";
function themeById(id) { return window.COCO_THEMES.find((t) => t.id === id) || window.COCO_THEMES[0]; }
function themeFont() {
  if (state.themeId === 'paper') return `'${state.settings.handwritingFont || 'Chalkboard SE'}','Bradley Hand','Comic Sans MS',cursive`;
  return themeById(state.themeId).font || DEFAULT_FONT;
}
function colorRgb(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
}
function colorHex(rgb) {
  return `#${rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
}
function colorMix(a, b, amount) {
  const aa = colorRgb(a);
  const bb = colorRgb(b);
  return colorHex(aa.map((value, i) => value + (bb[i] - value) * amount));
}
function colorLuminance(hex) {
  const channels = colorRgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function colorContrast(a, b) {
  const aa = colorLuminance(a);
  const bb = colorLuminance(b);
  return (Math.max(aa, bb) + 0.05) / (Math.min(aa, bb) + 0.05);
}
function accessibleColor(color, backgrounds, minimum = 4.5) {
  const surfaces = Array.isArray(backgrounds) ? backgrounds : [backgrounds];
  if (surfaces.every((surface) => colorContrast(color, surface) >= minimum)) return color;
  const blackScore = Math.min(...surfaces.map((surface) => colorContrast('#000000', surface)));
  const whiteScore = Math.min(...surfaces.map((surface) => colorContrast('#ffffff', surface)));
  const target = blackScore > whiteScore ? '#000000' : '#ffffff';
  for (let step = 1; step <= 20; step++) {
    const candidate = colorMix(color, target, step / 20);
    if (surfaces.every((surface) => colorContrast(candidate, surface) >= minimum)) return candidate;
  }
  return target;
}
function applyTheme(id) {
  state.themeId = id;
  const t = themeById(id);
  const r = document.documentElement.style;
  const surfaces = [t.ui.bg, t.ui.panel];
  const text = accessibleColor(t.ui.text, surfaces, 7);
  const dim = accessibleColor(t.ui.dim, surfaces, 4.5);
  const accent = accessibleColor(t.ui.accent, [t.ui.panel], 4.5);
  const accent2 = accessibleColor(t.ui.accent2 || t.ui.accent, [t.ui.panel], 4.5);
  const lightTheme = colorLuminance(t.ui.bg) > 0.48;
  const buttonBg = accessibleColor(t.ui.accent, [t.ui.panel], 3);
  const buttonText = colorContrast('#101214', buttonBg) >= colorContrast('#ffffff', buttonBg) ? '#101214' : '#ffffff';
  r.setProperty('--bg', t.ui.bg);
  r.setProperty('--panel', t.ui.panel);
  r.setProperty('--accent', accent);
  r.setProperty('--accent2', accent2);
  r.setProperty('--text', text);
  r.setProperty('--dim', dim);
  r.setProperty('--button-bg', buttonBg);
  r.setProperty('--button-text', buttonText);
  r.setProperty('--modal-shade', lightTheme ? 'rgba(31, 28, 25, .22)' : 'rgba(0, 0, 0, .46)');
  r.setProperty('--specular', lightTheme ? 'rgba(255,255,255,.68)' : 'rgba(255,255,255,.14)');
  r.setProperty('--shadow-color', lightTheme ? 'rgba(45, 38, 32, .24)' : 'rgba(0,0,0,.82)');
  document.body.classList.toggle('light-theme', lightTheme);
  document.body.style.background = t.ui.bg;
  document.body.dataset.theme = id; // lets CSS add per-theme effects (paper texture, etc.)
  const font = themeFont();
  for (const e of live.values()) { e.term.options.theme = t.xterm; e.term.options.fontSize = state.fontSize; e.term.options.fontFamily = font; try { e.fit.fit(); } catch {} }
  if (id !== 'paper') stopWriteSound();
  persist();
  renderThemeGrid();
  updateStatus();
}

// ---------------- terminal lifecycle ----------------
function basename(p) {
  return window.CocoPaths.displayBasename(p, OS.home);
}

// ---------------- split layout ----------------
// layout: {type:'leaf', session} | {type:'split', dir:'row'|'col', ratio, children:[a,b]}
let layout = null;
const leafNode = (sid) => ({ type: 'leaf', session: sid });
function eachLeaf(fn, node = layout) { if (!node) return; if (node.type === 'leaf') fn(node); else node.children.forEach((c) => eachLeaf(fn, c)); }
function firstLeaf(node = layout) { if (!node) return null; return node.type === 'leaf' ? node : firstLeaf(node.children[0]); }
function findLeaf(sid, node = layout, parent = null) {
  if (!node) return null;
  if (node.type === 'leaf') return node.session === sid ? { leaf: node, parent } : null;
  for (const c of node.children) { const r = findLeaf(sid, c, node); if (r) return r; }
  return null;
}
function findParentOf(target, node = layout, parent = null) {
  if (!node) return undefined;
  if (node === target) return parent;
  if (node.type === 'split') for (const c of node.children) { const r = findParentOf(target, c, node); if (r !== undefined) return r; }
  return undefined;
}
function pruneLayout(node) {
  if (!node) return null;
  if (node.type === 'leaf') return live.has(node.session) ? leafNode(node.session) : null;
  const a = pruneLayout(node.children[0]); const b = pruneLayout(node.children[1]);
  if (a && b) return { type: 'split', dir: node.dir, ratio: node.ratio || 0.5, children: [a, b] };
  return a || b || null;
}
function layoutLeafIds() { const ids = []; eachLeaf((l) => ids.push(l.session)); return ids; }

// Create (but do not place) a terminal for a session node.
function ensureTerminal(node, restore) {
  if (live.has(node.id)) return live.get(node.id);
  const theme = themeById(state.themeId);
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  pane.dataset.id = node.id;

  const term = new Terminal({
    fontFamily: themeFont(),
    fontSize: state.fontSize, lineHeight: 1.2,
    cursorBlink: true, cursorStyle: 'bar', allowProposedApi: true,
    scrollback: 10000, theme: theme.xterm,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, uri) => API.openExternal(uri)));
  const search = new SearchAddon();
  term.loadAddon(search);
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  term.open(pane);

  const entry = { term, fit, search, serialize, pane, dead: false };
  live.set(node.id, entry);
  if (!node.history) node.history = [];

  // While output floods in (claude code streaming, big builds), own the wheel:
  // translate deltas to scrollLines so pending trackpad momentum can never race
  // the reflowing viewport and fling the view to the top. Calm terminals keep
  // native pixel-smooth scrolling untouched.
  let wheelAcc = 0, wheelRaf = 0;
  pane.addEventListener('wheel', (ev) => {
    if (term.buffer.active.type === 'alternate') return; // fullscreen apps scroll themselves
    const rate = (entry._rate || 0) * Math.exp(-(performance.now() - (entry._rateT || 0)) / 400);
    if (rate < 1024) return;
    ev.preventDefault(); ev.stopPropagation();
    const cell = state.fontSize * 1.2; // matches lineHeight
    wheelAcc += ev.deltaMode === 1 ? ev.deltaY * cell : ev.deltaY;
    wheelAcc = Math.max(-30 * cell, Math.min(30 * cell, wheelAcc)); // momentum flicks can't queue seconds of scroll
    if (wheelRaf) return;
    wheelRaf = requestAnimationFrame(() => {
      wheelRaf = 0;
      const lines = Math.max(-6, Math.min(6, Math.trunc(wheelAcc / cell)));
      wheelAcc -= lines * cell;
      if (lines) try { term.scrollLines(lines); } catch {}
    });
  }, { capture: true, passive: false });

  term.parser.registerOscHandler(7, (data) => {
    try {
      const m = /file:\/\/[^/]*(\/.*)/.exec(data);
      if (m) {
        const p = window.CocoPaths.normalizeOscPath(m[1], OS.platform);
        node.cwd = p;
        if (!node.manualName) { node.name = basename(p); renderTree(); }
        if (node.id === activeId) updateStatus();
        autosave();
      }
    } catch {}
    return true;
  });
  term.parser.registerOscHandler(633, (data) => {
    if (data && data.startsWith('E;')) {
      const cmd = data.slice(2).trim();
      if (cmd && node.history[node.history.length - 1] !== cmd) {
        node.history.push(cmd);
        if (node.history.length > 300) node.history.shift();
      }
      if (isClaudeCommand(cmd)) {
        try {
          entry._preInteractiveBuffer = entry.serialize.serialize({
            scrollback: 1000, excludeAltBuffer: true, excludeModes: true,
          });
        } catch { entry._preInteractiveBuffer = ''; }
        entry.claudeActive = !isClaudePrintCommand(cmd);
        setClaudeState(node, entry, entry.claudeActive ? 'idle' : 'working');
      }
    }
    return true;
  });
  // OSC 133 — command-block boundaries (Warp-style): A=prompt, C=output, D=exit
  entry.blocks = []; entry.curBlock = null;
  term.parser.registerOscHandler(133, (data) => {
    const buf = term.buffer.active, y = buf.baseY + buf.cursorY;
    const t = data[0], arg = data.slice(2);
    if (t === 'A') { entry.curBlock = { promptY: y }; }
    else if (t === 'C') { if (entry.curBlock) entry.curBlock.outputY = y; }
    else if (t === 'D') {
      if (entry.curBlock && entry.curBlock.outputY != null) {
        entry.curBlock.endY = y; entry.curBlock.exit = parseInt(arg || '0', 10);
        entry.blocks.push(entry.curBlock); if (entry.blocks.length > 500) entry.blocks.shift();
        markBlock(term, entry.curBlock);
        entry.curBlock = null;
      }
      if (entry.claudeState) {
        entry.claudeActive = false;
        if (entry.claudeState === 'working' || entry.claudeState === 'complete') claudeComplete(node, entry);
        else setClaudeState(node, entry, null);
        delete entry._preInteractiveBuffer;
      }
    }
    return true;
  });
  // OSC 1337 — inline images (iTerm imgcat protocol)
  term.parser.registerOscHandler(1337, (data) => {
    if (!data.startsWith('File=')) return false;
    const colon = data.indexOf(':');
    if (colon < 0) return false;
    const args = {}; data.slice(5, colon).split(';').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) args[kv.slice(0, i)] = kv.slice(i + 1); });
    renderInlineImage(term, entry, args, data.slice(colon + 1));
    return true;
  });
  term.onData((d) => {
    if (d === '\r') playWriteSound('enter');
    else if (d.length === 1 && d.charCodeAt(0) >= 32) playWriteSound('scratch');
    if (entry.claudeActive && /[\r\n]/.test(d)) {
      entry._claudeRequest = (entry._claudeRequest || 0) + 1;
      entry._claudeOutputSeen = false;
      if (entry._claudeCompleteTimer) clearTimeout(entry._claudeCompleteTimer);
      entry._claudeCompleteTimer = null;
      setClaudeState(node, entry, 'working');
    }
    else if (entry.claudeActive && entry.claudeState === 'complete') setClaudeState(node, entry, 'idle');
    else if (!entry.claudeActive && entry.claudeState === 'complete') setClaudeState(node, entry, null);
    if (broadcast && layoutLeafIds().length > 1) { for (const lid of layoutLeafIds()) API.input(lid, d); }
    else API.input(node.id, d);
  });
  term.onBell(() => {
    if (entry.claudeState) claudeComplete(node, entry);
  });
  term.onResize(({ cols, rows }) => API.resize(node.id, cols, rows));
  term.attachCustomKeyEventHandler(globalKeyHandler);
  term.registerLinkProvider(makePathLinkProvider(node, term));
  // run a per-session startup command once the shell/connection is up
  if (node.init) entry._initTimer = setTimeout(() => {
    entry._initTimer = null;
    if (live.has(node.id)) API.input(node.id, node.init + '\r');
  }, node.type === 'host' ? 1300 : 350);

  const isHost = node.type === 'host';
  const skippedInteractiveRestore = !isHost && unsafeRestoreBuffer(restore);
  const hasTranscriptRestore = !isHost && restore && !!(restore.transcript || skippedInteractiveRestore);
  const isRestore = !isHost && restore && restore.buffer && !skippedInteractiveRestore && !hasTranscriptRestore;
  const seedHistory = (!isHost && restore && state.settings.restoreHistory) ? restore.history : null;
  if (isHost) {
    const label = node.sftp ? 'SFTP' : 'SSH';
    const target = (node.user ? node.user + '@' : '') + node.host + (node.port && String(node.port) !== '22' ? ':' + node.port : '');
    const a = theme.ui.accent;
    term.write(`\x1b[38;2;${parseInt(a.slice(1,3),16)};${parseInt(a.slice(3,5),16)};${parseInt(a.slice(5,7),16)}m▸ ${label} → ${target} …\x1b[0m\r\n\n`);
  } else if (hasTranscriptRestore && writeRestoredTranscript(term, restore, theme)) {
    // Full-screen apps cannot be resumed safely, but their readable terminal
    // transcript is preserved above the newly spawned shell.
  } else if (isRestore) {
    // previous screen on top, then a divider, then the fresh shell prompt below
    const a = theme.ui.dim;
    term.write(restore.buffer.replace(/[\r\n]+$/, ''));
    term.write(`\r\n\x1b[38;2;${parseInt(a.slice(1,3),16)};${parseInt(a.slice(3,5),16)};${parseInt(a.slice(5,7),16)}m[restored shell]\x1b[0m\r\n`);
  } else if (skippedInteractiveRestore) {
    const a = theme.ui.dim;
    term.write(`\x1b[38;2;${parseInt(a.slice(1,3),16)};${parseInt(a.slice(3,5),16)};${parseInt(a.slice(5,7),16)}m[previous interactive screen could not be recovered; shell restored fresh]\x1b[0m\r\n`);
  }
  // (no banner for plain terminals — just the shell)

  const spawnOpts = { tabId: node.id, cwd: node.cwd, command: node.command, history: seedHistory };
  if (isHost) {
    const key = node.keyId && state.keys.find((k) => k.id === node.keyId);
    spawnOpts.ssh = { host: node.host, port: node.port, user: node.user, identity: key ? key.path : '', mode: node.sftp ? 'sftp' : 'ssh' };
  }
  API.spawn(spawnOpts).then((res) => {
    if (!isHost && res && res.cwd) {
      node.cwd = res.cwd;
      if (!node.manualName) { node.name = basename(res.cwd); renderTree(); }
      if (node.id === activeId) updateStatus();
    }
    setTimeout(() => { try { fit.fit(); } catch {} }, 30);
  });
  return entry;
}

// Open a session: ensure its terminal, then show it (focus if visible, else load into focused pane).
function openTerminal(node, restore) {
  ensureTerminal(node, restore);
  if (layout && findLeaf(node.id)) { setFocus(node.id); return; }
  if (!layout) layout = leafNode(node.id);
  else { const f = findLeaf(activeId); if (f) f.leaf.session = node.id; else layout = leafNode(node.id); }
  setFocus(node.id);
  renderLayout(); renderTree(); autosave();
}
function activate(id) { // focus a live session, bringing it on-screen if needed
  if (!live.has(id)) return;
  if (layout && findLeaf(id)) { setFocus(id); return; }
  if (!layout) layout = leafNode(id);
  else { const f = findLeaf(activeId); if (f) f.leaf.session = id; else layout = leafNode(id); }
  setFocus(id); renderLayout();
}
function setFocus(id) {
  activeId = id;
  document.querySelectorAll('.pane-slot').forEach((s) => s.classList.toggle('focused', s.dataset.session === id));
  const e = live.get(id);
  const r = findNode(id);
  if (e && r && e.claudeState === 'complete') setClaudeState(r.node, e, e.claudeActive ? 'idle' : null);
  if (e) setTimeout(() => { try { e.fit.fit(); } catch {} e.term.focus(); }, 0);
  renderTree(); updateStatus(); updateTitle();
}

function renderLayout() {
  const host = document.getElementById('terminals');
  let root = document.getElementById('layout-root');
  if (!root) { root = document.createElement('div'); root.id = 'layout-root'; host.appendChild(root); }
  // detach all panes first so re-parenting doesn't destroy them
  live.forEach((e) => { if (e.pane.parentElement) e.pane.parentElement.removeChild(e.pane); });
  root.innerHTML = '';
  const empty = document.getElementById('empty-state');
  if (!layout) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  const multi = layoutLeafIds().length > 1;
  root.appendChild(buildLayoutNode(layout, multi));
  requestAnimationFrame(() => {
    eachLeaf((l) => { const e = live.get(l.session); if (e) { try { e.fit.fit(); } catch {} } });
    const fe = live.get(activeId); if (fe) fe.term.focus();
  });
}
function buildLayoutNode(node, multi) {
  if (node.type === 'leaf') {
    const slot = document.createElement('div');
    slot.className = 'pane-slot' + (multi ? ' multi' : '') + (node.session === activeId ? ' focused' : '');
    slot.dataset.session = node.session;
    const sn = findNode(node.session);
    if (sn && sn.node.color) slot.style.setProperty('--pane-accent', sn.node.color); // colored frame for prod hosts
    const e = live.get(node.session);
    if (e) {
      const rr = findNode(node.session);
      const isHost = rr && rr.node.type === 'host';
      const location = isHost
        ? `${rr.node.user ? `${rr.node.user}@` : ''}${rr.node.host}`
        : shortCwd(rr ? rr.node.cwd : OS.home);
      const bar = document.createElement('div');
      bar.className = 'pane-bar';
      bar.draggable = true;
      bar.innerHTML = `<span class="pane-grip">${ic('ellipsis-vertical', { size: 12 })}</span><span class="pane-ic">${ic(isHost ? (rr.node.sftp ? 'folder-key' : 'server') : 'square-terminal', { size: 12 })}</span><span class="pane-name">${escapeHtml(rr ? rr.node.name : 'shell')}</span><span class="pane-location">${ic(isHost ? 'server' : 'folder', { size: 11 })}<span>${escapeHtml(location)}</span></span>`;
      bar.ondragstart = (ev) => { ev.stopPropagation(); dragId = node.session; ev.dataTransfer.setData('text/plain', node.session); ev.dataTransfer.effectAllowed = 'move'; };
      bar.ondragend = () => { dragId = null; clearPaneDropZones(); };
      if (!isHost) {
        const open = document.createElement('button');
        open.className = 'pane-open-with';
        open.innerHTML = ic('external-link', { size: 11 }) + '<span>Open with…</span>';
        open.title = 'Open current directory with…';
        open.onclick = (ev) => { ev.stopPropagation(); openDirectoryWith(rr.node.cwd); };
        open.onmousedown = (ev) => ev.stopPropagation();
        bar.appendChild(open);
      }
      if (multi) {
        const exitSplit = document.createElement('button');
        exitSplit.className = 'pane-exit-split';
        exitSplit.innerHTML = ic('panel-left', { size: 12 }) + '<span>Exit split</span>';
        exitSplit.title = 'Show only this terminal; other terminals stay open in the sidebar';
        exitSplit.onclick = (ev) => { ev.stopPropagation(); exitSplitView(node.session); };
        exitSplit.onmousedown = (ev) => ev.stopPropagation();
        bar.appendChild(exitSplit);
      } else {
        const cls = document.createElement('button');
        cls.className = 'pane-close'; cls.innerHTML = ic('x', { size: 12 });
        cls.title = 'Close terminal'; cls.onclick = (ev) => { ev.stopPropagation(); closePane(node.session); };
        cls.onmousedown = (ev) => ev.stopPropagation();
        bar.appendChild(cls);
      }
      slot.appendChild(bar);
      slot.appendChild(e.pane);
    }
    slot.onmousedown = (ev) => { if (!ev.target.closest('.pane-bar')) setFocus(node.session); };
    // accept a dragged session/pane → split this pane on the nearest edge
    slot.ondragover = (ev) => {
      if (!dragId) return;
      ev.preventDefault(); ev.stopPropagation();
      ev.dataTransfer.dropEffect = 'move';
      showPaneDropZone(slot, paneDropSide(slot, ev));
    };
    slot.ondragleave = (ev) => { if (!slot.contains(ev.relatedTarget)) { const i = slot.querySelector('.pane-drop-ind'); if (i) i.remove(); } };
    slot.ondrop = (ev) => {
      if (!dragId) return;
      ev.preventDefault(); ev.stopPropagation();
      const side = paneDropSide(slot, ev);
      const did = dragId; dragId = null;
      dropSessionIntoPane(node.session, did, side);
    };
    slot.oncontextmenu = (ev) => { setFocus(node.session); openTerminalMenu(ev); };
    return slot;
  }
  const cont = document.createElement('div');
  cont.className = 'split-container ' + (node.dir === 'row' ? 'split-row' : 'split-col');
  const a = buildLayoutNode(node.children[0], multi);
  const b = buildLayoutNode(node.children[1], multi);
  const ratio = node.ratio || 0.5;
  a.style.flex = `${ratio} 1 0`; b.style.flex = `${1 - ratio} 1 0`;
  const divider = document.createElement('div');
  divider.className = 'split-divider ' + (node.dir === 'row' ? 'vert' : 'horiz');
  divider.onmousedown = (ev) => startDividerDrag(ev, node, cont, a, b);
  cont.appendChild(a); cont.appendChild(divider); cont.appendChild(b);
  return cont;
}
function startDividerDrag(ev, splitNode, cont, aEl, bEl) {
  ev.preventDefault();
  const horizontal = splitNode.dir === 'row';
  const rect = cont.getBoundingClientRect();
  const move = (e) => {
    let ratio = horizontal ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    ratio = Math.max(0.12, Math.min(0.88, ratio));
    splitNode.ratio = ratio;
    aEl.style.flex = `${ratio} 1 0`; bEl.style.flex = `${1 - ratio} 1 0`;
    eachLeaf((l) => { const en = live.get(l.session); if (en) { try { en.fit.fit(); } catch {} } });
  };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); persist(); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
  const restore = () => { document.body.style.cursor = ''; document.removeEventListener('mouseup', restore); };
  document.addEventListener('mouseup', restore);
}

// split the focused pane, creating a new terminal beside it
function splitFocused(dir) {
  if (!activeId || !live.has(activeId)) { newTerminal({}); return; }
  if (!layout) layout = leafNode(activeId);
  const r0 = findNode(activeId);
  const cwd = r0 ? r0.node.cwd : OS.home;
  const folder = r0 && r0.parent ? r0.parent : null;
  const node = { id: uid('ses'), type: 'session', name: 'shell', cwd, command: '', pinned: false, manualName: false };
  if (folder) folder.children.push(node); else state.tree.push(node);
  ensureTerminal(node);
  const f = findLeaf(activeId);
  const split = { type: 'split', dir, ratio: 0.5, children: [leafNode(activeId), leafNode(node.id)] };
  if (!f || !f.parent) layout = split;
  else { const i = f.parent.children.indexOf(f.leaf); f.parent.children[i] = split; }
  setFocus(node.id);
  renderLayout(); renderTree(); autosave();
}
// Drop a dock session (or another pane) into a target pane → split on the chosen edge.
function paneDropSide(slot, e) {
  const rect = slot.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  if (x > 0.34 && x < 0.66 && y > 0.34 && y < 0.66) return 'center';
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
}
function showPaneDropZone(slot, side) {
  let ind = slot.querySelector('.pane-drop-ind');
  if (!ind) { ind = document.createElement('div'); ind.className = 'pane-drop-ind'; slot.appendChild(ind); }
  const pos = {
    left: { left: '0', top: '0', width: '50%', height: '100%' },
    right: { left: '50%', top: '0', width: '50%', height: '100%' },
    top: { left: '0', top: '0', width: '100%', height: '50%' },
    bottom: { left: '0', top: '50%', width: '100%', height: '50%' },
    center: { left: '0', top: '0', width: '100%', height: '100%' },
  }[side];
  Object.assign(ind.style, { left: pos.left, top: pos.top, width: pos.width, height: pos.height });
}
function clearPaneDropZones() { document.querySelectorAll('.pane-drop-ind').forEach((el) => el.remove()); }

function dropSessionIntoPane(targetSid, dragSid, side) {
  clearPaneDropZones();
  if (!dragSid || (dragSid === targetSid && side === 'center')) return;
  const r = findNode(dragSid);
  if (!r || !isLeaf(r.node)) return; // only terminals/hosts can fill a pane
  ensureTerminal(r.node);
  if (layout && findLeaf(dragSid)) removeLeafFromLayout(dragSid); // pull from old position
  let t = layout && findLeaf(targetSid);
  if (!t) {
    if (!layout) layout = leafNode(dragSid);
    else { const f = findLeaf(activeId); if (f) f.leaf.session = dragSid; else layout = leafNode(dragSid); }
  } else if (side === 'center') {
    t.leaf.session = dragSid;
  } else {
    const dir = (side === 'left' || side === 'right') ? 'row' : 'col';
    const children = (side === 'left' || side === 'top')
      ? [leafNode(dragSid), leafNode(targetSid)]
      : [leafNode(targetSid), leafNode(dragSid)];
    const split = { type: 'split', dir, ratio: 0.5, children };
    if (!t.parent) layout = split;
    else { const i = t.parent.children.indexOf(t.leaf); t.parent.children[i] = split; }
  }
  setFocus(dragSid);
  renderLayout(); renderTree(); autosave();
}

function focusNextPane(dir) {
  const leaves = layoutLeafIds();
  if (leaves.length < 2) {
    const ids = [...live.keys()]; if (ids.length < 2) return;
    const i = ids.indexOf(activeId); activate(ids[(i + dir + ids.length) % ids.length]); return;
  }
  const i = leaves.indexOf(activeId);
  setFocus(leaves[(i + dir + leaves.length) % leaves.length]);
}

function closeEntry(id) {
  const e = live.get(id);
  if (!e) return;
  if (e._claudeCompleteTimer) clearTimeout(e._claudeCompleteTimer);
  if (e._initTimer) clearTimeout(e._initTimer);
  pendingWrites.delete(id);
  API.kill(id);
  try { e.term.dispose(); } catch {}
  if (e.pane.parentElement) e.pane.parentElement.removeChild(e.pane);
  live.delete(id);
  const r = findNode(id);
  if (r && r.node.type === 'session') r.list.splice(r.index, 1);
}
function removeLeafFromLayout(id) {
  const r = findLeaf(id);
  if (!r) return;
  if (!r.parent) { layout = null; return; }
  const split = r.parent;
  const sibling = split.children[0] === r.leaf ? split.children[1] : split.children[0];
  const gp = findParentOf(split);
  if (gp === null || gp === undefined) layout = sibling;
  else { const i = gp.children.indexOf(split); gp.children[i] = sibling; }
}
function closePane(id) {
  if (layout && findLeaf(id)) removeLeafFromLayout(id);
  closeEntry(id);
  if (!layout) {
    const remaining = [...live.keys()];
    if (remaining.length) { layout = leafNode(remaining[0]); activeId = remaining[0]; }
    else { activeId = null; }
  } else if (!findLeaf(activeId)) {
    const fl = firstLeaf(layout); activeId = fl ? fl.session : null;
  }
  renderLayout(); renderTree(); updateStatus(); updateTitle(); autosave();
  if (activeId) setFocus(activeId);
}
function closeTerminal(id) { closePane(id); } // ⌘W closes the focused pane
function exitSplitView(keepId) {
  layout = live.has(keepId) ? leafNode(keepId) : null;
  activeId = layout ? keepId : null;
  renderLayout(); renderTree(); updateStatus(); updateTitle(); autosave();
  if (activeId) setFocus(activeId);
}

// ---------------- actions ----------------
function newTerminal({ folderId, cwd } = {}) {
  const node = {
    id: uid('ses'), type: 'session',
    name: 'shell', cwd: cwd || activeCwd() || OS.home,
    command: '', pinned: false, manualName: false,
  };
  const fid = folderId !== undefined ? folderId : state.selectedFolderId;
  const target = fid ? findNode(fid) : null;
  if (target && target.node.type === 'folder') { target.node.children.push(node); target.node.expanded = true; }
  else state.tree.push(node);
  openTerminal(node);
}

function newFolder(name, parentId) {
  const folder = { id: uid('fld'), type: 'folder', name: name || 'New Folder', expanded: true, children: [] };
  const pid = parentId !== undefined ? parentId : state.selectedFolderId;
  const target = pid ? findNode(pid) : null;
  if (target && target.node.type === 'folder') target.node.children.push(folder);
  else state.tree.push(folder);
  persist(); renderTree();
}

function duplicateSession(id) {
  const r = findNode(id);
  if (!r || r.node.type !== 'session') return;
  newTerminal({ folderId: r.parent ? r.parent.id : null, cwd: r.node.cwd });
}

function deleteNode(id) {
  const r = findNode(id);
  if (!r) return;
  const isFolder = r.node.type === 'folder';
  const isHost = r.node.type === 'host';
  const label = isFolder ? `folder “${r.node.name}” and everything inside it` : `${isHost ? 'saved host' : 'session'} “${r.node.name}”`;
  const doDelete = () => {
    const fresh = findNode(id);
    if (!fresh) return;
    const ids = [];
    if (fresh.node.type === 'folder') eachSession((s) => ids.push(s.id), fresh.node.children);
    else ids.push(fresh.node.id);
    ids.forEach((sid) => { if (live.has(sid)) closeTermSilent(sid); });
    const again = findNode(id);
    if (again) again.list.splice(again.index, 1);
    if (state.selectedFolderId === id) state.selectedFolderId = null;
    if (activeId === null) document.getElementById('empty-state').classList.remove('hidden');
    persist(); renderTree(); updateStatus(); updateTitle();
  };
  if (!state.settings.confirmDelete) { doDelete(); return; }
  confirmModal({
    title: isFolder ? 'Remove folder permanently?' : isHost ? 'Remove saved host permanently?' : 'Remove session permanently?',
    message: `Remove ${label}? This cannot be undone.`,
    okLabel: 'Remove permanently', danger: true, rememberLabel: 'Don’t show removal confirmations',
    onOk: (remembered) => { if (remembered) { state.settings.confirmDelete = false; persist(); } doDelete(); },
  });
}

// reusable confirm dialog with optional "remember" checkbox
function confirmModal({ title, message, okLabel = 'OK', danger = false, rememberLabel, onOk }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `
    <div class="modal-card confirm-card${danger ? ' is-danger' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="cm-title" aria-describedby="cm-message">
      <div class="confirm-head">
        <span class="confirm-icon">${ic(danger ? 'trash-2' : 'circle-dot', { size: 20 })}</span>
        <div><strong id="cm-title">${escapeHtml(title)}</strong><p id="cm-message">${escapeHtml(message)}</p></div>
      </div>
      ${rememberLabel ? `<label class="confirm-remember">
        <span>${escapeHtml(rememberLabel)}</span>
        <input class="switch-input" type="checkbox" id="cm-remember" />
        <span class="switch-ui" aria-hidden="true"><span></span></span>
      </label>` : ''}
      <div class="modal-actions confirm-actions">
        <button class="btn-ghost" id="cm-cancel">Cancel</button>
        <button class="${danger ? 'btn-danger' : 'btn-accent'}" id="cm-ok">${escapeHtml(okLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); focusActive(); };
  overlay.querySelector('#cm-cancel').onclick = close;
  overlay.querySelector('#cm-ok').onclick = () => {
    const remembered = overlay.querySelector('#cm-remember')?.checked || false;
    close(); onOk(remembered);
  };
  overlay.onkeydown = (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') overlay.querySelector('#cm-ok').click(); };
  setTimeout(() => overlay.querySelector('#cm-ok').focus(), 20);
}

// Settings panel
function openSettings() {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  const toggle = (key, label, desc) => `
    <label class="set-row set-toggle-row">
      <span class="set-label">${label}<span class="set-sub">${desc}</span></span>
      <input class="switch-input" type="checkbox" data-key="${key}" ${state.settings[key] !== false ? 'checked' : ''} />
      <span class="switch-ui" aria-hidden="true"><span></span></span>
    </label>`;
  overlay.innerHTML = `
    <div class="modal-card settings-card">
      <div class="modal-head"><span>Settings</span><button class="modal-close" id="set-close">${ic('x', { size: 16 })}</button></div>
      <div class="settings-body">
        <section class="settings-section">
          <h3>Claude</h3>
          ${toggle('claudeDetection', 'Track Claude status', 'Show Working, Idle, and Complete on Claude sessions.')}
          ${toggle('desktopNotifications', 'Desktop notifications', 'Notify you when Claude finishes, even when terminal bell is unavailable.')}
          <div class="set-row">
            <span class="set-label">Claude terminal bell<span class="set-sub" id="set-claude-status">Checking Claude configuration…</span></span>
            <input class="switch-input" id="set-claude-toggle" type="checkbox" disabled />
            <span class="switch-ui" aria-hidden="true"><span></span></span>
          </div>
          <div class="settings-inline-actions">
            <button class="btn-ghost" id="set-test-notification">${ic('bell', { size: 14 })} Test notification</button>
          </div>
        </section>
        <section class="settings-section">
          <h3>Terminal</h3>
          ${toggle('restoreSessions', 'Restore sessions on launch', 'Automatically save and reopen terminals, folders, layouts, and terminal content in each workspace.')}
          ${toggle('restoreHistory', 'Restore command history', 'Reload previous commands when reopening a session.')}
          ${toggle('rtlText', 'Arabic and RTL text', 'Display right-to-left text in reading order.')}
          ${toggle('confirmDelete', 'Confirm destructive actions', 'Ask before deleting a session or folder.')}
        </section>
        <section class="settings-section">
          <h3>Features</h3>
          ${toggle('gitIntegration', 'Git integration', 'Show repository status, branch details, pull, push, and sync controls.')}
          ${toggle('commandsEnabled', 'Commands', 'Show saved commands in the sidebar, menus, and command palette.')}
          ${toggle('directoryPreviews', 'Directory previews', `Preview detected files and folders while holding ${OS.platform === 'darwin' ? 'Command' : 'Control'}.`)}
        </section>
        <section class="settings-section">
          <h3>Updates</h3>
          <label class="set-row set-toggle-row">
            <span class="set-label">Automatic updates<span class="set-sub" id="set-update-status">Checking update configuration…</span></span>
            <input class="switch-input" id="set-auto-updates" type="checkbox" disabled />
            <span class="switch-ui" aria-hidden="true"><span></span></span>
          </label>
          <div class="settings-inline-actions">
            <button class="btn-ghost" id="set-check-updates">${ic('refresh-cw', { size: 14 })} Check now</button>
          </div>
        </section>
        <section class="settings-section">
          <h3>Appearance</h3>
          ${toggle('writeSound', 'Paper writing sound', 'Play writing audio only while using the Paper theme.')}
          <label class="set-row">
            <span class="set-label">Handwriting font<span class="set-sub">Used by the Paper theme.</span></span>
            <select id="set-handfont" class="set-input">
              ${HAND_FONTS.map((f) => `<option value="${f}" ${f === state.settings.handwritingFont ? 'selected' : ''} style="font-family:'${f}'">${f}</option>`).join('')}
            </select>
          </label>
        </section>
        <section class="settings-section">
          <h3>Local development</h3>
          <label class="set-row">
            <span class="set-label">Domain suffix<span class="set-sub">Examples: .local, .test, .localhost</span></span>
            <input id="set-tld" class="set-input set-short" type="text" value="${escapeHtml(state.settings.domainTld || '.local')}" />
          </label>
          <label class="set-row">
            <span class="set-label">Proxy port<span class="set-sub">Port 80 provides clean URLs.</span></span>
            <input id="set-pport" class="set-input set-number" type="text" value="${escapeHtml(String(state.settings.proxyPort || 80))}" />
          </label>
        </section>
        <section class="settings-section settings-about" aria-label="About Coco">
          <div class="set-row">
            <span class="set-label">Coco<span class="set-sub">Workspace terminal for ${OS.platform === 'darwin' ? 'macOS' : OS.platform === 'win32' ? 'Windows' : 'Linux'}</span></span>
            <span class="app-version" id="set-app-version">Version…</span>
          </div>
        </section>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const claudeStatus = overlay.querySelector('#set-claude-status');
  const claudeToggle = overlay.querySelector('#set-claude-toggle');
  const showClaudeStatus = (result) => {
    if (!result || !result.ok) {
      claudeStatus.textContent = result && result.error || 'Could not check Claude settings.';
      claudeToggle.disabled = true;
      return;
    }
    claudeStatus.textContent = result.enabled ? 'Claude can emit an immediate completion signal.' : 'Optional. Coco also detects completion independently.';
    claudeToggle.checked = !!result.enabled;
    claudeToggle.disabled = false;
  };
  API.claudeNotificationStatus().then(showClaudeStatus);
  claudeToggle.nextElementSibling.onclick = () => { if (!claudeToggle.disabled) claudeToggle.click(); };
  claudeToggle.onchange = async () => {
    const enabled = claudeToggle.checked;
    claudeToggle.disabled = true;
    claudeStatus.textContent = enabled ? 'Enabling…' : 'Disabling…';
    const result = enabled ? await API.enableClaudeNotifications() : await API.disableClaudeNotifications();
    showClaudeStatus(result);
    if (!result || !result.ok) claudeToggle.checked = !enabled;
  };
  overlay.querySelector('#set-test-notification').onclick = () => {
    API.notify({ tabId: activeId, title: 'Coco notification test', body: 'Desktop notifications are working.' });
    flashToast('Test notification sent');
  };
  const updateToggle = overlay.querySelector('#set-auto-updates');
  const updateStatus = overlay.querySelector('#set-update-status');
  const showUpdateStatus = (result) => {
    updateToggle.checked = !!(result && result.enabled);
    updateToggle.disabled = !(result && result.configured && result.packaged);
    updateStatus.textContent = !result || !result.packaged
      ? 'Available in the packaged app.'
      : !result.configured
        ? 'The release feed is not configured in this build.'
        : result.enabled
          ? `Updates download automatically. Current version: ${result.version}.`
          : `Automatic checks are off. Current version: ${result.version}.`;
  };
  API.updateStatus().then(showUpdateStatus);
  API.appInfo().then((info) => {
    const version = overlay.querySelector('#set-app-version');
    if (version) version.textContent = `Version ${info && info.version ? info.version : 'unknown'}`;
  });
  updateToggle.nextElementSibling.onclick = () => { if (!updateToggle.disabled) updateToggle.click(); };
  updateToggle.onchange = async () => {
    updateToggle.disabled = true;
    updateStatus.textContent = updateToggle.checked ? 'Enabling automatic updates…' : 'Disabling automatic updates…';
    showUpdateStatus(await API.setAutomaticUpdates(updateToggle.checked));
  };
  overlay.querySelector('#set-check-updates').onclick = () => API.checkForUpdates();
  overlay.querySelectorAll('input[data-key]').forEach((inp) => {
    inp.onchange = () => {
      state.settings[inp.dataset.key] = inp.checked;
      if (inp.dataset.key === 'writeSound' && !inp.checked) stopWriteSound();
      if (inp.dataset.key === 'rtlText') applyRtl();
      if (['gitIntegration', 'commandsEnabled', 'directoryPreviews'].includes(inp.dataset.key)) updateFeatureVisibility();
      persist();
    };
  });
  overlay.querySelector('#set-tld').onchange = (e) => { let v = e.target.value.trim().replace(/^\.*/, '.'); if (!v || v === '.') v = '.local'; state.settings.domainTld = v; e.target.value = v; persist(); };
  overlay.querySelector('#set-pport').onchange = (e) => { const v = parseInt(e.target.value, 10) || 80; state.settings.proxyPort = v; e.target.value = v; persist(); };
  overlay.querySelector('#set-handfont').onchange = (e) => {
    state.settings.handwritingFont = e.target.value;
    persist();
    if (state.themeId === 'paper') { const f = themeFont(); for (const en of live.values()) { en.term.options.fontFamily = f; try { en.fit.fit(); } catch {} } }
  };
  const close = () => overlay.remove();
  overlay.querySelector('#set-close').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

// ---------------- generic form modal ----------------
function formModal({ title, fields, submitLabel = 'Save', onSubmit, onCancel, extra }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  const fieldHtml = fields.map((f) => {
    const id = 'fm-' + f.key;
    if (f.type === 'select') {
      const opts = f.options.map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === (f.value || '') ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
      return `<label class="fm-row${f.half ? ' half' : ''}"><span>${escapeHtml(f.label)}</span><select id="${id}">${opts}</select></label>`;
    }
    if (f.type === 'textarea') {
      return `<label class="fm-row${f.half ? ' half' : ''}"><span>${escapeHtml(f.label)}</span><textarea id="${id}" rows="3" placeholder="${escapeHtml(f.placeholder || '')}" spellcheck="false">${escapeHtml(f.value || '')}</textarea></label>`;
    }
    return `<label class="fm-row${f.half ? ' half' : ''}"><span>${escapeHtml(f.label)}</span>
      <input id="${id}" type="${f.type || 'text'}" value="${escapeHtml(f.value || '')}" placeholder="${escapeHtml(f.placeholder || '')}" spellcheck="false" autocomplete="off" /></label>`;
  }).join('');
  overlay.innerHTML = `
    <div class="modal-card" style="width:440px;">
      <div class="modal-head"><span>${escapeHtml(title)}</span><button class="modal-close" id="fm-x">${ic('x', { size: 16 })}</button></div>
      <div class="fm-body">${fieldHtml}${extra ? `<div class="fm-extra">${extra}</div>` : ''}</div>
      <div class="modal-actions">
        <button class="btn-ghost" id="fm-cancel">Cancel</button>
        <button class="btn-accent" id="fm-ok">${escapeHtml(submitLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  let submitted = false;
  const close = () => { overlay.remove(); if (!submitted && onCancel) onCancel(); focusActive(); };
  const submit = () => {
    submitted = true;
    const vals = {};
    fields.forEach((f) => { vals[f.key] = document.getElementById('fm-' + f.key).value.trim(); });
    overlay.remove(); focusActive(); onSubmit(vals);
  };
  overlay.querySelector('#fm-x').onclick = close;
  overlay.querySelector('#fm-cancel').onclick = close;
  overlay.querySelector('#fm-ok').onclick = submit;
  overlay.onkeydown = (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'TEXTAREA') submit(); };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  setTimeout(() => { const first = overlay.querySelector('input,select'); if (first) first.focus(); }, 20);
  return overlay;
}

// ---------------- remote sessions & keys ----------------
function keyOptions() {
  return [{ value: '', label: 'None (ssh-agent / default keys)' }]
    .concat(state.keys.map((k) => ({ value: k.id, label: k.name })));
}
function hostFields(node, mode = 'ssh') {
  return [
    { key: 'name', label: 'Display name', value: node ? node.name : '', placeholder: 'Production server' },
    { key: 'host', label: 'Address', value: node ? node.host : '', placeholder: 'server.example.com or 192.0.2.1' },
    { key: 'user', label: 'Username', half: true, value: node ? node.user : '', placeholder: OS.user || 'root' },
    { key: 'port', label: 'Port', half: true, type: 'number', value: node ? node.port : '22', placeholder: '22' },
    { key: 'keyId', label: 'Authentication', type: 'select', value: node ? node.keyId : '', options: keyOptions() },
    { key: 'color', label: 'Environment color', half: true, type: 'select', value: node ? (node.color || '') : '', options: [{ value: '', label: 'No color' }, { value: '#d98682', label: 'Red - production' }, { value: '#c7a873', label: 'Amber - caution' }, { value: '#83b9ae', label: 'Green - development' }, { value: '#8eafca', label: 'Blue - staging' }, { value: '#b7a3c8', label: 'Violet - custom' }] },
    { key: 'init', label: 'Command after connection', value: node ? (node.init || '') : '', placeholder: 'Optional, for example: cd /var/www' },
  ];
}
function openHostAs(node, sftp) {
  const tmp = { id: uid('host'), type: 'host', name: node.name + (sftp ? ' · SFTP' : ''), host: node.host, user: node.user, port: node.port, keyId: node.keyId, sftp: !!sftp, pinned: false, manualName: true };
  const r = findNode(node.id);
  const folder = r && r.parent ? r.parent : null;
  if (folder) folder.children.push(tmp); else state.tree.push(tmp);
  openTerminal(tmp);
}
function newHost(folderId, mode = 'ssh') {
  const isSftp = mode === 'sftp';
  const form = formModal({
    title: isSftp ? 'Add SFTP Session' : 'Add SSH Session',
    submitLabel: isSftp ? 'Save and open files' : 'Save and connect',
    fields: hostFields(null, mode),
    extra: `<div class="remote-form-kind"><span>${ic(isSftp ? 'folder-key' : 'server', { size: 18 })}</span><div><strong>${isSftp ? 'SFTP files' : 'SSH terminal'}</strong><small>${isSftp ? 'Browse and transfer files securely over SSH.' : 'Open an interactive remote shell.'}</small></div></div><button class="fm-link" id="fm-managekeys">${ic('key', { size: 14 })}<span>Manage SSH keys</span></button>`,
    onSubmit: (v) => {
      if (!v.host) return;
      const node = { id: uid('host'), type: 'host', name: v.name || v.host, host: v.host, user: v.user, port: v.port || '22', keyId: v.keyId || '', sftp: isSftp, color: v.color || '', init: v.init || '', pinned: true, manualName: true };
      const fid = folderId !== undefined ? folderId : state.selectedFolderId;
      const t = fid ? findNode(fid) : null;
      if (t && t.node.type === 'folder') { t.node.children.push(node); t.node.expanded = true; }
      else state.tree.push(node);
      persist(); renderTree();
      if (node.sftp) openSftpBrowser(node); else openTerminal(node);
    },
  });
  form.querySelector('.modal-card').classList.add('host-form-card');
  form.querySelector('.modal-card').classList.add(isSftp ? 'remote-sftp-form' : 'remote-ssh-form');
  const mk = document.getElementById('fm-managekeys');
  if (mk) mk.onclick = (e) => { e.preventDefault(); openKeys(); };
}

function savedHosts() {
  const hosts = [];
  eachSession((node) => { if (node.type === 'host') hosts.push(node); });
  return hosts;
}
function openHosts() {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `
    <div class="modal-card hosts-card">
      <div class="modal-head"><span>Remote Sessions</span><button class="modal-close" id="hosts-x">${ic('x', { size: 16 })}</button></div>
      <div class="hosts-toolbar">
        <span>Saved SSH terminals and SFTP file connections</span>
        <button class="btn-ghost" id="hosts-keys">${ic('key', { size: 14 })} Keys</button>
        <button class="btn-ghost" id="hosts-add-sftp">${ic('folder-key', { size: 14 })} Add SFTP</button>
        <button class="btn-accent" id="hosts-add">${ic('server', { size: 14 })} Add SSH</button>
      </div>
      <div class="hosts-list"></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const render = () => {
    const list = overlay.querySelector('.hosts-list');
    const hosts = savedHosts();
    if (!hosts.length) {
      list.innerHTML = `<div class="hosts-empty">${ic('server', { size: 25 })}<strong>No remote sessions</strong><span>Add an SSH terminal or an SFTP file connection.</span><div class="hosts-empty-actions"><button class="btn-ghost" id="hosts-empty-sftp">${ic('folder-key', { size: 14 })} Add SFTP</button><button class="btn-accent" id="hosts-empty-add">${ic('server', { size: 14 })} Add SSH</button></div></div>`;
      list.querySelector('#hosts-empty-add').onclick = () => { close(); newHost(undefined, 'ssh'); };
      list.querySelector('#hosts-empty-sftp').onclick = () => { close(); newHost(undefined, 'sftp'); };
      return;
    }
    list.innerHTML = hosts.map((host) => {
      const key = host.keyId && state.keys.find((item) => item.id === host.keyId);
      const target = `${host.user ? host.user + '@' : ''}${host.host}${host.port && String(host.port) !== '22' ? ':' + host.port : ''}`;
      return `<div class="host-row" data-host="${host.id}">
        <span class="host-mark" ${host.color ? `style="color:${host.color}"` : ''}>${ic(host.sftp ? 'folder-key' : 'server', { size: 17 })}</span>
        <span class="host-info"><strong>${escapeHtml(host.name)}</strong><small>${host.sftp ? 'SFTP' : 'SSH'} · ${escapeHtml(target)} · ${escapeHtml(key ? key.name : 'Default authentication')}</small></span>
        <button class="host-connect" data-connect="${host.id}">${ic(host.sftp ? 'folder-key' : 'plug', { size: 14 })} Open ${host.sftp ? 'files' : 'terminal'}</button>
        <button class="row-btn" data-alternate="${host.id}" title="${host.sftp ? 'Open SSH terminal' : 'Open SFTP files'}">${ic(host.sftp ? 'square-terminal' : 'folder-key', { size: 14 })}</button>
        <button class="row-btn" data-edit="${host.id}" title="Edit host">${ic('pencil', { size: 14 })}</button>
        <button class="row-btn danger" data-delete="${host.id}" title="Delete saved host">${ic('trash-2', { size: 14 })}</button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-connect]').forEach((button) => {
      button.onclick = () => { const r = findNode(button.dataset.connect); if (r) { close(); if (r.node.sftp) openSftpBrowser(r.node); else openTerminal(r.node); } };
    });
    list.querySelectorAll('[data-alternate]').forEach((button) => {
      button.onclick = () => { const r = findNode(button.dataset.alternate); if (r) { close(); if (r.node.sftp) openHostAs(r.node, false); else openSftpBrowser(r.node); } };
    });
    list.querySelectorAll('[data-edit]').forEach((button) => {
      button.onclick = () => { close(); editHost(button.dataset.edit); };
    });
    list.querySelectorAll('[data-delete]').forEach((button) => {
      button.onclick = () => { close(); deleteNode(button.dataset.delete); };
    });
  };
  render();
  overlay.querySelector('#hosts-x').onclick = close;
  overlay.querySelector('#hosts-add').onclick = () => { close(); newHost(undefined, 'ssh'); };
  overlay.querySelector('#hosts-add-sftp').onclick = () => { close(); newHost(undefined, 'sftp'); };
  overlay.querySelector('#hosts-keys').onclick = () => openKeys();
  overlay.onclick = (event) => { if (event.target === overlay) close(); };
}
function editHost(id) {
  const r = findNode(id);
  if (!r || r.node.type !== 'host') return;
  const form = formModal({
    title: r.node.sftp ? 'Edit SFTP Session' : 'Edit SSH Session', submitLabel: 'Save',
    fields: hostFields(r.node, r.node.sftp ? 'sftp' : 'ssh'),
    extra: `<div class="remote-form-kind"><span>${ic(r.node.sftp ? 'folder-key' : 'server', { size: 18 })}</span><div><strong>${r.node.sftp ? 'SFTP files' : 'SSH terminal'}</strong><small>${r.node.sftp ? 'Secure file browsing and transfers.' : 'Interactive remote shell connection.'}</small></div></div>`,
    onSubmit: (v) => {
      if (!v.host) return;
      Object.assign(r.node, { name: v.name || v.host, host: v.host, user: v.user, port: v.port || '22', keyId: v.keyId || '', color: v.color || '', init: v.init || '' });
      persist(); renderTree(); updateStatus(); updateTitle();
    },
  });
  form.querySelector('.modal-card').classList.add('host-form-card', r.node.sftp ? 'remote-sftp-form' : 'remote-ssh-form');
}
function openKeys() {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  const render = () => {
    const rows = state.keys.length
      ? state.keys.map((k) => `<div class="key-row"><span class="key-ic">${ic('key', { size: 15 })}</span>
          <span class="key-info"><b>${escapeHtml(k.name)}</b><br><span>${escapeHtml(k.path)}</span></span>
          <button class="row-btn" data-del="${k.id}">${ic('trash-2', { size: 14 })}</button></div>`).join('')
      : `<div class="tree-empty" style="padding:14px;">No keys yet. Add a private key file from ~/.ssh.</div>`;
    overlay.querySelector('#keys-list').innerHTML = rows;
    overlay.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { state.keys = state.keys.filter((k) => k.id !== b.dataset.del); persist(); render(); }; });
  };
  overlay.innerHTML = `
    <div class="modal-card" style="width:520px;">
      <div class="modal-head"><span>SSH Keys</span><button class="modal-close" id="keys-x">${ic('x', { size: 16 })}</button></div>
      <div id="keys-list" style="padding:8px 14px;max-height:46vh;overflow:auto;"></div>
      <div class="modal-actions">
        <button class="btn-ghost" id="keys-gen">${ic('key', { size: 14 })} Generate new key</button>
        <button class="btn-accent" id="keys-add">${ic('plus', { size: 14 })} Add existing</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  render();
  overlay.querySelector('#keys-x').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#keys-add').onclick = async () => {
    const path = await API.pickKeyFile();
    if (!path) return;
    const name = path.split('/').pop();
    state.keys.push({ id: uid('key'), name, path });
    persist(); render();
  };
  overlay.querySelector('#keys-gen').onclick = () => generateKeyForm(render);
}
function generateKeyForm(onDone) {
  formModal({
    title: 'Generate SSH Key', submitLabel: 'Generate',
    fields: [
      { key: 'name', label: 'File name (~/.ssh/…)', value: 'id_coco', placeholder: 'id_coco' },
      { key: 'type', label: 'Type', type: 'select', value: 'ed25519', options: [{ value: 'ed25519', label: 'ed25519 (recommended)' }, { value: 'rsa', label: 'RSA 4096' }] },
      { key: 'comment', label: 'Comment', value: `${OS.user}@${OS.host}`, placeholder: 'email or label' },
      { key: 'passphrase', label: 'Passphrase (optional)', type: 'password', placeholder: 'leave blank for none' },
    ],
    onSubmit: async (v) => {
      const res = await API.sshKeygen({ name: v.name, type: v.type, passphrase: v.passphrase, comment: v.comment });
      if (!res.ok) { confirmModal({ title: 'Key generation failed', message: res.error || 'ssh-keygen error', okLabel: 'OK', onOk: () => {} }); return; }
      state.keys.push({ id: uid('key'), name: res.name, path: res.path });
      persist(); if (onDone) onDone();
      showPubKey(res.pub, res.path);
    },
  });
}
function showPubKey(pub, keyPath) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `
    <div class="modal-card" style="width:580px;">
      <div class="modal-head"><span>Key generated</span><button class="modal-close" id="pk-x">${ic('x', { size: 16 })}</button></div>
      <div style="padding:14px 18px;">
        <div style="font-size:12px;color:var(--dim);margin-bottom:8px;">Saved to <b>${escapeHtml(keyPath)}</b>. Add this public key to the server’s <code>~/.ssh/authorized_keys</code>:</div>
        <pre class="pp-snippet" style="white-space:pre-wrap;max-height:170px;user-select:text;">${escapeHtml(pub || '(no public key)')}</pre>
      </div>
      <div class="modal-actions" style="padding:0 18px 16px;">
        <button class="btn-ghost" id="pk-copy">Copy public key</button>
        <button class="btn-accent" id="pk-ok">Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#pk-x').onclick = close;
  overlay.querySelector('#pk-ok').onclick = close;
  overlay.querySelector('#pk-copy').onclick = () => { API.clipboardWrite(pub || ''); };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

// ---------------- command blocks (Warp-style, via OSC 133) ----------------
function cellDims(term) {
  let w = 8.5, h = 18;
  try { const el = term.element && term.element.querySelector('.xterm-rows'); if (el) { h = el.offsetHeight / term.rows || h; w = el.offsetWidth / term.cols || w; } } catch {}
  return { w, h };
}
function markBlock(term, block) {
  try {
    const buf = term.buffer.active;
    const marker = term.registerMarker(block.promptY - (buf.baseY + buf.cursorY));
    if (!marker) return;
    const color = block.exit === 0 ? '#3ddc97' : '#ff6b6b';
    const deco = term.registerDecoration({ marker, x: 0, width: 1, overviewRulerOptions: { color, position: 'left' } });
    if (deco) deco.onRender((el) => { el.style.background = color; el.style.width = '3px'; el.style.opacity = '0.85'; el.style.pointerEvents = 'none'; });
    block.marker = marker;
  } catch {}
}
function jumpBlock(dir) {
  const e = live.get(activeId); if (!e || !e.blocks || !e.blocks.length) return;
  const buf = e.term.buffer.active, top = buf.viewportY;
  const ys = e.blocks.map((b) => b.promptY).sort((a, b) => a - b);
  let target = dir > 0 ? ys.find((y) => y > top + 1) : ys.filter((y) => y < top - 1).pop();
  if (target == null) return;
  try { e.term.scrollLines(target - buf.viewportY); } catch {}
}
function copyLastOutput() {
  const e = live.get(activeId); if (!e || !e.blocks || !e.blocks.length) return;
  const b = e.blocks[e.blocks.length - 1], buf = e.term.buffer.active;
  let out = '';
  for (let y = b.outputY; y < b.endY && y < buf.length; y++) { const l = buf.getLine(y); if (l) out += l.translateToString(true) + '\n'; }
  API.clipboardWrite(out.trim());
  flashToast('Copied last command output');
}
function flashToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ---------------- inline images (OSC 1337) ----------------
function parseImgDim(v, maxCols, cellW, natW) {
  if (/^\d+px$/.test(v)) return Math.ceil(parseInt(v) / cellW);
  if (/^\d+%$/.test(v)) return Math.ceil(maxCols * parseInt(v) / 100);
  if (/^\d+$/.test(v)) return parseInt(v);
  return Math.min(maxCols, Math.ceil(natW / cellW));
}
function renderInlineImage(term, entry, args, b64) {
  const url = `data:image/png;base64,${(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '')}`;
  const img = new Image();
  img.onload = () => {
    const cell = cellDims(term);
    let cols = args.width ? parseImgDim(args.width, term.cols, cell.w, img.naturalWidth) : Math.min(term.cols, Math.ceil(img.naturalWidth / cell.w));
    cols = Math.max(1, Math.min(cols, term.cols));
    let rows = Math.max(1, Math.min(30, Math.ceil((cols * cell.w * img.naturalHeight / img.naturalWidth) / cell.h)));
    term.write('\r\n'.repeat(rows), () => {
      try {
        const marker = term.registerMarker(-rows);
        if (!marker) return;
        const deco = term.registerDecoration({ marker, x: 0 });
        if (deco) deco.onRender((el) => {
          el.classList.add('coco-inline-img');
          el.style.width = (cols * cell.w) + 'px';
          el.style.height = (rows * cell.h) + 'px';
          el.style.backgroundImage = `url("${url}")`;
          el.style.zIndex = '5';
        });
      } catch {}
    });
  };
  img.src = url;
}

// ---------------- saved layouts ----------------
function serializeLeaf(sid) {
  const r = findNode(sid); if (!r) return null;
  const n = r.node;
  if (n.type === 'host') return { type: 'host', name: n.name, host: n.host, user: n.user, port: n.port, keyId: n.keyId, sftp: n.sftp, color: n.color, init: n.init };
  return { type: 'session', name: n.manualName ? n.name : '', cwd: n.cwd, init: n.init || '' };
}
function serializeLayout(node) {
  if (!node) return null;
  if (node.type === 'leaf') return { type: 'leaf', session: serializeLeaf(node.session) };
  return { type: 'split', dir: node.dir, ratio: node.ratio, children: [serializeLayout(node.children[0]), serializeLayout(node.children[1])] };
}
function materializeLayout(snode) {
  if (!snode) return null;
  if (snode.type === 'leaf') {
    const d = snode.session; if (!d) return null;
    let node;
    if (d.type === 'host') node = { id: uid('host'), type: 'host', name: d.name, host: d.host, user: d.user, port: d.port, keyId: d.keyId, sftp: d.sftp, color: d.color, init: d.init, pinned: false, manualName: true };
    else node = { id: uid('ses'), type: 'session', name: d.name || 'shell', cwd: d.cwd, command: '', init: d.init, pinned: false, manualName: !!d.name };
    state.tree.push(node);
    ensureTerminal(node);
    return leafNode(node.id);
  }
  const a = materializeLayout(snode.children[0]); const b = materializeLayout(snode.children[1]);
  return a && b ? { type: 'split', dir: snode.dir, ratio: snode.ratio || 0.5, children: [a, b] } : (a || b || null);
}
function saveLayoutPreset() {
  if (!layout) { flashToast('Nothing to save'); return; }
  promptModal('Save Layout', 'Layout name', '', (name) => {
    if (!name) return;
    state.layouts.push({ id: uid('lay'), name, tree: serializeLayout(layout) });
    persist(); flashToast('Layout saved');
  });
}
function openLayoutPreset(ws) {
  const lay = materializeLayout(ws.tree); if (!lay) return;
  layout = lay; const fl = firstLeaf(layout); activeId = fl ? fl.session : null;
  renderLayout(); renderTree(); if (activeId) setFocus(activeId); autosave();
}
function openLayoutsManager() {
  const overlay = document.createElement('div'); overlay.className = 'modal';
  const render = () => {
    const rows = state.layouts.length ? state.layouts.map((w) => {
      const n = (function count(t) { return !t ? 0 : t.type === 'leaf' ? 1 : count(t.children[0]) + count(t.children[1]); })(w.tree);
      return `<div class="lm-row" data-open="${w.id}"><span class="lm-ic">${ic('square-terminal', { size: 15 })}</span><span class="lm-info"><b>${escapeHtml(w.name)}</b><br><span>${n} pane${n === 1 ? '' : 's'}</span></span><button class="row-btn" data-del="${w.id}">${ic('trash-2', { size: 14 })}</button></div>`;
    }).join('') : '<div class="tree-empty" style="padding:16px;">No saved layouts yet. Arrange splits, then save the layout.</div>';
    overlay.querySelector('#wm-list').innerHTML = rows;
    overlay.querySelectorAll('[data-open]').forEach((el) => { el.onclick = (e) => { if (e.target.closest('[data-del]')) return; const w = state.layouts.find((x) => x.id === el.dataset.open); overlay.remove(); openLayoutPreset(w); }; });
    overlay.querySelectorAll('[data-del]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); state.layouts = state.layouts.filter((x) => x.id !== b.dataset.del); persist(); render(); }; });
  };
  overlay.innerHTML = `<div class="modal-card" style="width:500px;"><div class="modal-head"><span>Saved Layouts</span><button class="modal-close" id="wm-x">${ic('x', { size: 16 })}</button></div><div id="wm-list" style="padding:8px 14px;max-height:50vh;overflow:auto;"></div><div class="modal-actions"><button class="btn-accent" id="wm-save">${ic('plus', { size: 14 })} Save current layout</button></div></div>`;
  document.body.appendChild(overlay); render();
  overlay.querySelector('#wm-x').onclick = () => overlay.remove();
  overlay.querySelector('#wm-save').onclick = () => { overlay.remove(); saveLayoutPreset(); };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

async function switchWorkspace(id) {
  if (id === state.activeWorkspaceId) return;
  const target = state.workspaceProfiles.find((workspace) => workspace.id === id);
  if (!target) return;
  await persistBuffers();
  syncActiveWorkspace();
  for (const [sessionId, entry] of live) {
    API.kill(sessionId);
    try { entry.term.dispose(); } catch {}
    entry.pane.remove();
  }
  live.clear();
  layout = null;
  activeId = null;
  state.activeWorkspaceId = id;
  state.tree = target.tree || [];
  state.keys = target.keys || [];
  state.commands = target.commands || defaultCommands();
  state.domains = target.domains || [];
  state.selectedFolderId = null;
  const buffers = (await API.storeGet(workspaceBufferKey())) || {};
  const valid = (target.openIds || []).filter((sessionId) => {
    const found = findNode(sessionId);
    return found && isLeaf(found.node);
  });
  valid.forEach((sessionId) => { const found = findNode(sessionId); if (found) ensureTerminal(found.node, buffers[sessionId]); });
  layout = (target.layout && pruneLayout(target.layout)) || (valid.length ? leafNode(valid[0]) : null);
  const first = firstLeaf(layout);
  activeId = target.activeId && live.has(target.activeId) && findLeaf(target.activeId) ? target.activeId : (first ? first.session : null);
  renderLayout();
  renderTree();
  renderWorkspaceSwitcher();
  if (activeId) setFocus(activeId);
  else document.getElementById('empty-state').classList.remove('hidden');
  pushProxyMap();
  persist();
}

function renderWorkspaceSwitcher() {
  const button = document.getElementById('workspace-switcher');
  const workspace = activeWorkspace();
  if (!button || !workspace) return;
  button.innerHTML = `<span class="workspace-symbol">${ic('layers', { size: 12 })}</span><span class="workspace-caption">Workspace</span><span class="workspace-name">${escapeHtml(workspace.name)}</span>${ic('chevron-down', { size: 11 })}`;
}

function openWorkspaceMenu() {
  const anchor = document.getElementById('workspace-switcher');
  const current = openMenus[0];
  if (current && current.classList.contains('workspace-menu')) {
    closeAllMenus();
    anchor.classList.remove('menu-open');
    anchor.setAttribute('aria-expanded', 'false');
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const items = state.workspaceProfiles.map((workspace) => ({
    icon: workspace.id === 'global' ? 'globe' : 'layers',
    label: workspace.name,
    hint: workspace.id === state.activeWorkspaceId ? 'Current' : '',
    run: () => switchWorkspace(workspace.id),
  }));
  items.push({ sep: true });
  items.push({ icon: 'settings-2', label: 'Manage Workspaces…', run: () => openWorkspaceManager() });
  const menu = showMenu(rect.left, rect.bottom + 5, items);
  menu.classList.add('workspace-menu');
  anchor.classList.add('menu-open');
  anchor.setAttribute('aria-expanded', 'true');
}

function openWorkspaceManager() {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `<div class="modal-card workspace-card">
    <div class="modal-head"><span>Workspaces</span><button class="modal-close" id="workspace-x">${ic('x', { size: 16 })}</button></div>
    <div class="workspace-manager-head"><span>Sessions, hosts, keys, commands, and domains stay separate in each workspace.</span><button class="btn-accent" id="workspace-add">${ic('plus', { size: 14 })} New workspace</button></div>
    <div class="workspace-list"></div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const startWorkspaceRename = (workspaceId) => {
    const workspace = state.workspaceProfiles.find((item) => item.id === workspaceId);
    const row = overlay.querySelector(`[data-workspace-id="${workspaceId}"]`);
    const info = row && row.querySelector('.workspace-row-info');
    if (!workspace || !info) return;
    const input = document.createElement('input');
    input.className = 'workspace-inline-name';
    input.value = workspace.name;
    const finish = (save) => {
      const next = input.value.trim();
      if (save && next) workspace.name = next;
      persist();
      render();
      renderWorkspaceSwitcher();
    };
    input.onkeydown = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(true);
    info.replaceChildren(input);
    input.focus();
    input.select();
  };
  const render = () => {
    overlay.querySelector('.workspace-list').innerHTML = state.workspaceProfiles.map((workspace) => {
      const sessionCount = (function count(nodes) { return nodes.reduce((total, node) => total + (node.type === 'folder' ? count(node.children || []) : 1), 0); })(workspace.tree || []);
      const hostCount = [];
      eachSession((node) => { if (node.type === 'host') hostCount.push(node); }, workspace.tree || []);
      return `<div class="workspace-row" data-workspace-id="${workspace.id}">
        <span class="workspace-row-icon">${ic(workspace.id === 'global' ? 'globe' : 'layers', { size: 17 })}</span>
        <span class="workspace-row-info"><strong>${escapeHtml(workspace.name)}</strong><small>${sessionCount} sessions · ${hostCount.length} hosts · ${(workspace.keys || []).length} keys</small></span>
        ${workspace.id === state.activeWorkspaceId ? '<span class="workspace-current">Current</span>' : `<button class="row-btn" data-open-workspace="${workspace.id}" title="Open workspace">${ic('arrow-right', { size: 14 })}</button>`}
        ${workspace.id === 'global' ? '' : `<button class="row-btn" data-rename-workspace="${workspace.id}" title="Rename">${ic('pencil', { size: 14 })}</button><button class="row-btn danger" data-delete-workspace="${workspace.id}" title="Delete">${ic('trash-2', { size: 14 })}</button>`}
      </div>`;
    }).join('');
    overlay.querySelectorAll('[data-open-workspace]').forEach((button) => { button.onclick = () => { const id = button.dataset.openWorkspace; close(); switchWorkspace(id); }; });
    overlay.querySelectorAll('[data-rename-workspace]').forEach((button) => {
      button.onclick = () => startWorkspaceRename(button.dataset.renameWorkspace);
    });
    overlay.querySelectorAll('[data-delete-workspace]').forEach((button) => {
      button.onclick = () => {
        const workspace = state.workspaceProfiles.find((item) => item.id === button.dataset.deleteWorkspace);
        confirmModal({ title: 'Delete Workspace', message: `Delete “${workspace.name}” and its saved sessions, hosts, and settings? SSH key files on disk are not deleted.`, okLabel: 'Delete', danger: true, onOk: () => {
          state.workspaceProfiles = state.workspaceProfiles.filter((item) => item.id !== workspace.id);
          API.storeDelete(`buffers:${workspace.id}`);
          API.storeDelete(`pinbuffers:${workspace.id}`);
          persist(); render();
        } });
      };
    });
  };
  render();
  overlay.querySelector('#workspace-x').onclick = close;
  overlay.querySelector('#workspace-add').onclick = () => {
    const used = new Set(state.workspaceProfiles.map((workspace) => workspace.name.toLowerCase()));
    let number = state.workspaceProfiles.length;
    let name = `Workspace ${number}`;
    while (used.has(name.toLowerCase())) name = `Workspace ${++number}`;
    const workspace = { id: uid('workspace'), name, tree: [], keys: [], commands: defaultCommands(), domains: [], openIds: [], layout: null, activeId: null };
    state.workspaceProfiles.push(workspace);
    persist();
    render();
    startWorkspaceRename(workspace.id);
  };
  overlay.onclick = (event) => { if (event.target === overlay) close(); };
}

// ---------------- port forwarding ----------------
let tunnelRunning = new Set();
function tunnelLabel(t) { return `${t.type === 'R' ? 'R' : 'L'}  :${t.localPort} → ${t.remoteHost || 'localhost'}:${t.remotePort}  via ${t.sshUser ? t.sshUser + '@' : ''}${t.sshHost}`; }
async function startTunnel(t, refresh) {
  const key = t.keyId && state.keys.find((k) => k.id === t.keyId);
  const res = await API.tunnelStart({ id: t.id, type: t.type, localPort: t.localPort, remoteHost: t.remoteHost, remotePort: t.remotePort, sshHost: t.sshHost, sshUser: t.sshUser, sshPort: t.sshPort, identity: key ? key.path : '' });
  if (res.ok) { tunnelRunning.add(t.id); flashToast('Tunnel started'); } else { confirmModal({ title: 'Tunnel failed', message: res.error || 'could not start', okLabel: 'OK', onOk: () => {} }); }
  if (refresh) refresh();
}
async function stopTunnel(t, refresh) { await API.tunnelStop({ id: t.id }); tunnelRunning.delete(t.id); if (refresh) refresh(); }
function tunnelForm(existing, after) {
  formModal({
    title: existing ? 'Edit Tunnel' : 'New Tunnel', submitLabel: 'Save',
    fields: [
      { key: 'name', label: 'Name', value: existing ? existing.name : '', placeholder: 'Dev DB' },
      { key: 'type', label: 'Direction', type: 'select', value: existing ? existing.type : 'L', options: [{ value: 'L', label: 'Local  (-L)  local → remote' }, { value: 'R', label: 'Remote (-R)  remote → local' }] },
      { key: 'localPort', label: 'Listen port', value: existing ? existing.localPort : '', placeholder: '5432' },
      { key: 'remoteHost', label: 'Target host', value: existing ? existing.remoteHost : 'localhost', placeholder: 'localhost' },
      { key: 'remotePort', label: 'Target port', value: existing ? existing.remotePort : '', placeholder: '5432' },
      { key: 'sshHost', label: 'SSH host', value: existing ? existing.sshHost : '', placeholder: 'example.com' },
      { key: 'sshUser', label: 'SSH user', value: existing ? existing.sshUser : '', placeholder: 'root' },
      { key: 'sshPort', label: 'SSH port', value: existing ? existing.sshPort : '22', placeholder: '22' },
      { key: 'keyId', label: 'SSH key', type: 'select', value: existing ? existing.keyId : '', options: keyOptions() },
    ],
    onSubmit: (v) => {
      if (!v.localPort || !v.remotePort || !v.sshHost) return;
      if (existing) Object.assign(existing, v);
      else state.tunnels.push({ id: uid('tun'), ...v });
      persist(); if (after) after();
    },
  });
}
function openTunnels() {
  const overlay = document.createElement('div'); overlay.className = 'modal';
  const render = () => {
    const rows = state.tunnels.length ? state.tunnels.map((t) => {
      const on = tunnelRunning.has(t.id);
      return `<div class="lm-row"><span class="lm-ic" style="color:${on ? 'var(--accent2)' : 'var(--dim)'}">${ic('plug', { size: 15 })}</span>
        <span class="lm-info"><b>${escapeHtml(t.name || tunnelLabel(t))}</b><br><span>${escapeHtml(tunnelLabel(t))}</span></span>
        <button class="btn-ghost" data-toggle="${t.id}" style="padding:5px 12px;${on ? 'color:var(--accent2);border-color:var(--accent2)' : ''}">${on ? 'Stop' : 'Start'}</button>
        <button class="row-btn" data-edit="${t.id}">${ic('pencil', { size: 13 })}</button>
        <button class="row-btn" data-del="${t.id}">${ic('trash-2', { size: 13 })}</button></div>`;
    }).join('') : '<div class="tree-empty" style="padding:16px;">No tunnels yet. Add one to forward a port over SSH.</div>';
    overlay.querySelector('#tn-list').innerHTML = rows;
    overlay.querySelectorAll('[data-toggle]').forEach((b) => { b.onclick = () => { const t = state.tunnels.find((x) => x.id === b.dataset.toggle); tunnelRunning.has(t.id) ? stopTunnel(t, render) : startTunnel(t, render); }; });
    overlay.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => { const t = state.tunnels.find((x) => x.id === b.dataset.edit); tunnelForm(t, render); }; });
    overlay.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { const t = state.tunnels.find((x) => x.id === b.dataset.del); if (tunnelRunning.has(t.id)) stopTunnel(t); state.tunnels = state.tunnels.filter((x) => x.id !== b.dataset.del); persist(); render(); }; });
  };
  overlay.innerHTML = `<div class="modal-card" style="width:600px;"><div class="modal-head"><span>Port Forwarding</span><button class="modal-close" id="tn-x">${ic('x', { size: 16 })}</button></div><div id="tn-list" style="padding:8px 14px;max-height:52vh;overflow:auto;"></div><div class="modal-actions"><button class="btn-accent" id="tn-add">${ic('plus', { size: 14 })} New tunnel</button></div></div>`;
  document.body.appendChild(overlay);
  API.tunnelRunning().then((ids) => { tunnelRunning = new Set(ids); render(); });
  render();
  overlay.querySelector('#tn-x').onclick = () => overlay.remove();
  overlay.querySelector('#tn-add').onclick = () => tunnelForm(null, render);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// ---------------- SFTP file browser ----------------
function humanSizeShort(n) { if (n == null) return ''; const u = ['B', 'K', 'M', 'G']; let i = 0, v = n; while (v >= 1024 && i < 3) { v /= 1024; i++; } return (i === 0 ? v : v.toFixed(1)) + u[i]; }
async function openSftpBrowser(hostNode) {
  const key = hostNode.keyId && state.keys.find((k) => k.id === hostNode.keyId);
  const overlay = document.createElement('div'); overlay.className = 'modal';
  overlay.innerHTML = `<div class="modal-card sftp-card"><div class="modal-head"><span>SFTP · ${escapeHtml(hostNode.name)}</span><button class="modal-close" id="sf-x">${ic('x', { size: 16 })}</button></div><div class="sftp-body" id="sf-body"><div class="sftp-connecting">${ic('plug', { size: 18 })} connecting…</div></div></div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); if (state._sftpId) { API.sftpDisconnect({ id: state._sftpId }); state._sftpId = null; } };
  overlay.querySelector('#sf-x').onclick = close;

  let res = await API.sftpConnect({ host: hostNode.host, port: hostNode.port, user: hostNode.user, identity: key ? key.path : '' });
  if (!res.ok) {
    const pw = await askText('Password', `${hostNode.user || ''}@${hostNode.host} password`, true);
    if (pw == null) { close(); return; }
    res = await API.sftpConnect({ host: hostNode.host, port: hostNode.port, user: hostNode.user, identity: key ? key.path : '', password: pw });
  }
  if (!res.ok) { overlay.querySelector('#sf-body').innerHTML = `<div class="sftp-connecting" style="color:#ff8b8b">${escapeHtml(res.error || 'connection failed')}</div>`; return; }
  const sid = res.id; state._sftpId = sid;
  let localDir = await API.fsHome();
  let remoteDir = res.home || '.';
  const body = overlay.querySelector('#sf-body');
  body.innerHTML = `
    <div class="sftp-pane" id="sf-local"><div class="sftp-bar"><span class="sftp-side">THIS MAC</span><span class="sftp-path" id="lp-path"></span><button class="sftp-up" id="lp-up" title="Up">${ic('chevron-right', { size: 14 })}</button></div><div class="sftp-list" id="lp-list"></div></div>
    <div class="sftp-pane" id="sf-remote"><div class="sftp-bar"><span class="sftp-side">${escapeHtml(hostNode.host)}</span><span class="sftp-path" id="rp-path"></span><button class="sftp-up" id="rp-up" title="Up">${ic('chevron-right', { size: 14 })}</button></div><div class="sftp-list" id="rp-list"></div></div>`;
  body.querySelector('#lp-up').style.transform = 'rotate(180deg)';
  body.querySelector('#rp-up').style.transform = 'rotate(180deg)';

  const join = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
  const parent = (dir) => { const p = dir.replace(/\/+$/, '').split('/').slice(0, -1).join('/'); return p || '/'; };

  async function loadLocal() {
    const r = await API.fsList({ path: localDir });
    if (!r.ok) return;
    localDir = r.dir; body.querySelector('#lp-path').textContent = localDir;
    paint(body.querySelector('#lp-list'), r.entries, 'local');
  }
  async function loadRemote() {
    const r = await API.sftpList({ id: sid, path: remoteDir });
    if (!r.ok) { body.querySelector('#rp-list').innerHTML = `<div class="tree-empty" style="padding:14px;color:#ff8b8b">${escapeHtml(r.error)}</div>`; return; }
    remoteDir = r.dir; body.querySelector('#rp-path').textContent = remoteDir;
    paint(body.querySelector('#rp-list'), r.entries, 'remote');
  }
  function paint(listEl, entries, side) {
    listEl.innerHTML = '';
    entries.forEach((it) => {
      const row = document.createElement('div'); row.className = 'sf-row';
      row.innerHTML = `<span class="sf-ic">${ic(it.type === 'dir' ? 'folder' : 'scroll-text', { size: 14 })}</span><span class="sf-name">${escapeHtml(it.name)}</span><span class="sf-size">${it.type === 'dir' ? '' : humanSizeShort(it.size)}</span>`;
      row.ondblclick = () => {
        if (it.type === 'dir') { if (side === 'local') { localDir = join(localDir, it.name); loadLocal(); } else { remoteDir = join(remoteDir, it.name); loadRemote(); } }
        else if (side === 'remote') transfer('down', it);
      };
      if (it.type !== 'dir') {
        row.draggable = true;
        row.ondragstart = (ev) => { ev.dataTransfer.setData('text/coco-sftp', JSON.stringify({ side, name: it.name })); };
      }
      listEl.appendChild(row);
    });
  }
  async function transfer(dir, it) {
    flashToast(dir === 'down' ? `Downloading ${it.name}…` : `Uploading ${it.name}…`);
    let r;
    if (dir === 'down') r = await API.sftpDownload({ id: sid, remote: join(remoteDir, it.name), local: join(localDir, it.name) });
    else r = await API.sftpUpload({ id: sid, local: join(localDir, it.name), remote: join(remoteDir, it.name) });
    if (r.ok) { flashToast('Done'); dir === 'down' ? loadLocal() : loadRemote(); }
    else confirmModal({ title: 'Transfer failed', message: r.error || '', okLabel: 'OK', onOk: () => {} });
  }
  // drop local→remote (upload) and remote→local (download)
  const wire = (paneId, side) => {
    const el = body.querySelector(paneId);
    el.ondragover = (ev) => { if (ev.dataTransfer.types.includes('text/coco-sftp')) { ev.preventDefault(); el.classList.add('sf-drop'); } };
    el.ondragleave = () => el.classList.remove('sf-drop');
    el.ondrop = (ev) => { el.classList.remove('sf-drop'); const raw = ev.dataTransfer.getData('text/coco-sftp'); if (!raw) return; const d = JSON.parse(raw); if (d.side === side) return; ev.preventDefault(); if (side === 'remote') transfer('up', { name: d.name }); else transfer('down', { name: d.name }); };
  };
  wire('#sf-remote', 'remote'); wire('#sf-local', 'local');
  body.querySelector('#lp-up').onclick = () => { localDir = parent(localDir); loadLocal(); };
  body.querySelector('#rp-up').onclick = () => { remoteDir = parent(remoteDir); loadRemote(); };
  loadLocal(); loadRemote();
}
// small async text/password prompt returning a Promise<string|null>
function askText(title, placeholder, password) {
  return new Promise((resolve) => {
    formModal({ title, submitLabel: 'OK', fields: [{ key: 'v', label: placeholder, type: password ? 'password' : 'text' }], onSubmit: (v) => resolve(v.v), onCancel: () => resolve(null) });
  });
}

// ---------------- local domains (auto-detect dev servers → *.localhost) ----------------
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi;
const IGNORE_PORTS = new Set([80, 443]);
function domainTld() { let t = state.settings.domainTld || '.local'; return t.startsWith('.') ? t : '.' + t; }
function slugBase(name) { return ((name || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'app'; }
function fullDomain(name) { return name.includes('.') ? name : slugBase(name) + domainTld(); }
function proxyPort() { return Number(state.settings.proxyPort) || 80; }
function domainUrl(domain) { const p = proxyPort(); return 'http://' + domain + (p === 80 ? '' : ':' + p); }
function buildProxyMap() { const m = {}; for (const d of state.domains) m[d.domain] = Number(d.port); return m; }
function pushProxyMap() { if (state.proxyOn) API.proxySetMap(buildProxyMap()); }

function detectService(tabId, data) {
  const e = live.get(tabId); if (!e) return;
  const r = findNode(tabId); if (!r || r.node.type === 'host') return; // local sessions only
  e._outBuf = ((e._outBuf || '') + data).slice(-400);
  if (!e._seenPorts) e._seenPorts = new Set();
  let m; URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(e._outBuf))) {
    const port = parseInt(m[1], 10);
    if (IGNORE_PORTS.has(port) || e._seenPorts.has(port)) continue;
    e._seenPorts.add(port);
    // only treat as a real service if something is actually listening on that port
    API.portCheck(port).then((up) => {
      if (!up) { e._seenPorts.delete(port); return; }
      e._lastPort = port;
      onServiceDetected(r.node, port);
      if (r.node.id === activeId) updateStatus();
    });
  }
}
function addDomain(domain, port, sessionId, auto) {
  const entry = { id: uid('dom'), domain, port: Number(port), sessionId, auto: !!auto };
  state.domains.push(entry); persist();
  return entry;
}
async function onServiceDetected(node, port) {
  if (state.domains.some((d) => Number(d.port) === port)) return; // already mapped
  let info = {};
  try { info = await API.projectInfo(node.cwd); } catch {}
  // a saved .coco-domain wins — expose it automatically, no prompt
  if (info.saved && info.saved.domain) {
    const entry = addDomain(fullDomain(info.saved.domain), info.saved.port || port, node.id, true);
    domainUp.set(entry.id, true);
    if (state.proxyOn) { pushProxyMap(); notifyDomain(entry); } else await enableProxy(true).then(() => { if (state.proxyOn) { pushProxyMap(); notifyDomain(entry); } });
    updateStatus(); return;
  }
  // otherwise: no popup — the bottom-bar button pulses to invite the user to expose
  updateStatus();
}
function notifyDomain(entry) {
  flashToast(`${entry.domain} → :${entry.port} is live`);
}

// small bottom-right popup to expose a detected dev server
function closeDomainPopup() { const p = document.getElementById('domain-popup'); if (p) p.remove(); }
async function showDomainPopup({ node, base, port }) {
  closeDomainPopup();
  const tld = domainTld();
  if (!base) { try { const info = await API.projectInfo(node.cwd); base = info.name; } catch {} }
  base = base || (node.cwd ? basename(node.cwd) : 'app');
  let name = slugBase(base);
  let n = 2; while (state.domains.some((d) => d.domain === name + tld)) name = slugBase(base) + (n++);
  const pop = document.createElement('div'); pop.id = 'domain-popup'; pop.className = 'corner-pop';
  pop.innerHTML = `
    <div class="cp-head"><span class="cp-port">:${port}</span><span class="cp-title">Expose dev server</span><button class="cp-x" id="cp-x" title="Dismiss">${ic('x', { size: 14 })}</button></div>
    <div class="cp-body">
      <div class="cp-route">
        <input id="cp-name" class="cp-name" type="text" value="${escapeHtml(name)}" spellcheck="false" autocomplete="off"/><span class="cp-tld">${escapeHtml(tld)}</span><span class="cp-arrow">→</span><span class="cp-pre">:</span><input id="cp-portin" class="cp-portin" type="text" value="${port}"/>
      </div>
      <div class="cp-url" id="cp-url"></div>
      <label class="cp-check"><input type="checkbox" id="cp-save" checked/><span>Remember for this project <code>.coco-domain</code></span></label>
    </div>
    <div class="cp-actions"><button class="cp-dismiss" id="cp-cancel">Not now</button><button class="btn-accent" id="cp-ok">Expose</button></div>`;
  document.body.appendChild(pop);
  requestAnimationFrame(() => pop.classList.add('show'));
  const nameI = pop.querySelector('#cp-name');
  const urlEl = pop.querySelector('#cp-url');
  const preview = () => { urlEl.textContent = domainUrl(fullDomain(nameI.value.trim() || name)); };
  nameI.oninput = preview; preview();
  setTimeout(() => { nameI.focus(); nameI.select(); }, 30);
  const close = () => closeDomainPopup();
  pop.querySelector('#cp-x').onclick = pop.querySelector('#cp-cancel').onclick = close;
  const submit = async () => {
    const nm = nameI.value.trim() || name;
    const p = parseInt(pop.querySelector('#cp-portin').value, 10) || port;
    const save = pop.querySelector('#cp-save').checked;
    const domain = fullDomain(nm);
    close();
    const entry = addDomain(domain, p, node.id, true);
    domainUp.set(entry.id, true); // just detected listening — show in the bar right away
    if (save) API.saveProjectDomain({ cwd: node.cwd, data: { domain: nm, port: p } });
    if (!state.proxyOn) await enableProxy(true);
    if (state.proxyOn) { pushProxyMap(); notifyDomain(entry); }
    updateStatus();
  };
  pop.querySelector('#cp-ok').onclick = submit;
  pop.onkeydown = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(); };
}

async function enableProxy(silent) {
  // if the background proxy is already running, don't ask for the password again
  try { const st = await API.proxyStatus(); if (st && st.running) { state.proxyOn = true; pushProxyMap(); updateStatus(); return true; } } catch {}
  const res = await API.proxyEnable(proxyPort());
  if (res.ok) { state.proxyOn = true; pushProxyMap(); updateStatus(); }
  else if (res.error && res.error !== 'cancelled') confirmModal({ title: 'Could not start proxy', message: res.error, okLabel: 'OK', onOk: () => {} });
  return state.proxyOn;
}
async function disableProxy() { await API.proxyDisable(); state.proxyOn = false; updateStatus(); }

function openDomains() {
  const overlay = document.createElement('div'); overlay.className = 'modal';
  const render = () => {
    const status = state.proxyOn ? `<span style="color:var(--accent2)">● running on :80</span>` : `<span style="color:var(--dim)">○ proxy off</span>`;
    const rows = state.domains.length ? state.domains.map((d) => `
      <div class="lm-row">
        <span class="lm-ic">${ic('globe', { size: 15 })}</span>
        <span class="lm-info"><b><a href="#" data-open="${d.id}" style="color:var(--text)">${escapeHtml(d.domain)}</a></b><br><span>→ 127.0.0.1:${d.port}</span></span>
        <button class="row-btn" data-edit="${d.id}" title="Rename domain">${ic('pencil', { size: 13 })}</button>
        <button class="row-btn" data-del="${d.id}">${ic('trash-2', { size: 13 })}</button>
      </div>`).join('') : '<div class="tree-empty" style="padding:16px;">No domains yet. Run a dev server (npm run dev) and coco will map it automatically.</div>';
    overlay.querySelector('#dm-list').innerHTML = rows;
    overlay.querySelector('#dm-status').innerHTML = status;
    const tg = overlay.querySelector('#dm-toggle');
    tg.textContent = state.proxyOn ? 'Stop proxy' : 'Enable (admin once)';
    tg.className = state.proxyOn ? 'btn-ghost' : 'btn-accent';
    overlay.querySelectorAll('[data-open]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); const d = state.domains.find((x) => x.id === a.dataset.open); API.openExternal(domainUrl(d.domain)); }; });
    overlay.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => { const d = state.domains.find((x) => x.id === b.dataset.edit); promptModal('Rename domain', 'Full domain', d.domain, (v) => { if (v) { d.domain = fullDomain(v); persist(); pushProxyMap(); render(); } }); }; });
    overlay.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { state.domains = state.domains.filter((x) => x.id !== b.dataset.del); persist(); pushProxyMap(); render(); updateStatus(); }; });
  };
  overlay.innerHTML = `<div class="modal-card" style="width:560px;">
    <div class="modal-head"><span>Local Domains &nbsp; <span id="dm-status" style="font-size:11px;font-family:var(--font-mono)"></span></span><button class="modal-close" id="dm-x">${ic('x', { size: 16 })}</button></div>
    <div id="dm-list" style="padding:8px 14px;max-height:46vh;overflow:auto;"></div>
    <div class="modal-actions" style="padding:0 18px 16px;">
      <span style="flex:1;font-size:11px;color:var(--dim)">Adding or removing apps never needs a password — only starting the proxy does (once).</span>
      <button class="btn-ghost" id="dm-add">${ic('plus', { size: 14 })} Add</button>
      <button class="btn-accent" id="dm-toggle"></button>
    </div></div>`;
  document.body.appendChild(overlay);
  API.proxyStatus().then((s) => { state.proxyOn = !!s.running; render(); });
  render();
  overlay.querySelector('#dm-x').onclick = () => overlay.remove();
  overlay.querySelector('#dm-toggle').onclick = async () => {
    if (state.proxyOn) {
      confirmModal({ title: 'Stop the local-domain proxy?', message: 'This stops the background proxy and frees port 80 — you’ll need your admin password again to restart it. To simply un-expose an app, just delete its domain above (no password needed).', okLabel: 'Stop proxy', danger: true, onOk: async () => { await disableProxy(); render(); } });
    } else { await enableProxy(); render(); }
  };
  overlay.querySelector('#dm-add').onclick = () => {
    promptModal('Add domain', 'name (→ name.localhost)', '', (name) => {
      if (!name) return;
      promptModal('Port', 'local port', '3000', (port) => {
        if (!port) return;
        addDomain(fullDomain(name), parseInt(port, 10), null, false);
        pushProxyMap(); render();
      });
    });
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// ---------------- keyboard shortcuts editor ----------------
function accelLabel(acc) {
  if (!acc) return '—';
  const macMap = { CmdOrCtrl: '⌘', Cmd: '⌘', Command: '⌘', Ctrl: '⌃', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Plus: '+', Return: '⏎', Enter: '⏎', Tab: '⇥', Space: '␣', Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: '⌫', Escape: '⎋' };
  const desktopMap = { CmdOrCtrl: 'Ctrl', Cmd: 'Ctrl', Command: 'Ctrl', Control: 'Ctrl', Option: 'Alt', Return: 'Enter', Plus: '+', Up: '↑', Down: '↓', Left: '←', Right: '→' };
  const map = OS.platform === 'darwin' ? macMap : desktopMap;
  return acc.split('+').map((p) => map[p] || p).join(OS.platform === 'darwin' ? ' ' : '+');
}
function accelFromEvent(e) {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;
  const parts = [];
  if (e.metaKey) parts.push('CmdOrCtrl');
  if (e.ctrlKey && !e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  const map = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', '+': 'Plus', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete' };
  if (map[key]) key = map[key];
  else if (key.length === 1) key = key.toUpperCase();
  else if (!/^F\d+$/.test(key)) return null;
  return parts.concat(key).join('+');
}
function canonicalAccelerator(accelerator) {
  const primary = OS.platform === 'darwin' ? 'Cmd' : 'Ctrl';
  return String(accelerator || '')
    .replace(/CmdOrCtrl|Command|Cmd/g, primary)
    .replace(/Control/g, 'Ctrl')
    .replace(/Option/g, 'Alt');
}
async function openShortcuts() {
  const commands = await API.getCommands();
  await API.captureShortcuts(true);
  const binds = () => (state.settings.keybindings = state.settings.keybindings || {});
  const effective = (c) => { const b = binds(); return b[c.id] !== undefined ? b[c.id] : c.accel; };
  let recordingId = null;

  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `
    <div class="modal-card" style="width:580px;max-height:80vh;">
      <div class="modal-head"><span>Keyboard Shortcuts</span><button class="modal-close" id="sc-x">${ic('x', { size: 16 })}</button></div>
      <div id="sc-list" style="padding:6px 14px 4px;overflow:auto;"></div>
      <div class="modal-actions" style="padding:8px 18px 14px;">
        <span style="flex:1;font-size:11px;color:var(--dim);">Click a shortcut, then press keys · Backspace clears · Esc cancels</span>
        <button class="btn-ghost" id="sc-reset">Reset all</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  function render() {
    const groups = {};
    commands.forEach((c) => { (groups[c.group] = groups[c.group] || []).push(c); });
    overlay.querySelector('#sc-list').innerHTML = Object.keys(groups).map((g) =>
      `<div class="sc-group">${escapeHtml(g)}</div>` + groups[g].map((c) => {
        const isRec = recordingId === c.id;
        const current = canonicalAccelerator(effective(c));
        const dup = !isRec && !!current && commands.some((o) => o.id !== c.id && canonicalAccelerator(effective(o)) === current);
        return `<div class="sc-row">
          <span class="sc-label">${escapeHtml(c.label)}</span>
          <button class="sc-key${isRec ? ' recording' : ''}${dup ? ' conflict' : ''}" data-rec="${c.id}" title="${dup ? 'Conflicts with another shortcut' : ''}">${isRec ? 'Press keys…' : accelLabel(effective(c))}</button>
          <button class="row-btn" data-reset="${c.id}" title="Reset to default">${ic('rotate-cw', { size: 13 })}</button>
        </div>`;
      }).join('')).join('');
    overlay.querySelectorAll('[data-rec]').forEach((b) => { b.onclick = () => { recordingId = b.dataset.rec; render(); }; });
    overlay.querySelectorAll('[data-reset]').forEach((b) => { b.onclick = () => { delete binds()[b.dataset.reset]; persist(); render(); }; });
  }

  const onKey = (e) => {
    if (!recordingId) return;
    e.preventDefault(); e.stopPropagation();
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
    if (e.key === 'Escape') { recordingId = null; render(); return; }
    if (e.key === 'Backspace') { binds()[recordingId] = ''; recordingId = null; persist(); render(); return; }
    const acc = accelFromEvent(e);
    if (!acc) return;
    binds()[recordingId] = acc; recordingId = null; persist(); render();
  };
  document.addEventListener('keydown', onKey, true);

  const close = async () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    await API.captureShortcuts(false); // rebuild menu from saved bindings
    focusActive();
  };
  overlay.querySelector('#sc-x').onclick = close;
  overlay.querySelector('#sc-reset').onclick = () => { state.settings.keybindings = {}; persist(); render(); };
  overlay.onclick = (e) => { if (e.target === overlay && !recordingId) close(); };
  render();
}

// ---------------- routine commands ----------------
function findCmd(id, nodes = state.commands, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parent, list: nodes, index: i };
    if (n.type === 'cmd-folder') { const r = findCmd(id, n.children, n); if (r) return r; }
  }
  return null;
}
function eachCommand(fn, nodes = state.commands) {
  for (const n of nodes) { if (n.type === 'command') fn(n); else if (n.type === 'cmd-folder') eachCommand(fn, n.children); }
}
async function runCommand(node) {
  if (!node || node.type !== 'command') return;
  const cmd = await expandCommand(node.command);
  if (cmd == null) return;
  if (!activeId || !live.has(activeId)) { newTerminal({}); setTimeout(() => activeId && API.input(activeId, cmd + '\r'), 600); return; }
  API.input(activeId, cmd + '\r');
  focusActive();
}
async function pasteCommandText(node) {
  if (!node || node.type !== 'command' || !activeId) return;
  const cmd = await expandCommand(node.command);
  if (cmd != null) { API.input(activeId, cmd); focusActive(); }
}
async function runCommandInSplit(node) {
  if (node.type !== 'command') return;
  const cmd = await expandCommand(node.command);
  if (cmd == null) return;
  splitFocused('row');
  const target = activeId;
  setTimeout(() => { if (target && live.has(target)) API.input(target, cmd + '\r'); }, 550);
}

// drag to reorder commands / drop into a category
let dragCmdId = null, cmdDropTarget = null;
function clearCmdDrops() {
  document.querySelectorAll('.cmd-drop-before,.cmd-drop-after,.cmd-drop-inside').forEach((el) => el.classList.remove('cmd-drop-before', 'cmd-drop-after', 'cmd-drop-inside'));
  cmdDropTarget = null;
}
function moveCmd(dragId, refId, mode) {
  if (dragId === refId) return;
  const src = findCmd(dragId);
  if (!src) return;
  if (src.node.type === 'cmd-folder' && refId) { if (findCmd(refId, [src.node])) return; } // no folder into itself
  src.list.splice(src.index, 1);
  if (mode === 'root' || refId === null) state.commands.push(src.node);
  else if (mode === 'inside') {
    const t = findCmd(refId);
    if (t && t.node.type === 'cmd-folder') { t.node.children.push(src.node); t.node.expanded = true; }
    else state.commands.push(src.node);
  } else {
    const ref = findCmd(refId);
    if (!ref) state.commands.push(src.node);
    else { const idx = ref.list.indexOf(ref.node); ref.list.splice(mode === 'before' ? idx : idx + 1, 0, src.node); }
  }
  persist(); refreshCommandsUI();
}
function cmdFolderOptions() {
  const opts = [{ value: '', label: '— Top level —' }];
  state.commands.forEach((n) => { if (n.type === 'cmd-folder') opts.push({ value: n.id, label: n.name }); });
  return opts;
}
function placeCmd(node, folderId) {
  if (folderId) { const t = findCmd(folderId); if (t && t.node.type === 'cmd-folder') { t.node.children.push(node); return; } }
  state.commands.push(node);
}
function addCommandNode(folderId) {
  formModal({
    title: 'New Command', submitLabel: 'Save',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'e.g. Deploy' },
      { key: 'command', label: 'Command', type: 'textarea', placeholder: 'npm run deploy' },
      { key: 'folder', label: 'Category', type: 'select', value: folderId || '', options: cmdFolderOptions() },
    ],
    onSubmit: (v) => { if (!v.command) return; const node = { id: uid('cmd'), type: 'command', name: v.name || v.command, command: v.command }; placeCmd(node, v.folder); persist(); refreshCommandsUI(); },
  });
}
function editCommandNode(id) {
  const r = findCmd(id); if (!r || r.node.type !== 'command') return;
  formModal({
    title: 'Edit Command', submitLabel: 'Save',
    fields: [
      { key: 'name', label: 'Name', value: r.node.name },
      { key: 'command', label: 'Command', type: 'textarea', value: r.node.command },
      { key: 'folder', label: 'Category', type: 'select', value: r.parent ? r.parent.id : '', options: cmdFolderOptions() },
    ],
    onSubmit: (v) => {
      if (!v.command) return;
      r.node.name = v.name || v.command; r.node.command = v.command;
      const cur = r.parent ? r.parent.id : '';
      if ((v.folder || '') !== cur) { r.list.splice(r.index, 1); placeCmd(r.node, v.folder); }
      persist(); refreshCommandsUI();
    },
  });
}
function addCmdFolder() {
  promptModal('New Category', 'Category name', '', (name) => { if (!name) return; state.commands.push({ id: uid('cmdf'), type: 'cmd-folder', name, expanded: true, children: [] }); persist(); refreshCommandsUI(); });
}
function deleteCmdNode(id) { const r = findCmd(id); if (!r) return; r.list.splice(r.index, 1); persist(); refreshCommandsUI(); }
function refreshCommandsUI() {
  const list = document.getElementById('cmd-pop-list'); if (list) renderCommandsPopover(list);
  const manager = document.querySelector('.commands-manager-list');
  if (manager) {
    const search = manager.closest('.commands-manager-card')?.querySelector('.commands-manager-search input');
    renderCommandsManagerList(manager, search ? search.value : '');
  }
}

function openCommandsPanel(anchor) {
  closeCommandsPanel();
  const pop = document.createElement('div');
  pop.id = 'cmd-popover'; pop.className = 'popover';
  pop.innerHTML = `
    <div class="pop-head">
      <span class="pop-title">${ic('zap', { size: 13 })} Routine Commands</span>
      <span style="flex:1"></span>
      <button class="pop-manage" id="cmd-manage">${ic('settings-2', { size: 13 })}<span>Manage</span></button>
    </div>
    <div class="pop-list" id="cmd-pop-list"></div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const listEl = pop.querySelector('#cmd-pop-list');
  renderCommandsPopover(listEl);
  // The Commands control may live in either the title bar or the dock footer.
  // Measure the populated panel, then choose the side with enough room and
  // clamp it fully inside the window.
  const gap = 7;
  const margin = 9;
  const popRect = pop.getBoundingClientRect();
  const roomBelow = window.innerHeight - r.bottom - margin;
  const openAbove = roomBelow < popRect.height + gap && r.top > roomBelow;
  const top = openAbove ? r.top - popRect.height - gap : r.bottom + gap;
  pop.style.top = Math.max(margin, Math.min(top, window.innerHeight - popRect.height - margin)) + 'px';
  pop.style.left = Math.max(margin, Math.min(r.left, window.innerWidth - popRect.width - margin)) + 'px';
  pop.style.right = 'auto';
  listEl.addEventListener('dragover', (e) => { if (dragCmdId) e.preventDefault(); });
  listEl.addEventListener('drop', (e) => { if (dragCmdId && e.target === listEl) { e.preventDefault(); const did = dragCmdId; clearCmdDrops(); moveCmd(did, null, 'root'); } });
  pop.querySelector('#cmd-manage').onclick = () => { closeCommandsPanel(); openCommandsManager(); };
  setTimeout(() => window.addEventListener('mousedown', cmdPopOutside), 0);
}
function cmdPopOutside(e) {
  const p = document.getElementById('cmd-popover');
  const btn = document.getElementById('btn-commands');
  if (p && !p.contains(e.target) && !(btn && btn.contains(e.target)) && !e.target.closest('.modal')) closeCommandsPanel();
}
function closeCommandsPanel() { const p = document.getElementById('cmd-popover'); if (p) { p.remove(); window.removeEventListener('mousedown', cmdPopOutside); } }
function renderCommandsPopover(listEl) {
  listEl.innerHTML = '';
  if (state.commands.length === 0) { listEl.innerHTML = '<div class="tree-empty" style="padding:14px;">No commands yet. Use the add button to create one.</div>'; return; }
  state.commands.forEach((n) => listEl.appendChild(cmdRow(n)));
}
function commandSearchText(node) {
  return node.type === 'command'
    ? `${node.name} ${node.command}`.toLowerCase()
    : `${node.name} ${(node.children || []).map(commandSearchText).join(' ')}`.toLowerCase();
}
function renderCommandsManagerList(container, query = '') {
  container.innerHTML = '';
  const q = query.trim().toLowerCase();
  const nodes = q ? state.commands.filter((node) => commandSearchText(node).includes(q)) : state.commands;
  if (!nodes.length) { container.innerHTML = '<div class="commands-manager-empty">No commands match this search.</div>'; return; }
  nodes.forEach((node) => container.appendChild(cmdRow(node, true)));
}
function openCommandsManager() {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `<div class="modal-card commands-manager-card">
    <div class="modal-head"><span>Manage Commands</span><button class="modal-close" id="commands-manager-x">${ic('x', { size: 16 })}</button></div>
    <div class="commands-manager-toolbar">
      <label class="commands-manager-search">${ic('search', { size: 14 })}<input type="text" placeholder="Search commands…" spellcheck="false"></label>
      <button class="btn-ghost" id="commands-manager-folder">${ic('folder-plus', { size: 14 })} New category</button>
      <button class="btn-accent" id="commands-manager-add">${ic('plus', { size: 14 })} New command</button>
    </div>
    <div class="commands-manager-hint">Drag commands to reorder them or place them inside categories.</div>
    <div class="commands-manager-list"></div>
  </div>`;
  document.body.appendChild(overlay);
  const list = overlay.querySelector('.commands-manager-list');
  const search = overlay.querySelector('.commands-manager-search input');
  const render = () => renderCommandsManagerList(list, search.value);
  render();
  list.addEventListener('dragover', (event) => { if (dragCmdId) event.preventDefault(); });
  list.addEventListener('drop', (event) => {
    if (dragCmdId && event.target === list) { event.preventDefault(); const id = dragCmdId; clearCmdDrops(); moveCmd(id, null, 'root'); render(); }
  });
  search.oninput = render;
  overlay.querySelector('#commands-manager-add').onclick = () => addCommandNode();
  overlay.querySelector('#commands-manager-folder').onclick = () => addCmdFolder();
  const close = () => overlay.remove();
  overlay.querySelector('#commands-manager-x').onclick = close;
  overlay.onclick = (event) => { if (event.target === overlay) close(); };
  setTimeout(() => search.focus(), 20);
}
function onCmdDragOver(e, node, row) {
  if (!dragCmdId || dragCmdId === node.id) return;
  e.preventDefault(); e.stopPropagation();
  const rect = row.getBoundingClientRect();
  const rel = (e.clientY - rect.top) / rect.height;
  row.classList.remove('cmd-drop-before', 'cmd-drop-after', 'cmd-drop-inside');
  let mode;
  if (node.type === 'cmd-folder') mode = rel < 0.28 ? 'before' : rel > 0.72 ? 'after' : 'inside';
  else mode = rel < 0.5 ? 'before' : 'after';
  row.classList.add('cmd-drop-' + mode);
  cmdDropTarget = { id: node.id, mode };
}
function cmdRow(node, manager = false) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'cmd-row';
  row.draggable = true;
  row.ondragstart = (e) => { e.stopPropagation(); dragCmdId = node.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', node.id); };
  row.ondragend = () => { dragCmdId = null; clearCmdDrops(); };
  row.addEventListener('dragover', (e) => onCmdDragOver(e, node, row));
  row.addEventListener('dragleave', () => row.classList.remove('cmd-drop-before', 'cmd-drop-after', 'cmd-drop-inside'));
  row.addEventListener('drop', (e) => { if (!dragCmdId) return; e.preventDefault(); e.stopPropagation(); const dt = cmdDropTarget || { id: node.id, mode: 'after' }; const did = dragCmdId; clearCmdDrops(); moveCmd(did, dt.id, dt.mode); });
  if (node.type === 'cmd-folder') {
    const tw = document.createElement('span'); tw.className = 'twirl'; tw.innerHTML = ic(node.expanded ? 'chevron-down' : 'chevron-right', { size: 13 }); row.appendChild(tw);
    const icn = document.createElement('span'); icn.className = 'cmd-ic'; icn.innerHTML = ic('folder', { size: 14 }); row.appendChild(icn);
    const lab = document.createElement('span'); lab.className = 'cmd-label'; lab.textContent = node.name; row.appendChild(lab);
    const act = document.createElement('span'); act.className = 'cmd-actions';
    if (manager) {
      act.appendChild(cmdActBtn('plus', 'Add command here', (e) => { e.stopPropagation(); addCommandNode(node.id); }));
      act.appendChild(cmdActBtn('pencil', 'Rename', (e) => { e.stopPropagation(); promptModal('Rename Category', 'Name', node.name, (v) => { if (v) { node.name = v; persist(); refreshCommandsUI(); } }); }));
      act.appendChild(cmdActBtn('trash-2', 'Delete', (e) => { e.stopPropagation(); deleteCmdNode(node.id); }));
    }
    row.appendChild(act);
    row.onclick = () => { node.expanded = !node.expanded; persist(); refreshCommandsUI(); };
    wrap.appendChild(row);
    if (node.expanded) {
      const kids = document.createElement('div'); kids.className = 'cmd-children';
      if (node.children.length === 0) kids.innerHTML = '<div class="tree-empty">empty</div>';
      else node.children.forEach((c) => kids.appendChild(cmdRow(c, manager)));
      wrap.appendChild(kids);
    }
  } else {
    const icn = document.createElement('span'); icn.className = 'cmd-ic'; icn.innerHTML = ic('chevron-right', { size: 13 }); row.appendChild(icn);
    const lab = document.createElement('span'); lab.className = 'cmd-label';
    lab.innerHTML = `${escapeHtml(node.name)}<span class="cmd-preview">${escapeHtml(node.command)}</span>`;
    row.appendChild(lab);
    const act = document.createElement('span'); act.className = 'cmd-actions';
    act.appendChild(cmdActBtn('play', 'Run in new split', (e) => { e.stopPropagation(); runCommandInSplit(node); closeCommandsPanel(); }));
    act.appendChild(cmdActBtn('clipboard-paste', 'Insert (don’t run)', (e) => { e.stopPropagation(); pasteCommandText(node); closeCommandsPanel(); }));
    if (manager) {
      act.appendChild(cmdActBtn('pencil', 'Edit', (e) => { e.stopPropagation(); editCommandNode(node.id); }));
      act.appendChild(cmdActBtn('trash-2', 'Delete', (e) => { e.stopPropagation(); deleteCmdNode(node.id); }));
    }
    row.appendChild(act);
    row.onclick = () => {
      if (manager) editCommandNode(node.id);
      else { runCommand(node); closeCommandsPanel(); }
    };
    wrap.appendChild(row);
  }
  return wrap;
}
function cmdActBtn(iconName, title, onClick) { const b = document.createElement('button'); b.className = 'row-btn'; b.title = title; b.innerHTML = ic(iconName, { size: 13 }); b.onclick = onClick; return b; }

// ---------------- nested context menu (supports submenus) ----------------
const openMenus = [];
function closeMenusFrom(d) {
  while (openMenus.length > d) {
    const m = openMenus.pop();
    if (m && m.classList.contains('workspace-menu')) {
      const anchor = document.getElementById('workspace-switcher');
      if (anchor) {
        anchor.classList.remove('menu-open');
        anchor.setAttribute('aria-expanded', 'false');
      }
    }
    if (m && m.parentElement) m.remove();
  }
}
function closeAllMenus() { closeMenusFrom(0); }
function showMenu(x, y, items, depth = 0) {
  closeMenusFrom(depth);
  const menu = document.createElement('div'); menu.className = 'ctx-menu';
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); return; }
    const el = document.createElement('div'); el.className = 'ctx-item' + (it.danger ? ' danger' : '');
    const right = it.submenu ? `<span class="ctx-arrow">${ic('chevron-right', { size: 13 })}</span>` : (it.hint ? `<span class="ctx-hint">${escapeHtml(it.hint)}</span>` : '');
    el.innerHTML = `<span class="ci-ic"${it.iconColor ? ` style="color:${it.iconColor}"` : ''}>${ic(it.icon || 'hash', { size: 15 })}</span><span style="flex:1">${escapeHtml(it.label)}</span>${right}`;
    if (it.submenu && it.submenu.length) {
      el.onmouseenter = () => { const r = el.getBoundingClientRect(); showMenu(r.right - 4, r.top - 6, it.submenu, depth + 1); };
      el.onclick = (e) => e.stopPropagation();
    } else {
      el.onmouseenter = () => closeMenusFrom(depth + 1);
      el.onclick = (e) => { e.stopPropagation(); closeAllMenus(); if (it.run) it.run(); };
    }
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  const mw = menu.offsetWidth || 220, mh = menu.offsetHeight || 300;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(Math.max(8, y), window.innerHeight - mh - 8) + 'px';
  openMenus[depth] = menu;
  return menu;
}
function commandsToMenu(nodes) {
  return nodes.map((n) => n.type === 'cmd-folder'
    ? { icon: 'folder', label: n.name, submenu: n.children.length ? commandsToMenu(n.children) : [{ icon: 'hash', label: '(empty)' }] }
    : { icon: 'chevron-right', label: n.name, run: () => runCommand(n) });
}
function openTerminalMenu(e) {
  e.preventDefault(); e.stopPropagation();
  closeContextMenu();
  const items = [
    { icon: 'copy', label: 'Copy', run: () => { const t = live.get(activeId); const sel = t ? t.term.getSelection() : ''; if (sel) API.clipboardWrite(sel); } },
    { icon: 'clipboard-paste', label: 'Paste', run: async () => { const txt = await API.clipboardRead(); if (txt && activeId) API.input(activeId, txt); focusActive(); } },
  ];
  if (state.settings.commandsEnabled !== false) {
    items.push({ sep: true });
    items.push({ icon: 'zap', label: 'Routine Commands', submenu: state.commands.length ? commandsToMenu(state.commands) : [{ icon: 'hash', label: 'No commands — add some', run: () => openCommandsPanel(document.getElementById('btn-commands')) }] });
  }
  items.push(
    { sep: true },
    { icon: 'square-terminal', label: 'Split Right', run: () => splitFocused('row') },
    { icon: 'square-terminal', label: 'Split Down', run: () => splitFocused('col') },
    ...(layoutLeafIds().length > 1 ? [{ icon: 'panel-left', label: 'Exit Split View', run: () => activeId && exitSplitView(activeId) }] : []),
    { icon: 'x', label: 'Close Terminal', run: () => activeId && closeTerminal(activeId) },
  );
  if (state.settings.commandsEnabled !== false) {
    items.push({ sep: true });
    items.push({ icon: 'settings-2', label: 'Manage Commands…', run: () => openCommandsManager() });
  }
  showMenu(e.clientX, e.clientY, items);
}
function closeTermSilent(id) {
  const e = live.get(id);
  if (!e) return;
  API.kill(id); try { e.term.dispose(); } catch {} e.pane.remove(); live.delete(id);
  if (activeId === id) activeId = null;
}

function renameNode(id) {
  const r = findNode(id);
  if (!r) return;
  startInlineRename(id);
}

// ---------------- tree rendering ----------------
function matchesFilter(node) {
  if (!state.filter) return true;
  const f = state.filter.toLowerCase();
  if (node.type === 'session') return node.name.toLowerCase().includes(f) || (node.cwd || '').toLowerCase().includes(f);
  return node.children.some(matchesFilter) || node.name.toLowerCase().includes(f);
}

function renderTree() {
  const root = document.getElementById('session-tree');
  root.innerHTML = '';
  const visible = state.tree.filter(matchesFilter);
  if (state.tree.length === 0) {
    root.appendChild(emptyHint(`No sessions yet. Press ${accelLabel('CmdOrCtrl+T')} to open a terminal.`));
  } else if (visible.length === 0) {
    root.appendChild(emptyHint('No matches.'));
  } else {
    visible.forEach((n) => root.appendChild(renderNode(n)));
  }
  // root drop zone (append to end of top level)
  root.ondragover = (e) => { e.preventDefault(); };
  root.ondrop = (e) => {
    if (e.target !== root) return;
    e.preventDefault();
    const id = dragId; clearDropMarks();
    if (id) moveNode(id, null, 'root');
  };
  renderTopbar();
  updateFolderToggle();
}

function setAllFoldersExpanded(expanded, nodes = state.tree) {
  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    node.expanded = expanded;
    setAllFoldersExpanded(expanded, node.children);
  }
}
function hasExpandedFolder(nodes = state.tree) {
  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    if (node.expanded || hasExpandedFolder(node.children)) return true;
  }
  return false;
}
function updateFolderToggle() {
  const button = document.getElementById('dock-collapse-all');
  if (!button) return;
  const collapse = hasExpandedFolder();
  const label = collapse ? 'Collapse all folders' : 'Expand all folders';
  button.innerHTML = `<span class="folder-toggle-icon ${collapse ? 'collapse' : 'expand'}">${ic('chevrons-down-up', { size: 15 })}</span>`;
  button.classList.toggle('will-collapse', collapse);
  button.classList.toggle('will-expand', !collapse);
  button.title = label;
  button.setAttribute('aria-label', label);
}
function toggleAllFolders() {
  const expand = !hasExpandedFolder();
  setAllFoldersExpanded(expand);
  if (!expand) state.selectedFolderId = null;
  persist();
  renderTree();
}

function openNewTerminalMenu(button) {
  const hosts = [];
  eachSession((node) => { if (node.type === 'host') hosts.push(node); });
  const items = hosts.map((host) => ({
    icon: host.sftp ? 'folder-key' : 'server',
    label: `${host.name} · ${host.sftp ? 'SFTP' : 'SSH'}`,
    hint: `${host.user ? `${host.user}@` : ''}${host.host}`,
    run: () => { if (host.sftp) openSftpBrowser(host); else openTerminal(host); },
  }));
  if (items.length) items.push({ sep: true });
  items.push({ icon: 'server', label: 'Add SSH Session…', run: () => newHost(undefined, 'ssh') });
  items.push({ icon: 'folder-key', label: 'Add SFTP Session…', run: () => newHost(undefined, 'sftp') });
  items.push({ icon: 'settings-2', label: 'Manage Remote Sessions…', run: () => openHosts() });
  const rect = button.getBoundingClientRect();
  const menu = showMenu(rect.left, rect.bottom + 5, items);
  menu.classList.add('remote-session-menu');
}

function emptyHint(text) {
  const e = document.createElement('div');
  e.className = 'tree-empty'; e.textContent = text; return e;
}

function renderNode(node) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.id = node.id;
  row.draggable = true;
  row.ondragstart = (e) => { e.stopPropagation(); dragId = node.id; row.classList.add('dragging'); e.dataTransfer.setData('text/plain', node.id); e.dataTransfer.effectAllowed = 'move'; };
  row.ondragend = () => { dragId = null; row.classList.remove('dragging'); clearDropMarks(); clearPaneDropZones(); };
  row.ondragover = (e) => onRowDragOver(e, node, row);
  row.ondragleave = () => row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  row.ondrop = (e) => onRowDrop(e, node, row);
  row.oncontextmenu = (e) => { e.preventDefault(); openContextMenu(e, node); };

  if (node.type === 'folder') {
    row.classList.add('folder-row');
    if (state.selectedFolderId === node.id) row.classList.add('selected');
    if (node.color) row.style.setProperty('--row-accent', node.color);
    const tw = document.createElement('span');
    tw.className = 'twirl';
    tw.innerHTML = ic(node.expanded ? 'chevron-down' : 'chevron-right', { size: 12 });
    tw.onclick = (e) => { e.stopPropagation(); node.expanded = !node.expanded; persist(); renderTree(); };
    row.appendChild(tw);

    const icn = document.createElement('span');
    icn.className = 'tree-ic';
    icn.innerHTML = ic(node.expanded ? 'folder-open-dot' : 'folder-closed', { size: 15 });
    if (node.color) icn.style.color = node.color;
    row.appendChild(icn);

    row.appendChild(makeLabel(node));

    const count = countSessions(node);
    if (count) { const c = document.createElement('span'); c.className = 'tree-count'; c.textContent = count; row.appendChild(c); }

    row.appendChild(rowActions(node));
    row.onclick = () => {
      if (!node.expanded) node.expanded = true;
      state.selectedFolderId = state.selectedFolderId === node.id ? null : node.id;
      persist(); renderTree();
    };
    wrap.appendChild(row);

    if (node.expanded || state.filter) {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      const vis = node.children.filter(matchesFilter);
      if (vis.length === 0) kids.appendChild(emptyHint('empty'));
      else vis.forEach((c) => kids.appendChild(renderNode(c)));
      wrap.appendChild(kids);
    }
  } else {
    const isHost = node.type === 'host';
    const isLive = live.has(node.id);
    const e = live.get(node.id);
    if (node.id === activeId) row.classList.add('active');
    if (node.color) row.style.setProperty('--row-accent', node.color);
    if (isHost) row.title = (node.user ? node.user + '@' : '') + node.host + (node.port && String(node.port) !== '22' ? ':' + node.port : '');

    const dot = document.createElement('span');
    dot.className = 'status-dot ' + (e && e.dead ? 'dead' : e && e.claudeState ? `claude-${e.claudeState}` : isLive ? 'live' : 'idle');
    if (node.color && !(e && e.claudeState)) dot.style.background = node.color;
    row.appendChild(dot);

    const icn = document.createElement('span');
    icn.className = 'tree-ic';
    icn.innerHTML = ic(isHost ? (node.sftp ? 'folder-key' : 'server') : 'square-terminal', { size: 15 });
    if (node.color) icn.style.color = node.color;
    row.appendChild(icn);

    row.appendChild(makeLabel(node));

    if (e && e.claudeState) {
      const status = document.createElement('span');
      status.className = `claude-status ${e.claudeState}`;
      status.title = `Claude ${e.claudeState}`;
      status.setAttribute('aria-label', `Claude ${e.claudeState}`);
      status.innerHTML = ic('bot', { size: 13 });
      row.appendChild(status);
    }
    row.appendChild(rowActions(node));

    row.onclick = () => openTerminal(node);
    wrap.appendChild(row);
  }
  return wrap;
}

function makeLabel(node) {
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.dataset.id = node.id;
  label.textContent = node.name;
  return label;
}
function countSessions(folder) {
  let n = 0; eachSession(() => n++, folder.children); return n;
}
function rowActions(node) {
  const box = document.createElement('span');
  box.className = 'row-actions';
  if (node.type === 'folder') {
    box.appendChild(actionBtn('plus', 'New terminal here', (e) => { e.stopPropagation(); newTerminal({ folderId: node.id }); }));
    box.appendChild(actionBtn('pencil', 'Rename', (e) => { e.stopPropagation(); renameNode(node.id); }));
  } else if (node.type === 'host') {
    box.appendChild(actionBtn('pencil-line', 'Edit connection', (e) => { e.stopPropagation(); editHost(node.id); }));
  } else {
    box.appendChild(actionBtn('pencil', 'Rename', (e) => { e.stopPropagation(); renameNode(node.id); }));
    if (live.has(node.id)) {
      const close = actionBtn('x', 'Close terminal', (e) => { e.stopPropagation(); closeTerminal(node.id); });
      close.classList.add('close');
      box.appendChild(close);
    }
  }
  if (node.type !== 'session') box.appendChild(actionBtn('trash-2', node.type === 'folder' ? 'Remove folder' : 'Remove saved host', (e) => { e.stopPropagation(); deleteNode(node.id); }));
  return box;
}
function actionBtn(iconName, title, onClick) {
  const b = document.createElement('button');
  b.className = 'row-btn'; b.title = title; b.innerHTML = ic(iconName, { size: 13 }); b.onclick = onClick;
  return b;
}

function startInlineRename(id) {
  const r = findNode(id);
  if (!r) return;
  const labelEl = document.querySelector(`.tree-label[data-id="${id}"]`);
  if (!labelEl) { // fallback to modal
    promptModal('Rename', 'New name', r.node.name, (v) => { if (v && v.trim()) { commitRename(r.node, v.trim()); } });
    return;
  }
  const input = document.createElement('input');
  input.type = 'text'; input.value = r.node.name;
  labelEl.textContent = ''; labelEl.appendChild(input);
  input.focus(); input.select();
  const done = (commit) => {
    const v = input.value.trim();
    if (commit && v) commitRename(r.node, v);
    else renderTree();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
    e.stopPropagation();
  };
  input.onblur = () => done(true);
  input.onclick = (e) => e.stopPropagation();
}
function commitRename(node, name) {
  node.name = name;
  if (node.type === 'session') node.manualName = true;
  persist(); renderTree(); updateTitle();
}

// ---------------- drag & drop ----------------
let dragId = null;
let dropTarget = null; // { id, mode }
function clearDropMarks() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-inside')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  dropTarget = null;
}
function onRowDragOver(e, node, row) {
  if (!dragId || dragId === node.id) return;
  e.preventDefault(); e.stopPropagation();
  const rect = row.getBoundingClientRect();
  const rel = (e.clientY - rect.top) / rect.height;
  row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  let mode;
  if (node.type === 'folder') {
    if (rel < 0.28) mode = 'before'; else if (rel > 0.72) mode = 'after'; else mode = 'inside';
  } else {
    mode = rel < 0.5 ? 'before' : 'after';
  }
  row.classList.add('drop-' + mode);
  dropTarget = { id: node.id, mode };
}
function onRowDrop(e, node, row) {
  if (!dragId) return;
  e.preventDefault(); e.stopPropagation();
  const dt = dropTarget || { id: node.id, mode: 'after' };
  const id = dragId;
  clearDropMarks();
  moveNode(id, dt.id, dt.mode);
}
function moveNode(id, refId, mode) {
  if (id === refId) return;
  const src = findNode(id);
  if (!src) return;
  // can't drop a folder inside its own subtree
  if (src.node.type === 'folder' && refId) {
    if (findNode(refId, [src.node])) return;
  }
  // remove from current position
  src.list.splice(src.index, 1);

  if (mode === 'root' || refId === null) { state.tree.push(src.node); }
  else if (mode === 'inside') {
    const t = findNode(refId);
    if (t && t.node.type === 'folder') { t.node.children.push(src.node); t.node.expanded = true; }
    else state.tree.push(src.node);
  } else {
    const ref = findNode(refId);
    if (!ref) { state.tree.push(src.node); }
    else {
      const idx = ref.list.indexOf(ref.node);
      ref.list.splice(mode === 'before' ? idx : idx + 1, 0, src.node);
    }
  }
  persist(); renderTree();
}

// ---------------- status bar / title ----------------
function activeCwd() { const r = activeId && findNode(activeId); return r ? r.node.cwd : OS.home; }
function shortCwd(p) {
  if (!p) return '~';
  return p.startsWith(OS.home) ? '~' + p.slice(OS.home.length) : p;
}
function updateStatus() {
  const r = activeId && findNode(activeId);
  const isHost = r && r.node.type === 'host';
  updateGitStatus(state.settings.gitIntegration !== false && r && !isHost ? r.node.cwd : null);
  if (isHost) {
    setHTML('st-shell', ic('plug', { size: 12 }) + `<span>ssh${r.node.port && String(r.node.port) !== '22' ? ':' + escapeHtml(r.node.port) : ''}</span>`);
    setHTML('st-count', ic('square-terminal', { size: 12 }) + `<span>${live.size} open</span>`);
    setHTML('st-theme', ic('palette', { size: 12 }) + `<span>${themeById(state.themeId).name}</span>`);
    updateDomainButton(); // hides any expose state left over from a previous local tab
    return;
  }
  setHTML('st-shell', ic('terminal', { size: 12 }) + `<span>${escapeHtml((process_env_shell()).split('/').pop())}</span>`);
  updateDomainButton();
  setHTML('st-count', ic('square-terminal', { size: 12 }) + `<span>${live.size} open</span>`);
  setHTML('st-theme', ic('palette', { size: 12 }) + `<span>${themeById(state.themeId).name}</span>`);
}

let gitStatusSeq = 0;
let activeGitStatus = null;
const gitStatusCache = new Map();
async function updateGitStatus(cwd, force = false) {
  const btn = document.getElementById('st-git');
  if (!btn) return;
  if (state.settings.gitIntegration === false) {
    activeGitStatus = null;
    btn.classList.add('hidden');
    closeGitPanel();
    return;
  }
  const seq = ++gitStatusSeq;
  if (!cwd) {
    activeGitStatus = null;
    btn.classList.add('hidden');
    closeGitPanel();
    return;
  }
  if (!force) btn.classList.add('checking');
  let result;
  const cached = gitStatusCache.get(cwd);
  if (!force && cached && Date.now() - cached.time < 2500) result = cached.result;
  else {
    try { result = await API.gitStatus(cwd); } catch { result = null; }
    if (gitStatusCache.size >= 100) {
      const oldest = gitStatusCache.keys().next().value;
      if (oldest !== undefined) gitStatusCache.delete(oldest);
    }
    gitStatusCache.set(cwd, { time: Date.now(), result });
  }
  if (seq !== gitStatusSeq) return;
  btn.classList.remove('checking');
  if (!result || !result.ok || !result.repository) {
    activeGitStatus = null;
    btn.classList.add('hidden');
    closeGitPanel();
    return;
  }
  activeGitStatus = result;
  btn.classList.remove('hidden');
  const mark = result.github ? githubMark(12) : ic('git-branch', { size: 12 });
  const delta = [
    result.ahead ? `<span class="git-badge ahead">↑${result.ahead}</span>` : '',
    result.behind ? `<span class="git-badge behind">↓${result.behind}</span>` : '',
    result.changes.length ? `<span class="git-badge dirty">${result.changes.length}</span>` : '',
  ].join('');
  btn.innerHTML = mark + `<span>${escapeHtml(result.branch)}</span>${delta}`;
  btn.title = `${result.branch}${result.upstream ? ` tracking ${result.upstream}` : ' · no upstream'} · ${result.changes.length} changed`;
  if (document.getElementById('git-panel')) renderGitPanel();
}

function gitRemoteWebUrl(remote) {
  const value = String(remote || '').trim();
  if (!value) return '';
  if (/^git@github\.com:/i.test(value)) return `https://github.com/${value.replace(/^git@github\.com:/i, '').replace(/\.git$/, '')}`;
  if (/^https?:\/\/github\.com\//i.test(value)) return value.replace(/\.git$/, '');
  return '';
}

function openGitPanel() {
  if (!activeGitStatus) return;
  if (document.getElementById('git-panel')) { closeGitPanel(); return; }
  const panel = document.createElement('div');
  panel.id = 'git-panel';
  panel.className = 'git-panel';
  document.body.appendChild(panel);
  document.getElementById('st-git').setAttribute('aria-expanded', 'true');
  renderGitPanel();
  const btnRect = document.getElementById('st-git').getBoundingClientRect();
  panel.style.left = `${Math.max(10, Math.min(btnRect.left, window.innerWidth - 430))}px`;
  requestAnimationFrame(() => window.addEventListener('mousedown', gitPanelOutside));
}

function closeGitPanel() {
  const panel = document.getElementById('git-panel');
  if (panel) panel.remove();
  const button = document.getElementById('st-git');
  if (button) button.setAttribute('aria-expanded', 'false');
  window.removeEventListener('mousedown', gitPanelOutside);
}
function gitPanelOutside(event) {
  const panel = document.getElementById('git-panel');
  const button = document.getElementById('st-git');
  if (panel && !panel.contains(event.target) && !button.contains(event.target)) closeGitPanel();
}
function renderGitPanel(message = '') {
  const panel = document.getElementById('git-panel');
  const data = activeGitStatus;
  if (!panel || !data) return;
  const remoteUrl = gitRemoteWebUrl(data.remote);
  const files = data.changes.slice(0, 8).map((file) => `<div class="git-file ${escapeHtml(file.kind || 'modified')}"><span>${escapeHtml(file.code.trim() || 'M')}</span><b>${escapeHtml(file.path)}</b></div>`).join('');
  panel.innerHTML = `
    <div class="git-head">
      <span class="git-head-mark">${data.github ? githubMark(17) : ic('git-branch', { size: 17 })}</span>
      <div><strong>${escapeHtml(data.branch)}</strong><small>${escapeHtml(data.root)}</small></div>
      <button class="git-close" title="Close">${ic('x', { size: 15 })}</button>
    </div>
    <div class="git-meta">
      <div><span>Remote</span>${data.remote ? `<button class="git-remote" ${remoteUrl ? '' : 'disabled'}>${escapeHtml(data.remote)}</button>` : '<b>Not configured</b>'}</div>
      <div><span>Tracking</span><b>${escapeHtml(data.upstream || 'No upstream branch')}</b></div>
      <div><span>Local commit</span><b class="git-commit"><code>${escapeHtml(data.localHead || '—')}</code><span>${escapeHtml(data.localSubject || 'No commits')}</span></b></div>
      <div><span>Remote commit</span><b class="git-commit"><code>${escapeHtml(data.remoteHead || '—')}</code><span>${escapeHtml(data.remoteSubject || (data.upstream ? 'Remote ref unavailable' : 'No upstream'))}</span></b></div>
      <div class="git-counts"><span>Commits</span><b><span class="git-badge ahead">${data.ahead} ahead</span><span class="git-badge behind">${data.behind} behind</span></b></div>
      <div class="git-counts"><span>Working tree</span><b><span class="git-badge staged">${data.staged || 0} staged</span><span class="git-badge dirty">${data.unstaged || 0} modified</span><span class="git-badge untracked">${data.untracked || 0} new</span></b></div>
    </div>
    <div class="git-changes-head"><span>Changes</span><b>${data.changes.length}</b></div>
    <div class="git-files">${files || '<div class="git-clean">Working tree is clean</div>'}${data.changes.length > 8 ? `<div class="git-more">and ${data.changes.length - 8} more</div>` : ''}</div>
    <div class="git-result">${escapeHtml(message)}</div>
    <div class="git-actions">
      <button data-git-action="pull" ${data.upstream ? '' : 'disabled'}>${ic('arrow-down', { size: 13 })} Pull</button>
      <button data-git-action="push">${ic('arrow-up', { size: 13 })} Push</button>
      <button data-git-action="sync" ${data.upstream ? '' : 'disabled'}>${ic('refresh-cw', { size: 13 })} Sync</button>
    </div>`;
  panel.querySelector('.git-close').onclick = closeGitPanel;
  const remote = panel.querySelector('.git-remote');
  if (remote && remoteUrl) remote.onclick = () => API.openExternal(remoteUrl);
  panel.querySelectorAll('[data-git-action]').forEach((button) => {
    button.onclick = async () => {
      const action = button.dataset.gitAction;
      panel.classList.add('busy');
      panel.querySelectorAll('[data-git-action]').forEach((item) => { item.disabled = true; });
      panel.querySelector('.git-result').textContent = `${action[0].toUpperCase() + action.slice(1)} in progress…`;
      let result;
      try { result = await API.gitAction({ cwd: data.root, action }); }
      catch (error) { result = { ok: false, error: error.message || String(error) }; }
      panel.classList.remove('busy');
      if (result && result.status && result.status.ok) activeGitStatus = result.status;
      else await updateGitStatus(data.root, true);
      renderGitPanel(result && result.ok ? (result.output || `${action} complete.`) : (result && result.error || `${action} failed.`));
      gitStatusCache.delete(data.root);
      updateGitStatus(data.root, true);
    };
  });
}
function process_env_shell() { return OS.shell || (OS.platform === 'win32' ? 'powershell.exe' : OS.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'); }
function applyRtl() { document.body.classList.toggle('rtl-text', state.settings.rtlText !== false); }
function sessionDomain(sid) { return state.domains.find((d) => d.sessionId === sid); }
const domainUp = new Map(); // domain id → is something actually listening on its port right now
function updateDomainButton() {
  const btn = document.getElementById('st-domain'); if (!btn) return;
  const e = live.get(activeId);
  const dom = sessionDomain(activeId);
  // the button only shows while a server is actually listening — an exposed domain
  // whose dev server has stopped stays in the domains list but leaves the bar
  if (dom && !domainUp.has(dom.id)) API.portCheck(dom.port).then((up) => { domainUp.set(dom.id, up); updateDomainButton(); });
  if (dom && domainUp.get(dom.id)) {
    const on = state.proxyOn;
    btn.className = 'st-btn ' + (on ? 'on' : 'off');
    btn.innerHTML = ic('globe', { size: 12 }) + `<span>${escapeHtml(dom.domain)}</span>`;
    btn.title = on ? `Open http://${dom.domain}` : 'Proxy is off — click to start';
    btn.onclick = () => { if (state.proxyOn) API.openExternal(domainUrl(dom.domain)); else enableProxy().then(() => { pushProxyMap(); updateStatus(); }); };
  } else if (e && e._lastPort) {
    btn.className = 'st-btn detect';
    const port = e._lastPort; const node = findNode(activeId);
    const guess = node && node.node.cwd ? slugBase(basename(node.node.cwd)) + domainTld() : 'expose';
    btn.innerHTML = ic('globe', { size: 12 }) + `<span>expose ${escapeHtml(guess)} :${port}</span>`;
    btn.title = `Expose this dev server (:${port}) to ${guess}`;
    btn.onclick = () => node && showDomainPopup({ node: node.node, port });
  } else {
    btn.className = 'st-btn hidden';
    btn.innerHTML = ''; btn.onclick = null;
  }
}
function updateTitle() {
  const r = activeId && findNode(activeId);
  document.getElementById('tb-title').textContent = r ? `${r.node.name} — ${shortCwd(r.node.cwd)}` : 'coco';
}
function setHTML(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function startClock() {
  const tick = () => {
    const d = new Date();
    setHTML('st-clock', ic('clock', { size: 12 }) + `<span>${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`);
  };
  tick(); setInterval(tick, 15000);
}

// ---------------- command palette ----------------
let paletteItems = [], paletteSel = 0;
function buildPaletteItems() {
  const items = [];
  const add = (group, item) => items.push({ group, ...item });
  add('Terminal', { icon: 'plus', label: 'New Terminal', hint: accelLabel('CmdOrCtrl+T'), run: () => newTerminal({}) });
  add('Terminal', { icon: 'server', label: 'New SSH Session', hint: '', run: () => newHost(undefined, 'ssh') });
  add('Terminal', { icon: 'folder-key', label: 'New SFTP Session', hint: '', run: () => newHost(undefined, 'sftp') });
  add('Terminal', { icon: 'folder-plus', label: 'New Session Folder', hint: accelLabel('CmdOrCtrl+Shift+N'), run: () => promptModal('New Folder', 'Folder name', 'New Folder', (v) => v && newFolder(v)) });
  if (activeId) {
    add('Terminal', { icon: 'copy', label: 'Duplicate Terminal', hint: accelLabel('CmdOrCtrl+Shift+D'), run: () => duplicateSession(activeId) });
    add('Terminal', { icon: 'x', label: 'Close Terminal', hint: accelLabel('CmdOrCtrl+W'), run: () => closeTerminal(activeId) });
    add('Layout', { icon: 'square-terminal', label: 'Split Right', hint: accelLabel('CmdOrCtrl+\\'), run: () => splitFocused('row') });
    add('Layout', { icon: 'square-terminal', label: 'Split Down', hint: accelLabel('CmdOrCtrl+Shift+\\'), run: () => splitFocused('col') });
    add('Layout', { icon: 'zap', label: broadcast ? 'Stop Broadcasting' : 'Broadcast Input to All Panes', hint: accelLabel('CmdOrCtrl+Shift+B'), run: () => toggleBroadcast() });
    add('Current Session', { icon: 'folder-open', label: 'Open Directory With…', hint: accelLabel('CmdOrCtrl+Shift+O'), run: () => openInFinder() });
    add('Current Session', { icon: 'corner-down-right', label: 'Copy Current Path', hint: accelLabel('CmdOrCtrl+Shift+C'), run: () => copyPath() });
    add('Current Session', { icon: 'copy', label: 'Copy Last Command Output', hint: accelLabel('CmdOrCtrl+Shift+Y'), run: () => copyLastOutput() });
    add('Current Session', { icon: 'search', label: 'Search Scrollback', hint: accelLabel('CmdOrCtrl+F'), run: () => openFind() });
  }
  if (state.settings.commandsEnabled !== false) {
    add('Commands', { icon: 'zap', label: 'Routine Commands…', hint: '', run: () => openCommandsPanel(document.getElementById('btn-commands')) });
    add('Commands', { icon: 'settings-2', label: 'Manage Commands…', hint: '', run: () => openCommandsManager() });
    eachCommand((c) => add('Commands', { icon: 'chevron-right', label: 'Run: ' + c.name, hint: c.command.length > 28 ? c.command.slice(0, 28) + '…' : c.command, run: () => runCommand(c) }));
  }
  add('Workspace', { icon: 'layers', label: 'Switch Workspace…', hint: '', run: () => openWorkspaceManager() });
  add('Workspace', { icon: 'square-terminal', label: 'Save Current Layout', hint: accelLabel('CmdOrCtrl+Shift+S'), run: () => saveLayoutPreset() });
  add('Workspace', { icon: 'layers', label: 'Saved Layouts…', hint: '', run: () => openLayoutsManager() });
  add('Tools', { icon: 'server', label: 'Manage Remote Sessions', hint: '', run: () => openHosts() });
  add('Tools', { icon: 'key', label: 'Manage SSH Keys', hint: '', run: () => openKeys() });
  add('Tools', { icon: 'globe', label: 'Local Domains…', hint: '', run: () => openDomains() });
  add('Tools', { icon: 'plug', label: 'Port Forwarding…', hint: '', run: () => openTunnels() });
  add('View', { icon: 'palette', label: 'Change Theme…', hint: accelLabel('CmdOrCtrl+P'), run: () => openThemeModal() });
  add('View', { icon: 'panel-left', label: 'Toggle Dock', hint: accelLabel('CmdOrCtrl+B'), run: () => toggleDock() });
  add('View', {
    icon: state.layoutMode === 'topbar' ? 'panel-left' : 'layers',
    label: state.layoutMode === 'topbar' ? 'Use Sidebar Layout' : 'Use Top-bar Layout',
    hint: '',
    run: () => toggleLayoutMode(),
  });
  add('Preferences', { icon: 'settings-2', label: 'Settings…', hint: '', run: () => openSettings() });
  add('Preferences', { icon: 'command', label: 'Keyboard Shortcuts…', hint: accelLabel('CmdOrCtrl+,'), run: () => openShortcuts() });
  return items;
}
function openPalette() {
  const modal = document.getElementById('palette-modal');
  const input = document.getElementById('palette-input');
  modal.classList.remove('hidden');
  input.value = ''; paletteSel = 0;
  renderPalette('');
  setTimeout(() => input.focus(), 20);
  input.oninput = () => { paletteSel = 0; renderPalette(input.value); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); highlightPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); highlightPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteSel(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  };
}
function closePalette() { document.getElementById('palette-modal').classList.add('hidden'); focusActive(); }
function renderPalette(query) {
  const all = buildPaletteItems();
  const q = query.trim().toLowerCase();
  paletteItems = q ? all.filter((i) => i.label.toLowerCase().includes(q) || (i.hint || '').toLowerCase().includes(q)) : all;
  const listEl = document.getElementById('palette-list');
  listEl.innerHTML = '';
  if (paletteItems.length === 0) { listEl.innerHTML = '<div class="palette-empty">No matches</div>'; return; }
  let lastGroup = '';
  paletteItems.forEach((it, i) => {
    if (!q && it.group !== lastGroup) {
      const group = document.createElement('div');
      group.className = 'palette-group';
      group.textContent = it.group;
      listEl.appendChild(group);
      lastGroup = it.group;
    }
    const el = document.createElement('div');
    el.className = 'palette-item' + (i === paletteSel ? ' sel' : '');
    el.innerHTML = `<span class="pi-ic">${ic(it.icon, { size: 16 })}</span><span class="palette-label">${escapeHtml(it.label)}</span>${it.hint ? `<span class="palette-hint">${escapeHtml(it.hint)}</span>` : ''}`;
    el.onclick = () => { paletteSel = i; runPaletteSel(); };
    el.onmouseenter = () => { paletteSel = i; highlightPalette(); };
    listEl.appendChild(el);
  });
}
function highlightPalette() {
  document.querySelectorAll('#palette-list .palette-item').forEach((el, i) => el.classList.toggle('sel', i === paletteSel));
  const sel = document.querySelector('#palette-list .palette-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function runPaletteSel() {
  const it = paletteItems[paletteSel];
  closePalette();
  if (it) setTimeout(() => it.run(), 0);
}

// ---------------- context menu ----------------
const NODE_COLORS = [
  { value: '', label: 'None' },
  { value: '#ff5c5c', label: 'Red' }, { value: '#ffb000', label: 'Orange' }, { value: '#f2cc60', label: 'Yellow' },
  { value: '#3ddc97', label: 'Green' }, { value: '#3d7eff', label: 'Blue' }, { value: '#c792ea', label: 'Purple' }, { value: '#56d4dd', label: 'Cyan' },
];
function setNodeColor(id, color) { const r = findNode(id); if (!r) return; if (color) r.node.color = color; else delete r.node.color; persist(); renderTree(); if (r.node.id === activeId) updateStatus(); }
function colorSubmenu(id) { return NODE_COLORS.map((c) => ({ icon: c.value ? 'circle-dot' : 'x', iconColor: c.value, label: c.label, run: () => setNodeColor(id, c.value) })); }

function openContextMenu(e, node) {
  const items = [];
  if (node.type === 'folder') {
    items.push({ icon: 'plus', label: 'New Terminal Here', run: () => newTerminal({ folderId: node.id }) });
    items.push({ icon: 'server', label: 'New SSH Session Here', run: () => newHost(node.id, 'ssh') });
    items.push({ icon: 'folder-key', label: 'New SFTP Session Here', run: () => newHost(node.id, 'sftp') });
    items.push({ icon: 'folder-plus', label: 'New Subfolder', run: () => promptModal('New Folder', 'Folder name', 'New Folder', (v) => v && newFolder(v, node.id)) });
    items.push({ sep: true });
    items.push({ icon: 'pencil', label: 'Rename', run: () => renameNode(node.id) });
    items.push({ icon: 'palette', label: 'Color', submenu: colorSubmenu(node.id) });
    items.push({ icon: 'trash-2', label: 'Delete', danger: true, run: () => deleteNode(node.id) });
  } else if (node.type === 'host') {
    items.push({ icon: 'plug', label: live.has(node.id) ? 'Focus' : 'Connect', run: () => openTerminal(node) });
    items.push({ icon: 'square-terminal', label: 'Open SSH Shell', run: () => openHostAs(node, false) });
    items.push({ icon: 'folder-key', label: 'Open SFTP Browser', run: () => openSftpBrowser(node) });
    items.push({ icon: 'plug', label: 'Open SFTP Terminal', run: () => openHostAs(node, true) });
    items.push({ icon: 'copy', label: 'Duplicate', run: () => { const c = { ...node, id: uid('host'), pinned: true }; const r = findNode(node.id); (r.parent ? r.parent.children : state.tree).push(c); persist(); renderTree(); } });
    items.push({ icon: 'pencil-line', label: 'Edit Connection', run: () => editHost(node.id) });
    items.push({ icon: 'palette', label: 'Color', submenu: colorSubmenu(node.id) });
    items.push({ sep: true });
    if (live.has(node.id)) items.push({ icon: 'x', label: 'Disconnect Host', run: () => closeTerminal(node.id) });
    items.push({ icon: 'trash-2', label: 'Remove Saved Host Permanently', danger: true, run: () => deleteNode(node.id) });
  } else {
    items.push({ icon: 'square-terminal', label: live.has(node.id) ? 'Focus' : 'Open', run: () => openTerminal(node) });
    items.push({ icon: 'copy', label: 'Duplicate', run: () => duplicateSession(node.id) });
    items.push({ icon: 'corner-down-right', label: 'Copy Path', run: () => { navigator.clipboard.writeText(node.cwd || ''); } });
    items.push({ icon: 'folder-open', label: 'Open Directory With…', run: () => openDirectoryWith(node.cwd) });
    items.push({ sep: true });
    items.push({ icon: 'pencil', label: 'Rename', run: () => renameNode(node.id) });
    items.push({ icon: 'palette', label: 'Color', submenu: colorSubmenu(node.id) });
    if (live.has(node.id)) items.push({ icon: 'x', label: 'Close Terminal', run: () => closeTerminal(node.id) });
  }
  showMenu(e.clientX, e.clientY, items);
}
function closeContextMenu() { closeAllMenus(); }

// ---------------- theme modal ----------------
function openThemeModal() { renderThemeGrid(); document.getElementById('theme-modal').classList.remove('hidden'); }
function renderThemeGrid() {
  const grid = document.getElementById('theme-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const t of window.COCO_THEMES) {
    const card = document.createElement('div');
    card.className = 'theme-card' + (t.id === state.themeId ? ' active' : '');
    card.onclick = () => applyTheme(t.id);
    const sw = `<div class="theme-swatch" style="background:${t.xterm.background};color:${t.xterm.foreground}">❯ coco
      <div class="swatch-dots">${[t.xterm.red, t.xterm.green, t.xterm.yellow, t.xterm.blue, t.xterm.magenta, t.xterm.cyan].map((c) => `<span style="background:${c}"></span>`).join('')}</div></div>`;
    card.innerHTML = `<div class="theme-name">${escapeHtml(t.name)}</div>${sw}`;
    grid.appendChild(card);
  }
}

// ---------------- prompt modal ----------------
function promptModal(title, placeholder, value, onOk, opts = {}) {
  const modal = document.getElementById('prompt-modal');
  const input = document.getElementById('prompt-input');
  document.getElementById('prompt-title').textContent = title;
  input.placeholder = placeholder || ''; input.value = value || '';
  const ok = document.getElementById('prompt-ok');
  const cancel = document.getElementById('prompt-cancel');
  ok.textContent = opts.okLabel || 'OK';
  ok.classList.toggle('btn-accent', true);
  modal.classList.remove('hidden');
  setTimeout(() => { input.focus(); input.select(); }, 20);
  const close = () => { modal.classList.add('hidden'); ok.onclick = cancel.onclick = input.onkeydown = null; focusActive(); };
  ok.onclick = () => { const v = input.value; close(); onOk(v); };
  cancel.onclick = close;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ok.onclick(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    e.stopPropagation();
  };
}

// ---------------- misc ----------------
function focusActive() { const e = live.get(activeId); if (e) e.term.focus(); }

// ---- top-bar layout (alternative to the sidebar) ----
function applyLayoutMode() {
  const topbar = state.layoutMode === 'topbar';
  document.body.classList.toggle('topbar-mode', topbar);
  if (topbar) state.dockCollapsed = true; // dock hidden; slide it in with the Sessions button
  document.getElementById('dock').classList.toggle('collapsed', state.dockCollapsed);
  renderTopbar();
  setTimeout(() => { const e = live.get(activeId); if (e) { try { e.fit.fit(); } catch {} } }, 240);
}
function toggleLayoutMode() {
  state.layoutMode = state.layoutMode === 'topbar' ? 'dock' : 'topbar';
  if (state.layoutMode === 'dock') state.dockCollapsed = false;
  applyLayoutMode();
  persist();
}
function renderTopbar() {
  const bar = document.getElementById('topbar');
  if (!bar) return;
  if (state.layoutMode !== 'topbar') { bar.innerHTML = ''; return; }
  bar.innerHTML = '';
  const sessionsBtn = document.createElement('button');
  sessionsBtn.className = 'tb2-btn'; sessionsBtn.title = 'Saved sessions';
  sessionsBtn.innerHTML = ic('panel-left', { size: 15 });
  sessionsBtn.onclick = (e) => { e.stopPropagation(); toggleDock(); };
  bar.appendChild(sessionsBtn);

  const tabs = document.createElement('div'); tabs.className = 'tb2-tabs';
  for (const id of live.keys()) {
    const r = findNode(id);
    const isHost = r && r.node.type === 'host';
    const e = live.get(id);
    const tab = document.createElement('div');
    tab.className = 'tb2-tab' + (id === activeId ? ' active' : '');
    const claudeClass = e && e.claudeState ? ` claude-${e.claudeState}` : '';
    const claudeLabel = e && e.claudeState ? `<span class="tb2-claude ${e.claudeState}">${e.claudeState}</span>` : '';
    tab.innerHTML = `<span class="tb2-dot ${e && e.dead ? 'dead' : ''}${claudeClass}"></span><span class="tb2-ic">${ic(isHost ? (r.node.sftp ? 'folder-key' : 'server') : 'square-terminal', { size: 12 })}</span><span class="tb2-name">${escapeHtml(r ? r.node.name : 'shell')}</span>${claudeLabel}`;
    const close = document.createElement('button'); close.className = 'tb2-close'; close.title = 'Stop terminal'; close.innerHTML = ic('x', { size: 11 });
    close.onclick = (ev) => { ev.stopPropagation(); closePane(id); };
    tab.appendChild(close);
    tab.onclick = () => activate(id);
    tab.ondblclick = () => renameNode(id);
    tabs.appendChild(tab);
  }
  bar.appendChild(tabs);

  const addBtn = document.createElement('button');
  addBtn.className = 'tb2-btn'; addBtn.title = 'New terminal'; addBtn.innerHTML = ic('plus', { size: 16 });
  addBtn.onclick = () => newTerminal({});
  bar.appendChild(addBtn);
}

function toggleDock() {
  state.dockCollapsed = !state.dockCollapsed;
  document.getElementById('dock').classList.toggle('collapsed', state.dockCollapsed);
  const button = document.getElementById('btn-dock');
  const label = state.dockCollapsed ? 'Show sidebar' : 'Hide sidebar';
  button.title = `${label} (${accelLabel('CmdOrCtrl+B')})`;
  button.setAttribute('aria-label', label);
  persist();
  setTimeout(() => { const e = live.get(activeId); if (e) { try { e.fit.fit(); } catch {} } }, 240);
}
function changeFont(d) {
  state.fontSize = Math.max(8, Math.min(28, state.fontSize + d));
  for (const e of live.values()) { e.term.options.fontSize = state.fontSize; try { e.fit.fit(); } catch {} }
  persist();
}
function copyPath() { const r = activeId && findNode(activeId); if (r) navigator.clipboard.writeText(r.node.cwd || ''); }
async function openDirectoryWith(cwd) {
  const result = await API.openDirectoryWith(cwd || activeCwd());
  if (result && result.error) flashToast(result.error);
}
function openInFinder() { openDirectoryWith(activeCwd()); }
function toggleBroadcast() {
  broadcast = !broadcast;
  document.body.classList.toggle('broadcasting', broadcast);
  updateStatus();
  focusActive();
}

// ---- continuous pen/marker writing sound (synthesized, no audio files) ----
// A single looping friction noise that swells ON while you type and fades when you
// pause — so it feels like a marker gliding on paper, not a tick per key.
let _audio = null, _writeEngine = null;
function audioCtx() {
  if (!_audio) { try { _audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  if (_audio && _audio.state === 'suspended') _audio.resume();
  return _audio;
}
function writeEngine() {
  const ctx = audioCtx(); if (!ctx) return null;
  if (_writeEngine) return _writeEngine;
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; // steady friction noise
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 600;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.5;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4000; // dry marker (no sizzle)
  const gain = ctx.createGain(); gain.gain.value = 0.0001;
  src.connect(hp); hp.connect(bp); bp.connect(lp); lp.connect(gain); gain.connect(ctx.destination);
  src.start();
  _writeEngine = { ctx, src, hp, bp, lp, gain, idle: null };
  return _writeEngine;
}
function playWriteSound(kind) {
  if (!state.settings.writeSound || state.themeId !== 'paper') return;
  const eng = writeEngine(); if (!eng) return;
  const ctx = eng.ctx, now = ctx.currentTime;
  // keep the marker "on the paper" while keys keep coming; small per-key variation = texture
  const target = kind === 'enter' ? 0.06 : 0.032 + Math.random() * 0.022;
  eng.gain.gain.cancelScheduledValues(now);
  eng.gain.gain.setTargetAtTime(target, now, 0.008);          // quick swell, no click
  eng.bp.frequency.setTargetAtTime(1450 + Math.random() * 900, now, 0.03); // movement
  eng.lp.frequency.setTargetAtTime(kind === 'enter' ? 3000 : 4200, now, 0.05);
  if (eng.idle) clearTimeout(eng.idle);
  eng.idle = setTimeout(() => { const t = ctx.currentTime; eng.gain.gain.setTargetAtTime(0.0001, t, 0.05); }, 150); // fade ~150ms after last key
}
function stopWriteSound() { if (_writeEngine) { const t = _writeEngine.ctx.currentTime; _writeEngine.gain.gain.setTargetAtTime(0.0001, t, 0.03); } }
// Expand {{variables}} in a routine command by prompting for each. Returns null if cancelled.
function expandCommand(cmd) {
  const vars = [...new Set((cmd.match(/\{\{\s*([^}]+?)\s*\}\}/g) || []).map((m) => m.replace(/^\{\{\s*|\s*\}\}$/g, '')))];
  if (!vars.length) return Promise.resolve(cmd);
  return new Promise((resolve) => {
    formModal({
      title: 'Fill in values', submitLabel: 'Run',
      fields: vars.map((v) => ({ key: v, label: v, placeholder: '' })),
      onSubmit: (vals) => {
        let out = cmd;
        for (const v of vars) out = out.replace(new RegExp('\\{\\{\\s*' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\}\\}', 'g'), vals[v] || '');
        resolve(out);
      },
      onCancel: () => resolve(null),
    });
  });
}

// ---- search across scrollback ----
function openFind() {
  const e = live.get(activeId);
  if (!e) return;
  let bar = document.getElementById('searchbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'searchbar';
    bar.innerHTML = `
      <span class="sb-ic">${ic('search', { size: 14 })}</span>
      <input id="sb-input" type="text" placeholder="Search scrollback…" spellcheck="false" />
      <button class="sb-btn" id="sb-prev" title="Previous">${ic('chevron-down', { size: 14 })}</button>
      <button class="sb-btn" id="sb-next" title="Next">${ic('chevron-down', { size: 14 })}</button>
      <button class="sb-btn" id="sb-x" title="Close">${ic('x', { size: 14 })}</button>`;
    document.getElementById('terminals').appendChild(bar);
    bar.querySelector('#sb-prev').style.transform = 'rotate(180deg)';
    const input = bar.querySelector('#sb-input');
    const opts = { decorations: { matchOverviewRuler: '#ffb27a', activeMatchColorOverviewRuler: '#ffb27a' } };
    const doNext = () => { const en = live.get(activeId); if (en && input.value) en.search.findNext(input.value, opts); };
    const doPrev = () => { const en = live.get(activeId); if (en && input.value) en.search.findPrevious(input.value, opts); };
    input.oninput = doNext;
    input.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.shiftKey ? doPrev() : doNext(); } if (ev.key === 'Escape') closeFind(); ev.stopPropagation(); };
    bar.querySelector('#sb-next').onclick = doNext;
    bar.querySelector('#sb-prev').onclick = doPrev;
    bar.querySelector('#sb-x').onclick = closeFind;
  }
  bar.classList.add('open');
  const input = bar.querySelector('#sb-input');
  setTimeout(() => { input.focus(); input.select(); }, 10);
}
function closeFind() {
  const bar = document.getElementById('searchbar');
  if (bar) bar.classList.remove('open');
  const e = live.get(activeId); if (e) { try { e.search.clearDecorations(); } catch {} e.term.focus(); }
}
function shellQuote(p) { if (!p) return ''; return /^[\w@%+=:,./-]+$/.test(p) ? p : "'" + p.replace(/'/g, "'\\''") + "'"; }
function cycle(dir) { focusNextPane(dir); }
function switchTo(n) {
  const leaves = layoutLeafIds();
  if (leaves[n]) { setFocus(leaves[n]); return; }
  const ids = [...live.keys()]; if (ids[n]) activate(ids[n]);
}

// Shortcuts are Electron menu accelerators (so they stay editable + work while xterm is focused).
function globalKeyHandler() { return true; }

// ---------------- clickable file paths ----------------
// Path detection runs in the main process (real fs checks) per line, so it handles
// spaces, unicode (Arabic), parentheses, multi-column ls, and ls -la correctly.
const lineCache = new Map(); // "cwd\0lineText" -> [{start,len,isDir}]
let hoverSeq = 0;

function makePathLinkProvider(node, term) {
  const buildLinks = (text, matches, y, callback) => {
    if (!matches || !matches.length) { callback(undefined); return; }
    const links = matches.map((mt) => {
      const len = Math.min(mt.len, text.length - mt.start);
      if (len < 1) return null;
      const linkText = text.slice(mt.start, mt.start + len);
      return {
        text: linkText,
        range: { start: { x: mt.start + 1, y }, end: { x: mt.start + len, y } },
        decorations: { pointerCursor: false, underline: true },
        activate: (ev) => { if (ev.metaKey || ev.ctrlKey) { API.pathOpen({ cwd: node.cwd, raw: linkText, reveal: ev.altKey }); hidePathPreview(); } },
        hover: (ev) => {
          if (state.settings.directoryPreviews === false) return;
          currentHover = { cwd: node.cwd, text: linkText, x: ev.clientX, y: ev.clientY };
          if (ev.metaKey || ev.ctrlKey) showPathPreview(ev, node.cwd, linkText);
        },
        leave: () => { currentHover = null; hidePathPreview(); },
      };
    }).filter(Boolean);
    callback(links.length ? links : undefined);
  };
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      if (!text || !/[\p{L}\p{N}~./]/u.test(text)) { callback(undefined); return; }
      const key = (node.cwd || '') + '\0' + text;
      const cached = lineCache.get(key);
      if (cached !== undefined) { buildLinks(text, cached, y, callback); return; }
      API.pathScanLine({ cwd: node.cwd, text }).then((matches) => {
        if (lineCache.size > 3000) lineCache.clear();
        lineCache.set(key, matches || []);
        buildLinks(text, matches, y, callback);
      });
    },
  };
}

function previewEl() {
  let el = document.getElementById('path-preview');
  if (!el) { el = document.createElement('div'); el.id = 'path-preview'; el.className = 'path-preview hidden'; document.body.appendChild(el); }
  return el;
}
function humanSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}
async function showPathPreview(event, cwd, p) {
  if (state.settings.directoryPreviews === false) return;
  const el = previewEl();
  const seq = ++hoverSeq;
  el.classList.remove('hidden');
  el.innerHTML = `<div class="pp-head">${ic('scroll-text', { size: 13 })}<span>${escapeHtml(p)}</span></div><div class="pp-meta">resolving…</div>`;
  positionPreview(el, event);
  const info = await API.pathPreview({ cwd, raw: p });
  if (seq !== hoverSeq) return;
  if (!info) { el.innerHTML = `<div class="pp-head pp-missing">${ic('x', { size: 13 })}<span>path not found</span></div>`; positionPreview(el, event); return; }
  const meta = `${info.isDir ? 'folder' : (info.ext || 'file')} · ${humanSize(info.size)}`;
  let body = '';
  if (info.isDir) body = `<div class="pp-meta">${info.count} item${info.count === 1 ? '' : 's'}</div><pre class="pp-snippet">${escapeHtml((info.entries || []).join('\n'))}${info.count > (info.entries || []).length ? '\n…' : ''}</pre>`;
  else if (info.dataUrl) body = `<img class="pp-img" src="${info.dataUrl}" alt="">`;
  else if (info.snippet != null) body = `<pre class="pp-snippet">${escapeHtml(info.snippet)}</pre>`;
  else if (info.binary) body = `<div class="pp-meta">binary file</div>`;
  el.innerHTML = `<div class="pp-head">${ic(info.isDir ? 'folder' : 'scroll-text', { size: 13 })}<span>${escapeHtml(info.name)}</span></div>
    <div class="pp-path">${escapeHtml(info.abs)}</div>
    <div class="pp-meta">${escapeHtml(meta)}</div>${body}
    <div class="pp-hint">${OS.platform === 'darwin' ? '⌘-click to open · ⌥⌘-click to reveal' : 'Ctrl-click to open · Alt+Ctrl-click to reveal'}</div>`;
  positionPreview(el, event);
}
function positionPreview(el, event) {
  const pad = 14;
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = (event.clientX || 120) + 16, y = (event.clientY || 120) + 18;
  if (x + w + pad > window.innerWidth) x = (event.clientX || 120) - w - 16;
  if (y + h + pad > window.innerHeight) y = window.innerHeight - h - pad;
  el.style.left = Math.max(pad, x) + 'px';
  el.style.top = Math.max(pad, y) + 'px';
}
function hidePathPreview() { hoverSeq++; const el = document.getElementById('path-preview'); if (el) el.classList.add('hidden'); }

function updateFeatureVisibility() {
  const commands = document.getElementById('btn-commands');
  if (commands) commands.classList.toggle('feature-hidden', state.settings.commandsEnabled === false);
  if (state.settings.commandsEnabled === false) closeCommandsPanel();
  if (state.settings.gitIntegration === false) {
    closeGitPanel();
    const git = document.getElementById('st-git');
    if (git) git.classList.add('hidden');
  } else {
    const r = activeId && findNode(activeId);
    updateGitStatus(r && r.node.type !== 'host' ? r.node.cwd : null, true);
  }
  if (state.settings.directoryPreviews === false) {
    currentHover = null;
    hidePathPreview();
  }
}

// The preview tooltip only appears while ⌘ (or Ctrl) is held. We remember the path
// currently under the cursor so pressing ⌘ after hovering still shows it.
let currentHover = null;
function onModifierDown(e) {
  if (state.settings.directoryPreviews === false) return;
  if ((e.key === 'Meta' || e.key === 'Control') && currentHover) {
    showPathPreview({ clientX: currentHover.x, clientY: currentHover.y }, currentHover.cwd, currentHover.text);
  }
}
function onModifierUp(e) { if (e.key === 'Meta' || e.key === 'Control') hidePathPreview(); }

// ---------------- IPC ----------------
// PTY data → terminal, coalesced to one write per frame. AI CLIs (claude code,
// copilot…) emit hundreds of tiny chunks/sec; writing each one reflows the
// viewport, which races queued trackpad-momentum scrolls and rockets the view
// to the top of the scrollback. Batching also smooths their constant redraws.
const pendingWrites = new Map(); // tabId -> chunks[]
let writeRaf = 0, writeTimer = 0;
function flushWrites() {
  if (writeRaf) { cancelAnimationFrame(writeRaf); writeRaf = 0; }
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = 0; }
  for (const [tabId, chunks] of pendingWrites) {
    const e = live.get(tabId); if (!e) continue;
    const data = chunks.join('');
    e.term.write(data);
    // exponential byte-rate (~last 400ms) — the wheel guard reads this
    const now = performance.now();
    e._rate = (e._rate || 0) * Math.exp(-(now - (e._rateT || now)) / 400) + data.length;
    e._rateT = now;
    e._dirty = true;
    if (e.claudeActive && e.claudeState === 'working') {
      e._claudeOutputSeen = true;
      const r = findNode(tabId);
      if (r) scheduleClaudeCompletion(r.node, e);
    }
    detectService(tabId, data);
  }
  pendingWrites.clear();
  scheduleBufferSave();
}
API.onData(({ tabId, data }) => {
  const q = pendingWrites.get(tabId);
  if (q) q.push(data); else pendingWrites.set(tabId, [data]);
  if (writeRaf || writeTimer) return;
  writeRaf = requestAnimationFrame(flushWrites);
  writeTimer = setTimeout(flushWrites, 50); // backstop: rAF stalls when the window is hidden
});
API.onExit(({ tabId }) => {
  const e = live.get(tabId);
  if (e) {
    const r = findNode(tabId);
    if (e.claudeState && r) claudeComplete(r.node, e);
    e.dead = true;
    e.claudeActive = false;
    if (e._claudeCompleteTimer) clearTimeout(e._claudeCompleteTimer);
    e.term.write(`\r\n\x1b[38;5;244m[process exited - ${accelLabel('CmdOrCtrl+W')} to close]\x1b[0m\r\n`);
    renderTree();
  }
});
API.onNotificationOpen(({ tabId }) => {
  if (tabId && live.has(tabId)) activate(tabId);
});
API.onMenu((cmd, arg) => {
  switch (cmd) {
    case 'new-tab': newTerminal({}); break;
    case 'new-local': newTerminal({ cwd: activeCwd() }); break;
    case 'new-host': openHosts(); break;
    case 'new-folder': promptModal('New Folder', 'Folder name', 'New Folder', (v) => v && newFolder(v)); break;
    case 'close-tab': if (activeId) closeTerminal(activeId); break;
    case 'rename-tab': if (activeId) renameNode(activeId); break;
    case 'duplicate': if (activeId) duplicateSession(activeId); break;
    case 'split-right': splitFocused('row'); break;
    case 'split-down': splitFocused('col'); break;
    case 'focus-next-pane': focusNextPane(1); break;
    case 'focus-prev-pane': focusNextPane(-1); break;
    case 'next-tab': cycle(1); break;
    case 'prev-tab': cycle(-1); break;
    case 'switch': switchTo(arg); break;
    case 'palette': openPalette(); break;
    case 'themes': openThemeModal(); break;
    case 'shortcuts': openShortcuts(); break;
    case 'toggle-dock': toggleDock(); break;
    case 'toggle-layout': toggleLayoutMode(); break;
    case 'font-up': changeFont(1); break;
    case 'font-down': changeFont(-1); break;
    case 'find': openFind(); break;
    case 'broadcast': toggleBroadcast(); break;
    case 'open-finder': openInFinder(); break;
    case 'copy-path': copyPath(); break;
    case 'copy-output': copyLastOutput(); break;
    case 'prev-block': jumpBlock(-1); break;
    case 'next-block': jumpBlock(1); break;
    case 'save-workspace': saveLayoutPreset(); break;
    case 'workspaces': openWorkspaceManager(); break;
    case 'tunnels': openTunnels(); break;
    case 'domains': openDomains(); break;
    case 'focus-filter': document.getElementById('dock-filter').focus(); break;
  }
});

// ---------------- buttons / globals ----------------
function wireUI() {
  document.getElementById('btn-dock').innerHTML = ic('panel-left', { size: 15 });
  document.getElementById('btn-commands').innerHTML = ic('zap', { size: 17 });
  document.getElementById('btn-palette').innerHTML = ic('command', { size: 17 });
  document.getElementById('btn-theme').innerHTML = ic('palette', { size: 17 });
  document.getElementById('btn-settings').innerHTML = ic('settings-2', { size: 17 });
  document.getElementById('dock-logo').innerHTML = ic('circle-dot', { size: 16 });
  renderWorkspaceSwitcher();
  document.getElementById('dock-add-host').innerHTML = ic('server', { size: 14 });
  document.getElementById('dock-add-folder').innerHTML = ic('folder-plus', { size: 14 });
  document.getElementById('dock-add-term').innerHTML = ic('square-terminal', { size: 14 });
  document.getElementById('btn-commands').innerHTML = ic('zap', { size: 15 }) + '<span>Commands</span>';
  document.getElementById('btn-theme').innerHTML = ic('palette', { size: 15 }) + '<span>Appearance</span>';
  document.getElementById('dock-search-ic').innerHTML = ic('search', { size: 14 });
  updateFolderToggle();
  document.getElementById('palette-ic').innerHTML = ic('command', { size: 18 });
  document.getElementById('theme-close').innerHTML = ic('x', { size: 16 });
  document.getElementById('empty-logo').innerHTML = ic('square-terminal', { size: 40, stroke: 1.5 });
  updateFeatureVisibility();

  document.getElementById('btn-dock').onclick = toggleDock;
  document.getElementById('btn-commands').onclick = (e) => { e.stopPropagation(); if (document.getElementById('cmd-popover')) closeCommandsPanel(); else openCommandsPanel(e.currentTarget); };
  document.getElementById('btn-palette').onclick = openPalette;
  document.getElementById('btn-theme').onclick = openThemeModal;
  document.getElementById('btn-settings').onclick = openSettings;
  document.getElementById('workspace-switcher').onclick = (event) => { event.stopPropagation(); openWorkspaceMenu(); };
  document.getElementById('dock-add-host').onclick = (event) => { event.stopPropagation(); openNewTerminalMenu(event.currentTarget); };
  document.getElementById('dock-add-folder').onclick = () => promptModal('New Folder', 'Folder name', 'New Folder', (v) => v && newFolder(v));
  document.getElementById('dock-add-term').onclick = () => newTerminal({});
  document.getElementById('dock-collapse-all').onclick = toggleAllFolders;
  document.getElementById('theme-close').onclick = () => document.getElementById('theme-modal').classList.add('hidden');
  document.getElementById('theme-modal').onclick = (e) => { if (e.target.id === 'theme-modal') e.target.classList.add('hidden'); };
  document.getElementById('palette-modal').onclick = (e) => { if (e.target.id === 'palette-modal') closePalette(); };

  document.getElementById('st-git').onclick = openGitPanel;

  const filter = document.getElementById('dock-filter');
  filter.oninput = () => { state.filter = filter.value; renderTree(); };
  filter.onkeydown = (e) => { if (e.key === 'Escape') { filter.value = ''; state.filter = ''; renderTree(); filter.blur(); } };

  // Never let a dropped file navigate the window away (caused the UI to vanish).
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });

  // drag a file from Finder/Desktop into the terminal → inserts its (shell-quoted) path
  const termsEl = document.getElementById('terminals');
  const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  termsEl.addEventListener('dragover', (e) => {
    if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; termsEl.classList.add('drop-files'); }
  });
  termsEl.addEventListener('dragleave', (e) => { if (e.target === termsEl) termsEl.classList.remove('drop-files'); });
  termsEl.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    termsEl.classList.remove('drop-files');
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length || !activeId) return;
    const paths = files.map((f) => shellQuote(API.getPathForFile(f))).filter(Boolean).join(' ');
    if (paths) { API.input(activeId, paths + ' '); focusActive(); }
  });

  // path preview only while ⌘/Ctrl is held
  window.addEventListener('keydown', onModifierDown);
  window.addEventListener('keyup', onModifierUp);

  API.onTunnelExit(({ id, error }) => { tunnelRunning.delete(id); if (error) flashToast('Tunnel stopped: ' + error.split('\n')[0]); });

  // dismiss context menus
  window.addEventListener('click', () => { closeContextMenu(); closeAllMenus(); });
  window.addEventListener('contextmenu', (e) => { if (!e.target.closest('.pane-slot') && !e.target.closest('.tree-row')) closeAllMenus(); });
  window.addEventListener('resize', () => { const e = live.get(activeId); if (e) { try { e.fit.fit(); } catch {} } });
  document.addEventListener('keydown', (e) => {
    const primaryModifier = OS.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (primaryModifier && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); }
  });
}

const ro = new ResizeObserver(() => { const e = live.get(activeId); if (e) { try { e.fit.fit(); } catch {} } });

// ---------------- init ----------------
async function init() {
  OS = await API.osInfo();
  document.body.classList.add(`platform-${OS.platform}`);
  if (OS.platform !== 'darwin') state.settings.proxyPort = 8080;
  const shortcutText = (accel) => accelLabel(accel);
  document.getElementById('btn-dock').title = `Hide sidebar (${shortcutText('CmdOrCtrl+B')})`;
  document.getElementById('btn-palette').title = `Command palette (${shortcutText('CmdOrCtrl+K')})`;
  document.getElementById('dock-add-term').title = `New local terminal (${shortcutText('CmdOrCtrl+T')})`;
  document.getElementById('dock-add-folder').title = `New session folder (${shortcutText('CmdOrCtrl+Shift+N')})`;
  document.getElementById('btn-theme').title = `Appearance and themes (${shortcutText('CmdOrCtrl+P')})`;
  const emptySub = document.querySelector('.empty-sub');
  if (emptySub) emptySub.innerHTML = `Press <kbd>${shortcutText('CmdOrCtrl+T')}</kbd> for a new terminal · <kbd>${shortcutText('CmdOrCtrl+K')}</kbd> for the command palette`;
  const { openIds, activeId: savedActive, savedLayout } = await loadState();
  applyTheme(state.themeId);
  applyRtl();
  document.getElementById('dock').classList.toggle('collapsed', state.dockCollapsed);
  wireUI();
  if (state.dockCollapsed) {
    const button = document.getElementById('btn-dock');
    button.title = `Show sidebar (${shortcutText('CmdOrCtrl+B')})`;
    button.setAttribute('aria-label', 'Show sidebar');
  }
  applyLayoutMode();
  renderTree();
  startClock();
  ro.observe(document.getElementById('terminals'));

  const valid = openIds.filter((id) => findNode(id) && isLeaf(findNode(id).node));
  if (valid.length && state.settings.restoreSessions !== false) {
    const buffers = (await API.storeGet(workspaceBufferKey())) || (state.activeWorkspaceId === 'global' ? (await API.storeGet('buffers')) || {} : {});
    valid.forEach((id) => { const r = findNode(id); if (r) ensureTerminal(r.node, buffers[id]); });
    layout = (savedLayout && pruneLayout(savedLayout)) || leafNode(valid[0]);
    const fl = firstLeaf(layout);
    activeId = (savedActive && live.has(savedActive) && findLeaf(savedActive)) ? savedActive : (fl ? fl.session : null);
    renderLayout();
    if (activeId) setFocus(activeId);
    restoreResolved = true;
    persist();
  } else {
    if (state.settings.restoreSessions === false) {
      removeEphemeral();
      API.storeDelete(workspaceBufferKey());
      renderTree();
    }
    newTerminal({});
    restoreResolved = true; persist();
  }
  // restore proxy state: if it's still running, re-sync the domain map
  API.proxyStatus().then((s) => { state.proxyOn = !!(s && s.running); if (state.proxyOn) pushProxyMap(); });

  // keep the status-bar button honest: it only shows while a server is listening.
  // clears the "expose" hint when a detected dev server stops, and hides/reshows
  // an exposed domain as its dev server goes down or comes back up
  setInterval(() => {
    const e = live.get(activeId);
    if (e && e._lastPort) API.portCheck(e._lastPort).then((up) => { if (!up) { if (e._seenPorts) e._seenPorts.delete(e._lastPort); e._lastPort = null; updateDomainButton(); } });
    const dom = sessionDomain(activeId);
    if (dom) API.portCheck(dom.port).then((up) => { if (domainUp.get(dom.id) !== up) { domainUp.set(dom.id, up); updateDomainButton(); } });
  }, 4000);

  // periodic snapshot so an accidental/force quit still has the latest screen + history
  setInterval(() => { if (restoreResolved) persistBuffers(); }, 10000); // safety net; debounced save does the work
  console.log(`coco ready · theme=${state.themeId} · rows=${document.querySelectorAll('.tree-row').length} · live=${live.size}`);
}

window.addEventListener('error', (e) => console.error('coco error:', e.message, e.filename + ':' + e.lineno));
init().catch((e) => console.error('coco init failed:', e && e.stack || e));
