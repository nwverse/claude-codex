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
  ) => {
    exec(sql: string): void
    prepare(sql: string): { all(...params: unknown[]): any[] }
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
