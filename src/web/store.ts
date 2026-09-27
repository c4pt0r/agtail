import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import zlib from "node:zlib";
import { haystack, matcher, mergeSessions, snippet } from "../search.ts";
import { Tailer, type Emitted } from "../tailer.ts";
import type { AgentEvent, SessionInfo, Source } from "../types.ts";
import { formatInput, home } from "../util.ts";
import { tarEnd, tarEntry, untar } from "./tar.ts";

const TEXT_CAP = 100_000;

interface FileSummary {
  file: string;
  src: Source;
  mtimeMs: number;
  size: number;
  info: SessionInfo;
  events: number;
  start?: number;
  end?: number;
  first?: string;
}

export interface SessionSummary {
  key: string;
  agent: string;
  id: string;
  cwd?: string;
  title?: string;
  parent?: string;
  files: string[];
  size: number;
  events: number;
  start?: number;
  end: number;
  first?: string;
}

const key = (info: SessionInfo) => `${info.agent}:${info.id}`;

/** The first thing a person typed, skipping harness messages that start with a tag. */
function firstPrompt(events: Emitted[]): string | undefined {
  const e = events.find((x) => x.event.kind === "user" && x.event.text.trim() && !/^\s*</.test(x.event.text));
  return e?.event.text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function cap(s: string): { text: string; truncated?: boolean } {
  return s.length > TEXT_CAP ? { text: s.slice(0, TEXT_CAP), truncated: true } : { text: s };
}

function wireEvent(e: AgentEvent) {
  const t = cap(e.text);
  const input = e.input !== undefined ? cap(formatInput(e.input)) : undefined;
  return {
    t: e.time.getTime(),
    kind: e.kind,
    label: e.label,
    text: t.text,
    truncated: t.truncated || input?.truncated || undefined,
    input: input?.text,
  };
}

export class Store {
  private tailer: Tailer;
  private cache = new Map<string, FileSummary>();
  private refreshing?: Promise<SessionSummary[]>;

  constructor(private sources: Source[]) {
    this.tailer = new Tailer({ sources, sinceMs: 0, onEvent: () => {} });
  }

  /** All sessions, newest first. Only files that changed since the last call are re-read. */
  sessions(): Promise<SessionSummary[]> {
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async refresh(): Promise<SessionSummary[]> {
    const alive = new Set((await this.tailer.listFiles()).map((f) => f.file));
    for (const f of this.cache.keys()) if (!alive.has(f)) this.cache.delete(f);

    const changed = await this.tailer.readAll({
      file: (f, st) => {
        const c = this.cache.get(f);
        return !c || c.mtimeMs !== st.mtimeMs || c.size !== st.size;
      },
    });
    for (const r of changed) {
      const times = r.events.map((e) => e.event.time.getTime()).filter((t) => t > 0);
      this.cache.set(r.info.file, {
        file: r.info.file,
        src: r.src,
        mtimeMs: r.mtime.getTime(),
        size: r.size,
        info: { ...r.info },
        events: r.events.length,
        start: times.length ? Math.min(...times) : undefined,
        end: times.length ? Math.max(...times) : undefined,
        first: firstPrompt(r.events),
      });
    }

    const groups = new Map<string, FileSummary[]>();
    for (const f of this.cache.values()) groups.set(key(f.info), [...(groups.get(key(f.info)) ?? []), f]);
    return [...groups.entries()]
      .map(([k, fs]) => {
        fs.sort((a, b) => a.mtimeMs - b.mtimeMs);
        const latest = fs.at(-1)!;
        const starts = fs.map((f) => f.start).filter((x): x is number => x !== undefined);
        return {
          key: k,
          agent: latest.info.agent,
          id: latest.info.id,
          cwd: latest.info.cwd,
          title: fs.map((f) => f.info.title).filter(Boolean).at(-1),
          parent: latest.info.parent,
          files: fs.map((f) => f.file),
          size: fs.reduce((a, f) => a + f.size, 0),
          events: fs.reduce((a, f) => a + f.events, 0),
          start: starts.length ? Math.min(...starts) : undefined,
          end: Math.max(...fs.map((f) => f.end ?? f.mtimeMs)),
          first: fs.find((f) => f.first)?.first,
        };
      })
      .sort((a, b) => b.end - a.end);
  }

  async session(k: string) {
    const summary = (await this.sessions()).find((s) => s.key === k);
    if (!summary) return undefined;
    const files = new Set(summary.files);
    const [merged] = mergeSessions(await this.tailer.readAll({ file: (f) => files.has(f) }));
    return { summary, events: (merged?.events ?? []).map((e) => wireEvent(e.event)) };
  }

  async search(q: string, opts: { regex?: boolean; agents?: string[]; kinds?: string[]; limit?: number }) {
    const started = performance.now();
    const m = matcher(q, Boolean(opts.regex));
    const summaries = new Map((await this.sessions()).map((s) => [s.key, s]));
    const merged = mergeSessions(await this.tailer.readAll({ content: (t) => m.mayContain(t) }));
    const hits = merged
      .filter((s) => !opts.agents?.length || opts.agents.includes(s.info.agent))
      .map((s) => ({
        s,
        matches: s.events.filter((e) => (!opts.kinds?.length || opts.kinds.includes(e.event.kind)) && m.test(e.event)),
      }))
      .filter((h) => h.matches.length)
      .sort((a, b) => b.matches.at(-1)!.event.time.getTime() - a.matches.at(-1)!.event.time.getTime());
    const total = hits.reduce((a, h) => a + h.matches.length, 0);
    return {
      took: Math.round(performance.now() - started),
      total,
      sessions: hits.length,
      results: hits.slice(0, opts.limit ?? 200).map((h) => ({
        session: summaries.get(key(h.s.info)) ?? {
          key: key(h.s.info),
          agent: h.s.info.agent,
          id: h.s.info.id,
          cwd: h.s.info.cwd,
          title: h.s.info.title,
          files: [],
          size: 0,
          events: h.s.events.length,
          end: h.s.mtime.getTime(),
        },
        count: h.matches.length,
        matches: h.matches.slice(-8).map((e) => ({
          t: e.event.time.getTime(),
          kind: e.event.kind,
          label: e.event.label,
          snippet: snippet(haystack({ ...e.event, label: undefined }), m, 120),
        })),
      })),
    };
  }

  /** Where a session file lives in a backup: `<source>/<path under that source's root>`. */
  private archivePath(file: string): string | undefined {
    for (const src of this.sources) {
      for (const root of src.roots()) {
        const rel = path.relative(root, file);
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return `${src.agent}/${rel.split(path.sep).join("/")}`;
      }
    }
    return undefined;
  }

  /** Stream a .tar.gz of the given sessions (all when `keys` is empty) to `out`. */
  async backup(keys: string[], out: Writable, dir: string) {
    const all = await this.sessions();
    const chosen = keys.length ? all.filter((s) => keys.includes(s.key)) : all;
    const manifest = {
      format: "agtail-backup",
      version: 1,
      created: new Date().toISOString(),
      sessions: chosen.map((s) => ({
        agent: s.agent,
        id: s.id,
        cwd: s.cwd,
        title: s.title,
        first: s.first,
        start: s.start,
        end: s.end,
        files: s.files.map((f) => this.archivePath(f)).filter(Boolean),
      })),
    };

    const gz = zlib.createGzip();
    gz.pipe(out);
    const write = async (bufs: Buffer[]) => {
      for (const b of bufs) if (!gz.write(b)) await once(gz, "drain");
    };
    await write(tarEntry(`${dir}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2))));
    for (const s of chosen) {
      for (const file of s.files) {
        const rel = this.archivePath(file);
        if (!rel) continue;
        let data: Buffer;
        let stat: fs.Stats;
        try {
          [data, stat] = await Promise.all([fsp.readFile(file), fsp.stat(file)]);
        } catch {
          continue; // deleted meanwhile
        }
        await write(tarEntry(`${dir}/${rel}`, data, stat.mtime));
      }
    }
    await write([tarEnd()]);
    gz.end();
    await once(out, "finish").catch(() => {});
    return { sessions: chosen.length };
  }

  // ---- import ----

  async planImport(body: Buffer, filename: string) {
    return this.importItems(body, filename, false);
  }

  async applyImport(body: Buffer, filename: string) {
    return this.importItems(body, filename, true);
  }

  private async importItems(body: Buffer, filename: string, apply: boolean): Promise<ImportItem[]> {
    const candidates = unpack(body, filename, this.sources);
    const items: ImportItem[] = [];
    for (const c of candidates) {
      const item: ImportItem = { name: c.name, agent: c.src?.agent ?? "?", size: c.data.length, status: "invalid" };
      items.push(item);
      if (!c.src || !c.rel) {
        item.reason = c.reason ?? "not a recognised session file";
        continue;
      }
      const root = c.src.roots()[0]!;
      const target = safeJoin(root, c.rel);
      if (!target) {
        item.reason = "unsafe path";
        continue;
      }
      item.target = target.startsWith(home + path.sep) ? "~" + target.slice(home.length) : target;
      Object.assign(item, describe(c.src, target, c.data));

      let existing: Buffer | undefined;
      try {
        existing = await fsp.readFile(target);
      } catch {}
      if (!existing) item.status = "new";
      else if (existing.equals(c.data)) item.status = "same";
      else if (c.data.length > existing.length && c.data.subarray(0, existing.length).equals(existing)) item.status = "update";
      else if (existing.length > c.data.length && existing.subarray(0, c.data.length).equals(c.data)) item.status = "older";
      else item.status = "conflict";

      if (apply && (item.status === "new" || item.status === "update")) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.agtail-import-${process.pid}`;
        await fsp.writeFile(tmp, c.data);
        await fsp.rename(tmp, target);
        item.status = item.status === "new" ? "imported" : "updated";
      }
    }
    return items;
  }
}

export interface ImportItem {
  name: string;
  agent: string;
  size: number;
  status: "new" | "same" | "update" | "older" | "conflict" | "invalid" | "imported" | "updated";
  reason?: string;
  target?: string;
  id?: string;
  cwd?: string;
  title?: string;
  first?: string;
  events?: number;
}

interface Candidate {
  name: string;
  data: Buffer;
  src?: Source;
  rel?: string;
  reason?: string;
}

/** Join `rel` under `root`, refusing anything that would escape it or isn't a .jsonl. */
function safeJoin(root: string, rel: string): string | undefined {
  const norm = path.posix.normalize(rel);
  if (!norm.endsWith(".jsonl") || norm.startsWith("/") || norm.split("/").some((p) => p === ".." || p === "")) return undefined;
  const target = path.resolve(root, ...norm.split("/"));
  return target.startsWith(path.resolve(root) + path.sep) ? target : undefined;
}

function lines(data: Buffer): any[] {
  const out: any[] = [];
  for (const line of data.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Parse a session file in memory for the import preview. */
function describe(src: Source, file: string, data: Buffer) {
  const recs = lines(data);
  const info = src.init(file, recs[0]);
  const events: Emitted[] = [];
  for (const r of recs) for (const event of src.parse(r, info)) events.push({ session: info, event });
  return { id: info.id, cwd: info.cwd, title: info.title, first: firstPrompt(events), events: events.length };
}

function unpack(body: Buffer, filename: string, sources: Source[]): Candidate[] {
  let buf = body;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = zlib.gunzipSync(buf, { maxOutputLength: 4 * 1024 ** 3 });
    } catch {
      return [{ name: filename, data: body, reason: "corrupt gzip" }];
    }
  }
  const bySource = new Map(sources.map((s) => [s.agent as string, s]));

  if (buf.length >= 512 && buf.toString("ascii", 257, 262) === "ustar") {
    const files = untar(buf);
    const manifest = files.find((f) => /(^|\/)manifest\.json$/.test(f.name) && f.name.split("/").length <= 2);
    const base = manifest ? manifest.name.replace(/manifest\.json$/, "") : "";
    return files
      .filter((f) => f.name.endsWith(".jsonl"))
      .map((f) => {
        const inner = base && f.name.startsWith(base) ? f.name.slice(base.length) : f.name;
        const [head, ...rest] = inner.split("/");
        const src = bySource.get(head ?? "");
        if (src && rest.length) return { name: f.name, data: f.data, src, rel: rest.join("/") };
        return { name: f.name, data: f.data, ...place(f.data, f.name, sources) };
      });
  }
  return [{ name: filename, data: buf, ...place(buf, filename, sources) }];
}

/** Work out where a lone session file belongs from its own records. */
function place(data: Buffer, name: string, sources: Source[]): { src?: Source; rel?: string; reason?: string } {
  const recs = lines(data);
  if (!recs.length) return { reason: "no JSON lines found" };
  const base = path.basename(name).replace(/[^\w.-]/g, "_");
  const find = (a: string) => sources.find((s) => s.agent === a);
  const day = (ts: unknown) => {
    const d = new Date(typeof ts === "string" || typeof ts === "number" ? ts : Date.now());
    const x = Number.isNaN(d.getTime()) ? new Date() : d;
    return [x.getFullYear(), String(x.getMonth() + 1).padStart(2, "0"), String(x.getDate()).padStart(2, "0")];
  };

  const head = recs[0];
  if (head?.type === "session_meta") {
    const p = head.payload ?? {};
    const [y, mo, d] = day(p.timestamp ?? head.timestamp);
    const file = /^rollout-.*\.jsonl$/.test(base) ? base : `rollout-${String(p.timestamp ?? "").replace(/[:.]/g, "-")}-${p.id ?? "session"}.jsonl`;
    return { src: find("codex"), rel: `${y}/${mo}/${d}/${file}` };
  }
  if (head?.type === "session" && typeof head.cwd === "string") {
    const slug = `--${head.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const file = base.endsWith(".jsonl") ? base : `${String(head.timestamp ?? "").replace(/[:.]/g, "-")}_${head.id}.jsonl`;
    return { src: find("pi"), rel: `${slug}/${file}` };
  }
  const claudeRec = recs.find((r) => typeof r?.sessionId === "string" && (r.type === "user" || r.type === "assistant"));
  if (claudeRec) {
    const cwd = recs.find((r) => typeof r?.cwd === "string")?.cwd ?? "/imported";
    return { src: find("claude"), rel: `${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${claudeRec.sessionId}.jsonl` };
  }
  return { reason: "unknown session format" };
}
