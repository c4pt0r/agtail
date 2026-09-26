import os from "node:os";
import path from "node:path";

export const home = os.homedir();

export function envPath(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export function toDate(v: unknown): Date {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Flatten the many "content" shapes agents use into plain text. */
export function textOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const o = c as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
          if (o.type === "image" || o.type === "input_image") return "[image]";
          if ("content" in o) return textOf(o.content);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if ("content" in o) return textOf(o.content);
    if ("output" in o) return textOf(o.output);
  }
  return String(content);
}

/** One-line summary of tool input: prefer the obviously meaningful field. */
export function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    try {
      return summarizeInput(JSON.parse(input));
    } catch {
      return input;
    }
  }
  if (typeof input !== "object") return String(input);
  const o = input as Record<string, unknown>;
  for (const k of [
    "command",
    "cmd",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "description",
    "prompt",
    "code",
  ]) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
  }
  return JSON.stringify(o);
}

export function shortId(id: string): string {
  return id.replace(/^.*?([0-9a-f]{8})[0-9a-f-]*$/i, "$1").slice(0, 8);
}

export function project(cwd: string | undefined): string {
  if (!cwd) return "?";
  const base = path.basename(cwd);
  return cwd === home ? "~" : base || cwd;
}
