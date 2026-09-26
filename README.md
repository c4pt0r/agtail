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
git clone https://github.com/c4pt0r/agtail.git
cd agtail
npm install        # also compiles to dist/
npm install -g .   # puts `agtail` on your PATH
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
agtail -f                   # full multi-line messages instead of one line each
agtail -n 100 --since 1d    # bigger replay window
agtail --no-follow          # print the replay and exit, like plain `tail`
agtail --json | jq -r 'select(.kind=="error") | "\(.agent) \(.cwd): \(.text)"'
```

JSON events look like this:

```json
{"time":"2026-09-26T21:02:14.000Z","agent":"claude","session":"3f9a1c20-…","cwd":"/src/api","kind":"tool","label":"Bash","text":"npm test -- auth/login.spec.ts"}
```

### Reading the stream

| Glyph | Event                     |
| ----- | ------------------------- |
| `❯`   | user prompt               |
| `●`   | assistant reply           |
| `∴`   | thinking / reasoning      |
| `⚙`   | tool call (name + input)  |
| `↳`   | tool result               |
| `✗`   | error / failed tool       |
| `·`   | meta: model switch, compaction… |

Each line is tagged `<project>#<session-id>`, colored per session so interleaved sessions stay
readable. A trailing `↳` on the tag marks a subagent.

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
