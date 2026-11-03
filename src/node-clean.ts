import { execFile, spawn } from "node:child_process";
import { availableParallelism, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { fit, formatCount, formatRate, formatSize, padRight, sizeBar, visibleWidth } from "./format.ts";
import { trash } from "./trash.ts";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const INVERT = "\x1b[7m";
const SELECT = "\x1b[48;5;24m\x1b[97m";
const BAR = "\x1b[38;5;73m";
const HEADER = "\x1b[48;5;234m\x1b[97m";

/**
 * Directories that hold nothing you cannot regenerate. node_modules reinstalls;
 * the rest are build and tool caches.
 */
const JUNK = new Set([
  "node_modules",
  ".nuxt",
  ".next",
  ".turbo",
  ".output",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".yarn",
]);

const nativePath = fileURLToPath(new URL("../native/build/Release/scannative.node", import.meta.url));

/**
 * Two jobs, so the worker never has to report the whole tree back.
 * "find" returns only the junk directories and the names worth descending into.
 * "size" returns the allocated size of one directory, following nothing.
 */
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { readdirSync, lstatSync } = require("node:fs");
const { createRequire } = require("node:module");

let native = null;
try {
  native = createRequire(${JSON.stringify(nativePath)})(${JSON.stringify(nativePath)});
} catch (err) {
  native = null;
}

const JUNK = new Set(${JSON.stringify([...JUNK])});

function join(parent, name) {
  return parent === "/" ? "/" + name : parent + "/" + name;
}

function scanDir(path) {
  if (native) {
    const handle = native.open(path);
    const entries = [];
    try {
      for (;;) {
        const batch = native.read(handle);
        if (batch.done) break;
        for (let i = 0; i < batch.names.length; i++) {
          entries.push({ name: batch.names[i], kind: batch.kinds ? batch.kinds[i] : 0, size: batch.sizes ? batch.sizes[i] : 0 });
        }
      }
    } finally {
      try { native.close(handle); } catch (err) {}
    }
    return entries;
  }
  const dirents = readdirSync(path, { withFileTypes: true });
  return dirents.map((d) => ({
    name: d.name,
    kind: d.isSymbolicLink() ? 2 : d.isDirectory() ? 1 : 0,
    size: 0,
  }));
}

parentPort.on("message", (msg) => {
  if (msg.op === "find") {
    let entries;
    try {
      entries = scanDir(msg.path);
    } catch (err) {
      parentPort.postMessage({ id: msg.id, error: (err && err.code) || "unreadable", junk: [], descend: [] });
      return;
    }
    const junk = [];
    const descend = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if ((entry.kind & 2) !== 0 || (entry.kind & 1) === 0) continue;
      if (JUNK.has(entry.name)) junk.push(entry.name);
      else descend.push(entry.name);
    }
    parentPort.postMessage({ id: msg.id, junk: junk, descend: descend });
    return;
  }

  let size = 0;
  const stack = [msg.path];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = scanDir(current);
    } catch (err) {
      continue;
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if ((entry.kind & 2) !== 0) continue;
      if ((entry.kind & 1) !== 0) {
        stack.push(join(current, entry.name));
        continue;
      }
      if (entry.size > 0) {
        size += entry.size;
        continue;
      }
      try {
        const st = lstatSync(join(current, entry.name));
        size += st.blocks > 0 ? st.blocks * 512 : st.size;
      } catch (err) {}
    }
  }
  parentPort.postMessage({ id: msg.id, size: size });
});
`;

function reveal(path: string): void {
  const os = platform();
  if (os === "darwin") execFile("open", ["-R", path], () => {});
  else if (os === "win32") execFile("explorer", ["/select,", path], () => {});
  else execFile("xdg-open", [path], () => {});
}

function copyText(text: string): void {
  const os = platform();
  const command = os === "darwin" ? "pbcopy" : os === "win32" ? "clip" : "xclip";
  const args = os === "linux" ? ["-selection", "clipboard"] : [];
  const child = spawn(command, args);
  child.stdin.end(text);
  child.on("error", () => {
    if (os !== "linux") return;
    const fallback = spawn("wl-copy");
    fallback.stdin.end(text);
    fallback.on("error", () => {});
  });
}

function formatDuration(ms: number): string {
  if (ms < 10_000) return (ms / 1000).toFixed(1) + "s";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

interface Found {
  path: string;
  size: number | null;
  pending: boolean;
  error?: string;
  gone: boolean;
}

interface FindResult {
  id: number;
  junk?: string[];
  descend?: string[];
  size?: number;
  error?: string;
}

export async function runNodeClean(rootPath: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("letsclean --nodejs needs an interactive terminal.");
    process.exitCode = 1;
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25l");

  let stopped = false;
  const restore = (): void => {
    if (stopped) return;
    stopped = true;
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };

  const found: Found[] = [];
  let selected: Found | null = null;
  let scroll = 0;
  let confirm: Found | null = null;
  let confirmAll = false;
  let query = "";
  let filtering = false;
  let help = false;
  let message = "";
  let messageUntil = 0;
  let busy = false;

  let queued = 1;
  let running = 0;
  let measured = 0;
  let startedAt = Date.now();
  let finishedIn: number | null = null;

  const parallelism = Math.min(32, Math.max(4, availableParallelism() * 2));
  let nextId = 1;
  const pending = new Map<number, { resolve: (result: FindResult) => void }>();

  function ask(worker: Worker, op: string, path: string): Promise<FindResult> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      worker.postMessage({ id, op, path });
    });
  }

  const workers = Array.from({ length: parallelism }, () => {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.on("message", (msg: FindResult) => {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      waiter.resolve(msg);
    });
    return worker;
  });

  function stop(): void {
    for (const worker of workers) void worker.terminate();
    restore();
    process.exit(0);
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let renderScheduled = false;
  function scheduleRender(): void {
    if (renderScheduled || stopped) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      draw();
    }, 60);
  }

  const sizeQueue: Found[] = [];
  let sizing = 0;

  async function measureNext(): Promise<void> {
    const item = sizeQueue.shift();
    if (!item) return;
    sizing++;
    const worker = workers[sizing % workers.length]!;
    const result = await ask(worker, "size", item.path);
    item.size = result.size ?? 0;
    item.pending = false;
    measured++;
    sizing--;
    scheduleRender();
    void measureNext();
  }

  async function walk(dir: string): Promise<void> {
    running++;
    queued--;
    const worker = workers[running % workers.length]!;
    let result: FindResult;
    try {
      result = await ask(worker, "find", dir);
    } catch {
      result = { id: 0, junk: [], descend: [] };
    }
    running--;

    if (!result.error) {
      for (const name of result.junk ?? []) {
        const path = dir === "/" ? "/" + name : dir + "/" + name;
        const item: Found = { path, size: null, pending: true, gone: false };
        found.push(item);
        sizeQueue.push(item);
      }
      for (const name of result.descend ?? []) {
        queued++;
        void walk(dir === "/" ? "/" + name : dir + "/" + name);
      }
    }
    if (running === 0 && queued === 0 && finishedIn === null) finishedIn = Date.now() - startedAt;
    while (sizeQueue.length > 0 && sizing < parallelism) void measureNext();
    scheduleRender();
  }

  function visible(): Found[] {
    const needle = query.toLowerCase();
    return found
      .filter((item) => !item.gone && (needle === "" || item.path.toLowerCase().includes(needle)))
      .sort((a, b) => (b.size ?? -1) - (a.size ?? -1) || (a.path < b.path ? -1 : 1));
  }

  function padLine(text: string, width: number): string {
    const gap = width - visibleWidth(text.replaceAll(/\x1b\[[0-9;]*m/g, ""));
    return gap > 0 ? text + " ".repeat(gap) : text;
  }

  function draw(): void {
    if (stopped) return;
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const now = Date.now();
    const list = visible();
    const listH = Math.max(1, rows - 4);
    if (!selected || !list.includes(selected)) selected = list[0] ?? null;
    const cursor = selected ? list.indexOf(selected) : 0;
    if (cursor < scroll) scroll = cursor;
    if (cursor >= scroll + listH) scroll = cursor - listH + 1;

    const total = list.reduce((sum, item) => sum + (item.size ?? 0), 0);
    const elapsed = finishedIn ?? now - startedAt;
    const scanning = finishedIn === null;
    const spin = scanning ? SPIN[Math.floor(now / 80) % SPIN.length] : "";
    const status = scanning
      ? `${spin} ${formatCount(found.length)} found  ${measured} measured  ${BOLD}${formatDuration(elapsed)}${RESET}${HEADER}`
      : `${BOLD}done in ${formatDuration(elapsed)}${RESET}${HEADER}  ${formatCount(list.length)} dirs`;
    const right = `  ${formatSize(total).trim()} reclaimable   ${status} `;
    const title = ` letsclean  ${fit("--nodejs  " + rootPath, Math.max(0, cols - visibleWidth(stripAnsi(right)) - 12))}`;
    const lines = ["\x1b[H" + HEADER + padLine(title, cols - visibleWidth(stripAnsi(right))) + right + RESET];

    const biggest = list[0]?.size ?? 0;
    const sizeW = formatSize(0).length;
    const barW = cols >= 60 ? 10 : 0;
    const nameW = Math.max(1, cols - sizeW - 2 - (barW > 0 ? barW + 1 : 0));
    lines.push(DIM + padLine(" " + padRight("directory", nameW) + formatSize(total), cols) + RESET);

    for (let row = 0; row < listH; row++) {
      const item = list[scroll + row];
      if (!item) {
        lines.push(" ".repeat(cols));
        continue;
      }
      const selected = scroll + row === cursor;
      const size = item.pending ? "       …" : formatSize(item.size ?? 0);
      const rel = item.path.startsWith(rootPath) ? item.path.slice(rootPath.length + 1) || item.path : item.path;
      const bar = barW > 0 ? sizeBar(item.size ?? 0, biggest, barW) : "";
      const style = selected ? SELECT : "";
      const sizeColor = selected ? "" : GREEN;
      const text =
        style +
        sizeColor +
        size +
        RESET +
        style +
        " " +
        (selected ? "" : BAR) +
        bar +
        (bar ? RESET + style + " " : "") +
        fit(rel, nameW) +
        (item.error ? " " + item.error : "");
      lines.push(padLine(text, cols) + RESET);
    }

    const current = list[cursor];
    const filterLabel = query ? `  filter: ${query}${filtering ? "▍" : ""}` : "";
    const detail = (current ? current.path : rootPath) + filterLabel;
    lines.push(DIM + padLine(" " + fit(detail, cols - 1), cols) + RESET);

    let foot: string;
    if (confirm) foot = `${YELLOW}${BOLD} Trash ${confirm.path}? ${RESET}${YELLOW} y confirm   n cancel${RESET}`;
    else if (confirmAll) foot = `${YELLOW}${BOLD} Trash all ${formatCount(list.length)} (${formatSize(total).trim()})? ${RESET}${YELLOW} y confirm   n cancel${RESET}`;
    else if (message && now < messageUntil) foot = YELLOW + " " + message + RESET;
    else if (filtering) foot = `${BOLD}/${query}${RESET}  type to filter   ↑↓ move   ^o reveal   ^d trash   ^y copy   esc clear`;
    else foot = ` ${BOLD}↑↓${RESET} move  ${BOLD}^d${RESET} trash  ${BOLD}^a${RESET} trash all  ${BOLD}^o${RESET} finder  ${BOLD}^y${RESET} copy  ${BOLD}/${RESET} filter  ${BOLD}?${RESET} help  ${BOLD}q${RESET} quit`;
    lines.push(padLine(foot, cols));
    let frame = lines.join("\n");
    if (help) frame += renderHelp(cols, rows);
    process.stdout.write(frame);
  }

  function renderHelp(cols: number, rows: number): string {
    const body = [
      "letsclean --nodejs",
      "",
      "Finds directories you can regenerate:",
      "node_modules  .nuxt  .next  .turbo",
      ".output  .cache  .parcel-cache  .vite",
      "",
      "↑ ↓  j k     move",
      "ctrl-d        move to Trash",
      "ctrl-a        trash everything listed",
      "ctrl-o        reveal in Finder",
      "ctrl-y        copy path",
      "/            filter the list",
      "?            this help",
      "q  ctrl-c    quit",
      "",
      "Nothing is deleted outright. Both trash",
      "actions ask for confirmation first.",
      "",
      "any key closes",
    ];
    const width = 46;
    const top = Math.max(1, Math.floor((rows - body.length - 2) / 2));
    const left = Math.max(0, Math.floor((cols - width - 2) / 2));
    const border = "─".repeat(width);
    let out = `\x1b[${top};${left + 1}H${INVERT}┌${border}┐${RESET}`;
    for (let i = 0; i < body.length; i++) {
      out += `\x1b[${top + 1 + i};${left + 1}H${INVERT}│${padRight(" " + body[i]!, width)}│${RESET}`;
    }
    out += `\x1b[${top + 1 + body.length};${left + 1}H${INVERT}└${border}┘${RESET}`;
    return out;
  }

  async function remove(targets: Found[]): Promise<void> {
    busy = true;
    let failed = 0;
    let freed = 0;
    for (const item of targets) {
      message = "trashing " + item.path;
      scheduleRender();
      try {
        await trash(item.path);
        item.gone = true;
        freed += item.size ?? 0;
      } catch (error) {
        item.error = error instanceof Error ? error.message.replaceAll("\n", " ").slice(0, 80) : "failed";
        failed++;
      }
    }
    message = `trashed ${formatCount(targets.length - failed)}, freed ${formatSize(freed).trim()}` + (failed ? `, ${failed} failed` : "");
    messageUntil = Date.now() + 4000;
    busy = false;
    scheduleRender();
  }

  process.stdin.on("data", (chunk: Buffer) => {
    if (stopped) return;
    const text = chunk.toString("utf8");
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (help) {
        help = false;
        continue;
      }
      if (char === "\x03" || (char === "q" && !filtering && !confirm && !confirmAll)) {
        stop();
        return;
      }
      if (confirm || confirmAll) {
        if (char === "y" || char === "Y") {
          const targets = confirm ? [confirm] : visible();
          confirm = null;
          confirmAll = false;
          void remove(targets);
        } else if (char === "n" || char === "N" || char === "\x1b") {
          confirm = null;
          confirmAll = false;
        }
        continue;
      }
      if (busy) continue;
      const list = visible();
      const arrow = text.slice(i, i + 3);
      const cursor = selected ? list.indexOf(selected) : 0;
      if (arrow === "\x1b[A" || (!filtering && char === "k")) {
        selected = list[Math.max(0, cursor - 1)] ?? null;
        if (arrow === "\x1b[A") i += 2;
      } else if (arrow === "\x1b[B" || (!filtering && char === "j")) {
        selected = list[Math.min(list.length - 1, cursor + 1)] ?? null;
        if (arrow === "\x1b[B") i += 2;
      } else if (arrow === "\x1b[3~" || char === "\x7f" || char === "\b") {
        if (filtering && query) query = query.slice(0, -1);
        if (arrow === "\x1b[3~") i += 3;
      } else if (char === "\x1b" && text[i + 1] !== "[") {
        query = "";
        filtering = false;
      } else if (char === "/" && !filtering) {
        filtering = true;
      } else if (char === "?" && !filtering) {
        help = true;
      } else if (char === "\x04" && selected) {
        confirm = selected;
      } else if (!filtering && char === "\x01" && list.length > 0) {
        confirmAll = true;
      } else if (char === "\x0f" && selected) {
        reveal(selected.path);
      } else if (char === "\x19" && selected) {
        copyText(selected.path);
        message = "copied " + selected.path;
        messageUntil = Date.now() + 2500;
      } else if (filtering && char >= " " && char !== "\x7f") {
        query += char;
      }
    }
    scheduleRender();
  });

  void walk(rootPath);
  scheduleRender();
}
