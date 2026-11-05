import { execFile } from "node:child_process";
import { platform } from "node:os";

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
