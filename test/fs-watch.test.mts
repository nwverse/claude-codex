import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import fs, {
  existsSync,
  type FSWatcher,
  mkdirSync,
  mkdtempSync,
  type PathLike,
  renameSync,
  rmSync,
  type StatSyncOptions,
  symlinkSync,
  utimesSync,
  type WatchOptionsWithStringEncoding,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { FS_WATCH_DEBOUNCE_MS } from '../src/fs-watch.mjs'
import { INVALID_REQUEST } from '../src/host-methods.mjs'
import { MockRuntime } from '../src/mock-runtime.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'
import { type InProcessApp, withInProcessApp } from './fixtures/in-process-app.mjs'

// Codex's own `fs/watch` callers watch single files in .git (HEAD, FETCH_HEAD),
// which git replaces by renaming a lock file over them. The watch keeps the
// path the App sent, follows the file across renames, and accepts a file that
// does not exist yet.

// A fresh folder, under the tmpdir path as given (not its realpath).
const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fs-watch-'))
  roots.push(root)
  return root
}

// A fresh `.git` with HEAD.
function gitDir(): string {
  const git = join(tempRoot(), '.git')
  mkdirSync(git)
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  return git
}

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Watches `path` and waits until the watch is live. On macOS a directory watch
// starts asynchronously, so a write right after fs/watch can be missed: write
// to `probe` (the target itself, or an entry of a watched directory), or call
// it, until the first fs/changed arrives, then forget what was seen.
async function watchLive(
  app: InProcessApp,
  watchId: string,
  path: string,
  probe: string | ((attempt: number) => void),
): Promise<void> {
  assert.deepEqual(await app.request('fs/watch', { watchId, path }), { path })
  await probeChange(app, watchId, (attempt) =>
    typeof probe === 'string' ? writeFileSync(probe, String(attempt)) : probe(attempt),
  )
  await delay(300) // let the probe's debounce window close
  const isMine = (message: any): boolean =>
    message.method === 'fs/changed' && message.params.watchId === watchId
  for (let index = app.messages.length - 1; index >= 0; index--) {
    if (isMine(app.messages[index])) app.messages.splice(index, 1)
  }
}

// git's atomic update: write `<file>.lock`, rename it over `<file>`.
function gitUpdate(file: string, content: string): void {
  writeFileSync(`${file}.lock`, content)
  renameSync(`${file}.lock`, file)
}

function changes(app: InProcessApp, watchId: string): string[][] {
  return app
    .notified('fs/changed')
    .filter((params) => params.watchId === watchId)
    .map((params) => params.changedPaths)
}

// The changes for the watch once one more batch arrives after `seen` batches.
async function nextChange(app: InProcessApp, watchId: string, seen: number): Promise<string[]> {
  return poll(`fs/changed #${seen + 1} for ${watchId}`, () => changes(app, watchId)[seen])
}

// Calls `probe` every 50 ms until the watch reports one more batch, which it
// returns. A watch set up during the test may not be live at once on macOS.
async function probeChange(
  app: InProcessApp,
  watchId: string,
  probe: (attempt: number) => void,
): Promise<string[]> {
  const seen = changes(app, watchId).length
  return poll(`fs/changed for ${watchId}`, () => changes(app, watchId)[seen], probe)
}

// Checks `found` every 50 ms, calling `probe` before each wait, until it
// returns a value. The deadline is generous: file events can be slow on a
// loaded CI machine.
async function poll<T>(
  what: string | (() => string),
  found: () => T | undefined,
  probe?: (attempt: number) => void,
): Promise<T> {
  const deadline = Date.now() + 20_000
  for (let attempt = 0; ; attempt++) {
    const value = found()
    if (value !== undefined) return value
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`)
    }
    probe?.(attempt)
    await delay(50)
  }
}

type Listener = (eventType: string, filename: string | null) => void

// Spies on fs.watch for the rest of the test, also as the code under test
// imported it. `paths` lists the folders watched, in order, and `open()`
// counts the fs.watch handles opened since and not closed yet. `intercept`
// may stand in for a watch; `start` starts the real one with a listener.
function spyOnWatch(
  t: TestContext,
  intercept?: (
    path: string,
    listener: Listener,
    start: (listener: Listener) => FSWatcher,
  ) => FSWatcher,
): { paths: string[]; open: () => number } {
  const original = fs.watch
  const paths: string[] = []
  const open = new Set<number>()
  const handles = createHook({
    init: (id, type) => {
      if (type === 'FSEVENTWRAP') open.add(id)
    },
    destroy: (id) => {
      open.delete(id)
    },
  }).enable()
  fs.watch = ((path: string, options: WatchOptionsWithStringEncoding, listener: Listener) => {
    paths.push(path)
    const start = (wrapped: Listener): FSWatcher => original(path, options, wrapped)
    return intercept ? intercept(path, listener, start) : start(listener)
  }) as typeof fs.watch
  syncBuiltinESMExports()
  t.after(() => {
    fs.watch = original
    syncBuiltinESMExports()
    handles.disable()
  })
  return { paths, open: () => open.size }
}

// Makes fs.statSync report the change time as birth time for the rest of the
// test, also as the code under test imported it, as Node does on Linux
// without statx (kernel < 4.11, some seccomp filters, WSL1).
function birthTimeIsChangeTime(t: TestContext): void {
  const original = fs.statSync
  fs.statSync = ((path: PathLike, options?: StatSyncOptions) => {
    const stats = original(path, options)
    return stats && Object.assign(stats, { birthtimeMs: stats.ctimeMs })
  }) as typeof fs.statSync
  syncBuiltinESMExports()
  t.after(() => {
    fs.statSync = original
    syncBuiltinESMExports()
  })
}

// Waits until exactly `count` fs.watch handles are open; a closed handle is
// counted out once Node has released it.
async function openWatches(spy: { open: () => number }, count: number): Promise<void> {
  await poll(
    () => `${count} open fs.watch handle(s), not ${spy.open()}`,
    () => (spy.open() === count ? true : undefined),
  )
}

test('a watched file reports its own path after each atomic rename', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const head = join(gitDir(), 'HEAD')
    await watchLive(app, 'head', head, head)

    for (const [index, branch] of ['a', 'b', 'c'].entries()) {
      gitUpdate(head, `ref: refs/heads/${branch}\n`)
      assert.deepEqual(await nextChange(app, 'head', index), [head])
      // Let the debounce window close so the next rename is its own batch.
      await delay(250)
    }
    // The lock file next to HEAD is never reported for a HEAD watch.
    assert.ok(changes(app, 'head').every((paths) => paths.every((path) => path === head)))
    await app.request('fs/unwatch', { watchId: 'head' })
  })
})

test('a missing file can be watched and fires once it appears', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const fetchHead = join(gitDir(), 'FETCH_HEAD')
    await watchLive(app, 'fetch', fetchHead, fetchHead)
    rmSync(fetchHead)
    await delay(300)
    app.messages.splice(
      0,
      app.messages.length,
      ...app.messages.filter((m) => m.method !== 'fs/changed'),
    )

    gitUpdate(fetchHead, 'abc\tbranch main\n')
    assert.deepEqual(await nextChange(app, 'fetch', 0), [fetchHead])
    await app.request('fs/unwatch', { watchId: 'fetch' })
  })
})

test('a symlinked file reports its own path when its target changes, also once re-pointed', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const root = tempRoot()
    for (const dir of ['dotfiles', 'home', 'other']) mkdirSync(join(root, dir))
    const target = join(root, 'dotfiles', 'config.toml')
    writeFileSync(target, 'model = "a"\n')
    const link = join(root, 'home', 'config.toml')
    symlinkSync(target, link)
    // A write to the target, in another folder, is a change of the link.
    await watchLive(app, 'cfg', link, target)
    gitUpdate(target, 'model = "b"\n')
    assert.deepEqual(await nextChange(app, 'cfg', 0), [link])
    await delay(250)

    // Replacing the link is a change too, and the watch moves to the new target.
    const moved = join(root, 'other', 'config.toml')
    writeFileSync(moved, 'model = "c"\n')
    symlinkSync(moved, `${link}.tmp`)
    renameSync(`${link}.tmp`, link)
    assert.deepEqual(await nextChange(app, 'cfg', 1), [link])
    await delay(250)
    assert.deepEqual(
      await probeChange(app, 'cfg', (attempt) => writeFileSync(moved, `model = "${attempt}"\n`)),
      [link],
    )
    await app.request('fs/unwatch', { watchId: 'cfg' })
  })
})

test('a file whose folder does not exist yet is watched from the nearest existing one', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const git = join(tempRoot(), '.git')
    const head = join(git, 'HEAD')
    assert.deepEqual(await app.request('fs/watch', { watchId: 'head', path: head }), { path: head })
    // `git init` creates .git and HEAD at once; touch .git until the watch sees it.
    const init = await probeChange(app, 'head', (attempt) => {
      if (attempt > 0) {
        utimesSync(git, new Date(), new Date())
      } else {
        mkdirSync(git)
        writeFileSync(head, 'ref: refs/heads/main\n')
      }
    })
    assert.deepEqual(init, [head])
    await delay(300)
    // From then on the watch follows HEAD in the new .git.
    const update = await probeChange(app, 'head', () => gitUpdate(head, 'ref: refs/heads/a\n'))
    assert.deepEqual(update, [head])
    await app.request('fs/unwatch', { watchId: 'head' })
  })
})

test('a watched file recovers when its folder is deleted and created again, leaking no watches', async (t) => {
  const spy = spyOnWatch(t)
  await withInProcessApp(new MockRuntime(), async (app) => {
    const git = gitDir()
    const project = dirname(git)
    const head = join(git, 'HEAD')
    await watchLive(app, 'head', head, head)
    assert.deepEqual(spy.paths, [git])

    for (const branch of ['a', 'b', 'c']) {
      // `rm -rf .git`: HEAD is gone.
      const seen = changes(app, 'head').length
      rmSync(git, { recursive: true })
      assert.deepEqual(await nextChange(app, 'head', seen), [head])
      // `git init`: touch .git until the watch sees it.
      const init = await probeChange(app, 'head', (attempt) => {
        if (attempt > 0) {
          utimesSync(git, new Date(), new Date())
        } else {
          mkdirSync(git)
          writeFileSync(head, 'ref: refs/heads/main\n')
        }
      })
      assert.deepEqual(init, [head])
      // The watch moved up to the project folder when .git was deleted, and
      // back down into the new one. On Linux a watch stays with the folder it
      // started on, so one left on the deleted .git would see nothing more.
      assert.deepEqual(spy.paths.slice(-2), [project, git])
      // The watch follows HEAD in the new .git, the only watch left open.
      const update = await probeChange(app, 'head', () =>
        gitUpdate(head, `ref: refs/heads/${branch}\n`),
      )
      assert.deepEqual(update, [head])
      await openWatches(spy, 1)
    }
    await app.request('fs/unwatch', { watchId: 'head' })
    await openWatches(spy, 0)
  })
})

test('a watched file recovers when its folder is replaced before the watch sees the deletion', async (t) => {
  const spy = spyOnWatch(t)
  await withInProcessApp(new MockRuntime(), async (app) => {
    const git = gitDir()
    const head = join(git, 'HEAD')
    await watchLive(app, 'head', head, head)

    for (const branch of ['a', 'b', 'c', 'd', 'e']) {
      // `rm -rf .git && git init` in one go: the watch handles the deletion
      // once the new .git is there, which on ext4 often has the inode number
      // of the old one.
      const seen = changes(app, 'head').length
      const watches = spy.paths.length
      rmSync(git, { recursive: true })
      mkdirSync(git)
      writeFileSync(head, 'ref: refs/heads/main\n')
      assert.deepEqual(await nextChange(app, 'head', seen), [head])
      // The watch moves to the new .git: on Linux the old one is dead.
      await poll('a watch on the new .git', () => (spy.paths.length > watches ? true : undefined))
      assert.deepEqual(spy.paths.slice(watches), [git])
      const update = await probeChange(app, 'head', () =>
        gitUpdate(head, `ref: refs/heads/${branch}\n`),
      )
      assert.deepEqual(update, [head])
      await openWatches(spy, 1)
    }
    await app.request('fs/unwatch', { watchId: 'head' })
    await openWatches(spy, 0)
  })
})

test('files coming and going beside a watched file do not report it, also without statx', async (t) => {
  // Without statx each file created or removed in .git changes the birth
  // time Node reports for it, so the watch starts again on the same folder.
  birthTimeIsChangeTime(t)
  const spy = spyOnWatch(t)
  await withInProcessApp(new MockRuntime(), async (app) => {
    const git = gitDir()
    const head = join(git, 'HEAD')
    await watchLive(app, 'head', head, head)
    const seen = changes(app, 'head').length
    const watches = spy.paths.length
    // `git status` a few times: index.lock comes and goes, HEAD stays.
    for (let index = 0; index < 3; index++) {
      writeFileSync(join(git, 'index.lock'), '')
      rmSync(join(git, 'index.lock'))
    }
    await poll('the watch to start again on .git', () =>
      spy.paths.length > watches ? true : undefined,
    )
    assert.deepEqual(spy.paths.slice(watches, watches + 1), [git])
    // A report would have been due one debounce window after the watch
    // started again, so before this wait ends.
    await delay(FS_WATCH_DEBOUNCE_MS * 2)
    assert.equal(changes(app, 'head').length, seen)
    // HEAD itself changing is still reported.
    const update = await probeChange(app, 'head', () => gitUpdate(head, 'ref: refs/heads/a\n'))
    assert.deepEqual(update, [head])
    await openWatches(spy, 1)
    await app.request('fs/unwatch', { watchId: 'head' })
    await openWatches(spy, 0)
  })
})

test('a folder created just before the watch on its parent starts is not missed', async (t) => {
  const root = tempRoot()
  const a = join(root, 'a')
  const b = join(a, 'b')
  const head = join(b, 'HEAD')
  // `mkdir -p a/b` racing the watch: b appears after the watch found a without
  // it but before the watch on a starts, so that watch never reports b. (On
  // macOS the event may still come late; it is dropped, as Linux never sends it.)
  const spy = spyOnWatch(t, (path, listener, start) => {
    if (path !== a || existsSync(b)) return start(listener)
    mkdirSync(b)
    return start((eventType, filename) => {
      if (filename !== 'b') listener(eventType, filename)
    })
  })
  await withInProcessApp(new MockRuntime(), async (app) => {
    assert.deepEqual(await app.request('fs/watch', { watchId: 'head', path: head }), { path: head })
    assert.deepEqual(spy.paths, [root])
    // Touch a until the watch on the temp folder sees it.
    await poll(
      'the watch to move down to a',
      () => (spy.paths.includes(a) ? true : undefined),
      (attempt) => {
        if (attempt > 0) utimesSync(a, new Date(), new Date())
        else mkdirSync(a)
      },
    )
    // Once it watches a, the watch checks again and moves on to b at once.
    assert.deepEqual(spy.paths, [root, a, b])
    const update = await probeChange(app, 'head', (attempt) => writeFileSync(head, `${attempt}\n`))
    assert.deepEqual(update, [head])
    await openWatches(spy, 1)
    await app.request('fs/unwatch', { watchId: 'head' })
    await openWatches(spy, 0)
  })
})

test('a folder gone again before its watch starts leaves the watch where it was', async (t) => {
  const root = tempRoot()
  const a = join(root, 'a')
  const b = join(a, 'b')
  const head = join(b, 'HEAD')
  mkdirSync(a)
  // b appears once the watch on a starts, so the check after it finds b, and
  // is gone again before the watch on b starts, which then fails.
  let raced = false
  const spy = spyOnWatch(t, (path, listener, start) => {
    if (!raced && path === a) mkdirSync(b)
    if (!raced && path === b) {
      raced = true
      rmSync(b, { recursive: true })
    }
    return start(listener)
  })
  await withInProcessApp(new MockRuntime(), async (app) => {
    assert.deepEqual(await app.request('fs/watch', { watchId: 'head', path: head }), { path: head })
    assert.deepEqual(spy.paths, [a, b])
    await openWatches(spy, 1)
    // The watch stayed on a and still moves down once b is there.
    const init = await probeChange(app, 'head', (attempt) => {
      if (attempt > 0) {
        utimesSync(b, new Date(), new Date())
      } else {
        mkdirSync(b)
        writeFileSync(head, 'ref: refs/heads/main\n')
      }
    })
    assert.deepEqual(init, [head])
    assert.equal(spy.paths.at(-1), b)
    await openWatches(spy, 1)
    await app.request('fs/unwatch', { watchId: 'head' })
    await openWatches(spy, 0)
  })
})

test('a file right under / is matched although libuv on macOS reports it as /name', async (t) => {
  const path = join('/', `claude-codex-fs-watch-${process.pid}`)
  assert.equal(existsSync(path), false)
  // A test cannot create entries in /, so the watch on / is replaced by one
  // that reports such an entry the way libuv on macOS does.
  let report: Listener | undefined
  spyOnWatch(t, (dir, listener, start) => {
    if (dir !== '/') return start(listener)
    report = listener
    return Object.assign(new EventEmitter(), { close: () => {} }) as unknown as FSWatcher
  })
  await withInProcessApp(new MockRuntime(), async (app) => {
    assert.deepEqual(await app.request('fs/watch', { watchId: 'top', path }), { path })
    assert.ok(report, 'the watch is on /')
    report('rename', path)
    assert.deepEqual(await nextChange(app, 'top', 0), [path])
    await app.request('fs/unwatch', { watchId: 'top' })
  })
})

test('a watched directory reports the changed entry under the requested path', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const git = gitDir()
    await watchLive(app, 'git', git, join(git, '.probe'))

    writeFileSync(join(git, 'ORIG_HEAD'), 'abc\n')
    const changed = await nextChange(app, 'git', 0)
    assert.ok(changed.includes(join(git, 'ORIG_HEAD')), JSON.stringify(changed))
    await app.request('fs/unwatch', { watchId: 'git' })
  })
})

test('bursts of events for one watch arrive as one fs/changed', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const head = join(gitDir(), 'HEAD')
    await watchLive(app, 'head', head, head)
    for (let index = 0; index < 5; index++) writeFileSync(head, `ref: refs/heads/b${index}\n`)
    assert.deepEqual(await nextChange(app, 'head', 0), [head])
    await delay(300)
    assert.equal(changes(app, 'head').length, 1)
    await app.request('fs/unwatch', { watchId: 'head' })
  })
})

test('a watchId already in use is refused and the first watch keeps working', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const git = gitDir()
    const head = join(git, 'HEAD')
    await watchLive(app, 'head', head, head)
    const reply = await app.call('fs/watch', { watchId: 'head', path: git })
    assert.equal(reply.error?.code, INVALID_REQUEST)
    assert.equal(reply.error?.message, 'watchId already exists: head')

    gitUpdate(head, 'ref: refs/heads/a\n')
    assert.deepEqual(await nextChange(app, 'head', 0), [head])
    await app.request('fs/unwatch', { watchId: 'head' })
    // An unwatched id can be used again.
    await app.request('fs/watch', { watchId: 'head', path: head })
    await app.request('fs/unwatch', { watchId: 'head' })
  })
})

test('watch ids are per connection: reuse across connections, refusal within one, unwatch scoped', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const head = join(gitDir(), 'HEAD')
    const other: RpcPeer = { id: 'other', send: () => {}, close: () => {} }
    const send = (peer: RpcPeer, id: string, method: string, params: Record<string, unknown>) =>
      app.server.handle(peer, { jsonrpc: '2.0', id, method, params } as WireMessage)

    await watchLive(app, 'head', head, head)
    // Another connection may use the same id...
    await send(other, 'o1', 'fs/watch', { watchId: 'head', path: head })
    // ...and its unwatch leaves the owner's watch alone.
    await send(other, 'o2', 'fs/unwatch', { watchId: 'head' })
    // The owner still cannot reuse its own id.
    const reply = await app.call('fs/watch', { watchId: 'head', path: head })
    assert.equal(reply.error?.code, INVALID_REQUEST)

    // Foreign unwatch of the owner's id (never watched by `other` now) is a no-op.
    await send(other, 'o3', 'fs/unwatch', { watchId: 'head' })
    gitUpdate(head, 'ref: refs/heads/z\n')
    assert.deepEqual(await nextChange(app, 'head', 0), [head])

    app.server.closePeer(other)
    await app.request('fs/unwatch', { watchId: 'head' })
  })
})
