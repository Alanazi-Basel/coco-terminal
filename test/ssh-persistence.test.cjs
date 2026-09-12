'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../src/main/store');
const { attachPty, stopPty } = require('../src/main/pty-lifecycle');
const { buildSshCommand } = require('../src/main/ssh-command');

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-ssh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir);
}

function fakePty() {
  return {
    onData(fn) { this.data = fn; },
    onExit(fn) { this.exit = fn; },
    kill() { this.killed = true; this.exit({ exitCode: 0 }); },
  };
}

test('a replaced SSH process cannot close or write into its replacement', () => {
  const registry = new Map();
  const events = [];
  const emit = (...event) => events.push(event);
  const first = fakePty(), second = fakePty();
  attachPty(registry, 'server', first, emit);
  stopPty(registry, 'server');
  attachPty(registry, 'server', second, emit);
  first.data('stale output');
  first.exit({ exitCode: 255 });
  assert.equal(registry.get('server'), second);
  assert.deepEqual(events, []);
  second.data('connected');
  assert.deepEqual(events, [['pty:data', { tabId: 'server', data: 'connected' }]]);
  second.exit({ exitCode: 0 });
  assert.equal(registry.has('server'), false);
  assert.deepEqual(events.at(-1), ['pty:exit', { tabId: 'server', exitCode: 0 }]);
});

test('SSH startup commands run after authentication through the remote command argument', () => {
  const init = 'cd /var/www # project directory';
  const { shell, args } = buildSshCommand({ host: 'example.test', user: 'alice', port: 2222, identity: '/keys/my key', init });
  assert.equal(shell, 'ssh');
  assert.deepEqual(args.slice(0, 4), ['-p', '2222', '-i', '/keys/my key']);
  assert.equal(args.includes('-t'), true);
  assert.equal(args.at(-2), 'alice@example.test');
  assert.equal(args.at(-1), init + '\nexec "${SHELL:-/bin/sh}" -l');
  const sftp = buildSshCommand({ host: 'example.test', port: 2222, mode: 'sftp', init });
  assert.equal(sftp.shell, 'sftp');
  assert.deepEqual(sftp.args.slice(0, 2), ['-P', '2222']);
  assert.equal(sftp.args.at(-1), 'example.test');
  assert.throws(() => buildSshCommand({ host: 'example.test', port: 65536 }), /port/);
  assert.throws(() => buildSshCommand({ host: '-oProxyCommand=anything' }), /address/);
});

test('saved connections survive reopening the store and a damaged primary file', (t) => {
  const store = temporaryStore(t);
  const saved = { workspaceProfiles: [{ id: 'global', tree: [{ type: 'host', host: 'example.test', user: 'alice', port: '2222', keyId: 'key-1' }] }] };
  store.set('state', saved);
  assert.deepEqual(new Store(store.dir).get('state'), saved);
  fs.writeFileSync(path.join(store.dir, 'state.json'), '{interrupted');
  assert.deepEqual(new Store(store.dir).get('state'), saved);
  store.set('state', { ...saved, themeId: 'paper' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.dir, 'state.json.bak'), 'utf8')), saved);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(store.dir, 'state.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(store.dir, 'state.json.bak')).mode & 0o777, 0o600);
  }
  store.delete('state');
  assert.equal(store.get('state', null), null);
});

test('unrecoverable data and failed writes are surfaced without replacing the primary', (t) => {
  const store = temporaryStore(t);
  const file = path.join(store.dir, 'state.json');
  fs.writeFileSync(file, '{damaged');
  assert.throws(() => store.get('state', null), /Could not read saved state/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{damaged');
  fs.writeFileSync(file, '{"hosts":["keep"]}');
  fs.mkdirSync(file + '.bak');
  assert.throws(() => store.set('state', { hosts: [] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hosts: ['keep'] });
  assert.equal(fs.readdirSync(store.dir).some((name) => name.endsWith('.tmp')), false);
});

// Load the real renderer without starting Electron or its initial local shell.
// Only terminal/DOM adapters and visual rendering are replaced; persistence,
// host creation, closing, reconnecting and exit handling run unchanged.
function renderer(store, overrides = {}) {
  const spawns = [], notices = [], writes = [], terminals = [], kills = [];
  const element = () => ({
    dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, remove() {}, querySelector() { return element(); },
  });
  class Terminal {
    constructor() {
      this.parser = { registerOscHandler() {} };
      this.options = {};
      this.output = '';
      terminals.push(this);
    }
    loadAddon() {}
    open() {}
    onData(fn) { this.input = fn; }
    onBell() {}
    onResize() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {}
    write(text) { this.output += text; }
    dispose() { this.disposed = true; }
  }
  class Addon { fit() {} }
  const api = {
    storeGet: async (key) => store.get(key, null),
    storeSet: async (key, value) => { writes.push(key); store.set(key, value); return true; },
    storeDelete: async (key) => store.delete(key),
    spawn: async (options) => { spawns.push(options); return { ok: true }; },
    kill(id) { kills.push(id); }, onData() {}, onExit() {}, onNotificationOpen() {}, onMenu() {},
    ...overrides,
  };
  const context = vm.createContext({
    window: {
      cocoAPI: api, Terminal, FitAddon: { FitAddon: Addon }, WebLinksAddon: { WebLinksAddon: Addon },
      SearchAddon: { SearchAddon: Addon }, SerializeAddon: { SerializeAddon: Addon },
      icon: () => '', addEventListener() {},
    },
    document: { createElement: element, getElementById: element },
    ResizeObserver: class {},
    setTimeout: () => 1, clearTimeout() {},
    console: { error() {} },
    notices,
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  vm.runInContext(source.slice(0, source.lastIndexOf('init().catch')), context);
  vm.runInContext(`
    let capturedForm;
    formModal = (options) => { capturedForm = options; return document.createElement('div'); };
    renderTree = () => {};
    renderLayout = () => {};
    updateStatus = () => {};
    updateTitle = () => {};
    setFocus = (id) => { activeId = id; };
    flashToast = (text) => notices.push(text);
    themeFont = () => 'monospace';
    themeById = () => ({ ui: { accent: '#123456' }, xterm: {} });
    globalThis.app = {
      state, live, loadState, persist, removeEphemeral, closeEntry, openTerminal,
      newHost, editHost, markTerminalExited, validateHost, savedHosts, findSavedHost,
      openSavedHost, deleteNode, deleteSavedHost, openHostAs, matchesFilter,
      removeWorkspaceKeepingConnections,
      form: () => capturedForm,
      layout: () => layout,
      prepareQuit: window.coco.prepareQuit,
    };
  `, context);
  return { app: context.app, api, spawns, notices, writes, terminals, kills };
}

const values = { name: 'Production', host: 'example.test', user: 'alice', port: '2222', keyId: 'identity', color: '', init: '' };

test('Save only preserves SSH details and keys across close, restore off, and relaunch', async (t) => {
  const store = temporaryStore(t);
  const first = renderer(store);
  await first.app.loadState();
  first.app.state.keys.push({ id: 'identity', name: 'Server key', path: '/keys/server' });
  first.app.newHost();
  assert.equal(first.app.form().secondarySubmitLabel, 'Save only');
  await first.app.form().onSubmit(values, 'secondary');
  assert.equal(first.spawns.length, 0);
  const host = first.app.state.tree[0];
  first.app.openTerminal(host);
  first.app.closeEntry(host.id);
  first.app.state.tree.push({ id: 'local', type: 'session', pinned: false });
  first.app.state.settings.restoreSessions = false;
  await first.app.prepareQuit();
  const second = renderer(store);
  await second.app.loadState();
  assert.equal(second.app.state.tree.length, 1);
  const restored = second.app.state.tree[0];
  for (const [key, value] of Object.entries(values)) assert.equal(restored[key], value);
  assert.equal(second.app.state.keys[0].path, '/keys/server');
  second.app.openTerminal(restored);
  assert.equal(second.spawns[0].ssh.identity, '/keys/server');
  assert.equal(second.spawns[0].ssh.port, '2222');
});

test('Save and connect waits for persistence and surfaces a failed save', async (t) => {
  let resolveSave;
  const first = renderer(temporaryStore(t), { storeSet: () => new Promise((resolve) => { resolveSave = resolve; }) });
  await first.app.loadState();
  first.app.newHost();
  const saving = first.app.form().onSubmit(values, 'primary');
  assert.equal(first.spawns.length, 0);
  resolveSave(true);
  await saving;
  assert.equal(first.spawns.length, 1);

  const failed = renderer(temporaryStore(t), { storeSet: async () => { throw new Error('disk full'); } });
  await failed.app.loadState();
  failed.app.newHost();
  await failed.app.form().onSubmit(values, 'primary');
  assert.equal(failed.spawns.length, 0);
  assert.equal(failed.notices.some((text) => /Could not save/.test(text)), true);
  assert.equal(failed.notices.some((text) => /connection saved/.test(text)), false);
});

test('clicking or pressing Enter reconnects a dead saved host in the same pane', async (t) => {
  const { app, spawns, terminals } = renderer(temporaryStore(t));
  await app.loadState();
  const host = { id: 'server', type: 'host', ...values };
  app.state.tree.push(host);
  app.openTerminal(host);
  app.openTerminal(host);
  assert.equal(spawns.length, 1);
  app.markTerminalExited(host.id);
  assert.match(terminals[0].output, /Press Enter.*reconnect/);
  app.openTerminal(host);
  assert.equal(spawns.length, 2);
  assert.equal(terminals[0].disposed, true);
  assert.equal(app.live.get(host.id).dead, false);
  assert.equal(app.layout().session, host.id);
  assert.equal(app.state.tree[0], host);
  app.markTerminalExited(host.id);
  terminals[1].input('\r');
  assert.equal(spawns.length, 3);
  assert.equal(terminals[1].disposed, true);
  assert.equal(app.live.get(host.id).dead, false);
});

test('SSH spawn failure is visible and the saved connection can retry', async (t) => {
  let attempts = 0;
  const { app, terminals } = renderer(temporaryStore(t), { spawn: async () => ++attempts === 1 ? { ok: false, error: 'SSH executable not found' } : { ok: true } });
  await app.loadState();
  const host = { id: 'server', type: 'host', ...values };
  app.state.tree.push(host);
  app.openTerminal(host);
  await Promise.resolve();
  assert.equal(app.live.get(host.id).dead, true);
  assert.match(terminals[0].output, /SSH executable not found/);
  app.openTerminal(host);
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(app.live.get(host.id).dead, false);
});

test('saved SSH startup commands are handed to OpenSSH instead of typed into authentication prompts', async (t) => {
  const { app, spawns } = renderer(temporaryStore(t));
  await app.loadState();
  const host = { id: 'server', type: 'host', ...values, init: 'cd /var/www' };
  app.state.tree.push(host);
  app.openTerminal(host);
  assert.equal(spawns[0].ssh.init, host.init);
  assert.equal(app.live.get(host.id)._initTimer, undefined);
});

test('an unreadable saved workspace cannot be overwritten while quitting', async (t) => {
  const { app, writes } = renderer(temporaryStore(t), { storeGet: async () => { throw new Error('unreadable workspace'); } });
  await assert.rejects(app.loadState(), /unreadable workspace/);
  assert.equal(await app.persist(), false);
  await app.prepareQuit();
  assert.deepEqual(writes, []);
});

test('removing a sidebar SSH entry preserves its independent connection inventory across relaunch', async (t) => {
  const store = temporaryStore(t);
  const first = renderer(store);
  await first.app.loadState();
  first.app.state.settings.confirmDelete = false;
  first.app.newHost();
  await first.app.form().onSubmit(values, 'primary');
  const host = first.app.state.tree[0];
  first.app.deleteNode(host.id);
  await first.app.persist();
  assert.equal(first.app.state.tree.length, 0);
  assert.equal(first.app.live.size, 0);
  assert.equal(first.app.savedHosts().length, 1);

  const second = renderer(store);
  await second.app.loadState();
  assert.equal(second.app.state.tree.length, 0);
  const saved = second.app.findSavedHost(host.id);
  assert.equal(saved.host, values.host);
  assert.equal(saved.keyId, values.keyId);
  second.app.openSavedHost(saved);
  assert.equal(second.spawns.length, 1);
  assert.equal(second.spawns[0].ssh.host, values.host);
  assert.equal(second.app.state.tree[0].id, host.id);
});

test('legacy nested hosts migrate before deleting their sidebar folder', async (t) => {
  const store = temporaryStore(t);
  const host = { id: 'legacy', type: 'host', ...values };
  store.set('state', { tree: [{ id: 'folder', type: 'folder', children: [host] }], keys: [{ id: 'identity', path: '/keys/server' }] });
  const first = renderer(store);
  await first.app.loadState();
  assert.equal(first.app.findSavedHost(host.id).host, host.host);
  first.app.state.settings.confirmDelete = false;
  first.app.deleteNode('folder');
  await first.app.persist();
  const second = renderer(store);
  await second.app.loadState();
  assert.equal(second.app.state.tree.length, 0);
  assert.equal(second.app.savedHosts().length, 1);
  second.app.openSavedHost(second.app.findSavedHost(host.id));
  assert.equal(second.spawns[0].ssh.identity, '/keys/server');
});

test('only deleting from SSH Connections removes the inventory and related terminal copies', async (t) => {
  const store = temporaryStore(t);
  const first = renderer(store);
  await first.app.loadState();
  first.app.state.settings.confirmDelete = false;
  first.app.newHost();
  await first.app.form().onSubmit(values, 'primary');
  const host = first.app.savedHosts()[0];
  first.app.openHostAs(host, false);
  await first.app.persist();
  assert.equal(first.app.live.size, 2);
  assert.equal(first.app.savedHosts().length, 1);
  first.app.deleteSavedHost(host.id);
  await first.app.persist();
  assert.equal(first.app.live.size, 0);
  assert.equal(first.app.state.tree.length, 0);
  assert.equal(first.app.savedHosts().length, 0);
  const second = renderer(store);
  await second.app.loadState();
  assert.equal(second.app.savedHosts().length, 0);
});

test('editing a saved connection without a sidebar entry persists and reopens the edited details', async (t) => {
  const store = temporaryStore(t);
  const first = renderer(store);
  await first.app.loadState();
  first.app.state.settings.confirmDelete = false;
  first.app.newHost();
  await first.app.form().onSubmit(values, 'secondary');
  const host = first.app.savedHosts()[0];
  first.app.deleteNode(host.id);
  first.app.editHost(host.id);
  await first.app.form().onSubmit({ ...values, host: 'updated.example.test', port: '2200' });
  const second = renderer(store);
  await second.app.loadState();
  second.app.openSavedHost(second.app.findSavedHost(host.id));
  assert.equal(second.spawns[0].ssh.host, 'updated.example.test');
  assert.equal(second.spawns[0].ssh.port, '2200');
  second.app.state.filter = 'updated';
  assert.equal(second.app.matchesFilter(second.app.state.tree[0]), true);
});

test('editing a connected host closes its original and duplicate shells before relabeling them', async (t) => {
  const store = temporaryStore(t);
  const killedHosts = [];
  const first = renderer(store, {
    kill(id) { killedHosts.push(first.app.state.tree.find((node) => node.id === id).host); },
  });
  await first.app.loadState();
  first.app.newHost();
  await first.app.form().onSubmit(values, 'primary');
  const host = first.app.savedHosts()[0];
  first.app.openHostAs(host, false);
  const duplicate = first.app.state.tree.find((node) => node.sourceHostId === host.id);
  const oldTerminals = first.terminals.slice();
  first.app.newHost();
  await first.app.form().onSubmit({ ...values, name: 'Other server', host: 'other.example.test' }, 'primary');
  const other = first.app.savedHosts()[1];
  const otherEntry = first.app.live.get(other.id);

  first.app.editHost(duplicate.id);
  await first.app.form().onSubmit({ ...values, name: 'Updated server', host: 'updated.example.test' });
  assert.deepEqual(killedHosts, [values.host, values.host], 'Old sessions must stop before their displayed identity changes');
  assert.equal(oldTerminals.every((terminal) => terminal.disposed), true);
  assert.equal(first.app.live.size, 1);
  assert.equal(first.app.live.get(other.id), otherEntry, 'Other servers must keep their sessions');
  assert.equal(first.app.layout().session, other.id);
  assert.equal(first.app.savedHosts().length, 2);
  assert.equal(host.host, 'updated.example.test');
  assert.equal(duplicate.host, host.host);
  assert.equal(first.spawns.length, 3, 'Saving does not silently authenticate another session');

  first.app.openSavedHost(host);
  first.app.openTerminal(duplicate);
  assert.deepEqual(first.spawns.slice(-2).map((spawn) => spawn.ssh.host), ['updated.example.test', 'updated.example.test']);
  const second = renderer(store);
  await second.app.loadState();
  assert.equal(second.app.findSavedHost(host.id).host, 'updated.example.test');
});

for (const [field, value] of Object.entries({ user: 'new-user', port: '2200', keyId: 'new-key', init: 'cd /srv/new-project' })) {
  test(`editing SSH ${field} requires a fresh connection`, async (t) => {
    const { app, spawns, kills } = renderer(temporaryStore(t));
    await app.loadState();
    app.state.keys.push({ id: 'identity', path: '/keys/original' }, { id: 'new-key', path: '/keys/updated' });
    app.newHost();
    await app.form().onSubmit(values, 'primary');
    const host = app.savedHosts()[0];
    app.editHost(host.id);
    await app.form().onSubmit({ ...values, [field]: value });
    assert.deepEqual(kills, [host.id]);
    assert.equal(app.live.has(host.id), false);
    app.openSavedHost(host);
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1].ssh[field === 'keyId' ? 'identity' : field], field === 'keyId' ? '/keys/updated' : value);
  });
}

test('renaming or recoloring a saved host preserves its connected shells', async (t) => {
  const { app, kills, spawns } = renderer(temporaryStore(t));
  await app.loadState();
  app.newHost();
  await app.form().onSubmit(values, 'primary');
  const host = app.savedHosts()[0];
  app.openHostAs(host, false);
  const original = app.live.get(host.id);
  const duplicate = app.state.tree.find((node) => node.sourceHostId === host.id);
  const duplicateEntry = app.live.get(duplicate.id);
  app.editHost(host.id);
  await app.form().onSubmit({ ...values, name: 'Renamed server', color: '#123456' });
  assert.deepEqual(kills, []);
  assert.equal(app.live.get(host.id), original);
  assert.equal(app.live.get(duplicate.id), duplicateEntry);
  assert.equal(host.name, 'Renamed server');
  assert.equal(duplicate.name, host.name);
  assert.equal(duplicate.color, host.color);
  app.openSavedHost(host);
  assert.equal(spawns.length, 2);
});

test('deleting a workspace moves its independent saved connections and key references to Default', async (t) => {
  const store = temporaryStore(t);
  const first = renderer(store);
  await first.app.loadState();
  const workspace = { id: 'work', name: 'Work', tree: [], savedHosts: [{ id: 'work-host', type: 'host', ...values }], keys: [{ id: 'identity', path: '/keys/work' }] };
  first.app.state.workspaceProfiles.push(workspace);
  await first.app.removeWorkspaceKeepingConnections(workspace);
  const second = renderer(store);
  await second.app.loadState();
  const host = second.app.findSavedHost('work-host');
  assert.equal(host.host, values.host);
  second.app.openSavedHost(host);
  assert.equal(second.spawns[0].ssh.identity, '/keys/work');
  assert.equal(second.app.state.workspaceProfiles.some((item) => item.id === 'work'), false);
});
