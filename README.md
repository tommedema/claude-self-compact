# claude-self-compact

Lets Claude compact its own Claude Code session at a moment it chooses, with a note it writes itself that comes back word for word afterwards. Compaction then lands at a natural checkpoint instead of at an arbitrary point near the context limit, and a long session stops paying to re-read a huge context on every call.

The plugin adds:

- **A tool**, `mcp__self-compact__compact`, with `carry` (Claude's own note: open threads, pending decisions, what it last told you, running background tasks, standing rules) and an optional `then` (what to continue with, so an unattended session keeps working). The compaction runs as soon as Claude's current turn ends. `carry` is re-inserted verbatim after the summary, with the machine's clock time, how long ago the previous compaction was and Claude's last report word for word, and `then` is sent as the next prompt.
- **A soft mark**: once the real context size of the last call (input + cache read + cache write tokens, read from the transcript) passes a threshold, Claude gets one line: `self-compact plugin: this session's context is at 312K tokens; compact at the next natural checkpoint`. It comes once on crossing, then again only once the context has grown another 50K past the size it was last marked at (kept across reloads and resumes). It never blocks, stops or interrupts anything.
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

Start a new session afterwards; sessions already running do not pick it up. The install may say "3 userConfig options not yet set": unset options use the defaults below. To check it is on, run `/compact-stats` in the new session, or ask Claude whether `mcp__self-compact__compact` is among its tools.

Update later with `claude plugin marketplace update claude-self-compact`.

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

## Measured

One real compaction through the plugin, in a desktop app Code tab session (Opus 5.5, 2026-11-14), at the user's prices (output $40, 1-hour cache write $16, cache read $0.20, input $8 per M):

| Part | Tokens | Cost |
| --- | --- | --- |
| Claude writing the carry note (output) | 2,145 | $0.09 |
| the short closing reply that ends the turn | 347,935, almost all cache read | $0.11 |
| the summariser call | 354,701: 345,651 cache read, 4,693 output, 2,147 write, 2,210 input | $0.31 |
| re-caching the new, shorter context (first call's write minus a normal call's) | 42,464 | $0.68 |
| **one compaction** | | **$1.18** |

The context went from 342,853 tokens to 99,265 on the first call after it (55,116 of them the system prompt and tools, still cached). It took 40 seconds. Each later call then reads about 246K fewer tokens, $0.05 less per call, so the compaction pays for itself in about 24 calls. On the desktop the context right after is larger than in the terminal (99K against 60K) because the app's system prompt, tool and skill listings are larger.

What that cost means for the threshold, replaying a real 9-day supervisor session (5,673 calls, $1,261; 33 automatic compactions; context median 361K, 90th percentile 787K; +3,274 tokens per call) with $1.18 per compaction:

| Threshold | 100K | 150K | 200K | 250K | 300K | 400K | 700K | none |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| restart at 60K | +5% | −13% | −16% | −17% | −16% | −14% | 0% | +12% |

The cheapest is 260K (closed form 256K), 17% below the replay of what happened; restarting at the desktop's 99K it moves to about 300K. The curve is flat from 200K to 300K, so the default 250K is within one percentage point of the best in both cases; compacting much earlier (100K) costs more than never compacting early. Run the stats command on your own sessions to see your numbers.

## How it works

Claude Code 2.1.32x lets a plugin ship a hooks module, and that module can compact the session. `$.session.compact()` makes the same call `/compact` makes. Where that call is not offered, `$.command.run({ command: 'compact' })` runs the built-in `/compact` command the way you would type it. Neither can run while a turn is still going (the engine refuses: "it would compact under the turn this hook is holding"). So the tool call only records the request, and the compaction runs when Claude's turn ends:

1. Claude calls the tool. The plugin checks that it can compact here (main conversation, not a one-shot `claude -p`, compaction not disabled) and returns an error otherwise, with nothing changed. It saves the request to `~/.claude/self-compact/sessions/<session>.json` and tells Claude to end its turn.
2. When the turn ends (`turn.complete`), the plugin compacts: through `$.session.compact` in the terminal, or through `/compact` in headless hosts (the desktop app, Agent SDK), where the engine runs compaction as a turn of its own. The summariser is told that Claude's note will follow, so the summary stays short.
3. After the compaction it appends the `carry` text verbatim as a user-role row the model reads, with `then` repeated inside it, then submits `then` as the next prompt. The row opens with the machine's clock (`2026-11-14 12:44 local time, 38 minutes after the previous compaction`): a time Claude writes into its note is its own estimate, was once 31 minutes off, and would otherwise be copied from note to note. The session keeps its id, transcript and background tasks: this is the same in-place compaction `/compact` does.
4. If the compaction fails (a PreCompact hook blocks it, the API fails), the conversation is unchanged and Claude gets a note saying so. `then` (and a Stop hook's held message, below) is still sent so the session keeps working. Each compaction is logged, with its size before and after (and in the terminal the summariser's token usage), to `~/.claude/self-compact/compactions.jsonl` (one appended line each, so sessions that finish together do not lose each other's).

The mark runs after each tool call and with each prompt you send. It reads the last call's usage from the end of the transcript and adds one line of context to that tool result or prompt.

## Stop hooks and the note

The note is written when Claude calls the tool; the compaction runs when the turn ends. A Stop hook that blocks the stop (a reviewer, a check that asks for more work) holds the turn open in between, and whatever Claude then does is not in its note. In one supervisor session this happened at four of five compactions: three to four minutes of edits and a commit after the note was written.

- The summariser is told that the turn may have gone on after the tool call and to cover all of that in full, so it reaches the next context whatever the hook is.
- Claude's last report before the tool call (its newest text of 400 characters or more) comes back word for word in the same row as the note, as `<last-report>`. The engine keeps only the very last message verbatim, which is the closing line after the tool call, and a reply or a review that arrives after the compaction quotes the report by the sentence.
- A hook of your own can stand aside for that one stop, which keeps the note current. While a request waits, `~/.claude/self-compact/sessions/<session id>.json` has `pending` set (`requestedAt` in milliseconds, `then` when the session carries on by itself); it is `null` again once the compaction has run or was cancelled. Treat a request older than a few minutes as left over from a session that died.

A Stop hook that keeps blocking, such as `/goal` (which keeps the session working until its condition is met), would hold the compaction off for as long as it blocks: a blocked stop does not end the turn, it goes on with another model request. In one session that was hours, and the context grew from 300K to 702K while five requests waited. So while a compaction waits, the plugin watches the turn's model requests: one that starts right after Claude ended the turn means a Stop hook kept it going. That request is not sent; the plugin ends the turn there (no interruption marker), the compaction runs, and the hook's message, read from the transcript, is sent as the next prompt (after `then`, if any) and repeated in the row with the note. The session goes on as the hook asked, on the compacted context, and the hook decides again when that turn ends. Turns with no compaction waiting are left alone.

The plugin hooks no classic events (`classic.Stop`, `classic.SessionStart`) and not `session.compact`: on a machine with managed settings, or on a Team or Enterprise plan, the built-in `cc-plugin-sec-default` passes those on past the plugins a person installs, and the session is told each hook was skipped. What they would give is read from the turn's steps and the transcript instead.

## Testing

```bash
claude plugin test plugins/self-compact
```

```bash
python3 plugins/self-compact/tests/e2e.py
```

```bash
python3 plugins/self-compact/tests/e2e-queued.py
```

The second runs two real compactions in a small headless session (about two minutes, a few cents) and checks the note, the clock, the last report, the pending request and the log. It sets `SELF_COMPACT_HOME` to a temporary folder, which moves the plugin's state files and log there, so nothing is written to `~/.claude/self-compact`. The stats command reads only the log rows of the session it is asked about.

The third sends a message while a compaction runs and checks that the first request after it already carries the note (under a minute). Such a message is queued and submitted the moment the compaction ends, a few milliseconds before the plugin puts the note back, so the plugin holds that prompt until the note is in.

## Surfaces

| Surface | Works | How |
| --- | --- | --- |
| Interactive terminal (`claude`) | yes | `$.session.compact` |
| Desktop app, Code tab | yes, shown on a real session (above) | `/compact` via `$.command.run` (the desktop runs Claude Code headless) |
| Agent SDK / `claude --input-format stream-json` | yes | `/compact` via `$.command.run` |
| One-shot `claude -p "…"` | no: the tool returns an error | the session ends with the turn, before a compaction could run |

## What is not supported

- One-shot `claude -p` runs (see above). The mark still works there.
- Subagents: only the main conversation can compact itself; a subagent's call returns an error.
- Compacting in the middle of a turn: the engine does not allow it, so the compaction always waits for the turn to end. If you interrupt that turn, the request is cancelled and Claude is told.
- Failures that only show when the compaction runs (a blocking PreCompact hook, an API error) cannot be returned by the tool call, which has already returned. They arrive as a note in the conversation instead, and the conversation is left as it was.
- In the terminal the transcript is written slightly behind the live session, so the mark can lag one call: it reports the size of the call before.
- If something is already queued when the compaction finishes (a background task's notification, a message you typed), it takes the first turn and the `then` prompt follows it. The carry note repeats `then`, so Claude carries on in that first turn anyway, and it tells Claude not to redo finished work when the `then` prompt itself arrives.
- On the desktop and SDK path the `/compact` command and its arguments (the short summariser instruction, not your note) stay in the context as the command's record.
- Plugin options are read from user settings only; per project, use the environment variables above.
