import { readFileSync } from "node:fs";

/**
 * Filesystems the kernel builds in memory. Nothing in them is on disk, and
 * some report absurd sizes: /proc/kcore claims the whole kernel address space
 * (128 TB on x86-64). Listing them is also slow and mostly fails without root.
 * tmpfs is left in, since /tmp or /dev/shm can hold real user files.
 */
const PSEUDO_TYPES = new Set([
  "autofs",
  "binfmt_misc",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "efivarfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "proc",
  "pstore",
  "rpc_pipefs",
  "securityfs",
  "selinuxfs",
  "sysfs",
  "tracefs",
]);

function within(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(root + "/");
}

/** /proc/self/mounts escapes space, tab, newline and backslash as \ooo. */
function unescapeMount(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Linux mount points of pseudo filesystems inside the scan root, to be left
 * out like `du -x` would. The root itself is never returned, so scanning
 * /proc directly still works.
 */
export function pseudoMounts(rootPath: string): Set<string> {
  const mounts = new Set<string>();
  if (process.platform !== "linux") return mounts;
  let text: string;
  try {
    text = readFileSync("/proc/self/mounts", "utf8");
  } catch {
    return mounts;
  }
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 3 || !PSEUDO_TYPES.has(fields[2]!)) continue;
    const mount = unescapeMount(fields[1]!);
    if (mount !== rootPath && within(mount, rootPath)) mounts.add(mount);
  }
  return mounts;
}
