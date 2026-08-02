'use strict';

function normalizeOscPath(value, platform) {
  let result = decodeURIComponent(String(value || ''));
  if (platform === 'win32' && /^\/[A-Za-z]:\//.test(result)) {
    result = result.slice(1).replace(/\//g, '\\');
  }
  return result;
}

function displayBasename(value, home) {
  if (!value) return 'shell';
  if (value === home) return '~';
  const parts = String(value).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || (String(value).includes('\\') ? '\\' : '/');
}

const api = { normalizeOscPath, displayBasename };
if (typeof window !== 'undefined') window.CocoPaths = api;
if (typeof module !== 'undefined') module.exports = api;
