import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { firmlinkShadows } from "./firmlinks.ts";
import { formatCount, formatSize } from "./format.ts";
import type { Node, ToolFactory } from "./shell.ts";

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

interface FindResult {
  id: number;
  junk?: string[];
  descend?: string[];
  size?: number;
  error?: string;
}

/** A found junk directory, shown as one row of a flat list. */
interface Found extends Node {
  path: string;
}

/** `--nodejs`: a flat list of regenerable directories found under the root. */
export function nodeCleanTool(rootPath: string): ToolFactory {
  return (update) => {
    const root: Found = {
      name: rootPath,
      path: rootPath,
      parent: null,
      kind: "dir",
      size: 0,
      children: [],
      pending: 1,
      dead: false,
      gen: 0,
    };

    const shadows = firmlinkShadows(rootPath);
    let queued = 1;
    let running = 0;
    let found = 0;
    let measured = 0;

    const parallelism = Math.min(32, Math.max(4, availableParallelism() * 2));
    let nextId = 1;
    const waiting = new Map<number, (result: FindResult) => void>();

    function ask(worker: Worker, op: string, path: string): Promise<FindResult> {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        worker.postMessage({ id, op, path });
      });
    }

    const workers = Array.from({ length: parallelism }, () => {
      const worker = new Worker(WORKER_SOURCE, { eval: true });
      worker.on("message", (msg: FindResult) => {
        const resolve = waiting.get(msg.id);
        if (!resolve) return;
        waiting.delete(msg.id);
        resolve(msg);
      });
      return worker;
    });

    const sizeQueue: Found[] = [];
    let sizing = 0;

    async function measureNext(): Promise<void> {
      const item = sizeQueue.shift();
      if (!item) return;
      sizing++;
      const worker = workers[sizing % workers.length]!;
      const result = await ask(worker, "size", item.path);
      sizing--;
      if (!item.dead) {
        item.size = result.size ?? 0;
        item.pending = 0;
        root.size += item.size;
        root.pending--;
        root.gen++;
      }
      measured++;
      update();
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
          const rel = path.startsWith(rootPath + "/") ? path.slice(rootPath.length + 1) : path;
          const item: Found = {
            name: rel,
            path,
            parent: root,
            kind: "dir",
            size: 0,
            children: null,
            pending: 1,
            dead: false,
            gen: 0,
          };
          root.children!.push(item);
          root.pending++;
          root.gen++;
          found++;
          sizeQueue.push(item);
        }
        for (const name of result.descend ?? []) {
          const path = dir === "/" ? "/" + name : dir + "/" + name;
          // Firmlink twin of a path already being walked; would list every hit twice.
          if (shadows.has(path)) continue;
          queued++;
          void walk(path);
        }
      }
      if (running === 0 && queued === 0) {
        root.pending--;
        root.gen++;
      }
      while (sizeQueue.length > 0 && sizing < parallelism) void measureNext();
      update();
    }

    void walk(rootPath);

    return {
      name: "letsclean --nodejs",
      root,
      help: [
        "Finds directories you can regenerate:",
        [...JUNK].join("  "),
        "",
        "Nothing is deleted outright. Trash",
        "always asks for confirmation first.",
      ],
      path: (node: Node) => (node as Found).path,
      // Junk directories are leaves here; open them with ctrl-o instead.
      canOpen: () => false,
      detach(node: Node) {
        const item = node as Found;
        const kids = root.children!;
        const index = kids.indexOf(item);
        if (index >= 0) kids.splice(index, 1);
        root.size -= item.size;
        if (item.pending > 0) root.pending--;
        root.gen++;
      },
      stop() {
        for (const worker of workers) void worker.terminate();
      },
      stats() {
        const scanning = running > 0 || queued > 0 || sizing > 0 || sizeQueue.length > 0;
        const count = root.children!.length;
        return {
          scanning,
          info: scanning ? `${formatCount(found)} found  ${formatCount(measured)} measured` : `${formatCount(count)} dirs`,
          total: `${formatSize(root.size).trim()} reclaimable`,
        };
      },
    };
  };
}
