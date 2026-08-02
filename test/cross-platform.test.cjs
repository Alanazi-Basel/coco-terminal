'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSpawn, defaultShell } = require('../src/main/shell-integration');
const { normalizeOscPath, displayBasename } = require('../src/renderer/platform-paths');

test('selects a native default shell for each desktop platform', () => {
  assert.equal(defaultShell({}, 'darwin'), '/bin/zsh');
  assert.equal(defaultShell({}, 'linux'), '/bin/bash');
  assert.equal(defaultShell({}, 'win32'), 'powershell.exe');
  assert.equal(defaultShell({ COCO_SHELL: 'pwsh.exe' }, 'win32'), 'pwsh.exe');
});

test('creates PowerShell cwd integration on Windows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-shell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = buildSpawn(dir, {}, 'win32');
  assert.equal(result.shell, 'powershell.exe');
  assert.deepEqual(result.args.slice(0, 4), ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass']);
  const integration = result.args.at(-1);
  assert.equal(fs.existsSync(integration), true);
  const source = fs.readFileSync(integration, 'utf8');
  assert.match(source, /OSC 7 cwd reports/);
  assert.match(source, /file:\/\/localhost/);
  assert.match(source, /]633;E;/);
  assert.match(source, /]133;C/);
});

test('normalizes Windows OSC 7 file URLs into native paths', () => {
  assert.equal(normalizeOscPath('/C:/Users/Alice/My%20Project', 'win32'), 'C:\\Users\\Alice\\My Project');
  assert.equal(displayBasename('C:\\Users\\Alice\\My Project', 'C:\\Users\\Alice'), 'My Project');
  assert.equal(normalizeOscPath('/home/alice/My%20Project', 'linux'), '/home/alice/My Project');
});

test('creates Bash cwd integration on Linux', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-shell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = buildSpawn(dir, {}, 'linux');
  assert.equal(result.shell, '/bin/bash');
  assert.equal(result.args[0], '--rcfile');
  assert.equal(fs.existsSync(result.args[1]), true);
  const source = fs.readFileSync(result.args[1], 'utf8');
  assert.match(source, /]633;E;/);
  assert.match(source, /]133;D;/);
});

test('defines installable and updateable Windows and Linux packages', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.build.win.target[0].target, 'nsis');
  assert.deepEqual(pkg.build.win.target[0].arch, ['x64']);
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.linux.target[0].target, 'AppImage');
  assert.deepEqual(pkg.build.linux.target[0].arch, ['x64']);
  assert.equal(pkg.build.publish[0].url, 'https://tarout.sa/api/storage/gateway/cmrsa7oqw00je01pjsvkc2wk7/stable');
});
