# Deployment

The Codex App connects through the SSH shim on a remote host
([Install the shim](#install-the-shim)). On a workstation shared with Orca or
native Codex app-server clients, a native Codex CLI can instead connect to an
isolated foreground listener.

## Alongside Orca and native Codex

After `npm install` and `npm run build`, run with Node.js 24+ from the checkout:

```bash
# Terminal 1: use your Claude Code login or credentials from your shell.
node dist/src/isolated-launch.mjs --state-dir "$PWD/.claude-codex/local" --port 8790
```

The separately named package bin, `claude-codex-isolated`, runs the same launcher
when installed. In a second terminal in the same checkout, use the native Codex
CLI to select this adapter explicitly:

```bash
CLAUDE_CODEX_REMOTE_TOKEN="$(cat "$PWD/.claude-codex/local/adapter/ws-token")" \
  codex --remote ws://127.0.0.1:8790 --remote-auth-token-env CLAUDE_CODEX_REMOTE_TOKEN
```

Use a CLI version whose `--help` includes `--remote` and
`--remote-auth-token-env`. If a global shim is already installed, invoke the
actual native executable by its absolute path. This recipe does not install a
file named `codex`, edit PATH or shell settings, or change Codex/Orca
configuration. Existing native `codex app-server`, ordinary CLI commands and
Orca structured chats continue to use their existing executable. It does not
convert an Orca chat to Claude; the selected CLI connects to Claude.

The launcher binds only `127.0.0.1`. Its default port is `0` (automatically
assigned); copy the printed `listening on ws://127.0.0.1:PORT` address into
`--remote`. `--port 8790` above makes both terminal commands concrete. Choose
another port if it is occupied. Parallel instances need different state
directories; automatic ports keep their listener addresses separate. A bind
conflict exits nonzero and leaves the existing listener intact. This entry
point never binds or removes a Unix control socket.

Within the chosen directory, the launcher sets a private Codex home in `codex/`
and adapter state in `adapter/` (database, recovery records, MCP files, logs and
the generated `ws-token`). These override inherited `CODEX_HOME`,
`CLAUDE_CODEX_HOME`, `CLAUDE_CODEX_SOCKET_PATH`, `CLAUDE_CODEX_DEBUG_LOG` and
`CLAUDE_CODEX_RUN_LOG` (a `0`/`false` log opt-out is kept) in the child only.
Native Codex configuration and auth are not copied into that home. Claude
credentials/configuration and the other adapter/runtime options still come from
the launcher's environment; the shim's runtime env file is not sourced.
Automatic shared HTTP bridge management is disabled, so this launcher never
invokes the global mode helper.

Capability-token auth is on by default, using the existing WebSocket auth
implementation. The generated token is private and reused with the state
directory. Existing WebSocket token-source environment variables and the
`--ws-*` options remain available; if you configure an external token source,
use that source in the client command instead. See
[WebSocket listener](/guide/configuration#websocket-listener).
`<state-dir>/adapter/ws-token` and the state database are private; keep the
state directory out of version control (`.claude-codex/` is already gitignored).

### Foreground lifecycle

Keep terminal 1 open while clients use the adapter. **Ctrl-C**, **SIGTERM**, or
**SIGHUP** to the printed launcher PID forwards the signal only to its adapter
child and waits for it to exit. Closing a CLI does not stop the foreground
listener. Stop and start the same command to restart this instance; its threads
and token persist. There is no background stop/restart command.

An exclusive `launcher.lock` prevents two launchers from recovering or writing
the same state concurrently. A crash or SIGKILL may leave it behind, and a
SIGKILL of the launcher may leave its child alive. The startup line prints both
PIDs. Confirm both processes have stopped before manually removing a stale
lock, or use a fresh state directory. The launcher never guesses ownership or
takes over an unverified lock.

The legacy `claude-codex-mode` helper changes shared host routing and its
switch/restart operations select app-server processes by command-line patterns,
including native servers. **Do not use it to manage isolated instances**; use
the foreground launcher PID instead.

## Install the shim

Install `scripts/codex-shim` as `codex` on the remote host:

```bash
mkdir -p ~/bin
cp scripts/codex-shim ~/bin/codex && chmod +x ~/bin/codex
```

Then have the login shell export the adapter pointers. Put these in `~/.zshenv`
so non-interactive SSH sees them too:

```bash
export PATH="$HOME/bin:$PATH"
export ANTHROPIC_API_KEY="<your-anthropic-api-key>" # or sign in with `claude /login`
export CLAUDE_CODEX_ADAPTER="/opt/claude-codex-adapter/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="/absolute/path/to/node" # optional
export CODEX_REAL="/usr/local/bin/codex.real"     # optional native-Codex fallback
```

Keep credentials in the host environment or a secret manager. Do not commit
real API keys, OAuth/session state, `.env` files, copied shell snippets with
resolved secrets, or private infrastructure URLs.

Codex App keeps using its native SSH flow: it probes `codex --version`, starts
`codex app-server --listen unix://`, then connects via `codex app-server proxy`.
The shim routes every first-argument `app-server` call that reaches it to the
adapter, regardless of the calling client, except the schema generators
(`codex app-server generate-ts` and `generate-json-schema`), which go to the
real codex. `CODEX_REAL` is the fallback for other commands; it does not
protect an Orca/native app-server invocation from this routing in adapter mode.
Prefer the isolated launcher above on a shared workstation. The SSH integration
remains available for dedicated remote hosts.

::: tip Custom Anthropic endpoints
If your organization uses a supported custom Anthropic endpoint, configure
`ANTHROPIC_BASE_URL` in the host environment. Treat the endpoint value as
deployment configuration and avoid committing private URLs.
:::

## Bootstrapping a fresh host (no sudo / Homebrew)

A clean machine usually needs only four user-space tools:

```bash
# 1. Node 24 (stable node:sqlite) — pick your platform tarball from nodejs.org/dist.
curl -fsSL https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.xz | tar -xJ -C ~/.local

# 2. Claude Code CLI under a user prefix.
mkdir -p ~/.local/npm-global
~/.local/node-v24.11.0-darwin-arm64/bin/npm config set prefix ~/.local/npm-global
~/.local/npm-global/bin/npm install -g @anthropic-ai/claude-code
~/.local/npm-global/bin/claude /login        # interactive: claude.ai OAuth

# 3. Adapter checkout + build.
git clone https://github.com/nwverse/claude-codex ~/claude-codex && cd ~/claude-codex
npm install && npm run build

# 4. Persist PATH + adapter pointers for non-interactive SSH.
cat >>~/.zshenv <<'EOF'
export PATH="$HOME/.local/npm-global/bin:$HOME/.local/node-v24.11.0-darwin-arm64/bin:$HOME/.local/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="$HOME/claude-codex/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="$HOME/.local/node-v24.11.0-darwin-arm64/bin/node"
EOF
cp scripts/codex-shim ~/.local/bin/codex && chmod +x ~/.local/bin/codex

npm run doctor       # all checks should be ok
npm run smoke:real   # round-trips a real Claude turn
```

Codex App's Remote connection then hits the shim first and is routed into the
adapter. Disconnecting reclaims the daemon so the adapter exits.

## Daemon lifecycle

The daemon owns the Unix socket while a client is connected. When the last
client disconnects it shuts down after an idle grace period (deferred if a turn
is still active; reconnecting during that window reattaches notifications). Tune
with `CLAUDE_CODEX_IDLE_EXIT_MS` (default `15000`; `0` keeps it running).

One daemon serves a socket. Its pid is in the `.pid` file next to the socket. A
second `app-server --listen unix://` for the same socket prints
`app-server already running at <socket> (pid N)` and exits 0 when the daemon
listens. If the daemon is still starting, the second one waits up to 10 seconds
for it to listen, then prints `app-server already starting` and exits 0. It starts in the
daemon's place when that process has exited, when the pid now belongs to a
process started after the file was written, or when the daemon has not
listened within 60 seconds of the file's date (10 seconds when `ps` cannot
report process start times). A socket that still answers is never removed. A
daemon that finds the socket taken when it binds exits 0 as well.

Several clients can follow one thread at once. A client follows the threads it
starts, resumes, forks or sends a turn to, until it disconnects or sends
`thread/unsubscribe`, which drops only that client; every follower gets the
thread's notifications. An approval or question goes to all of them, the first
answer wins, and the others get `serverRequest/resolved`; any connected client
may answer. A client that opens a thread while one of its turns is waiting on a
request, such as the App after a reconnect, gets the request too.

A chat another client starts, such as a phone relay or a script, reaches every
connected Codex App when its first turn starts: the App gets `thread/started`
with the first message as the preview (and the name the client gave the chat, if
any), follows the chat from then on, and gets the turn's notifications, the user
message included. It is announced once. An App that opted out of
`thread/started`, an ephemeral thread and a chat the App started itself are left
out. A chat the [leader tools](/guide/gui#leader-chats) start is announced on
the leader's connection, as before, and, when that connection is not the App's,
to the connected Apps too.

An App titles a chat announced without a name itself, with a title turn of its
own: one more model call for each such chat. A client that names the chat
(`thread/name/set`) before its first turn keeps the App from generating a title
for it.

A subagent thread is followed only while its agent runs, and a helper thread
(a title, a description or a summary) until its turn ends. Then it unloads, so
`thread/loaded/list` on a daemon that runs for weeks holds the chats clients
follow and the agents still running, not every agent a workflow ever ran. See
[Loaded threads](/reference/protocol-coverage) for the details.

## Quick remote probe

```bash
ssh host 'command -v codex'
ssh host 'codex --version'
```
