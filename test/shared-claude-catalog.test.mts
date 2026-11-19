import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const worker = `
  import { listFolderCommands, noteFolderCommands } from './dist/src/claude-commands.mjs'
  import { listClaudeModels, noteClaudeModels } from './dist/src/claude-models.mjs'
  const folders = ['a', 'b', 'c']
  process.on('message', (step) => {
    if (step !== 'read') {
      noteFolderCommands('/' + step, [{name: 'cost', builtin: true}, {name: 'cmd-' + step}])
      noteClaudeModels([{value: 'model-' + step, displayName: step, supportsEffort: true}])
    }
    process.send({
      commands: folders.map(f => listFolderCommands('/' + f).map(c => c.name)),
      models: listClaudeModels().map(m => m.value).sort(),
    })
  })
`

test('adapters and a restarted reader see the reports for every folder and model', {
  timeout: 20_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cc-catalogs-'))
  const peers: ChildProcess[] = []
  const peer = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CODEX_HOME: home,
        CLAUDE_CODEX_DEBUG_LOG: '0',
        NODE_NO_WARNINGS: '1',
      },
    })
    peers.push(child)
    const exited = once(child, 'exit')
    return async (step: string) => {
      const reply = once(child, 'message', { signal: t.signal })
      child.send(step)
      return (
        await Promise.race([
          reply,
          exited.then(([code, signal]) => {
            throw new Error(`catalog reader exited before replying to ${step} (${code ?? signal})`)
          }),
        ])
      )[0]
    }
  }
  try {
    const commands = join(home, 'claude-commands.json')
    const models = join(home, 'claude-models.json')
    await symlink('commands-target.json', commands)
    await writeFile(models, '{"models":[]}')
    const a = peer()
    const b = peer()
    await Promise.all([a('read'), b('read')])
    await Promise.all([a('a'), b('b')])
    await a('c')
    const expected = {
      commands: [['cmd-a'], ['cmd-b'], ['cmd-c']],
      models: ['model-a', 'model-b', 'model-c'],
    }
    for (const read of [a, b, peer()]) assert.deepEqual(await read('read'), expected)
    assert.equal(await readlink(commands), 'commands-target.json')
    assert.deepEqual(Object.keys(JSON.parse(await readFile(commands, 'utf8')).folders).sort(), [
      '/a',
      '/b',
      '/c',
    ])
  } finally {
    await Promise.all(
      peers.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }),
    )
    await rm(home, { recursive: true, force: true })
  }
})
