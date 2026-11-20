import { type FSWatcher, lstatSync, realpathSync, type Stats, statSync, watch } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
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
// before `git init`), the nearest existing ancestor is watched. As Codex does,
// that folder is picked again on every event, so the watch moves down as the
// missing directories appear and back up when one on the way is deleted
// (`rm -rf .git && git init`). Returns the function that closes the watch.
function watchEntry(path: string, onEntry: () => void): () => void {
  const parent = dirname(path)
  // Never null again once set: onEvent relies on anchor() not throwing then,
  // and an exception in an fs.watch listener would end the adapter.
  let watcher: FSWatcher | null = null
  let watched: Folder | null = null
  // The entry as last reported, so that a move reports it only if it changed.
  let reported = ''
  // Watches the nearest existing folder unless it is watched already, then
  // checks again: a folder further down may have appeared before the new
  // watch started. At most one move per level, so a folder that keeps being
  // replaced cannot hold it here. Throws only when no watch could start; a
  // move that fails (the folder gone again, or out of watches) keeps the
  // current watch.
  const anchor = (): void => {
    for (let level = path.split(sep).length; level > 0; level--) {
      const dir = nearestFolder(parent)
      if (dir.path === watched?.path && dir.id === watched.id) return
      // The entry's own name, or the first missing directory on the way to it.
      const name = relative(dir.path, path).split(sep)[0] ?? ''
      let next: FSWatcher
      try {
        next = watch(dir.path, { persistent: false }, (_eventType, filename) => {
          onEvent(dir.path === parent && isEntryEvent(filename, name))
        })
      } catch (error) {
        if (!watcher) throw error
        debugLog('fs_watch_error', { path: dir.path, error: String(error) })
        return
      }
      logErrors(next, dir.path)
      watcher?.close()
      watcher = next
      watched = dir
    }
  }
  const onEvent = (aboutEntry: boolean): void => {
    const was = watched
    anchor()
    // After a move the entry may have appeared (created before the watch got
    // down to it) or be gone with the folder the watch was on. A new watch on
    // the same folder, as without statx, leaves it as it was.
    if (!aboutEntry && (watched === was || entryStamp(path) === reported)) return
    reported = entryStamp(path)
    onEntry()
  }
  anchor()
  reported = entryStamp(path)
  return () => watcher?.close()
}

// Whether an event in a watched folder may be about its entry `name`; one
// without a filename may be. When the folder is `/`, libuv on macOS reports
// the entry as `/name`.
function isEntryEvent(filename: string | null, name: string): boolean {
  return !filename || basename(filename) === name
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

// An existing folder. `id` tells it apart from one created later at the same
// path, since on Linux a watch stays with the folder it was started on. The
// birth time is part of it because ext4 often gives a folder created right
// after another was deleted the old inode number. Where Linux lacks statx,
// Node reports the change time as birth time, so each entry created or
// removed in the folder starts a new watch on it; the re-check after it finds
// the same folder, and the watched entry is reported only if it changed.
interface Folder {
  path: string
  id: string
}

// The nearest existing folder at or above `path`.
function nearestFolder(path: string): Folder {
  for (let dir = path; ; dir = dirname(dir)) {
    const stats = directoryStats(dir)
    if (stats) return { path: dir, id: `${stats.dev}:${stats.ino}:${stats.birthtimeMs}` }
    if (dirname(dir) === dir) return { path: dir, id: '' }
  }
}

// What tells a change of the entry at `path`; '' while it is missing. The
// change time is in it because a program can copy a modification time but
// not a change time, and siblings coming and going leave both alone.
function entryStamp(path: string): string {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false })
    return stats ? `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}` : ''
  } catch {
    return ''
  }
}

function isDirectory(path: string): boolean {
  return directoryStats(path) !== undefined
}

// Runs on every event, so a missing folder is not an exception.
function directoryStats(path: string): Stats | undefined {
  try {
    const stats = statSync(path, { throwIfNoEntry: false })
    return stats?.isDirectory() ? stats : undefined
  } catch {
    return undefined
  }
}
