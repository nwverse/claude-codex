import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { jsonFileTarget, replaceJsonFile } from './json-file.mjs'
import { adapterHome, debugLog } from './util.mjs'

// CLI reports are shared by all adapters using the home. Keep the JSON format
// used by older installations and reserve its entire read/modify/write step.
export class SharedClaudeCatalog<T> {
  private readonly filename: string
  private readonly decode: (json: Record<string, unknown>) => T
  private cached: { path: string; stamp: string; value: T } | null = null

  constructor(filename: string, decode: (json: Record<string, unknown>) => T) {
    this.filename = filename
    this.decode = decode
  }

  read(): T {
    const path = join(adapterHome(), this.filename)
    try {
      return this.load(path)
    } catch (error) {
      debugLog('claudeCatalog.readFailed', { filename: this.filename, message: String(error) })
      return this.cached?.path === path ? this.cached.value : this.decode({})
    }
  }

  update(edit: (draft: T, save: () => void) => void): void {
    const path = join(adapterHome(), this.filename)
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const target = jsonFileTarget(path)
      // Loading SQLite lazily keeps CLI probes independent of the catalog.
      const { DatabaseSync } = process.getBuiltinModule(
        'node:sqlite',
      ) as typeof import('node:sqlite')
      const lock = new DatabaseSync(target + '.lock.sqlite', { timeout: 5000 })
      try {
        lock.exec('BEGIN IMMEDIATE')
        const draft = structuredClone(this.load(path))
        edit(draft, () => replaceJsonFile(target, draft))
      } finally {
        lock.close()
      }
    } catch (error) {
      debugLog('claudeCatalog.saveFailed', { filename: this.filename, message: String(error) })
    }
  }

  private load(path: string): T {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false })
    const stamp = stat ? [stat.dev, stat.ino, stat.mtimeNs, stat.size].join(':') : ''
    if (this.cached?.path === path && this.cached.stamp === stamp) return this.cached.value
    let data: Record<string, unknown> = {}
    if (stat) {
      const text = readFileSync(path, 'utf8')
      try {
        data = JSON.parse(text) ?? {}
      } catch {
        // Incomplete catalogs from older versions can be regenerated on the next CLI report.
      }
    }
    const value = this.decode(data)
    this.cached = { path, stamp, value }
    return value
  }
}
