'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cocoAPI', {
  // pty
  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  input: (tabId, data) => ipcRenderer.send('pty:input', { tabId, data }),
  resize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  kill: (tabId) => ipcRenderer.send('pty:kill', { tabId }),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, p) => cb(p)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, p) => cb(p)),
  notify: (arg) => ipcRenderer.send('notification:show', arg),
  onNotificationOpen: (cb) => ipcRenderer.on('notification:open', (_e, p) => cb(p)),
  claudeNotificationStatus: () => ipcRenderer.invoke('claude:notification-status'),
  enableClaudeNotifications: () => ipcRenderer.invoke('claude:enable-notifications'),
  disableClaudeNotifications: () => ipcRenderer.invoke('claude:disable-notifications'),
  updateStatus: () => ipcRenderer.invoke('updates:status'),
  setAutomaticUpdates: (enabled) => ipcRenderer.invoke('updates:set-automatic', !!enabled),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // persistence
  storeGet: (key) => ipcRenderer.invoke('store:get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', { key, value }),
  storeDelete: (key) => ipcRenderer.invoke('store:delete', key),
  osInfo: () => ipcRenderer.invoke('os:info'),

  // reliable absolute path for a dropped File (Electron 30+)
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return file && file.path || ''; } },

  // SSH
  pickKeyFile: () => ipcRenderer.invoke('dialog:pick-key'),
  sshKeygen: (arg) => ipcRenderer.invoke('ssh:keygen', arg),

  // SFTP browser
  sftpConnect: (arg) => ipcRenderer.invoke('sftp:connect', arg),
  sftpList: (arg) => ipcRenderer.invoke('sftp:list', arg),
  sftpDownload: (arg) => ipcRenderer.invoke('sftp:download', arg),
  sftpUpload: (arg) => ipcRenderer.invoke('sftp:upload', arg),
  sftpMkdir: (arg) => ipcRenderer.invoke('sftp:mkdir', arg),
  sftpDelete: (arg) => ipcRenderer.invoke('sftp:delete', arg),
  sftpDisconnect: (arg) => ipcRenderer.invoke('sftp:disconnect', arg),
  fsList: (arg) => ipcRenderer.invoke('fs:list', arg),
  fsHome: () => ipcRenderer.invoke('fs:home'),

  // local domains (reverse proxy)
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxyEnable: (port) => ipcRenderer.invoke('proxy:enable', port),
  proxyDisable: () => ipcRenderer.invoke('proxy:disable'),
  proxySetMap: (map) => ipcRenderer.invoke('proxy:setmap', map),
  openExternal: (url) => ipcRenderer.send('domains:open', url),
  projectInfo: (cwd) => ipcRenderer.invoke('project:info', cwd),
  saveProjectDomain: (arg) => ipcRenderer.invoke('project:saveDomain', arg),
  portCheck: (port) => ipcRenderer.invoke('port:check', port),

  // port forwarding
  tunnelStart: (arg) => ipcRenderer.invoke('tunnel:start', arg),
  tunnelStop: (arg) => ipcRenderer.invoke('tunnel:stop', arg),
  tunnelRunning: () => ipcRenderer.invoke('tunnel:running'),
  onTunnelExit: (cb) => ipcRenderer.on('tunnel:exit', (_e, p) => cb(p)),

  // clipboard
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),

  // clickable file paths
  pathResolve: (arg) => ipcRenderer.invoke('path:resolve', arg),
  pathScanLine: (arg) => ipcRenderer.invoke('path:scan-line', arg),
  pathPreview: (arg) => ipcRenderer.invoke('path:preview', arg),
  pathOpen: (arg) => ipcRenderer.invoke('path:open', arg),
  openDirectoryWith: (cwd) => ipcRenderer.invoke('directory:open-with', cwd),

  // Git repository status and explicit user actions
  gitStatus: (cwd) => ipcRenderer.invoke('git:status', cwd),
  gitAction: (arg) => ipcRenderer.invoke('git:action', arg),

  // shortcuts
  getCommands: () => ipcRenderer.invoke('shortcuts:commands'),
  setBindings: (bindings) => ipcRenderer.invoke('shortcuts:set', bindings),
  captureShortcuts: (on) => ipcRenderer.invoke('shortcuts:capture', on),

  // menu events
  onMenu: (cb) => {
    const channels = [
      'new-tab', 'new-local', 'new-host', 'new-folder', 'close-tab', 'rename-tab', 'duplicate', 'pin',
      'next-tab', 'prev-tab', 'palette', 'themes', 'toggle-dock', 'toggle-layout', 'font-up',
      'font-down', 'find', 'copy-path', 'open-finder', 'copy-output', 'broadcast', 'focus-filter', 'shortcuts',
      'split-right', 'split-down', 'focus-next-pane', 'focus-prev-pane', 'prev-block', 'next-block',
      'save-workspace', 'workspaces', 'tunnels', 'domains',
    ];
    channels.forEach((c) => ipcRenderer.on(`menu:${c}`, () => cb(c)));
    ipcRenderer.on('menu:switch', (_e, index) => cb('switch', index));
  },
});
