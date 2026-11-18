import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { linuxMounts } from "./volume.ts";

// Paths arrive as argv, so nothing needs escaping. Build the list outside the
// Finder block: `POSIX file` inside it resolves against Finder's terminology.
const MAC_SCRIPT = `on run argv
  set targets to {}
  repeat with p in argv
    set end of targets to (POSIX file (contents of p)) as alias
  end repeat
  tell application "Finder" to delete targets
end run`;

// Stay well under ARG_MAX; each chunk is one Finder call (one Trash sound).
const CHUNK = 500;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) => {
      if (!error) return resolve();
      // The default message echoes the whole command line, script included.
      const detail = String(stderr).trim().replace(/^.*execution error: /s, "");
      reject(new Error(detail || error.message));
    });
  });
}

/**
 * Move paths to the system Trash in as few calls as possible. Never unlinks.
 * Rejects if the batch fails as a whole; callers can retry one by one to find
 * which path was the problem.
 */
export async function trashMany(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const os = platform();
  if (os !== "darwin" && os !== "linux") throw new Error("trash is not supported on this platform");
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    if (os === "darwin") await run("osascript", ["-e", MAC_SCRIPT, ...chunk]);
    else await run("gio", ["trash", "--", ...chunk]);
  }
}

/** Move a path to the system Trash. Never unlinks it directly. */
export function trash(path: string): Promise<void> {
  return trashMany([path]);
}

// Terminals usually can't list ~/.Trash (macOS privacy protection), but Finder
// can, and the items inside can still be stat'ed. This also covers the per
// volume .Trashes folders.
const MAC_LIST = `tell application "Finder" to set found to URL of every item of trash
set AppleScript's text item delimiters to linefeed
return found as text`;

function output(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout));
      const detail = String(stderr).trim().replace(/^.*execution error: /s, "");
      reject(new Error(detail || error.message));
    });
  });
}

export interface TrashEntry {
  path: string;
  /** Name of the drive the item sits on; "" for the home Trash. */
  volume: string;
}

async function readTrashDir(dir: string, volume: string): Promise<TrashEntry[]> {
  try {
    return (await readdir(dir)).map((name) => ({ path: join(dir, name), volume }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return [];
    throw error;
  }
}

/**
 * Linux keeps one Trash in the home folder and one per drive, at
 * $mount/.Trash/$uid or $mount/.Trash-$uid (freedesktop.org Trash spec).
 */
async function linuxTrash(): Promise<TrashEntry[]> {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const home = join(data, "Trash", "files");
  const uid = process.getuid?.() ?? 0;
  const dirs = new Map<string, string>([[home, ""]]);
  for (const mount of await linuxMounts()) {
    const volume = mount === "/" ? "/" : basename(mount);
    for (const dir of [join(mount, ".Trash", String(uid), "files"), join(mount, `.Trash-${uid}`, "files")]) {
      if (!dirs.has(dir)) dirs.set(dir, volume);
    }
  }
  const found = await Promise.all([...dirs].map(([dir, volume]) => readTrashDir(dir, volume)));
  return found.flat();
}

/** The items at the top level of every mounted drive's Trash. */
export async function listTrash(): Promise<TrashEntry[]> {
  const os = platform();
  if (os === "darwin") {
    const text = await output("osascript", ["-e", MAC_LIST]);
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("file://"))
      .map((url) => {
        const path = fileURLToPath(url).replace(/\/$/, "") || "/";
        // Other drives keep theirs at /Volumes/<drive>/.Trashes/<uid>.
        return { path, volume: path.match(/^\/Volumes\/([^/]+)\//)?.[1] ?? "" };
      });
  }
  if (os === "linux") return linuxTrash();
  throw new Error("Trash is not supported on this platform");
}

/** Permanently delete everything in the Trash, the way Finder does. */
export async function emptyTrash(): Promise<void> {
  const os = platform();
  if (os === "darwin") await run("osascript", ["-e", 'tell application "Finder" to empty trash']);
  else if (os === "linux") await run("gio", ["trash", "--empty"]);
  else throw new Error("Trash is not supported on this platform");
}

export interface SizedPath {
  path: string;
  /** Drive label to show next to the name; "" for the home Trash. */
  volume?: string;
  /** Allocated bytes found so far. */
  size: number;
  done: boolean;
}

/**
 * Add up allocated sizes under each path, a few directories at a time. Calls
 * `progress` as sizes grow; stops early once `cancelled` returns true.
 */
export async function sizePaths(items: SizedPath[], progress: () => void, cancelled: () => boolean): Promise<void> {
  const queue: { path: string; item: SizedPath }[] = items.map((item) => ({ path: item.path, item }));
  const open = new Map<SizedPath, number>(items.map((item) => [item, 1]));
  let lastProgress = 0;
  const settle = (item: SizedPath): void => {
    const left = open.get(item)! - 1;
    open.set(item, left);
    if (left === 0) item.done = true;
  };
  let active = 0;
  const worker = async (): Promise<void> => {
    while (!cancelled()) {
      const job = queue.pop();
      if (!job) {
        if (active === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      active++;
      try {
        const stat = await lstat(job.path);
        job.item.size += stat.blocks > 0 ? stat.blocks * 512 : stat.size;
        if (stat.isDirectory()) {
          const names = await readdir(job.path).catch(() => [] as string[]);
          open.set(job.item, open.get(job.item)! + names.length);
          for (const name of names) queue.push({ path: job.path + "/" + name, item: job.item });
        }
      } catch {
        // Unreadable entries just don't count.
      } finally {
        active--;
        settle(job.item);
      }
      const now = Date.now();
      if (now - lastProgress > 100) {
        lastProgress = now;
        progress();
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  progress();
}
