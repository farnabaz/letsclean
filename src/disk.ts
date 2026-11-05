import { formatCount, formatRate, formatSize } from "./format.ts";
import type { Entry } from "./scan.ts";
import { detach, fullPath, startScan } from "./scan.ts";
import type { Node, ToolFactory } from "./shell.ts";

/** The default tool: an OmniDiskSweeper-style browser over a live disk scan. */
export function diskTool(rootPath: string): ToolFactory {
  return (update) => {
    const scanner = startScan(rootPath, update);
    let lastFiles = 0;
    let lastRateAt = Date.now();
    let rate = 0;
    let rss = process.memoryUsage().rss;
    let lastRssAt = 0;

    return {
      name: "letsclean",
      root: scanner.root,
      hiddenToggle: true,
      help: [
        "Sizes are allocated disk usage and grow",
        "while the scan is still running. The",
        "folder you are looking at is scanned first.",
      ],
      path: (node: Node) => fullPath(node as Entry),
      focus: (dir: Node) => scanner.focus(dir as Entry),
      detach: (node: Node) => detach(node as Entry),
      stop: () => scanner.stop(),
      stats(now: number, cols: number) {
        const stats = scanner.stats;
        if (!stats.done && now - lastRateAt >= 400) {
          rate = ((stats.files - lastFiles) * 1000) / (now - lastRateAt);
          lastFiles = stats.files;
          lastRateAt = now;
        }
        if (now - lastRssAt > 1000) {
          rss = process.memoryUsage().rss;
          lastRssAt = now;
        }
        const memory = formatSize(Math.max(stats.memory, rss)).trim();
        const files = formatCount(stats.files);
        const counts = cols >= 110 ? `${files} files  ${formatCount(stats.dirs)} dirs` : `${files} files`;
        const errors = stats.errors > 0 ? `  ${formatCount(stats.errors)} skipped` : "";
        return {
          scanning: !stats.done,
          info: stats.done ? `${counts}  ${memory}${errors}` : `${counts}  ${formatRate(rate)}  ${memory}${errors}`,
          total: formatSize(scanner.root.size).trim(),
        };
      },
    };
  };
}
