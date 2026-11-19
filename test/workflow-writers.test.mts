import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runWorkflowCli } from '../src/workflow-cli.mjs'
import type { WorkflowState } from '../src/workflow-state.mjs'

const cli = new URL('../src/workflow-cli.mjs', import.meta.url)
const stateModule = new URL('../src/workflow-state.mjs', import.meta.url)
const exec = promisify(execFile)

async function stateFor(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-writers-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'state.json')
}

async function run(path: string, ...args: string[]) {
  const { stdout, stderr } = await exec(
    process.execPath,
    [fileURLToPath(cli), ...args, '--state', path],
    { timeout: 10000 },
  )
  assert.equal(stderr, '')
  return JSON.parse(stdout)
}

// Hold the first real CLI process immediately after it reads its snapshot.
// A second process must contend for the writer lock at this point, before any
// decision or JSON replacement is made.
async function afterFirstRead(t: TestContext, path: string, ...args: string[]) {
  const source = `
    import { once } from 'node:events'
    import { runWorkflowCli } from ${JSON.stringify(cli.href)}
    import { WorkflowStateStore } from ${JSON.stringify(stateModule.href)}
    const read = WorkflowStateStore.prototype.read
    WorkflowStateStore.prototype.read = async function () {
      const snapshot = await read.call(this)
      const released = once(process, 'message')
      process.send('read')
      await released
      return snapshot
    }
    await runWorkflowCli(process.argv.slice(1))
  `
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source, ...args, '--state', path],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  assert.ok(child.stdout && child.stderr)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  })
  const ready = await Promise.race([
    once(child, 'message'),
    closed.then(([code]) => {
      throw new Error(`writer exited before its read (${code}): ${stderr}`)
    }),
  ])
  assert.equal(ready[0], 'read')
  const probe = new DatabaseSync(`${path}.lock.sqlite`, { timeout: 0 })
  try {
    assert.throws(() => probe.exec('BEGIN IMMEDIATE'), { errcode: 5 })
  } finally {
    probe.close()
  }
  return {
    kill: async () => {
      child.kill('SIGKILL')
      await closed
    },
    finish: async () => {
      child.send('release')
      const [code] = await closed
      assert.equal(code, 0, stderr)
      return JSON.parse(stdout)
    },
  }
}

test('two workflow schedulers return a single claim for the same task', {
  timeout: 15000,
}, async (t) => {
  const path = await stateFor(t)
  await run(path, 'enqueue', '--id', 'one', '--prompt', 'test')
  const first = await afterFirstRead(t, path, 'schedule', '--worker', 'a')
  const second = run(path, 'schedule', '--worker', 'b')
  const [a, b] = await Promise.all([first.finish(), second])
  assert.equal(a.type, 'claimed')
  assert.equal(b.type, 'idle')
  const { state } = await run(path, 'status')
  assert.equal(state.tasks[0].lease.workerId, 'a')
  assert.equal(state.tasks[0].attempts, 1)
})

test('competing workflow enqueues preserve both tasks and a killed writer releases its lock', {
  timeout: 15000,
}, async (t) => {
  const path = await stateFor(t)
  const first = await afterFirstRead(t, path, 'enqueue', '--id', 'a', '--prompt', 'first')
  const second = run(path, 'enqueue', '--id', 'b', '--prompt', 'second')
  await Promise.all([first.finish(), second])
  const interrupted = await afterFirstRead(
    t,
    path,
    'enqueue',
    '--id',
    'discard',
    '--prompt',
    'unfinished',
  )
  await interrupted.kill()
  await run(path, 'enqueue', '--id', 'c', '--prompt', 'after recovery')
  const state = JSON.parse(await readFile(path, 'utf8')) as WorkflowState
  assert.deepEqual(
    state.tasks.map((task) => task.id),
    ['a', 'b', 'c'],
  )
})

test('a waiting scheduler starts its lease clock after obtaining the lock', {
  timeout: 10000,
}, async (t) => {
  const path = await stateFor(t)
  await run(path, 'enqueue', '--id', 'one', '--prompt', 'test')
  const lock = new DatabaseSync(`${path}.lock.sqlite`)
  lock.exec('BEGIN IMMEDIATE')
  let output = ''
  const waiting = runWorkflowCli(['schedule', '--state', path, '--worker', 'later'], {
    stdout: {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
    stderr: {
      write: (chunk) => {
        throw new Error(String(chunk))
      },
    },
  })
  let released: number
  try {
    // A pending writer in this process must leave the event loop free for
    // the holder to finish its own I/O and release the reservation.
    await delay(60)
    released = Date.now()
  } finally {
    lock.close()
  }
  assert.equal(await waiting, 0)
  assert.ok(Date.parse(JSON.parse(output).task.lease.renewedAt) >= released)
})
