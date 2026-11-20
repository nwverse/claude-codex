# Workflow Operations

This page is the operator runbook for the local workflow control plane used by
recurring Codex maintenance loops. The workflow is deliberately explicit: tasks
are queued in a local state file, leased by a worker, verified, and then marked
complete.

The default state file is `workflow-state.json` in the adapter home
(`CLAUDE_CODEX_HOME`, else `claude-codex-adapter` under `CODEX_HOME`, which
defaults to `~/.codex`; see the
[configuration reference](/guide/configuration#reference-table)):

```text
~/.codex/claude-codex-adapter/workflow-state.json
```

Every command takes `--state PATH` to name another state file, `health` also
takes `--run-log PATH` for the run registry, and each command prints the
`statePath` it used. Check `statePath` when the daemon runs with a different
`CODEX_HOME` or `CLAUDE_CODEX_HOME` than the shell you run the CLI from.

Queue writers serialize changes with SQLite's writer lock in
`<statePath>.lock.sqlite` beside the JSON file. Keep this sidecar in place
while workers are active. The operating system releases the lock if a worker
exits. `status` and `health` read the JSON directly.

## Core loop

Start each heartbeat by reading the state through the CLI:

```bash
npm run workflow -- status
npm run workflow -- health
```

If `health.status` is `healthy` and a task is running with an active lease,
continue that task. Renew the lease only when the worker needs more time:

```bash
npm run workflow -- heartbeat --task task-id --worker codex-heartbeat
```

If no task is running and there is one clear safe task, queue exactly one task
and claim it:

```bash
npm run workflow -- enqueue --id task-id --prompt "Do one concrete task"
npm run workflow -- schedule --worker codex-heartbeat
```

Finish by running the matching verification commands, then mark the task
complete:

```bash
npm run workflow -- complete --task task-id
```

Use `fail` for a task that should retry or fail closed. Use `block` when the
worker cannot proceed without user input or an external state change:

```bash
npm run workflow -- fail --task task-id --error "Verification failed"
npm run workflow -- block --task task-id --reason "Needs a missing credential"
```

A value that starts with `--`, such as a diff or a CLI error line, needs the
`--name=value` form (`--error="--- a/x ..."`); given as a separate argument it
is refused, so it is never read as another option.

## Health signals

`npm run workflow -- health` reports:

| Field | Meaning |
| --- | --- |
| `counts` | Number of queued, running, blocked, done, and failed tasks. |
| `runningTaskIds` | Tasks currently holding leases. |
| `staleLeaseTaskIds` | Running tasks whose lease expired; `schedule` reclaims them, or fails them on their final attempt. |
| `nextLeaseExpiresAt` | The next active lease expiry time, or `null`. |
| `runRegistryLagMs` | Time since the run registry was last updated, when available. |

A safe heartbeat has no stale leases, no failed tasks, and no duplicate queued
work. `schedule` reclaims a stale lease. If that lease was the task's final
attempt (`attempts >= maxAttempts`), `schedule` marks the task `failed` with a
lease-expiry `lastError` instead, and a late `complete` or `fail` from that
worker is rejected. An active lease should not be stolen.

## Run registry

Run events are appended to `runs.jsonl` in the adapter home, by default:

```text
~/.codex/claude-codex-adapter/runs.jsonl
```

The registry redacts prompt-like fields, model responses, and secret-like
values before writing. Set `CLAUDE_CODEX_RUN_LOG=0` to disable the registry, or
set `CLAUDE_CODEX_RUN_LOG=/path/to/runs.jsonl` to choose another JSONL file.

The registry is for operational evidence, not transcript storage. Do not depend
on it for raw prompt, response, credential, or user-secret recovery.

## Worktree isolation

Per-thread git worktrees are off by default. Set `CLAUDE_CODEX_AUTO_WORKTREE=1`
in the adapter's environment to turn them on; `CLAUDE_CODEX_WORKTREE_ROOT` only
chooses where they go (default `worktrees` in the adapter home). Setting the
root alone does not enable isolation. Each newly started or forked thread whose
cwd is inside a git repository gets a worktree on a new `claude-codex/<label>`
branch created from that repository's `HEAD`. Each thread id is mapped to a
root-confined, collision-resistant label. If the worktree already exists, it is
reused. If setup fails, the adapter logs the failure and keeps the original cwd
so the app-server session can continue. See
[Worktree isolation](/guide/configuration#worktree-isolation) in the
configuration guide.

This feature isolates concurrent coding agents when it is enabled, without
making worktree creation a hard dependency for normal Codex App operation.

## GitHub trust boundary

GitHub issue and pull request text is external input. Do not wire GitHub issue,
PR, review, or comment bodies directly into execution.

Instead, export trusted metadata to local JSON and ingest it:

```bash
gh issue list --json number,title,state,url > /tmp/github-issues.json
npm run workflow -- ingest-github --github-json /tmp/github-issues.json
```

The ingestion command creates explicit workflow tasks from trusted metadata
only: item number, title, state, URL, and item kind. Body text, comments,
reviews, and other external instructions are intentionally omitted from the
generated task prompt.

Ingestion inserts each stable task ID only once. IDs already in the queue,
including repeated entries in one export, are reported in `existing` and keep
their saved status, attempts, lease, prompt, settings, errors, and blocked reason.
`enqueued` and `taskIds` describe only newly inserted tasks. Use explicit
`enqueue --id` to intentionally replace a task instead.
A `gh issue list` export and a GitHub REST export of the same ordinary issue
(github.com, GHE.com or GitHub Enterprise Server) share one task ID, so a task
saved under either ID is reported in `existing`.

Before changing code for a GitHub-sourced task, inspect external text through
the project trust-boundary workflow and keep the execution step explicit in the
local queue.

## Verification checklist

For code changes, run the focused check for the changed surface and then the
default suite:

```bash
npm run typecheck
npm test
```

For docs-only changes, run:

```bash
npm run docs:build
```

When the task changes navigation, links, or shared README examples, include the
docs build even if no TypeScript source changed.
