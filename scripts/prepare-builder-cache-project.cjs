'use strict';

// Creates a source-free Electron shell used only to prefetch electron-builder's
// public runtime/tool caches. The real application is compiled later offline.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = path.resolve(process.argv[2] || '');
if (!target || target === root) throw new Error('Provide an isolated target directory.');

fs.mkdirSync(path.join(target, 'src', 'main'), { recursive: true });
fs.mkdirSync(path.join(target, 'assets'), { recursive: true });
fs.writeFileSync(path.join(target, 'src', 'main', 'main.js'), "require('electron').app.whenReady().then(() => require('electron').app.quit());\n");
for (const name of ['icon-source.png', 'icon-256.png', 'icon.ico', 'entitlements.mac.plist']) {
  const source = path.join(root, 'assets', name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, 'assets', name));
}
console.log(`Prepared source-free cache project at ${target}`);
