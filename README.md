# claude-self-compact

Lets Claude compact its own Claude Code session at a moment it chooses, with a note it writes itself that comes back word for word afterwards. Compaction then lands at a natural checkpoint instead of at an arbitrary point near the context limit, and a long session stops paying to re-read a huge context on every call.

The plugin adds:

- **A tool**, `mcp__self-compact__compact`, with `carry` (Claude's own note: open threads, pending decisions, what it last told you, running background tasks, standing rules) and an optional `then` (what to continue with, so an unattended session keeps working). The compaction runs as soon as Claude's current turn ends. `carry` is re-inserted verbatim after the summary, and `then` is sent as the next prompt.
- **A soft mark**: once the real context size of the last call (input + cache read + cache write tokens, read from the transcript) passes a threshold, Claude gets one line: `self-compact plugin: this session's context is at 312K tokens; compact at the next natural checkpoint`. It comes once on crossing, then again only after every further 50K. It never blocks, stops or interrupts anything.
- **Guidance** in the tool's description, which is always loaded: compact only at a natural checkpoint (work committed, notes current, reply to you sent, nothing that lives only in context), always before a known long idle, never in the middle of an investigation; and what to put in `carry`.
- **A stats command** that prints, from a session's transcript, the cost split (output, first reads, re-reads), context size by percentile, growth per call, compactions, what one compaction costs, and the threshold that minimises cost.

Nothing leaves the machine: no telemetry, no outside services. The plugin reads the session's own transcript and writes small state files under `~/.claude/self-compact/`.

## Install

The repository is private, so add it over SSH (needs a GitHub SSH key on the machine):

```bash
claude plugin marketplace add git@github.com:tommedema/claude-self-compact.git
```

```bash
claude plugin install self-compact@claude-self-compact
```

Or add it to `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-self-compact": { "source": { "source": "git", "url": "git@github.com:tommedema/claude-self-compact.git" } }
  },
  "enabledPlugins": { "self-compact@claude-self-compact": true }
}
```

Start a new session afterwards. Update later with `claude plugin marketplace update claude-self-compact`.

Requires Claude Code 2.1.321 or newer (the plugin is a hooks module, a "mod"), and `python3` for the stats command.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `threshold` | `250000` | context size (tokens) at which Claude is first told to compact at the next natural checkpoint |
| `step` | `50000` | after the first mark, Claude is told again only each time the context has grown this much more |
| `enabled` | `true` | `false` removes the tool and the mark |

Set them for all your sessions in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "self-compact@claude-self-compact": { "options": { "threshold": 300000, "step": 50000 } } } }
```

Per project: Claude Code does not read plugin options from a project's settings, so the plugin also takes environment variables, which a project can set in the `env` block of its `.claude/settings.json` (shared) or `.claude/settings.local.json` (yours only). They win over the options above:

```json
{ "env": { "SELF_COMPACT_ENABLED": "false" } }
```

```json
{ "env": { "SELF_COMPACT_THRESHOLD": "200000", "SELF_COMPACT_STEP": "40000" } }
```

To turn the whole plugin off in one project, the standard switch works too: `{ "enabledPlugins": { "self-compact@claude-self-compact": false } }` in that project's settings.

## Stats

In a session: `/compact-stats`. From a shell, for any transcript:

```bash
python3 ~/.claude/plugins/marketplaces/claude-self-compact/plugins/self-compact/bin/self-compact-stats ~/.claude/projects/<project>/<session-id>.jsonl
```

With no argument it reads the newest transcript of the current directory's project; a session id (or its prefix) also works. Prices are in dollars per million tokens. The defaults are output $40, 1-hour cache write $16, 5-minute cache write $10, cache read $0.20, uncached input $8. Change them with `--price-output`, `--price-write`, `--price-write-5m`, `--price-read` and `--price-input`. `--compaction-cost` and `--post` override the measured cost of one compaction and the measured context right after one, and `--json` prints the numbers as JSON.

The threshold search replays the session's real calls: it re-reads the context before each call (re-writing it on a cache miss), writes each call's new tokens, and compacts back to the measured post-compaction size whenever the context reaches the threshold, charging one compaction each time. It also prints the closed form `T* = post + sqrt(2 × compaction cost × growth per call / cache read price)`.

## How it works

Claude Code 2.1.32x lets a plugin ship a hooks module, and that module can compact the session. `$.session.compact()` makes the same call `/compact` makes. Where that call is not offered, `$.command.run({ command: 'compact' })` runs the built-in `/compact` command the way you would type it. Neither can run while a turn is still going (the engine refuses: "it would compact under the turn this hook is holding"). So the tool call only records the request, and the compaction runs when Claude's turn ends:

1. Claude calls the tool. The plugin checks that it can compact here (main conversation, not a one-shot `claude -p`, compaction not disabled) and returns an error otherwise, with nothing changed. It saves the request to `~/.claude/self-compact/sessions/<session>.json` and tells Claude to end its turn.
2. When the turn ends (`turn.complete`), the plugin compacts: through `$.session.compact` in the terminal, or through `/compact` in headless hosts (the desktop app, Agent SDK), where the engine runs compaction as a turn of its own. The summariser is told that Claude's note will follow, so the summary stays short.
3. After the compaction it appends the `carry` text verbatim as a user-role row the model reads, then submits `then` as the next prompt. The session keeps its id, transcript and background tasks: this is the same in-place compaction `/compact` does.
4. If the compaction fails (a PreCompact hook blocks it, the API fails), the conversation is unchanged and Claude gets a note saying so. `then` is still sent so the session keeps working. Each compaction is logged, with the summariser's token usage, to `~/.claude/self-compact/compactions.jsonl`.

The mark runs after each tool call and with each prompt you send. It reads the last call's usage from the end of the transcript and adds one line of context to that tool result or prompt.

## Surfaces

| Surface | Works | How |
| --- | --- | --- |
| Interactive terminal (`claude`) | yes | `$.session.compact` |
| Desktop app, Code tab | yes | `/compact` via `$.command.run` (the desktop runs Claude Code headless) |
| Agent SDK / `claude --input-format stream-json` | yes | `/compact` via `$.command.run` |
| One-shot `claude -p "…"` | no: the tool returns an error | the session ends with the turn, before a compaction could run |

## What is not supported

- One-shot `claude -p` runs (see above). The mark still works there.
- Subagents: only the main conversation can compact itself; a subagent's call returns an error.
- Compacting in the middle of a turn: the engine does not allow it, so the compaction always waits for the turn to end. If you interrupt that turn, the request is cancelled and Claude is told.
- Failures that only show when the compaction runs (a blocking PreCompact hook, an API error) cannot be returned by the tool call, which has already returned. They arrive as a note in the conversation instead, and the conversation is left as it was.
- In the terminal the transcript is written slightly behind the live session, so the mark can lag one call: it reports the size of the call before.
- On the desktop and SDK path the `/compact` command and its arguments (the short summariser instruction, not your note) stay in the context as the command's record.
- Plugin options are read from user settings only; per project, use the environment variables above.
