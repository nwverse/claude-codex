# src/AGENTS.md

Adapter internals. All files are `.mts` ESM, compiled to `dist/*.mjs`. See the
[root AGENTS.md](../AGENTS.md) for build/test and project-wide conventions.

## Map

Grouped by concern; each module's header comment has the details.

Protocol and server:

- `adapter.mts` — entry point / CLI mode dispatch.
- `server.mts` — Codex app-server protocol layer (the big one; prefer adding new
  surface as helpers and splitting when practical).
- `server-helpers.mts` — pure helpers `server.mts` uses to read request params
  and shape results (config edits, model/effort/collaboration mode, permission
  profiles, turn errors, token usage, approval keys, diffs).
- `host-methods.mts` — JSON-RPC error codes (`RpcError`, `invalidRequest`) and
  inert answers for methods backed by OpenAI services or the Codex host
  (connectors, plugin catalog, remote control, passkeys, account extras,
  model providers, feedback bundles).
- `cli-probes.mts` — one-shot `app-server` probes (`--print-startup-config`,
  `daemon version`, config requirements) answered before any state is opened.
- `thread-history.mts` — paged history views: `thread/turns/list`,
  `thread/items/list`, `thread/items/read`, `thread/timeline/list`, searches
  and fork turns.
- `fs-watch.mts` — `fs/watch` the Codex way: non-recursive, debounced
  `fs/changed` under the requested path, following a file across renames and
  symlinks.
- `types.mts` — shared protocol/runtime types.
- `app-compat.mts` — App rules: Codex App behavior the adapter relies on beyond
  the protocol schema. Code that depends on one is tagged `// App rule: <id>`;
  keep tags and rules in step (see `docs/reference/app-compat.md`).

Transport and process lifecycle:

- `transports.mts` — stdio / WebSocket / Unix-socket daemon / `proxy`.
- `ws-auth.mts` — Origin check and capability-token auth for the TCP
  `--listen ws://` listener.
- `isolated-launch.mts` — the `claude-codex-isolated` bin: one foreground
  adapter on `ws://127.0.0.1` with its own state folder and token auth, to run
  beside native Codex or Orca.
- `process-owner.mts` — names a server by pid + start time so a later server
  fails only the turns of servers that are gone.
- `cli-orphans.mts` — records the Claude CLI children per adapter and reaps
  those a SIGKILLed adapter left behind.
- `cli-mcp-config.mts` — writes a session's MCP servers to a private 0600 file
  instead of the CLI's command line; sweeps stale ones.
- `idle-sleep.mts` — macOS `caffeinate -i -w` while work runs
  (`CLAUDE_CODEX_PREVENT_IDLE_SLEEP=1`).
- `sleep-notice.mts` — detects that the computer slept, for the watchdog and
  for failed-turn messages.

Persistence:

- `store.mts` — SQLite thread/turn persistence via `node:sqlite` (Node 24+).
- `run-registry.mts` — append-only `runs.jsonl` of thread/turn/subagent events
  (`CLAUDE_CODEX_RUN_LOG`, `0` to disable), with redaction; rotated like
  debug.jsonl (`appendLogLine` in `util.mts`).
- `claude-session-relocation.mts` — copies a Claude transcript to the
  project folder of a thread's new workspace, so a chat resumes after its
  folder is moved or renamed, and decides when a missing transcript is
  certainly gone (a new session) or only out of reach (the turn fails).

Codex and Claude Code config bridging:

- `codex-config.mts` — reads Codex `config.toml` layers (user, then trusted
  project `.codex/`) for MCP servers, `notify` and auto-compact.
- `toml.mts` — dependency-free TOML 1.0 reader for the Codex config.
- `claude-config.mts` — Claude Code settings read with the CLI's precedence
  (MCP scopes, project trust, permission rules) when
  `CLAUDE_CODEX_CLAUDE_CONFIG_DIR` is set.
- `inherited-config.mts` — which MCP servers, agents, permission rules and
  hooks a thread takes over, each behind its own switch.
- `project-instructions.mts` — AGENTS.md (read the Codex way) plus bridged
  CLAUDE.md, rules and project skills for a thread's folder.
- `claude-agents.mts` — user/project `agents/*.md` subagents as the SDK's
  `agents` option (`CLAUDE_CODEX_CLAUDE_AGENTS=1`).
- `claude-hooks.mts` — user/project Claude Code command hooks run as SDK hook
  callbacks (`CLAUDE_CODEX_CLAUDE_HOOKS`).
- `sdk-hooks.mts` — assembles the SDK `hooks` option for a session.
- `ask-rules.mts` — `permissions.ask` rules enforced through a PreToolUse
  callback, including compound Bash command lines
  (`CLAUDE_CODEX_CLAUDE_PERMISSIONS=1`).
- `shell-commands.mts` — every command a Bash command line may run (wrappers,
  `sh -c`, `eval`, `xargs`, `find -exec`), read as bash and zsh read it and
  failing closed, for the ask rules and hook `if` conditions.
- `shell-words.mts` — a command line read into simple commands and words
  (quotes, expansions, case patterns, arrays, `[[ ]]`) for `shell-commands.mts`.
- `shell-eval.mts` — text a command line has the shell run later (PS4,
  BASH_ENV, zsh tables, subscripts and names that arithmetic evaluates).
- `wildcards.mts` — text with wildcards on both sides (a rule's `*`, what the
  shell expands) compared in linear time.
- `permission-suggestions.mts` — Claude's "don't ask again" suggestions mapped
  to the App's approval-card choices (session rules and folders only with
  `CLAUDE_CODEX_SESSION_SUGGESTIONS=1`).
- `claude-commands.mts` — Claude Code commands the CLI reports, served through
  `skills/list` for the App's "/" popup.
- `claude-capabilities.mts` — skill folders for `skills/list`, the
  `hooks/list` entries and Claude-to-Codex hook event names, and App plugins
  whose skills Claude can run.
- `claude-models.mts` — per-model reasoning efforts the CLI reports, cached for
  `model/list`.
- `shared-claude-catalog.mts` — the JSON catalogs behind the two modules above
  (`claude-commands.json`, `claude-models.json`), shared by every adapter on
  one home, each read-modify-write held under a SQLite lock.
- `model-profiles.mts` — per-model Claude Code process profiles
  (`CLAUDE_CODEX_MODEL_PROFILES[_FILE]`) and the fingerprint a thread pins.
- `auto-compact.mts` — Codex `model_auto_compact_token_limit` as
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`CLAUDE_CODEX_CODEX_AUTO_COMPACT=1`).
- `memories.mts` — the App's memories settings driving Claude Code auto-memory
  (`CLAUDE_CODEX_MEMORIES=1`).
- `app-settings.mts` — what `config/value/write` and `config/batchWrite` do for
  Claude threads (App MCP servers only with `CLAUDE_CODEX_APP_MCP_SERVERS=1`,
  unsupported settings).
- `codex-notify.mts` — runs the Codex `notify` program on turn completion
  (`CLAUDE_CODEX_CODEX_NOTIFY=1`).

Provider loop descriptors:

- `provider-loop-descriptor-types.mts` — descriptor field enums and types.
- `provider-loop-descriptor-schema.mts` — descriptor validation, credential
  sources, and the `redactSecretLikeText` helper other modules reuse.
- `provider-loop-descriptors.mts` — the built-in descriptor list; re-exports
  the two modules above.
- `provider-loop-selection.mts` — resolves the selected provider/loop from env
  (`CLAUDE_CODEX_PROVIDER`, `CLAUDE_CODEX_AGENT_LOOP`) or config.
- `provider-loop-config.mts` — the `provider_loop_config` projection
  `config/read` reports.

Native Codex harness (`CLAUDE_CODEX_NATIVE_CODEX=on`):

- `harness-models.mts` — the three harnesses a model id picks (Claude Code,
  Codex, Codex+AsterGate `codex-ag:<model>`), their menu labels and the Codex
  catalog models.
- `codex-native-bridge.mts` — runs a Codex thread's conversation in a real
  `codex app-server` child: maps thread ids both ways and passes requests,
  server requests and notifications through as Codex sent them.
- `codex-app-server-child.mts` — one `codex app-server --listen stdio://`
  child per Codex model provider, started by the first request and again by
  the next one after a crash.

Turn input and lifecycle:

- `native-turn-input.mts` — the prompt channel kept open for a native turn, for
  `steer()` and control round trips.
- `turn-context.mts` — SKILL.md, App context and injected items added to the
  model input next to the user's message.
- `goal-prompts.mts` — thread-goal statuses and the hidden continuation prompts.
- `turn-watchdog.mts` — fails a turn whose subagents or workflow go quiet for a
  whole window (paused for approvals and sleep).
- `turn-notices.mts` — Claude Code side notices shown as inline `error` rows
  with `willRetry: true`.
- `quiet-turns.mts` — the heartbeat block that keeps a turn ending with
  background work running from lighting the unread dot.
- `cron-jobs.mts` — tracks session-only CronCreate jobs so a process stays open
  until they fire.

Tools and item presentation:

- `tool-items.mts` — how Claude's Read, Grep, Glob, LS, image and MCP tool
  calls show as Codex items.
- `command-actions.mts` — a port of Codex's `parse_command`: the command
  actions that fold a read-only Bash command into the App's "Explored" row.
- `command-output.mts` — live Bash output from polling the CLI's
  `get_task_output`.
- `user-shell.mts` — a shell command the user types (`thread/shellCommand`):
  no stdin, output capped but drained to the end, its process group killed
  when it is stopped or times out.
- `foreground-shells.mts` — a foreground Bash call the CLI hands to a
  background task when its timeout expires: keeps its command item tied to
  that task until the CLI reports its exit.
- `tool-input-preview.mts` — streamed Edit/Write/MultiEdit input parsed as
  partial JSON for `item/fileChange/patchUpdated`.
- `visualize-lines.mts` — adds the private-use marks to unmarked `visualize`
  lines in completed agent messages.
- `memory-citations.mts` — the `memoryCitation` for memories recalled in a turn.
- `dynamic-tools.mts` — client-registered dynamic tools offered to Claude as
  in-process MCP servers (`CLAUDE_CODEX_DYNAMIC_TOOLS=1`).
- `leader-tools.mts` — tools that let one chat start, message, wait for and
  read other chats (`CLAUDE_CODEX_LEADER_TOOLS=1`).
- `session-changes.mts` — a chat's file edits from its transcripts as a unified
  diff, for reviews outside git (`CLAUDE_CODEX_SESSION_CHANGES=1`).
- `mcp.mts` — MCP stdio/HTTP tool & resource calls.
- `mcp-credentials.mts` — the env variables the CLI never fills into an MCP
  config, mirrored for the adapter's own MCP calls.
- `app-plugin-mcp.mts` — MCP servers of the App's bundled plugins, run for the
  App's own requests (`CLAUDE_CODEX_APP_PLUGIN_MCP`).

Subagents and workflows:

- `subagent-items.mts` — a subagent's messages, thinking and tool calls as
  bounded items of its child thread.
- `subagent-presentation.mts` — subagent thread names and failure wording.
- `task-output.mts` — reads a background agent's final report from the tail of
  its sidechain transcript.
- `workflow-subagents.mts` — follows a Claude Code workflow run's journal so its
  agents show as subagent threads.
- `workflow-command.mts` — parses `/workflows [list|<task>]` and builds the
  runtime prompt.
- `workflow-cli.mts` — `npm run workflow`: a file-backed task queue
  (`enqueue`, `schedule`, `heartbeat`, `complete`, `fail`, `block`, `status`,
  `health`, `ingest-github`).
- `workflow-state.mts` — the queue's versioned state file and store.
- `workflow-write-lock.mts` — the worker that holds a SQLite write lock while
  `workflow-state.mts` changes the state file, so concurrent CLI runs queue.
- `workflow-scheduler.mts` — lease-based task scheduling and transitions.
- `workflow-health.mts` — healthy/stalled/failed report from leases and the run
  registry.
- `github-queue.mts` — turns open GitHub issues/PRs (JSON) into queue tasks,
  leaving their untrusted body text out.

Git and worktrees:

- `worktree.mts` — optional per-thread git worktree isolation.
- `git-info.mts` — a thread's Codex `gitInfo`: cached lookups and remote URL
  sanitizing.
- `turn-diff.mts` — the whole-tree `git diff` behind `turn/diff/updated` and
  `gitDiffToRemote`, untracked files and symlinks included, within size caps.

Utilities (reuse these instead of writing another copy):

- `util.mts` — shared helpers.
- `process-group.mts` — signals or stops a child's whole process group
  (SIGTERM, then SIGKILL after 1 s or as soon as the leader exits), for
  anything that spawns a process.
- `json-file.mts` — atomic owner-only JSON writes (temp file and rename) that
  keep a symlinked file linked.
- `json-syntax.mts` — why a JSON config did not parse, without quoting its
  text, which may hold a credential.

## Runtime backends

Claude backends sit behind the `ClaudeRuntime` interface and are constructed in
`runtime-factory.mts` from `runtime-config.mts`:

- `native-runtime.mts` — default, in-process Claude Agent SDK.
- `http-agent-runtime.mts` — `agent-http` / `agentapi` HTTP/SSE bridges.
- `claude-p-runtime.mts` — one-shot `claude-p` transcript wrapper.
- `codex-proxy-runtime.mts` — native Codex passthrough (`codex exec`).
- `mock-runtime.mts` — credential-free protocol testing (`CLAUDE_CODEX_MOCK=1`).

**Adding a backend:** create `<name>-runtime.mts` implementing `ClaudeRuntime`,
register it in `runtime-factory.mts`, and add any env knobs to
`runtime-config.mts`. The PostToolUse hook nudges if runtime code lands
elsewhere.

## Conventions

- Keep the protocol layer (`server.mts`) decoupled from any specific backend —
  it only talks to `ClaudeRuntime`.
- Compatibility-only Codex UI methods should return stable empty/inert
  responses rather than throwing (see the capability matrix in `docs/`).
- **Erasable syntax only**: no `enum`, `namespace`, or constructor parameter
  properties (`constructor(private x: T)`). Declare the field, then assign in the
  body. `tsc` (with `erasableSyntaxOnly`) and the PostToolUse hook both flag
  violations.
