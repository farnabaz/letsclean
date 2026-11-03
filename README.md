# letsclean

OmniDiskSweeper-style disk explorer for the terminal. Sizes stream in while you navigate, so you can start deleting before the scan finishes.

Directory reads use `readdir` plus `lstat`. On macOS, a local native addon (`getattrlistbulk`: name, type, and allocated size in one syscall per batch) is used automatically if you have built it.

## Install

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
| `ctrl-o` | reveal in Finder |
| `ctrl-d` | move to Trash |
| `ctrl-y` | copy path |
| `.` | toggle hidden files |
| `/` | filter the column |
| `?` | help |
| `q` | quit |

`--nodejs` lists directories you can regenerate (`node_modules`, `.next`, `.nuxt`, `.turbo`, `.cache`, and similar) and moves the ones you pick to Trash. Nothing is unlinked.

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
