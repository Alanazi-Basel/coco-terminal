#!/bin/bash
# Double-click this file in Finder to launch coco.
# (Right-click → Open the first time if macOS Gatekeeper warns.)
cd "$(dirname "$0")" || exit 1

# install deps on first run
if [ ! -d node_modules ]; then
  echo "First run — installing dependencies (this happens once)…"
  npm install || { echo "npm install failed"; read -r; exit 1; }
fi

# kill any previous coco instance so we never stack a new window over a stale one
pkill -9 -f "coco-terminal/node_modules/electron" 2>/dev/null
sleep 1

# launch detached so closing this window doesn't kill the app
./node_modules/.bin/electron . >/dev/null 2>&1 &
sleep 1
# close the helper Terminal window
osascript -e 'tell application "Terminal" to close (every window whose name contains "coco.command")' >/dev/null 2>&1 &
exit 0
