import type { Emitted } from "./tailer.ts";
import type { AgentEvent, SessionInfo } from "./types.ts";
import { formatInput } from "./util.ts";

export interface Matcher {
  /** Case-insensitive test against an event's label, text and tool input. */
  test(e: AgentEvent): boolean;
  /** First match position in `s`, or -1. */
  index(s: string): { at: number; len: number } | undefined;
  /** Cheap pre-check on a raw transcript file, before any JSON parsing. */
  mayContain(fileText: string): boolean;
  re: RegExp;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How a keyword can appear inside JSONL: as-is, JSON-escaped, or \uXXXX-escaped. */
function encodings(kw: string): string[] {
  const json = JSON.stringify(kw).slice(1, -1);
  const unicode = json.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return [...new Set([kw, json, unicode].map((s) => s.toLowerCase()))];
}

export function haystack(e: AgentEvent): string {
  const parts = [e.label ?? "", e.text];
  if (e.input !== undefined) parts.push(formatInput(e.input));
  return parts.join("\n");
}

export function matcher(pattern: string, regex: boolean): Matcher {
  const re = new RegExp(regex ? pattern : escapeRe(pattern), "i");
  const forms = regex ? undefined : encodings(pattern);
  return {
    re,
    test: (e) => re.test(haystack(e)),
    index(s) {
      const m = re.exec(s);
      return m && m[0].length ? { at: m.index, len: m[0].length } : undefined;
    },
    // A regex can match text that only exists after JSON decoding, so it always parses.
    mayContain: (text) => {
      if (!forms) return true;
      const lower = text.toLowerCase();
      return forms.some((f) => lower.includes(f));
    },
  };
}

/** One-line excerpt of `s` centred on the first match. */
export function snippet(s: string, m: Matcher, radius = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const hit = m.index(flat);
  if (!hit) return flat.slice(0, radius * 2);
  const start = Math.max(0, hit.at - radius);
  const end = Math.min(flat.length, hit.at + hit.len + radius);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

/** Reverse-video every match, leaving ANSI color sequences untouched. */
export function highlight(rendered: string, m: Matcher): string {
  const g = new RegExp(m.re.source, "gi");
  return rendered
    .split(/(\x1b\[[0-9;]*m)/)
    .map((part) => (part.startsWith("\x1b[") ? part : part.replace(g, (x) => (x ? `\x1b[7m${x}\x1b[27m` : x))))
    .join("");
}

export interface Session {
  info: SessionInfo;
  mtime: Date;
  events: Emitted[];
}

/**
 * Codex writes a new rollout file (same session id) each time a session is
 * resumed, and may copy earlier history into it: merge those into one session.
 */
export function mergeSessions(files: Session[]): Session[] {
  const byId = new Map<string, Session[]>();
  for (const f of files) {
    const key = `${f.info.agent}:${f.info.id}`;
    byId.set(key, [...(byId.get(key) ?? []), f]);
  }
  return [...byId.values()].map((group) => {
    if (group.length === 1) return group[0]!;
    group.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
    const seen = new Set<string>();
    const events = group
      .flatMap((g) => g.events)
      .filter((e) => {
        const k = `${e.event.time.getTime()}|${e.event.kind}|${e.event.label ?? ""}|${e.event.text}|${JSON.stringify(e.record ?? null)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.event.time.getTime() - b.event.time.getTime());
    const latest = group.at(-1)!;
    return { info: latest.info, mtime: latest.mtime, events };
  });
}
