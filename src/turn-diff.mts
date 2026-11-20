import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { debugLog } from './util.mjs'

const execFileAsync = promisify(execFile)
const TRACKED_DIFF_BYTES = 5 * 1024 * 1024
const DIFF_FILE_BYTES = 256 * 1024
const DIFF_INLINE_BYTES = 2 * 1024 * 1024
const MAX_LISTED_FILES = 256
const MAX_PER_FILE_DIFFS = 32
// `git diff` names files from the top of the work tree even where the user
// set diff.relative. As config rather than --no-relative (git 2.28), so an
// older git, which has no diff.relative, still runs it.
const GIT_DIFF = ['-c', 'diff.relative=false', 'diff', '--no-ext-diff']

// `git diff` failing is expected outside a repo, so we still return '' to keep
// turns working — but the reason is written to the debug log instead of being
// dropped silently, and a genuine git error is flagged as such.
export function isNotAGitRepo(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not a git repository/i.test(message)
}

// Cheap upfront check — if cwd isn't in a git work-tree, skip the expensive
// `git diff` spawn entirely. Without this guard a non-git workspace (App
// Remote pointing at $HOME or any arbitrary dir) was spamming debug.jsonl
// with multi-KB "not a git repository" failures on every turn cycle, since
// gitDiff runs from runRuntimeTurn after each tool result. A work tree is
// cached, with cwd's path from its top ('' or ending in '/'). A folder git
// says is none is cached for a while only, as it can become one (`git init`),
// and a timeout or failed spawn on a loaded machine, which says nothing about
// the folder, is not cached at all (as in git-info.mts).
const NOT_A_WORK_TREE_TTL_MS = 30_000
const workTreePrefixes = new Map<string, string>()
const notWorkTreesAt = new Map<string, number>()
async function workTreePrefix(cwd: string): Promise<string | null> {
  const cached = workTreePrefixes.get(cwd)
  if (cached !== undefined) return cached
  const at = notWorkTreesAt.get(cwd)
  if (at !== undefined && Date.now() - at < NOT_A_WORK_TREE_TTL_MS) return null
  notWorkTreesAt.delete(cwd)
  let stdout: string
  try {
    const args = ['rev-parse', '--is-inside-work-tree', '--show-prefix']
    stdout = (await execFileAsync('git', args, { cwd, timeout: 3_000, maxBuffer: 64 * 1024 }))
      .stdout
  } catch (error) {
    // Git ran and exited with a status: outside a repository.
    if (typeof (error as { code?: unknown } | null)?.code === 'number')
      notWorkTreesAt.set(cwd, Date.now())
    return null
  }
  const [inside, prefix = ''] = stdout.split('\n')
  if (inside !== 'true') {
    // Inside a .git folder.
    notWorkTreesAt.set(cwd, Date.now())
    return null
  }
  workTreePrefixes.set(cwd, prefix)
  return prefix
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
  return (await workTreePrefix(cwd)) !== null
}

export function addedFileDiff(path: string, text: string, mode = '100644'): string {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
  // A link target never ends in a newline; git marks that so `git apply` keeps the link intact.
  const noNewline =
    mode === '120000' && text !== '' && !text.endsWith('\n') ? ['\\ No newline at end of file'] : []
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ...noNewline,
    '',
  ].join('\n')
}

// A file whose content the diff leaves out, as git shows a binary change: a
// renderer shows no content, and `git apply` refuses it (no full index)
// instead of writing a placeholder into the file. The reason follows outside
// any hunk, where git skips it.
function omittedFileDiff(path: string, reason: string, added = false): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...(added ? ['new file mode 100644'] : []),
    'index 0000000..0000000',
    `Binary files ${added ? '/dev/null' : `a/${path}`} and b/${path} differ`,
    `[omitted: ${reason}]`,
    '',
  ].join('\n')
}

// Drain the whole NUL-delimited list for an accurate omitted count while
// retaining only enough paths to display. Git can list millions of paths.
function listGitRecords(
  cwd: string,
  args: string[],
): Promise<{ records: string[]; omitted: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    })
    const records: string[] = []
    let remainder = ''
    let omitted = 0
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      const batch = (remainder + chunk).split('\0')
      remainder = batch.pop() ?? ''
      for (const record of batch) {
        if (records.length < MAX_LISTED_FILES) records.push(record)
        else omitted++
      }
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ records, omitted })
      else reject(new Error(`git ${args.join(' ')} exited with ${code ?? 'a signal'}`))
    })
  })
}

type InlineBudget = { remaining: number }

function bufferOverflow(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
}

async function trackedDiffFallback(cwd: string, budget: InlineBudget): Promise<string> {
  const args = [...GIT_DIFF, '--no-renames']
  const { records, omitted } = await listGitRecords(cwd, [...args, '--numstat', '-z', '--'])
  const files = records.map((record) => {
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    return {
      path: record.slice(second + 1),
      additions: record.slice(0, first),
      deletions: record.slice(first + 1, second),
    }
  })
  const patches = files.map(({ path, additions, deletions }) =>
    omittedFileDiff(path, `diff size limit, +${additions} -${deletions}`),
  )
  // Look for small changes first when a generated file exhausted the original
  // diff. Even if every candidate overflows, bound the number of git processes.
  const candidates = files
    .map(({ path, additions, deletions }, index) => ({
      index,
      path,
      lines: Number(additions) + Number(deletions) || 0,
    }))
    .sort((a, b) => a.lines - b.lines)
    .slice(0, MAX_PER_FILE_DIFFS)
  for (const { index, path } of candidates) {
    if (budget.remaining <= 0) break
    try {
      // Numstat paths are repo-relative even when the thread is in a subdirectory.
      const { stdout } = await execFileAsync('git', [...args, '--', `:(top,literal)${path}`], {
        cwd,
        timeout: 10_000,
        maxBuffer: Math.min(DIFF_FILE_BYTES, budget.remaining),
      })
      if (stdout) {
        patches[index] = stdout
        budget.remaining -= Buffer.byteLength(stdout)
      }
    } catch (error) {
      if (!bufferOverflow(error)) throw error
      if (budget.remaining < DIFF_FILE_BYTES) budget.remaining = 0
    }
  }
  if (omitted) patches.push(`[${omitted} more tracked files omitted]\n`)
  return patches.join('')
}

export async function gitDiff(cwd: string): Promise<string> {
  if (!(await isGitWorkTree(cwd))) return ''
  const budget = { remaining: DIFF_INLINE_BYTES }
  let tracked: string
  try {
    const { stdout } = await execFileAsync('git', [...GIT_DIFF, '--'], {
      cwd,
      timeout: 10_000,
      maxBuffer: TRACKED_DIFF_BYTES,
    })
    tracked = stdout
  } catch (error) {
    if (!bufferOverflow(error)) {
      debugLog('git.diff.failed', {
        cwd,
        reason: isNotAGitRepo(error) ? 'notAGitRepository' : 'error',
        error: String(error),
      })
      return ''
    }
    try {
      tracked = await trackedDiffFallback(cwd, budget)
    } catch (fallbackError) {
      debugLog('git.diff.fallbackFailed', { cwd, error: String(fallbackError) })
      return ''
    }
  }
  return tracked + (await gitUntrackedDiff(cwd, budget))
}

// `listed` is relative to cwd, as ls-files lists it; the diff names the file
// from the top of the work tree, as `git diff` does.
async function untrackedFileDiff(
  cwd: string,
  prefix: string,
  listed: string,
  budget: InlineBudget,
): Promise<string> {
  const fullPath = join(cwd, listed)
  const path = prefix + listed
  const info = await lstat(fullPath)
  if (info.isSymbolicLink()) return addedFileDiff(path, await readlink(fullPath), '120000')
  if (!info.isFile()) return ''
  const limit = Math.min(DIFF_FILE_BYTES, budget.remaining)
  if (limit === 0 || info.size > limit) return omittedFileDiff(path, `${info.size} bytes`, true)

  // Refuse a link swapped in after lstat, and never block on a FIFO.
  const file = await open(
    fullPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stats = await file.stat()
    if (!stats.isFile()) return ''
    if (stats.size > limit) return omittedFileDiff(path, `${stats.size} bytes`, true)
    // Bound the read even if the file grows between fstat and read.
    const bytes = Buffer.allocUnsafe(stats.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > stats.size) return omittedFileDiff(path, 'file grew during read', true)
    const content = bytes.subarray(0, length)
    if (content.includes(0)) return omittedFileDiff(path, 'binary file', true)
    const patch = addedFileDiff(path, content.toString('utf8'))
    const size = Buffer.byteLength(patch)
    if (size > budget.remaining) return omittedFileDiff(path, `${stats.size} bytes`, true)
    budget.remaining -= size
    return patch
  } finally {
    await file.close()
  }
}

export async function gitUntrackedDiff(
  cwd: string,
  budget: InlineBudget = { remaining: DIFF_INLINE_BYTES },
): Promise<string> {
  try {
    const prefix = await workTreePrefix(cwd)
    if (prefix === null) return ''
    const { records, omitted } = await listGitRecords(cwd, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ])
    const patches: string[] = []
    for (const path of records) {
      try {
        patches.push(await untrackedFileDiff(cwd, prefix, path, budget))
      } catch (error) {
        // A disappearing or unreadable path must not hide the other new files.
        debugLog('git.untrackedDiff.fileFailed', { cwd, path, error: String(error) })
      }
    }
    if (omitted) patches.push(`[${omitted} more untracked files omitted]\n`)
    return patches.join('')
  } catch (error) {
    debugLog('git.untrackedDiff.failed', {
      cwd,
      reason: isNotAGitRepo(error) ? 'notAGitRepository' : 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    return ''
  }
}
