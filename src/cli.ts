#!/usr/bin/env node
import { parseArgs } from "node:util";
import { claude } from "./sources/claude.ts";
import { codex } from "./sources/codex.ts";
import { pi } from "./sources/pi.ts";
import { render, sessionLabel } from "./render.ts";
import { Tailer, type Emitted } from "./tailer.ts";
import type { AgentName, EventKind, Source } from "./types.ts";

const HELP = `agtail — tail -f for local coding agents

Usage:
  agtail [options]          follow all agent sessions live
  agtail ls [options]       list recently active sessions

Agents: claude (Claude Code), codex (Codex CLI), chatgpt (ChatGPT/Codex
desktop app & Chrome side panel), pi (pi coding agent)

Options:
  -a, --agent <list>     only these agents, comma separated
  -p, --project <text>   only sessions whose cwd contains <text>
  -s, --session <id>     only sessions whose id starts with <id>
  -k, --kinds <list>     only these event kinds:
                         user,assistant,thinking,tool,result,error,meta
  -q, --quiet            conversation only (user,assistant,error)
      --no-subagents     hide subagent / sidechain sessions
  -n, --lines <n>        replay last <n> events on start (default 20)
      --since <dur>      replay window, e.g. 30s 15m 2h 1d (default 1h; 1d for ls)
      --no-follow        print the replay and exit
  -f, --full             print full multi-line messages
                         (tool results capped at 20 lines)
  -F, --full-content     print everything untruncated: whole messages,
                         whole tool results, complete tool-call input
  -t, --text-tag         text tags like [user] [tool] instead of glyphs
  -o, --output <fmt>     text (default), jsonl (parsed events, one JSON
                         object per line) or raw (original transcript
                         records, tagged with agent and session)
      --json, --jsonl    same as -o jsonl
      --no-color         disable colors
  -h, --help             show this help

Env: CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR override locations.
`;

function duration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const mult = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? "m"]!;
  return Number(m[1]) * mult;
}

function list(s: string | undefined): string[] | undefined {
  return s ? s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : undefined;
}

function ago(d: Date) {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string", short: "a" },
      project: { type: "string", short: "p" },
      session: { type: "string", short: "s" },
      kinds: { type: "string", short: "k" },
      quiet: { type: "boolean", short: "q" },
      "no-subagents": { type: "boolean" },
      lines: { type: "string", short: "n", default: "20" },
      since: { type: "string" },
      "no-follow": { type: "boolean" },
      full: { type: "boolean", short: "f" },
      "full-content": { type: "boolean", short: "F" },
      "text-tag": { type: "boolean", short: "t" },
      output: { type: "string", short: "o", default: "text" },
      json: { type: "boolean" },
      jsonl: { type: "boolean" },
      "no-color": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const output = values.json || values.jsonl ? "jsonl" : values.output!;
  if (!["text", "jsonl", "raw"].includes(output)) {
    process.stderr.write(`agtail: unknown output format "${output}" (text, jsonl, raw)\n`);
    process.exit(2);
  }
  const raw = output === "raw";

  const agents = list(values.agent) as AgentName[] | undefined;
  const kinds = (values.quiet ? ["user", "assistant", "error"] : list(values.kinds)) as
    | EventKind[]
    | undefined;
  const isLs = positionals[0] === "ls" || positionals[0] === "list";
  const sinceMs = duration(values.since ?? (isLs ? "1d" : "1h"));
  const lines = Number(values.lines);

  // "chatgpt" sessions live in the codex store, so load codex for either.
  const sources: Source[] = [];
  if (!agents || agents.includes("claude")) sources.push(claude);
  if (!agents || agents.includes("codex") || agents.includes("chatgpt")) sources.push(codex);
  if (!agents || agents.includes("pi")) sources.push(pi);

  const keep = (e: Emitted) => {
    const s = e.session;
    if (agents && !agents.includes(s.agent)) return false;
    if (values.project && !(s.cwd ?? "").includes(values.project)) return false;
    if (values.session && !s.id.startsWith(values.session)) return false;
    if (values["no-subagents"] && s.parent) return false;
    // raw records have no event kind, so -k / -q don't apply to them
    if (kinds && !raw && !kinds.includes(e.event.kind)) return false;
    return true;
  };

  const color = !values["no-color"] && output === "text" && !process.env.NO_COLOR && process.stdout.isTTY;
  const ropts = {
    color: Boolean(color),
    full: Boolean(values.full),
    fullContent: Boolean(values["full-content"]),
    textTag: Boolean(values["text-tag"]),
    width: process.stdout.isTTY ? process.stdout.columns ?? 120 : 0,
  };
  process.stdout.on("resize", () => (ropts.width = process.stdout.columns ?? 120));
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  const print = (e: Emitted) => {
    if (!keep(e)) return;
    if (raw) {
      const s = e.session;
      process.stdout.write(
        JSON.stringify({ agent: s.agent, session: s.id, cwd: s.cwd, parent: s.parent, file: s.file, record: e.record }) + "\n",
      );
    } else if (output === "jsonl") {
      const { session: s, event: ev } = e;
      process.stdout.write(
        JSON.stringify({
          time: ev.time.toISOString(),
          agent: s.agent,
          session: s.id,
          cwd: s.cwd,
          parent: s.parent,
          kind: ev.kind,
          label: ev.label,
          text: ev.text,
          ...(values["full-content"] && ev.input !== undefined ? { input: ev.input } : {}),
        }) + "\n",
      );
    } else {
      process.stdout.write(render(e, ropts) + "\n");
    }
  };

  if (isLs) {
    const tailer = new Tailer({ sources, sinceMs, onEvent: () => {} });
    const rows = (await tailer.sessions(sinceMs)).filter((r) =>
      keep({ session: r.info, event: { time: r.mtime, kind: "meta", text: "" } }),
    );
    for (const { info, mtime } of rows) {
      const row = [ago(mtime).padStart(4), info.agent.padEnd(7), sessionLabel(info, Boolean(values["text-tag"])).padEnd(30), info.title ?? info.cwd ?? ""];
      process.stdout.write(row.join("  ") + "\n");
    }
    if (!rows.length) process.stdout.write("no active sessions\n");
    return;
  }
  if (positionals.length) {
    process.stderr.write(`unknown command: ${positionals[0]}\n\n${HELP}`);
    process.exit(2);
  }

  const tailer = new Tailer({ sources, sinceMs, raw, onEvent: print });
  const backlog = (await tailer.start()).filter(keep);
  for (const e of lines > 0 ? backlog.slice(-lines) : []) print(e);

  if (values["no-follow"]) {
    tailer.stop();
    return;
  }
  if (output === "text" && process.stderr.isTTY) {
    process.stderr.write(
      (color ? "\x1b[2m" : "") + `— following ${sources.map((s) => s.agent).join(", ")} sessions (ctrl-c to stop) —` + (color ? "\x1b[0m" : "") + "\n",
    );
  }
  const bye = () => {
    tailer.stop();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main().catch((err) => {
  process.stderr.write(`agtail: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
