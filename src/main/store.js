'use strict';
const fs = require('fs');
const path = require('path');
let writeCounter = 0;

function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.${++writeCounter}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

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
    const file = this._file(key);
    let readError;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      readError = error;
    }
    try {
      return JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    } catch (backupError) {
      if (readError.code === 'ENOENT' && backupError.code === 'ENOENT') return fallback;
      // Do not silently replace an unreadable workspace with an empty one.
      throw new Error(`Could not read saved ${key}. Your data has not been changed.`, { cause: readError });
    }
  }
  set(key, value) {
    const file = this._file(key);
    const contents = JSON.stringify(value, null, 2);
    if (contents === undefined) throw new Error('Cannot store an undefined value');
    let previous = contents;
    try {
      const current = fs.readFileSync(file, 'utf8');
      JSON.parse(current);
      previous = current;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      // If recovery was needed, preserve the good backup instead of copying
      // the damaged primary file over it.
      try {
        const backup = fs.readFileSync(file + '.bak', 'utf8');
        JSON.parse(backup);
        previous = backup;
      } catch (backupError) {
        if (backupError.code !== 'ENOENT' && !(backupError instanceof SyntaxError)) throw backupError;
      }
    }
    writeAtomic(file + '.bak', previous);
    writeAtomic(file, contents);
  }
  delete(key) {
    const file = this._file(key);
    for (const candidate of [file, file + '.bak']) {
      try { fs.unlinkSync(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

module.exports = { Store };
