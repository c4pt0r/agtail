import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, SessionInfo, Source } from "./types.ts";

export interface Emitted {
  session: SessionInfo;
  event: AgentEvent;
}

interface Tracked {
  src: Source;
  file: string;
  offset: number;
  rest: Buffer;
  info?: SessionInfo;
  busy: boolean;
  again: boolean;
}

export interface TailerOptions {
  sources: Source[];
  /** Files touched within this window get their recent history replayed. */
  sinceMs: number;
  /** Max bytes read from the end of each file for replay. */
  backlogBytes?: number;
  rescanMs?: number;
  onEvent: (e: Emitted) => void;
}

const MAX_HEADER = 8 * 1024 * 1024;

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p, out);
      if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }),
  );
}

/** Read the first line of a file; session headers can be several MB (codex). */
async function firstLine(file: string): Promise<unknown> {
  const fh = await fsp.open(file, "r");
  try {
    const chunks: Buffer[] = [];
    let pos = 0;
    while (pos < MAX_HEADER) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const nl = buf.subarray(0, bytesRead).indexOf(10);
      if (nl >= 0) {
        chunks.push(buf.subarray(0, nl));
        break;
      }
      chunks.push(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    await fh.close();
  }
}

export class Tailer {
  private files = new Map<string, Tracked>();
  private watchers: fs.FSWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private started = false;

  constructor(private opts: TailerOptions) {}

  /** Discover sessions and return replayed backlog events (sorted by time). */
  async start(): Promise<Emitted[]> {
    const now = Date.now();
    const backlog: Emitted[] = [];
    const found = await this.discover();
    await Promise.all(
      found.map(async ({ src, file, stat }) => {
        const t = this.track(src, file, stat);
        t.offset = stat.size;
        if (now - stat.mtimeMs <= this.opts.sinceMs) {
          backlog.push(...(await this.replay(t, stat.size)));
        }
      }),
    );
    this.started = true;
    this.watch();
    return backlog.sort((a, b) => a.event.time.getTime() - b.event.time.getTime());
  }

  /** Sessions with activity inside the window, newest first. */
  async sessions(sinceMs: number): Promise<{ info: SessionInfo; mtime: Date }[]> {
    const now = Date.now();
    const found = await this.discover();
    const recent = found.filter((f) => now - f.stat.mtimeMs <= sinceMs);
    const out = await Promise.all(
      recent.map(async ({ src, file, stat }) => {
        const t = this.track(src, file, stat);
        await this.replay(t, stat.size);
        return { info: t.info!, mtime: stat.mtime };
      }),
    );
    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  stop() {
    for (const w of this.watchers) w.close();
    if (this.timer) clearInterval(this.timer);
  }

  private async discover() {
    const found: { src: Source; file: string; stat: fs.Stats }[] = [];
    for (const src of this.opts.sources) {
      for (const root of src.roots()) {
        const files: string[] = [];
        await walk(root, files);
        await Promise.all(
          files.map(async (file) => {
            try {
              found.push({ src, file, stat: await fsp.stat(file) });
            } catch {}
          }),
        );
      }
    }
    return found;
  }

  private track(src: Source, file: string, stat: fs.Stats): Tracked {
    let t = this.files.get(file);
    if (!t) {
      t = { src, file, offset: 0, rest: Buffer.alloc(0), busy: false, again: false };
      this.files.set(file, t);
    }
    return t;
  }

  private async ensureInfo(t: Tracked): Promise<SessionInfo> {
    if (!t.info) t.info = t.src.init(t.file, await firstLine(t.file));
    return t.info;
  }

  private parseLines(t: Tracked, info: SessionInfo, lines: string[]): Emitted[] {
    const out: Emitted[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      for (const event of t.src.parse(rec, info)) {
        if (event.text || event.label) out.push({ session: info, event });
      }
    }
    return out;
  }

  private async replay(t: Tracked, size: number): Promise<Emitted[]> {
    const info = await this.ensureInfo(t);
    const want = this.opts.backlogBytes ?? 512 * 1024;
    const start = Math.max(0, size - want);
    const fh = await fsp.open(t.file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift(); // partial first line
      lines.pop(); // possibly incomplete last line; picked up by follow
      return this.parseLines(t, info, lines);
    } finally {
      await fh.close();
    }
  }

  private async pump(t: Tracked): Promise<void> {
    if (t.busy) {
      t.again = true;
      return;
    }
    t.busy = true;
    try {
      do {
        t.again = false;
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(t.file);
        } catch {
          this.files.delete(t.file);
          return;
        }
        if (stat.size < t.offset) {
          // truncated or rewritten: start over
          t.offset = 0;
          t.rest = Buffer.alloc(0);
        }
        if (stat.size === t.offset) continue;
        const info = await this.ensureInfo(t);
        const fh = await fsp.open(t.file, "r");
        let chunk: Buffer;
        try {
          chunk = Buffer.alloc(stat.size - t.offset);
          const { bytesRead } = await fh.read(chunk, 0, chunk.length, t.offset);
          chunk = chunk.subarray(0, bytesRead);
        } finally {
          await fh.close();
        }
        t.offset += chunk.length;
        const data = Buffer.concat([t.rest, chunk]);
        const nl = data.lastIndexOf(10);
        if (nl < 0) {
          t.rest = data;
          continue;
        }
        t.rest = Buffer.from(data.subarray(nl + 1));
        const lines = data.subarray(0, nl).toString("utf8").split("\n");
        for (const e of this.parseLines(t, info, lines)) this.opts.onEvent(e);
      } while (t.again);
    } finally {
      t.busy = false;
    }
  }

  private onChange(src: Source, file: string) {
    if (!file.endsWith(".jsonl")) return;
    const known = this.files.get(file);
    if (known) {
      void this.pump(known);
      return;
    }
    fsp
      .stat(file)
      .then((stat) => {
        if (!stat.isFile() || this.files.has(file)) return;
        // brand-new session: read it from the beginning
        void this.pump(this.track(src, file, stat));
      })
      .catch(() => {});
  }

  private watch() {
    for (const src of this.opts.sources) {
      for (const root of src.roots()) {
        try {
          const w = fs.watch(root, { recursive: true }, (_ev, name) => {
            if (name) this.onChange(src, path.join(root, name.toString()));
          });
          w.on("error", () => {});
          this.watchers.push(w);
        } catch {
          // root missing or recursive watch unsupported: rescans cover it
        }
      }
    }
    // Safety net for missed fs events and roots created after startup.
    this.timer = setInterval(() => void this.rescan(), this.opts.rescanMs ?? 3000);
  }

  private async rescan() {
    if (!this.started) return;
    for (const { src, file, stat } of await this.discover()) {
      const t = this.files.get(file);
      if (!t) this.onChange(src, file);
      else if (stat.size !== t.offset) void this.pump(t);
    }
  }
}
