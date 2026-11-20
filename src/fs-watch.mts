import { type FSWatcher, lstatSync, realpathSync, statSync, watch } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { debugLog } from './util.mjs'

// Codex coalesces a watch's events over this window before it sends
// `fs/changed` (codex-rs/app-server/src/fs_watch.rs).
export const FS_WATCH_DEBOUNCE_MS = 200

export interface PathWatch {
  close(): void
}

// Watches `path` the way Codex's `fs/watch` does: non-recursively, reporting
// paths under the requested path rather than its realpath. A directory is
// watched itself, and each change is reported as the entry inside it. A file,
// or a path that does not exist yet (FETCH_HEAD before the first fetch), is
// watched through its parent directory, so the watch survives the file being
// replaced by a rename (git's `HEAD.lock` -> `HEAD`) and fires once it appears.
// A symlinked file is also watched where its target lives, since writes to it
// happen there.
// Throws when neither the path nor any of its ancestors can be watched.
export function watchPath(
  path: string,
  onChange: (changedPaths: string[]) => void,
  debounceMs = FS_WATCH_DEBOUNCE_MS,
): PathWatch {
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  const changed = (changedPath: string): void => {
    pending.add(changedPath)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const paths = [...pending]
      pending.clear()
      onChange(paths)
    }, debounceMs)
    timer.unref()
  }
  const stopTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    pending.clear()
  }

  if (isDirectory(path)) {
    const watcher = watch(path, { persistent: false }, (_eventType, filename) => {
      changed(filename ? join(path, String(filename)) : path)
    })
    logErrors(watcher, path)
    return {
      close: () => {
        watcher.close()
        stopTimer()
      },
    }
  }

  // The link's target, looked up again whenever the link itself changes.
  let target: { path: string; close: () => void } | null = null
  const followLink = (): void => {
    const real = symlinkTarget(path)
    if (real === (target?.path ?? null)) return
    target?.close()
    target = null
    if (real === null) return
    try {
      target = { path: real, close: watchEntry(real, () => changed(path)) }
    } catch (error) {
      debugLog('fs_watch_error', { path: real, error: String(error) })
    }
  }
  const closeEntry = watchEntry(path, () => {
    followLink()
    changed(path)
  })
  followLink()
  return {
    close: () => {
      closeEntry()
      target?.close()
      stopTimer()
    },
  }
}

// Calls `onEntry` on each event for the entry at `path` (a file, a symlink, or
// a path that does not exist yet), watched through its parent directory so a
// rename over it is seen too. While the parent is missing as well (.git/HEAD
// before `git init`), the nearest existing ancestor is watched, as Codex does,
// and the watch moves down as the missing directories appear. Returns the
// function that closes the watch.
function watchEntry(path: string, onEntry: () => void): () => void {
  const parent = dirname(path)
  let watcher: FSWatcher | null = null
  let watched = ''
  const anchor = (): void => {
    const dir = nearestDirectory(parent)
    if (dir === watched) return
    // The entry's own name, or the first missing directory on the way to it.
    const name = relative(dir, path).split(sep)[0]
    const next = watch(dir, { persistent: false }, (_eventType, filename) => {
      // Without a filename the event may be about the entry; report it.
      if (filename && String(filename) !== name) return
      if (dir === parent) {
        onEntry()
        return
      }
      try {
        anchor()
      } catch (error) {
        debugLog('fs_watch_error', { path, error: String(error) })
      }
      // The entry may have been created before the watch moved down to it.
      if (entryExists(path)) onEntry()
    })
    logErrors(next, dir)
    watcher?.close()
    watcher = next
    watched = dir
  }
  anchor()
  return () => watcher?.close()
}

// A watched directory that goes away errors the watcher. Unhandled, that error
// would end the process; the watch just stops instead.
function logErrors(watcher: FSWatcher, path: string): void {
  watcher.on('error', (error) => debugLog('fs_watch_error', { path, error: String(error) }))
}

// The realpath of a symlink at `path`; null when `path` is not a symlink or
// the link is dangling.
function symlinkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : null
  } catch {
    return null
  }
}

function nearestDirectory(path: string): string {
  let dir = path
  while (!isDirectory(dir) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
