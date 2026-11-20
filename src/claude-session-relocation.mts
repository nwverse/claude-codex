import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { newId, projectSlugs } from './util.mjs'

export const CLAUDE_SESSION_UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

function failure(path: string, error: unknown): string {
  return `${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`
}

// A transcript lookup: the file, or null when nothing is there. A lookup that
// cannot tell (EACCES, EPERM, EIO) is added to `failures`.
export function transcriptStat(path: string, failures: string[]): Stats | null {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat : null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') failures.push(failure(path, error))
    return null
  }
}

// Whether a folder can say a transcript in it is gone: 'readable', 'absent'
// (no entry at all in a parent folder that is there), or else why not.
function folderState(dir: string): string {
  let path = dir
  try {
    if (!lstatSync(dir, { throwIfNoEntry: false })) {
      path = dirname(dir)
      if (statSync(path).isDirectory()) return 'absent'
    } else if (statSync(dir).isDirectory()) {
      accessSync(dir, constants.R_OK | constants.X_OK)
      return 'readable'
    }
    return `${path}: not a folder`
  } catch (error) {
    return failure(path, error)
  }
}

// A Claude session starts over only when its transcript is certainly gone:
// no lookup in the CLI's config folder failed, and that folder and its
// projects folder are readable or not there at all (the CLI creates them).
// A folder that is out of reach (a link or parent folder that is gone, as
// on an unmounted volume, or one that cannot be read) fails the turn
// instead, and the chat keeps its session for when the folder is back.
export function assertTranscriptGone(id: string, root: string, failures: string[]): void {
  let problem = failures[0]
  for (const dir of [root, join(root, 'projects')]) {
    if (problem) break
    const state = folderState(dir)
    if (state === 'absent') break
    if (state !== 'readable') problem = state
  }
  if (problem)
    throw new Error(
      `Cannot resume Claude session ${id}: its transcript could not be read (${problem}). The chat keeps its session; send the message again once that folder is available.`,
    )
}

// Also resolve a renamed directory's surviving parent, e.g. /tmp -> /private/tmp.
function physicalPath(path: string): string {
  let parent = path
  while (true) {
    try {
      return join(realpathSync(parent), relative(parent, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent))
        throw error
      parent = dirname(parent)
    }
  }
}

function trusted(stat: Stats): boolean {
  return (
    process.platform === 'win32' ||
    ((process.getuid?.() ?? stat.uid) === stat.uid && (stat.mode & 0o022) === 0)
  )
}

function verifyDirectory(dir: string): void {
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || !trusted(stat))
    throw new Error('Claude transcript directory is not trusted')
}

// Skip metadata records, then validate the session identity in the transcript
// itself. Read one record at a time, even in a large conversation.
function verifyTranscript(path: string, sessionId: string): Stats {
  if (!lstatSync(path).isFile()) throw new Error('Claude transcript is not a trusted regular file')
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || !trusted(stat))
      throw new Error('Claude transcript is not a trusted, single-link regular file')
    const bytes = Buffer.alloc(64 * 1024)
    const decoder = new StringDecoder('utf8')
    let pieces: string[] = []
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, null)
      const lines = (count ? decoder.write(bytes.subarray(0, count)) : decoder.end()).split('\n')
      const tail = count ? (lines.pop() ?? '') : ''
      for (const line of lines) {
        pieces.push(line)
        const text = pieces.join('').trim()
        pieces = []
        if (!text) continue
        let record: { type?: string; sessionId?: string }
        try {
          record = JSON.parse(text)
        } catch {
          throw new Error('Claude transcript contains an unreadable record')
        }
        if (record?.type !== 'user' && record?.type !== 'assistant') continue
        if (record.sessionId !== sessionId)
          throw new Error('Claude transcript has a different session ID')
        return stat
      }
      if (!count) break
      if (tail) pieces.push(tail)
    }
    throw new Error('Claude transcript has no conversation record')
  } finally {
    closeSync(fd)
  }
}

function digest(path: string): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || !trusted(stat))
      throw new Error('Claude transcript is not a trusted regular file')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (!count) return hash.digest('hex')
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    closeSync(fd)
  }
}

// A retry after a failed CLI launch can see the independent copy published
// by the previous attempt. A different file is never overwritten.
function identicalDestination(source: string, target: string, id: string): boolean {
  const stat = lstatSync(target, { throwIfNoEntry: false })
  if (!stat) return false
  if (stat.isFile() && trusted(stat) && stat.nlink === 1 && digest(source) === digest(target))
    return true
  throw new Error(
    `Cannot relocate Claude session ${id}: its destination already has a different transcript`,
  )
}

// When the App changes this thread's working directory, use only the source
// workspace recorded in SQLite and the config root of the selected CLI. False
// when there is nothing to copy: the CLI already finds the transcript under
// the new workspace's name, or the recorded workspace has none left.
export function relocateClaudeTranscript(
  id: string,
  sourceCwd: string,
  cwd: string,
  root: string,
): boolean {
  const from = physicalPath(sourceCwd)
  const to = physicalPath(cwd)
  if (from === to) return false
  if (!CLAUDE_SESSION_UUID.test(id))
    throw new Error('Cannot relocate an unrecognized Claude session ID')
  const projects = join(root, 'projects')
  // No transcripts at all, e.g. after the projects folder was cleared.
  if (!lstatSync(projects, { throwIfNoEntry: false })) return false
  verifyDirectory(projects)
  const sources: string[] = []
  const previous = new Set([...projectSlugs(from), ...projectSlugs(sourceCwd)])
  const targetSlug = projectSlugs(to)[0] as string
  // A rename that keeps the folder name's slug (my_project -> my-project)
  // leaves the transcript where the CLI looks for it.
  if (previous.has(targetSlug)) return false
  for (const slug of previous) {
    const dir = join(projects, slug)
    if (!lstatSync(dir, { throwIfNoEntry: false })) continue
    verifyDirectory(dir)
    const path = join(dir, `${id}.jsonl`)
    if (!lstatSync(path, { throwIfNoEntry: false })) continue
    sources.push(path)
  }
  const targetDir = join(projects, targetSlug)
  const target = join(targetDir, `${id}.jsonl`)
  if (!sources.length && lstatSync(targetDir, { throwIfNoEntry: false })) {
    verifyDirectory(targetDir)
    if (lstatSync(target, { throwIfNoEntry: false })) {
      verifyTranscript(target, id)
      return true
    }
  }
  // Claude Code deletes old transcripts (cleanupPeriodDays): a session with
  // none left is missing, moved or not, and the turn starts a new one.
  if (!sources.length) return false
  if (sources.length !== 1) {
    throw new Error(
      `Cannot relocate Claude session ${id}: expected one transcript in the recorded workspace, found ${sources.length}`,
    )
  }
  const source = sources[0] as string
  const original = verifyTranscript(source, id)
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  verifyDirectory(targetDir)
  // Publish only a completed independent copy. linkSync refuses to replace
  // a destination another process (or an earlier attempt) has created.
  for (const slug of projectSlugs(cwd)) {
    const dir = join(projects, slug)
    if (slug === targetSlug || !lstatSync(dir, { throwIfNoEntry: false })) continue
    verifyDirectory(dir)
    identicalDestination(source, join(dir, `${id}.jsonl`), id)
  }
  if (identicalDestination(source, target, id)) return true
  const temporary = `${target}.${newId()}.tmp`
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    chmodSync(temporary, 0o600)
    verifyTranscript(temporary, id)
    const current = lstatSync(source)
    if (
      current.ino !== original.ino ||
      current.dev !== original.dev ||
      current.size !== original.size ||
      current.mtimeMs !== original.mtimeMs
    )
      throw new Error('Claude transcript changed during relocation; retry when its writer is idle')
    linkSync(temporary, target)
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'EEXIST' &&
      identicalDestination(source, target, id)
    )
      return true
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Cannot relocate Claude session ${id}: a transcript already exists at its destination`,
      )
    throw error
  } finally {
    rmSync(temporary, { force: true })
  }
  return true
}
