#!/usr/bin/env node
import { parseArgs } from "node:util";
import { claude } from "./sources/claude.ts";
import { codex } from "./sources/codex.ts";
import { pi } from "./sources/pi.ts";
import { render, sessionLabel, stamp } from "./render.ts";
import { haystack, highlight, matcher, mergeSessions, snippet } from "./search.ts";
import { Tailer, type Emitted } from "./tailer.ts";
import type { AgentName, EventKind, Source } from "./types.ts";

const HELP = `agtail — tail -f for local coding agents

Usage:
  agtail [options]          follow all agent sessions live
  agtail ls [options]       list recently active sessions
  agtail grep <keyword>     find sessions containing <keyword> (all history),
                            then keep printing new matches live
  agtail show <session-id>  print a whole session from the start

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
      --no-follow        print the replay (or grep's history results) and exit
  -f, --full             print full multi-line messages
                         (tool results capped at 20 lines)
  -F, --full-content     print everything untruncated: whole messages,
                         whole tool results, complete tool-call input
  -t, --text-tag         text tags like [user] [tool] instead of glyphs
  -T, --timestamps       full date and time on each line (default for
                         grep / show; live mode shows time of day only)
  -o, --output <fmt>     text (default), jsonl (parsed events, one JSON
                         object per line) or raw (original transcript
                         records, tagged with agent and session)
      --json, --jsonl    same as -o jsonl
      --no-color         disable colors
  -h, --help             show this help

grep / show:
  -E, --regex            treat the keyword as a regular expression
                         (matching is always case-insensitive)
  -l, --list             grep: only list matching sessions
      --max <n>          grep: matching lines shown per session (default 5)
      --show             grep: print every matching session in full
  -a/-p/-k/--since also narrow grep and show; -f/-F/-t/-o shape the output.
  <session-id> can be any unique prefix, e.g. the 8 chars after "#".

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
      timestamps: { type: "boolean", short: "T" },
      output: { type: "string", short: "o", default: "text" },
      json: { type: "boolean" },
      jsonl: { type: "boolean" },
      "no-color": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      regex: { type: "boolean", short: "E" },
      list: { type: "boolean", short: "l" },
      max: { type: "string", default: "5" },
      show: { type: "boolean" },
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
  const cmd = positionals[0];
  const isLs = cmd === "ls" || cmd === "list";
  const isHistory = cmd === "grep" || cmd === "show";
  // grep / show search all history unless --since is given
  const sinceMs = values.since ? duration(values.since) : isLs ? 864e5 : isHistory ? Infinity : 36e5;
  const lines = Number(values.lines);

  // "chatgpt" sessions live in the codex store, so load codex for either.
  const sources: Source[] = [];
  if (!agents || agents.includes("claude")) sources.push(claude);
  if (!agents || agents.includes("codex") || agents.includes("chatgpt")) sources.push(codex);
  if (!agents || agents.includes("pi")) sources.push(pi);

  const sessionOk = (s: Emitted["session"]) => {
    if (agents && !agents.includes(s.agent)) return false;
    if (values.project && !(s.cwd ?? "").includes(values.project)) return false;
    if (values.session && !s.id.startsWith(values.session)) return false;
    if (values["no-subagents"] && s.parent) return false;
    return true;
  };
  const keep = (e: Emitted) => {
    if (!sessionOk(e.session)) return false;
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
    date: Boolean(values.timestamps) || isHistory,
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

  const header = (info: Emitted["session"], extra: string) => {
    if (output !== "text") return;
    const tag = `${info.agent} ${sessionLabel(info, ropts.textTag)}`;
    const line = [tag, info.id, extra, info.cwd, info.title].filter(Boolean).join("  ·  ");
    process.stdout.write((color ? `\x1b[1;36m── ${line}\x1b[0m` : `── ${line}`) + "\n");
  };

  async function history() {
    const arg = positionals.slice(1).join(" ");
    if (!arg) {
      process.stderr.write(`agtail ${cmd}: missing ${cmd === "grep" ? "<keyword>" : "<session-id>"}\n`);
      process.exit(2);
    }
    const since = Number.isFinite(sinceMs) ? sinceMs : undefined;
    const printSession = (events: Emitted[]) => {
      for (const e of events) if (keep(e)) print(e);
    };

    if (cmd === "show") {
      const q = arg.toLowerCase();
      const found = mergeSessions(
        await new Tailer({ sources, sinceMs: 0, raw, onEvent: () => {} }).readAll({
          sinceMs: since,
          file: (f) => f.toLowerCase().includes(q),
        }),
      ).filter((s) => s.info.id.toLowerCase().startsWith(q) && sessionOk(s.info));
      if (!found.length) {
        process.stderr.write(`agtail show: no session matches "${arg}"\n`);
        process.exit(1);
      }
      if (found.length > 1) {
        process.stderr.write(`agtail show: "${arg}" matches ${found.length} sessions, use a longer prefix:\n`);
        for (const s of found) process.stderr.write(`  ${s.info.agent.padEnd(7)} ${s.info.id}  ${s.info.cwd ?? ""}\n`);
        process.exit(1);
      }
      const [s] = found;
      header(s!.info, `${ago(s!.mtime)} ago`);
      printSession(s!.events);
      return;
    }

    // grep: matches from history, then new ones as they are written (like tail -f | grep)
    if (raw && !values.show) {
      process.stderr.write("agtail grep: -o raw needs --show (raw records are printed per session)\n");
      process.exit(2);
    }
    let m;
    try {
      m = matcher(arg, Boolean(values.regex));
    } catch (err) {
      process.stderr.write(`agtail grep: bad regex: ${(err as Error).message}\n`);
      process.exit(2);
    }
    const follow = !values["no-follow"];
    const started = performance.now();
    const took = () => {
      const ms = performance.now() - started;
      return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
    };
    const sid = (s: Emitted["session"]) => `${s.agent}:${s.id}`;
    const evKey = (e: Emitted) =>
      `${e.session.file}|${e.event.time.getTime()}|${e.event.kind}|${e.event.text}|${e.record ? JSON.stringify(e.record) : ""}`;
    const isHit = (e: Emitted) =>
      raw ? sessionOk(e.session) && (e.parsed ?? []).some((ev) => m.test(ev)) : keep(e) && m.test(e.event);

    // Watch before reading history so nothing written in between is lost; events
    // that arrive meanwhile wait until history is printed and are de-duplicated.
    const pending: Emitted[] = [];
    let live: ((e: Emitted) => void) | undefined;
    const watcher = follow
      ? new Tailer({ sources, sinceMs: 0, raw, onEvent: (e) => (live ? live(e) : pending.push(e)) })
      : undefined;
    await watcher?.start();

    const sessions = mergeSessions(
      await new Tailer({ sources, sinceMs: 0, onEvent: () => {} }).readAll({
        sinceMs: since,
        content: (text) => m.mayContain(text),
      }),
    );
    const hits = sessions
      .filter((s) => sessionOk(s.info))
      .map((s) => ({ ...s, matches: s.events.filter((e) => keep(e) && m.test(e.event)) }))
      .filter((s) => s.matches.length)
      .sort((a, b) => a.matches.at(-1)!.event.time.getTime() - b.matches.at(-1)!.event.time.getTime());

    if (!hits.length) {
      process.stderr.write(`no sessions contain "${arg}" (${took()})\n`);
      if (!follow) process.exit(1);
    }

    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : w.endsWith("h") ? "es" : "s"}`;
    const max = Number(values.max);
    const listRow = (info: Emitted["session"], n: number, last: Date) => {
      const row = [`${stamp(last)} ${`(${ago(last)})`.padEnd(6)}`, info.agent.padEnd(7), info.id.padEnd(38), plural(n, "match").padEnd(11), info.cwd ?? ""];
      process.stdout.write(row.join("  ") + "\n");
    };
    const matchLine = (e: Emitted) => {
      // one line centred on the match; the tool name stays in the label
      const text = snippet(haystack({ ...e.event, label: undefined }), m);
      const line = render({ ...e, event: { ...e.event, text, input: undefined } }, { ...ropts, full: false, fullContent: false });
      process.stdout.write((color ? highlight(line, m) : line) + "\n");
    };

    const seen = new Set<string>();
    if (values.show) {
      let rawById: Map<string, Emitted[]> | undefined;
      if (raw && hits.length) {
        // re-read every file of each hit session (resumed codex sessions span several)
        const ids = new Set(hits.map((h) => h.info.id));
        const rawSessions = mergeSessions(
          await new Tailer({ sources, sinceMs: 0, raw: true, onEvent: () => {} }).readAll({
            file: (f) => [...ids].some((id) => f.includes(id)),
          }),
        );
        rawById = new Map(rawSessions.map((s) => [s.info.id, s.events]));
      }
      for (const h of hits) {
        const events = rawById?.get(h.info.id) ?? h.events;
        for (const e of events) seen.add(evKey(e));
        header(h.info, plural(h.matches.length, "match"));
        printSession(events);
        if (output === "text") process.stdout.write("\n");
      }
    } else {
      for (const h of hits) {
        for (const e of h.matches) seen.add(evKey(e));
        const n = h.matches.length;
        if (output === "jsonl") {
          for (const e of h.matches) print(e);
        } else if (values.list) {
          listRow(h.info, n, h.matches.at(-1)!.event.time);
        } else {
          header(h.info, plural(n, "match"));
          for (const e of h.matches.slice(-max)) matchLine(e);
          if (n > max) process.stdout.write(`   … ${n - max} earlier matches; agtail show ${h.info.id.slice(0, 8)}\n`);
          process.stdout.write("\n");
        }
      }
    }
    if (hits.length && output === "text") {
      const total = hits.reduce((a, h) => a + h.matches.length, 0);
      process.stderr.write(`${plural(total, "match")} in ${plural(hits.length, "session")} (${took()})\n`);
    }
    if (!watcher) return;

    if (output === "text" && process.stderr.isTTY) {
      process.stderr.write((color ? "\x1b[2m" : "") + `— following new matches for "${arg}" (ctrl-c to stop) —` + (color ? "\x1b[0m" : "") + "\n");
    }
    const matched = new Map(hits.map((h) => [sid(h.info), h.matches.length]));
    let lastHeader: string | undefined;
    live = (e) => {
      if (seen.has(evKey(e))) return;
      const id = sid(e.session);
      const hit = isHit(e);
      if (values.show) {
        // stream every event of sessions that have matched; a session that
        // first matches now starts streaming from this event
        if (hit && !matched.has(id)) {
          matched.set(id, 1);
          header(e.session, "new match");
        }
        if (matched.has(id) && keep(e)) print(e);
        return;
      }
      if (!hit) return;
      const n = (matched.get(id) ?? 0) + 1;
      matched.set(id, n);
      if (output === "jsonl") {
        print(e);
      } else if (values.list) {
        if (n === 1) listRow(e.session, n, e.event.time);
      } else {
        if (lastHeader !== id) header(e.session, "live");
        lastHeader = id;
        matchLine(e);
      }
    };
    for (const e of pending.splice(0)) live(e);
    const bye = () => {
      watcher.stop();
      process.exit(0);
    };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
  }

  if (isLs) {
    const tailer = new Tailer({ sources, sinceMs, onEvent: () => {} });
    const rows = (await tailer.sessions(sinceMs)).filter((r) => sessionOk(r.info));
    for (const { info, mtime } of rows) {
      const row = [ago(mtime).padStart(4), info.agent.padEnd(7), sessionLabel(info, Boolean(values["text-tag"])).padEnd(30), info.title ?? info.cwd ?? ""];
      process.stdout.write(row.join("  ") + "\n");
    }
    if (!rows.length) process.stdout.write("no active sessions\n");
    return;
  }
  if (isHistory) {
    await history();
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
