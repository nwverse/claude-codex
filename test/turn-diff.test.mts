import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { gitDiff, gitUntrackedDiff } from '../src/server-helpers.mjs'

const execFileAsync = promisify(execFile)
const MiB = 1024 * 1024
process.env.CLAUDE_CODEX_DEBUG_LOG = '0'

async function withRepository(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'turn-diff-'))
  try {
    await execFileAsync('git', ['init', '-q'], { cwd })
    await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('oversized tracked diff retains large, small and untracked files', async () => {
  await withRepository(async (cwd) => {
    await writeFile(join(cwd, '00-large.txt'), `${'before'.repeat(170)}\n`.repeat(6_000))
    const subdir = join(cwd, 'sub')
    await mkdir(subdir)
    await writeFile(join(subdir, 'literal[1].txt'), 'old\n')
    await writeFile(join(cwd, 'small.txt'), 'before\n')
    await execFileAsync('git', ['add', '--', '.'], { cwd })
    await writeFile(join(subdir, 'literal[1].txt'), 'changed in subdir\n')
    await writeFile(join(cwd, '00-large.txt'), `${'after!'.repeat(170)}\n`.repeat(6_000))
    await writeFile(join(cwd, 'small.txt'), 'small change remains visible\n')
    await writeFile(join(cwd, 'new.txt'), 'untracked change remains visible\n')
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--'], {
      cwd,
      maxBuffer: 20 * MiB,
    })
    assert.ok(Buffer.byteLength(stdout) > 5 * MiB, 'fixture must overflow the old buffer')

    const diff = await gitDiff(cwd)
    assert.match(diff, /diff --git a\/00-large\.txt b\/00-large\.txt/)
    assert.match(diff, /\[omitted:/)
    assert.match((await gitReads(diff)).numstat, /^-\t-\t00-large\.txt$/m)
    assert.match(diff, /diff --git a\/small\.txt b\/small\.txt/)
    assert.match(diff, /\+small change remains visible/)
    assert.match(diff, /diff --git a\/new\.txt b\/new\.txt/)
    assert.match(diff, /\+untracked change remains visible/)
    assert.ok(Buffer.byteLength(diff) < MiB, 'large tracked content should be summarized')
    const subdirDiff = await gitDiff(subdir)
    assert.match(subdirDiff, /diff --git a\/00-large\.txt b\/00-large\.txt/)
    assert.match(subdirDiff, /\+small change remains visible/)
    assert.match(subdirDiff, /\+changed in subdir/)
  })
})

test('large untracked files have size stubs without inlining their contents', async () => {
  await withRepository(async (cwd) => {
    await writeFile(join(cwd, 'artifact.txt'), Buffer.alloc(10 * MiB, 'x'))
    await writeFile(join(cwd, 'small.txt'), 'visible new file\n')
    const diff = await gitDiff(cwd)
    assert.match(diff, /diff --git a\/artifact\.txt b\/artifact\.txt/)
    assert.match(diff, /\[omitted: 10485760 bytes\]/)
    assert.match(diff, /\+visible new file/)
    assert.ok(Buffer.byteLength(diff) < 4096)
    assert.ok(!diff.includes('x'.repeat(100)))
  })
})

test('untracked inline budget preserves entries beyond fifty files', async () => {
  await withRepository(async (cwd) => {
    const paths = Array.from(
      { length: 60 },
      (_, index) => `new-${String(index).padStart(2, '0')}.txt`,
    )
    const text = `${'line'.repeat(255)}\n`.repeat(100)
    assert.ok(Buffer.byteLength(text) < 256 * 1024)
    assert.ok(Buffer.byteLength(text) * paths.length > 2 * MiB)
    await Promise.all(paths.map((path) => writeFile(join(cwd, path), text)))
    const diff = await gitUntrackedDiff(cwd)
    for (const path of paths) {
      assert.ok(diff.includes(`diff --git a/${path} b/${path}\n`), `missing ${path}`)
    }
    assert.match(diff, /\[omitted:/)
    assert.ok(
      Buffer.byteLength(diff) < 2 * MiB + 64 * 1024,
      'only headers may exceed inline budget',
    )
  })
})

test('a large untracked listing keeps a bounded number of entries with an omitted count', async () => {
  await withRepository(async (cwd) => {
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => writeFile(join(cwd, `entry-${i}.txt`), '')),
    )
    const diff = await gitUntrackedDiff(cwd)
    const shown = (diff.match(/^diff --git /gm) ?? []).length
    assert.ok(shown > 50 && shown < 300)
    assert.ok(diff.endsWith(`[${300 - shown} more untracked files omitted]\n`))
    assert.ok(Buffer.byteLength(diff) < 128 * 1024)
  })
})

// What git makes of a diff: its numstat (binary files as '-'), and whether
// it applies to an empty repository.
async function gitReads(diff: string): Promise<{ numstat: string; applied: boolean }> {
  const repo = await mkdtemp(join(tmpdir(), 'turn-diff-apply-'))
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: repo })
    await writeFile(join(repo, 'turn.diff'), diff)
    const { stdout: numstat } = await execFileAsync('git', ['apply', '--numstat', 'turn.diff'], {
      cwd: repo,
    })
    const applied = await execFileAsync('git', ['apply', 'turn.diff'], { cwd: repo }).then(
      () => true,
      () => false,
    )
    return { numstat, applied }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

test('omitted files are binary changes git does not apply as placeholder text', async () => {
  await withRepository(async (cwd) => {
    await writeFile(join(cwd, 'artifact.txt'), Buffer.alloc(300 * 1024, 'x'))
    await writeFile(join(cwd, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    const diff = await gitDiff(cwd)
    assert.match(diff, /^Binary files \/dev\/null and b\/artifact\.txt differ\n\[omitted: 307200/m)
    assert.match(diff, /^Binary files \/dev\/null and b\/image\.bin differ\n\[omitted: binary/m)
    assert.deepEqual(await gitReads(diff), {
      numstat: '-\t-\tartifact.txt\n-\t-\timage.bin\n',
      applied: false,
    })
  })
})

test('a thread in a subdirectory names every file from the top of the work tree', async () => {
  await withRepository(async (cwd) => {
    const pkg = join(cwd, 'pkg')
    await mkdir(pkg)
    await writeFile(join(pkg, 'tracked.txt'), 'before\n')
    await execFileAsync('git', ['add', '--', '.'], { cwd })
    // Without --no-relative, git diff would name tracked files from cwd.
    await execFileAsync('git', ['config', 'diff.relative', 'true'], { cwd })
    await writeFile(join(pkg, 'tracked.txt'), 'after\n')
    await writeFile(join(pkg, 'new.txt'), 'new in pkg\n')
    await writeFile(join(pkg, 'blob.bin'), Buffer.from([0, 1, 2]))
    const diff = await gitDiff(pkg)
    assert.deepEqual(
      diff.split('\n').filter((line) => line.startsWith('diff --git ')),
      [
        'diff --git a/pkg/tracked.txt b/pkg/tracked.txt',
        'diff --git a/pkg/blob.bin b/pkg/blob.bin',
        'diff --git a/pkg/new.txt b/pkg/new.txt',
      ],
    )
    assert.match(diff, /^\+\+\+ b\/pkg\/new\.txt\n@@ -0,0 \+1,1 @@\n\+new in pkg$/m)
    assert.match(diff, /^Binary files \/dev\/null and b\/pkg\/blob\.bin differ$/m)
  })
})

test('a folder that was no repository is asked again after a while', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const cwd = await mkdtemp(join(tmpdir(), 'turn-diff-'))
  try {
    assert.equal(await gitDiff(cwd), '')
    await execFileAsync('git', ['init', '-q'], { cwd })
    await writeFile(join(cwd, 'new.txt'), 'after git init\n')
    // The tool calls and the end of one turn ask git once.
    assert.equal(await gitDiff(cwd), '')
    t.mock.timers.tick(30_000)
    assert.match(await gitDiff(cwd), /\+after git init/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a git that fails to run does not make a repository look like a folder', async () => {
  await withRepository(async (cwd) => {
    await writeFile(join(cwd, 'new.txt'), 'git runs again\n')
    const path = process.env.PATH
    // No git to spawn, like one that timed out on a loaded machine.
    process.env.PATH = cwd
    try {
      assert.equal(await gitDiff(cwd), '')
    } finally {
      process.env.PATH = path
    }
    assert.match(await gitDiff(cwd), /\+git runs again/)
  })
})

test('a git before 2.28, without --no-relative, still diffs from the top', async () => {
  await withRepository(async (cwd) => {
    // That git refuses the option (exit 129) and ignores the config key.
    const bin = await mkdtemp(join(tmpdir(), 'turn-diff-old-git-'))
    const { stdout: realGit } = await execFileAsync('sh', ['-c', 'command -v git'])
    await writeFile(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = "--no-relative" ]; then echo "error: unknown option" >&2; exit 129; fi',
        'done',
        `exec '${realGit.trim()}' "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const pkg = join(cwd, 'pkg')
    await mkdir(pkg)
    await writeFile(join(pkg, 'large.txt'), `${'before'.repeat(170)}\n`.repeat(6_000))
    await writeFile(join(pkg, 'small.txt'), 'before\n')
    await execFileAsync('git', ['add', '--', '.'], { cwd })
    await execFileAsync('git', ['config', 'diff.relative', 'true'], { cwd })
    await writeFile(join(pkg, 'large.txt'), `${'after!'.repeat(170)}\n`.repeat(6_000))
    await writeFile(join(pkg, 'small.txt'), 'after\n')
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path ?? ''}`
    try {
      // Over the size limit, so the per-file fallback runs too.
      const diff = await gitDiff(pkg)
      assert.match(diff, /^Binary files a\/pkg\/large\.txt and b\/pkg\/large\.txt differ$/m)
      assert.match(diff, /^diff --git a\/pkg\/small\.txt b\/pkg\/small\.txt\n[\s\S]*\n\+after$/m)
    } finally {
      process.env.PATH = path
      await rm(bin, { recursive: true, force: true })
    }
  })
})
