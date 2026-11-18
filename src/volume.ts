import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";

export interface VolumeSpace {
  /** Where the volume holding the path is mounted, e.g. "/System/Volumes/Data". */
  mount: string;
  total: number;
  /** Space a normal user can still write. */
  free: number;
  used: number;
}

function mountPoint(path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("df", ["-P", path], (error, stdout) => {
      if (error) return resolve("");
      const line = String(stdout).trim().split("\n")[1] ?? "";
      // The mount point is the last column and may itself contain spaces.
      const match = line.match(/\s\d+%\s+(.*)$/);
      resolve(match ? match[1]! : "");
    });
  });
}

export async function volumeSpace(path: string): Promise<VolumeSpace> {
  const [stats, mount] = await Promise.all([statfs(path), mountPoint(path)]);
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;
  return { mount: mount || path, total, free, used: Math.max(0, total - free) };
}
