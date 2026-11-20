# Changelog

All notable public-facing changes for Claude Codex Adapter are summarized here.
The project is still private in `package.json`; this file tracks release notes
for maintainers preparing the next public release and does not change package
versioning or publishing metadata.

## Unreleased

### Native Codex chats

- With `CLAUDE_CODEX_NATIVE_CODEX=on`, a new Codex chat runs in a `codex
  app-server` child for its provider. The model menu also offers configured
  AsterGate models. Native chats retain their provider, approvals and history
  across adapter restarts. Existing `codex exec` chats keep their route. See
  [Harnesses](docs/guide/backends.md#harnesses) for configuration and helper chats.
- A native Codex chat keeps its active sidebar state when another adapter opens
  the same state directory. A later startup clears the activity marker if the
  adapter that ran the native turn has exited.
- A native `codex app-server` child that exits on its own (a crash) now takes
  the rest of its process group with it, as a stopped one does, so helpers it
  started, such as MCP servers that ignore stdin EOF, no longer run on after
  every crash. (#334)

### `ws://` listener authentication

- **Breaking:** `--listen ws://` on a non-loopback address (`0.0.0.0`, `::`,
  a LAN or public IP) now refuses to start without a capability token, as
  `codex app-server` does. It used to accept any client, which put an agent
  with shell access on the network. Pass `--ws-auth capability-token`
  (`CLAUDE_CODEX_WS_AUTH=capability-token`) to require a token or, when
  something else protects the listener, opt out explicitly with
  `--ws-allow-unauthenticated` (`CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED=1`);
  the adapter then warns at startup. Loopback listeners keep working without
  a token, and the Codex App, which uses stdio or the unix socket, is not
  affected.
- **Breaking:** a `ws://` upgrade that carries an `Origin` header is refused
  (403) unless the origin is in `CLAUDE_CODEX_WS_ALLOWED_ORIGINS` /
  `--ws-allowed-origins`, on loopback too, so web pages (and DNS rebinding)
  cannot reach the listener. App-server clients outside a browser send no
  `Origin`.
- Capability-token auth (`--ws-auth capability-token`, `--ws-token-file`,
  `--ws-token-sha256`, `CLAUDE_CODEX_WS_TOKEN*`) takes the token as
  `Authorization: Bearer`, which `codex --remote-auth-token-env` sends, or as
  a `claude-codex.bearer.<token>` subprotocol from a browser. Without a token
  source the adapter creates a 0600 `ws-token` file in its home and prints
  only the path.
- `ws://[::1]:port` listens on the IPv6 loopback address (the brackets used
  to reach `listen()` and fail), and the `listening on` line shows the bound
  port, so `ws://127.0.0.1:0` is usable.
- A refused listener or another bad listener option ends the adapter with
  exit code 1 and the message alone, without a stack trace.
- The `ws` library is 8.23.0, which disconnects a peer that floods the
  listener with pings without reading the pongs, instead of letting it
  exhaust the adapter's memory. (#288)

### Isolated launcher

- New `claude-codex-isolated` bin
  (`node dist/src/isolated-launch.mjs --state-dir PATH [--port PORT]`) runs a
  foreground adapter on a loopback `ws://` port. It keeps its own Codex home,
  adapter state, logs and capability token (token auth is on by default), so a
  chosen native `codex --remote` CLI can use Claude while Orca and other
  `codex app-server` clients keep their native route. The SSH shim is
  unchanged.

### Failures you can see and act on

- A turn in a GPT chat (the `codex-proxy` route) now hands its prompt to
  `codex exec` on stdin instead of as the last argument. A message that
  starts with `-` or `--` no longer fails as an unknown `codex` flag, and a
  prompt over 128 KiB (a pasted log, a large injected context) no longer fails
  with `spawn E2BIG` on Linux.
- A message sent to steer a running turn in an `agent-http` or `agentapi`
  chat no longer jumps ahead of the turn's own prompt. A steer that arrived
  while the turn was still starting was posted before the prompt, possibly to
  the unmanaged base URL instead of the turn's bridge, and was reported as
  delivered. It now waits until the prompt is posted and goes to the turn's
  bridge. A steer for a chat with no running turn is no longer posted.
- A turn that fails after the computer slept for a minute or more since
  Claude last made progress in it says so in its error: roughly how long the
  computer slept, that this broke Claude's connection to the model, and that a
  message (or Continue) picks up where it left off; on macOS it also points to
  the App's **Prevent sleep while running** setting. A sleep the turn went on
  from is not blamed: only what Claude or a subagent wrote or ran after waking
  counts as going on, not API retries (a subagent's included), notices, hooks,
  the heartbeats and other frames Claude Code sends while an agent runs or
  after its request failed, the message naming the failed request, or the
  error result of an agent (nested ones included) whose request failed. The
  error code and details are unchanged, and refusals such as usage limits, an
  overloaded API or a Claude Code start that a retry cannot fix are left
  alone.
- The subagent watchdog (`CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS`) no longer fails a
  turn over quiet that is not a stall. The wait is paused while the turn waits
  on the user (an approval, a question, an MCP elicitation or a client dynamic
  tool call), and time the computer spent asleep does not count; after either,
  the wait starts over.
- Opt-in `CLAUDE_CODEX_PREVENT_IDLE_SLEEP=1` keeps a Mac from idle-sleeping
  while Claude works: the adapter holds `caffeinate -i -w <adapter pid>` while
  any turn, background agent or other background work runs, and stops it once
  nothing does. A command Claude runs in the background with Bash, such as a
  dev server or file watcher, counts as background work and keeps the Mac
  awake until its Claude session closes, `CLAUDE_CODEX_BACKGROUND_IDLE_MS`
  (default 2 hours) after the session's last message. Closing the lid still
  sleeps. A `caffeinate` that fails or ends on its own is started again while
  work runs; the adapter stops trying until it restarts only after three in a
  row end within a minute of starting.
  Off by default, and it does nothing on other platforms.
- What Claude Code reports beside a turn (a compaction it could not do, a
  switch to a fallback model, an urgent CLI notification, a call it refused)
  now shows in the Codex App as a dim row under the turn, which goes on. Each
  notice also goes out as an `error` notification with `willRetry: true` and
  no error code, which the App draws that way; the `warning` is still sent.
  Each message shows once a turn and at most five rows a turn, and a turn that
  then fails repeats its notices in the error's `additionalDetails`, which are
  stored with the turn and returned by `thread/read`; the App shows them only
  in an error diagnostics view it does not always offer.
  `CLAUDE_CODEX_NOTICE_ROWS=0` sends the warnings alone.
- A tool call, MCP elicitation or client dynamic tool call that background work
  (a background agent, a workflow, a cron job) makes while no turn runs is
  still turned down, but no longer silently. For a tool call or client dynamic
  tool call, Claude is told no user turn was active and that the user can run
  it again in a turn. An MCP elicitation is declined, and the server gets only
  a plain decline, so what Claude sees of it is up to that server. In every
  case the user sees a notice row under the thread's running or last turn.
  Nothing is queued.
- A turn keeps a `contextCompaction` item only once the compaction completes,
  in the place it started, like Codex. A compaction an interrupt cuts short no
  longer reads as "Context compacted" after a reload, and one Claude Code could
  not do leaves no marker; its notice says what happened. That includes a
  `/compact` (`thread/compact/start`) Claude Code could not do: its turn keeps
  only the summary written instead, and no `thread/compacted` is sent.
- A `/compact` Claude Code did no longer also gets a summary written in a
  session of its own. The adapter failed on the plain-text messages the
  command streams once it has compacted (its summary and output), took the
  compaction for failed and fell back to that summary, which cost a second
  model call. A run that goes wrong after Claude compacted the session no
  longer undoes that either.
- Requests the user can correct fail with JSON-RPC `-32600` (invalid request),
  as Codex answers an unknown thread or turn and a bad cursor, instead of
  `-32000`, with the same messages: an unknown thread, turn, section, queued
  message or process; a bad cursor or parameter; a model the chat cannot
  take; a rewind or queued start while a turn runs; a fork from an unknown
  thread, from a turn its thread does not have or that still runs, or onto
  another model process profile. (Codex answers some section parameter errors
  with `-32602`, invalid params.)
  The model menu's "Couldn't update model settings" toast now gives the
  reason, after the App's own "Check your config.toml." line. Failures inside
  the adapter stay `-32000`, and so do the project store's errors (a project
  not found, a name, roots or metadata it refuses), whose text the App
  matches; a bad project cursor or an empty `idempotencyKey` is an invalid
  request.
- `thread/turns/list`, `thread/turns/items/list`, `thread/items/list`,
  `thread/timeline/list`, `thread/name/set`, `thread/archive`,
  `thread/goal/get` and `turn/interrupt` refuse an unknown thread with
  `unknown thread: <id>` (`-32600`) too. They used to answer an empty page,
  `{goal: null}` or `{}`; a rename or archive still sent its notification,
  and an interrupt left the caller subscribed to a thread that did not exist.
- Model process profiles that fail to load fail with one line of at most 300
  characters that names the file (or `CLAUDE_CODEX_MODEL_PROFILES`) and says
  what is wrong. The message used to carry the JSON parser's excerpt of the
  file's text, which could include a credential, and the id or
  `defaultModel` value that was not valid. A model change from the menu or
  `turn/settings/update` that fails on them is now an invalid request
  (`-32600`) like one from `turn/start`, so the toast shows the reason.
- A `CLAUDE_CODEX_MCP_SERVERS` value (or the file it names) that is not valid
  JSON fails with a message that names the source and says what is wrong,
  quoting none of its text. The `CLAUDE_CODEX_MCP_SERVERS` server status in
  the App and the debug log used to carry the JSON parser's excerpt of it,
  which could include a credential; JSON wrapped in quotes was echoed whole
  as a file that was not found.
- A Claude Code settings or config file (`~/.claude/settings.json`, a
  project's `.claude/settings.json` or `.claude/settings.local.json`,
  `~/.claude.json`, a project's `.mcp.json`) or a Codex `config.toml` that
  does not parse is reported quoting none of its text. The App's hooks list
  showed the JSON parser's excerpt of a settings file, the debug log carried
  it for each of these JSON files, and for a `config.toml` the debug log
  quoted the whole bad value, so a credential pasted without its quotes ended
  up there. A TOML error names the line and what is wrong. A `\u` or `\U`
  escape for a surrogate or a code point past U+10FFFF is now such an error,
  as TOML requires. (#332)
- `claude-codex-mode logs agent-http|agentapi` and `tail agent-http|agentapi`
  show the pooled bridge log written to most recently. They used to show the
  oldest one, so the log a failed bridge start pointed you to was usually
  another bridge's. They also find pooled logs when `CLAUDE_CODEX_STATE_DIR`
  contains a space.
- `claude-codex-mode logs adapter`, `tail adapter` and `status` look for the
  adapter's `debug.jsonl` in its home as the adapter does, under
  `CLAUDE_CODEX_HOME` when that is set, and read `CLAUDE_CODEX_DEBUG_LOG`,
  `CLAUDE_CODEX_HOME`, `CODEX_HOME` and the bridge port range from
  `runtime.env` too. (#304)
- A workflow agent that fails (one that stalled on every attempt, or hit an
  API error) ends its thread's turn as failed, with the reason the workflow
  reported, and counts as a failed subagent of its parent. It used to show as
  running until the workflow ended and then as completed. An attempt the
  workflow ran again after a stall ends as failed too, as soon as the next
  attempt starts, saying the workflow ran the agent again, instead of staying
  open. Claude Code's progress report does not keep that attempt's own error.
- The `codex` shim no longer runs itself in an endless loop when its `PATH`
  directory is a symlink, when it is on `PATH` twice (also as another version
  of it), or when `CODEX_REAL` names a shim: it passes over every copy of
  itself, runs the real Codex CLI later on `PATH`, or exits 127 and says to
  set `CODEX_REAL`. `claude-codex-mode set` and `model` shell-quote the model
  and bridge cwd they write to `runtime.env`, so `$`, quotes and backticks in
  them are read back as written instead of being expanded or run each time
  the shim sources the file, and a value with a line break is refused.
- The goal tools (`codex_goal`) and leader tools (`codex_leader`) load with the
  session instead of behind Claude Code's tool search, so Claude knows they are
  there in a session with many tools.
- `claude-codex-mode` force-kills (SIGKILL) a pooled bridge or an app-server
  that is still running 3 seconds after SIGTERM. It used to send SIGTERM a
  second time, then drop the bridge's pidfile anyway, which left a bridge
  holding its port that `status`, `stop-bridges` and `prune-bridges` could no
  longer see, and `set` reported the app-server stopped while it still ran.
- An unexpected error the adapter does not catch now ends it with exit code 1
  and the stack on stderr, logged once in `debug.jsonl`, so whatever started
  it can start it again. The adapter used to log and re-throw the same error
  forever, so it kept running in whatever state the error left it in, busy
  writing thousands of `adapter.uncaughtException` lines a second to
  `debug.jsonl`. Errors from a peer that went away (`EPIPE`, `ECONNRESET`,
  `EBADF`) are still logged and ignored.
- A failed Bash command shows its real exit code (127, 2, 128+n, ...) in the
  App instead of 1, in the parent thread and in subagent threads, live and
  after a reload, and a successful one shows 0. (#208)
- `CLAUDE_CODEX_RUNTIME_TYPE=codex` (or `native`, `real`, `native-codex`,
  `real-codex`) is the `codex` shim's native passthrough, which never starts
  the adapter. An adapter started with it directly still refuses it, but says
  so and to unset it or choose an adapter route, instead of
  `unknown CLAUDE_CODEX_RUNTIME_TYPE`. (#304)

### App-server and protocol compatibility

- A file the turn diff leaves out (too large, binary or past the size limit)
  shows as a binary change with the reason after it, which renderers show
  without content and `git apply` refuses. It used to be a one-line hunk that
  `git apply` accepted, writing `[omitted: …]` into the file; that includes
  `gitDiffToRemote`, which the App sends as a cloud task's starting diff. New
  files in a chat that runs in a subfolder are named from the repository root,
  as the changed tracked files are, also where `diff.relative` is set, and a
  tracked diff over the 5 MB limit is no longer empty with a git older than
  2.28. (#336)
- A folder that becomes a repository after a chat first diffed it shows its
  changes in `turn/diff/updated` and `gitDiffToRemote` within 30 seconds,
  and one whose `git` timed out once on a busy machine at the next diff. The
  adapter used to remember either as no repository until it restarted.
  (#336)
- Untracked symlinks show in the turn diff as `new file mode 120000` entries
  whose content is the link target, as `git diff` shows them. The adapter no
  longer reads through a link, so a file outside the workspace no longer leaks
  into the diff and a link to a device such as `/dev/zero` no longer hangs it;
  a dangling or directory link, an embedded repository or an unreadable file
  no longer empties the untracked part of the diff.
- With the `codex` shim on `PATH`, `codex app-server generate-ts` and
  `generate-json-schema` (and so `npm run generate:schema`) go to the real
  Codex CLI (`CODEX_REAL`). They used to start an adapter app-server on stdio
  that never wrote the bindings; without a real codex the shim now exits 127
  and says to set `CODEX_REAL`.
- `thread/list` now filters by `searchTerm` (thread name or preview) and
  `excludedThreadIds`, and the exclusion applies before the page limit. A
  malformed or oversized (more than 100) `excludedThreadIds` returns
  `invalidRequest`, for `thread/search` too.
- Sidebar search and title filtering use the same Unicode case matching as
  in-chat search. Multiline queries can find adjacent message text parts. (#168)
- A symlink under `.claude/rules` or `.claude/agents` that points back up the
  tree (such as `a -> .`) no longer stalls the adapter. Starting, resuming or
  forking a Claude thread in such a project used to block every other request
  for seconds and then fail with `Maximum call stack size exceeded`. Each
  folder is now read once, by its real path, and its rules and agents load as
  usual.
- `fs/watch` follows Codex: it keeps the path the client sent instead of its
  realpath, watches a file (such as `.git/HEAD`) through its directory so the
  watch survives git's lock-file rename and reports the file's own path, accepts
  a file that does not exist yet, coalesces each watch's events over 200 ms,
  and refuses a `watchId` already in use on the same connection with
  `watchId already exists: <id>`. Watch ids are per connection, and a closed
  connection's watches are dropped.
- A `command/exec` that hits `timeoutMs` now stops its whole process group
  (SIGTERM, then SIGKILL after 1 s) and reports `exitCode` 124. The reply comes
  when the command exits plus at most a 2 s output drain, so a backgrounded
  child no longer holds it. `command/exec/terminate` stops the group too.
- Streamed `command/exec` output (`streamStdoutStderr` or `tty`) now honors
  `outputBytesCap`, including its 1,000,000-byte default, as Codex does: each
  stream is cut at the cap, the delta that reaches it carries `capReached:
  true`, and later data on that stream is dropped while the process keeps
  running. `disableOutputCap` keeps streaming everything.
- When a client disconnects from a `unix://` or `ws://` adapter, the
  terminals (`process/spawn`) and `command/exec` processes it started are
  stopped, as `codex app-server` does, and their handles are free again at
  once; other clients keep theirs. They used to run on after every App
  reconnect, holding their handles, and a terminal without a pty even outlived
  the adapter. A stopping adapter now ends the terminals still open, and
  `process/kill` follows up with SIGKILL when a process ignores SIGTERM.
- A stopping adapter (launchd stop, idle exit, the stdio pipe closing) sends
  each running `command/exec` and `process/spawn` process group SIGTERM once
  and SIGKILLs what is left after at most 1 s, before it exits. A command
  that ignored SIGTERM used to outlive the adapter, and one that handled it
  got a second SIGTERM as the clients disconnected. (#334)
- A `process/spawn` without a pty runs in its own process group, as
  `command/exec` does: `process/kill`, `timeoutMs` (60 s by default for a
  non-interactive process) and a stopping adapter now end what it started,
  not only its own process, with SIGKILL for what ignores SIGTERM, so its
  `process/exited` comes and its handle is free again. A terminal that
  reaches `timeoutMs` is stopped as `process/kill` stops it, shell session
  included, instead of losing only its pty bridge. For `command/exec` too,
  the SIGKILL now comes as soon as the command exits if that is before the
  1 s grace ends, and never later. (#334)
- A terminal with a TTY (`process/spawn` with `tty`) reports `process/exited`
  as soon as its command exits, after the rest of its output, with the real
  exit code (128+N for a signal, 127 when the command cannot start). It used
  to wait for `process/kill` and always report 0. (#221)
- `fs/getMetadata` reports `isSymlink: true` for a symbolic link, while
  `isFile`, `isDirectory` and the times still describe its target, and a
  dangling link returns the link's own metadata instead of failing with
  `ENOENT`; a missing path or a symlink loop still fails. (#271)
- `fs/watch` on a symlinked file reports changes to the file it points to
  again, under the link's path, and follows the link when it is re-pointed.
  Since #267 it only noticed the link itself being replaced.
  A file whose directory does not exist yet (`.git/HEAD` before `git init`)
  is watched from the nearest existing folder, as Codex does, instead of
  failing with `ENOENT`. (#333)
- `fs/readDirectory` lists a symlink as the file or folder it points to, as
  `fs/getMetadata` and Codex do, and leaves out a dangling link. Linked files
  such as `CLAUDE.md -> AGENTS.md` and linked package folders used to show as
  neither. (#333)
- `fs/copy` keeps symlink targets as written, so a relative link in a
  recursive copy stays relative instead of pointing back into the source
  tree, and writing through the copy no longer changes the source. (#270)
- `review/start` and `thread/compact/start` are refused as an invalid request
  (`-32600`) while a turn runs or is still starting on the thread. They used
  to start a second Claude run that took over the thread, and the running
  turn's remaining output was lost. (#240, #241)
- Deleting or archiving a chat interrupts a turn the user runs directly on
  one of its subagent threads, as it does the chat's own turn. A deleted
  thread's turn used to keep the adapter busy for good: the daemon never
  idle-exited and the keep-awake guard stayed on. A review, compaction or
  Claude follow-up no longer starts on a chat that `thread/delete` is
  removing (nor a review or compaction on an archived chat), and the App
  hears nothing more of a deleted thread, such as a `turn/completed` still
  marked `inProgress`. (#328)
- Startup recovery streams the completed history and rechecks a turn before
  repairing its activity markers. A report another adapter finished while
  recovery was scanning stays in the conversation.
- Adapters sharing one state directory claim an adapter-managed turn in SQLite.
  A window attached to another adapter can read the chat while a turn runs and
  retry a message after it completes. A surviving adapter can start the next
  turn after the previous owner exits. (#283)
- A message, shell command or review sent to the thread of a subagent that is
  still working is refused with "this agent is still working; message it from
  its parent chat or wait for it to report", instead of naming an active turn
  in another adapter process that does not exist. (#335)
- A `turn/start` sent while another turn runs or is still starting on the
  same thread, or a goal continuation that waited on it, joins that turn
  instead of opening a second run that orphaned it or whose answer was
  dropped, and a late cleanup from an older turn no longer clears the newer
  one or marks the thread idle. (#241)
- `thread/loaded/list` honors its cursor: following `nextCursor` returns the
  next page instead of the first one again, the last page's cursor is
  `null`, `limit: 0` counts as 1 instead of looping on empty pages, and a
  cursor the adapter never handed out is an invalid request, as in Codex.
  (#239)
- The @-file picker finds files in large repositories. The file list is
  streamed instead of buffered, so a walk over 5 MiB no longer comes back
  empty, the `find` fallback skips `.git` and `node_modules`, and every match
  is scored before the best 100 are kept, so a deep exact name match is no
  longer cut off. (#225)
- The adapter's own MCP clients (`mcpServerStatus/list`,
  `mcpServer/tool/call`, `mcpServer/resource/read`) answer a server's `ping`,
  turn down its other requests with `-32601` and ignore its notifications.
  They used to take such a request for the reply to a pending call or wait
  out the MCP timeout. (#219)
- Those requests start a stdio MCP server in the Claude thread's project
  folder, as Claude Code does during a turn, so relative commands and paths
  work, and two projects no longer share one server status list. (#220)
- File change cards of Write, Edit and MultiEdit calls keep blank lines, so
  an edit that only adds or removes blank lines no longer shows as no
  change. (#207)
- A command whose approval request arrives before its tool call records its
  start time, so its item shows a real duration, and keeps getting a
  background shell's output after the Bash call returns. (#209)
- A question Claude asks (`AskUserQuestion`) shows the App's own free-text
  choice instead of an extra plain "Other" option, and a typed answer reaches
  Claude and the answer card as the answer; a literal "Other" pick is kept.
  (#218)
- A git lookup for a chat's branch that times out, is killed or cannot start
  no longer leaves the chat without its branch, as if on a detached HEAD, and
  the next lookup runs git again; only git's own errors (outside a
  repository, an unborn branch, no `origin`) mean no git info. A resume into
  another folder whose lookup fails clears the previous folder's git info.
  (#212)
- An HTTP MCP server that answers with an event stream and keeps the stream
  open after its reply no longer makes every request wait out the MCP
  timeout and fail: the adapter stops reading at the event that answers the
  request, as Codex's MCP client does.
- Opt-in Memories: with `CLAUDE_CODEX_MEMORIES=1`, the App's Memories
  settings (Settings > Personalization) and `/memories` decide whether Claude
  threads run with Claude Code's auto-memory, and while Memories is off in the
  App they run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Without the switch
  nothing changes: the App shows no Memories settings and Claude Code's own
  settings decide.
- `memory/reset` is refused instead of reporting success, since Claude Code's
  memory folders are shared with Claude Code outside the App and the adapter
  deletes nothing, and `memory/status` checks `minConsolidatedThreads` against
  Codex's bounds (1 to 4096).
- The model picker reads the Codex model catalog from `CODEX_HOME` instead of
  `~/.codex`, so an App with its own home lists its catalog rather than the
  built-in fallback models.
- Updated the adapter to advertise Codex app-server protocol v2 compatibility at
  the current pinned Codex CLI compatibility version, while keeping a
  `claude-codex` suffix so hosts can distinguish the adapter from upstream
  Codex.
- `plugin/read` returns the plugin's `appTemplates` the protocol requires. The
  Codex App read them unguarded, so a thread with the in-app browser open
  showed an error page instead of the conversation.
- A structured (`outputSchema`) Claude turn, such as the App's title and
  summary turns, answers with what Claude passed to `StructuredOutput`. The
  adapter used to drop that call and fill every field with the user's prompt,
  so App chats were titled with the first words of the request.
- A chat the leader tools start is announced with its first message as its
  preview and its `thread_start` title, kept to one line, as its name. The
  Codex App shows that title or, without one, titles the chat from its first
  message, as it titles the user's own chats; such chats used to stay
  untitled.
- `thread/inject_items` no longer adds a turn that shows the items as raw
  JSON in an assistant message, which Claude never read. The items, such as
  the state of an inline visualization or an MCP app's content, wait for the
  next message and reach Claude before it as `<app_context>` blocks, the way
  Codex adds them to the model's history without showing them. Images in
  them are left out.
- Expanded Codex App Remote coverage across thread lifecycle, turn envelopes,
  item streaming, approvals, MCP status, fuzzy file search sessions, Claude
  skills/hooks, and `thread/turns/list` item views.
- A turn still finishing when the adapter stops (waiting on its final
  `git diff`, an approval or the runtime) no longer writes to the closed
  SQLite store, which crashed the process on the way out.
- When the adapter cannot record the turns it interrupts on shutdown (its
  database was deleted, for example), it still stops Claude and exits with
  status 1 instead of staying alive.
- A turn, review or compaction requested just before the adapter stops no
  longer starts afterwards: it launched Claude after the runtime had stopped,
  and a compaction crashed writing to the closed store.
- Added protocol fixture coverage for `config/read`, including the sanitized
  `config.provider_loop_config` shape, so the Rust fixture drift gate covers
  provider-loop config projection behavior.
- Kept compatibility-only account, plugin, marketplace, realtime, and other
  OpenAI-specific surfaces inert or schema-shaped where Claude Code has no
  equivalent.
- Writes to the state database wait out another connection's lock (5 s,
  `CLAUDE_CODEX_STATE_DB_TIMEOUT_MS`) instead of failing at once, and a turn
  whose final write still fails ends with `turn/completed` instead of staying
  in progress with an unhandled rejection.
- Goals, steer and the message queue follow the Codex App: `thread/goal/*`
  with continuation turns, token and time budgets and goal tools for Claude;
  steer errors in Codex's wording; and `thread/queue/*`.
- A queued message that starts after the App disconnected is no longer killed
  by the unix daemon's idle exit 15 s into its turn, with the message already
  gone from the queue; nor is any other turn that starts while the daemon
  counts down, such as Claude answering a background agent's report. The
  daemon exits once nothing runs. (#335)
- After an interrupt, the queue stays held until `thread/queue/start` or the
  user's next message. A `!` shell command, review or compaction in between
  used to send the next queued message on its own. (#335)
- The context gauge follows the main loop's latest API call, like Codex's
  `last_token_usage`, and tokens spent by subagents and workflows count toward
  the thread total without moving the gauge or goal progress.
- `thread/compact/start` compacts the thread's own Claude session with
  `/compact`, so the conversation goes on from Claude's summary instead of a
  summary written beside it; a thread with no session yet, or whose
  compaction fails, still gets the summary-model summary. Claude compacting
  on its own within a turn now shows as a `contextCompaction` item, and the
  context gauge drops to the compacted size either way. Only compaction and
  review turns refuse `turn/steer`, with Codex's invalid-request code
  (`-32600`) and its `activeTurnNotSteerable` error as data, which newer App
  builds take as a cue to queue a message sent during a compaction; a turn
  Claude compacted keeps taking messages.
- A turn that ends early completes the message still streaming and fails the
  tool calls still running before `turn/completed`, instead of leaving them
  in progress in the App.
- The adapter stops Claude CLI processes a previous adapter on the same state
  dir left running, matching pid, start time and command line before
  signalling (`CLAUDE_CODEX_REAP_ORPHANED_CLI=0` turns it off). Start times
  are read in UTC and the C locale, so two adapters with a different `TZ`
  (an App launch and a shell) no longer drop a live sibling's record or miss
  a killed adapter's Claude CLI.
- On a busy machine, a `claude-p` turn that times out or is interrupted stops
  the processes it started in their own process group too. Listing the
  process tree (`ps`) gave up after 1 s, which a loaded Mac with a thousand
  or more processes often needs, and the stop then reached only the
  `claude-p` process; the list now runs without blocking the adapter and
  gets 10 s.
- A `claude-p` turn that times out also SIGKILLs the processes it started
  after the `claude-p` process itself has exited, those started during the
  grace period included, so a child that ignores SIGTERM no longer survives
  and one holding the output open no longer leaves the turn hanging. An
  interrupt's follow-up reaches them the same way. (#264)
- A second adapter started on the same state dir (a startup probe, another
  window) no longer fails the turns a running adapter is still working on.
  Each turn records the process that wrote it, by pid and start time, and
  startup recovery fails only the turns of processes that are gone; turns
  written before this change are recovered as before.
- Opening the state database no longer rewrites thread rows. The startup
  repairs for pin state and legacy enum values rewrote every unsectioned
  thread on each open and scanned the instruction text; they now check with
  a read first and touch only rows that need fixing, so a clean store opens
  without a write or the write lock (about 20 ms instead of 320-370 ms for
  20,000 threads with large instructions).
- `app-server --print-startup-config` (codex 0.164) prints its one JSON line
  (`appServerVersion` and `configRequirements`) and exits, and
  `app-server daemon version` reports the unix daemon listening on the control
  socket, or fails when none is. Both answer before the state database opens;
  they used to start a full stdio server, with its startup recovery and
  cleanup, and never print their answer. The `codex` shim answers the plain
  forms itself, without starting node.
- `CLAUDE_CODEX_SOCKET_PATH` moves the unix socket that
  `app-server --listen unix://` listens on and `app-server proxy` connects
  to when neither names one (by default
  `app-server-control/app-server-control.sock` under `CODEX_HOME`); an
  explicit `--listen unix://PATH` or `proxy --sock PATH` still wins. Both
  commands read it, so set it where both run. The daemon creates a missing
  folder with mode 700 and leaves an existing folder's permissions as they
  are; it refuses to start in a folder that group or other users can write
  to unless the folder is sticky, as `/tmp` is.
- `app-server proxy` takes `--sock=PATH` as well as `--sock PATH`; a `--sock`
  with no path is an error instead of quietly using the default socket. A
  bad `--listen` (`tcp://...`, `ws://host:abc`, or `--listen` with no value)
  now fails with one line before the state database opens, instead of a
  stack trace after it, or a silent `stdio://`. The unix daemon no longer
  refuses to start over a pid file that is empty or holds `0`, nor over one
  naming a process that has not listened on the socket within the startup
  limit described next.
- A unix daemon that takes more than 10 seconds to start no longer gets a
  second daemon beside it. A second `--listen unix://` used to take it for
  stale after 10 seconds and start too; one of the two then removed the
  other's socket, and the daemon left without one kept the state database and
  its Claude runtime open and never exited. The process the pid file names now
  gets up to 60 seconds from the file's date to start listening, unless it
  started after the file was written (a reused pid); when `ps` cannot report
  its start time, the 10 seconds still apply. Meanwhile a second daemon says
  `app-server already starting` (or `already running`) and exits 0. A daemon
  removes a socket at its path only when the socket refuses a connection, so
  of two daemons that do start, the one that binds second leaves the socket
  to the first and exits. (#329)
- With `CLAUDE_CODEX_SDK_LAUNCH_GATE=1`, the native runtime starts Claude
  Code processes one at a time: a new session waits until the previous
  launch has sent its first SDK message, has ended, or has held the slot for
  `CLAUDE_CODEX_SDK_LAUNCH_GATE_TIMEOUT_MS` (default 30000) without a word,
  and the prompt, steers and settings changes sent meanwhile wait with it.
  This keeps the chats that all resume right after a restart from writing
  `~/.claude.json` at once, which can corrupt it
  (anthropics/claude-code#28847). A `SessionStart` hook does not hold the
  gate. Without the switch nothing changes.
- The App's "/" popup offers Claude Code's built-in skills (`/simplify`,
  `/code-review`, …) from the list the CLI reports, and a picked one runs as
  the CLI's slash command.
- Every client request the Codex App can send now has a handler. New real
  ones: `project/*`, `thread/delete` (with its subagents), `thread/rollback`
  and `thread/revert` that also rewind Claude's session, `thread/search` and
  `thread/searchOccurrences`, item and timeline paging, `thread/attachment/*`,
  background shell listing and termination, `turn/settings/update`,
  `account/usage/read` from local history, import history, and server
  diagnostics. Remote control and passkey verification answer disabled and
  unavailable instead of failing.
- Fixed `thread/turns/list` paging and ordering, and `thread/list` /
  `thread/search` pages that skipped threads updated in the same second as the
  last one shown.
- Input sent while a turn is still starting waits up to 10 s for it instead
  of failing with `no active turn to steer`, a turn whose runtime run has
  returned is ended instead of holding the thread until Stop, and a turn the
  server failed also stops the CLI turn behind it.
- An ephemeral `thread/fork`, which the App uses to describe a thread, stays
  out of `thread/list`.
- A `turn/start` carrying `toolOutput` instead of input (a thread handoff, or
  a message from another thread) prompts Claude with its text and images and
  records it as a `functionCallOutput` item, instead of starting a turn with
  an empty prompt.
- `thread/timeline/list` serves the newest page first and pages back, as Codex
  does, instead of starting from the oldest entries.
- `turn/settings/update` switches a running turn's model and effort in place,
  and accepts the reviewer the App sends when permissions change during a
  turn, instead of failing on any change. An unknown model fails instead of
  falling back to the thread's model.
- Claude Code command hooks the adapter runs honour `onFailure: "block"`: a
  hook that cannot start, times out, exits with a code other than 0 or 2, or
  prints JSON that does not parse blocks the tool call or prompt as exit 2
  would, with a reason that names the hook and the failure, instead of letting
  it through. `continue` stays the default; async hooks and `Stop` /
  `SubagentStop` hooks ignore it, as in Claude Code.
- Claude Code's hook runs show as `hook/started` / `hook/completed` in the
  turn's hook summary, with the settings file that configures them and a
  blocked status for a hook that blocks; `hooks/list` also lists `SessionEnd`,
  `SubagentStart` and `SubagentStop` hooks.
- A switch to a fallback model after a refusal shows as `model/rerouted` for a
  cyber-safety refusal and as a warning otherwise, and a refusal with no
  fallback as a warning.
- An MCP server can ask the user for input: its elicitation becomes
  `mcpServer/elicitation/request`, a form or a link in the App, and the answer
  goes back to the server.
- `mcpServerStatus/list` honours `serverName`, and `mcpServer/resource/read`
  answers with the `originCallId` the protocol requires.
- Claude threads can show inline visualizations. New threads, forks and
  subagents get UUIDv7 ids, without which the App refuses to read a thread's
  visualizations; the `visualize` plugin the App installs is remembered, and
  its skill is listed in the desktop prompt with the `::codex-inline-vis{…}`
  line the App renders and the thread's visualization folder, which Claude may
  read without an approval prompt. Chats created before cannot render them.
- A visualization Claude names with a plain `visualize{…}` line, without the
  invisible marks the App's visualize skill puts around it, renders instead of
  showing as text: the adapter adds the marks outside code fences when the
  message completes and in history reads; streamed deltas keep the line as
  written.
- A turn its Claude session no longer holds as the current one ends when that
  session does, instead of staying in progress. The App leaves its running
  state on `turn/completed` only, so such a turn kept the thread spinning for
  the rest of the connection — with the answer already written to Claude's
  transcript — until the user interrupted it by hand.
- Codex App 26.1013 is a verified build. Its GovCloud check for a Bedrock
  account is answered "not GovCloud", so the App no longer shows the GovCloud
  modal; `thread/attachmentOwner/list` lists the threads holding a worktree,
  by thread id and with the `archived` filter; and a request the adapter has
  no case for fails with JSON-RPC `-32601` (method not found), the code the
  App treats as unsupported, instead of the generic `-32000`.
- As in Codex, a fork that is kept holds the thread attachments its parent
  held (the worktree, pull requests), so `thread/attachmentOwner/list` names
  it too and the App keeps a worktree a fork of an archived chat still holds.
- `npm run check:app-upgrade` also takes an `app.asar` or an extracted App,
  reads the protocol from a codex checkout with `--protocol-source` or skips
  it with `--bundle-only`, and lists every request the App's scripts name that
  the adapter would answer with method not found.
- `thread/fork` honours `lastTurnId` (fork through that turn) and
  `beforeTurnId` (fork before it), which the App sends to fork a chat from one
  of its turns. The fork's history stops there, and so does Claude's context:
  its first turn resumes at the newest kept turn's checkpoint, or where the
  chat began when the fork keeps no turn, so the forked chat no longer
  remembers what came after. As in Codex, the two ids together, an unknown
  turn and a `lastTurnId` that is still running are rejected. When the kept
  turns predate checkpoints, the fork keeps Claude's whole session, as before,
  and a `configWarning` says so.
- The adapter advertises app-server `0.163.0-alpha.10.2`, the Codex build of
  Codex App 26.1013, so every feature gate of 26.1013 is on; App 26.930 turns
  on every one of its own gates, as with the `0.159.0-alpha.12.1` the adapter
  advertised before. Codex `0.163.0` has the same app-server protocol.
  `CLAUDE_CODEX_COMPAT_VERSION` still overrides it, and
  `docs/reference/app-compat.md` lists what the gates change, including the
  two that also depend on the App's server-side flags. The App's composer
  predictions, which that version turns
  on, fork only a thread whose `modelProvider` is `openai`, so they leave
  Claude threads (`claude-code`) alone.
- Every turn carries `rootTurnId`, new in that protocol: the root a
  `turn/start` names for work it starts on behalf of another turn, else the
  turn's own id. A subagent's turn takes the root of the turn that spawned it,
  and input that joins a running turn keeps that turn's root, as in Codex; a
  queued message or goal turn the adapter starts afterwards is its own root.
- CI checks the Rust protocol fixtures against `@openai/codex@0.163.0`, and
  the `turn/started` and `turn/completed` fixtures must carry exactly the
  fields of the generated `Turn`.
- With `CLAUDE_CODEX_DYNAMIC_TOOLS=1`, Claude gets the dynamic tools a client
  registers on `thread/start` (the Codex App's own tools, which it sends to
  remote hosts), one in-process MCP server per namespace. A call goes back to
  the client as `item/tool/call` and shows as a `dynamicToolCall` item; specs
  Codex refuses fail `thread/start` with its messages, and a chat keeps its
  tools across restarts, resumes and forks. Off by default, since the App's
  tools act on the desktop without an approval prompt.
- Claude's file edits show while Claude is still writing them, as Codex's
  patches do: the `fileChange` card of an Edit, Write or MultiEdit call in
  the main loop opens once Claude's streamed input names the file and grows
  through `item/fileChange/patchUpdated`, at most every 500 ms. The finished
  call, or an approval request that comes first, replaces the streamed
  input, so the approval and the completed item show exactly the change
  Claude makes; a card whose call never finished fails at the next model
  response. `CLAUDE_CODEX_LIVE_FILE_CHANGES=0` shows a change only once the
  whole call has arrived, as before.
- `model/list` offers each Claude model the reasoning efforts Claude Code
  reports for it instead of low to xhigh for all: `max` on the models that
  take it, and none on a model without effort levels, such as Claude Haiku,
  whose `defaultReasoningEffort` is then `none`. The native runtime asks the
  SDK for `supportedModels()` when a Claude session starts and keeps the
  answer in `claude-models.json` under the adapter home, so a restarted
  adapter still lists the levels. Before the first report, or with a Claude
  Code that reports none, every model offers low to xhigh as before, and
  Codex proxy models keep those levels. `max` is kept as a thread and config
  effort; a `turn/start` with effort `none` runs without an effort and keeps
  the thread's, and `turn/settings/update` ignores `none`. The App picks the
  levels up when it reloads the model list (on window focus, at most every
  five minutes) and shows Max only once it is turned on under Settings >
  Agent > Model features.
- With `CLAUDE_CODEX_APP_PLUGIN_MCP=1` (off by default), the adapter runs
  the MCP server of the Codex App's code-review plugin, which draws the
  App's Pull Requests panel, and answers the App's `mcpServerStatus/list`,
  `mcpServer/tool/call` and `mcpServer/resource/read` for server
  `code-review` instead of treating it as unknown. The server runs as one
  long-lived stdio process from the plugin's folder with only an
  environment allowlist, uses the host's GitHub credentials (such as an
  existing `gh` login) and is never offered to Claude threads. A
  comma-separated value names other plugins to run; `codex-app-tools`,
  `browser-use` and the `codex_app` server never run. The App turns the
  server on only for an app-server on the same machine, and starting a
  review from the panel runs the real Codex CLI, so it needs a working
  Codex install. For every server, `mcpServerStatus/list` now keeps each
  tool's `annotations`, `icons` and `_meta`, and `mcpServer/tool/call`
  forwards the request's `_meta` with the call's `threadId` set, as Codex
  does.
- `mcpServer/oauth/login` fails with an error saying to sign in with `/mcp`
  in a Claude Code session, instead of handing the App an authorization URL
  that led nowhere: Claude Code signs in to MCP servers itself, and the
  adapter cannot start that sign-in. The App shows only its own "couldn't
  connect" message. `config/mcpServer/reload` is no longer a no-op: it drops
  the cached server statuses, sends every window each configured server's
  startup status again, and has sessions kept open by background work retry
  the servers that failed or wait for a sign-in, leaving connected ones
  alone.
- Memories Claude Code recalls during a turn show under its answer as a
  Codex `memoryCitation`: each memory once, with its file's lines and its
  description or first line as the note.
- Review turns complete their `enteredReviewMode` item right away and end
  with an `exitedReviewMode` item that carries Claude's answer, or Codex's
  fallback text when there is none, also when the review is interrupted,
  fails or is cut off by the adapter stopping, as Codex does.
- The Claude Agent SDK is 0.3.322, which bundles Claude Code 2.1.322. The
  adapter always passes a permission mode, so the CLI's changed default for
  SDK sessions without one does not reach Claude threads.
- Claude's Bash commands stream their output into the App's command item
  while they run, read about once a second through the SDK's
  `get_task_output` request: a foreground command once Claude Code makes it a
  task, about two seconds in, and a background shell after its call returned,
  also after the turn ended, followed by Claude Code's note when it was
  stopped, failed or reached its background time limit (30 minutes in Agent
  SDK sessions since Claude Code 2.1.285, or the call's own `timeout` up to 2
  hours). `CLAUDE_CODEX_COMMAND_OUTPUT_POLL_MS=0` shows the output only when
  the command finishes, as before.
- Claude's thinking shows in the Codex App. The CLI is asked for summarized
  thinking (`--thinking-display summarized`), which recent models otherwise
  redact, and it streams as the reasoning summary, the only part of a
  reasoning item the App renders (`item/reasoning/summaryPartAdded`, then
  `summaryTextDelta`). Thinking stored before as raw content reads back as
  the summary. `CLAUDE_CODEX_REASONING_VISIBLE=0` or the App's Reasoning
  summary setting set to None keeps the previous behavior.
- API retries show in the turn as Codex shows a stream retry: each
  `system/api_retry` of the main loop becomes an `error` notification with
  `willRetry` and the message `Reconnecting... n/m`, which the App folds into
  one passing row, and is not stored. Errors and failed turns carry a Codex
  `codexErrorInfo` code from the CLI's terminal reason, error category and
  HTTP status (`serverOverloaded` for a 529, `contextWindowExceeded`,
  `rateLimitExceeded`, ...), never one the App answers with a ChatGPT account
  flow. CLI notifications of high or immediate priority go out as `warning`
  notifications, which the App opts out of, as it does with Codex.
- A Claude CLI that refuses to start fails the turn with an adapter-written
  message for its `startup_failure_reason` and the reason's name as details,
  never the CLI's own output, which can hold proxy credentials. Reasons a
  retry can fix (`org_config_required_unavailable`, organization settings or
  checks that could not be reached) are `httpConnectionFailed`, which the App
  offers to retry; refused sign-ins, `provider_not_allowed`, invalid managed
  settings and local problems are `other`. The adapter sets
  `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` so every startup failure is reported
  this way unless the environment sets it. The thread keeps its Claude
  session: the refused run never loaded it, so the session id on its result
  is not stored, and the next turn resumes the conversation.
- The adapter keeps the Claude Code version each session reports (in the
  initialize reply from 2.1.296, in `system/init` from every CLI) and leaves
  off what an older CLI cannot do: live Bash output needs 2.1.287
  (`get_task_output`), and a spawn card shows an Agent call's own `effort`
  only from 2.1.292. While the version is unknown, both stay on.
- Claude chats show their branch in the App sidebar. Threads carry Codex
  `gitInfo` (commit, branch, and the `origin` remote without credentials),
  looked up after `thread/start`, when a thread without it resumes and when a
  turn ends, and stored, so `thread/list` and `thread/read` run no git.
  `thread/metadata/update` patches it as Codex does, which the App uses after
  creating a branch, and `getConversationSummary` returns it. Threads also
  carry their `model` and `reasoningEffort`.
- The context gauge moves while a turn runs, as it does for Codex: each API
  call of the main loop sends `thread/tokenUsage/updated` as it streams, with
  that call as `last` and on top of the settled total, once a result has
  reported the context window for the thread or its model. The turn's result
  still settles the total, so nothing is counted twice.
- Notifications a client opts out of in `initialize`
  (`capabilities.optOutNotificationMethods`) are no longer sent to it. The App
  opts out of `turn/diff/updated`, so its threads also skip the whole-tree
  `git diff` after every tool call. It also opts out of `warning`,
  `thread/compacted`, `thread/closed`, `project/changed`,
  `thread/project/updated` and `command/exec/outputDelta`, which it no longer
  receives from the adapter, as from Codex.
- Several clients can follow one thread, as with Codex's app-server: every
  client that starts, resumes, forks or sends a turn to a thread gets its
  notifications, instead of only the client that touched it last, and a
  turn one client starts shows its `userMessage` item to the others.
  Approvals, questions and elicitations go to every follower; the first
  answer wins, `serverRequest/resolved` takes the card down everywhere, and
  a later answer is ignored. A client that opens the thread while a request
  waits, including one that closed and reopened the chat, gets the request
  again, and the requests of a turn that ended are dropped.
  `thread/unsubscribe` drops only the caller, which alone gets
  `thread/closed`; `thread/delete` tells every follower. With one client
  connected nothing changes on the wire.
- `config/read` reports `web_search = "live"` instead of `"disabled"`, matching
  the web search `modelProvider/capabilities/read` advertises;
  `CLAUDE_CODEX_WEBSEARCH=0` turns both off.
- Claude's file exploration folds into the App's "Explored" row, as Codex's
  does. Read, Grep, Glob and LS calls are command items named after the tool
  (`Read src/app.ts`) with Codex `read`, `search` and `listFiles` command
  actions, and a Bash command that only reads, lists or searches files gets
  its actions from a port of Codex's command parser, which unlike Codex's
  never folds a command that can write files or start other programs, such
  as `find -delete` or `| xargs rm`. The App keeps the first
  30,000 characters of their output; Claude still gets all of it. A Read of
  an image is an `imageView`, WebFetch a `webSearch` item opening the page,
  and an MCP tool names its server, split by the turn's configured server
  names. A Read, Grep, Glob or LS call Claude Code asks about asks on the
  command card, and "Allow for this session" covers the same call.
- `mcpServerStatus/list` entries carry every field of Codex's
  `McpServerStatus`: `serverInfo` and `serverCapabilities` from the server's
  `initialize` reply, `toolsError` when the server failed to start or to list
  its tools, `toolListMeta` from the first `tools/list` page, `httpOrigin` for
  HTTP servers and `pluginId` for plugin servers, each `null` when unknown.
  With a `threadId` whose Claude session is open, `runtimeStatus` is the
  state that session reports for each server; otherwise it is `null`, as
  Codex answers without a thread. The App uses these to show server names and
  logos and a tool discovery error, and to retry a plugin's servers. Lists
  asked for at once share one look at the servers; HTTP servers are spoken to
  as streamable HTTP (event-stream replies, sessions) and, like stdio ones,
  given up on after 20 seconds (`CLAUDE_CODEX_MCP_TIMEOUT_MS`). An error
  carries only the end of a server's stderr and never a url's credentials.
- Codex's `model_auto_compact_token_limit` now sets the compaction window of
  Claude threads: from the config a thread starts, resumes or forks with, or
  `config/value/write`, it reaches the Claude CLI as
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (kept within 100,000 to 1,000,000
  tokens), and `config/read` reports it instead of `null`. The user's and
  trusted projects' `config.toml` count only with
  `CLAUDE_CODEX_CODEX_AUTO_COMPACT=1`, since users set the key there for Codex
  models. Without the key nothing changes. Bridged Claude Code subagents keep
  their `autoCompactWindow` frontmatter, which used to be dropped.
- Claude chats have the Codex App's Plan mode: `collaborationMode/list`
  returns Plan and Default presets, which turns on `/plan` and the
  composer's Plan toggle, and `turn/start`, `thread/settings/update` and
  `thread/resume` take the App's `collaborationMode`, reading the model and
  effort from its settings first. A Plan turn runs in Claude Code's plan
  permission mode: Claude explores read-only and may ask questions, a tool
  call that would need approval is refused, and the plan Claude hands over
  (`ExitPlanMode`) becomes a single `plan` item, so the turn completes and
  the App offers "Implement this plan?"; accepting sends a Default turn. A
  thread keeps its mode across turns and restarts and reports it on
  `thread/settings/updated` and `thread/resume`; a fork starts in Default,
  as in Codex. The legacy `planMode` flag still works.
- A skill picked in the composer, or from a plugin or setup card, reaches
  Claude the way Codex reads it: the adapter adds a `<skill>` block with its
  `SKILL.md` to the prompt when the file sits in a folder `skills/list`
  reads or belongs to an App skill Claude can run, up to 64 KiB, and
  otherwise asks Claude to read the file. `additionalContext` on
  `turn/start` and `turn/steer`, which used to be dropped, follows the
  message as `<app_context>` blocks of at most 32,768 characters each,
  with a note that untrusted entries are data, not instructions. The
  `userMessage` item keeps the input as sent, and `outputSchema` helper
  turns get neither. Desktop prompts add a "# Tool availability" note
  naming the App-only tools the App's instructions mention (starting and
  reading threads, automations, worktrees, the sidebar), so Claude asks the
  user to use the App instead of looking for them or writing their
  directives; tools a chat has a counterpart for (the leader tools, or a
  dynamic tool of the same name) are left out of the note. No tool is
  added.
- Claude's approval requests look like a Codex thread's: the card carries
  Claude's reason; a tool other than Edit, Write and MultiEdit asks on the
  command card with its name and what it touches (`WebFetch https://…`),
  where such calls used to show no card while the turn waited; a file
  change outside the workspace sets `grantRoot`; and an MCP tool asks with
  the App's MCP tool approval card (`mcpServer/elicitation/request` with
  `_meta.codex_approval_kind` `"mcp_tool_call"`). "Allow for this session"
  covers the same Bash command, the same input of another tool, or every
  call of that MCP tool for the rest of the thread while the adapter runs;
  a remembered Bash command no longer approves another tool whose input has
  the same `command`. Decline ends the call declined while Claude goes on,
  Cancel also stops the turn, and a call Claude refuses without asking (a
  deny rule, the auto-mode classifier) ends declined with a warning naming
  the reason.
- The App's "remember" choices save the permission rules Claude Code offers
  with a request: a shell command for which Claude offers exactly one rule
  gets "Allow similar commands" (`proposedExecpolicyAmendment` with the
  rule's command prefix, answered with `acceptWithExecpolicyAmendment`),
  and an MCP tool card gets "Always allow", which saves
  `mcp__<server>__<tool>` for that tool alone. Claude Code writes the rule,
  always to the project's `.claude/settings.local.json`. Nothing is saved
  unless one of these two is picked, and a call only the user may answer,
  or one Claude offers no rule for, gets neither. With
  `CLAUDE_CODEX_SESSION_SUGGESTIONS=1`, "Allow for this session" also
  applies the session rules and folders Claude offers with the call, which
  can cover more than a Codex session approval (every fetch from a domain,
  a folder outside the workspace), so it is off by default; Claude's offer
  to switch permission mode is never passed on.
- The App's auto-review permissions preset works in Claude chats:
  `approvalsReviewer` `auto_review` (`guardian_subagent` from older App
  builds) is kept per thread, across later turns, restarts and forks, and
  reported back, and a Claude thread with it runs in Claude Code's `auto`
  permission mode, where a classifier decides the calls that would
  otherwise ask. A call the classifier blocks ends declined after an
  `item/autoApprovalReview/completed` denied review with its reason;
  `thread/approveGuardianDeniedAction` stays a no-op. Where auto mode is
  unavailable (the model lacks it, Claude Code refuses it, a read-only
  sandbox, `CLAUDE_CODEX_PERMISSION_MODE` set to another mode, a backend
  other than the Agent SDK), the thread keeps and reports `user` with a
  `configWarning` saying why, and a model switch checks again.
  `turn/settings/update` switches a running turn into or out of auto mode.
  A thread that names no reviewer runs as before, except that a call Claude
  Code says only the user may answer now asks in every mode, Full access
  included, and "Allow for this session" covers only that call.
- When Claude Code withdraws a pending approval or question mid-turn, its card
  closes, the call is declined, and a late Cancel no longer interrupts the turn.
- A turn that ends while an approval, question or MCP form waits now takes the
  card down in every client that shows it (`serverRequest/resolved`), leaves
  the thread idle instead of reporting it active again, and no longer leaves
  the call Claude made hanging. A `turn/interrupt` naming a turn that already
  ended, a background agent's earlier run included, is ignored instead of
  stopping the turn or run that came after it.
- A thread whose approval policy is `never` keeps a read-only sandbox
  read-only: Read, Grep, Glob, LS and WebSearch run, and any other call is
  refused without a card, with Claude told the sandbox is read-only. Before,
  `never` approved every tool whatever the sandbox, so Bash and file edits ran
  in a read-only thread. The `claude-p` backend no longer adds
  `--dangerously-skip-permissions` there, so only the read tools it
  pre-approves run. The summary `/compact` writes in place of compacting
  Claude's session (on a Codex model, or when that compaction fails) now
  declines any tool beyond its reads instead of approving it. `never` with
  any other sandbox still runs every tool unasked: the adapter has no OS
  sandbox to confine workspace-write.
- Approval policy `on-failure` runs Claude Code in `acceptEdits` mode only in
  a `workspace-write` sandbox; anywhere else file edits ask. In a read-only
  sandbox, edits in the workspace used to run with no card. (#331)
- An approval card that a turn ending on its own takes down, such as a
  background agent's request still open when Claude finishes its reply, now
  declines the call, and Claude is told the turn had ended rather than that
  the user declined. It used to reach Claude Code as the user's Cancel, which
  stopped the background agent. Stop, or Cancel on a card (also while the
  turn is still finishing), still stops the call. (#331)
- `turn/start`, `thread/settings/update` and `thread/resume` that name a
  custom permissions profile with explicit approval and sandbox fields now
  store those fields as the thread's policy, as `thread/start` does. The turn
  used to run on them while approvals and later turns kept the thread's
  earlier policy, so a Full Access thread moved to a custom read-only profile
  still ran every call without a card. (#331)
- The `claude-p` backend pre-approves only Read, Grep, Glob, LS and WebSearch
  in a read-only thread, as the Agent SDK route runs there. It also
  pre-approved WebFetch, Task and TodoWrite, so a read-only chat could fetch
  any URL with no card. (#331)

### Trustworthy history and settings

- A turn no longer stores the whole uncommitted `git diff` of its folder,
  which nothing read back. In a repository with a large uncommitted change
  every turn added megabytes to `state.sqlite`, every fork copied them, and
  every history read or search decoded them: five turns in a repository with
  a 3.5 MB diff grew the file to 21 MB, now 160 KB. Clients that listen still
  get `turn/diff/updated`; the turn's end no longer runs `git diff` when every
  client opted out of it, as the App does. After the upgrade the adapter
  empties the diffs older versions stored gradually, a few turns per write in
  the background once it serves, so a large state file neither delays its
  start nor locks out another adapter for long; reads skip them meanwhile.
  SQLite reuses the space (the file does not shrink), and an older version
  still opens the state. (#336)
- A Claude chat keeps its conversation when its workspace folder is moved or
  renamed. The adapter looks for the transcript under the workspace it last
  recorded, in the chat's own Claude config folder, and resumes an
  independent copy for the new path, or the transcript itself when the new
  name maps to the same Claude Code project folder (`my_project` to
  `my-project`). It used to start a new session silently and send Claude only
  the newest message. When the transcript cannot be found, for example after
  Claude Code deleted sessions older than its `cleanupPeriodDays` (30 days by
  default), the chat continues in a new Claude session and a notice says the
  earlier conversation could not be found. So does a chat whose Claude config
  folder was deleted; the new session creates it again. A config folder that
  is out of reach (a link or parent folder that is gone, as on an unmounted
  volume, or a folder that cannot be read) fails the turn instead, and the
  chat keeps its session for when the folder is back. (#324, #327)
- A fork whose first turn failed before Claude Code started still forks its
  parent's Claude session on its next turn. It used to resume the parent's
  session itself and write the fork's conversation into the parent's
  transcript. (#327)
- A deleted chat stays deleted and a rename sticks when a `turn/start`
  arrives at the same time, for example from a second window on the same
  chat. `turn/start` re-reads the thread after waiting on a running turn
  instead of writing back the copy it read first, and a `turn/start` that
  lands while `thread/delete` is ending the chat's turn fails with
  `unknown thread` and starts nothing.
- Streaming no longer stalls the adapter on every text, reasoning or command
  output delta. Each delta used to read the whole turn, write it back and
  fsync the state database before the delta reached the App, a few
  milliseconds each on a long turn. The store now keeps a streaming turn in
  memory and writes it about every 50 ms, and before any other write or read
  of the state. Reads of that turn, such as the status check before each
  delta, come from the copy in memory, so history, completion, a restart and
  other processes still see every delta.
- `thread/revert` returns an `itemsBackwardsCursor` that `thread/items/list`
  accepts: the index of the last item kept, or `null` when none is left. It
  used to return that item's id, which the list refused as an invalid
  cursor. (#274)
- `thread/search` and `thread/searchOccurrences` no longer fail with `-32000`
  on a term with a `-` in it, such as a date, a package name or a flag.
  (#222)
- Chats in a folder whose Claude Code project name runs past 200 characters
  resume their Claude session again: the adapter names the project folder as
  Claude Code does (its first 200 characters and a hash of the path) and
  still finds the older uncut name while it fits in 255 characters. (#223)
- `CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING=1` reaches Claude Code: the native
  runtime passes `enableFileCheckpointing` to the SDK, which it used to read
  and drop. Changing it starts a new Claude session on a thread's next turn.
  (#206)
- Turning a skill off on the App's Skills page is refused as an invalid
  request, so the App puts the switch back and shows "Failed to update
  skill". It used to report the skill off while Claude kept loading it and
  `skills/list` still showed it on. Turning one on still works. (#275)
- A forked chat shows the turns it was forked with on every read, as a Codex
  fork does: `thread/resume`, `thread/read`, `thread/turns/list`,
  `thread/items/list`, `thread/turns/items/list`, `thread/timeline/list` and
  search return them ahead of the fork's own turns, under the same ids, after
  a restart too. So does a leader chat's `thread_read`, and its
  `thread_list` names a fork's last inherited turn until the fork has one
  of its own. The adapter copies them into the fork when it is made, so a
  rollback or delete of the parent leaves the fork's history alone; a fork of
  a fork inherits the whole history and can branch from an inherited turn,
  and a rollback or revert can reach back into the inherited turns. Forks
  made by an earlier version get their history when first read if their
  stored fork point says exactly where they branched off. Ephemeral forks
  still carry their history in the `thread/fork` response only, as in Codex.
- With `CLAUDE_CODEX_APP_MCP_SERVERS=1`, MCP servers added, edited, switched
  off or deleted in the App's Settings > MCP servers take effect in Claude
  threads. The App writes them with
  `config/batchWrite` and `config/value/write`; the adapter keeps them in its
  own settings (never in `config.toml`), checks them like `config.toml`
  entries, passes them to every turn, `mcpServerStatus/list` and
  `config/mcpServer/reload`, and reports them in `config/read` so the page
  lists them after a restart. One of them wins a name over a server the
  Codex or Claude Code config brings, and `CLAUDE_CODEX_MCP_SERVERS` wins
  over it; the App's own desktop servers (`node_repl`, `cua_repl`) are
  accepted and not kept. A server or field named `__proto__` is refused
  with `INVALID_REQUEST`.
  The switch is off by default, since such a server runs a program or reaches
  a URL from every Claude thread. Without it the page lists no server, and a
  save, switch or delete there fails with a message the App shows under the
  form: the servers are not used for Claude threads unless the adapter runs
  with `CLAUDE_CODEX_APP_MCP_SERVERS=1`, and a server can also go into Claude
  Code's own MCP config. Servers saved earlier stay saved, unused.
- The debug log hides the values in config writes that can hold credentials.
  For `config/value/write`, `config/batchWrite` and the `config` of a request
  such as `thread/start`, it keeps every key name and the shape of each value
  but replaces the values of an MCP server's `env`, `headers`,
  `http_headers`, `env_http_headers` and `args` (where a `--header` token
  goes), of a provider's `query_params`, and of any key named like a token,
  secret, password, API key, auth setting, cookie or credential (such as
  `bearer_token_env_var`). Of a `url` it keeps only the scheme and host: the
  user, password, path (where a per-user server URL keeps its secret), query
  and fragment are replaced. Other values, such as a server's `command`, are
  still logged.
- Writing a debug log line no longer creates the log's folder and reads the
  file's size each time; the adapter logs every streaming notification, so
  this was a mkdir and two stats on every delta. The folder is made once (and
  again if it is removed), and the size is re-read at most once a second, so
  rotation at `CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES` still notices lines other
  adapter processes append.
- The debug log records sizes, counts and ids instead of the text of
  `turn/steer`, `turn/diff/updated`, `item/fileChange/patchUpdated`,
  `process/writeStdin`, `command/exec/write`, `fs/writeFile`,
  `thread/inject_items` and every streamed delta, so diffs, written files,
  terminal input and steer text no longer reach `debug.jsonl`. (#210)
- `debug.jsonl` and its rotated copies are created readable by their owner
  alone (0600), like `runs.jsonl`. The log got the umask's mode, usually
  0644, so only its folder kept other local accounts from the commands, tool
  input and stderr in it. When the adapter starts writing to the log, it also
  tightens a log or rotated copy an earlier version left readable, if that is
  a regular file the adapter owns: a symbolic link and its target, a device
  such as `/dev/stderr` and another user's file keep their mode.
  `CLAUDE_CODEX_DEBUG_LOG_KEEP` is capped at 100. (#332)
- Settings a Claude thread cannot honor are refused with `INVALID_REQUEST`
  instead of being saved and ignored, so the App shows "Couldn't update this
  setting": `model_verbosity`, a service tier other than the default, network
  access off and the other workspace sandbox fields, `instructions`,
  `developer_instructions` and `compact_prompt`. Writing the value Claude
  already has, or clearing a key, still succeeds. `config/read` keeps
  reporting `sandbox_workspace_write` unset, so Settings shows network access
  off although Claude threads always have it: the App takes the default
  permissions for its Default permissions preset only while that table is
  unset (or has network access off), and would otherwise preselect Custom
  (config.toml) in new chats.
- **Behavior change:** a `thread/start` that names no approval policy or
  sandbox, or only a permissions profile the adapter does not know, gets the
  defaults `config/read` reports (`on-request` with `workspace-write` unless
  Settings saved others) and asks before tools run, as a Codex thread does.
  It used to get `never` with full access, so a client that left the fields
  out ran every tool without asking. A thread kept without a policy, which
  asks too, is now reported as `on-request` instead of `never`.
- `web_search = "disabled"` saved in the App's settings takes WebSearch from
  Claude threads, including the summary `/compact` writes in a session of its
  own; `cached`, `indexed` and `live` keep it.
- **Behavior change:** `CLAUDE_CODEX_WEBSEARCH=0` now takes Claude Code's
  WebSearch tool away from Claude threads too, while the App's settings saved
  no web search mode. Before, it only made `config/read` report
  `web_search = "disabled"` (and capabilities no web search), so Settings
  showed web search off while Claude could still search. A mode saved in
  Settings wins, and `modelProvider/capabilities/read` now follows it.
- Web search off holds on the `claude-p` backend too. It now passes the tools
  a thread must not have to `claude-p` as `--disallowedTools`, the way the
  SDK route does, and no longer pre-approves one of them: a read-only thread
  used to get `--allowedTools` with WebSearch in it whatever the setting
  said. The same flag carries the Claude Code deny rules the adapter bridges
  and the MCP tools the config disables, which `claude-p` turns did not get
  before.
  The `agent-http` and `agentapi` backends run Claude outside the adapter, so
  Claude keeps WebSearch there whatever the setting says.
- A `config/batchWrite` is all or nothing: one refused edit leaves the
  settings as they were. Keys earlier versions saved but never honored are
  dropped from the adapter's settings when it starts.
- The App's `/` popup lists every command Claude Code reports for a folder,
  not only its built-in skills: the user's and the project's
  `.claude/commands`, plugin commands and skills (`plugin:name`) and MCP
  prompts. Picking one runs it as `/name args`. The list is kept per folder
  from the last chat session there (`supportedCommands()` when a turn starts,
  then each `commands_changed`), so a folder shows them after its first
  Claude turn; `skills/changed` makes the App refetch it. Names the App uses
  itself (every command id it registers, including `/pin`, `/archive`,
  `/read-aloud` and the hotkey-window and ChatGPT-chat ones), names that are
  not one slash-command word and rows that share a
  name with one of Claude Code's own commands are left out, and a skill read
  from `.claude/skills` keeps its own entry. Each folder gets its own
  `SKILL.md` per command, so a `/deploy` in two projects no longer shows the
  description of whichever reported last; the files of commands a folder no
  longer reports, and of folders no longer kept, are removed.
- A message that runs a Claude Code command (`/name args`, typed or picked)
  runs it also when the App sends context with it. Claude Code runs a
  command only from the last text block of a message, so that block is now
  the text as typed. Everything else goes in blocks before it, so Claude
  still reads it and the command's arguments leave it out: the items the App
  injected, a side chat's instructions, the `SKILL.md` of a skill picked with
  the command, the App's `additionalContext` and images. Before, any of
  these made the message a plain prompt or ended up in the arguments. A file
  mentioned with the command stays in its arguments as `@path`. A command
  sent while a turn runs is not folded into it: Claude Code runs it once the
  current answer ends, and the turn stays open until it is done. A name with
  a dot, such as `/release.notes` from a file `release.notes.md`, counts as
  a command too, as the `/` popup lists it.
  This is on the default Agent SDK backend. The `claude-p`, `agent-http` and
  `agentapi` backends get a message as one flat text, now with that context
  ahead of the command, so there a command sent with context does not run:
  Claude reads the text as a plain message. Before, context other than
  injected items followed the command into its arguments. A message with no
  context still goes as typed. Codex chats on the `codex-proxy` route get the
  same flat text and have no Claude Code commands.

### Provider and multi-agent boundaries

- Follow-up turns of a Codex (`gpt-*`) chat on the `codex-proxy` route run
  in the thread's folder with its sandbox mode and extra writable roots
  (`CLAUDE_CODEX_ADD_DIRS`) again. `codex exec resume` was run without `-C`,
  `-s` and `--add-dir`, so from the second turn on Codex worked in the
  adapter's own folder, dropped the extra roots and, in `read-only` and
  `workspace-write` chats, used the sandbox of the user's Codex config.
- A Codex chat on the `codex-proxy` route shows a failed, declined or
  non-zero-exit command as failed, with its exit code when Codex reports one,
  names the file a file change edits, and shows an MCP call's text result or
  error instead of nothing. The adapter used to read fields
  `codex exec --json` does not emit. (#234)
- The token meter and goal budgets of a Codex chat no longer count cached
  input tokens twice: `codex exec` includes them in its input count, so the
  adapter now reports the input without them and the cached tokens apart,
  and reports reasoning tokens as part of the output. (#237)
- An `agent-http` chat handles every event of an SSE chunk that carries
  several, in order. It used to append each later event's data to the
  first, so a warning showed as a generic error and streamed text waited for
  the next event. (#211)
- `/workflows` runs turn workflows on with the CLI's `CLAUDE_CODE_WORKFLOWS`
  switch instead of `--settings`, which pinned launchers reject, and respect a
  user's `enableWorkflows: false`.
- Added the provider and multi-agent loop boundaries RFC to separate runtime
  backends, provider metadata, agent-loop fidelity, credential ownership, and
  subscription/entitlement boundaries.
- Added static provider/agent-loop descriptors with validation for allowed and
  unsupported credential source labels.
- Added sanitized provider-loop projection helpers and exposed the read-only
  `config.provider_loop_config` field through `config/read`.
- Added explicit provider/agent-loop selection for known descriptor ids and loop
  ids. Selection maps only to existing runtime backends, preserves legacy
  runtime environment overrides and `CLAUDE_CODEX_MOCK=1` precedence, filters
  raw saved selection keys from public `config/read`, and exposes sanitized
  selection metadata through `config.provider_loop_config.selection`.
- Added tests proving built-in descriptors validate cleanly, unsupported
  credential labels are not projected as allowed, and secret-like descriptor
  text is redacted from public projection results.
- Background subagents (`run_in_background` Agent calls) keep running across
  turns, as Codex App 26.930 shows them: the Claude session stays open while
  they run, a finished agent's report wakes the parent with a new turn,
  `SendMessage` resumes an agent, and the child's Stop button ends it.
- Subagents behave the way the Codex App draws them: the parent's own tools
  beside an Agent call keep their cards, interrupts stop workflows and single
  children as Codex does, `SendMessage` / `TaskStop` map to agent calls, the
  CLI 2.1.283 hand-back report and usage trailer are parsed, and a finishing
  child no longer clears its still-running siblings from the roster.
- A subagent's spawn card and thread show the effort Claude Code 2.1.292+
  runs it at when the Agent call sets one (`max` shows as `xhigh`, the top of
  the App's scale). A fork subagent, on by default in Agent SDK sessions since
  Claude Code 2.1.302, shows its parent's model and effort, since Claude
  ignores the Agent call's `model` and `effort` for it. Claude Code reads
  `CLAUDE_CODE_FORK_SUBAGENT` from the adapter's environment, so `0` there
  turns forks off; a model process profile passes it on only when its
  `inheritEnv` names it or its `env` sets it.
- An agent another agent launches hangs off that agent's child thread, one
  level deeper, with its spawn and wait cards in that agent's conversation,
  when Claude Code names the agent behind each frame (`agent_id`, newer
  Claude Code versions); without the ids every agent still hangs off the
  parent thread. An agent `SendMessage` resumes keeps its child
  thread, and the agents it launches hang off it. Task frames still arriving
  from the run a resume replaced (`run_id`) are dropped instead of being
  counted against the new run.
- Opt-in leader tools: with `CLAUDE_CODEX_LEADER_TOOLS=1`, Claude in a chat
  the user started gets a `codex_leader` MCP server whose `thread_start`,
  `thread_list`, `thread_wait`, `thread_prompt` and `thread_read` tools
  start other Claude chats, which the Codex App adds to the sidebar, and
  wait for, message and read them. A started chat shows as a card when
  Claude repeats the `::created-thread{threadId="…"}` line the tool returns.
  Started chats take the leader's cwd and model by default and its approval
  policy, sandbox and permissions, never anything more permissive (a leader
  without a policy starts chats that ask); they, forks, subagents and
  ephemeral chats get no leader tools. A leader runs at most
  `CLAUDE_CODEX_LEADER_MAX_RUNNING` (default 4) chats at once, never answers
  their approvals or questions (such a chat shows as blocked), starts none
  while new chats run on the Codex proxy, and in plan mode only lists, waits
  and reads. Which chat leads which survives restarts. Without the switch
  nothing changes.
- Opt-in session changes: with `CLAUDE_CODEX_SESSION_CHANGES=1`, Claude in a
  chat gets a read-only `codex_session` MCP tool, `changes`, that gives the
  files the chat changed with Edit, Write and NotebookEdit, its subagents'
  included, as a unified diff read from its Claude Code transcripts, so
  `/simplify`, `/review` and other reviews work outside a git repository.
  Outside one the system prompt says to call it. It follows the thread's
  history, so a rolled-back turn no longer counts, and narrows to `paths`,
  the last `turns` or a `stat` list. Changes made by shell commands are not
  shown. Without the switch nothing changes.
- The `changes` tool compares a CRLF file as LF, as Claude Code records its
  edits, so a one-line edit shows as one changed line instead of the whole
  file, and a file edited back drops out of the list. (#216)
- The `changes` tool diffs only the changed part of each file, with the same
  output, about three times faster on a large file with a small edit. (#194)
- Deleting a thread ends its running background agents first, so each child
  turn completes as interrupted; stopping a turn no longer wakes the thread to
  acknowledge the background agents Claude Code stopped with it; and
  `/workflows` lists the workflows Claude ran on its own.
- Archiving a chat stops what still runs in it, as in Codex: its running turn
  and background agents end as interrupted and its Claude session closes, so
  an archived chat no longer spends tokens or edits files. The subagent
  threads it spawned are archived with it and come back when it is
  unarchived; its forks stay as they are.
- A turn that ends while its background agents or workflows still run no
  longer marks the chat unread in the Codex App or sends a desktop
  notification; the turn the work reports back in does. Background Bash shells
  do not count, since a dev server or watcher can run for the rest of the chat.
  `CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0` marks every finished turn unread
  again.
- The subagent watchdog (`CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS`, default 30
  minutes, now documented) waits for inactivity instead of a fixed deadline:
  a subagent's output and tool heartbeats, task progress and workflow agents
  starting or finishing all start it over. It used to fail every workflow
  that ran past 30 minutes, however busy, and interrupt the whole Claude
  session, which ended every workflow agent and unrelated background agent
  with it. When it does give up, the turn is stopped as an interrupt would
  stop it, which keeps background work earlier turns left running; while
  background agents the turn itself handed off still run, only its own stuck
  agents and workflows stop and those agents keep going.
- An interrupt while a session idles no longer leaves its earlier idle timer
  running, which could close the session (and its background agents) on the
  old deadline although they kept reporting progress.
- A thread stays on the runtime backend that holds its conversation. Once
  it has one, `turn/start`, `thread/settings/update` and
  `thread/metadata/update` refuse a model of the other backend (a Codex
  model in a Claude chat, or the reverse) with "cannot change runtime
  backend …; start a new thread" before changing anything, and the App's
  model menu shows "Couldn't update model settings". They used to hand a
  `gpt-*` id to the Claude CLI or move the chat to Codex without its
  history. A Codex thread keeps any model while the Codex proxy carries
  every thread, a thread with no conversation yet still takes its model's
  backend, and a structured (`outputSchema`) turn, such as the App's title
  and summary turns, runs its model for that turn alone instead of
  rewriting the thread's model. With `CLAUDE_CODEX_DISABLE_CODEX_PROXY=1`,
  unless the Codex proxy carries every thread, `thread/start` and a first
  turn refuse a Codex model outside the App's helper threads.
- Opt-in model process profiles: `CLAUDE_CODEX_MODEL_PROFILES_FILE` (or the
  same JSON inline in `CLAUDE_CODEX_MODEL_PROFILES`) lists the Claude models
  of the picker, each running its turns in its own Claude Code process with
  its own executable, a provider environment built from an allowlist of
  inherited variables, a private env file and `${VAR}` references, and its
  own `CLAUDE_CONFIG_DIR`, so transcripts never mix between providers. The
  adapter's own provider settings and credentials never reach a profile
  process. The profiles file must belong to the user and be neither a
  symlink nor writable by group or others, an env file must also be mode
  0600, and a secret-like key may only reference a variable. A chat with a
  conversation stays on its profile: another profile is refused, and a chat
  whose profile changed or is gone still opens but refuses turns, forks,
  compaction, review and model changes with "… cannot continue; start a new
  chat"; a queued message or goal reports that and does not run. Profiles
  replace `CLAUDE_CODEX_MODELS` and `CLAUDE_CODEX_MODEL_ALIASES` and need
  the native runtime. Without a profiles file nothing changes.
- `ANTHROPIC_CUSTOM_HEADERS` counts as a secret in model process profiles,
  like a key whose name contains `TOKEN`, `KEY`, `SECRET`, `PASSWORD` or
  `AUTH`. In a profile's `env` it must be a single `${VAR}` reference, and
  its value is a placeholder in the profile fingerprint, so rotating a
  gateway header credential keeps chats going. A profiles file with a
  literal value there no longer loads (move the value to the 0600 env file
  or a `${VAR}`). A chat that already had a conversation on a profile
  setting it, before this change, needs a new chat once after updating.
- A model process profile's env file takes comments after a value: outside
  quotes a `#` after a space or tab starts one, so `http://host/#frag` keeps
  its `#`; a quoted value ends at its closing quote and may be followed only
  by spaces or a comment; and an unterminated quote or other trailing text
  fails with the file and line, never the value. A `${VAR}` in a comment is
  no longer read. A profile whose env file had such comments on a non-secret
  key gets a new fingerprint, so its chats need a new chat once. (#215)
- Resuming a Claude session copies its transcript only into the config dir
  that turn's Claude Code runs from (a model profile's, else
  `CLAUDE_CONFIG_DIR` or `~/.claude`, or with `CLAUDE_CODEX_CLI` the
  router's dir for the model), from the newest copy found. It used to copy
  the whole conversation into every config dir it knew of and never
  refreshed a copy already there, so switching back to a model resumed a
  stale copy without the turns taken on another. A copy that is identical,
  newer or longer stays as it is; a new copy keeps the source's file mode
  and is a clone where the file system supports it.
- Subagent threads are named when they start, after the Agent call's
  `description` or a workflow agent's label, else the agent's type and the
  first line of its prompt, and keep the name in `thread/read`,
  `thread/list` and after a restart. The Codex App used to run a title turn
  for every subagent, which named workflow agents after the workflow's
  relayed user request; a workflow agent's prompt is now the task the
  workflow computed for it. Names and failure reasons are one line of plain
  text, without control characters, terminal escapes or bidirectional
  overrides.
- A subagent that fails says why: its thread's turn fails with the reason
  Claude Code gave instead of "subagent failed", the agent's state on the
  parent's wait carries the reason, and a parent turn that fails after its
  subagents failed says how many did and why the first did, keeping its
  error code. A background agent that fails tells the reason its task
  notification gives (a stall, an API error), not the last thing it said.
  Stopped, interrupted and orphaned subagents say how they ended and do not
  count as failed. Stopping a foreground subagent whose Agent call returned
  before Claude Code confirmed the stop no longer ends its thread twice.
- A foreground subagent's API retries show as **Reconnecting n/m** in the
  subagent's thread while it runs, instead of not at all, and never in the
  parent. Claude Code reports them as the Agent call's `tool_progress` with
  `subagent_retry` (and none for a background agent).
- A subagent's thread shows the subagent's own work, not just its prompt and
  answer: its messages, thinking, and tool calls with their results, as the
  same command, file change, MCP, web search and image items the parent's
  calls make, with its todo list as the thread's plan. With the Agent SDK
  backend the adapter asks Claude Code for the subagent's text and thinking
  (`forwardSubagentText`) and routes each frame by its agent id, so a nested
  agent's work lands in its own thread, and its cards land in the launching
  agent's thread after what that agent said before the call. What an agent
  says after launching one is a message of its own, also when the launched
  agent hangs off the parent thread (a CLI without agent ids) or starts
  between turns, so its answer shows once. The items are stored with the child
  turn (`thread/read`, `thread/turns/list`, `thread/items/list`, resume,
  followers), keep the parent's output caps (other long text of a call is
  cut the same way, a diff at a line within 30,000 bytes), stop at 256 per
  child turn or once a child turn's items come to 2 MiB (the answer is
  always kept whole), and a call still open when the child turn ends shows
  as failed, whichever way it ends: the subagent stops or fails, either
  thread is interrupted (also when the agent's task cannot be stopped), or
  the adapter stops or restarts. An image being read when the adapter dies
  is the exception: it shows as the image, as it does in the parent's own
  turns. The parent thread is unchanged. `CLAUDE_CODEX_SUBAGENT_ITEMS=0`
  keeps the previous prompt-and-answer view.
- Deleting a subagent's thread while the agent runs no longer fails the
  parent's turn with "FOREIGN KEY constraint failed" when the agent ends, or
  stops the adapter's shutdown halfway; the agent's end leaves nothing in
  the deleted thread.
- A client that resumes a thread now follows all of its subagents and their
  subagents. It used to follow only the first 50 children of each thread,
  so a workflow with more agents left the rest without live updates there.
  Finding a thread's subagents and the newest-first thread list use indexes
  instead of reading every thread: with 20,000 threads a list page takes
  about 1 ms instead of 25 ms.

### Workflow queue CLI

- `npm run workflow` runs from a path with spaces or other characters a
  `file://` URL escapes, and through a symlink. It used to do nothing and
  exit 0. (#242)
- `workflow enqueue` refuses a `--priority` that is not a whole number and a
  `--max-attempts` below 1 or not a whole number before writing anything. It
  used to save a queue that every later command refused to read. (#273)
- `workflow schedule` fails a task whose lease expired on its final attempt,
  with a lease-expiry `lastError`, instead of leaving it `running` forever
  with `health` stalled, and saves that even when there is nothing to claim.
  (#289)
- Re-ingesting a GitHub export no longer resets tasks already in the queue:
  done, running, blocked and failed tasks keep their status, attempts, lease
  and prompt. Only new ids are inserted, the others are listed under
  `existing`, and `enqueue --id` still replaces a task on purpose. (#277)
- An ordinary issue gets one task id whether it comes from a
  `gh issue list` export or a GitHub REST export (github.com, GHE.com or
  GitHub Enterprise Server), so importing both no longer queues it twice; an
  issue saved under either id is reported in `existing`. (#291)
- `workflow ingest-github` skips merged pull requests and gives `gh pr list`
  entries the same task id and priority as REST exports. A pull request
  queued before gets a new `github-pull-request-N-*` id on its next ingest.
  (#272)
- An option value that starts with `--`, such as `--prompt "--dry-run
  first"` or an `--error` holding a diff, is refused with a hint to write
  `--name=value`, which keeps it as given. It used to be saved as `true`, as
  was a value option given last without a value. (#333)

### Rust-first protocol groundwork

- Added the Rust-first runtime boundaries RFC, keeping the TypeScript
  app-server adapter as the shipping runtime path while defining incremental
  Rust protocol, transport, store, and launcher boundaries.
- Added an experimental Rust workspace scaffold and protocol crate with
  representative Codex app-server JSON fixtures.
- Added Rust parse/reserialize tests for the covered fixtures.
- Added a pinned fixture drift check against the configured Codex CLI version
  and made it part of CI alongside `cargo test --workspace`.
- Extended fixture coverage to include config projection data without claiming a
  Rust production runtime, transport, store, or provider execution path.

### Release readiness and compliance docs

- Added open-source compliance documentation and release-readiness reference
  material for maintainers and reviewers.
- Clarified the README and documentation homepage around the TypeScript
  production path, Rust-first experimental boundaries, provider/agent-loop
  descriptor and selection boundaries, supported credential ownership models,
  unsupported subscription/session/private endpoint/bypass behavior, and release
  verification expectations.
- Documented provider selection configuration for `CLAUDE_CODEX_PROVIDER`,
  `CLAUDE_CODEX_AGENT_LOOP`, saved provider-loop config keys, precedence rules,
  and sanitized `config.provider_loop_config.selection` projection.
- Documented the current shippable baseline: TypeScript remains the production
  path; Rust pieces are opt-in protocol boundary work; provider/loop descriptors
  are read-only metadata, not runtime dispatch.
- Documented supported credential ownership models: local user-provided API
  keys, official cloud-provider credential chains, organization-managed
  gateways, and local CLI auth for same-host user-directed execution.
- Documented unsupported credential models, including personal subscription
  sharing, browser cookie/session-token reuse, private provider endpoints,
  bypass guidance, and credential redistribution.
- The README, the docs site and `package.json` point at the repository's new
  home, github.com/nwverse/claude-codex, and its documentation at
  nwverse.github.io/claude-codex. (#112)
- The configuration guide documents the debug log, the `agent-http`,
  `agentapi` and `claude-p` settings, `CLAUDE_CODEX_EFFORT` and
  `CLAUDE_CODEX_SUBAGENT_COMPLETED`; the validation reference covers the
  capability probe, the runtime matrix and the fixture checks; and the
  `src/` and `scripts/` AGENTS.md maps list every module.
  (#116, #121, #136, #140)
- The configuration reference lists the adapter home (`CLAUDE_CODEX_HOME`),
  `CLAUDE_CODEX_PERMISSION_MODE`, `CLAUDE_CODEX_CLI`, `CLAUDE_CODEX_RUN_LOG`,
  `CLAUDE_CODEX_SESSION_CHANGES` and the summary model, the backends guide
  the shim's and `claude-codex-mode`'s own variables, and the worktree docs
  say that `CLAUDE_CODEX_AUTO_WORKTREE=1` turns isolation on. (#304)
- The capability matrix no longer says `CLAUDE_CODEX_ALLOWED_TOOLS` restricts
  Claude's tools: the listed tools are pre-approved and run without an
  approval card, and a Claude Code deny rule is what takes a tool away. The
  `src/` AGENTS.md map lists the modules added since, such as the native
  Codex harness and the shared process-group and JSON-file helpers, and the
  root AGENTS.md points to the configuration reference table for the full
  list of variables. (#338)

### Validation and release gates

- Default CI runs Biome checks, TypeScript typechecking, the VitePress docs
  build, the Node test suite, Rust workspace tests, and the pinned Rust protocol
  fixture drift gate.
- The docs build no longer ignores dead links, so a link to a page that does not
  exist fails CI.
- `npm test` passes in a developer's or Claude Code's shell as it does on CI,
  and leaves that shell's adapter and Claude state alone. It preloads
  `dist/test/support/hermetic-env.mjs` into every suite, and the suites that
  start adapters or run adapter code in-process import it too, for a direct
  `node --test` run. No suite, and no adapter a suite starts, gets the
  shell's `ANTHROPIC_*`, `CLAUDE*` or `CODEX_*` variables. Before, only the
  `adapter-*` suites dropped them, and from a shell or chat that exports
  `CLAUDE_CODEX_HOME` (as `claude-codex-isolated` does) the others wrote
  dozens of mock threads, debug and run logs, and an
  `approval_policy = never`, `danger-full-access` default into that live
  adapter home. No suite writes to `~/.codex` either: a session store for a
  database elsewhere no longer creates the adapter home, a thread's git
  lookup that outlives its server no longer logs, and an MCP test no longer
  reads `~/.codex/config.toml`. The relative `CLAUDE_CODEX_SOCKET_PATH` test
  passes in a checkout deeper than about 84 bytes, and the
  `app-server daemon version` test runs on macOS instead of skipping under
  its long temp folder (#330). `CLAUDE_CODE_WORKFLOWS=1`, `umask 077` and a
  global `commit.gpgsign = true` no longer fail tests. Daemon and fixture
  tests allow for a busy machine, `npm run build` clears `dist/test` so a
  deleted suite stops running, and a hung test fails after 2 minutes instead
  of holding `npm test` (the CI job that runs it stops after 20 minutes).
- The mock adapter suites, once one `adapter.test.mts`, run as parallel
  `adapter-*` suites, and tests that failed on a busy machine or with the
  long macOS temp folder pass there (#130, #193, #213, #214). Biome is 2.6,
  which also checks the `AGENTS.md` files, and TypeScript's
  `noUnusedLocals` is on (#68, #126).
- Credentialed smoke and acceptance checks remain opt-in and must use
  credentials already owned by the local user or organization on the host.
- `npm run check:app-upgrade -- --app <bundle>` checks a new Codex App build
  against `scripts/app-baseline.json`: the protocol its bundled `codex`
  generates, the feature gates on at the reported version and whether every
  method behind them has a handler, and the clientInfo names. The App
  behaviors the adapter relies on are App rules in `src/app-compat.mts`, tagged
  in the code and kept in sync by `test/app-compat.test.mts`; an App build not
  yet checked gets a config warning. See `docs/reference/app-compat.md`.
- `npm run doctor` checks the runtime the shim will run: it reads the
  `runtime.env` that `claude-codex-mode set` writes, accepts `codex-proxy`
  (and checks for the real `codex` CLI), and reports an unknown runtime type
  as a failed check instead of crashing. It finds the adapter, shim and
  `node_modules` from its own checkout whatever the working directory, checks
  that the built adapter answers a startup probe, and names spawn errors such
  as `ENOENT` instead of `exited null`. It reads quoted values, trailing
  comments and a leading `~` in `runtime.env` as the shell does, fails the
  runtime type check when a line it cannot evaluate sets the runtime, lists
  the other lines it skipped, and says whether the type came from the file,
  the environment or the default. It looks for the real `codex` as the shim
  does for the native route and as the adapter does for `codex-proxy`.

### Still experimental or not yet included

- No Rust production runtime, transport, store, provider execution path, or
  default-on Rust launcher is included.
- No executable new provider loop is included beyond the existing runtime
  backends.
- No broad runtime dispatch rewrite is included.
- No new credential collection model is included.
- No support is included for personal subscription sharing, credential pooling,
  browser cookie/session-token reuse, private provider endpoints, or provider
  bypass behavior.
- The App's worktree tools (its `threadAttachments` gate) on a local host,
  where the App names them for its bundled `codex_app` MCP server instead of
  sending them as `dynamicTools`, and MCP tool-call progress are not
  included. Hook runs are shown live but not kept in history.
