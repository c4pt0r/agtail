#!/usr/bin/env node
// Flag user prompts to coding agents that contain sensitive information,
// using TypeSafe's Jev model (https://docs.typesafe.ai).
//
//   export TYPESAFE_API_KEY=...            # https://console.typesafe.ai/keys
//   agtail -o jsonl -n 0 -k user | node examples/sensitive-input.mjs
//
// Every user input is sent to Jev with four yes/no ("noul") questions in one
// request. Each answer is the probability that the answer is yes; anything at
// or above SENSITIVE_THRESHOLD (default 0.5) is reported.
//
// Note: the prompt text itself is sent to api.typesafe.ai to be judged.
//
// Env:
//   TYPESAFE_API_KEY      required
//   TYPESAFE_MODEL        default jev-latest
//   TYPESAFE_BASE_URL     default https://api.typesafe.ai
//   SENSITIVE_THRESHOLD   default 0.5
//   SENSITIVE_NOTIFY=1    also show a macOS notification for each hit
//   SENSITIVE_ALL=1       print a line for clean inputs too

import { execFile } from "node:child_process";
import readline from "node:readline";

const API_KEY = process.env.TYPESAFE_API_KEY;
const MODEL = process.env.TYPESAFE_MODEL || "jev-latest";
const BASE_URL = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "");
const THRESHOLD = Number(process.env.SENSITIVE_THRESHOLD || 0.5);
const NOTIFY = process.env.SENSITIVE_NOTIFY === "1";
const SHOW_ALL = process.env.SENSITIVE_ALL === "1";
const MAX_CHARS = 20000;

if (!API_KEY) {
  console.error("sensitive-input: set TYPESAFE_API_KEY (https://console.typesafe.ai/keys)");
  process.exit(1);
}

const QUESTIONS = {
  credentials: {
    type: "noul",
    instructions: "Does the text contain a secret credential?",
    criteria: {
      true: "Includes an actual API key, access token, password, private key, connection string with a password, session cookie, or similar secret value",
      false: "No secret values; mentioning that a key or password exists, or a placeholder like <API_KEY> or $TOKEN, does not count",
    },
  },
  personal_data: {
    type: "noul",
    instructions: "Does the text contain personal data about a real, identifiable person?",
    criteria: {
      true: "Includes things like a person's home address, phone number, personal email, government ID number, date of birth, or health information",
      false: "No personal data; names of public figures, usernames in file paths, or obviously fake example data do not count",
    },
  },
  financial: {
    type: "noul",
    instructions: "Does the text contain sensitive financial data?",
    criteria: {
      true: "Includes a credit card number, bank account or routing number, IBAN, or a specific person's or private company's non-public financial figures",
      false: "No sensitive financial data; prices, public figures, or example numbers do not count",
    },
  },
  confidential: {
    type: "noul",
    instructions: "Does the text contain confidential business information not meant to leave the organization?",
    criteria: {
      true: "Includes internal-only material such as unreleased plans, private customer lists, deal terms, internal hostnames or IPs, or text marked confidential",
      false: "Ordinary coding or product requests with no confidential material",
    },
  },
};

// Claude Code records some harness messages as user turns; they aren't typed by a person.
const HARNESS = /^\s*<(task-notification|system-reminder|local-command-|command-name|bash-input|bash-stdout)/;

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

async function judge(text) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: text.slice(0, MAX_CHARS), model: MODEL, questions: QUESTIONS }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return (await res.json()).answers;
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

function notify(title, body) {
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  execFile("osascript", ["-e", script], () => {});
}

async function handle(ev) {
  if (ev.kind !== "user" || !ev.text || HARNESS.test(ev.text)) return;

  const where = `${ev.agent} ${(ev.cwd || "?").split("/").pop()}#${String(ev.session).slice(0, 8)}`;
  const preview = ev.text.replace(/\s+/g, " ").trim().slice(0, 100);

  let answers;
  try {
    answers = await judge(ev.text);
  } catch (err) {
    console.error(c("31", `✗ ${where}: ${err.message}`));
    return;
  }

  const hits = Object.entries(answers)
    .map(([id, a]) => [id, a.noul])
    .filter(([, p]) => typeof p === "number" && p >= THRESHOLD)
    .sort((a, b) => b[1] - a[1]);

  if (!hits.length) {
    if (SHOW_ALL) console.log(c("2", `✓ ${where}  ${preview}`));
    return;
  }

  const labels = hits.map(([id, p]) => `${id} ${p.toFixed(2)}`).join(", ");
  console.log(`${c("1;31", "⚠ SENSITIVE")} ${c("33", where)}  ${c("31", labels)}\n    ${preview}`);
  if (NOTIFY) notify(`Sensitive input · ${ev.agent}`, `${labels}\n${preview}`);
}

// Judge inputs one at a time so output stays in the order the prompts were sent.
let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  queue = queue.then(() => handle(ev));
});
