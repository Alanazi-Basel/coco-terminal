'use strict';

function buildSshCommand(ssh) {
  const host = String(ssh.host || '').trim();
  const user = String(ssh.user || '').trim();
  const port = String(ssh.port || '22');
  if (!host || /^[\s-]|\s|[\x00-\x1f\x7f]/.test(host)) throw new Error('Enter a valid SSH server address.');
  if (/^[\s-]|\s|[\x00-\x1f\x7f]/.test(user)) throw new Error('Enter a valid SSH username.');
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('SSH port must be between 1 and 65535.');
  const sftp = ssh.mode === 'sftp';
  const args = [];
  if (port !== '22') args.push(sftp ? '-P' : '-p', port);
  if (ssh.identity) args.push('-i', ssh.identity);
  if (!sftp) args.push('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3');
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  const init = !sftp && typeof ssh.init === 'string' ? ssh.init.trim() : '';
  if (init) args.push('-t');
  args.push(user ? `${user}@${host}` : host);
  // OpenSSH sends this only after authentication. A fixed renderer timer can
  // accidentally type the startup command into a password/passphrase prompt.
  if (init) args.push(`${init}\nexec "\${SHELL:-/bin/sh}" -l`);
  return { shell: sftp ? 'sftp' : 'ssh', args };
}

module.exports = { buildSshCommand };
