import path from "node:path";
import type { AgentEvent, SessionInfo, Source } from "../types.ts";
import { envPath, home, summarizeInput, textOf, toDate } from "../util.ts";

// ~/.pi/agent/sessions/--<cwd-slug>--/<ts>_<uuid>.jsonl
export const pi: Source = {
  agent: "pi",

  roots() {
    return [path.join(envPath("PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent")), "sessions")];
  },

  init(file, header: any) {
    const info: SessionInfo = {
      agent: "pi",
      file,
      id: path.basename(file, ".jsonl").replace(/^.*_/, ""),
    };
    if (header?.type === "session") {
      if (typeof header.id === "string") info.id = header.id;
      if (typeof header.cwd === "string") info.cwd = header.cwd;
      if (header.parentSession) info.parent = String(header.parentSession);
    }
    return info;
  },

  parse(r, info): AgentEvent[] {
    if (!r || typeof r !== "object") return [];
    const time = toDate(r.timestamp);

    switch (r.type) {
      case "session":
        if (typeof r.cwd === "string") info.cwd = r.cwd;
        return [];
      case "model_change":
        return [{ time, kind: "meta", text: `model → ${r.provider ?? ""}/${r.modelId ?? ""}` }];
      case "compaction":
        return [{ time, kind: "meta", text: "context compacted" }];
      case "session_info":
        if (typeof r.name === "string") info.title = r.name;
        return [];
      case "message":
        break;
      default:
        return [];
    }

    const m = r.message ?? {};
    const out: AgentEvent[] = [];
    switch (m.role) {
      case "user":
        out.push({ time, kind: "user", text: textOf(m.content) });
        break;
      case "assistant":
        for (const c of Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]) {
          if (c?.type === "text" && c.text) out.push({ time, kind: "assistant", text: c.text });
          else if (c?.type === "thinking" && c.thinking) out.push({ time, kind: "thinking", text: c.thinking });
          else if (c?.type === "toolCall")
            out.push({ time, kind: "tool", label: c.name, text: summarizeInput(c.arguments), input: c.arguments });
        }
        if (m.stopReason === "error" && m.errorMessage)
          out.push({ time, kind: "error", text: String(m.errorMessage) });
        break;
      case "toolResult":
        out.push({ time, kind: m.isError ? "error" : "result", text: textOf(m.content) });
        break;
      case "bashExecution":
        out.push({ time, kind: "tool", label: "!bash", text: String(m.command ?? "") });
        if (m.output) out.push({ time, kind: "result", text: String(m.output) });
        break;
      default:
        if (m.content) out.push({ time, kind: "meta", label: m.role, text: textOf(m.content) });
    }
    return out;
  },
};
