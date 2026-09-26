import path from "node:path";
import type { AgentEvent, SessionInfo, Source } from "../types.ts";
import { envPath, home, summarizeInput, textOf, toDate } from "../util.ts";

// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// The Codex CLI, the ChatGPT/Codex desktop app and the Chrome side panel all
// write here; `session_meta.originator` tells them apart.
const INJECTED = /^\s*<(environment_context|app-context|user_instructions|permissions|user_shell_command|turn_aborted|INSTRUCTIONS)/;

function classify(info: SessionInfo, meta: any) {
  if (!meta || typeof meta !== "object") return;
  if (typeof meta.cwd === "string") info.cwd = meta.cwd;
  if (typeof meta.id === "string") info.id = meta.id;
  const origin = String(meta.originator ?? "").toLowerCase();
  if (/desktop|chrome|chatgpt/.test(origin)) info.agent = "chatgpt";
  if (meta.source && typeof meta.source === "object" && meta.source.subagent) {
    info.parent = String(meta.source.subagent.thread_spawn?.parent_thread_id ?? "subagent");
  }
}

export const codex: Source = {
  agent: "codex",

  roots() {
    return [path.join(envPath("CODEX_HOME", path.join(home, ".codex")), "sessions")];
  },

  init(file, header: any) {
    const info: SessionInfo = { agent: "codex", file, id: path.basename(file, ".jsonl") };
    if (header?.type === "session_meta") classify(info, header.payload);
    return info;
  },

  parse(r, info): AgentEvent[] {
    if (!r || typeof r !== "object") return [];
    const time = toDate(r.timestamp);
    const p = r.payload ?? {};

    if (r.type === "session_meta") {
      classify(info, p);
      return [];
    }
    if (r.type === "turn_context" && typeof p.cwd === "string") {
      info.cwd = p.cwd;
      return [];
    }
    if (r.type === "compacted") return [{ time, kind: "meta", text: "context compacted" }];
    if (r.type === "event_msg") {
      if (p.type === "error" || p.type === "stream_error")
        return [{ time, kind: "error", text: String(p.message ?? "") }];
      if (p.type === "turn_aborted") return [{ time, kind: "meta", text: `turn aborted (${p.reason ?? ""})` }];
      return [];
    }
    if (r.type !== "response_item") return [];

    switch (p.type) {
      case "message": {
        if (p.role !== "user" && p.role !== "assistant") return [];
        const text = textOf(p.content);
        if (p.role === "user" && INJECTED.test(text)) return [];
        return [{ time, kind: p.role, text }];
      }
      case "agent_message":
        return [{ time, kind: "assistant", label: `${p.author ?? "?"} → ${p.recipient ?? "?"}`, text: textOf(p.content) }];
      case "reasoning": {
        const text = textOf(p.summary);
        return text ? [{ time, kind: "thinking", text }] : [];
      }
      case "function_call":
        return [{ time, kind: "tool", label: p.namespace ? `${p.namespace}.${p.name}` : p.name, text: summarizeInput(p.arguments), input: p.arguments }];
      case "custom_tool_call": {
        // the desktop app's `exec` tool wraps shell commands in JS: show the command
        const cmd = typeof p.input === "string" && /\bcmd:\s*("(?:[^"\\]|\\.)*")/.exec(p.input);
        let text = summarizeInput(p.input);
        if (cmd) {
          try {
            text = JSON.parse(cmd[1]!);
          } catch {}
        }
        return [{ time, kind: "tool", label: p.name, text, input: p.input }];
      }
      case "local_shell_call":
        return [{ time, kind: "tool", label: "shell", text: summarizeInput(p.action?.command ?? p.action), input: p.action }];
      case "web_search_call":
        return [{ time, kind: "tool", label: "web_search", text: summarizeInput(p.action ?? p), input: p.action }];
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output": {
        let out = p.output;
        if (typeof out === "string") {
          try {
            const j = JSON.parse(out);
            if (j && typeof j === "object" && "output" in j) out = j.output;
          } catch {}
        }
        return [{ time, kind: "result", text: textOf(out) }];
      }
    }
    return [];
  },
};
