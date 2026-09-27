// Minimal tar (ustar + PAX long paths) writer and reader, enough for session
// backups. Archives open with any standard `tar`.

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, mtime: Date, type = "0"): Buffer {
  const h = Buffer.alloc(BLOCK);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar: split at a "/" so the tail fits in 100 bytes and the head in 155
    for (let i = name.indexOf("/"); i > 0; i = name.indexOf("/", i + 1)) {
      if (Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) {
        prefix = name.slice(0, i);
        base = name.slice(i + 1);
        break;
      }
    }
  }
  h.write(base.slice(0, 100), 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, "ascii");
  h.write("        ", 148, "ascii"); // checksum placeholder
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, "ascii");
  return h;
}

function pad(size: number): Buffer {
  const r = size % BLOCK;
  return Buffer.alloc(r ? BLOCK - r : 0);
}

function fits(name: string): boolean {
  if (Buffer.byteLength(name) <= 100) return true;
  for (let i = name.indexOf("/"); i > 0; i = name.indexOf("/", i + 1)) {
    if (Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) return true;
  }
  return false;
}

/** Blocks for one file entry (with a PAX header first if the path is too long). */
export function tarEntry(name: string, data: Buffer, mtime = new Date()): Buffer[] {
  const out: Buffer[] = [];
  if (!fits(name)) {
    const rec = (len: number) => `${len} path=${name}\n`;
    let len = Buffer.byteLength(rec(0));
    while (Buffer.byteLength(rec(len)) !== len) len = Buffer.byteLength(rec(len));
    const pax = Buffer.from(rec(len));
    out.push(header("PaxHeader", pax.length, mtime, "x"), pax, pad(pax.length));
  }
  out.push(header(name, data.length, mtime), data, pad(data.length));
  return out;
}

export function tarEnd(): Buffer {
  return Buffer.alloc(BLOCK * 2);
}

export interface TarFile {
  name: string;
  data: Buffer;
}

function str(b: Buffer, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const nul = s.indexOf(0);
  return (nul >= 0 ? s.subarray(0, nul) : s).toString("utf8");
}

/** Parse a tar archive into its regular files. */
export function untar(buf: Buffer): TarFile[] {
  const files: TarFile[] = [];
  let off = 0;
  let longName: string | undefined;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156]!);
    const data = buf.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "L") {
      longName = str(data, 0, data.length);
      continue;
    }
    const prefix = str(h, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    longName = undefined;
    if (type === "0" || type === "\0") files.push({ name, data: Buffer.from(data) });
  }
  return files;
}
