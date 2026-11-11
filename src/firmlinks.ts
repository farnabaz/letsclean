import { readFileSync } from "node:fs";

/** Where the writable Data volume is mounted on macOS 10.15+. */
const DATA_MOUNT = "/System/Volumes/Data";

/** Defines the firmlinks: "<path on the System volume>\t<path relative to the Data volume>". */
const FIRMLINKS_FILE = "/usr/share/firmlinks";

function within(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(root + "/");
}

/**
 * On macOS, /Users, /Applications, /private and friends are firmlinks into
 * /System/Volumes/Data. Both paths are the same directory, so a scan that
 * reaches both would count the same bytes twice. When the firmlink path is
 * inside the scan root, its /System/Volumes/Data twin is skipped and the data
 * is counted once, under the familiar path. Scanning /System/Volumes/Data on
 * its own still works, because then the firmlink paths are out of scope.
 */
export function firmlinkShadows(rootPath: string): Set<string> {
  const shadows = new Set<string>();
  if (process.platform !== "darwin") return shadows;
  let text: string;
  try {
    text = readFileSync(FIRMLINKS_FILE, "utf8");
  } catch {
    return shadows;
  }
  for (const line of text.split("\n")) {
    const [source, target] = line.trim().split("\t");
    if (!source || !target) continue;
    const shadow = DATA_MOUNT + "/" + target.replace(/^\/+/, "");
    if (within(source, rootPath) && within(shadow, rootPath) && shadow !== rootPath) shadows.add(shadow);
  }
  return shadows;
}
