# agtail

**`tail -f` for your coding agents.**

You have Claude Code in one pane, Codex in another, the ChatGPT desktop app doing something in
the background and a pi session you forgot about. `agtail` merges all of them into a single live,
colored stream: every prompt, reply, thought, tool call and error, as it happens.

```console
$ agtail
14:02:11 claude  api#3f9a1c20   ❯ the login test is flaky, find out why
14:02:14 claude  api#3f9a1c20   ⚙ Bash npm test -- auth/login.spec.ts
14:02:19 claude  api#3f9a1c20   ↳ FAIL auth/login.spec.ts › rejects expired tokens (timeout 5000ms)
14:02:20 codex   web#019faf79   ⚙ exec rg "useSession" src/
14:02:22 chatgpt notes#01a0dc33 ● Here's a summary of the three options…
14:02:25 claude  api#3f9a1c20   ∴ The clock is mocked after the token is minted, so…
14:02:31 pi      ~#01a05a1d     ⚙ bash python3 hello.py
14:02:31 pi      ~#01a05a1d     ↳ Hello, World!
14:02:40 claude  api#3f9a1c20   ✗ Exit code 1
— following claude, codex, pi sessions (ctrl-c to stop) —
```

- **Zero setup.** No hooks, wrappers, daemons or API keys. It reads the JSONL transcripts the
  agents already write to disk.
- **Everything at once.** New sessions appear automatically, including subagents.
- **Zero runtime dependencies.** Just Node ≥ 20.
- **Scriptable.** `--json` emits one event per line for `jq`, dashboards, alerts…

## Supported agents

| Agent                                        | Name      | Reads from                         | Override              |
| -------------------------------------------- | --------- | ---------------------------------- | --------------------- |
| [Claude Code](https://claude.com/claude-code) | `claude`  | `~/.claude/projects/**/*.jsonl`    | `CLAUDE_CONFIG_DIR`   |
| [Codex CLI](https://github.com/openai/codex)  | `codex`   | `~/.codex/sessions/**/*.jsonl`     | `CODEX_HOME`          |
| ChatGPT / Codex desktop app & Chrome panel    | `chatgpt` | `~/.codex/sessions/**/*.jsonl`     | `CODEX_HOME`          |
| [pi](https://github.com/badlogic/pi-mono)     | `pi`      | `~/.pi/agent/sessions/**/*.jsonl`  | `PI_CODING_AGENT_DIR` |

The Codex CLI and the ChatGPT desktop app share one session store. `agtail` tells them apart by
the `originator` recorded in each session's header.

## Install

```sh
npm install -g agtail
```

Or from source:

```sh
git clone https://github.com/c4pt0r/agtail.git
cd agtail && npm install && npm install -g .
```

## Usage

```sh
agtail                      # replay the last 20 events from the past hour, then follow
agtail ls                   # sessions active in the last day, newest first
```

```console
$ agtail ls
  2s  claude   api#3f9a1c20       Fix flaky login test
  4m  chatgpt  notes#01a0dc33     /Users/me/Documents/notes
  1h  codex    web#019faf79       /Users/me/src/web
```

### Searching history

```sh
agtail grep kubernetes        # every session (any agent, all history) mentioning a keyword,
                             # then keep streaming new matches live (like tail -f | grep)
agtail grep deploy --no-follow   # search history only, then exit
agtail grep -l stripe        # just list matching sessions: agent, full session id, count
agtail grep -E 'api[_-]?key' -k user          # regex, only in what you typed
agtail grep deploy --show    # print each matching session in full
agtail show fb1dd6ac         # print one whole session from the start (any unique id prefix)
agtail show fb1dd6ac -q -f   # …only the conversation, full messages
```

```console
$ agtail grep -l helloworld
2026-08-11 10:12:53 (46d)   pi       019ff1cf-9270-72ef-be2f-b487189ec165    2 matches    /Users/me/16nx
2026-09-26 14:02:29 (2h)    chatgpt  01a0df86-ba6b-74b0-82d1-ceccceacd6da    1 match      /Users/me/Documents/Codex/new-chat
```

After the history results, `grep` keeps watching and prints each new match as it is written:
with `-l` it lists sessions as they first match, with `--show` it streams every new event of
matching sessions, and with `-o jsonl` it emits new matching events. Use `--no-follow` to stop
after the history.

Matching is case-insensitive and covers messages, thinking, tool calls (including their full
input) and tool results. `grep` shows up to `--max` (default 5) matching lines per session, each
cut down to the text around the match, with the match highlighted. Every line carries the full local date and time. `-a`, `-p`, `-k` and `--since`
narrow both commands, and `-o jsonl` / `-o raw` work with them too. Codex sessions that were
resumed into several files are merged back into one.

### Filtering

```sh
agtail -a claude,codex      # only these agents
agtail -p myrepo            # only sessions whose cwd contains "myrepo"
agtail -s 3f9a              # only one session (id prefix)
agtail -q                   # just the conversation: user, assistant, errors
agtail -k tool,error        # just tool calls and failures
agtail --no-subagents       # hide subagent / sidechain sessions
```

### Output

```sh
agtail -f                   # full multi-line messages (tool results capped at 20 lines)
agtail -F                   # --full-content: nothing truncated, complete tool-call input too
agtail -t                   # text tags ([user] [tool] …) instead of glyphs
agtail -T                   # full date + time on each line (grep / show do this by default)
agtail -n 100 --since 1d    # bigger replay window
agtail --no-follow          # print the replay and exit, like plain `tail`
```

### Machine-readable output

`-o, --output <fmt>` picks the format: `text` (default), `jsonl` or `raw`.

**`jsonl`** (also `--json` / `--jsonl`) prints one normalized event per line. The shape is the
same for every agent, and all filters apply:

```sh
agtail -o jsonl | jq -r 'select(.kind=="error") | "\(.agent) \(.cwd): \(.text)"'
```

```json
{"time":"2026-09-26T21:02:14.000Z","agent":"claude","session":"3f9a1c20-…","cwd":"/src/api","kind":"tool","label":"Bash","text":"npm test -- auth/login.spec.ts"}
```

Add `-F` to include each tool call's complete arguments as an `input` field.

**`raw`** prints every transcript line exactly as the agent wrote it, wrapped with where it came
from. Use it to archive sessions or to build your own parser. `-a`, `-p`, `-s` and
`--no-subagents` apply; `-k` / `-q` don't, because raw records have no event kind.

```sh
agtail -o raw >> all-agents.jsonl
```

```json
{"agent":"codex","session":"019faf79-…","cwd":"/src/web","file":"/Users/me/.codex/sessions/…/rollout-….jsonl","record":{"timestamp":"…","type":"response_item","payload":{…}}}
```

### Reading the stream

| Glyph | `--text-tag` | Event                           |
| ----- | ------------ | ------------------------------- |
| `❯`   | `[user]`     | user prompt                     |
| `●`   | `[asst]`     | assistant reply                 |
| `∴`   | `[think]`    | thinking / reasoning            |
| `⚙`   | `[tool]`     | tool call (name + input)        |
| `↳`   | `[result]`   | tool result                     |
| `✗`   | `[error]`    | error / failed tool             |
| `·`   | `[meta]`     | meta: model switch, compaction… |

Use `-t` / `--text-tag` when your font lacks the glyphs, or when you want output that is easy to
`grep` (`agtail -t | grep '\[error\]'`).

Each line is tagged `<project>#<session-id>`, colored per session so interleaved sessions stay
readable. A trailing `↳` on the tag (or `(sub)` with `--text-tag`) marks a subagent.

### Example: flag sensitive prompts

[`examples/sensitive-input.mjs`](examples/sensitive-input.mjs) sends every user prompt to
[TypeSafe's Jev](https://docs.typesafe.ai) and reports the ones that contain credentials,
personal data, financial data or confidential business information:

```sh
export TYPESAFE_API_KEY=...        # https://console.typesafe.ai/keys
agtail -o jsonl -n 0 -k user | node examples/sensitive-input.mjs
```

```
⚠ SENSITIVE codex web#019faf79  credentials 0.96
    use this key: sk-… to call the API
```

Set `SENSITIVE_NOTIFY=1` for macOS notifications, `SENSITIVE_THRESHOLD` to tune (default 0.5),
or `SENSITIVE_ALL=1` to also print clean prompts. Note that the prompts are sent to TypeSafe to be judged.

## How it works

`agtail` walks each agent's session directory, replays the tail of recently modified transcripts,
then follows them with a recursive `fs.watch` plus a periodic rescan as a safety net. Incomplete
lines are buffered until the agent finishes writing them. Truncated or rewritten files start
over from the beginning. Everything is read-only.

## Adding an agent

Each agent is one small file in [`src/sources/`](src/sources). Implement the `Source` interface:

```ts
export interface Source {
  agent: AgentName;
  roots(): string[];                                  // directories holding *.jsonl transcripts
  init(file: string, header: unknown): SessionInfo;   // session id / cwd from the first line
  parse(record: any, info: SessionInfo): AgentEvent[]; // one JSONL record -> display events
}
```

Then register it in [`src/cli.ts`](src/cli.ts). PRs welcome.

## License

[MIT](LICENSE)
