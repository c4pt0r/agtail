import path from "node:path";
import type { AgentEvent, Source } from "../types.ts";
import { envPath, home, summarizeInput, textOf, toDate } from "../util.ts";

// ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
// subagents: ~/.claude/projects/<cwd-slug>/<session-uuid>/subagents/agent-*.jsonl
export const claude: Source = {
  agent: "claude",

  roots() {
    const base = envPath("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
    return [path.join(base, "projects")];
  },

  init(file) {
    const parts = file.split(path.sep);
    const sub = parts.lastIndexOf("subagents");
    return {
      agent: "claude",
      file,
      id: path.basename(file, ".jsonl"),
      parent: sub > 0 ? parts[sub - 1] : undefined,
    };
  },

  parse(r, info): AgentEvent[] {
    if (!r || typeof r !== "object") return [];
    if (typeof r.cwd === "string") info.cwd = r.cwd;
    if (r.type === "ai-title" && typeof r.aiTitle === "string") info.title = r.aiTitle;
    if (r.type === "summary" && typeof r.summary === "string") info.title = r.summary;

    const time = toDate(r.timestamp);

    if (r.type === "system" && r.subtype === "api_error") {
      return [{ time, kind: "error", label: "api", text: textOf(r.content ?? r.error) }];
    }
    if (r.type === "system" && r.subtype === "compact_boundary") {
      return [{ time, kind: "meta", text: "context compacted" }];
    }
    if (r.type !== "user" && r.type !== "assistant") return [];
    if (r.isMeta) return [];

    const msg = r.message ?? {};
    const out: AgentEvent[] = [];

    if (typeof msg.content === "string") {
      out.push({ time, kind: r.type === "user" ? "user" : "assistant", text: msg.content });
      return out;
    }
    if (!Array.isArray(msg.content)) return out;

    for (const c of msg.content) {
      switch (c?.type) {
        case "text":
          out.push({ time, kind: r.type === "user" ? "user" : "assistant", text: c.text ?? "" });
          break;
        case "thinking":
          if (c.thinking) out.push({ time, kind: "thinking", text: c.thinking });
          break;
        case "tool_use":
        case "server_tool_use":
          out.push({ time, kind: "tool", label: c.name, text: summarizeInput(c.input) });
          break;
        case "tool_result":
          out.push({
            time,
            kind: c.is_error ? "error" : "result",
            text: textOf(c.content),
          });
          break;
        case "image":
          out.push({ time, kind: r.type === "user" ? "user" : "assistant", text: "[image]" });
          break;
      }
    }
    return out;
  },
};
