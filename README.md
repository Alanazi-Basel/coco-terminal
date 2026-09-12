# coco 🥥

A free, clean terminal for macOS, Windows, and Linux. Built on
Electron + xterm.js + node-pty (real shells, full color, GPU rendering).

[Download Coco Terminal](https://coco-holding.com/terminal/) · [MIT license](LICENSE)

## Run

**Easiest on macOS:** double-click **`coco.command`**. First run installs
deps automatically, then launches the app and closes the helper window.

**From a terminal:**
```bash
npm install --omit=optional  # installs deps + rebuilds node-pty; SSH uses its supported JS fallback
npm start        # launch coco   (or: npm run app)
```

## Build desktop packages

```bash
npm run dist:mac    # DMG + ZIP
npm run dist:win    # Windows x64 NSIS installer (run on Windows)
npm run dist:linux  # Linux x86-64 AppImage (run on Linux)
```

Official release infrastructure and signing credentials are intentionally kept
outside the public repository.

## How it works

coco defaults to a **side dock**, where open terminals can be organized into
folders like a file tree. An optional top-bar layout is available from the
command palette. Click a terminal to focus it, or show several in split panes.
Saved servers live independently in **SSH Connections**, so closing or removing
a terminal from the dock preserves its connection for later.

## Features

- **Terminals inside folders** — open terminals appear in the dock and can be
  grouped into folders (and subfolders). A live dot shows which are running.
- **Drag to reorder & organize** — drag any session or folder; drop *between* rows
  to reorder, or *onto* a folder to move it inside. A glowing line shows where it
  will land.
- **Auto-named by folder** — each session's name tracks its current directory via
  shell integration (OSC 7). Rename inline anytime (the name then sticks).
- **Save & restore** — coco continuously saves workspace organization and, when
  **Restore sessions on launch** is enabled, reopens terminal entries and saved
  content. A restored shell is a new process. Saved SSH connections remain
  available even when terminal restoration is disabled.
- **Command palette** (⌘K) — fuzzy-run any action or jump to any session.
- **Context menus** — right-click rows for terminal, folder, rename, duplicate,
  path-copying, and removal actions appropriate to that entry.
- **Filter** (⌘L) — type to filter the dock to matching sessions.
- **Status bar** — current path, shell, open count, theme, and a clock.
- **18 themes** — Coco (default), Coco Light, Paper, Fax Machine, Midnight,
  Emerald, Amber CRT, Termius Dark/Light, Dracula, Nord, Tokyo Night, Gruvbox,
  One Dark, Solarized Dark, Synthwave, Cyberpunk, and Monokai. Open with ⌘P.
- **Clickable file paths** — paths *and* bare filenames/dirs of **any type** (anything
  `ls` prints — images, PDFs, text, folders) that actually exist are detected. They
  **underline when you hover**; **hold ⌘ (or Ctrl) while hovering** to show a preview
  (image thumbnail, text snippet, or folder listing + size). **⌘-click** opens in the OS
  default app; **⌥⌘-click** reveals in Finder. Handles spaces, `~`, and relative paths
  (resolved against the cwd).
- **Routine commands** — the ⚡ button (title bar) opens a dropdown of saved commands
  you can run with one click. Organize them into **categories** (folders) — **drag to
  reorder or drop a command into a category**; commands can also sit at the top level.
  Add/edit/remove, insert-without-running, or **run in a new split**. Also in the
  command palette and the terminal right-click menu under *Routine Commands ▸*.
- **Right-click a terminal** — Copy, Paste, run a routine command, split, or close pane.
- **Split panes** — split the focused pane right (⌘\) or down (⌘⇧\) to run several
  terminals side by side in one screen; drag the dividers to resize, ⌘] / ⌘[ to move
  focus, ⌘1–9 to jump to a pane. Each pane has its own close button.
- **Editable shortcuts** — open **Keyboard Shortcuts** (⌘,), click any shortcut and
  press the new keys (Backspace clears, Esc cancels). Conflicts are flagged; reset any
  one or all to defaults.
- **SSH Connections & keys** — save remote hosts (name, host, user, port, key)
  without connecting, then open them any time from **SSH Connections** (⌘⇧H).
  Closing a terminal or removing its dock entry preserves the saved host; only
  deleting it in SSH Connections removes it permanently. Password / host-key
  prompts appear inline in the terminal. Register private-key paths in
  **Manage SSH Keys** and choose them per host. Use the dock's server button,
  folder context menu, or command palette to manage connections.
- **Remote tools** — browse and transfer files through SFTP, and manage SSH port
  forwards. Desktop local-domain tools can map development services to local names.
- **Workspaces & layouts** — separate terminal organization, saved hosts, commands,
  keys, and domains; save split layouts and broadcast input to visible panes.
- **Git panel** — inspect and operate on the local repository for the active
  terminal when Git integration is enabled.
- **Drag a file in** — drag any file/folder from Finder onto a terminal to insert its
  shell-quoted path.
- **Crisp icons** — a bundled Lucide icon set (SVG), no emoji or bitmap images.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘T | New terminal |
| ⌘⇧N | New folder |
| ⌘⇧D | Duplicate terminal |
| ⌘W | Close terminal |
| ⌘R | Rename |
| ⌘⇧H | SSH Connections |
| ⌘⇧C | Copy current path |
| ⌘1…9 | Jump to terminal N |
| ⌃Tab / ⌃⇧Tab | Next / previous terminal |
| ⌘K | Command palette |
| ⌘P | Themes |
| ⌘L | Filter sessions |
| ⌘B | Toggle dock |
| ⌘F | Find in terminal |
| ⌘+ / ⌘- | Font size |

## Layout

```
src/
  main/
    main.js              Electron main: window, pty, persistence, quit/restore
    preload.js           contextBridge API
    store.js             tiny JSON store under userData
    shell-integration.js generates zsh/bash rc files for cwd reporting
  renderer/
    index.html           app shell
    styles.css           dock + status bar + palette + theme styling
    icons.js             bundled Lucide SVG icons (generated)
    themes.js            theme definitions
    logo.js              ASCII coco banner
    renderer.js          terminals, dock tree, drag/drop, palette, save/restore
```

Desktop workspace state and saved SSH profiles live under Electron's user-data
directory (`~/Library/Application Support/coco-terminal/data/` on macOS). Saved
SSH profiles are independent of open terminal entries. Data is never bundled
into the application or uploaded by coco.

## Open source and security

Coco Terminal is available under the [MIT license](LICENSE). Contributions are
welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues
privately by following [SECURITY.md](SECURITY.md), not through a public issue.
