import { readFileSync, statSync } from 'node:fs'

// Optional local signal for a remote Codex desktop connection. Only a transition
// out of the unread set for the same identity, host and completed turn is a read.
// A missing identity, unreadable file, or the first snapshot proves nothing.
export class DesktopReads {
  constructor(file) {
    this.file = file
    this.mark = ''
    this.hosts = new Map()
    this.pending = new Map()
  }
  update(turns, seen) {
    if (!this.file) return
    try {
      const st = statSync(this.file)
      const mark = `${st.mtimeMs}:${st.size}`
      if (mark !== this.mark) {
        const state = JSON.parse(readFileSync(this.file, 'utf8'))
        const accounts = state?.['electron-thread-read-state-v1']?.unreadByIdentity
        if (!accounts || typeof accounts !== 'object') return
        const hosts = new Map()
        for (const [account, entries] of Object.entries(accounts)) {
          for (const [host, ids] of Object.entries(entries ?? {})) {
            if (host.startsWith('local:') || !Array.isArray(ids)) continue
            const key = JSON.stringify([account, host])
            const unread = new Set(ids)
            for (const [id, turn] of this.pending.get(key) ?? []) {
              if (!unread.has(id) && turns.get(id) === turn) seen(id, turn)
            }
            hosts.set(key, unread)
          }
        }
        this.hosts = hosts
        this.mark = mark
      }
      this.pending.clear()
      for (const [host, ids] of this.hosts) {
        const current = new Map()
        for (const id of ids) if (turns.has(id)) current.set(id, turns.get(id))
        this.pending.set(host, current)
      }
    } catch {
      // The desktop app may be replacing its state file. Retry at the next poll.
    }
  }
}
