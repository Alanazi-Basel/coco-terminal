'use strict';
const fs = require('fs');
const path = require('path');

// Tiny synchronous JSON store. One file per key under userData.
class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  _file(key) {
    if (!/^[a-zA-Z0-9:_-]+$/.test(String(key || ''))) throw new Error('Invalid store key');
    return path.join(this.dir, `${key}.json`);
  }
  get(key, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this._file(key), 'utf8'));
    } catch {
      return fallback;
    }
  }
  set(key, value) {
    const tmp = this._file(key) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this._file(key)); // atomic-ish write
    try { fs.chmodSync(this._file(key), 0o600); } catch {}
  }
  delete(key) {
    try { fs.unlinkSync(this._file(key)); } catch {}
  }
}

module.exports = { Store };
