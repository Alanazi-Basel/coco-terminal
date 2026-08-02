'use strict';
// ASCII art for the coco banner. Rendered into each fresh terminal as text.
// Colors are applied with ANSI escape codes so it adapts to the active theme's
// accent. \x1b[38;2;R;G;Bm sets a truecolor foreground.

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const ART = [
  '   ▄████▄   ▒█████   ▄████▄   ▒█████  ',
  '  ▒██▀ ▀█  ▒██▒  ██▒▒██▀ ▀█  ▒██▒  ██▒',
  '  ▒▓█    ▄ ▒██░  ██▒▒▓█    ▄ ▒██░  ██▒',
  '  ▒▓▓▄ ▄██▒▒██   ██░▒▓▓▄ ▄██▒▒██   ██░',
  '  ▒ ▓███▀ ░░ ████▓▒░▒ ▓███▀ ░░ ████▓▒░',
  '  ░ ░▒ ▒  ░░ ▒░▒░▒░ ░ ░▒ ▒  ░░ ▒░▒░▒░ ',
];

// A tiny coconut mascot drawn beside the wordmark.
const MASCOT = [
  '    _.-._   ',
  '  .\'     \'. ',
  ' /  o   o  \\',
  ' |    ‿    |',
  '  \\  \\_/  / ',
  '   \'-...-\'  ',
];

function colorize(text, rgb) {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`;
}

// Build the full banner string (with \r\n) for a given theme + context line.
function buildBanner(theme, info) {
  const accent = hexToRgb(theme.ui.accent);
  const dim = hexToRgb(theme.ui.dim);
  const text = hexToRgb(theme.ui.text);

  const accent2 = hexToRgb(theme.ui.accent2 || theme.ui.accent);
  const lines = [];
  lines.push('');
  for (let i = 0; i < ART.length; i++) {
    const mascot = MASCOT[i] || '           ';
    lines.push('  ' + colorize(mascot, accent2) + '   ' + colorize(ART[i], accent));
  }
  lines.push('');
  lines.push('   ' + colorize('coco', accent) + colorize('  ·  a clean, organized workspace terminal', dim));
  if (info) {
    lines.push('   ' + colorize(info, text));
  }
  lines.push('   ' + colorize('⌘K palette  ·  ⌘T terminal  ·  ⌘P themes  ·  ⌘B dock', dim));
  lines.push('');
  // \x1b[?25h ensures cursor visible; carriage returns for terminal newlines.
  return lines.join('\r\n') + '\r\n';
}

window.COCO_LOGO = { buildBanner };
