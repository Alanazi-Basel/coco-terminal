'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const builder = path.join(root, 'node_modules', '.bin', 'electron-builder');
const appPath = path.join(root, 'dist', 'mac-arm64', 'coco.app');
const entitlements = path.join(root, 'assets', 'entitlements.mac.plist');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

run(builder, ['--mac', 'dir', '--config.mac.identity=null']);
if (!fs.existsSync(appPath)) throw new Error(`Packaged app not found: ${appPath}`);

// An unsigned Electron executable can contain an incomplete linker signature.
// Seal the complete bundle so Gatekeeper reports an unsigned beta instead of a
// misleading “damaged” app. This is not a substitute for Developer ID signing.
run('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath]);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]);
run(builder, ['--mac', 'dmg', '--prepackaged', appPath]);

console.log('Built a structurally valid ad-hoc signed beta DMG.');
