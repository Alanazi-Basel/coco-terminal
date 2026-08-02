const fs = require('fs');
const path = require('path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
const names = new Set();
for (const match of renderer.matchAll(/\bic\(\s*['"]([^'"]+)['"]/g)) names.add(match[1]);
[
  'folder', 'folder-open', 'terminal', 'square-terminal', 'pin', 'plus', 'x',
  'search', 'palette', 'panel-left', 'chevron-right', 'chevron-down',
  'folder-open-dot', 'folder-closed',
].forEach((name) => names.add(name));

const icons = {};
for (const name of [...names].sort()) {
  const filename = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons', `${name}.svg`);
  if (!fs.existsSync(filename)) {
    console.warn(`Missing icon: ${name}`);
    continue;
  }
  const svg = fs.readFileSync(filename, 'utf8');
  const body = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  icons[name] = body ? body[1].trim() : '';
}

const output = `"use strict";
// Auto-generated from lucide-static (ISC). Run scripts/rebuild-icons.cjs after adding icons.
window.COCO_ICONS = ${JSON.stringify(icons)};
window.icon = function (name, opts = {}) {
  const size = opts.size || 16; const sw = opts.stroke || 2;
  const cls = opts.class ? \` class="\${opts.class}"\` : "";
  const inner = window.COCO_ICONS[name] || "";
  return \`<svg\${cls} width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="\${sw}" stroke-linecap="round" stroke-linejoin="round">\${inner}</svg>\`;
};
`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'icons.js'), output);
