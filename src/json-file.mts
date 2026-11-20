import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ensureParent, newId } from './util.mjs'

export function jsonFileTarget(path: string): string {
  // Rename next to the target so a linked config stays linked, including
  // when a user creates the link before the first save.
  let target = path
  const links = new Set<string>()
  while (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    if (links.has(target)) throw new Error(`symbolic link loop at ${target}`)
    links.add(target)
    target = resolve(dirname(target), readlinkSync(target))
  }
  return target
}

// Runs a read/modify/replace of the JSON file at `path` holding a lock next
// to the file it resolves to, so writers in every home linked to that file
// take turns. `body` gets the resolved target.
export function withJsonFileLock<T>(path: string, body: (target: string) => T): T {
  const target = jsonFileTarget(path)
  ensureParent(target)
  // Loading SQLite lazily keeps CLI probes independent of the lock.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const lock = new DatabaseSync(`${target}.lock.sqlite`, { timeout: 5000 })
  try {
    lock.exec('BEGIN IMMEDIATE')
    return body(target)
  } finally {
    lock.close()
  }
}

export function replaceJsonFile(target: string, value: unknown): void {
  // Renaming can replace a read-only file in a writable directory. Honor
  // the file permissions that a direct config write would enforce.
  if (existsSync(target)) accessSync(target, constants.W_OK)
  const temp = `${target}.${newId()}.tmp`
  try {
    ensureParent(target)
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }
}
