# agtail

`tail -f` for local coding agents. Streams every session of **Claude Code**, **Codex CLI**,
**ChatGPT / Codex desktop** (and its Chrome side panel) and **pi** into one live, colored feed,
straight from the JSONL transcripts they write to disk. No daemons, no hooks, no runtime deps.

```
14:00:00 claude  demo#aaaa1111 ❯ fix the flaky test
14:00:01 claude  demo#aaaa1111 ⚙ Bash npm test
14:00:03 codex   api#bbbb2222  ● Done — migrated the handler to the new router.
14:00:04 chatgpt llama#01a0dc33 ⚙ exec gh repo list --limit 50
14:00:04 pi      ~#cccc3333    ∴ Let me run it to show the output.
```

## Install

```sh
npm install -g .      # from this directory (builds on install)
agtail
```

## Usage

```
agtail                     follow everything, replaying the last 20 events from the past hour
agtail ls                  list sessions active in the last day
agtail -a claude,pi        only some agents
agtail -p myrepo           only sessions whose cwd contains "myrepo"
agtail -q                  conversation only (user / assistant / errors)
agtail -k tool,error       only tool calls and errors
agtail -f                  full multi-line messages instead of one line each
agtail --json | jq …       NDJSON events for scripting
agtail -n 100 --since 1d --no-follow
```

Glyphs: `❯` user · `●` assistant · `∴` thinking · `⚙` tool call · `↳` tool result · `✗` error · `·` meta.
Session tags are `<project>#<short-id>`; a trailing `↳` marks a subagent.

## Where it looks

| agent   | location                                              | override              |
|---------|-------------------------------------------------------|-----------------------|
| claude  | `~/.claude/projects/**/*.jsonl`                       | `CLAUDE_CONFIG_DIR`   |
| codex   | `~/.codex/sessions/**/*.jsonl` (originator `codex-tui`, `codex_cli_rs`, …) | `CODEX_HOME` |
| chatgpt | same Codex store, originator `Codex Desktop` / `codex_work_desktop` / Chrome side panel | `CODEX_HOME` |
| pi      | `~/.pi/agent/sessions/**/*.jsonl`                     | `PI_CODING_AGENT_DIR` |

Files are followed with recursive `fs.watch` plus a periodic rescan, so new sessions show up
automatically and partially-written lines are buffered until complete.

## Adding an agent

Implement `Source` in `src/sources/<name>.ts` (`roots`, `init`, `parse` a JSONL record into
events) and register it in `src/cli.ts`.
