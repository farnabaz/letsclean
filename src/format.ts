const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Fixed-width disk size, 8 columns. Physical bytes in, human out. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "    0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const label = UNITS[unit];
  let num: string;
  if (unit === 0) num = String(Math.round(value));
  else if (value >= 100) num = value.toFixed(0);
  else if (value >= 10) num = value.toFixed(1);
  else num = value.toFixed(2);
  const text = num + " " + label;
  return text.length >= 8 ? text : " ".repeat(8 - text.length) + text;
}

export function formatCount(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

export function formatRate(perSecond: number): string {
  if (perSecond < 10) return "0/s";
  if (perSecond < 1000) return Math.round(perSecond) + "/s";
  if (perSecond < 1_000_000) return (perSecond / 1000).toFixed(1) + "k/s";
  return (perSecond / 1_000_000).toFixed(1) + "M/s";
}

function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  // Combining marks: don't advance the column.
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  return 1;
}

/** Truncate to a terminal column width. Strips control characters. */
export function fit(text: string, width: number): string {
  if (width <= 0 || text.length === 0) return "";
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127 || text.charCodeAt(i) < 32) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    if (text.length <= width) return text;
    return width === 1 ? "…" : text.slice(0, width - 1) + "…";
  }

  let out = "";
  let used = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    i += step;
    if (cp < 32 || cp === 127) continue;
    const cw = charWidth(cp);
    if (used + cw > width) {
      if (width === 1) return "…";
      if (out.length === 0) return "…";
      return trimWidth(out, width - 1) + "…";
    }
    out += String.fromCodePoint(cp);
    used += cw;
    if (used === width) {
      if (i < text.length) return trimWidth(out, width - 1) + "…";
      return out;
    }
  }
  return out;
}

function trimWidth(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    const cw = charWidth(cp);
    if (used + cw > width) break;
    out += String.fromCodePoint(cp);
    used += cw;
  }
  return out;
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    if (cp < 32 || cp === 127) continue;
    width += charWidth(cp);
  }
  return width;
}

export function padRight(text: string, width: number): string {
  const shown = fit(text, width);
  const gap = width - visibleWidth(shown);
  return gap > 0 ? shown + " ".repeat(gap) : shown;
}

const BAR_EMPTY = "░";
const BAR_FULL = "█";
const BAR_PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function sizeBar(size: number, max: number, width: number): string {
  if (width <= 0) return "";
  if (max <= 0 || size <= 0) return BAR_EMPTY.repeat(width);
  const ratio = Math.min(1, size / max);
  const exact = ratio * width;
  const full = Math.floor(exact);
  const eighths = Math.round((exact - full) * 8);
  let bar = BAR_FULL.repeat(full);
  let used = full;
  if (eighths === 8) {
    bar += BAR_FULL;
    used++;
  } else if (eighths > 0 && used < width) {
    bar += BAR_PARTIAL[eighths];
    used++;
  }
  if (used < width) bar += BAR_EMPTY.repeat(width - used);
  return bar;
}
