'use strict';

// Wrap a 256x256 PNG in an ICO container. Modern Windows supports PNG-backed
// ICO entries, so this preserves the original artwork without recompression.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || path.join(root, 'assets', 'icon-256.png'));
const output = path.resolve(process.argv[3] || path.join(root, 'assets', 'icon.ico'));
const png = fs.readFileSync(source);

if (png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 1, 4) !== 'PNG') {
  throw new Error(`${source} is not a PNG file.`);
}
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== 256 || height !== 256) {
  throw new Error(`Windows icon source must be 256x256; received ${width}x${height}.`);
}

const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(1, 4); // one image
header.writeUInt8(0, 6); // 0 represents 256px
header.writeUInt8(0, 7);
header.writeUInt8(0, 8);
header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(header.length, 18);

fs.writeFileSync(output, Buffer.concat([header, png]));
console.log(`Created ${output}`);
