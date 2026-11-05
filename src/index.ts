#!/usr/bin/env node
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { diskTool } from "./disk.ts";
import { nodeCleanTool } from "./node-clean.ts";
import { runShell } from "./shell.ts";

const args = process.argv.slice(2);
const nodejs = args.includes("--nodejs");
const arg = args.find((item) => !item.startsWith("-"));

if (args.includes("-h") || args.includes("--help")) {
  console.log(`letsclean [path]

OmniDiskSweeper-style disk explorer. Sizes stream in while you navigate.

  letsclean            scan the current directory
  letsclean ~          scan your home folder
  letsclean /Users     scan a chosen folder
  letsclean --nodejs ~ find node_modules and build caches to trash

Keys
  ↑↓ j k       move
  → l enter    open directory
  ← h bksp     back
  space tab    select / deselect row
  ctrl-a       select all in column
  esc          clear filter, then selection
  ctrl-o       reveal in Finder
  ctrl-d       move to Trash (selection)
  ctrl-y       copy path (selection)
  .            toggle hidden files
  /            filter the column
  ?            help
  q            quit
`);
  process.exit(0);
}

const root = resolve(arg ?? (process.cwd() || homedir()));
try {
  const stat = statSync(root);
  if (!stat.isDirectory()) {
    console.error(`${root} is not a directory`);
    process.exit(1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

runShell(nodejs ? nodeCleanTool(root) : diskTool(root));
