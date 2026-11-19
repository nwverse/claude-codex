import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runWorkflowCli } from '../src/workflow-cli.mjs'
import { WorkflowStateStore, type WorkflowTask } from '../src/workflow-state.mjs'

const web = 'https://github.com/example/demo/issues/42'
const api = 'https://api.github.com/repos/example/demo/issues/42'
const gh = { number: 42, title: 'Updated title', state: 'OPEN', url: web }
const rest = { number: 42, title: 'Updated title', state: 'open', url: api, html_url: web }
// IDs written by the original importer for these two exports.
const webId = 'github-issue-42-8c1040fa124e'
const restId = 'github-issue-42-5be0c8e1d866'
const now = '2026-07-04T00:00:00.000Z'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-issue-identity-'))
  const path = join(dir, 'state.json')
  const store = new WorkflowStateStore(path)
  const source = join(dir, 'issues.json')
  async function run(args: string[]) {
    let output = ''
    assert.equal(
      await runWorkflowCli([...args, '--state', path, '--now', now], {
        stdout: {
          write(value) {
            output += value.toString()
            return true
          },
        },
        stderr: { write: (value) => assert.fail(String(value)) },
      }),
      0,
    )
    return output
  }
  async function ingest(items: readonly unknown[]) {
    await writeFile(source, JSON.stringify(items))
    return JSON.parse(await run(['ingest-github', '--github-json', source])) as {
      enqueued: number
      existing: string[]
      taskIds: string[]
    }
  }
  return { store, run, ingest }
}

for (const [id, incoming] of [
  [restId, gh],
  [webId, rest],
] as const) {
  test(`workflow reuses the saved issue ${id} across export formats`, async () => {
    const { store, run, ingest } = await fixture()
    const saved: WorkflowTask = {
      id,
      status: 'running',
      updatedAt: '2026-07-03T23:59:00.000Z',
      prompt: 'Saved prompt edited after the first import',
      priority: 8,
      attempts: 2,
      maxAttempts: 4,
      lease: {
        workerId: 'worker-a',
        renewedAt: '2026-07-03T23:59:00.000Z',
        expiresAt: '2026-07-04T00:01:00.000Z',
      },
      blockedReason: null,
      lastError: 'Earlier attempt stopped',
    }
    await store.write({ version: 1, tasks: [saved] })
    const duplicate = await ingest([incoming])
    assert.deepEqual((await store.read())?.tasks, [saved])
    assert.equal(duplicate.enqueued, 0)
    assert.deepEqual(duplicate.existing, [id])
    assert.deepEqual(duplicate.taskIds, [])

    await run(['heartbeat', '--task', id, '--worker', 'worker-a', '--ttl-ms', '120000'])
    const renewed = (await store.read())?.tasks[0]
    assert.equal(renewed?.lease?.expiresAt, '2026-07-04T00:02:00.000Z')
    await run(['complete', '--task', id])
    const completed = await store.read()
    assert.equal(completed?.tasks[0]?.id, id)
    assert.equal(completed?.tasks[0]?.status, 'done')
    assert.equal(completed?.tasks[0]?.attempts, 2)
    assert.equal((await ingest([incoming])).enqueued, 0)
    assert.deepEqual(await store.read(), completed)
  })
}

test('new ordinary issues use the same ID in either format and preserve repository and number', async () => {
  for (const [first, second] of [
    [gh, rest],
    [rest, gh],
  ] as const) {
    const { store, ingest } = await fixture()
    const otherRepo = { ...gh, url: 'https://github.com/example/other/issues/42' }
    const otherNumber = { ...gh, number: 43, url: 'https://github.com/example/demo/issues/43' }
    const batch = await ingest([first, second, otherRepo, otherNumber])
    assert.equal(batch.enqueued, 3)
    assert.equal(batch.taskIds[0], webId)
    assert.deepEqual(batch.existing, [webId])
    assert.equal(new Set(batch.taskIds).size, 3)
    assert.equal((await store.read())?.tasks.length, 3)
  }
})

test('a queue that already contains both historical IDs keeps both records', async () => {
  const { store, ingest } = await fixture()
  await ingest([gh])
  const first = (await store.read())?.tasks[0]
  assert.ok(first)
  const rows = [
    { ...first, status: 'done' as const, attempts: 2 },
    { ...first, id: restId, status: 'blocked' as const, blockedReason: 'Waiting for review' },
  ]
  await writeFile(store.path, JSON.stringify({ version: 1, tasks: rows }))
  const before = await readFile(store.path, 'utf8')
  assert.equal((await ingest([rest, gh])).enqueued, 0)
  assert.equal(await readFile(store.path, 'utf8'), before)
  const fresh = { ...gh, number: 43, url: 'https://github.com/example/demo/issues/43' }
  assert.equal((await ingest([rest, fresh])).enqueued, 1)
  assert.deepEqual((await store.read())?.tasks.slice(0, 2), rows)
})

test('Enterprise Cloud and Server exports keep distinct host-scoped issue identities', async () => {
  const { ingest } = await fixture()
  const cloud = 'https://example.ghe.com/example/demo/issues/42'
  const server = 'https://forge.example/example/demo/issues/42'
  const batch = await ingest([
    { ...rest, html_url: cloud, url: 'https://api.example.ghe.com/repos/example/demo/issues/42' },
    { ...gh, url: cloud },
    { ...gh, url: server },
    { ...rest, html_url: server, url: 'https://forge.example/api/v3/repos/example/demo/issues/42' },
    gh,
  ])
  assert.equal(batch.enqueued, 3)
  assert.equal(new Set(batch.taskIds).size, 3)
})
