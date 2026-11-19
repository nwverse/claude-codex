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
