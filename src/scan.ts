import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/**
 * Directory reads run in worker threads so the UI never blocks. On macOS each
 * worker uses getattrlistbulk (native/scan.cc): one syscall returns the name,
 * type and allocated size of a whole batch, instead of readdir plus an lstat
 * per file. Elsewhere, or if the addon is missing, it falls back to that.
 * Classic-worker source (eval) so we don't depend on TypeScript loader hooks.
 */
const nativePath = fileURLToPath(new URL("../native/build/Release/scannative.node", import.meta.url));

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

const BATCH = 4000;

function finish(id, error) {
  parentPort.postMessage({ id: id, done: true, error: error || undefined, names: [] });
}

parentPort.on("message", async (msg) => {
  const id = msg.id;
  const path = msg.path;
  if (native) {
    let handle;
    try {
      handle = native.open(path);
    } catch (err) {
      finish(id, (err && err.code) || "unreadable");
      return;
    }
    try {
      for (;;) {
        const batch = native.read(handle);
        if (batch.done) {
          finish(id);
          return;
        }
        const kinds = new Uint8Array(batch.kinds);
        const sizes = new Float64Array(batch.sizes);
        parentPort.postMessage(
          { id: id, done: false, names: batch.names, kinds: kinds, sizes: sizes },
          [kinds.buffer, sizes.buffer],
        );
      }
    } catch (err) {
      finish(id, (err && err.code) || "unreadable");
    } finally {
      try { native.close(handle); } catch (err) {}
    }
    return;
  }

  let dirents;
  try {
    dirents = readdirSync(path, { withFileTypes: true });
  } catch (err) {
    finish(id, (err && err.code) || "unreadable");
    return;
  }

  const n = dirents.length;
  if (n === 0) {
    finish(id);
    return;
  }

  for (let start = 0; start < n; start += BATCH) {
    const end = Math.min(start + BATCH, n);
    const count = end - start;
    const names = new Array(count);
    const kinds = new Uint8Array(count);
    const sizes = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const d = dirents[start + i];
      const name = d.name;
      names[i] = name;
      if (d.isSymbolicLink()) {
        kinds[i] = 2;
        try {
          sizes[i] = lstatSync(path === "/" ? "/" + name : path + "/" + name).size;
        } catch (err) {
          kinds[i] = 10;
        }
        continue;
      }
      if (d.isDirectory()) {
        kinds[i] = 1;
        continue;
      }
      try {
        const st = lstatSync(path === "/" ? "/" + name : path + "/" + name);
        sizes[i] = st.blocks > 0 ? st.blocks * 512 : st.size;
      } catch (err) {
        kinds[i] = 8;
      }
    }
    const done = end === n;
    const transfer = [kinds.buffer, sizes.buffer];
    parentPort.postMessage({ id: id, done: done, names: names, kinds: kinds, sizes: sizes }, transfer);
    if (!done) await new Promise((resolve) => setImmediate(resolve));
  }
});
`;

export type Kind = "dir" | "file" | "link";

export interface Entry {
  name: string;
  /** Full path for directories (workers need it). Empty for files — use fullPath(). */
  path: string;
  parent: Entry | null;
  kind: Kind;
  /** Total physical size of this node, including descendants discovered so far. */
  size: number;
  children: Entry[] | null;
  /** Unscanned directories in this subtree, including self when not yet listed. */
  pending: number;
  listing: boolean;
  scanned: boolean;
  dead: boolean;
  error?: string;
  /** Bumped when direct-child order may have changed. */
  gen: number;
  depth: number;
  job: Job | null;
}

interface Job {
  entry: Entry;
  pri: number;
  seq: number;
  index: number;
  dead: boolean;
}

export interface ScanStats {
  files: number;
  dirs: number;
  errors: number;
  inFlight: number;
  queued: number;
  done: boolean;
  /** Estimated bytes the tree itself occupies, files and directories combined. */
  memory: number;
}

// Per entry, checked against process heap after a full scan of ~700k entries.
// RSS runs higher still because of worker threads and allocator slack, so the
// displayed figure is clamped up to the real resident size once a second.
const BYTES_PER_ENTRY = 250;

export interface Scanner {
  root: Entry;
  stats: ScanStats;
  focus(entry: Entry): void;
  stop(): void;
}

interface WorkerResult {
  id: number;
  done: boolean;
  error?: string;
  names: string[];
  kinds?: Uint8Array;
  sizes?: Float64Array;
}

class Heap {
  items: Job[] = [];

  get size(): number {
    return this.items.length;
  }

  push(job: Job): void {
    job.index = this.items.length;
    this.items.push(job);
    this.up(job.index);
  }

  pop(): Job | undefined {
    const items = this.items;
    if (items.length === 0) return;
    const top = items[0]!;
    const last = items.pop()!;
    top.index = -1;
    if (items.length > 0 && last !== top) {
      items[0] = last;
      last.index = 0;
      this.down(0);
    }
    return top;
  }

  bump(job: Job, pri: number): void {
    if (job.index < 0 || job.dead || pri >= job.pri) return;
    job.pri = pri;
    this.up(job.index);
  }

  private less(a: Job, b: Job): boolean {
    return a.pri < b.pri || (a.pri === b.pri && a.seq < b.seq);
  }

  private up(i: number): void {
    const items = this.items;
    const job = items[i]!;
    while (i > 0) {
      const parentIndex = (i - 1) >> 1;
      const parent = items[parentIndex]!;
      if (!this.less(job, parent)) break;
      items[i] = parent;
      parent.index = i;
      i = parentIndex;
    }
    items[i] = job;
    job.index = i;
  }

  private down(i: number): void {
    const items = this.items;
    const n = items.length;
    const job = items[i]!;
    for (;;) {
      let smallest = i;
      const left = i * 2 + 1;
      const right = left + 1;
      if (left < n && this.less(items[left]!, items[smallest]!)) smallest = left;
      if (right < n && this.less(items[right]!, items[smallest]!)) smallest = right;
      if (smallest === i) break;
      items[i] = items[smallest]!;
      items[i]!.index = i;
      i = smallest;
    }
    items[i] = job;
    job.index = i;
  }
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? "/" + name : parent + "/" + name;
}

export function fullPath(entry: Entry): string {
  if (entry.path) return entry.path;
  const parent = entry.parent;
  if (!parent) return entry.name;
  return joinPath(parent.path || fullPath(parent), entry.name);
}

/**
 * Roll a size delta toward the root, but bump sort generations only on the
 * immediate parent. Further ancestors change size without reshuffling until
 * the view actually draws them — marking every ancestor dirty per batch made
 * huge trees re-sort columns the user isn't even looking at.
 */
function addSize(entry: Entry, delta: number): void {
  entry.size += delta;
  // Bump every ancestor, not just the parent. A directory's size changes as
  // its descendants are scanned, and any on-screen column showing that
  // directory has to re-sort. Skipping the rest of the chain left the list in
  // the order it first appeared until something else forced a sort.
  let current = entry.parent;
  while (current) {
    current.size += delta;
    current.gen++;
    current = current.parent;
  }
}

function addPending(entry: Entry, delta: number): void {
  let current: Entry | null = entry;
  while (current) {
    current.pending += delta;
    current = current.parent;
  }
}

export function detach(entry: Entry): void {
  if (entry.dead || !entry.parent) return;
  kill(entry);
  const parent = entry.parent;
  const kids = parent.children;
  if (kids) {
    const index = kids.indexOf(entry);
    if (index >= 0) kids.splice(index, 1);
  }
  parent.gen++;
  let ancestor: Entry | null = parent;
  const size = entry.size;
  const pending = entry.pending;
  while (ancestor) {
    ancestor.size -= size;
    ancestor.pending -= pending;
    ancestor.gen++;
    ancestor = ancestor.parent;
  }
}

function kill(entry: Entry): void {
  entry.dead = true;
  if (entry.job) {
    entry.job.dead = true;
    entry.job = null;
  }
  const kids = entry.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) kill(kids[i]!);
}

export function startScan(rootPath: string, onActivity: () => void): Scanner {
  const root: Entry = {
    name: rootPath,
    path: rootPath,
    parent: null,
    kind: "dir",
    size: 0,
    children: null,
    pending: 1,
    listing: false,
    scanned: false,
    dead: false,
    gen: 0,
    depth: 0,
    job: null,
  };

  const stats: ScanStats = {
    files: 0,
    dirs: 1,
    errors: 0,
    inFlight: 0,
    queued: 0,
    done: false,
    memory: rootPath.length * 2 + BYTES_PER_ENTRY,
  };

  function account(name: string): void {
    stats.memory += name.length * 2 + BYTES_PER_ENTRY;
  }

  const heap = new Heap();
  let seq = 0;
  let nextId = 1;
  let stopped = false;
  let focusEntry: Entry = root;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEmit = 0;

  const inflight = new Map<number, Entry>();
  const workers: Worker[] = [];
  const idle: Worker[] = [];

  const parallelism = Math.min(32, Math.max(4, availableParallelism() * 2));

  function emit(): void {
    const now = Date.now();
    if (now - lastEmit >= 40) {
      lastEmit = now;
      if (emitTimer) {
        clearTimeout(emitTimer);
        emitTimer = null;
      }
      onActivity();
      return;
    }
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      lastEmit = Date.now();
      onActivity();
    }, 40);
  }

  function priority(entry: Entry): number {
    if (entry === focusEntry) return -2_000_000;
    if (entry.parent === focusEntry) return -1_000_000;
    // Root focus would match the entire tree; keep shallow-first in that case.
    if (focusEntry.parent) {
      let current: Entry | null = entry;
      while (current) {
        if (current === focusEntry) return entry.depth - 100_000;
        current = current.parent;
      }
    }
    return entry.depth;
  }

  function schedule(entry: Entry): void {
    if (stopped || entry.dead || entry.kind !== "dir") return;
    if (entry.job || entry.listing || entry.scanned) return;
    const job: Job = {
      entry,
      pri: priority(entry),
      seq: seq++,
      index: -1,
      dead: false,
    };
    entry.job = job;
    heap.push(job);
    stats.queued = heap.size;
  }

  function pump(): void {
    if (stopped) return;
    while (idle.length > 0) {
      let job = heap.pop();
      while (job && (job.dead || job.entry.dead)) job = heap.pop();
      if (!job) break;
      const worker = idle.pop()!;
      const entry = job.entry;
      entry.job = null;
      entry.listing = true;
      const id = nextId++;
      inflight.set(id, entry);
      stats.inFlight = inflight.size;
      stats.queued = heap.size;
      worker.postMessage({ id, path: entry.path });
    }
    stats.queued = heap.size;
    stats.done = stats.inFlight === 0 && heap.size === 0 && root.scanned;
  }

  function apply(entry: Entry, msg: WorkerResult): void {
    if (stopped || entry.dead) {
      if (msg.done) finishListing(entry, true);
      return;
    }

    if (msg.error && entry.children === null) {
      entry.error = msg.error;
      stats.errors++;
      entry.children = [];
      if (msg.done) finishListing(entry, false);
      emit();
      return;
    }

    if (entry.children === null) entry.children = [];
    const names = msg.names;
    const kinds = msg.kinds;
    const sizes = msg.sizes;
    let fileSum = 0;
    const kids = entry.children;

    for (let i = 0; i < names.length; i++) {
      const kindByte = kinds ? kinds[i]! : 0;
      const isLink = (kindByte & 2) !== 0;
      const isDir = (kindByte & 1) !== 0;
      const failed = (kindByte & 8) !== 0;
      const size = sizes ? sizes[i]! : 0;
      const name = names[i]!;

      if (isDir) {
        const child: Entry = {
          name,
          path: joinPath(entry.path, name),
          parent: entry,
          kind: "dir",
          size: 0,
          children: null,
          pending: 1,
          listing: false,
          scanned: false,
          dead: false,
          gen: 0,
          depth: entry.depth + 1,
          job: null,
        };
        kids.push(child);
        addPending(entry, 1);
        stats.dirs++;
        account(name);
        schedule(child);
        continue;
      }

      const child: Entry = {
        name,
        path: "",
        parent: entry,
        kind: isLink ? "link" : "file",
        size,
        children: null,
        pending: 0,
        listing: false,
        scanned: true,
        dead: false,
        gen: 0,
        depth: entry.depth + 1,
        job: null,
      };
      if (failed) {
        child.error = "unreadable";
        stats.errors++;
      }
      kids.push(child);
      fileSum += size;
      stats.files++;
      account(name);
    }

    if (fileSum !== 0) addSize(entry, fileSum);
    entry.gen++;

    if (msg.done) finishListing(entry, false);
    emit();
    pump();
  }

  function finishListing(entry: Entry, ignored: boolean): void {
    entry.listing = false;
    entry.scanned = true;
    if (entry.children === null) entry.children = [];
    if (!ignored && !entry.dead) addPending(entry, -1);
    stats.inFlight = inflight.size;
    stats.done = stats.inFlight === 0 && heap.size === 0 && root.scanned;
  }

  function onWorkerMessage(worker: Worker, msg: WorkerResult): void {
    const entry = inflight.get(msg.id);
    if (!entry) return;
    if (msg.done) inflight.delete(msg.id);
    apply(entry, msg);
    if (msg.done && !stopped) {
      idle.push(worker);
      stats.inFlight = inflight.size;
      pump();
    }
  }

  function spawnWorker(): Worker {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.on("message", (msg: WorkerResult) => onWorkerMessage(worker, msg));
    worker.on("error", () => {
      if (stopped) return;
      const index = workers.indexOf(worker);
      if (index >= 0) workers.splice(index, 1);
      const idleIndex = idle.indexOf(worker);
      if (idleIndex >= 0) idle.splice(idleIndex, 1);
      for (const [id, entry] of inflight) {
        if (entry.listing && !entry.scanned && !entry.dead) {
          inflight.delete(id);
          entry.listing = false;
          schedule(entry);
        }
      }
      const replacement = spawnWorker();
      workers.push(replacement);
      idle.push(replacement);
      pump();
    });
    return worker;
  }

  for (let i = 0; i < parallelism; i++) {
    const worker = spawnWorker();
    workers.push(worker);
    idle.push(worker);
  }

  schedule(root);
  pump();

  return {
    root,
    stats,
    focus(entry: Entry): void {
      focusEntry = entry.kind === "dir" ? entry : (entry.parent ?? entry);
      const target = focusEntry;
      if (target.job) heap.bump(target.job, priority(target));
      const kids = target.children;
      if (kids) {
        const hot = -1_000_000;
        for (let i = 0; i < kids.length; i++) {
          const child = kids[i]!;
          if (child.kind === "dir" && child.job) heap.bump(child.job, hot);
        }
      }
      pump();
    },
    stop(): void {
      stopped = true;
      if (emitTimer) clearTimeout(emitTimer);
      for (const worker of workers) void worker.terminate();
      workers.length = 0;
      idle.length = 0;
    },
  };
}
