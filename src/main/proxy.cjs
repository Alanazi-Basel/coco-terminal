'use strict';
// coco local-domains reverse proxy. Runs as root (to bind :80 and edit /etc/hosts).
// argv: <mapFile> <pidFile>.  Map file: { "shop.local": 3000, ... } (hot-reloaded).
const http = require('http');
const net = require('net');
const fs = require('fs');
const cp = require('child_process');

const mapFile = process.argv[2];
const pidFile = process.argv[3];
let map = {};

const START = '# === coco-domains (managed by coco — do not edit) START ===';
const END = '# === coco-domains (managed by coco) END ===';

function syncHosts() {
  try {
    const cur = fs.readFileSync('/etc/hosts', 'utf8');
    const hosts = Object.keys(map).filter((h) => !/\.localhost$/i.test(h));
    const block = hosts.length ? START + '\n' + hosts.map((h) => '127.0.0.1 ' + h + '\n::1 ' + h).join('\n') + '\n' + END : '';
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\n*' + esc(START) + '[\\s\\S]*?' + esc(END) + '\\n*', 'm');
    let base = cur.replace(re, '\n').replace(/\n+$/, '\n');
    const out = block ? base + (base.endsWith('\n') ? '' : '\n') + block + '\n' : base;
    if (out !== cur) {
      fs.writeFileSync('/etc/hosts', out);
      cp.exec('dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null', () => {});
    }
  } catch (e) {}
}
function load() {
  try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) || {}; } catch { map = {}; }
  syncHosts();
}
load();
try { fs.watchFile(mapFile, { interval: 700 }, load); } catch {}
try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}

function portFor(host) { host = String(host || '').split(':')[0].toLowerCase(); return map[host]; }

const server = http.createServer((req, res) => {
  const port = portFor(req.headers.host);
  if (!port) { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<h2 style="font-family:system-ui">coco: no app mapped to ' + (req.headers.host || '?') + '</h2>'); return; }
  const p = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
  p.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('coco: nothing answering on 127.0.0.1:' + port); });
  req.pipe(p);
});
server.on('upgrade', (req, socket, head) => {
  const port = portFor(req.headers.host); if (!port) { socket.destroy(); return; }
  const up = net.connect(port, '127.0.0.1', () => {
    let s = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
    for (let i = 0; i < req.rawHeaders.length; i += 2) s += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
    s += '\r\n';
    up.write(Buffer.concat([Buffer.from(s), head])); up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
});
const PORT = Number(process.env.COCO_PROXY_PORT) || 80;
server.listen(PORT, () => console.log('coco-proxy on :' + PORT));
function bye() { try { map = {}; syncHosts(); } catch {} process.exit(0); } // clean /etc/hosts on stop
process.on('SIGTERM', bye); process.on('SIGINT', bye);
