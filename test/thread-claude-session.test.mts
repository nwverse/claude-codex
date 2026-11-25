import './support/hermetic-env.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sdkSessionTranscript } from '../src/claude-config-roots.mjs'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { type InProcessApp, withInProcessApp } from './fixtures/in-process-app.mjs'

// Thread.claudeSession names the Claude Code session behind a Claude thread,
// so a client that also reads Claude Code transcripts can match the two.

const PROFILES_ENV = ['CLAUDE_CODEX_MODEL_PROFILES', 'CLAUDE_CODEX_MODEL_PROFILES_FILE'] as const

// Two model process profiles, each with its own config dir under `root`, and
// any `more`.
async function withProfiles(
  root: string,
  body: () => Promise<void>,
  more: Record<string, unknown>[] = [],
): Promise<void> {
  const saved = PROFILES_ENV.map((key) => [key, process.env[key]] as const)
  delete process.env.CLAUDE_CODEX_MODEL_PROFILES_FILE
  process.env.CLAUDE_CODEX_MODEL_PROFILES = JSON.stringify({
    defaultModel: 'main-model',
    models: [
      {
        id: 'main-model',
        sdkModel: 'vendor/main-1',
        env: { CLAUDE_CONFIG_DIR: join(root, 'profiles', 'main') },
      },
      {
        id: 'second-model',
        sdkModel: 'vendor/second-1',
        env: { CLAUDE_CONFIG_DIR: join(root, 'profiles', 'second') },
      },
      ...more,
    ],
  })
  try {
    await body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function withTempRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-session-ref-'))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

// What Thread.claudeSession should be for the session the thread's record holds.
function storedSession(app: InProcessApp, threadId: string, configDir: string | null) {
  const thread = app.store.getThread(threadId)
  assert.ok(thread?.claudeSessionId, 'the turn stored a Claude session')
  return { id: thread.claudeSessionId, cwd: thread.claudeSessionCwd, configDir }
}

async function runTurn(app: InProcessApp, threadId: string, text: string): Promise<void> {
  const turnId = await app.startTurn(threadId, text)
  const turn = await app.turnCompleted(turnId)
  assert.equal(turn.status, 'completed')
}

async function readSession(app: InProcessApp, threadId: string): Promise<any> {
  return (await app.request('thread/read', { threadId })).thread.claudeSession
}

test('a Claude thread on a model process profile names its session and the profile config dir', {
  timeout: 20_000,
}, async () => {
  await withTempRoot((root) =>
    withProfiles(root, () =>
      withInProcessApp(new MockRuntime(), async (app) => {
        const started = await app.request('thread/start', {
          cwd: process.cwd(),
          model: 'second-model',
        })
        assert.equal(started.thread.claudeSession, null, 'no session before the first turn')
        const threadId = started.thread.id
        await runTurn(app, threadId, 'hello')

        const expected = storedSession(app, threadId, join(root, 'profiles', 'second'))
        assert.deepEqual(await readSession(app, threadId), expected)
        const listed = await app.request('thread/list', {})
        const row = listed.data.find((thread: any) => thread.id === threadId)
        assert.deepEqual(row?.claudeSession, expected)
        const resumed = await app.request('thread/resume', { threadId })
        assert.deepEqual(resumed.thread.claudeSession, expected)
      }),
    ),
  )
})

test('without profiles the session lives in the adapter config dir', {
  timeout: 20_000,
}, async () => {
  await withTempRoot(async (root) => {
    const configDir = join(root, 'claude-config')
    await withInProcessApp(
      new MockRuntime(),
      async (app) => {
        const threadId = await app.startThread()
        await runTurn(app, threadId, 'hello')
        assert.deepEqual(await readSession(app, threadId), storedSession(app, threadId, configDir))
      },
      { env: { CLAUDE_CONFIG_DIR: configDir } },
    )
  })
})

test('a fork names no session until a turn of its own writes one', {
  timeout: 20_000,
}, async () => {
  await withTempRoot(async (root) => {
    const configDir = join(root, 'claude-config')
    await withInProcessApp(
      new MockRuntime(),
      async (app) => {
        const parentId = await app.startThread()
        await runTurn(app, parentId, 'hello')
        const parentSession = await readSession(app, parentId)
        assert.ok(parentSession)

        const forked = await app.request('thread/fork', { threadId: parentId })
        const forkId = forked.thread.id
        // Until it runs a turn, the fork resumes from the parent's session:
        // that transcript is the parent's.
        assert.equal(app.store.getThread(forkId)?.claudeSessionId, parentSession.id)
        assert.equal(forked.thread.claudeSession, null)
        assert.equal(await readSession(app, forkId), null)

        await runTurn(app, forkId, 'and on the fork')
        const own = await readSession(app, forkId)
        assert.deepEqual(own, storedSession(app, forkId, configDir))
        assert.notEqual(own.id, parentSession.id)
      },
      { env: { CLAUDE_CONFIG_DIR: configDir } },
    )
  })
})

test('a Codex thread names no Claude session', { timeout: 20_000 }, async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const threadId = await app.startThread({ model: 'gpt-5.4-mini' })
    assert.equal(app.store.getThread(threadId)?.runtimeBackend, 'codex')
    await runTurn(app, threadId, 'hello')
    assert.equal(await readSession(app, threadId), null)
  })
})

test('a thread whose profile changed since it started names its session without a config dir', {
  timeout: 20_000,
}, async () => {
  await withTempRoot((root) =>
    withProfiles(root, () =>
      withInProcessApp(new MockRuntime(), async (app) => {
        const threadId = await app.startThread({ model: 'second-model' })
        await runTurn(app, threadId, 'hello')
        const thread = app.store.getThread(threadId)
        assert.ok(thread)
        // Pinned to a configuration no profile has any more.
        app.store.upsertThread({ ...thread, modelProfileFingerprint: 'f'.repeat(64) })
        assert.deepEqual(await readSession(app, threadId), storedSession(app, threadId, null))
      }),
    ),
  )
})

test('a relative profile config dir is taken against the folder the session runs in', {
  timeout: 20_000,
}, async () => {
  const relative = {
    id: 'relative-model',
    sdkModel: 'vendor/relative-1',
    env: { CLAUDE_CONFIG_DIR: 'relative-config' },
  }
  await withTempRoot((root) =>
    withProfiles(
      root,
      () =>
        withInProcessApp(new MockRuntime(), async (app) => {
          const threadId = await app.startThread({ model: 'relative-model', cwd: root })
          await runTurn(app, threadId, 'hello')
          const cwd = app.store.getThread(threadId)?.claudeSessionCwd
          assert.ok(cwd)
          const expected = storedSession(app, threadId, join(cwd, 'relative-config'))
          assert.deepEqual(await readSession(app, threadId), expected)
        }),
      [relative],
    ),
  )
})

test('the sessions of the HTTP bridges and claude-p name no Claude session', {
  timeout: 20_000,
}, async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const threadId = await app.startThread()
    await runTurn(app, threadId, 'hello')
    const thread = app.store.getThread(threadId)
    assert.ok(thread)
    for (const id of ['agent-http:abc', 'agentapi:abc', 'claude-p:abc']) {
      app.store.upsertThread({ ...thread, claudeSessionId: id })
      assert.equal(await readSession(app, threadId), null, id)
    }
  })
})

test('a router config dir is found once, not for every Thread', async () => {
  const keys = ['HOME', 'CLAUDE_CODEX_CLI', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS'] as const
  const saved = keys.map((key) => [key, process.env[key]] as const)
  await withTempRoot(async (root) => {
    // A model router runs each model from the dir named after it.
    process.env.HOME = root
    process.env.CLAUDE_CODEX_CLI = join(root, 'router')
    process.env.CLAUDE_CONFIG_DIR = join(root, 'own')
    process.env.CLAUDE_CONFIG_DIRS = join(root, 'routers')
    try {
      const routed = join(root, 'routers', 'sonnet')
      await mkdir(routed, { recursive: true })
      const session = {
        sessionId: 's-1',
        model: 'sonnet',
        modelProfileFingerprint: null,
        cwd: root,
      }
      assert.deepEqual(sdkSessionTranscript(session), { configDir: routed })
      // Reused, not looked up again: the folders are not listed for each Thread.
      await rm(routed, { recursive: true })
      assert.deepEqual(sdkSessionTranscript(session), { configDir: routed })
      // A model without a dir of its own runs from the adapter's.
      assert.deepEqual(sdkSessionTranscript({ ...session, model: 'haiku' }), {
        configDir: join(root, 'own'),
      })
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
