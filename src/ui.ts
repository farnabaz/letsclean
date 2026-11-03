import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { trash } from "./trash.ts";
import type { Entry, Scanner } from "./scan.ts";
import { detach, fullPath, startScan } from "./scan.ts";
import { fit, formatCount, formatRate, formatSize, padRight, sizeBar, visibleWidth } from "./format.ts";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const INVERT = "\x1b[7m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const SELECT = "\x1b[48;5;24m\x1b[97m";
const OPEN = "\x1b[48;5;236m";
const BAR = "\x1b[38;5;73m";
const HEADER = "\x1b[48;5;234m\x1b[97m";

interface ColCache {
  gen: number;
  at: number;
  hidden: boolean;
  list: Entry[];
}

const orderCache = new WeakMap<Entry, ColCache>();

function ordered(entry: Entry, showHidden: boolean): Entry[] {
  const kids = entry.children;
  if (!kids) return [];
  const cache = orderCache.get(entry);
  if (cache && cache.hidden === showHidden && cache.gen === entry.gen) return cache.list;
  const list = showHidden ? kids.slice() : kids.filter((child) => child.name.charCodeAt(0) !== 46);
  list.sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  orderCache.set(entry, { gen: entry.gen, at: 0, hidden: showHidden, list });
  return list;
}

function formatDuration(ms: number): string {
  if (ms < 10_000) return (ms / 1000).toFixed(1) + "s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
}

function matches(entry: Entry, query: string): boolean {
  if (!query) return true;
  return entry.name.toLowerCase().includes(query);
}

interface UIState {
  stack: Entry[];
  cursor: Entry | null;
  scroll: Map<Entry, number>;
  showHidden: boolean;
  query: string;
  filtering: boolean;
  help: boolean;
  confirm: Entry | null;
  message: string;
  messageUntil: number;
  busy: boolean;
}

let restored = false;

function restoreTerminal(): void {
  if (restored) return;
  restored = true;
  process.stdout.write("\x1b[?25h\x1b[?7h\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

function reveal(path: string): void {
  const os = platform();
  if (os === "darwin") execFile("open", ["-R", path], () => {});
  else if (os === "win32") execFile("explorer", ["/select,", path], () => {});
  else execFile("xdg-open", [path], () => {});
}

function copyText(text: string): void {
  const os = platform();
  if (os === "darwin") {
    const child = spawn("pbcopy");
    child.stdin.end(text);
    return;
  }
  if (os === "win32") {
    const child = spawn("clip");
    child.stdin.end(text);
    return;
  }
  const child = spawn("xclip", ["-selection", "clipboard"]);
  child.stdin.end(text);
  child.on("error", () => {
    const fallback = spawn("wl-copy");
    fallback.stdin.end(text);
    fallback.on("error", () => {});
  });
}


export function runUI(rootPath: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("letsclean needs an interactive terminal.");
    process.exitCode = 1;
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[2J\x1b[H");

  let scanner: Scanner | null = null;
  const state: UIState = {
    stack: [],
    cursor: null,
    scroll: new Map(),
    showHidden: true,
    query: "",
    filtering: false,
    help: false,
    confirm: null,
    message: "",
    messageUntil: 0,
    busy: false,
  };

  let cols = process.stdout.columns || 80;
  let rows = process.stdout.rows || 24;
  let blocked = false;
  let renderScheduled = false;
  let lastRender = 0;
  let lastFiles = 0;
  let lastRateAt = Date.now();
  let rate = 0;
  let stopped = false;
  const startedAt = Date.now();
  let finishedIn: number | null = null;
  let rss = process.memoryUsage().rss;
  let lastRssAt = 0;

  function note(text: string): void {
    state.message = text;
    state.messageUntil = Date.now() + 3500;
  }

  function activeDir(): Entry | null {
    return state.stack[state.stack.length - 1] ?? null;
  }

  function activeList(force: boolean): Entry[] {
    const dir = activeDir();
    if (!dir) return [];
    const list = ordered(dir, state.showHidden);
    if (!state.query) return list;
    const query = state.query.toLowerCase();
    return list.filter((entry) => matches(entry, query));
  }

  function ensureCursor(list: Entry[]): void {
    if (list.length === 0) {
      state.cursor = null;
      return;
    }
    if (!state.cursor || !list.includes(state.cursor)) state.cursor = list[0]!;
  }

  function move(delta: number): void {
    const list = activeList(true);
    ensureCursor(list);
    if (list.length === 0 || !state.cursor) return;
    const index = list.indexOf(state.cursor);
    const next = Math.max(0, Math.min(list.length - 1, index + delta));
    state.cursor = list[next]!;
    followScroll(activeDir()!, list);
  }

  function followScroll(dir: Entry, list: Entry[]): void {
    const listH = Math.max(1, rows - 4);
    let scroll = state.scroll.get(dir) ?? 0;
    const index = state.cursor ? list.indexOf(state.cursor) : 0;
    if (index < scroll) scroll = index;
    if (index >= scroll + listH) scroll = index - listH + 1;
    if (scroll > Math.max(0, list.length - listH)) scroll = Math.max(0, list.length - listH);
    if (scroll < 0) scroll = 0;
    state.scroll.set(dir, scroll);
  }

  function enter(): void {
    const target = state.cursor;
    if (!target || target.kind !== "dir") return;
    state.stack.push(target);
    state.cursor = null;
    state.query = "";
    state.filtering = false;
    scanner?.focus(target);
    const list = activeList(true);
    ensureCursor(list);
    const dir = activeDir();
    if (dir) followScroll(dir, list);
  }

  function back(): void {
    if (state.stack.length <= 1) return;
    const leaving = state.stack.pop()!;
    state.cursor = leaving;
    state.query = "";
    state.filtering = false;
    const dir = activeDir();
    if (dir) {
      scanner?.focus(dir);
      followScroll(dir, activeList(true));
    }
  }

  function scheduleRender(immediate: boolean): void {
    if (stopped) return;
    if (immediate) {
      renderScheduled = false;
      draw();
      return;
    }
    if (renderScheduled) return;
    renderScheduled = true;
    const wait = Math.max(0, 70 - (Date.now() - lastRender));
    setTimeout(() => {
      renderScheduled = false;
      if (!stopped) draw();
    }, wait);
  }

  function draw(): void {
    if (blocked || stopped) return;
    lastRender = Date.now();
    const now = lastRender;
    if (scanner && !scanner.stats.done) {
      if (now - lastRateAt >= 400) {
        const files = scanner.stats.files;
        rate = ((files - lastFiles) * 1000) / (now - lastRateAt);
        lastFiles = files;
        lastRateAt = now;
      }
    } else if (scanner && finishedIn === null) {
      finishedIn = now - startedAt;
    }
    const frame = render(now);
    blocked = !process.stdout.write(frame);
  }

  function render(now: number): string {
    const lines: string[] = [];
    const spin = scanner && !scanner.stats.done ? SPIN[Math.floor(now / 80) % SPIN.length] : " ";
    const root = scanner?.root;
    const total = root ? formatSize(root.size).trim() : "…";
    const stats = scanner?.stats;
    const scanning = stats && !stats.done;
    if (now - lastRssAt > 1000) {
      rss = process.memoryUsage().rss;
      lastRssAt = now;
    }
    const elapsed = formatDuration(finishedIn ?? now - startedAt);
    const memory = formatSize(Math.max(stats?.memory ?? 0, rss)).trim();
    const files = formatCount(stats?.files ?? 0);
    const dirs = formatCount(stats?.dirs ?? 0);
    const errors = stats && stats.errors > 0 ? `  ${formatCount(stats.errors)} skipped` : "";
    const wide = cols >= 110;
    const counts = wide ? `${files} files  ${dirs} dirs` : `${files} files`;
    const status = scanning
      ? `${spin} ${counts}  ${formatRate(rate)}  ${memory}  ${BOLD}${elapsed}${RESET}${HEADER}`
      : `${BOLD}done in ${elapsed}${RESET}${HEADER}  ${counts}  ${memory}${errors}`;
    // Status is placed from the right edge so it stays visible as the terminal
    // narrows; the path takes whatever room is left.
    const right = `  ${total}   ${status}${scanning ? errors : ""} `;
    const pathWidth = Math.max(0, cols - visibleWidth(stripAnsi(right)) - 12);
    const title = ` letsclean  ${fit(rootPath, pathWidth)}`;
    lines.push(HEADER + padVisible(title, cols - visibleWidth(stripAnsi(right))) + right + RESET);

    const listH = Math.max(1, rows - 4);
    const shown = visibleStack();
    const colW = Math.max(1, Math.floor(cols / shown.length));
    const widths = shown.map((_, index) => (index === shown.length - 1 ? cols - colW * (shown.length - 1) : colW));

    const headerCells = shown.map((dir, index) => {
      const mark = dir.pending > 0 ? "…" : "";
      const label = (dir.parent ? dir.name : dir.path) + mark;
      const size = formatSize(dir.size);
      const inner = widths[index]! - 1;
      const nameW = Math.max(1, inner - size.length - 1);
      return padRight(fit(label, nameW), nameW) + " " + size;
    });
    lines.push(paintColumns(headerCells, widths, CYAN + BOLD, true) + RESET);

    const lists = shown.map((dir, index) => {
      const isActive = index === shown.length - 1;
      const list = ordered(dir, state.showHidden);
      if (isActive && state.query) return list.filter((entry) => matches(entry, state.query.toLowerCase()));
      return list;
    });

    const active = lists[lists.length - 1] ?? [];
    ensureCursor(active);
    const dir = activeDir();
    if (dir) followScroll(dir, active);

    for (let row = 0; row < listH; row++) {
      const cells: string[] = [];
      const styles: string[] = [];
      for (let c = 0; c < shown.length; c++) {
        const dirEntry = shown[c]!;
        const list = lists[c]!;
        const scroll = state.scroll.get(dirEntry) ?? 0;
        const entry = list[scroll + row];
        const isLast = c === shown.length - 1;
        const opened = !isLast && shown[c + 1] === entry;
        const selected = isLast && entry !== undefined && entry === state.cursor;
        const width = widths[c]!;
        if (!entry) {
          if (row === 0 && list.length === 0) {
            const placeholder = dirEntry.error
              ? RED + fit(dirEntry.error, width - 2)
              : dirEntry.listing || dirEntry.children === null
                ? DIM + " scanning…"
                : DIM + " empty";
            cells.push(padVisible(placeholder, width - 1));
            styles.push("");
          } else {
            cells.push(" ".repeat(Math.max(0, width - 1)));
            styles.push("");
          }
          continue;
        }
        cells.push(paintEntry(entry, width - 1, list, selected));
        styles.push(selected ? SELECT : opened ? OPEN : "");
      }
      lines.push(paintColumns(cells, widths, "", false, styles));
    }

    const selected = state.cursor;
    const detail = selected
      ? `${selected.kind === "dir" ? "dir " : selected.kind === "link" ? "link" : "file"}  ${formatSize(selected.size).trim()}${selected.pending > 0 ? "  …" : ""}  ${fullPath(selected)}${selected.error ? "  " + selected.error : ""}`
      : rootPath;
    const filterLabel = state.query ? `  filter: ${state.query}${state.filtering ? "▍" : ""}` : "";
    const detailLine = fit(detail, Math.max(0, cols - visibleWidth(filterLabel) - 1)) + filterLabel;
    lines.push(DIM + padVisible(" " + detailLine, cols) + RESET);

    let foot: string;
    if (state.confirm) {
      foot = `${YELLOW}${BOLD} Trash ${state.confirm.name}? ${RESET}${YELLOW} y confirm   n cancel${RESET}`;
    } else if (state.message && now < state.messageUntil) {
      foot = YELLOW + " " + state.message + RESET;
    } else if (state.filtering) {
      foot = `${BOLD}/${state.query}${RESET}  type to filter   ↑↓ move   ^o reveal   ^d trash   ^y copy   esc clear`;
    } else {
      const hidden = state.showHidden ? "shown" : "hidden";
      foot = ` ${BOLD}↑↓${RESET} move  ${BOLD}→${RESET} open  ${BOLD}←${RESET} back  ${BOLD}^o${RESET} finder  ${BOLD}^d${RESET} trash  ${BOLD}^y${RESET} copy  ${BOLD}.${RESET} ${hidden}  ${BOLD}/${RESET} filter  ${BOLD}?${RESET} help  ${BOLD}q${RESET} quit`;
    }
    lines.push(padVisible(foot, cols));

    let frame = "\x1b[H" + lines.join("\n");
    if (state.help) frame += renderHelp();
    return frame;
  }

  function renderHelp(): string {
    const body = [
      "letsclean",
      "",
      "↑ ↓  j k     move",
      "→  l  enter  open directory",
      "←  h  bksp   go back",
      "g G  home end jump",
      "pgup pgdn     page",
      "ctrl-o        reveal in Finder",
      "ctrl-d        move to Trash",
      "ctrl-y        copy path",
      ".            toggle hidden files",
      "/            filter this column",
      "?            this help",
      "q  ctrl-c    quit",
      "",
      "Sizes are allocated disk usage and grow",
      "while the scan is still running. The",
      "folder you are looking at is scanned first.",
      "",
      "any key closes",
    ];
    const width = 46;
    const top = Math.max(1, Math.floor((rows - body.length - 2) / 2));
    const left = Math.max(0, Math.floor((cols - width - 2) / 2));
    let out = "";
    const border = "─".repeat(width);
    out += `\x1b[${top};${left + 1}H${INVERT}┌${border}┐${RESET}`;
    for (let i = 0; i < body.length; i++) {
      out += `\x1b[${top + 1 + i};${left + 1}H${INVERT}│${padRight(" " + body[i]!, width)}│${RESET}`;
    }
    out += `\x1b[${top + 1 + body.length};${left + 1}H${INVERT}└${border}┘${RESET}`;
    return out;
  }

  function visibleStack(): Entry[] {
    if (state.stack.length === 0) return [];
    const minCol = 32;
    const maxCols = Math.max(1, Math.min(state.stack.length, Math.floor(cols / minCol)));
    return state.stack.slice(state.stack.length - maxCols);
  }

  function onData(chunk: Buffer): void {
    if (stopped) return;
    const text = chunk.toString("utf8");
    for (let i = 0; i < text.length; i++) {
      const key = readKey(text, i);
      i += key.length - 1;
      handleKey(key.kind, key.char);
    }
    scheduleRender(true);
  }

  function handleKey(kind: string, char: string): void {
    if (state.help) {
      state.help = false;
      return;
    }
    if (state.confirm) {
      if (char === "y" || char === "Y") void confirmTrash();
      else if (char === "n" || char === "N" || kind === "escape" || char === "q") state.confirm = null;
      return;
    }
    if (state.busy) return;

    // While typing a filter every printable key is text. Acting on it would
    // open or trash something the moment the query contained o, d or y.
    if (state.filtering && kind === "char") {
      if (char >= " " && char !== "\x7f") state.query += char;
      return;
    }

    switch (kind) {
      case "up":
        move(-1);
        return;
      case "k":
        if (state.filtering) return;
        move(-1);
        return;
      case "down":
        move(1);
        return;
      case "j":
        if (state.filtering) return;
        move(1);
        return;
      case "pageup":
        move(-(rows - 5));
        return;
      case "pagedown":
        move(rows - 5);
        return;
      case "home":
        move(-1_000_000);
        return;
      case "g":
        if (state.filtering) return;
        move(-1_000_000);
        return;
      case "end":
        move(1_000_000);
        return;
      case "G":
        if (state.filtering) return;
        move(1_000_000);
        return;
      case "right":
      case "enter":
        enter();
        return;
      case "l":
        if (state.filtering) return;
        enter();
        return;
      case "left":
      case "backspace":
        if (state.filtering && state.query) {
          state.query = state.query.slice(0, -1);
          return;
        }
        back();
        return;
      case "h":
        if (state.filtering) return;
        back();
        return;
      case "escape":
        state.query = "";
        state.filtering = false;
        return;
      case "filter":
        state.filtering = true;
        return;
      case "quit":
        if (state.filtering) {
          state.query = "";
          state.filtering = false;
          return;
        }
        shutdown();
        return;
      case "help":
        if (state.filtering) return;
        state.help = true;
        return;
      case "hidden":
        if (state.filtering) return;
        state.showHidden = !state.showHidden;
        state.cursor = null;
        return;
      case "open":
        if (state.cursor) reveal(fullPath(state.cursor));
        return;
      case "yank":
        if (state.cursor) {
          copyText(fullPath(state.cursor));
          note("copied " + fullPath(state.cursor));
        }
        return;
      case "delete":
        if (state.cursor && state.cursor.parent) state.confirm = state.cursor;
        return;
      default:
        return;
    }
  }

  async function confirmTrash(): Promise<void> {
    const target = state.confirm;
    state.confirm = null;
    if (!target || !target.parent || state.busy) return;
    state.busy = true;
    const path = fullPath(target);
    note("moving to Trash…");
    scheduleRender(true);
    try {
      await trash(path);
      const parent = target.parent;
      const listBefore = ordered(parent, state.showHidden);
      const index = listBefore.indexOf(target);
      detach(target);
      if (state.cursor === target) {
        const list = activeList(true);
        state.cursor = list[index] ?? list[index - 1] ?? list[0] ?? null;
      }
      note("trashed " + target.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : "trash failed";
      note(message.replaceAll("\n", " ").slice(0, 120));
    } finally {
      state.busy = false;
      scheduleRender(true);
    }
  }

  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    scanner?.stop();
    restoreTerminal();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", restoreTerminal);
  process.stdout.on("resize", () => {
    cols = process.stdout.columns || 80;
    rows = process.stdout.rows || 24;
    scheduleRender(true);
  });
  process.stdout.on("drain", () => {
    blocked = false;
    scheduleRender(false);
  });
  process.stdin.on("data", onData);

  scanner = startScan(rootPath, () => scheduleRender(false));
  state.stack = [scanner.root];
  scanner.focus(scanner.root);
  scheduleRender(true);
}

function paintEntry(entry: Entry, width: number, siblings: Entry[], selected: boolean): string {
  const size = formatSize(entry.size);
  const pending = entry.kind === "dir" && (entry.pending > 0 || entry.children === null) ? "…" : "";
  const suffix = entry.kind === "dir" ? "/" : entry.kind === "link" ? "@" : "";
  const barW = width >= 36 ? 8 : 0;
  const nameW = width - size.length - 1 - (barW > 0 ? barW + 1 : 0) - pending.length;
  const max = siblings[0]?.size ?? 0;
  const nameColor = selected ? "" : entry.kind === "dir" ? CYAN : entry.kind === "link" ? MAGENTA : "";
  const sizeColor = selected ? "" : GREEN;
  const name = fit(entry.name + suffix, Math.max(1, nameW));
  const bar = barW > 0 ? sizeBar(entry.size, max, barW) : "";
  const core =
    sizeColor +
    size +
    RESET +
    (selected ? SELECT : "") +
    " " +
    (selected ? "" : BAR) +
    bar +
    (bar ? RESET + (selected ? SELECT : "") + " " : "") +
    nameColor +
    name +
    (selected ? "" : RESET) +
    (selected ? SELECT : YELLOW) +
    pending;
  return padVisible(core, width);
}

function paintColumns(cells: string[], widths: number[], style: string, header: boolean, styles?: string[]): string {
  let out = "";
  for (let i = 0; i < cells.length; i++) {
    const bg = styles?.[i] ?? "";
    const sep = i === cells.length - 1 ? "" : DIM + "│" + RESET;
    out += bg + style + cells[i] + RESET + sep;
    if (header) {
      // style already applied by caller via ANSI inside the padded cell
    }
  }
  return out;
}

/** Pad using visible width so ANSI color codes don't consume columns. */
function padVisible(text: string, width: number): string {
  const gap = width - visibleWidth(stripAnsi(text));
  if (gap <= 0) return text;
  return text + " ".repeat(gap);
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

interface Key {
  kind: string;
  char: string;
  length: number;
}

function readKey(text: string, index: number): Key {
  const char = text[index]!;
  if (char === "\x1b") {
    const rest = text.slice(index);
    if (rest.startsWith("\x1b[A") || rest.startsWith("\x1bOA")) return { kind: "up", char: "", length: 3 };
    if (rest.startsWith("\x1b[B") || rest.startsWith("\x1bOB")) return { kind: "down", char: "", length: 3 };
    if (rest.startsWith("\x1b[C") || rest.startsWith("\x1bOC")) return { kind: "right", char: "", length: 3 };
    if (rest.startsWith("\x1b[D") || rest.startsWith("\x1bOD")) return { kind: "left", char: "", length: 3 };
    if (rest.startsWith("\x1b[5~")) return { kind: "pageup", char: "", length: 4 };
    if (rest.startsWith("\x1b[6~")) return { kind: "pagedown", char: "", length: 4 };
    if (rest.startsWith("\x1b[H") || rest.startsWith("\x1b[1~") || rest.startsWith("\x1bOH")) {
      return { kind: "home", char: "", length: rest.startsWith("\x1b[1~") ? 4 : 3 };
    }
    if (rest.startsWith("\x1b[F") || rest.startsWith("\x1b[4~") || rest.startsWith("\x1bOF")) {
      return { kind: "end", char: "", length: rest.startsWith("\x1b[4~") ? 4 : 3 };
    }
    if (rest === "\x1b" || rest.startsWith("\x1b") && rest.length === 1) return { kind: "escape", char: "", length: 1 };
    // Swallow incomplete or unknown escape sequences up to a letter or tilde.
    let length = 1;
    while (length < rest.length && length < 8) {
      const code = rest.charCodeAt(length);
      length++;
      if ((code >= 64 && code <= 126) || code === 126) break;
    }
    if (length === 1) return { kind: "escape", char: "", length: 1 };
    return { kind: "ignore", char: "", length };
  }
  if (char === "\r" || char === "\n") return { kind: "enter", char, length: 1 };
  if (char === "\x7f" || char === "\b") return { kind: "backspace", char, length: 1 };
  // ctrl-c always quits; the letter keys also answer to ctrl so they stay
  // usable while a filter treats plain letters as text.
  if (char === "\x03") return { kind: "quit", char, length: 1 };
  if (char === "\x0f") return { kind: "open", char, length: 1 };
  if (char === "\x04") return { kind: "delete", char, length: 1 };
  if (char === "\x19") return { kind: "yank", char, length: 1 };
  if (char === "\x11") return { kind: "quit", char, length: 1 };
  if (char === "q") return { kind: "quit", char, length: 1 };
  if (char === "?") return { kind: "help", char, length: 1 };
  if (char === "/") return { kind: "filter", char, length: 1 };
  if (char === ".") return { kind: "hidden", char, length: 1 };
  if (char === "j" || char === "k" || char === "h" || char === "l" || char === "g" || char === "G") {
    return { kind: char, char, length: 1 };
  }
  if (char === "\x1b") return { kind: "escape", char, length: 1 };
  return { kind: "char", char, length: 1 };
}
