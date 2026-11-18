import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { lstatSync } from "node:fs";
import { basename } from "node:path";
import type { SizedPath } from "./trash.ts";
import { emptyTrash, listTrash, sizePaths, trash, trashMany } from "./trash.ts";
import type { VolumeSpace } from "./volume.ts";
import { listVolumes } from "./volume.ts";
import { fit, formatCount, formatSize, padRight, sizeBar, visibleWidth } from "./format.ts";

/**
 * The interactive terminal UI every tool shares: columns, cursor, filter,
 * selection, help, confirmation and the trash / copy / reveal actions. A tool
 * only provides a tree of nodes and a few hooks (see `Tool`).
 */

export type Kind = "dir" | "file" | "link";

/** What the shell needs from a row. The disk scanner's `Entry` fits as is. */
export interface Node {
  name: string;
  parent: Node | null;
  kind: Kind;
  /** Bytes, including descendants found so far. */
  size: number;
  /** Ordered by the shell; `null` while not listed yet. */
  children: Node[] | null;
  /** Work still outstanding in this subtree; shows a "…" while > 0. */
  pending: number;
  /** The directory itself is still being listed. */
  listing?: boolean;
  dead: boolean;
  error?: string;
  /** Bump whenever children or their sizes change so the column re-sorts. */
  gen: number;
}

export interface ToolStats {
  scanning: boolean;
  /** Shown next to the spinner / timer, e.g. "1,234 files". */
  info: string;
  /** The headline size, e.g. "12 GB" or "3 GB reclaimable". */
  total: string;
}

export interface Tool {
  /** Shown in the header and the help box, e.g. "letsclean --nodejs". */
  name: string;
  root: Node;
  /** Extra lines appended to the help box. */
  help: string[];
  /** Offer the `.` key to hide dotfiles. */
  hiddenToggle?: boolean;
  path(node: Node): string;
  stats(now: number, cols: number): ToolStats;
  /** Whether → opens this node as a new column. Defaults to directories. */
  canOpen?(node: Node): boolean;
  /** Called when a column becomes the active one. */
  focus?(dir: Node): void;
  /** Remove a node that was moved to Trash from the tree. */
  detach(node: Node): void;
  stop(): void;
}

/** A tool is built with a callback it calls whenever its data changes. */
export type ToolFactory = (update: () => void) => Tool;

/** Narrowest a parent column may get before older columns are dropped. */
const MIN_PARENT_COL = 24;

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
const PANEL = "\x1b[48;5;235m\x1b[97m";
const DANGER = "\x1b[41m\x1b[97m";

interface ColCache {
  gen: number;
  hidden: boolean;
  list: Node[];
}

const orderCache = new WeakMap<Node, ColCache>();

function ordered(node: Node, showHidden: boolean): Node[] {
  const kids = node.children;
  if (!kids) return [];
  const cache = orderCache.get(node);
  if (cache && cache.hidden === showHidden && cache.gen === node.gen) return cache.list;
  const list = showHidden ? kids.slice() : kids.filter((child) => child.name.charCodeAt(0) !== 46);
  list.sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  orderCache.set(node, { gen: node.gen, hidden: showHidden, list });
  return list;
}

function formatDuration(ms: number): string {
  if (ms < 10_000) return (ms / 1000).toFixed(1) + "s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
}

function matches(node: Node, query: string): boolean {
  if (!query) return true;
  return node.name.toLowerCase().includes(query);
}

function sumSize(nodes: Node[]): number {
  let total = 0;
  for (const node of nodes) total += node.size;
  return total;
}

/** A modal box drawn over the columns; it takes every key while open. */
type Overlay =
  | { type: "palette"; query: string; index: number }
  | {
      type: "trash";
      /** `null` until Finder has listed the Trash. */
      items: SizedPath[] | null;
      sizing: boolean;
      error: string;
      /** Which button has focus: 0 empty, 1 cancel. */
      focus: number;
      scroll: number;
      busy: boolean;
    }
  | { type: "space"; drives: VolumeSpace[] | null; error: string; scroll: number };

interface Command {
  title: string;
  hint: string;
  run(): void;
}

interface UIState {
  stack: Node[];
  cursor: Node | null;
  scroll: Map<Node, number>;
  showHidden: boolean;
  query: string;
  filtering: boolean;
  help: boolean;
  marked: Set<Node>;
  confirm: Node[] | null;
  message: string;
  messageUntil: number;
  busy: boolean;
  overlay: Overlay | null;
}

let restored = false;

function restoreTerminal(): void {
  if (restored) return;
  restored = true;
  process.stdout.write("\x1b[?25h\x1b[?7h\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
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

export function runShell(create: ToolFactory): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("letsclean needs an interactive terminal.");
    process.exitCode = 1;
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[2J\x1b[H");

  const state: UIState = {
    stack: [],
    cursor: null,
    scroll: new Map(),
    showHidden: true,
    query: "",
    filtering: false,
    help: false,
    marked: new Set(),
    confirm: null,
    message: "",
    messageUntil: 0,
    busy: false,
    overlay: null,
  };

  let cols = process.stdout.columns || 80;
  let rows = process.stdout.rows || 24;
  let blocked = false;
  let renderScheduled = false;
  let lastRender = 0;
  let stopped = false;
  const startedAt = Date.now();
  let finishedIn: number | null = null;
  let scanning = true;
  // Assigned once the tool is built; it may report updates while constructing.
  let tool!: Tool;

  function canOpen(node: Node): boolean {
    return tool.canOpen ? tool.canOpen(node) : node.kind === "dir";
  }

  function note(text: string): void {
    state.message = text;
    state.messageUntil = Date.now() + 3500;
  }

  function activeDir(): Node | null {
    return state.stack[state.stack.length - 1] ?? null;
  }

  function activeList(): Node[] {
    const dir = activeDir();
    if (!dir) return [];
    const list = ordered(dir, state.showHidden);
    if (!state.query) return list;
    const query = state.query.toLowerCase();
    return list.filter((node) => matches(node, query));
  }

  /** Live marked nodes, minus any whose ancestor is also marked. */
  function markedRoots(): Node[] {
    const out: Node[] = [];
    for (const node of state.marked) {
      if (node.dead) {
        state.marked.delete(node);
        continue;
      }
      let ancestor = node.parent;
      while (ancestor && !state.marked.has(ancestor)) ancestor = ancestor.parent;
      if (!ancestor) out.push(node);
    }
    return out;
  }

  /** What batch actions apply to: the selection if any, else the cursor row. */
  function targets(): Node[] {
    const roots = markedRoots();
    if (roots.length > 0) return roots;
    return state.cursor ? [state.cursor] : [];
  }

  function toggleMark(): void {
    const node = state.cursor;
    if (!node || !node.parent) return;
    if (state.marked.has(node)) state.marked.delete(node);
    else state.marked.add(node);
    move(1);
  }

  /** Select every row in the active column, or clear them if all are selected. */
  function markAll(): void {
    const list = activeList();
    if (list.length === 0) return;
    if (list.every((node) => state.marked.has(node))) for (const node of list) state.marked.delete(node);
    else for (const node of list) state.marked.add(node);
  }

  function ensureCursor(list: Node[]): void {
    if (list.length === 0) {
      state.cursor = null;
      return;
    }
    if (!state.cursor || !list.includes(state.cursor)) state.cursor = list[0]!;
  }

  function move(delta: number): void {
    const list = activeList();
    ensureCursor(list);
    if (list.length === 0 || !state.cursor) return;
    const index = list.indexOf(state.cursor);
    const next = Math.max(0, Math.min(list.length - 1, index + delta));
    state.cursor = list[next]!;
    followScroll(activeDir()!, list);
  }

  function followScroll(dir: Node, list: Node[]): void {
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
    if (!target || !canOpen(target)) return;
    state.stack.push(target);
    state.cursor = null;
    state.query = "";
    state.filtering = false;
    tool.focus?.(target);
    const list = activeList();
    ensureCursor(list);
    followScroll(target, list);
  }

  function back(): void {
    if (state.stack.length <= 1) return;
    const leaving = state.stack.pop()!;
    state.cursor = leaving;
    state.query = "";
    state.filtering = false;
    const dir = activeDir();
    if (dir) {
      tool.focus?.(dir);
      followScroll(dir, activeList());
    }
  }

  // ctrl-k palette. Add new entries here.
  const commands: Command[] = [
    { title: "Empty Trash", hint: "see what is in the Trash, then empty it", run: openTrash },
    { title: "Show free space", hint: "space left on every drive", run: openSpace },
  ];

  function paletteMatches(query: string): Command[] {
    const q = query.toLowerCase();
    return commands.filter((command) => !q || command.title.toLowerCase().includes(q) || command.hint.toLowerCase().includes(q));
  }

  function openTrash(): void {
    const dialog: Overlay & { type: "trash" } = { type: "trash", items: null, sizing: false, error: "", focus: 1, scroll: 0, busy: false };
    state.overlay = dialog;
    const closed = (): boolean => state.overlay !== dialog;
    listTrash()
      .then(async (paths) => {
        if (closed()) return;
        dialog.items = paths.map(({ path, volume }) => ({ path, volume, size: 0, done: false }));
        dialog.sizing = true;
        scheduleRender(true);
        await sizePaths(dialog.items, () => scheduleRender(false), closed);
      })
      .catch((error: unknown) => {
        dialog.error = oneLine(error, "could not read the Trash");
      })
      .finally(() => {
        dialog.sizing = false;
        scheduleRender(false);
      });
  }

  async function confirmEmptyTrash(dialog: Overlay & { type: "trash" }): Promise<void> {
    if (dialog.busy) return;
    dialog.busy = true;
    dialog.error = "";
    scheduleRender(true);
    try {
      await emptyTrash();
      const items = dialog.items ?? [];
      const freed = items.reduce((total, item) => total + item.size, 0);
      // The scan may have walked into the Trash; drop what is gone now.
      for (const item of items) {
        const node = findNode(item.path);
        if (!node || !node.parent) continue;
        tool.detach(node);
        node.dead = true;
      }
      settleAfterRemoval();
      if (state.overlay === dialog) state.overlay = null;
      note(freed > 0 ? `emptied Trash, freed ${formatSize(freed).trim()}` : "emptied Trash");
    } catch (error) {
      dialog.error = oneLine(error, "could not empty the Trash");
    } finally {
      dialog.busy = false;
      scheduleRender(true);
    }
  }

  function openSpace(): void {
    const previous = state.overlay?.type === "space" ? state.overlay : null;
    const dialog: Overlay & { type: "space" } = { type: "space", drives: previous?.drives ?? null, error: "", scroll: previous?.scroll ?? 0 };
    state.overlay = dialog;
    listVolumes(tool.path(tool.root))
      .then((drives) => {
        dialog.drives = drives;
      })
      .catch((error: unknown) => {
        dialog.error = oneLine(error, "could not read free space");
      })
      .finally(() => scheduleRender(false));
  }

  /** The tree node for an absolute path, if the scan has reached it. */
  function findNode(path: string): Node | null {
    const rootPath = tool.path(tool.root);
    const prefix = rootPath.endsWith("/") ? rootPath : rootPath + "/";
    if (!path.startsWith(prefix)) return null;
    let node = tool.root;
    for (const name of path.slice(prefix.length).split("/")) {
      const next = node.children?.find((child) => child.name === name && !child.dead);
      if (!next) return null;
      node = next;
    }
    return tool.path(node) === path ? node : null;
  }

  /** Fix up stack, cursor and selection after nodes died outside confirmTrash. */
  function settleAfterRemoval(): void {
    for (const node of state.marked) if (node.dead) state.marked.delete(node);
    while (state.stack.length > 1 && state.stack.some((dir) => dir.dead)) back();
    if (state.cursor?.dead) state.cursor = null;
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
    if (blocked || stopped || state.stack.length === 0) return;
    lastRender = Date.now();
    const frame = render(lastRender);
    blocked = !process.stdout.write(frame);
  }

  function render(now: number): string {
    const lines: string[] = [];
    const stats = tool.stats(now, cols);
    scanning = stats.scanning;
    if (!scanning && finishedIn === null) finishedIn = now - startedAt;
    const spin = SPIN[Math.floor(now / 80) % SPIN.length];
    const elapsed = formatDuration(finishedIn ?? now - startedAt);
    const status = stats.scanning
      ? `${spin} ${stats.info}  ${BOLD}${elapsed}${RESET}${HEADER}`
      : `${BOLD}done in ${elapsed}${RESET}${HEADER}  ${stats.info}`;
    // Status is placed from the right edge so it stays visible as the terminal
    // narrows; the path takes whatever room is left.
    const right = `  ${stats.total}   ${status} `;
    const rightW = visibleWidth(stripAnsi(right));
    const title = ` ${tool.name}  ${fit(tool.path(tool.root), Math.max(0, cols - rightW - 12))}`;
    lines.push(HEADER + padVisible(title, cols - rightW) + right + RESET);

    const listH = Math.max(1, rows - 4);
    const shown = visibleStack();
    const widths = columnWidths(shown.length);

    const headerCells = shown.map((dir, index) => {
      const mark = dir.pending > 0 ? "…" : "";
      const label = (dir.parent ? dir.name : tool.path(dir)) + mark;
      const size = formatSize(dir.size);
      const inner = widths[index]! - 1;
      const nameW = Math.max(1, inner - size.length - 1);
      return padRight(fit(label, nameW), nameW) + " " + size;
    });
    lines.push(paintColumns(headerCells, widths, CYAN + BOLD) + RESET);

    const lists = shown.map((dir, index) => {
      const isActive = index === shown.length - 1;
      const list = ordered(dir, state.showHidden);
      if (isActive && state.query) return list.filter((node) => matches(node, state.query.toLowerCase()));
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
        const dirNode = shown[c]!;
        const list = lists[c]!;
        const scroll = state.scroll.get(dirNode) ?? 0;
        const node = list[scroll + row];
        const isLast = c === shown.length - 1;
        const opened = !isLast && shown[c + 1] === node;
        const selected = isLast && node !== undefined && node === state.cursor;
        const marked = node !== undefined && state.marked.has(node);
        const width = widths[c]!;
        if (!node) {
          if (row === 0 && list.length === 0) {
            const placeholder = dirNode.error
              ? RED + fit(dirNode.error, width - 2)
              : dirNode.listing || dirNode.children === null || (dirNode.children.length === 0 && dirNode.pending > 0)
                ? DIM + " scanning…"
                : DIM + " empty";
            cells.push(padVisible(placeholder, width - 1));
          } else {
            cells.push(" ".repeat(Math.max(0, width - 1)));
          }
          styles.push("");
          continue;
        }
        const pending = node.pending > 0 || (node.children === null && canOpen(node));
        cells.push(paintNode(node, width - 1, list, selected, marked, pending));
        styles.push(selected ? SELECT : opened ? OPEN : "");
      }
      lines.push(paintColumns(cells, widths, "", styles));
    }

    const current = state.cursor;
    const detail = current
      ? `${current.kind === "dir" ? "dir " : current.kind === "link" ? "link" : "file"}  ${formatSize(current.size).trim()}${current.pending > 0 ? "  …" : ""}  ${tool.path(current)}${current.error ? "  " + current.error : ""}`
      : tool.path(tool.root);
    const filterLabel = state.query ? `  filter: ${state.query}${state.filtering ? "▍" : ""}` : "";
    const detailLine = fit(detail, Math.max(0, cols - visibleWidth(filterLabel) - 1)) + filterLabel;
    lines.push(DIM + padVisible(" " + detailLine, cols) + RESET);

    const roots = state.marked.size > 0 ? markedRoots() : [];
    let foot: string;
    if (state.confirm) {
      const what =
        state.confirm.length === 1
          ? state.confirm[0]!.name
          : `${formatCount(state.confirm.length)} items (${formatSize(sumSize(state.confirm)).trim()})`;
      foot = `${YELLOW}${BOLD} Trash ${what}? ${RESET}${YELLOW} y confirm   n cancel${RESET}`;
    } else if (state.message && now < state.messageUntil) {
      foot = YELLOW + " " + state.message + RESET;
    } else if (roots.length > 0) {
      foot = `${YELLOW}${BOLD} ${formatCount(roots.length)} selected  ${formatSize(sumSize(roots)).trim()} ${RESET}  ${BOLD}space${RESET} toggle  ${BOLD}^a${RESET} all  ${BOLD}^d${RESET} trash  ${BOLD}^y${RESET} copy  ${BOLD}esc${RESET} ${state.query ? "clear filter" : "deselect"}`;
    } else if (state.filtering) {
      foot = `${BOLD}/${state.query}${RESET}  type to filter   ↑↓ move   tab select   ^o reveal   ^d trash   ^y copy   esc clear`;
    } else {
      const hidden = tool.hiddenToggle ? `  ${BOLD}.${RESET} ${state.showHidden ? "shown" : "hidden"}` : "";
      const nav = state.stack.length > 1 || activeList().some(canOpen) ? `  ${BOLD}→${RESET} open  ${BOLD}←${RESET} back` : "";
      foot = ` ${BOLD}↑↓${RESET} move${nav}  ${BOLD}space${RESET} select  ${BOLD}^k${RESET} commands  ${BOLD}^o${RESET} finder  ${BOLD}^d${RESET} trash  ${BOLD}^y${RESET} copy${hidden}  ${BOLD}/${RESET} filter  ${BOLD}?${RESET} help  ${BOLD}q${RESET} quit`;
    }
    lines.push(padVisible(foot, cols));

    let frame = "\x1b[H" + lines.join("\n");
    if (state.help) frame += renderHelp();
    else if (state.overlay) frame += renderOverlay(state.overlay, now);
    return frame;
  }

  function renderOverlay(overlay: Overlay, now: number): string {
    if (overlay.type === "palette") return renderPalette(overlay);
    if (overlay.type === "trash") return renderTrash(overlay, now);
    return renderSpace(overlay);
  }

  function renderPalette(palette: Overlay & { type: "palette" }): string {
    const width = Math.min(cols - 4, 64);
    const inner = width - 2;
    const list = paletteMatches(palette.query);
    palette.index = Math.max(0, Math.min(list.length - 1, palette.index));
    const body: string[] = [BOLD + " Commands" + RESET, " " + CYAN + "›" + RESET + " " + fit(palette.query, inner - 5) + "▍", ""];
    if (list.length === 0) body.push(DIM + " no matching command" + RESET);
    const titleW = Math.min(20, Math.max(...commands.map((command) => command.title.length)) + 2);
    list.forEach((command, i) => {
      const selected = i === palette.index;
      const title = padRight(command.title, titleW);
      const hint = fit(command.hint, Math.max(0, inner - titleW - 3));
      body.push(selected ? `${SELECT} ${BOLD}${title}${RESET}${SELECT} ${hint}` : ` ${title} ${DIM}${hint}${RESET}`);
    });
    body.push("", DIM + " ↑↓ choose   enter run   esc close" + RESET);
    return renderBox(body, width, null);
  }

  function renderTrash(dialog: Overlay & { type: "trash" }, now: number): string {
    const width = Math.min(cols - 4, 72);
    const inner = width - 2;
    const items = dialog.items;
    const spin = SPIN[Math.floor(now / 80) % SPIN.length];
    const total = items ? items.reduce((sum, item) => sum + item.size, 0) : 0;
    let summary = "";
    if (items && items.length > 0) {
      summary = `${formatCount(items.length)} item${items.length === 1 ? "" : "s"}  ${formatSize(total).trim()}${dialog.sizing ? " " + spin : ""}`;
    }
    const title = " Empty Trash";
    const body: string[] = [BOLD + title + RESET + " ".repeat(Math.max(1, inner - title.length - summary.length - 1)) + YELLOW + summary + RESET, ""];

    // Leave room for the header, buttons, hints and box borders.
    const listH = Math.max(1, Math.min(items?.length ?? 1, rows - 12));
    if (!items) {
      if (dialog.error) {
        body.push(RED + " " + fit(dialog.error, inner - 2) + RESET);
        body.push(DIM + " Could not list it; emptying may still work." + RESET);
      } else {
        body.push(DIM + ` ${spin} reading Trash…` + RESET);
      }
    } else if (items.length === 0) {
      body.push(DIM + " The Trash is empty." + RESET);
    } else {
      const sorted = items.slice().sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
      dialog.scroll = Math.max(0, Math.min(dialog.scroll, sorted.length - listH));
      for (const item of sorted.slice(dialog.scroll, dialog.scroll + listH)) {
        const name = basename(item.path) + (item.done ? "" : " …");
        const drive = item.volume ? fit(" · " + item.volume, Math.floor((inner - 12) / 3)) : "";
        body.push(` ${GREEN}${formatSize(item.size)}${RESET}  ${fit(name, inner - 12 - visibleWidth(drive))}${DIM}${drive}${RESET}`);
      }
      const above = dialog.scroll;
      const below = sorted.length - dialog.scroll - listH;
      if (above > 0 || below > 0) {
        body.push(DIM + ` ${above > 0 ? `↑ ${formatCount(above)} more` : ""}${above > 0 && below > 0 ? "   " : ""}${below > 0 ? `↓ ${formatCount(below)} more` : ""}` + RESET);
      }
    }
    body.push("");
    if (dialog.error && items) body.push(RED + " " + fit(dialog.error, inner - 2) + RESET, "");

    const empty = items !== null && items.length === 0 && !dialog.error;
    if (dialog.busy) {
      body.push(YELLOW + ` ${spin} emptying Trash…` + RESET);
    } else if (empty) {
      body.push(" " + SELECT + BOLD + " Close " + RESET);
      body.push("", DIM + " enter / esc close" + RESET);
    } else {
      const emptyBtn = dialog.focus === 0 ? `${DANGER}${BOLD} Empty Trash ${RESET}` : `${RED}[ Empty Trash ]${RESET}`;
      const cancelBtn = dialog.focus === 1 ? `${SELECT}${BOLD} Cancel ${RESET}` : "[ Cancel ]";
      body.push(` ${emptyBtn}   ${cancelBtn}`);
      body.push("", DIM + fit(" Permanently deletes these. y empty  n cancel  ←→ choose  enter", inner) + RESET);
    }
    return renderBox(body, width, null);
  }

  function renderSpace(dialog: Overlay & { type: "space" }): string {
    const width = Math.min(cols - 4, 64);
    const inner = width - 2;
    const body: string[] = [BOLD + " Free space" + RESET, ""];
    const drives = dialog.drives;
    if (drives && drives.length > 0) {
      // Each drive takes three lines; keep the box on screen.
      const fitCount = Math.max(1, Math.floor((rows - 8) / 3));
      dialog.scroll = Math.max(0, Math.min(dialog.scroll, drives.length - fitCount));
      const freeText = (drive: VolumeSpace): string => `${formatSize(drive.free).trim()} free of ${formatSize(drive.total).trim()}`;
      // One bar width for every drive, sized by the longest "free of" text.
      const freeW = Math.max(...drives.map((drive) => freeText(drive).length));
      const barW = Math.max(4, inner - freeW - 4 - 5);
      for (const drive of drives.slice(dialog.scroll, dialog.scroll + fitCount)) {
        const ratio = drive.total > 0 ? drive.used / drive.total : 0;
        const color = ratio >= 0.9 ? RED : ratio >= 0.75 ? YELLOW : GREEN;
        const tag = drive.current ? "  this folder" : "";
        const where = drive.mount === "/" || drive.mount.endsWith("/" + drive.name) ? "" : "  " + drive.mount;
        const name = fit(drive.name, inner - 2 - tag.length);
        body.push(` ${BOLD}${name}${RESET}${CYAN}${tag}${RESET}${DIM}${fit(where, inner - 1 - visibleWidth(name) - tag.length)}${RESET}`);
        const free = freeText(drive);
        const percent = `${Math.round(ratio * 100)}%`.padStart(4);
        body.push(` ${color}${sizeBar(drive.used, drive.total, barW)}${RESET} ${percent}  ${color}${BOLD}${free}${RESET}`, "");
      }
      const below = drives.length - dialog.scroll - fitCount;
      if (dialog.scroll > 0 || below > 0) body.push(DIM + ` ${dialog.scroll > 0 ? "↑ more  " : ""}${below > 0 ? `↓ ${formatCount(below)} more` : ""}` + RESET);
      else body.pop();
    } else if (dialog.error) {
      body.push(RED + " " + fit(dialog.error, inner - 2) + RESET);
    } else if (drives) {
      body.push(DIM + " no drives found" + RESET);
    } else {
      body.push(DIM + " reading…" + RESET);
    }
    body.push("", DIM + " r refresh   esc close" + RESET);
    return renderBox(body, width, null);
  }

  /** Draw lines (which may carry color) in a bordered box centered on screen. */
  function renderBox(body: string[], width: number, style: string | null): string {
    const bg = style ?? PANEL;
    const inner = width - 2;
    const top = Math.max(1, Math.floor((rows - body.length - 2) / 2));
    const left = Math.max(0, Math.floor((cols - width) / 2));
    const border = DIM + CYAN;
    let out = `\x1b[${top};${left + 1}H${bg}${border}┌${"─".repeat(inner)}┐${RESET}`;
    for (let i = 0; i < body.length; i++) {
      // Colors inside a line end with RESET; put the panel background back.
      const line = padVisible(body[i]!, inner).replaceAll(RESET, RESET + bg);
      out += `\x1b[${top + 1 + i};${left + 1}H${bg}${border}│${RESET}${bg}${line}${bg}${border}│${RESET}`;
    }
    out += `\x1b[${top + 1 + body.length};${left + 1}H${bg}${border}└${"─".repeat(inner)}┘${RESET}`;
    return out;
  }

  function renderHelp(): string {
    const body = [
      tool.name,
      "",
      "↑ ↓  j k     move",
      "→  l  enter  open directory",
      "←  h  bksp   go back",
      "g G  home end jump",
      "pgup pgdn     page",
      "space  tab    select / deselect row",
      "ctrl-a        select all in column",
      "esc           clear filter, then selection",
      "ctrl-o        reveal in Finder",
      "ctrl-d        move to Trash (selection)",
      "ctrl-y        copy path (selection)",
      "ctrl-k        commands (Trash, free space)",
      ...(tool.hiddenToggle ? [".            toggle hidden files"] : []),
      "/            filter this column",
      "?            this help",
      "q  ctrl-c    quit",
      ...(tool.help.length > 0 ? ["", ...tool.help] : []),
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

  /**
   * The active column always gets at least half the screen; parent columns
   * share the other half, and the oldest fall off the left when they'd get
   * narrower than MIN_PARENT_COL.
   */
  function visibleStack(): Node[] {
    if (state.stack.length === 0) return [];
    const parentRoom = Math.floor(cols / 2);
    const maxParents = Math.floor(parentRoom / MIN_PARENT_COL);
    const count = Math.max(1, Math.min(state.stack.length, maxParents + 1));
    return state.stack.slice(state.stack.length - count);
  }

  function columnWidths(count: number): number[] {
    if (count <= 1) return [cols];
    const parentRoom = Math.floor(cols / 2);
    const parents = count - 1;
    const each = Math.max(1, Math.floor(parentRoom / parents));
    const widths = new Array<number>(parents).fill(each);
    // Leftover cells from the parent split go to the nearest parent column.
    widths[parents - 1]! += Math.max(0, parentRoom - each * parents);
    widths.push(cols - parentRoom);
    return widths;
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
    if (state.overlay) {
      handleOverlayKey(state.overlay, kind, char);
      return;
    }
    if (state.confirm) {
      if (char === "y" || char === "Y") void confirmTrash();
      else if (char === "n" || char === "N" || kind === "escape" || char === "q") state.confirm = null;
      else if (kind === "quit" && char === "\x03") shutdown();
      return;
    }
    if (state.busy) {
      if (kind === "quit" && char === "\x03") shutdown();
      return;
    }

    // While typing a filter every printable key is text, including the letter
    // shortcuts. Ctrl keys, arrows, tab and esc still act.
    if (state.filtering && char.length === 1 && char >= " " && char !== "\x7f") {
      state.query += char;
      return;
    }

    switch (kind) {
      case "up":
      case "k":
        move(-1);
        return;
      case "down":
      case "j":
        move(1);
        return;
      case "pageup":
        move(-(rows - 5));
        return;
      case "pagedown":
        move(rows - 5);
        return;
      case "home":
      case "g":
        move(-1_000_000);
        return;
      case "end":
      case "G":
        move(1_000_000);
        return;
      case "right":
      case "enter":
      case "l":
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
        back();
        return;
      case "escape":
        if (state.query || state.filtering) {
          state.query = "";
          state.filtering = false;
        } else {
          state.marked.clear();
        }
        return;
      case "toggle":
        toggleMark();
        return;
      case "all":
        markAll();
        return;
      case "char":
        if (char === " ") toggleMark();
        return;
      case "filter":
        state.filtering = true;
        return;
      case "quit":
        shutdown();
        return;
      case "help":
        state.help = true;
        return;
      case "palette":
        state.overlay = { type: "palette", query: "", index: 0 };
        return;
      case "hidden":
        if (!tool.hiddenToggle) return;
        state.showHidden = !state.showHidden;
        state.cursor = null;
        return;
      case "open":
        if (state.cursor) reveal(tool.path(state.cursor));
        return;
      case "yank": {
        const paths = targets().map((node) => tool.path(node));
        if (paths.length === 0) return;
        copyText(paths.join("\n"));
        note(paths.length === 1 ? "copied " + paths[0] : `copied ${formatCount(paths.length)} paths`);
        return;
      }
      case "delete": {
        const list = targets().filter((node) => node.parent);
        if (list.length > 0) state.confirm = list;
        return;
      }
      default:
        return;
    }
  }

  function handleOverlayKey(overlay: Overlay, kind: string, char: string): void {
    if (kind === "quit" && char === "\x03") {
      shutdown();
      return;
    }
    if (overlay.type === "palette") {
      if (kind === "escape" || kind === "palette") {
        state.overlay = null;
      } else if (kind === "up") {
        overlay.index = Math.max(0, overlay.index - 1);
      } else if (kind === "down" || kind === "toggle") {
        overlay.index++;
      } else if (kind === "enter") {
        const command = paletteMatches(overlay.query)[overlay.index];
        state.overlay = null;
        command?.run();
      } else if (kind === "backspace") {
        overlay.query = overlay.query.slice(0, -1);
        overlay.index = 0;
      } else if (char.length === 1 && char >= " " && char !== "\x7f") {
        overlay.query += char;
        overlay.index = 0;
      }
      return;
    }
    if (overlay.type === "space") {
      if (char === "r") openSpace();
      else if (kind === "escape") state.overlay = null;
      else if (kind === "up" || kind === "k") overlay.scroll = Math.max(0, overlay.scroll - 1);
      else if (kind === "down" || kind === "j") overlay.scroll++;
      return;
    }
    if (overlay.busy) return;
    const isEmpty = overlay.items !== null && overlay.items.length === 0 && !overlay.error;
    if (isEmpty) {
      if (kind === "escape" || kind === "enter") state.overlay = null;
      return;
    }
    switch (kind) {
      case "up":
      case "k":
        overlay.scroll = Math.max(0, overlay.scroll - 1);
        return;
      case "down":
      case "j":
        overlay.scroll++;
        return;
      case "pageup":
        overlay.scroll = Math.max(0, overlay.scroll - (rows - 12));
        return;
      case "pagedown":
        overlay.scroll += rows - 12;
        return;
      case "left":
      case "right":
      case "h":
      case "l":
      case "toggle":
        overlay.focus = overlay.focus === 0 ? 1 : 0;
        return;
      case "enter":
        if (overlay.focus === 0) void confirmEmptyTrash(overlay);
        else state.overlay = null;
        return;
      case "escape":
      case "quit":
      case "palette":
        state.overlay = null;
        return;
      default:
        if (char === "y" || char === "Y") void confirmEmptyTrash(overlay);
        else if (char === "n" || char === "N") state.overlay = null;
    }
  }

  async function confirmTrash(): Promise<void> {
    const list = state.confirm;
    state.confirm = null;
    if (!list || list.length === 0 || state.busy) return;
    state.busy = true;
    const listBefore = activeList();
    const cursorIndex = state.cursor ? listBefore.indexOf(state.cursor) : -1;
    let done = 0;
    let freed = 0;
    let firstError = "";
    const remove = (target: Node): void => {
      const size = target.size;
      tool.detach(target);
      target.dead = true;
      state.marked.delete(target);
      freed += size;
      done++;
    };
    try {
      const live = list.filter((target) => !target.dead && target.parent);
      note(live.length === 1 ? "moving to Trash…" : `moving ${formatCount(live.length)} items to Trash…`);
      scheduleRender(true);
      try {
        // One call for the whole batch, so Finder plays its sound once.
        await trashMany(live.map((target) => tool.path(target)));
        for (const target of live) remove(target);
      } catch {
        // Retry one by one to find which items failed. A partly applied batch
        // leaves some paths already gone; those count as trashed.
        for (let i = 0; i < live.length; i++) {
          const target = live[i]!;
          const path = tool.path(target);
          if (!exists(path)) {
            remove(target);
            continue;
          }
          note(`moving to Trash… ${i + 1}/${live.length}`);
          scheduleRender(true);
          try {
            await trash(path);
            remove(target);
          } catch (error) {
            const message = (error instanceof Error ? error.message : "trash failed").replaceAll("\n", " ").slice(0, 120);
            target.error = message;
            if (!firstError) firstError = message;
          }
        }
      }
      for (const node of state.marked) if (node.dead) state.marked.delete(node);

      // A trashed directory may be open in the column stack.
      let popped = false;
      while (state.stack.length > 1 && state.stack.some((dir) => dir.dead)) {
        back();
        popped = true;
      }
      if (popped) {
        if (state.cursor?.dead) state.cursor = null;
      } else if (state.cursor?.dead) {
        let next: Node | null = null;
        for (let i = cursorIndex; i >= 0 && i < listBefore.length && !next; i++) {
          if (!listBefore[i]!.dead) next = listBefore[i]!;
        }
        for (let i = cursorIndex - 1; i >= 0 && !next; i--) {
          if (!listBefore[i]!.dead) next = listBefore[i]!;
        }
        state.cursor = next;
      }

      const failed = list.length - done;
      if (list.length === 1 && done === 1) note("trashed " + list[0]!.name);
      else if (failed === 0) note(`trashed ${formatCount(done)} items, freed ${formatSize(freed).trim()}`);
      else if (done === 0) note(firstError);
      else note(`trashed ${formatCount(done)}, ${formatCount(failed)} failed: ${firstError}`);
    } finally {
      state.busy = false;
      scheduleRender(true);
    }
  }

  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    tool?.stop();
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

  const built = create(() => scheduleRender(false));
  state.stack = [built.root];
  tool = built;
  built.focus?.(built.root);
  scheduleRender(true);
  // Keep the spinner and timer moving even when the tool is quiet.
  setInterval(() => {
    if (scanning || (state.overlay?.type === "trash" && (state.overlay.busy || state.overlay.items === null))) scheduleRender(false);
  }, 250).unref();
}

function paintNode(node: Node, width: number, siblings: Node[], selected: boolean, marked: boolean, isPending: boolean): string {
  // Reset only bold/foreground so a row background (OPEN) survives the marker.
  const gutter = marked ? (selected ? "●" : YELLOW + BOLD + "●" + "\x1b[22;39m") : " ";
  width -= 1;
  const size = formatSize(node.size);
  const pending = isPending ? "…" : "";
  const suffix = node.kind === "dir" ? "/" : node.kind === "link" ? "@" : "";
  const barW = width >= 36 ? 8 : 0;
  const nameW = width - size.length - 1 - (barW > 0 ? barW + 1 : 0) - pending.length;
  const max = siblings[0]?.size ?? 0;
  const nameColor = selected
    ? marked
      ? BOLD
      : ""
    : marked
      ? YELLOW + BOLD
      : node.kind === "dir"
        ? CYAN
        : node.kind === "link"
          ? MAGENTA
          : "";
  const sizeColor = selected ? "" : GREEN;
  const name = fit(node.name + suffix, Math.max(1, nameW));
  const bar = barW > 0 ? sizeBar(node.size, max, barW) : "";
  const core =
    gutter +
    (selected ? SELECT : "") +
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
  return padVisible(core, width + 1);
}

function oneLine(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback).replaceAll("\n", " ").slice(0, 160) || fallback;
}

function paintColumns(cells: string[], widths: number[], style: string, styles?: string[]): string {
  let out = "";
  for (let i = 0; i < cells.length; i++) {
    const bg = styles?.[i] ?? "";
    const sep = i === cells.length - 1 ? "" : DIM + "│" + RESET;
    out += bg + style + cells[i] + RESET + sep;
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
    if (rest.length === 1) return { kind: "escape", char: "", length: 1 };
    // Swallow incomplete or unknown escape sequences up to a letter or tilde.
    let length = 1;
    while (length < rest.length && length < 8) {
      const code = rest.charCodeAt(length);
      length++;
      if (code >= 64 && code <= 126) break;
    }
    if (length === 1) return { kind: "escape", char: "", length: 1 };
    return { kind: "ignore", char: "", length };
  }
  if (char === "\r" || char === "\n") return { kind: "enter", char, length: 1 };
  if (char === "\t") return { kind: "toggle", char, length: 1 };
  if (char === "\x7f" || char === "\b") return { kind: "backspace", char, length: 1 };
  // ctrl-c always quits; the letter keys also answer to ctrl so they stay
  // usable while a filter treats plain letters as text.
  if (char === "\x03") return { kind: "quit", char, length: 1 };
  if (char === "\x01") return { kind: "all", char, length: 1 };
  if (char === "\x0f") return { kind: "open", char, length: 1 };
  if (char === "\x04") return { kind: "delete", char, length: 1 };
  if (char === "\x19") return { kind: "yank", char, length: 1 };
  if (char === "\x11") return { kind: "quit", char, length: 1 };
  if (char === "\x0b") return { kind: "palette", char, length: 1 };
  if (char === "q") return { kind: "quit", char, length: 1 };
  if (char === "?") return { kind: "help", char, length: 1 };
  if (char === "/") return { kind: "filter", char, length: 1 };
  if (char === ".") return { kind: "hidden", char, length: 1 };
  if (char === "j" || char === "k" || char === "h" || char === "l" || char === "g" || char === "G") {
    return { kind: char, char, length: 1 };
  }
  return { kind: "char", char, length: 1 };
}
