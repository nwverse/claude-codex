import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

export const publicId = (home, id) =>
  'c0de-' +
  createHash('sha256').update(`jarvis/codex/thread/v1\0${home}\0${id}`).digest('hex').slice(0, 32)
export class Owner {
  constructor(home, socket, onEvent, onClose) {
    this.home = realpathSync(home)
    this.socket = socket ?? path.join(this.home, 'app-server-control', 'app-server-control.sock')
    this.event = onEvent
    this.lost = onClose
    this.next = 0
  }
  async connect() {
    if (!this.connection) this.connection = this.open()
    return this.connection
  }
  async open() {
    const ws = new WebSocket(`ws+unix://${this.socket}`, { handshakeTimeout: 5000 })
    const pending = new Map()
    const client = {
      generation: randomUUID(),
      call: (method, params = {}) =>
        new Promise((resolve, reject) => {
          if (ws.readyState !== ws.OPEN) {
            reject(new Error('The adapter is offline'))
            return
          }
          const id = ++this.next
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('The adapter request timed out'))
          }, 20000)
          pending.set(id, { resolve, reject, timer })
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        }),
      respond: (id, result) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
      },
    }
    ws.on('error', () => {})
    ws.on('close', () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('The adapter disconnected'))
      }
      pending.clear()
      this.connection = null
      this.lost?.()
    })
    ws.on('message', (raw) => {
      let m
      try {
        m = JSON.parse(raw)
      } catch {
        return
      }
      if (m.method) {
        Promise.resolve(this.event?.(client, m)).catch(() => {})
        return
      }
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error) {
        const e = new Error(m.error.message)
        e.rpcCode = m.error.code
        p.reject(e)
      } else p.resolve(m.result)
    })
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const info = await client.call('initialize', {
        clientInfo: { name: 'persona-runtime', version: '1' },
        capabilities: { experimentalApi: true },
      })
      if (
        !info.codexHome ||
        realpathSync(info.codexHome) !== this.home ||
        !info.userAgent?.includes(') claude-codex (')
      )
        throw new Error('The socket does not belong to the expected claude-codex home')
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))
      return client
    } catch (e) {
      ws.terminate()
      throw e
    }
  }
  async rows(archived = false) {
    const c = await this.connect()
    return collect(c, 'thread/list', { archived, limit: 100 })
  }
}
export async function collect(client, method, params) {
  const data = [],
    cursors = new Set()
  let cursor
  do {
    const p = await client.call(method, { ...params, ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(p.data)) throw new Error('Invalid page from the adapter')
    data.push(...p.data)
    cursor = p.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('Repeated cursor from the adapter')
    cursors.add(cursor)
  } while (cursor)
  return data
}
