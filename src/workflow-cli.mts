#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseGitHubQueueJson } from './github-queue.mjs'
import { runRegistryPath } from './run-registry.mjs'
import { adapterHome, newId } from './util.mjs'
import { workflowHealth } from './workflow-health.mjs'
import {
  blockWorkflowTask,
  completeWorkflowTask,
  enqueueWorkflowTask,
  failWorkflowTask,
  renewWorkflowLease,
  scheduleNextWorkflowTask,
} from './workflow-scheduler.mjs'
import { type WorkflowState, WorkflowStateStore, type WorkflowTask } from './workflow-state.mjs'

export interface WorkflowCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>
}

export async function runWorkflowCli(
  args: readonly string[] = process.argv.slice(2),
  io: WorkflowCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const command = args[0] ?? 'status'
  const parsed = parseArgs(args.slice(1))
  if (command === 'help' || command === '--help' || command === '-h' || hasFlag(parsed, 'help')) {
    writeHelp(io.stdout)
    return 0
  }
  if (parsed.error) throw new WorkflowCliInputError(parsed.error)
  const store = new WorkflowStateStore(statePath(parsed))
  const clock = () => new Date(stringOption(parsed, 'now') ?? Date.now())
  const updateTask = (edit: (state: WorkflowState, now: Date) => WorkflowState) =>
    store.transact((state) => ({ state: edit(state, clock()), value: null }))

  switch (command) {
    case 'enqueue': {
      const task = await store.transact((state) => {
        const enqueued = taskFromArgs(parsed, clock())
        return { state: enqueueWorkflowTask(state, enqueued), value: enqueued }
      })
      writeJson(io.stdout, { status: 'enqueued', statePath: store.path, task })
      return 0
    }
    case 'schedule': {
      const decision = await store.transact((state) => {
        const next = scheduleNextWorkflowTask(state, {
          now: clock(),
          workerId: stringOption(parsed, 'worker') ?? `worker-${process.pid}`,
          leaseTtlMs: numberOption(parsed, 'ttl-ms') ?? 30 * 60 * 1000,
        })
        return { state: next.state, value: next }
      })
      writeJson(io.stdout, { ...decision, statePath: store.path })
      return 0
    }
    case 'heartbeat': {
      const taskId = requiredOption(parsed, 'task')
      await updateTask((state, now) =>
        renewWorkflowLease(state, taskId, {
          now,
          workerId: requiredOption(parsed, 'worker'),
          leaseTtlMs: numberOption(parsed, 'ttl-ms') ?? 30 * 60 * 1000,
        }),
      )
      writeJson(io.stdout, { status: 'heartbeat', statePath: store.path, taskId })
      return 0
    }
    case 'complete': {
      const taskId = requiredOption(parsed, 'task')
      await updateTask((state, now) => completeWorkflowTask(state, taskId, now))
      writeJson(io.stdout, { status: 'completed', statePath: store.path, taskId })
      return 0
    }
    case 'fail': {
      const taskId = requiredOption(parsed, 'task')
      await updateTask((state, now) =>
        failWorkflowTask(state, taskId, requiredOption(parsed, 'error'), now),
      )
      writeJson(io.stdout, { status: 'failed-or-requeued', statePath: store.path, taskId })
      return 0
    }
    case 'block': {
      const taskId = requiredOption(parsed, 'task')
      await updateTask((state, now) =>
        blockWorkflowTask(state, taskId, requiredOption(parsed, 'reason'), now),
      )
      writeJson(io.stdout, { status: 'blocked', statePath: store.path, taskId })
      return 0
    }
    case 'status': {
      const state = await store.readOrEmpty()
      writeJson(io.stdout, { status: 'ok', statePath: store.path, state })
      return 0
    }
    case 'health': {
      const state = await store.readOrEmpty()
      const runLog = stringOption(parsed, 'run-log') ?? runRegistryPath()
      const runLogUpdatedAt = runLog ? await fileUpdatedAt(runLog) : null
      writeJson(io.stdout, {
        status: 'ok',
        statePath: store.path,
        runLog,
        health: workflowHealth({ state, now: clock(), runLogUpdatedAt }),
      })
      return 0
    }
    case 'ingest-github': {
      const source = requiredOption(parsed, 'github-json')
      const text = await readFile(source, 'utf8')
      const result = await store.transact((state) => {
        const ingested = parseGitHubQueueJson(
          text,
          clock(),
          state.tasks.map((task) => task.id),
        )
        const knownTaskIds = new Set(state.tasks.map((task) => task.id))
        const existing = [...ingested.existing]
        const newTasks = ingested.tasks.filter((task) => {
          if (knownTaskIds.has(task.id)) {
            existing.push(task.id)
            return false
          }
          knownTaskIds.add(task.id)
          return true
        })
        // A duplicate-only import leaves the saved state file untouched.
        return {
          state:
            newTasks.length > 0 || existing.length === 0
              ? { ...state, tasks: [...state.tasks, ...newTasks] }
              : null,
          value: {
            enqueued: newTasks.length,
            existing,
            skipped: ingested.skipped,
            taskIds: newTasks.map((task) => task.id),
          },
        }
      })
      writeJson(io.stdout, { status: 'ingested', statePath: store.path, source, ...result })
      return 0
    }
    default:
      io.stderr.write(`unknown workflow command: ${command}\n`)
      writeHelp(io.stderr)
      return 1
  }
}

function taskFromArgs(args: ParsedArgs, now: Date): WorkflowTask {
  const prompt = requiredOption(args, 'prompt')
  const priority = numberOption(args, 'priority') ?? 0
  const maxAttempts = numberOption(args, 'max-attempts') ?? 3
  if (!Number.isInteger(priority)) {
    throw new WorkflowCliInputError('--priority must be an integer')
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new WorkflowCliInputError('--max-attempts must be a positive integer')
  }
  return {
    id: stringOption(args, 'id') ?? newId(),
    status: 'queued',
    updatedAt: now.toISOString(),
    prompt,
    priority,
    attempts: 0,
    maxAttempts,
    lease: null,
    blockedReason: null,
    lastError: null,
  }
}

interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>
  // Why the first value option given without a value is refused; thrown only
  // after --help is handled.
  readonly error: string | null
}

// Options that always take a value. A value that starts with `--` is refused
// rather than read as the next option or saved as `true`; `--name=value`
// passes one (a prompt such as `--dry-run first`, an error that is a diff).
const VALUE_OPTIONS = new Set([
  'state',
  'now',
  'id',
  'prompt',
  'priority',
  'max-attempts',
  'worker',
  'ttl-ms',
  'task',
  'error',
  'reason',
  'run-log',
  'github-json',
])

function parseArgs(args: readonly string[]): ParsedArgs {
  const values = new Map<string, string>()
  let error: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? ''
    if (!raw.startsWith('--')) continue
    const inline = raw.indexOf('=')
    if (inline >= 0) {
      values.set(raw.slice(2, inline), raw.slice(inline + 1))
      continue
    }
    const name = raw.slice(2)
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next)
      index += 1
    } else if (VALUE_OPTIONS.has(name)) {
      error ??=
        next === undefined
          ? `--${name} needs a value`
          : `--${name} needs a value; to pass one that starts with "--", write --${name}=VALUE`
    } else {
      values.set(name, 'true')
    }
  }
  return { values, error }
}

function statePath(args: ParsedArgs): string {
  return resolve(stringOption(args, 'state') ?? join(adapterHome(), 'workflow-state.json'))
}

function requiredOption(args: ParsedArgs, name: string): string {
  const value = stringOption(args, name)
  if (value) return value
  throw new WorkflowCliInputError(`missing required --${name}`)
}

function stringOption(args: ParsedArgs, name: string): string | null {
  const value = args.values.get(name)
  return value?.trim() ? value : null
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.values.get(name) === 'true'
}

function numberOption(args: ParsedArgs, name: string): number | null {
  const value = stringOption(args, name)
  if (!value) return null
  const parsed = Number(value)
  if (Number.isFinite(parsed)) return parsed
  throw new WorkflowCliInputError(`--${name} must be a number`)
}

function writeJson(output: Pick<NodeJS.WriteStream, 'write'>, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`)
}

function writeHelp(output: Pick<NodeJS.WriteStream, 'write'>): void {
  output.write(`Usage:
  workflow status [--state PATH]
  workflow enqueue --prompt TEXT [--id ID] [--priority N] [--max-attempts N] [--state PATH]
  workflow schedule [--worker ID] [--ttl-ms N] [--state PATH]
  workflow heartbeat --task ID --worker ID [--ttl-ms N] [--state PATH]
  workflow health [--state PATH] [--run-log PATH]
  workflow ingest-github --github-json PATH [--state PATH]
  workflow complete --task ID [--state PATH]
  workflow fail --task ID --error TEXT [--state PATH]
  workflow block --task ID --reason TEXT [--state PATH]

A value that starts with "--" needs the --name=VALUE form.
`)
}

class WorkflowCliInputError extends Error {
  override readonly name = 'WorkflowCliInputError'
}

async function fileUpdatedAt(path: string): Promise<Date | null> {
  try {
    return (await stat(path)).mtime
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    // Imports from eval or other hosts may have an argv[1] that is not a file.
    return false
  }
}

if (isMainModule()) {
  runWorkflowCli().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(
        `[claude-codex-workflow] ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    },
  )
}
