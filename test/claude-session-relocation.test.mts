import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sdkResumeSessionId } from '../src/native-runtime.mjs'
import { projectSlugs } from '../src/util.mjs'

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cc-relocate-')))
  const origin = join(base, 'old')
  const cwd = join(base, 'new')
  const config = join(base, 'profile')
  const id = randomUUID()
  const projects = join(config, 'projects')
  const oldDir = join(projects, projectSlugs(origin)[0] as string)
  const newDir = join(projects, projectSlugs(cwd)[0] as string)
  const file = (dir: string) => join(dir, `${id}.jsonl`)
  const original =
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: origin,
      message: { content: 'original marker' },
    }) + '\n'
  await mkdir(origin)
  await mkdir(oldDir, { recursive: true, mode: 0o700 })
  await writeFile(file(oldDir), original, { mode: 0o600 })
  await rename(origin, cwd)
  return {
    base,
    origin,
    cwd,
    config,
    id,
    oldDir,
    newDir,
    file,
    original,
    resume: () => sdkResumeSessionId(id, cwd, config, 'same-model', origin),
  }
}

test('a moved workspace resumes its recorded Claude conversation in an independent copy', async () => {
  const f = await fixture()
  try {
    assert.equal(f.resume(), f.id)
    assert.equal(f.resume(), f.id)
    assert.equal(await readFile(f.file(f.newDir), 'utf8'), f.original)
    assert.notEqual((await stat(f.file(f.oldDir))).ino, (await stat(f.file(f.newDir))).ino)
    await appendFile(f.file(f.newDir), 'another turn\n')
    assert.equal(await readFile(f.file(f.oldDir), 'utf8'), f.original)
    assert.throws(f.resume, /different transcript/)
  } finally {
    await rm(f.base, { recursive: true, force: true })
  }
})

test('relocation stays in the bound configuration and refuses unrelated or ambiguous copies', async () => {
  const f = await fixture()
  try {
    const foreign = join(f.base, 'foreign')
    await mkdir(join(foreign, 'projects'), { recursive: true, mode: 0o700 })
    assert.throws(() => sdkResumeSessionId(f.id, f.cwd, foreign, 'same-model', f.origin), /found 0/)
    const otherWorkspace = join(f.base, 'unrelated')
    assert.throws(
      () => sdkResumeSessionId(f.id, f.cwd, f.config, 'same-model', otherWorkspace),
      /found 0/,
    )
    await mkdir(f.newDir, { mode: 0o700 })
    await writeFile(f.file(f.newDir), f.original + 'different\n', { mode: 0o600 })
    assert.throws(f.resume, /different transcript/)
    assert.equal(await readFile(f.file(f.oldDir), 'utf8'), f.original)
    assert.equal(await readFile(f.file(f.newDir), 'utf8'), f.original + 'different\n')
  } finally {
    await rm(f.base, { recursive: true, force: true })
  }
})

test('relocation refuses a mismatched session identity and linked or writable transcript sources', async () => {
  const f = await fixture()
  try {
    await writeFile(f.file(f.oldDir), JSON.stringify({ type: 'user', sessionId: randomUUID() }))
    assert.throws(f.resume, /different session ID/)
    if (process.platform !== 'win32') {
      await writeFile(f.file(f.oldDir), f.original)
      await chmod(f.file(f.oldDir), 0o666)
      assert.throws(f.resume, /not a trusted/)
      await rm(f.file(f.oldDir))
      const unrelated = join(f.base, 'unrelated.jsonl')
      await writeFile(unrelated, f.original, { mode: 0o600 })
      await symlink(unrelated, f.file(f.oldDir))
      assert.throws(f.resume)
      assert.equal(await readFile(unrelated, 'utf8'), f.original)
      await rm(f.file(f.oldDir))
      await writeFile(f.file(f.oldDir), f.original, { mode: 0o600 })
      await mkdir(f.newDir, { mode: 0o700 })
      await link(f.file(f.oldDir), f.file(f.newDir))
      assert.throws(f.resume, /single-link|different transcript/)
      await rm(f.file(f.oldDir))
      await link(f.file(f.newDir), join(f.base, 'another-copy'))
      assert.throws(f.resume, /single-link/)
      assert.equal(await readFile(f.file(f.newDir), 'utf8'), f.original)
    }
  } finally {
    await rm(f.base, { recursive: true, force: true })
  }
})
