'use strict';

// A reconnect reuses the tab ID. Events from the process it replaced must not
// remove the new process or make its terminal appear disconnected.
function attachPty(registry, tabId, process, emit) {
  registry.set(tabId, process);
  process.onData((data) => {
    if (registry.get(tabId) === process) emit('pty:data', { tabId, data });
  });
  process.onExit(({ exitCode }) => {
    if (registry.get(tabId) !== process) return;
    registry.delete(tabId);
    emit('pty:exit', { tabId, exitCode });
  });
}

function stopPty(registry, tabId) {
  const process = registry.get(tabId);
  if (!process) return;
  // Remove first: kill() may synchronously deliver an exit callback.
  registry.delete(tabId);
  try { process.kill(); } catch {}
}

module.exports = { attachPty, stopPty };
