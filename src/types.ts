export type AgentName = "claude" | "codex" | "chatgpt" | "pi";

export type EventKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "result"
  | "error"
  | "meta";

export interface AgentEvent {
  time: Date;
  kind: EventKind;
  /** Short heading, e.g. a tool name. */
  label?: string;
  text: string;
}

/** Per-file state a parser may keep across lines (cwd, model, ...). */
export interface SessionInfo {
  agent: AgentName;
  file: string;
  id: string;
  cwd?: string;
  /** Set for subagents / sidechains. */
  parent?: string;
  title?: string;
}

export interface Source {
  /** Agent this source reports by default; parsers may reassign (codex -> chatgpt). */
  agent: AgentName;
  /** Directories to scan recursively for *.jsonl session files. */
  roots(): string[];
  /** Build initial info for a file; `header` is its first line (may be undefined). */
  init(file: string, header: unknown): SessionInfo;
  /** Turn one parsed JSONL record into zero or more events. May mutate `info`. */
  parse(record: any, info: SessionInfo): AgentEvent[];
}
