import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PINNED_SECTION_ID, SessionStore } from '../src/store.mjs'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { timeout?: number },
  ) => {
    exec(sql: string): void
    prepare(sql: string): { all(...params: unknown[]): any[]; run(...params: unknown[]): unknown }
    close(): void
  }
}

// SQLite bumps the file change counter (header bytes 24..27) on every write
// transaction that commits a change to the file. That holds only in
// rollback-journal mode (a WAL commit leaves the main file alone), so the
// first test asserts the store still uses it.
function changeCounter(path: string): number {
  return readFileSync(path).readUInt32BE(24)
}

function readThread(path: string, id: string): any {
  const db = new DatabaseSync(path)
  try {
    return db.prepare('SELECT * FROM threads WHERE id = ?').all(id)[0]
  } finally {
    db.close()
  }
}

// A store with one thread the startup repairs leave alone.
async function cleanStore(): Promise<{ home: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-store-startup-'))
  const path = join(home, 'state.sqlite')
  new SessionStore(path).close()
  const raw = new DatabaseSync(path)
  raw.exec(`INSERT INTO thread_sections (id, name, created_at, updated_at)
    VALUES ('custom', 'Custom', 0, 0)`)
  insertThread(raw, 'clean', `thread_source = 'user', base_instructions = 'keep'`)
  raw.close()
  return { home, path }
}

function insertThread(db: InstanceType<typeof DatabaseSync>, id: string, columns: string): void {
  db.exec(`INSERT INTO threads (id, session_id, preview, cwd, model, model_provider, source,
    created_at, updated_at, status_json) VALUES ('${id}', '${id}', '', '/w', 'm', 'claude',
    'appServer', 0, 7, '{"type":"idle"}')`)
  if (columns) db.exec(`UPDATE threads SET ${columns} WHERE id = '${id}'`)
}

test('startup repairs legacy thread rows once and leaves a clean store unwritten', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-store-startup-'))
  const path = join(home, 'state.sqlite')
  try {
    new SessionStore(path).close()
    const raw = new DatabaseSync(path)
    // What older adapter versions wrote: a pin flag with no section, a stale
    // flag on a custom section, ordering on an unsectioned row, and empty or
    // snake_case values in the enum-like columns.
    raw.exec(`INSERT INTO thread_sections (id, name, created_at, updated_at)
      VALUES ('custom', 'Custom', 0, 0)`)
    insertThread(raw, 'pinned', 'is_pinned = 1')
    insertThread(raw, 'custom', `is_pinned = 1, section_id = 'custom', section_position = 0`)
    insertThread(raw, 'stray', 'section_entered_at = 5, section_position = 3')
    insertThread(
      raw,
      'enums',
      `source = 'app_server', thread_source = '', agent_role = '', agent_nickname = '',
       base_instructions = '', developer_instructions = ''`,
    )
    insertThread(raw, 'clean', `thread_source = 'user', base_instructions = 'keep'`)
    raw.close()

    new SessionStore(path).close()
    const check = new DatabaseSync(path)
    const rows = new Map(
      check
        .prepare(`SELECT * FROM threads ORDER BY id`)
        .all()
        .map((row) => [row.id, row]),
    )
    const [{ journal_mode }] = check.prepare('PRAGMA journal_mode').all()
    check.close()
    assert.equal(journal_mode, 'delete', 'the change counter only sees rollback-journal commits')
    const pinned = rows.get('pinned')
    assert.equal(pinned.section_id, PINNED_SECTION_ID)
    assert.equal(pinned.is_pinned, 1)
    assert.equal(pinned.section_entered_at, 7)
    assert.notEqual(pinned.section_position, null)
    assert.equal(rows.get('custom').is_pinned, 0)
    assert.equal(rows.get('custom').section_position, 0)
    assert.equal(rows.get('stray').section_entered_at, null)
    assert.equal(rows.get('stray').section_position, null)
    const enums = rows.get('enums')
    assert.equal(enums.source, 'appServer')
    for (const column of [
      'thread_source',
      'agent_role',
      'agent_nickname',
      'base_instructions',
      'developer_instructions',
    ]) {
      assert.equal(enums[column], null, column)
    }
    assert.equal(rows.get('clean').thread_source, 'user')
    assert.equal(rows.get('clean').base_instructions, 'keep')

    const before = changeCounter(path)
    new SessionStore(path).close()
    new SessionStore(path).close()
    assert.equal(changeCounter(path), before, 'reopening a repaired store must not write')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// One legacy row per store, so a wrong term in a probe cannot hide behind
// another legacy row that opens the same probe.
const legacyRows: Array<[string, Record<string, unknown>]> = [
  ['is_pinned = 1', { section_id: PINNED_SECTION_ID, is_pinned: 1 }],
  [`is_pinned = 1, section_id = ''`, { section_id: PINNED_SECTION_ID, is_pinned: 1 }],
  [`is_pinned = 1, section_id = 'custom'`, { section_id: 'custom', is_pinned: 0 }],
  [`section_id = '${PINNED_SECTION_ID}'`, { section_id: PINNED_SECTION_ID, is_pinned: 1 }],
  ['section_entered_at = 5', { section_entered_at: null }],
  ['section_position = 3', { section_position: null }],
  [`thread_source = ''`, { thread_source: null }],
  [`thread_source = 'app'`, { thread_source: null }],
  [`agent_role = ''`, { agent_role: null }],
  [`agent_nickname = ''`, { agent_nickname: null }],
  [`base_instructions = ''`, { base_instructions: null }],
  [`developer_instructions = ''`, { developer_instructions: null }],
  [`source = 'app_server'`, { source: 'appServer' }],
]

test('startup repairs each legacy condition on its own', async (t) => {
  for (const [columns, expected] of legacyRows) {
    await t.test(columns, async () => {
      const { home, path } = await cleanStore()
      try {
        const raw = new DatabaseSync(path)
        insertThread(raw, 'legacy', columns)
        raw.close()

        new SessionStore(path).close()
        const row = readThread(path, 'legacy')
        for (const [column, value] of Object.entries(expected)) {
          assert.equal(row[column], value, column)
        }
        assert.equal(readThread(path, 'clean').base_instructions, 'keep')

        const before = changeCounter(path)
        new SessionStore(path).close()
        assert.equal(changeCounter(path), before, 'reopening a repaired store must not write')
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
      }
    })
  }
})

// How an older build writes a turn, which a rollback runs again: with the
// whole uncommitted `git diff`.
function olderBuildWrite(db: InstanceType<typeof DatabaseSync>, id: string, diff: string): void {
  db.prepare(`INSERT INTO turns (id, thread_id, status, started_at, items_json, diff)
    VALUES (?, 'clean', 'completed', 1, '[]', ?)
    ON CONFLICT(id) DO UPDATE SET diff = excluded.diff`).run(id, diff)
}

function diffBytes(db: InstanceType<typeof DatabaseSync>): string[] {
  return db
    .prepare(
      `SELECT id, octet_length(diff) AS bytes FROM turns
       UNION ALL SELECT thread_id, octet_length(diff) FROM thread_inherited_turns ORDER BY 1`,
    )
    .all()
    .map(({ id, bytes }) => `${id}:${bytes}`)
}

test('turn diffs older builds stored stay out of reads, and none is written or forked again', async () => {
  const { home, path } = await cleanStore()
  const big = 'x'.repeat(64 * 1024)
  try {
    const raw = new DatabaseSync(path)
    insertThread(raw, 'fork', `forked_from_id = 'clean'`)
    olderBuildWrite(raw, 'old', big)
    const store = new SessionStore(path)
    try {
      // Opening leaves them to clearStoredTurnDiffs, and reads skip them.
      assert.deepEqual(diffBytes(raw), ['old:65536'])
      const turn = store.getTurn('old')
      assert.ok(turn)
      assert.equal('diff' in turn, false)
      assert.deepEqual(
        store.historyTurns('clean').map((entry) => Object.keys(entry).includes('diff')),
        [false],
      )
      // A fork copies none, and the next write of the turn drops its own.
      store.copyInheritedHistory('fork', 'clean', 1)
      assert.deepEqual(diffBytes(raw), ['fork:0', 'old:65536'])
      store.upsertTurn({ ...turn, id: 'new' })
      store.upsertTurn(turn)
      assert.deepEqual(diffBytes(raw), ['fork:0', 'new:0', 'old:0'])
    } finally {
      store.close()
      raw.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('old turn diffs leave the store open at once and go a few rows per write', async () => {
  const { home, path } = await cleanStore()
  const diff = 'x'.repeat(64 * 1024)
  try {
    const raw = new DatabaseSync(path)
    insertThread(raw, 'fork', `forked_from_id = 'clean'`)
    for (let index = 0; index < 40; index++) olderBuildWrite(raw, `old-${index}`, diff)
    const inherit = raw.prepare(`INSERT INTO thread_inherited_turns
      (thread_id, position, id, status, items_json, diff) VALUES ('fork', ?, ?, 'completed', '[]', ?)`)
    for (let index = 0; index < 10; index++) inherit.run(index, `old-${index}`, diff)
    const left = () =>
      Number(
        raw
          .prepare(`SELECT (SELECT COUNT(*) FROM turns WHERE diff <> '')
          + (SELECT COUNT(*) FROM thread_inherited_turns WHERE diff <> '') AS rows`)
          .all()[0]?.rows,
      )

    // Opening writes none of it, so another adapter holding the write lock
    // does not hold it up (a write would wait out the 5 s busy timeout).
    raw.exec('BEGIN IMMEDIATE')
    const opening = performance.now()
    let store = new SessionStore(path)
    const opened = performance.now() - opening
    raw.exec('ROLLBACK')
    assert.ok(opened < 2_000, `opening took ${Math.round(opened)} ms`)
    assert.equal(left(), 50)

    // One batch, then a pause; closing the store ends the run.
    const paused = store.clearStoredTurnDiffs(0, 60_000)
    assert.equal(left(), 42)
    store.close()
    await paused

    store = new SessionStore(path)
    try {
      const before = changeCounter(path)
      const clearing = store.clearStoredTurnDiffs(0, 5)
      assert.equal(left(), 34)
      // Between batches the file is free: a writer that does not wait gets in.
      const other = new DatabaseSync(path, { timeout: 0 })
      other.exec(`UPDATE threads SET name = 'meanwhile' WHERE id = 'clean'`)
      other.close()
      await clearing
      assert.equal(left(), 0)
      // 24 + 10 more rows, eight per write at most, and the other writer.
      assert.ok(changeCounter(path) - before >= 1 + 3 + 2 + 1)
      assert.equal(store.historyTurns('clean').length, 40)
    } finally {
      store.close()
    }

    // A cleared store goes through without a write.
    const before = changeCounter(path)
    store = new SessionStore(path)
    await store.clearStoredTurnDiffs()
    store.close()
    assert.equal(changeCounter(path), before, 'clearing a cleared store must not write')
    raw.close()
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('another adapter can finish a column migration between the probe and the write', async (t) => {
  const { home, path } = await cleanStore()
  const other = new DatabaseSync(path)
  try {
    other.exec('ALTER TABLE threads DROP COLUMN approval_policy')
    const alter = 'ALTER TABLE threads ADD COLUMN approval_policy TEXT'
    const exec = DatabaseSync.prototype.exec
    let interleaved = false
    t.mock.method(
      DatabaseSync.prototype,
      'exec',
      function (this: InstanceType<typeof DatabaseSync>, sql: string) {
        if (!interleaved && (sql === 'BEGIN IMMEDIATE' || sql === alter)) {
          interleaved = true
          exec.call(other, alter)
        }
        return exec.call(this, sql)
      },
    )
    new SessionStore(path).close()
    assert.ok(interleaved)
    assert.ok(
      other
        .prepare("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'approval_policy'")
        .all().length,
    )
  } finally {
    other.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a clean store opens while another connection holds the write lock', async () => {
  const { home, path } = await cleanStore()
  try {
    new SessionStore(path).close()
    const writer = new DatabaseSync(path)
    writer.exec('BEGIN IMMEDIATE')
    try {
      // Any write during the open waits out the busy timeout, then throws
      // "database is locked".
      new SessionStore(path).close()
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery preserves completed history that changes between scan and repair', async () => {
  const { home, path } = await cleanStore()
  const store = new SessionStore(path)
  const raw = new DatabaseSync(path)
  try {
    raw.exec(`
      INSERT INTO turns (id, thread_id, status, items_json) VALUES
        ('a', 'clean', 'completed', '[{"id":"a","type":"mcpToolCall","status":"inProgress"}]'),
        ('b', 'clean', 'completed', '[{"id":"b","type":"mcpToolCall","status":"inProgress"}]'),
        ('c', 'clean', 'completed', '[  {"type":"agentMessage","text":"unchanged"}  ]');
      CREATE TRIGGER finish_second_during_repair AFTER UPDATE OF items_json ON turns
      WHEN NEW.id = 'a' BEGIN
        UPDATE turns SET items_json = '[{"type":"agentMessage","text":"finished elsewhere"}]' WHERE id = 'b';
      END;
    `)
    const recovered = store.recoverStaleInProgressTurns()
    assert.deepEqual(store.getTurn('b')?.items, [
      { type: 'agentMessage', text: 'finished elsewhere' },
    ])
    assert.equal(
      raw.prepare("SELECT items_json FROM turns WHERE id = 'c'").all()[0]?.items_json,
      '[  {"type":"agentMessage","text":"unchanged"}  ]',
    )
    assert.equal(recovered, 1)
    assert.equal(store.recoverStaleInProgressTurns(), 0)
  } finally {
    raw.close()
    store.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('a legacy Claude conversation retains its last confirmed workspace across multiple resumes', async () => {
  const { home, path } = await cleanStore()
  let store = new SessionStore(path)
  try {
    const raw = new DatabaseSync(path)
    raw.exec(
      "UPDATE threads SET cwd = '/former/workspace', claude_session_id = 'persisted-session', claude_session_cwd = NULL WHERE id = 'clean'",
    )
    raw.close()
    for (const cwd of ['/next/workspace', '/final/workspace']) {
      const thread = store.getThread('clean')
      assert.ok(thread)
      assert.equal(thread.claudeSessionCwd, '/former/workspace')
      store.upsertThread({ ...thread, cwd })
    }
    store.close()
    store = new SessionStore(path)
    assert.equal(store.getThread('clean')?.claudeSessionCwd, '/former/workspace')
    store.updateClaudeSessionId('clean', 'persisted-session', '/final/workspace')
    assert.equal(store.getThread('clean')?.claudeSessionCwd, '/final/workspace')
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true })
  }
})
