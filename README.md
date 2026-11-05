# letsclean

[![npm version](https://img.shields.io/npm/v/letsclean?color=black)](https://npmx.dev/letsclean)
[![npm downloads](https://img.shields.io/npm/dm/letsclean?color=black)](https://npmx.dev/package-stats/letsclean/v/latest?granularity=monthly)
[![license](https://img.shields.io/github/license/farnabaz/letsclean?color=black)](https://github.com/farnabaz/letsclean/blob/main/LICENSE)

OmniDiskSweeper-style disk explorer for the terminal. Sizes stream in while you navigate, so you can start deleting before the scan finishes.

Directory reads use `readdir` plus `lstat`. On macOS, a local native addon (`getattrlistbulk`: name, type, and allocated size in one syscall per batch) is used automatically if you have built it.

## Install

Run it without installing:

```sh
npx letsclean
```

Or install it globally:

```sh
npm install -g letsclean
```

Requires Node.js 22.18 or newer. Nothing is compiled on install.

## Use

```sh
letsclean            # scan the current directory
letsclean ~          # scan your home folder
letsclean /Users     # scan a chosen folder
letsclean --nodejs ~ # find node_modules and build caches
```

### Keys

| Key | Action |
| --- | --- |
| `↑` `↓` `j` `k` | move |
| `→` `l` `enter` | open directory |
| `←` `h` `backspace` | back |
| `space` `tab` | select / deselect row |
| `ctrl-a` | select all in column (again to clear) |
| `esc` | clear filter, then clear selection |
| `ctrl-o` | reveal in Finder |
| `ctrl-d` | move to Trash (all selected rows) |
| `ctrl-y` | copy path (all selected rows, one per line) |
| `.` | toggle hidden files |
| `/` | filter the column |
| `?` | help |
| `q` | quit |

`--nodejs` lists directories you can regenerate (`node_modules`, `.next`, `.nuxt`, `.turbo`, `.cache`, and similar) and moves the ones you pick to Trash. Nothing is unlinked. It uses the same keys as the default view; `ctrl-a` then `ctrl-d` trashes everything listed.

## Tools

Every mode is a *tool* plugged into one shared terminal UI (`src/shell.ts`), which owns navigation, filtering, selection, help, and the trash / copy / reveal actions. A tool (`src/disk.ts`, `src/node-clean.ts`) only supplies a tree of `Node`s and a few hooks (`path`, `stats`, `detach`, optional `focus` / `canOpen`). To add a mode, write a `ToolFactory` and pass it to `runShell` in `src/index.ts`.

## Develop

```sh
npm install
npm start -- ~
```

`npm start` runs the TypeScript directly via Node's type stripper. `npm run build` compiles `dist/`.

The published package is JS only. To use the faster macOS scanner locally (needs Xcode command line tools):

```sh
npm run rebuild
```

