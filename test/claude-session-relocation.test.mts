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
import { dirname, join } from 'node:path'
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

test('relocation stays in the bound configuration and never overwrites a different destination', async () => {
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

test('relocation refuses a recorded workspace with more than one transcript', {
  skip: process.platform === 'win32',
}, async () => {
  const f = await fixture()
  try {
    // The workspace was recorded through a link to its parent: its old
    // transcript may be under either name, and here it is under both.
    await symlink(f.base, join(f.base, 'link'))
    const linked = join(f.base, 'link', 'old')
    const other = join(f.config, 'projects', projectSlugs(linked)[0] as string)
    await mkdir(other, { mode: 0o700 })
    await writeFile(f.file(other), f.original, { mode: 0o600 })
    assert.throws(() => sdkResumeSessionId(f.id, f.cwd, f.config, 'same-model', linked), /found 2/)
    assert.equal(await stat(f.newDir).catch(() => null), null)
  } finally {
    await rm(f.base, { recursive: true, force: true })
  }
})

test('a transcript that is only out of reach is not taken for gone', async () => {
  const f = await fixture('workspace', 'workspace')
  const resume = (config = f.config) => sdkResumeSessionId(f.id, f.cwd, config, 'same-model', f.cwd)
  try {
    assert.equal(resume(), f.id)
    // A config folder on a volume that is not mounted: its parent is gone.
    assert.throws(
      () => resume(join(f.base, 'volume', 'profile')),
      /transcript could not be read \(.*volume: ENOENT\)/,
    )
    if (process.platform !== 'win32') {
      // A link to a folder that is not there now, for the config folder or
      // for its projects.
      await rename(f.config, join(f.base, 'real'))
      await symlink(join(f.base, 'volume', 'profile'), f.config)
      assert.throws(resume, /transcript could not be read .*ENOENT/)
      await rm(f.config)
      await rename(join(f.base, 'real'), f.config)
      await rename(join(f.config, 'projects'), join(f.base, 'projects'))
      await symlink(join(f.base, 'volume', 'projects'), join(f.config, 'projects'))
      assert.throws(resume, /transcript could not be read .*ENOENT/)
      await rm(join(f.config, 'projects'))
      await rename(join(f.base, 'projects'), join(f.config, 'projects'))
    }
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await chmod(f.newDir, 0o000)
      assert.throws(resume, /transcript could not be read .*EACCES/)
      await chmod(f.newDir, 0o700)
    }
    assert.equal(resume(), f.id)
  } finally {
    await chmod(f.newDir, 0o700).catch(() => {})
    await rm(f.base, { recursive: true, force: true })
  }
})

test('a deleted config folder, or an unreadable one the CLI does not use, leaves a gone transcript gone', async () => {
  const f = await fixture('workspace', 'workspace')
  const saved = [process.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIRS]
  const routers = join(f.base, 'routers')
  try {
    // Without a profile, the CLI runs from CLAUDE_CONFIG_DIR; a router
    // folder it does not run from cannot be read.
    process.env.CLAUDE_CONFIG_DIR = f.config
    process.env.CLAUDE_CONFIG_DIRS = routers
    await mkdir(join(routers, 'locked'), { recursive: true })
    if (process.platform !== 'win32') await chmod(join(routers, 'locked'), 0o000)
    assert.equal(sdkResumeSessionId(randomUUID(), f.cwd, undefined, null), null)
    assert.equal(sdkResumeSessionId(f.id, f.cwd, undefined, null), f.id)
    // The CLI creates its config folder again.
    await rm(f.config, { recursive: true })
    assert.equal(sdkResumeSessionId(f.id, f.cwd, f.config, 'same-model', f.cwd), null)
    assert.equal(sdkResumeSessionId(f.id, f.cwd, undefined, null), null)
  } finally {
    for (const [key, value] of [
      ['CLAUDE_CONFIG_DIR', saved[0]],
      ['CLAUDE_CONFIG_DIRS', saved[1]],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await chmod(join(routers, 'locked'), 0o700).catch(() => {})
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

const MISSING_NOTICE = /earlier Claude conversation of this chat could not be found/

// Claude Code as the SDK starts it for each turn: the options it was given,
// and the session it answers in, whose transcript it writes as the CLI does,
// or the error it fails with before any session starts.
function claudeCode(launches: Array<Record<string, unknown>>, runs: Array<string | Error>) {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: async function* ({ options }: { options: Record<string, unknown> }) {
      launches.push(options)
      const run = runs.shift()
      if (run instanceof Error || run === undefined) throw run ?? new Error('no run scripted')
      const config = (options.env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR as string
      await writeTranscript(config, options.cwd as string, run)
      yield { type: 'system', subtype: 'init', session_id: run }
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: run,
        uuid: randomUUID(),
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

async function writeTranscript(config: string, cwd: string, sessionId: string) {
  const dir = join(config, 'projects', projectSlugs(cwd)[0] as string)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const record = { type: 'user', sessionId, message: { role: 'user', content: 'hi' } }
  await writeFile(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

interface ClaudeChat {
  threadId: string
  sessionId: string
  config: string
  launches: Array<Record<string, unknown>>
}

// A Claude chat bound to a session, whose transcript is in the Claude config
// folder or, with `transcript` false, gone.
async function withClaudeChat(
  transcript: boolean,
  runs: Array<string | Error>,
  body: (app: InProcessApp, chat: ClaudeChat) => Promise<void>,
) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cc-session-')))
  const cwd = join(base, 'workspace')
  const config = join(base, 'volume', 'claude')
  const sessionId = randomUUID()
  await mkdir(cwd)
  await mkdir(join(config, 'projects'), { recursive: true, mode: 0o700 })
  if (transcript) await writeTranscript(config, cwd, sessionId)
  const launches: Array<Record<string, unknown>> = []
  try {
    await withInProcessApp(
      claudeCode(launches, runs),
      async (app) => {
        const threadId = await app.startThread({ cwd })
        app.store.updateClaudeSessionId(threadId, sessionId, cwd)
        await body(app, { threadId, sessionId, config, launches })
      },
      { env: { CLAUDE_CONFIG_DIR: config } },
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

function missingNotices(app: InProcessApp) {
  return app.notified('warning').filter((notice) => MISSING_NOTICE.test(notice.message))
}

test('a thread whose Claude transcript is gone continues in a new session and says so', async () => {
  const fresh = randomUUID()
  await withClaudeChat(false, [fresh], async (app, { threadId, launches }) => {
    const turn = await app.turnCompleted(await app.startTurn(threadId, 'hello again'))
    assert.equal(turn.status, 'completed')
    assert.equal(launches.length, 1)
    assert.equal(launches[0]?.resume, undefined)
    assert.equal(app.store.getThread(threadId)?.claudeSessionId, fresh)
    const notices = missingNotices(app)
    assert.equal(notices.length, 1)
    assert.equal(notices[0]?.threadId, threadId)
  })
})

test('a chat keeps its Claude session until a new session has started', async () => {
  const fresh = randomUUID()
  const runs = [new Error('Claude Code exited early'), fresh]
  await withClaudeChat(false, runs, async (app, { threadId, sessionId, launches }) => {
    const failed = await app.turnCompleted(await app.startTurn(threadId, 'hello again'))
    assert.equal(failed.status, 'failed')
    assert.equal(app.store.getThread(threadId)?.claudeSessionId, sessionId)
    // No new session started, so the turn does not say one did.
    assert.equal(missingNotices(app).length, 0)
    const next = await app.turnCompleted(await app.startTurn(threadId, 'and again'))
    assert.equal(next.status, 'completed')
    assert.deepEqual(
      launches.map((options) => options.resume),
      [undefined, undefined],
    )
    assert.equal(app.store.getThread(threadId)?.claudeSessionId, fresh)
    assert.equal(missingNotices(app).length, 1)
  })
})

test('a chat whose Claude config folder was deleted continues in a new session and says so', async () => {
  const fresh = randomUUID()
  await withClaudeChat(true, [fresh], async (app, { threadId, config, launches }) => {
    await rm(config, { recursive: true })
    const turn = await app.turnCompleted(await app.startTurn(threadId, 'hello again'))
    assert.equal(turn.status, 'completed')
    assert.equal(launches[0]?.resume, undefined)
    assert.equal(app.store.getThread(threadId)?.claudeSessionId, fresh)
    assert.equal(missingNotices(app).length, 1)
  })
})

test('a chat whose Claude config folder is out of reach fails the turn and keeps its session', async () => {
  const fresh = randomUUID()
  await withClaudeChat(true, [fresh], async (app, { threadId, sessionId, config, launches }) => {
    // The volume the folder is on is not mounted.
    const volume = dirname(config)
    await rename(volume, `${volume}.away`)
    const failed = await app.turnCompleted(await app.startTurn(threadId, 'hello'))
    assert.equal(failed.status, 'failed')
    assert.match(failed.error.message, /transcript could not be read/)
    assert.equal(launches.length, 0)
    assert.equal(app.store.getThread(threadId)?.claudeSessionId, sessionId)
    await rename(`${volume}.away`, volume)
    const resumed = await app.turnCompleted(await app.startTurn(threadId, 'again'))
    assert.equal(resumed.status, 'completed')
    assert.equal(launches[0]?.resume, sessionId)
    assert.equal(missingNotices(app).length, 0)
  })
})

test('a fork whose first turn failed before Claude started still forks its parent session', async () => {
  const forked = randomUUID()
  const runs = [new Error('Claude Code exited early'), forked, forked]
  await withClaudeChat(true, runs, async (app, { threadId, sessionId, launches }) => {
    const fork = (await app.request('thread/fork', { threadId })).thread.id
    assert.equal(app.store.getThread(fork)?.claudeSessionId, sessionId)
    for (const text of ['one', 'two', 'three'])
      await app.turnCompleted(await app.startTurn(fork, text))
    assert.deepEqual(
      launches.map((options) => [options.resume, options.forkSession === true]),
      [
        [sessionId, true],
        // Its parent's session is never resumed as the fork's own.
        [sessionId, true],
        [forked, false],
      ],
    )
    assert.equal(app.store.getThread(threadId)?.claudeSessionId, sessionId)
  })
})
