# Backends

The adapter's internal Codex protocol layer talks to a small `ClaudeRuntime`
interface, so non-SDK Claude Code bridges can be selected without removing the
default Agent SDK route.

| Backend | Status | Streaming | Approvals / diffs |
| --- | --- | --- | --- |
| `agent-sdk-sidecar` (default) | Stable | Full (text, reasoning, tools) | Yes |
| `agent-http` / Channels | Experimental | Message-level deltas | No |
| `agentapi` | Experimental | Terminal-derived text | No |
| `claude-p` | Experimental | None (one-shot) | No |
| `codex` (native passthrough) | Stable | Native Codex | Native Codex |

Only the SDK route gets a message's context (injected items, a picked skill's
`SKILL.md`, the App's `additionalContext`) in blocks of its own. `agent-http`,
`agentapi` and `claude-p` get one flat text with the context ahead of the
message, so a Claude Code command (`/name args`) sent with any context does not
run there; see [Skills and the App's tools](/guide/gui#skills-and-the-app-s-tools).

Web search off (Settings > Configuration, or `CLAUDE_CODEX_WEBSEARCH=0` with no
mode saved there) takes Claude Code's WebSearch tool away on the SDK route and
`claude-p`, which gets the tools a thread must not have as `--disallowedTools`.
`agent-http` and `agentapi` run Claude outside the adapter, so Claude keeps
WebSearch there whatever the web search setting says, as Claude Code's own
setting decides [memories](/guide/gui#memories) there.

## Native Agent SDK permissions

On the `agent-sdk-sidecar` backend, the App's exact Full Access combination
(`approval_policy=never` and `sandbox_mode=danger-full-access`, outside Plan mode)
maps to Claude Agent SDK `bypassPermissions`. The adapter enables the SDK's
required `allowDangerouslySkipPermissions` opt-in, so ordinary permission callbacks and
Codex approval cards are not used for that thread. User-only interactions and MCP
elicitation still use their explicit user-facing paths. This is a permission
bypass, not an OS sandbox: use it only with appropriate environment and host
isolation. Set
`CLAUDE_CODEX_PERMISSION_MODE` when an explicit mode must override the App's
policy; see [Configuration](/guide/configuration#reference-table).

## Harnesses

With `CLAUDE_CODEX_NATIVE_CODEX=on`, each chat picks one of three harnesses from
the Codex App's model menu:

| Menu label | Model ids | Runs on |
| --- | --- | --- |
| Claude Code · … | Claude (and gateway) ids, as before | Claude Code through the Agent SDK |
| Codex · … | `gpt-*` | a real `codex app-server` on the `openai` provider (ChatGPT login) |
| Codex+AsterGate · … | `codex-ag:<model>` | a real `codex app-server` on `CLAUDE_CODEX_CODEX_AG_PROVIDER` |

The adapter keeps a native chat’s sidebar entry, project and section. Codex
stores its conversation and handles approvals, streamed items, forks and
history. The adapter starts one child process per provider on demand and stops
idle children after `CLAUDE_CODEX_NATIVE_IDLE_MS`.

The first turn of a new chat selects its harness. Later turns and forks can
switch models within the same harness; `thread/resume` ignores a model from
another harness. Each native chat stores its original provider, including
across restarts and changes to the provider setting. Existing `codex exec`
conversations continue on their original route, which runs only the default
Codex provider, so they refuse Codex+AsterGate models. Turning native mode off
keeps native sidebar entries. Re-enable it to reopen them.

Adapters that share a state directory never run a native chat at the same
time. While one runs a turn or changes the chat, the others refuse to start,
steer, interrupt, compact, review, roll back, revert, inject into, set the goal
of, archive or delete it, until that ends or the adapter exits. Archiving or
deleting a chat also ends the turns of the subagent threads it spawned, so it
is refused while one of them runs in another adapter. Continuing one
native chat from two adapters in turn is not supported yet: each adapter's
Codex child keeps the conversation it loaded, so it does not see turns the
other adapter added later and continues from what it saw. Use one adapter per
native chat at a time; a child that was stopped (after
`CLAUDE_CODEX_NATIVE_IDLE_MS`, or with its adapter) loads the chat afresh.

Fresh title helpers run on Claude. A description fork of a native chat uses
its parent’s provider and rollout, so that provider processes the description.
Search within a native chat reads its Codex history. Global sidebar search
covers its name and preview. The child receives App dynamic tools when
`CLAUDE_CODEX_DYNAMIC_TOOLS=1`.

## Switching routes

Install the host helper next to the shim:

```bash
install -m 0755 scripts/claude-codex-mode ~/.local/bin/claude-codex-mode
```

It rewrites `~/.claude-codex/runtime.env`, prepares the matching bridge daemon
(`agent-http` / `agentapi`), stops the current app-server so Codex App reconnects
into the new route, and provides readback commands:

```bash
claude-codex-mode list                 # selectable modes; current marked *
claude-codex-mode set agent-http opus  # switch route, restart bridge with Opus
claude-codex-mode model opus           # keep route; update default/bridge model
claude-codex-mode status               # mode, bridge health, recent logs
claude-codex-mode logs adapter|agent-http|agentapi
```

::: warning Model switching
Model switching is exact per turn for the SDK runtime and `claude-p` (the adapter
passes `model` directly). For `agent-http` / `agentapi` the bridge talks to a
long-lived Claude Code session, so changing the model means restarting that
bridge (`claude-codex-mode model <alias>`).
:::

::: warning Native codex passthrough
In `CLAUDE_CODEX_RUNTIME_TYPE=codex` the shim launches the real Codex
app-server, so the adapter is not in the process and cannot switch back from
in-App controls. Use `claude-codex-mode set codex` / `set agent-sdk-sidecar` on
the host and reconnect. The adapter itself refuses this value.
:::

### Shim and mode helper variables

The `codex` shim and `claude-codex-mode` read a few variables of their own:

- `CLAUDE_CODEX_RUNTIME_ENV`: the env file both source, and `npm run doctor`
  reads. The shim and the doctor default to `~/.claude-codex/runtime.env`, the
  helper to `runtime.env` in `CLAUDE_CODEX_STATE_DIR`, the same file unless
  that is set.
- `CLAUDE_CODEX_STATE_DIR`: the helper's state, legacy bridge logs and bridge
  pool (default `~/.claude-codex`). Set it in the environment, not in
  `runtime.env`, which the helper finds through it.
- `CLAUDE_CODEX_AGENTAPI_COMMAND`: the `agentapi` the helper starts for
  `agentapi` bridges (default `agentapi`). Both bridge kinds start the Claude
  Code that `CLAUDE_CODEX_CLI` names (default `claude`).
- `CLAUDE_CODEX_BRIDGE_PORT_START` / `CLAUDE_CODEX_BRIDGE_PORT_END`: the ports
  pooled bridges take (default 3284-3384).
- `CLAUDE_CODEX_ROUTE`: shim only. When set, it decides instead of
  `CLAUDE_CODEX_RUNTIME_TYPE` whether the shim runs the real Codex app-server
  (`codex`, `native-codex`, `real-codex`, `native` or `real`) or the adapter,
  and `claude-codex-mode set` does not change it. `claude-codex-mode show`
  reports only `CLAUDE_CODEX_RUNTIME_TYPE`, so unset `CLAUDE_CODEX_ROUTE` if
  `show` and the route the shim takes disagree.

`claude-codex-mode logs adapter` and `tail adapter` read `debug.jsonl` in the
adapter home (`CLAUDE_CODEX_HOME`, else `claude-codex-adapter` under
`CODEX_HOME`), or the file `CLAUDE_CODEX_DEBUG_LOG` names, from the environment
or `runtime.env`.

## agent-http / Channels

Loads the bridge from `$CLAUDE_CODEX_AGENT_HTTP_DIR` (or `~/agent-http`) but
launches Claude Code from the thread cwd. Uses `POST /message`, `GET /messages`,
`GET /status`, `GET /events`; streams message-level deltas only (no semantic
tool / thinking / permission events).

```bash
claude-codex-mode set agent-http opus
```

## agentapi

Runs `agentapi server --type=claude` from the thread cwd and maps final agent
text into Codex messages. No rich approval / file-change events (terminal-derived
text only). Run `claude-codex-mode trust` if Claude's workspace-trust prompt
appears.

```bash
claude-codex-mode set agentapi opus
```

### agent-http and agentapi settings

`claude-codex-mode set agent-http|agentapi` writes the ones it needs into
`runtime.env`; set the others there or in the login shell.

```bash
# Bridge address (default http://127.0.0.1:3284). The first one set wins:
# CLAUDE_CODEX_HTTP_BASE_URL, CLAUDE_CODEX_AGENT_HTTP_URL, CLAUDE_CODEX_AGENTAPI_URL.
export CLAUDE_CODEX_HTTP_BASE_URL="http://127.0.0.1:3284"

# Start a bridge per thread cwd and model through `claude-codex-mode
# ensure-bridge` (45 s limit) and use the URL it prints; off by default, and
# set to 1 by `claude-codex-mode set agent-http|agentapi`. Title and summary
# turns never reach a bridge; the adapter answers them itself. The helper
# command defaults to claude-codex-mode.
export CLAUDE_CODEX_HTTP_MANAGE_BRIDGE="1"
export CLAUDE_CODEX_MODE_COMMAND="claude-codex-mode"

# agent-http also listens on GET /events (on by default; 0 polls only).
# agentapi always polls.
export CLAUDE_CODEX_HTTP_USE_SSE="1"

# Poll interval in ms (default 500, kept within 100..60000) and how long a turn
# may run before it fails (default 300000, 5 minutes, kept within 1 s..24 h).
export CLAUDE_CODEX_HTTP_POLL_MS="500"
export CLAUDE_CODEX_HTTP_TIMEOUT_MS="300000"

# Also send Ctrl-C to the bridge as a raw message on interrupt (off by default).
export CLAUDE_CODEX_HTTP_INTERRUPT_RAW="1"
```

Flags count as on for `1`, `true`, `yes` or `on`; any other non-empty value is
off. A number that does not parse falls back to the default, one out of range
is clamped.

## claude-p

Runs `claude-p --output-format json --input-file ...` per turn and emits the
final assistant text. Not streaming, no `turn/steer`; defaults to one-shot turns
(some `claude-p` builds replay results when combining `--resume` with
`--input-file`).

```bash
export CLAUDE_CODEX_RUNTIME_TYPE="claude-p"
export CLAUDE_CODEX_CLAUDE_P_COMMAND="claude-p"
# export CLAUDE_CODEX_CLAUDE_P_RESUME=1   # only after verifying --resume + --input-file

# Extra arguments placed before the adapter's own (a JSON array of strings, or
# split on whitespace).
# export CLAUDE_CODEX_CLAUDE_P_ARGS='["--flag","value"]'

# Per-turn limit in ms (default 300000, kept within 1 s..24 h). The adapter
# passes it on as --timeout in seconds and ends the process tree when it runs
# out. A run that hits that limit, or prints nothing but a StopTimeout on
# stderr, is retried this many times (default 1, kept within 0..5).
export CLAUDE_CODEX_CLAUDE_P_TIMEOUT_MS="300000"
export CLAUDE_CODEX_CLAUDE_P_STOP_TIMEOUT_RETRIES="1"

# Always pass --dangerously-skip-permissions (off by default), so Claude runs
# every tool without asking whatever the thread's approval policy. Without it
# the flag is passed only for turns with approval policy "never" outside a
# read-only sandbox, or with the danger-full-access sandbox.
# export CLAUDE_CODEX_CLAUDE_P_SKIP_PERMISSIONS=1
```
