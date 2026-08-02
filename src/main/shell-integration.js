'use strict';
// Generates shell-integration rc files so the spawned shell reports its
// current working directory back to coco via OSC 7. This is how the tab
// auto-naming ("tab name = current folder") stays accurate.
const fs = require('fs');
const path = require('path');
const os = require('os');

function writeZshIntegration(dir) {
  // We point ZDOTDIR at our own dir so we can hook precmd, but we must
  // re-source the user's real zsh dotfiles or their setup would break.
  const userZdotdir = process.env.ZDOTDIR || os.homedir();

  const passthrough = (name) => `# coco shell integration (${name})
COCO_USER_ZDOTDIR="${userZdotdir}"
if [[ -f "$COCO_USER_ZDOTDIR/${name}" ]]; then
  source "$COCO_USER_ZDOTDIR/${name}"
fi
`;

  fs.writeFileSync(path.join(dir, '.zshenv'), passthrough('.zshenv'));
  fs.writeFileSync(path.join(dir, '.zprofile'), passthrough('.zprofile'));
  fs.writeFileSync(path.join(dir, '.zlogin'), passthrough('.zlogin'));

  fs.writeFileSync(path.join(dir, '.zshrc'), `${passthrough('.zshrc')}
# --- coco: report cwd via OSC 7 on every prompt ---
_coco_report_cwd() {
  printf '\\033]7;file://%s%s\\033\\\\' "\${HOST:-localhost}" "$PWD"
}
# --- coco: command-block markers (OSC 133) + cwd, on every prompt ---
_coco_precmd() {
  local _ex=$?
  printf '\\033]133;D;%s\\007' "$_ex"   # previous command finished (exit code)
  _coco_report_cwd
  printf '\\033]133;A\\007'             # prompt start
}
# --- coco: report each command (OSC 633;E restore) + output start (OSC 133;C) ---
_coco_preexec() {
  printf '\\033]633;E;%s\\007' "$1"
  printf '\\033]133;C\\007'
}
autoload -Uz add-zsh-hook 2>/dev/null && {
  add-zsh-hook precmd _coco_precmd
  add-zsh-hook preexec _coco_preexec
}
# --- coco: silently load restored history (no echo, no execution) ---
if [[ -n "$COCO_RESTORE_HIST" && -f "$COCO_RESTORE_HIST" ]]; then
  fc -R "$COCO_RESTORE_HIST" 2>/dev/null
fi
_coco_report_cwd
`);
}

function writeBashIntegration(dir) {
  const rc = path.join(dir, 'coco.bashrc');
  fs.writeFileSync(rc, `# coco bash integration
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
_coco_report_cwd() { printf '\\033]7;file://%s%s\\033\\\\' "\${HOSTNAME:-localhost}" "$PWD"; }
_coco_prompt() {
  local _ex=$?
  _coco_in_prompt=1
  printf '\\033]133;D;%s\\007' "$_ex"
  _coco_report_cwd
  printf '\\033]133;A\\007'
  _coco_command_started=0
  _coco_in_prompt=0
}
_coco_preexec() {
  [[ "$_coco_in_prompt" == 1 || "$_coco_command_started" == 1 || -n "$COMP_LINE" ]] && return
  case "$BASH_COMMAND" in _coco_*|trap*|history*) return ;; esac
  _coco_command_started=1
  printf '\\033]633;E;%s\\007' "$BASH_COMMAND"
  printf '\\033]133;C\\007'
}
case "$PROMPT_COMMAND" in
  *_coco_prompt*) ;;
  *) PROMPT_COMMAND="_coco_prompt\${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac
trap '_coco_preexec' DEBUG
# coco: load restored history silently
if [[ -n "$COCO_RESTORE_HIST" && -f "$COCO_RESTORE_HIST" ]]; then
  history -r "$COCO_RESTORE_HIST"
fi
`);
  return rc;
}

function writePowerShellIntegration(dir) {
  const rc = path.join(dir, 'coco.ps1');
  fs.writeFileSync(rc, `# coco PowerShell integration
$userProfile = $PROFILE.CurrentUserCurrentHost
if (Test-Path $userProfile) { . $userProfile }

# Preserve a prompt supplied by the user's profile, then add OSC 7 cwd reports.
$global:CocoOriginalPrompt = $function:prompt
$global:CocoEsc = [char]27
if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
  $global:CocoOriginalHistoryHandler = (Get-PSReadLineOption).AddToHistoryHandler
  Set-PSReadLineOption -AddToHistoryHandler {
    param($line)
    [Console]::Write("$global:CocoEsc]633;E;$line\`a")
    [Console]::Write("$global:CocoEsc]133;C\`a")
    if ($global:CocoOriginalHistoryHandler) { return (& $global:CocoOriginalHistoryHandler $line) }
    return $true
  }
}
function global:prompt {
  $success = $?
  $exitCode = if ($success) { 0 } else { 1 }
  $uriPath = $PWD.Path.Replace('\\', '/')
  [Console]::Write("$global:CocoEsc]133;D;$exitCode\`a")
  [Console]::Write("$global:CocoEsc]7;file://localhost/$uriPath$global:CocoEsc\\")
  [Console]::Write("$global:CocoEsc]133;A\`a")
  if ($global:CocoOriginalPrompt) { return (& $global:CocoOriginalPrompt) }
  return "PS $($PWD.Path)> "
}
`);
  return rc;
}

function defaultShell(baseEnv = process.env, platform = process.platform) {
  if (baseEnv.COCO_SHELL) return baseEnv.COCO_SHELL;
  if (platform === 'win32') return baseEnv.SHELL || 'powershell.exe';
  return baseEnv.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

// Returns { shell, args, env } ready to hand to node-pty.
function buildSpawn(integrationDir, baseEnv = process.env, platform = process.platform) {
  const shell = defaultShell(baseEnv, platform);
  const env = { ...baseEnv, COCO_TERMINAL: '1', TERM_PROGRAM: 'coco' };
  let args = [];

  if (shell.endsWith('zsh')) {
    const zdir = path.join(integrationDir, 'zsh');
    fs.mkdirSync(zdir, { recursive: true });
    writeZshIntegration(zdir);
    env.ZDOTDIR = zdir;
    args = ['-i', '-l'];
  } else if (shell.endsWith('bash')) {
    const bdir = path.join(integrationDir, 'bash');
    fs.mkdirSync(bdir, { recursive: true });
    const rc = writeBashIntegration(bdir);
    args = ['--rcfile', rc, '-i'];
  } else if (/powershell(?:\.exe)?$/i.test(shell) || /pwsh(?:\.exe)?$/i.test(shell)) {
    const pdir = path.join(integrationDir, 'powershell');
    fs.mkdirSync(pdir, { recursive: true });
    const rc = writePowerShellIntegration(pdir);
    args = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', rc];
  } else if (platform === 'win32' && /cmd(?:\.exe)?$/i.test(shell)) {
    args = ['/Q'];
  } else {
    args = ['-i'];
  }
  return { shell, args, env };
}

module.exports = { buildSpawn, defaultShell };
