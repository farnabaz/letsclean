import { readdir, readFile, readlink, realpath, stat, statfs } from "node:fs/promises";
import { platform } from "node:os";
import { basename, join } from "node:path";

export interface VolumeSpace {
  /** What Finder (or the mount point) calls the drive, e.g. "Macintosh HD". */
  name: string;
  /** Where it is mounted, e.g. "/" or "/Volumes/Backup". */
  mount: string;
  total: number;
  /** Space a normal user can still write. */
  free: number;
  used: number;
  /** Holds the folder being scanned. */
  current: boolean;
}

// Pseudo and image filesystems are not drives anyone fills up.
const SKIP_FS = new Set(["squashfs", "tmpfs", "devtmpfs", "overlay", "proc", "sysfs", "ramfs"]);

/** Real block-device mounts, from /proc/self/mounts. */
export async function linuxMounts(): Promise<string[]> {
  let text: string;
  try {
    text = await readFile("/proc/self/mounts", "utf8");
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const [device, mount, type] = line.split(" ");
    if (!device || !mount || !type || !device.startsWith("/dev/") || SKIP_FS.has(type)) continue;
    // Spaces and friends are octal-escaped, e.g. "\040".
    out.add(mount.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
  }
  return [...out];
}

/** The startup disk plus every drive mounted under /Volumes, as Finder lists them. */
async function macMounts(): Promise<{ name: string; mount: string }[]> {
  let rootName = "Macintosh HD";
  const others: { name: string; mount: string }[] = [];
  const volumesDev = (await stat("/Volumes")).dev;
  for (const name of await readdir("/Volumes").catch(() => [] as string[])) {
    const mount = join("/Volumes", name);
    const link = await readlink(mount).catch(() => null);
    if (link === "/") {
      rootName = name;
      continue;
    }
    if (link !== null || name.startsWith(".")) continue;
    // A leftover empty folder sits on the same device as /Volumes itself.
    const dev = await stat(mount).then((s) => s.dev, () => volumesDev);
    if (dev !== volumesDev) others.push({ name, mount });
  }
  return [{ name: rootName, mount: "/" }, ...others];
}

function isBootMount(mount: string): boolean {
  return mount === "/boot" || mount.startsWith("/boot/") || mount === "/efi";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(resolve, ms))]);
}

/** Space on every mounted drive, the one holding `path` first. */
export async function listVolumes(path: string): Promise<VolumeSpace[]> {
  const os = platform();
  const mounts =
    os === "darwin"
      ? await macMounts()
      : (await linuxMounts())
          // Boot and EFI partitions are small, fixed and not for files.
          .filter((mount) => !isBootMount(mount))
          .map((mount) => ({ name: mount === "/" ? "/" : basename(mount), mount }));
  if (mounts.length === 0) mounts.push({ name: path, mount: path });

  const here = await realpath(path).catch(() => path);
  // The deepest mount point containing the scanned folder holds it.
  let currentMount = "";
  for (const { mount } of mounts) {
    const prefix = mount.endsWith("/") ? mount : mount + "/";
    if ((here === mount || here.startsWith(prefix)) && mount.length > currentMount.length) currentMount = mount;
  }

  // A dead network mount can hang statfs; skip it instead of waiting.
  const stats = await Promise.all(mounts.map(({ mount }) => withTimeout(statfs(mount).catch(() => null), 2000)));
  const out: VolumeSpace[] = [];
  const seen = new Set<string>();
  mounts.forEach(({ name, mount }, i) => {
    const s = stats[i];
    if (!s || s.blocks === 0) return;
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    // Volumes sharing one pool (APFS Recovery, btrfs subvolumes) report the
    // same space; listing them twice says nothing new.
    const key = `${total}:${free}`;
    const current = mount === currentMount;
    if (seen.has(key)) {
      if (current) {
        const twin = out.find((v) => `${v.total}:${v.free}` === key);
        if (twin) twin.current = true;
      }
      return;
    }
    seen.add(key);
    out.push({ name, mount, total, free, used: Math.max(0, total - free), current });
  });
  out.sort((a, b) => Number(b.current) - Number(a.current));
  return out;
}
