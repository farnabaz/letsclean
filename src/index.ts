#!/usr/bin/env node
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runUI } from "./ui.ts";

const arg = process.argv[2];
if (arg === "-h" || arg === "--help") {
  console.log(`letsclean [path]

OmniDiskSweeper-style disk explorer. Sizes stream in while you navigate.

  letsclean            scan the current directory
  letsclean ~          scan your home folder
  letsclean /Users     scan a chosen folder

Keys
  ↑↓ j k       move
  → l enter    open directory
  ← h bksp     back
  ctrl-o       reveal in Finder
  ctrl-d       move to Trash
  ctrl-y       copy path
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

runUI(root);
