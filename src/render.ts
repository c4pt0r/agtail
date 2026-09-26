import type { AgentName, EventKind } from "./types.ts";
import type { Emitted } from "./tailer.ts";
import { formatInput, project, shortId } from "./util.ts";

export interface RenderOptions {
  color: boolean;
  /** Show full multi-line text instead of one truncated line per event. */
  full: boolean;
  width: number;
  /** Prefix each line with the full local date, not just the time of day. */
  date: boolean;
  /** Like `full`, but nothing is shortened: whole tool results and raw tool inputs. */
  fullContent: boolean;
  /** Plain-text tags like [tool] instead of glyphs. */
  textTag: boolean;
}

const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const C = {
  dim: esc("2"),
  bold: esc("1"),
  italic: esc("3"),
  red: esc("31"),
  green: esc("32"),
  yellow: esc("33"),
  blue: esc("34"),
  magenta: esc("35"),
  cyan: esc("36"),
  orange: esc("38;5;208"),
};

const AGENT_COLOR: Record<AgentName, (s: string) => string> = {
  claude: C.orange,
  codex: C.cyan,
  chatgpt: C.green,
  pi: C.magenta,
};

const KIND: Record<EventKind, { glyph: string; tag: string; color: (s: string) => string }> = {
  user: { glyph: "❯", tag: "[user]", color: (s) => C.bold(C.green(s)) },
  assistant: { glyph: "●", tag: "[asst]", color: (s) => s },
  thinking: { glyph: "∴", tag: "[think]", color: (s) => C.dim(C.italic(s)) },
  tool: { glyph: "⚙", tag: "[tool]", color: C.yellow },
  result: { glyph: "↳", tag: "[result]", color: C.dim },
  error: { glyph: "✗", tag: "[error]", color: C.red },
  meta: { glyph: "·", tag: "[meta]", color: (s) => C.dim(C.magenta(s)) },
};
const TAG_WIDTH = 8;

// 256-color palette entries that read well on dark and light backgrounds.
const SESSION_COLORS = [33, 39, 41, 69, 75, 105, 135, 141, 166, 172, 178, 204, 209, 214];
function sessionColor(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return esc(`38;5;${SESSION_COLORS[Math.abs(h) % SESSION_COLORS.length]}`);
}

function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

function truncate(s: string, width: number): string {
  if (width <= 1) return "";
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width - 1) return out + "…";
    out += ch;
    w += cw;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "HH:MM:SS", or "YYYY-MM-DD HH:MM:SS" with `date`. */
export function stamp(d: Date, date = true) {
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t;
}

export function sessionLabel(e: Emitted["session"], textTag = false) {
  const tag = `${project(e.cwd)}#${shortId(e.id)}`;
  if (!e.parent) return tag;
  return textTag ? `${tag}(sub)` : `${tag}↳`;
}

export function render(e: Emitted, o: RenderOptions): string {
  const paint = (f: (s: string) => string, s: string) => (o.color ? f(s) : s);
  const { session, event } = e;
  const k = KIND[event.kind];

  const agent = session.agent.padEnd(7);
  const label = sessionLabel(session, o.textTag);
  const prefix =
    `${paint(C.dim, stamp(event.time, o.date))} ` +
    `${paint(AGENT_COLOR[session.agent], agent)} ` +
    `${paint(sessionColor(session.file), label)} `;
  const prefixWidth = (o.date ? 20 : 9) + 8 + label.length + 1;

  const mark = o.textTag ? k.tag.padEnd(TAG_WIDTH) : k.glyph;
  const head = event.label ? `${mark} ${event.label}` : mark;
  const text =
    o.fullContent && event.input !== undefined ? formatInput(event.input) : event.text;
  const body = text.replace(/\r/g, "");

  if (!o.full && !o.fullContent) {
    const one = body.replace(/\s+/g, " ").trim();
    const room = o.width - prefixWidth - head.length - 1;
    const text = o.width > 0 ? truncate(one, Math.max(room, 20)) : one;
    return `${prefix}${paint(k.color, head)} ${paint(k.color, text)}`;
  }

  const indent = " ".repeat(Math.min(prefixWidth, o.date ? 35 : 24)) + "  ";
  let lines = body.split("\n");
  if (!o.fullContent && event.kind === "result" && lines.length > 20) {
    lines = [...lines.slice(0, 20), `… ${lines.length - 20} more lines`];
  }
  const [first, ...rest] = lines;
  return [
    `${prefix}${paint(k.color, head)} ${paint(k.color, first ?? "")}`,
    ...rest.map((l) => indent + paint(k.color, l)),
  ].join("\n");
}
