import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NativeClaudeRuntime, sdkResumeSessionId } from '../src/native-runtime.mjs'
import { projectSlugs } from '../src/util.mjs'
import { type InProcessApp, withInProcessApp } from './fixtures/in-process-app.mjs'

async function fixture(from = 'old', to = 'new') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cc-relocate-')))
  const origin = join(base, from)
  const cwd = join(base, to)
  const config = join(base, 'profile')
  const id = randomUUID()
  const projects = join(config, 'projects')
  const oldDir = join(projects, projectSlugs(origin)[0] as string)
  const newDir = join(projects, projectSlugs(cwd)[0] as string)
  const file = (dir: string) => join(dir, `${id}.jsonl`)
  const original =
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: origin,
      message: { content: 'original marker' },
    }) + '\n'
  await mkdir(origin)
  await mkdir(oldDir, { recursive: true, mode: 0o700 })
  await writeFile(file(oldDir), original, { mode: 0o600 })
  await rename(origin, cwd)
  return {
    base,
    origin,
    cwd,
    config,
    id,
    oldDir,
    newDir,
    file,
    original,
    resume: () => sdkResumeSessionId(id, cwd, config, 'same-model', origin),
  }
}

test('a moved workspace resumes its recorded Claude conversation in an independent copy', async () => {
  const f = await fixture()
  try {
    assert.equal(f.resume(), f.id)
    assert.equal(f.resume(), f.id)
    assert.equal(await readFile(f.file(f.newDir), 'utf8'), f.original)
    assert.notEqual((await stat(f.file(f.oldDir))).ino, (await stat(f.file(f.newDir))).ino)
    await appendFile(f.file(f.newDir), 'another turn\n')
    assert.equal(await readFile(f.file(f.oldDir), 'utf8'), f.original)
    assert.throws(f.resume, /different transcript/)
  } finally {
    await rm(f.base, { recursive: true, force: true })
  }
})

test('a rename that keeps the transcript directory resumes the transcript where it is', async () => {
  for (const from of ['my_project', 'my project', 'my.project']) {
    const f = await fixture(from, 'my-project')
    try {
      assert.equal(f.oldDir, f.newDir)
      assert.equal(f.resume(), f.id)
      assert.deepEqual(await readdir(f.newDir), [`${f.id}.jsonl`])
      assert.equal(await readFile(f.file(f.newDir), 'utf8'), f.original)
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  }
})

test('a moved workspace whose transcript is gone starts a new session', async () => {
  const f = await fixture()
  try {
    await rm(f.file(f.oldDir))
    assert.equal(f.resume(), null)
    assert.equal(await stat(f.newDir).catch(() => null), null)
    await rm(join(f.config, 'projects'), { recursive: true })
    assert.equal(f.resume(), null)
  } finally {
    await rm(f.base, { recursive: true, force: true })
  }
})

test('relocation stays in the bound configuration and refuses unrelated or ambiguous copies', async () => {
  const f = await fixture()
  try {
    // Neither the profile's configuration nor the recorded workspace has the
    // transcript: nothing is copied in, and the turn starts a new session.
    const foreign = join(f.base, 'foreign')
    await mkdir(join(foreign, 'projects'), { recursive: true, mode: 0o700 })
    assert.equal(sdkResumeSessionId(f.id, f.cwd, foreign, 'same-model', f.origin), null)
    assert.deepEqual(await readdir(join(foreign, 'projects')), [])
    const otherWorkspace = join(f.base, 'unrelated')
    assert.equal(sdkResumeSessionId(f.id, f.cwd, f.config, 'same-model', otherWorkspace), null)
    assert.equal(await stat(f.file(f.newDir)).catch(() => null), null)
    await mkdir(f.newDir, { mode: 0o700 })
    await writeFile(f.file(f.newDir), f.original + 'different\n', { mode: 0o600 })
    assert.throws(f.resume, /different transcript/)
    assert.equal(await readFile(f.file(f.oldDir), 'utf8'), f.original)
    assert.equal(await readFile(f.file(f.newDir), 'utf8'), f.original + 'different\n')
  } finally {
    await rm(f.base, { recursive: true, force: true })
  }
})

test('relocation refuses a mismatched session identity and linked or writable transcript sources', async () => {
  const f = await fixture()
  try {
    await writeFile(f.file(f.oldDir), JSON.stringify({ type: 'user', sessionId: randomUUID() }))
    assert.throws(f.resume, /different session ID/)
    if (process.platform !== 'win32') {
      await writeFile(f.file(f.oldDir), f.original)
      await chmod(f.file(f.oldDir), 0o666)
      assert.throws(f.resume, /not a trusted/)
      await rm(f.file(f.oldDir))
      const unrelated = join(f.base, 'unrelated.jsonl')
      await writeFile(unrelated, f.original, { mode: 0o600 })
      await symlink(unrelated, f.file(f.oldDir))
      assert.throws(f.resume)
      assert.equal(await readFile(unrelated, 'utf8'), f.original)
      await rm(f.file(f.oldDir))
      await writeFile(f.file(f.oldDir), f.original, { mode: 0o600 })
      await mkdir(f.newDir, { mode: 0o700 })
      await link(f.file(f.oldDir), f.file(f.newDir))
      assert.throws(f.resume, /single-link|different transcript/)
      await rm(f.file(f.oldDir))
      await link(f.file(f.newDir), join(f.base, 'another-copy'))
      assert.throws(f.resume, /single-link/)
      assert.equal(await readFile(f.file(f.newDir), 'utf8'), f.original)
    }
  } finally {
    await rm(f.base, { recursive: true, force: true })
  }
})

const LOST_SESSION = '0b5c3a52-6a7e-4d0c-9a49-3f0e6a1b2c3d'
const MISSING_NOTICE = /could not find this chat's earlier conversation/

// Claude Code as the SDK starts it for each turn: the options it was given,
// and the frames it answers with, or the error it fails with before its
// session starts.
function claudeCode(launches: Array<Record<string, unknown>>, runs: Array<string | Error>) {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: async function* ({ options }: { options: Record<string, unknown> }) {
      launches.push(options)
      const run = runs.shift()
      if (run instanceof Error || run === undefined) throw run ?? new Error('no run scripted')
      yield { type: 'system', subtype: 'init', session_id: run }
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: run,
        message: {
          id: `${run}-reply`,
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi.' }],
        },
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Hi.', session_id: run }
    },
  })
  return runtime
}

async function withLostSession(
  runs: Array<string | Error>,
  body: (
    app: InProcessApp,
    threadId: string,
    launches: Array<Record<string, unknown>>,
  ) => Promise<void>,
) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cc-missing-')))
  const cwd = join(base, 'workspace')
  const config = join(base, 'claude')
  await mkdir(cwd)
  await mkdir(join(config, 'projects'), { recursive: true, mode: 0o700 })
  const launches: Array<Record<string, unknown>> = []
  try {
    await withInProcessApp(
      claudeCode(launches, runs),
      async (app) => {
        const threadId = await app.startThread({ cwd })
        // A session whose transcript Claude Code has since deleted.
        app.store.updateClaudeSessionId(threadId, LOST_SESSION, cwd)
        await body(app, threadId, launches)
      },
      { env: { CLAUDE_CONFIG_DIR: config } },
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('a thread whose Claude transcript is gone continues in a new session and says so', async () => {
  const fresh = randomUUID()
  await withLostSession([fresh], async (app, threadId, launches) => {
    const turn = await app.turnCompleted(await app.startTurn(threadId, 'hello again'))
    assert.equal(turn.status, 'completed')
    assert.equal(launches.length, 1)
    assert.equal(launches[0]?.resume, undefined)
    assert.equal(app.store.getThread(threadId)?.claudeSessionId, fresh)
    const notices = app.notified('warning').filter((notice) => MISSING_NOTICE.test(notice.message))
    assert.equal(notices.length, 1)
    assert.equal(notices[0]?.threadId, threadId)
  })
})

test('a lost Claude session is forgotten even when its new session fails to start', async () => {
  const fresh = randomUUID()
  await withLostSession([new Error('Claude Code exited early'), fresh], async (app, threadId) => {
    const failed = await app.turnCompleted(await app.startTurn(threadId, 'hello again'))
    assert.equal(failed.status, 'failed')
    assert.equal(app.store.getThread(threadId)?.claudeSessionId, null)
    const next = await app.turnCompleted(await app.startTurn(threadId, 'and again'))
    assert.equal(next.status, 'completed')
    assert.equal(app.store.getThread(threadId)?.claudeSessionId, fresh)
    // The user heard once that the earlier context is gone.
    const notices = app.notified('warning').filter((notice) => MISSING_NOTICE.test(notice.message))
    assert.equal(notices.length, 1)
  })
})
