import { execFile } from "node:child_process";
import { platform } from "node:os";

/** Move a path to the system Trash. Never unlinks it directly. */
export function trash(path: string): Promise<void> {
  const os = platform();
  return new Promise((resolve, reject) => {
    if (os === "darwin") {
      const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      execFile(
        "osascript",
        ["-e", `tell application "Finder" to delete POSIX file "${escaped}"`],
        (error) => (error ? reject(error) : resolve()),
      );
      return;
    }
    if (os === "linux") {
      execFile("gio", ["trash", path], (error) => (error ? reject(error) : resolve()));
      return;
    }
    reject(new Error("trash is not supported on this platform"));
  });
}
