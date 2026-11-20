import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { gitInfoFor, patchGitInfo, sanitizeGitRemoteUrl } from '../src/git-info.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim()
}

test('git remotes lose their credentials the way Codex sanitizes them', () => {
  const cases: Array<[string, string | null]> = [
    ['https://user:secret@example.com/acme/app.git', 'https://example.com/acme/app.git'],
    ['https://token@example.com/acme/app.git', 'https://example.com/acme/app.git'],
    ['https://example.com/acme/app.git', 'https://example.com/acme/app.git'],
    ['ssh://git@example.com/acme/app.git', 'ssh://git@example.com/acme/app.git'],
    ['ssh://git:secret@example.com/acme/app.git', 'ssh://git@example.com/acme/app.git'],
    ['ssh://alice@example.com:2222/acme/app.git', 'ssh://example.com:2222/acme/app.git'],
    ['git@github.com:acme/app.git', 'git@github.com:acme/app.git'],
    ['alice@example.com:acme/app.git', 'example.com:acme/app.git'],
    ['alice@[::1]:acme/app.git', '[::1]:acme/app.git'],
    ['hg::https://user:secret@example.com/repo', 'hg::https://example.com/repo'],
    ['/srv/git/app.git', '/srv/git/app.git'],
    ['file:///srv/git/app.git', 'file:///srv/git/app.git'],
    ['  https://example.com/acme/app.git  ', 'https://example.com/acme/app.git'],
    // A helper's command line can hold secrets anywhere.
    ['ext::ssh -i secret.key example.com %S', null],
    ['https://', null],
    ['https://example.com/acme\napp.git', null],
    ['', null],
  ]
  for (const [remote, expected] of cases)
    assert.equal(sanitizeGitRemoteUrl(remote), expected, remote)
})

test('a gitInfo patch keeps omitted fields, clears null ones and checks the rest', () => {
  const current = { sha: 'abc', branch: 'main', originUrl: 'https://example.com/acme/app.git' }
  assert.deepEqual(patchGitInfo(current, { branch: '  feature/x  ' }), {
    ...current,
    branch: 'feature/x',
  })
  assert.deepEqual(patchGitInfo(current, { sha: null, originUrl: 'https://u:p@example.com/r' }), {
    sha: null,
    branch: 'main',
    originUrl: 'https://example.com/r',
  })
  assert.deepEqual(patchGitInfo(null, { branch: 'main' }), {
    sha: null,
    branch: 'main',
    originUrl: null,
  })
  assert.equal(patchGitInfo(current, { sha: null, branch: null, originUrl: null }), null)
  assert.throws(() => patchGitInfo(current, {}), /gitInfo must include at least one field/)
  assert.throws(() => patchGitInfo(current, { branch: '  ' }), /gitInfo.branch must not be empty/)
  assert.throws(
    () => patchGitInfo(current, { originUrl: 'ext::sh -c secret' }),
    /gitInfo.originUrl must be a valid Git remote/,
  )
  assert.throws(() => patchGitInfo(current, { sha: 1 }), /gitInfo.sha must be a string or null/)
  assert.throws(() => patchGitInfo(current, 'main'), /gitInfo must be an object/)
})

test('gitInfoFor reads HEAD, its branch and origin, and caches per directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-git-info-'))
  try {
    const repo = join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/feature/sidebar')
    // An unborn branch has a name but no commit yet.
    assert.deepEqual(await gitInfoFor(repo, { fresh: true }), {
      sha: null,
      branch: 'feature/sidebar',
      originUrl: null,
    })
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'first')
    git(repo, 'remote', 'add', 'origin', 'https://user:secret@example.com/acme/app.git')
    const sha = git(repo, 'rev-parse', 'HEAD')
    const expected = {
      sha,
      branch: 'feature/sidebar',
      originUrl: 'https://example.com/acme/app.git',
    }
    assert.deepEqual(await gitInfoFor(repo, { fresh: true }), expected)

    // Cached until it expires or a caller asks for a fresh lookup.
    git(repo, 'checkout', '-q', '-b', 'fix/later')
    assert.deepEqual(await gitInfoFor(repo), expected)
    assert.deepEqual(await gitInfoFor(repo, { fresh: true }), { ...expected, branch: 'fix/later' })

    // A detached HEAD has no branch.
    git(repo, 'checkout', '-q', '--detach')
    assert.deepEqual(await gitInfoFor(repo, { fresh: true }), { ...expected, branch: null })

    assert.equal(await gitInfoFor(root), null)
    await assert.rejects(gitInfoFor(join(root, 'missing')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Even the healthy fixture can lose its one-second process budget on a busy
// runner. Retry that timeout alone, and require a new (uncached) lookup on
// every attempt, including the first one after the injected failure.
async function readRecoveredGitInfo(cwd: string, rejected: ReturnType<typeof gitInfoFor>) {
  for (let attempt = 1; ; attempt++) {
    const lookup = gitInfoFor(cwd)
    assert.notEqual(lookup, rejected, 'a failed Git lookup must be evicted')
    try {
      return await lookup
    } catch (error) {
      const execError = error as { code?: unknown; killed?: boolean; signal?: string }
      if (
        attempt === 3 ||
        execError.code !== null ||
        execError.killed !== true ||
        execError.signal !== 'SIGTERM'
      )
        throw error
      rejected = lookup
    }
  }
}

for (const failure of ['timeout', 'signal', 'spawn']) {
  test(`gitInfoFor rejects ${failure} and retries without a cached partial result`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-codex-git-failure-'))
    const previousPath = process.env.PATH
    const executable = join(root, 'git')
    const healthy = `#!/bin/sh
case "$1" in
  rev-parse) echo abc123 ;;
  symbolic-ref) echo feature/recovered ;;
  remote) echo https://example.com/repo.git ;;
esac
`
    try {
      process.env.PATH = root
      if (failure !== 'spawn') {
        const action = failure === 'timeout' ? 'exec /bin/sleep 5' : 'kill -KILL $$'
        await writeFile(
          executable,
          healthy.replace('symbolic-ref) echo feature/recovered', () => `symbolic-ref) ${action}`),
          { mode: 0o755 },
        )
      }
      const rejected = gitInfoFor(root)
      await assert.rejects(rejected, (error: unknown) => {
        const err = error as { killed?: boolean; signal?: string; code?: string }
        if (failure === 'spawn') assert.equal(err.code, 'ENOENT')
        else if (failure === 'timeout') assert.equal(err.killed, true)
        else assert.ok(typeof err.signal === 'string', 'git ended by a signal')
        return true
      })
      await writeFile(executable, healthy, { mode: 0o755 })
      assert.deepEqual(await readRecoveredGitInfo(root, rejected), {
        sha: 'abc123',
        branch: 'feature/recovered',
        originUrl: 'https://example.com/repo.git',
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('a thread git lookup that outlives its server logs nothing', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-codex-git-late-')))
  const previousPath = process.env.PATH
  const previousLog = process.env.CLAUDE_CODEX_DEBUG_LOG
  const log = join(root, 'debug.jsonl')
  try {
    // A git that hangs: the lookup thread/start begins fails a second later.
    await writeFile(join(root, 'git'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o755 })
    process.env.PATH = `${root}${delimiter}${previousPath ?? ''}`
    await withInProcessApp(
      scriptedRuntime(async () => {}),
      async (app) => {
        await app.startThread({ cwd: root })
      },
    )
    // The server is stopped and the test's environment is back: a late line
    // would go to the debug log of whatever adapter home that names, as the
    // developer's ~/.codex.
    process.env.CLAUDE_CODEX_DEBUG_LOG = log
    // The thread's lookup still waits on git. gitInfoFor hands this caller the
    // same lookup, so once it fails here the server has seen it fail too.
    await assert.rejects(gitInfoFor(root))
    assert.equal(existsSync(log), false)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousLog === undefined) delete process.env.CLAUDE_CODEX_DEBUG_LOG
    else process.env.CLAUDE_CODEX_DEBUG_LOG = previousLog
    await rm(root, { recursive: true, force: true })
  }
})
