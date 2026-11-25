import { createHash } from 'node:crypto'
import { collect } from './owner.mjs'
import { clipInput, light, page } from './sdk.mjs'

const hash = (v) => createHash('sha256').update(v).digest('hex')
const iso = (t) => new Date((t ?? 0) * 1000).toISOString()
const printable = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''))
export function viewItem(it, turn, stamp) {
  const id = hash(`${turn.id}\0${it.id}`).slice(0, 36),
    ts = iso(stamp || turn.startedAt)
  const text = (role, kind, body, extra = {}) => ({ id, ts, role, kind, text: body, ...extra })
  function tool(name, input, output, failed = false) {
    const entry = {
      id,
      ts,
      role: 'assistant',
      kind: 'tool_use',
      tool_use_id: it.id,
      tool_name: name,
      tool_input: clipInput(input ?? {}),
    }
    return output == null
      ? [entry]
      : [
          entry,
          {
            id: `${id}.out`,
            ts,
            role: 'user',
            kind: 'tool_result',
            tool_use_id: it.id,
            text: printable(output),
            ...(failed ? { outcome: { status: 'failed' } } : {}),
          },
        ]
  }
  switch (it.type) {
    case 'userMessage': {
      const content = (it.content ?? [])
        .map((x, i) => {
          if (x.type === 'text' && x.text)
            return text('user', 'text', x.text, {
              id: `${id}.${i}`,
              ...(it.clientId ? { client_msg_id: it.clientId } : {}),
            })
          if (x.type === 'image' && typeof x.url === 'string' && x.url.startsWith('data:image/')) {
            const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(x.url)
            if (m)
              return {
                id: `${id}.${i}`,
                ts,
                role: 'user',
                kind: 'image',
                image: { mime: m[1], data: m[2] },
              }
          }
          if (x.type === 'localImage')
            return text('user', 'text', `[Image] ${x.path || ''}`, { id: `${id}.${i}` })
          if (x.type === 'mention' || x.type === 'skill')
            return text('user', 'text', x.name || x.path || '', { id: `${id}.${i}` })
          return null
        })
        .filter(Boolean)
      return content
    }
    case 'agentMessage':
      return it.text ? [text('assistant', 'text', it.text)] : []
    case 'reasoning': {
      const t = (it.summary?.length ? it.summary : (it.content ?? []))
        .map((x) => (typeof x === 'string' ? x : (x.text ?? '')))
        .join('\n')
      return t ? [text('assistant', 'thinking', t)] : []
    }
    case 'commandExecution':
      return tool(
        'Bash',
        { command: it.command, cwd: it.cwd },
        it.aggregatedOutput,
        it.exitCode != null && it.exitCode !== 0,
      )
    case 'fileChange':
      return tool('Edit', { changes: it.changes }, it.status)
    case 'mcpToolCall':
      return tool(
        `mcp__${it.server}__${it.tool}`,
        it.arguments,
        it.result?.content?.map((x) => x.text ?? '').join('\n') ?? it.error,
        it.status === 'failed',
      )
    case 'dynamicToolCall':
      return tool(
        it.tool,
        it.arguments,
        it.contentItems?.map((x) => x.text ?? '').join('\n'),
        it.success === false,
      )
    case 'collabAgentToolCall':
      return tool(
        it.tool,
        { prompt: it.prompt, receiver_thread_ids: it.receiverThreadIds },
        it.agentsStates,
      )
    case 'subAgentActivity':
      return [
        text(
          'assistant',
          'notice',
          [it.kind, it.agentPath || it.agentThreadId].filter(Boolean).join(' · '),
        ),
      ]
    case 'imageView':
      return tool('Read', { file_path: it.path })
    case 'webSearch':
      return tool('WebSearch', { query: it.query }, it.results)
    case 'plan':
      return [text('assistant', 'text', it.text || printable(it.plan))]
    case 'contextCompaction':
      return [text('system', 'notice', 'Context compacted')]
    default:
      return [text('system', 'notice', it.type || 'Thread event')]
  }
}
export class History {
  constructor(owner) {
    this.owner = owner
    this.byId = new Map()
    this.pending = new Map()
  }
  async read(id, force = false) {
    const old = this.byId.get(id)
    if (!force && old && Date.now() - old.checked < 1200) return old
    if (!this.pending.has(id))
      this.pending.set(
        id,
        this.fetch(id, old).finally(() => this.pending.delete(id)),
      )
    return this.pending.get(id)
  }
  async fetch(id, old, retries = 1) {
    const c = await this.owner.connect()
    const turnPage = {
      threadId: id,
      sortDirection: 'asc',
      itemsView: 'notLoaded',
      limit: 100,
    }
    const turns = await collect(c, 'thread/turns/list', turnPage)
    const chunks = [],
      items = []
    let seq = 0
    for (const turn of turns) {
      const header = hash(JSON.stringify([turn.id, turn.status, turn.completedAt, turn.error]))
      const prior = old?.chunks.find((x) => x.header === header)
      let chunk
      if (prior && turn.status !== 'inProgress' && Date.now() - prior.at < 60000) chunk = prior
      else {
        const entries = await collect(c, 'thread/items/list', {
          threadId: id,
          turnId: turn.id,
          sortDirection: 'asc',
          limit: 192,
        })
        const rendered = [],
          keys = new Set()
        for (const entry of entries) {
          if (entry.turnId !== turn.id || !entry.item?.id)
            throw new Error('Item does not belong to the requested turn')
          if (keys.has(entry.item.id)) throw new Error('History changed while reading its items')
          keys.add(entry.item.id)
          rendered.push(
            ...viewItem(entry.item, turn, entry.startedAtMs ? entry.startedAtMs / 1000 : 0),
          )
        }
        if (turn.status === 'failed' || turn.status === 'interrupted')
          rendered.push({
            id: `${turn.id}.status`,
            ts: iso(turn.completedAt ?? turn.startedAt),
            role: 'system',
            kind: 'notice',
            text:
              turn.error?.message ||
              (turn.status === 'failed' ? 'Turn failed' : 'Turn interrupted'),
          })
        chunk = { header, items: rendered, at: Date.now() }
      }
      chunks.push(chunk)
      for (const it of chunk.items) items.push({ ...it, seq: ++seq })
    }
    const confirmed = await collect(c, 'thread/turns/list', turnPage)
    const lifecycle = (list) =>
      JSON.stringify(list.map((t) => [t.id, t.startedAt, t.completedAt, t.status, t.error]))
    if (lifecycle(turns) !== lifecycle(confirmed)) {
      if (retries > 0) return this.fetch(id, old, retries - 1)
      throw new Error('History changed while reading its turns')
    }
    const fingerprints = items.map((it) => hash(JSON.stringify(it)))
    const append =
      old &&
      old.fingerprints.length <= fingerprints.length &&
      old.fingerprints.every((v, i) => v === fingerprints[i])
    const history = append
      ? old.history
      : `cc:${id}:${hash(JSON.stringify(fingerprints)).slice(0, 20)}`
    const result = { items, chunks, fingerprints, history, toSeq: seq, checked: Date.now() }
    this.byId.delete(id)
    this.byId.set(id, result)
    if (this.byId.size > 12) this.byId.delete(this.byId.keys().next().value)
    return result
  }
  async items(id, params) {
    const s = await this.read(id),
      result = page(s.items, params, s)
    if (params.lazy_images)
      result.items = result.items.map((i) =>
        i.image?.data
          ? {
              ...i,
              image: {
                mime: i.image.mime,
                lazy: true,
                size: Buffer.byteLength(i.image.data, 'base64'),
              },
            }
          : i,
      )
    return result
  }
  async push(id, pub, prior, rt) {
    const s = await this.read(id)
    if (!prior || s.history !== prior.history) {
      const tail = s.items.slice(-80)
      rt.append(pub, {
        history: s.history,
        fromSeq: tail.length ? tail[0].seq - 1 : 0,
        toSeq: s.toSeq,
        items: tail.map(light),
      })
    } else if (s.toSeq > prior.toSeq)
      rt.append(pub, {
        history: s.history,
        fromSeq: prior.toSeq,
        toSeq: s.toSeq,
        items: s.items.slice(prior.toSeq).map(light),
      })
    return { history: s.history, toSeq: s.toSeq }
  }
}
