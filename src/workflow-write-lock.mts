import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

// This sidecar stores no task data. BEGIN IMMEDIATE holds SQLite's exclusive
// writer reservation until the JSON transition finishes or its process exits.
if (!parentPort) throw new Error('workflow write lock requires a parent worker port')
const lock = new DatabaseSync(workerData as string, { timeout: 30_000 })
try {
  lock.exec('BEGIN IMMEDIATE')
  const release = once(parentPort, 'message')
  parentPort.postMessage('locked')
  await release
} finally {
  lock.close()
}
