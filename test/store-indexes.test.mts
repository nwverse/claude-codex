import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord } from '../src/types.mjs'

function thread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    preview: id,
    name: null,
    archived: false,
    cwd: '/work',
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    claudeSessionId: null,
    source: 'appServer',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    status: { type: 'idle' },
    approvalPolicy: null,
    sandboxMode: null,
    ephemeral: false,
    threadSource: 'user',
    agentRole: null,
    agentNickname: null,
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
    runtimeBackend: 'claude',
    codexSessionId: null,
    ...overrides,
  }
}

async function withStore(body: (store: SessionStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-codex-store-indexes-'))
  const previousHome = process.env.CLAUDE_CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = directory
  try {
    await body(new SessionStore(join(directory, 'state.sqlite')))
  } finally {
    if (previousHome === undefined) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}

// The store keeps its handle private; the plan is what this suite checks.
function queryPlan(store: SessionStore, sql: string, ...args: Array<string | number>): string[] {
  const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => String((row as { detail: unknown }).detail))
}

test('the default thread list page and fork lookups use an index', async () => {
  await withStore((store) => {
    const page = queryPlan(
      store,
      `SELECT t.* FROM threads t WHERE t.archived = ? AND t.created_at < ? AND t.ephemeral = 0
       ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      0,
      Number.MAX_SAFE_INTEGER,
      50,
    )
    assert.ok(
      page.some((detail) => detail.includes('idx_threads_created')),
      page.join('\n'),
    )
    assert.ok(!page.some((detail) => detail.includes('TEMP B-TREE')), page.join('\n'))

    const children = queryPlan(
      store,
      `SELECT t.* FROM threads t WHERE t.archived = ? AND t.created_at > ? AND t.forked_from_id = ?
       ORDER BY t.created_at ASC, t.id ASC LIMIT ?`,
      0,
      -1,
      'root',
      50,
    )
    assert.ok(
      children.some((detail) => detail.includes('idx_threads_forked_from')),
      children.join('\n'),
    )
    assert.ok(!children.some((detail) => /^SCAN t\b/.test(detail)), children.join('\n'))

    // A project's list keeps narrowing by its own index first.
    const project = queryPlan(
      store,
      `SELECT t.* FROM threads t WHERE t.archived = ? AND t.created_at < ? AND t.project_id = ?
       ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      0,
      Number.MAX_SAFE_INTEGER,
      'project',
      50,
    )
    assert.ok(
      project.some((detail) => detail.includes('idx_threads_project')),
      project.join('\n'),
    )

    const walk = queryPlan(
      store,
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM threads WHERE forked_from_id = ? AND archived = 0
         UNION
         SELECT child.id FROM descendants parent CROSS JOIN threads child
           ON child.forked_from_id = parent.id WHERE child.archived = 0
       )
       SELECT t.id, t.ephemeral, t.thread_source,
              CASE WHEN json_valid(t.status_json)
                   THEN json_extract(t.status_json, '$.type') = 'active' ELSE 0 END AS active
         FROM descendants d CROSS JOIN threads t ON t.id = d.id
        WHERE d.id <> ?`,
      'root',
      'root',
    )
    assert.ok(!walk.some((detail) => /^SCAN (threads|child|t)\b/.test(detail)), walk.join('\n'))
    assert.equal(
      walk.filter((detail) => detail.includes('idx_threads_forked_from')).length,
      2,
      walk.join('\n'),
    )
    // Each thread the walk finds is read by its id.
    assert.ok(
      walk.some((detail) =>
        /^SEARCH t USING INDEX sqlite_autoindex_threads_1 \(id=\?\)/.test(detail),
      ),
      walk.join('\n'),
    )
  })
})

test('descendantThreads walks the whole unarchived fork tree without a page cap', async () => {
  await withStore((store) => {
    store.upsertThread(thread('root'))
    // More children than one listThreads page holds (50 by default).
    for (let index = 0; index < 75; index += 1) {
      store.upsertThread(
        thread(`child-${index}`, {
          forkedFromId: 'root',
          ephemeral: true,
          threadSource: 'subagent',
          createdAt: 1_700_000_000 + index,
          ...(index === 5 ? { status: { type: 'active', activeFlags: [] } } : {}),
        }),
      )
    }
    store.upsertThread(thread('grandchild', { forkedFromId: 'child-3', ephemeral: true }))
    store.upsertThread(thread('fork', { forkedFromId: 'root' }))
    // An archived child is skipped along with what hangs below it.
    store.upsertThread(thread('archived-child', { forkedFromId: 'root', archived: true }))
    store.upsertThread(thread('below-archived', { forkedFromId: 'archived-child' }))
    store.upsertThread(thread('unrelated'))

    const found = store.descendantThreads('root')
    const ids = found.map(({ id }) => id)
    assert.equal(ids.length, 77)
    assert.equal(new Set(ids).size, 77)
    assert.ok(ids.includes('child-74'))
    assert.ok(ids.includes('grandchild'))
    for (const absent of ['root', 'archived-child', 'below-archived', 'unrelated']) {
      assert.ok(!ids.includes(absent), absent)
    }
    // With what decides whether a client opening the root follows each one.
    const byId = new Map(found.map((descendant) => [descendant.id, descendant]))
    assert.deepEqual(byId.get('child-4'), {
      id: 'child-4',
      ephemeral: true,
      threadSource: 'subagent',
      active: false,
    })
    assert.equal(byId.get('child-5')?.active, true)
    assert.deepEqual(byId.get('fork'), {
      id: 'fork',
      ephemeral: false,
      threadSource: 'user',
      active: false,
    })
    assert.deepEqual(store.descendantThreads('unrelated'), [])

    // A status SQLite cannot parse counts as not active; the walk goes on.
    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.prepare(`UPDATE threads SET status_json = '{"type":' WHERE id = 'child-6'`).run()
    const again = store.descendantThreads('root')
    assert.equal(again.length, 77)
    assert.equal(again.find(({ id }) => id === 'child-6')?.active, false)
    assert.equal(again.find(({ id }) => id === 'child-5')?.active, true)
  })
})

test('descendantThreads stops on a fork cycle', async () => {
  await withStore((store) => {
    store.upsertThread(thread('a', { forkedFromId: 'b' }))
    store.upsertThread(thread('b', { forkedFromId: 'a' }))
    assert.deepEqual(
      store.descendantThreads('a').map(({ id }) => id),
      ['b'],
    )
  })
})
