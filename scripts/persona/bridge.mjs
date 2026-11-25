import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isCodexOpenAiModel } from '../../dist/src/util.mjs'
import { DesktopReads } from './desktop-read.mjs'
import { History } from './history.mjs'
import { readModels, selectedModel, settings } from './models.mjs'
import { collect, Owner, publicId } from './owner.mjs'
import { createRuntime, RpcError } from './sdk.mjs'

const env = process.env
if (!env.CODEX_HOME || !path.isAbsolute(env.CODEX_HOME))
  throw new Error('Set CODEX_HOME to the absolute home of the adapter to expose')
const runtime = env.CLAUDE_CODEX_PERSONA_ID || 'claude-codex'
const label = env.CLAUDE_CODEX_PERSONA_NAME || 'Claude Codex'
const state = env.CLAUDE_CODEX_PERSONA_STATE || path.join(env.CODEX_HOME, 'persona-companion')
fs.mkdirSync(state, { recursive: true, mode: 0o700 })
const receipts = new DatabaseSync(path.join(state, 'receipts.sqlite'))
receipts.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS receipts(message TEXT PRIMARY KEY, thread TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS seen(thread TEXT PRIMARY KEY, turn TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS starts(message TEXT PRIMARY KEY, digest TEXT NOT NULL, thread TEXT, draft INTEGER DEFAULT 1)`)
const typed = (message, code = 'unsupported') => new RpcError(message, code)
const fingerprint = (v) => createHash('sha256').update(v).digest('hex')
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const active = new Map(),
  observed = new Set(),
  asks = new Map(),
  watches = new Map(),
  progress = new Map()
let rt,
  catalogPromise,
  catalog = new Map(),
  signature = '',
  online = false,
  polling = false
let models = []
const owner = new Owner(env.CODEX_HOME, env.CLAUDE_CODEX_PERSONA_APP_SERVER, onEvent, () => {
  online = false
  observed.clear()
  for (const c of asks.values()) c.abort()
  asks.clear()
  rt?.sessionsChanged(0)
})
const hist = new History(owner)
const desktopReads = new DesktopReads(env.CLAUDE_CODEX_PERSONA_APP_STATE)
const pub = (id) => publicId(owner.home, id)
function mainThread(t) {
  return (
    uuid.test(t.id) &&
    !t.ephemeral &&
    !t.parentThreadId &&
    t.threadSource !== 'subagent' &&
    !t.source?.subAgent &&
    !isCodexOpenAiModel(t.model || '') &&
    t.modelProvider === 'claude-code'
  )
}
function finished(turn) {
  return turn && ['completed', 'failed', 'interrupted'].includes(turn.status)
}
const markSeen = receipts.prepare('INSERT OR REPLACE INTO seen VALUES (?,?)')
const lastSeen = receipts.prepare('SELECT turn FROM seen WHERE thread=?')
const startedHere = receipts.prepare('SELECT 1 FROM starts WHERE thread=?')
function session(t) {
  const flags = t.status?.activeFlags ?? []
  const active = t.status?.type === 'active'
  const latest = progress.get(t.id)
  const turn = latest?.turn
  const ended = !active && finished(turn) ? (turn.completedAt ?? turn.startedAt) : null
  let status = 'idle'
  if (!online || (!latest && !active)) status = 'offline'
  else if (flags.some((v) => v === 'waitingOnApproval' || v === 'waitingOnUserInput'))
    status = 'blocked'
  else if (active || turn?.status === 'inProgress') status = 'working'
  else if (ended != null && lastSeen.get(t.id)?.turn !== turn.id) status = 'done'
  const model = models.find((m) => m.profile === t.model)
  const available =
    online && Boolean(latest) && !active && turn?.status !== 'inProgress' && Boolean(model)
  const canChangeModel =
    available && models.length > 1 && (!model.processProfile || (latest !== undefined && !turn))
  const at = ended ?? t.updatedAt ?? t.createdAt
  return {
    session_id: pub(t.id),
    codex_thread: t.id,
    title: t.name || t.preview || 'Claude Code',
    cwd: t.cwd,
    agent: 'claude',
    agent_label: 'Claude Code',
    agent_name: label,
    space_id: runtime,
    space_name: label,
    launcher: runtime,
    started_by_persona: Boolean(startedHere.get(t.id)),
    capabilities: {
      modes: available && (model.efforts.length > 0 || canChangeModel),
      model: canChangeModel,
    },
    efforts: available ? model.efforts : [],
    status,
    updated_at: new Date(at * 1000).toISOString(),
    started_at: new Date(t.createdAt * 1000).toISOString(),
    rev: Math.max((t.updatedAt || t.createdAt) * 1000, latest?.rev ?? 0),
    model: model?.id ?? t.model,
    effort: t.reasoningEffort || undefined,
    last_text: latest?.preview,
  }
}
async function refresh() {
  if (!catalogPromise)
    catalogPromise = (async () => {
      const rows = await owner.rows()
      const next = new Map(rows.filter(mainThread).map((t) => [pub(t.id), t]))
      // thread/list hides empty prewarmed threads. Only expose an empty thread
      // when Persona explicitly created it and the owner still has it open.
      let archived
      for (const { thread: id } of receipts
        .prepare('SELECT thread FROM starts WHERE draft=1 AND thread IS NOT NULL')
        .all()) {
        if (next.has(pub(id))) {
          receipts.prepare('UPDATE starts SET draft=0 WHERE thread=?').run(id)
          continue
        }
        archived ??= new Set((await owner.rows(true)).map((t) => t.id))
        if (archived.has(id)) continue
        const client = await owner.connect()
        const reply = await client
          .call('thread/read', { threadId: id, includeTurns: false })
          .catch((e) => {
            if (e.rpcCode !== -32602) throw e
            return {}
          })
        if (reply.thread && reply.thread.id === id && mainThread(reply.thread))
          next.set(pub(id), reply.thread)
      }
      catalog = next
      online = true
      return next
    })().finally(() => {
      catalogPromise = null
    })
  return catalogPromise
}
async function lookup(publicKey, fresh = false, includeArchived = false) {
  if (fresh || !catalog.has(publicKey)) await refresh()
  let t = catalog.get(publicKey)
  if (!t && includeArchived)
    t = (await owner.rows(true)).find((x) => mainThread(x) && pub(x.id) === publicKey)
  if (!t) throw typed('Unknown adapter thread', 'not_found')
  return t
}

function launcherModels() {
  return {
    agent: 'claude',
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      efforts: m.efforts,
      default: m.isDefault,
      default_effort: m.defaultEffort,
    })),
  }
}

let syncing,
  nextModelRead = 0,
  lastLauncher = ''
async function syncCatalog() {
  if (!syncing)
    syncing = (async () => {
      const rows = await refresh()
      if (Date.now() >= nextModelRead) {
        try {
          models = await readModels(await owner.connect())
          nextModelRead = Date.now() + 30000
        } catch {
          models = []
        }
        const launcher = {
          ...launcherModels(),
          name: runtime,
          display_name: label,
          model: models.find((m) => m.isDefault)?.id,
        }
        const mark = JSON.stringify(launcher)
        if (lastLauncher !== mark) {
          rt.launchersChanged(models.length ? [launcher] : [])
          lastLauncher = mark
        }
      }
      const all = [...rows.values()]
      for (let i = 0; i < all.length; i += 4)
        await Promise.allSettled(all.slice(i, i + 4).map(probeProgress))
      const finishedTurns = new Map()
      for (const t of all) {
        const turn = progress.get(t.id)?.turn
        if (t.status?.type !== 'active' && finished(turn)) finishedTurns.set(t.id, turn.id)
      }
      desktopReads.update(finishedTurns, (id, turn) => markSeen.run(id, turn))
      return rows
    })().finally(() => {
      syncing = null
    })
  return syncing
}

function withThread(id, fn) {
  const prior = active.get(id) ?? Promise.resolve()
  const current = prior.catch(() => {}).then(fn)
  active.set(id, current)
  return current.finally(() => {
    if (active.get(id) === current) active.delete(id)
  })
}
async function subscribe(c, t) {
  observed.add(t.id)
  try {
    const r = await c.call('thread/resume', { threadId: t.id, excludeTurns: true })
    if (r.thread?.id !== t.id) throw typed('The adapter resumed a different thread')
  } catch (e) {
    observed.delete(t.id)
    throw e
  }
}
async function recentTurn(c, id) {
  const r = await c.call('thread/turns/list', {
    threadId: id,
    limit: 1,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  })
  return r.data?.[0]
}

async function start(p, driving) {
  if (p.resume || (p.launcher && p.launcher !== runtime))
    throw typed('Select this adapter launcher to create a new thread')
  if (!p.cwd || !path.isAbsolute(p.cwd)) throw typed('An absolute working directory is required')
  if (p.permission_mode && p.permission_mode !== 'default')
    throw typed('This launcher uses the adapter permission defaults')
  const key = p.client_msg_id || p.session_id || randomUUID()
  const digest = fingerprint(JSON.stringify([p.cwd, p.model, p.effort, p.prompt, p.images]))
  return withThread(`start:${key}`, async () => {
    const existing = receipts.prepare('SELECT * FROM starts WHERE message=?').get(key)
    let id = existing?.thread
    if (existing) {
      if (existing.digest !== digest) throw typed('Start ID was reused with different parameters')
      if (!id) throw typed('Previous thread creation is unconfirmed', 'delivery_uncertain')
    } else {
      const c = await owner.connect()
      models = await readModels(c)
      const chosen = selectedModel(models, p.model)
      const params = { cwd: p.cwd, model: chosen.profile, ...settings(chosen, p.effort) }
      // Record the reservation before the RPC. Losing the reply must not create
      // a second thread, even if the companion restarts before the phone retries.
      receipts.prepare('INSERT INTO starts(message,digest) VALUES(?,?)').run(key, digest)
      try {
        const { thread } = await c.call('thread/start', params)
        if (!mainThread(thread) || thread.model !== chosen.profile)
          throw typed('The adapter did not create the requested thread')
        id = thread.id
        receipts.prepare('UPDATE starts SET thread=? WHERE message=?').run(id, key)
      } catch (error) {
        if (error.rpcCode === -32602 || error.rpcCode === -32601)
          receipts.prepare('DELETE FROM starts WHERE message=? AND thread IS NULL').run(key)
        throw error
      }
    }
    const sid = pub(id)
    driving?.(sid)
    if (p.prompt || p.images?.length)
      await send({ session_id: sid, client_msg_id: key, text: p.prompt, images: p.images })
    const thread = await lookup(sid, true)
    await probeProgress(thread)
    return { session: session(thread) }
  })
}
async function send(p) {
  const t = await lookup(p.session_id, true)
  return withThread(t.id, async () => {
    const c = await owner.connect()
    const key = p.client_msg_id
    if (!key) throw typed('A client message ID is required for retry-safe delivery')
    const input = []
    if (p.text) input.push({ type: 'text', text: p.text })
    for (const img of p.images ?? []) {
      if (!/^image\/[a-z0-9.+-]+$/i.test(img.mime || '') || typeof img.data !== 'string')
        throw typed('Invalid image')
      input.push({ type: 'image', url: `data:${img.mime};base64,${img.data}` })
    }
    if (!input.length) throw typed('The message is empty')
    const digest = fingerprint(JSON.stringify(input))
    const prior = receipts.prepare('SELECT * FROM receipts WHERE message=?').get(key)
    if (prior) {
      if (prior.thread !== t.id || prior.digest !== digest)
        throw typed('Message ID was reused with different content')
      if (prior.status === 'done') return
      const view = await hist.read(t.id, true)
      if (view.items.some((i) => i.client_msg_id === key)) {
        receipts.prepare("UPDATE receipts SET status='done' WHERE message=?").run(key)
        return
      }
      throw typed('Previous delivery is unconfirmed', 'delivery_uncertain')
    }
    await subscribe(c, t)
    const turn = await recentTurn(c, t.id)
    const steer = turn?.status === 'inProgress'
    const params = {
      threadId: t.id,
      input,
      clientUserMessageId: key,
      ...(steer ? { expectedTurnId: turn.id } : {}),
    }
    receipts.prepare("INSERT INTO receipts VALUES(?,?,?,'pending')").run(key, t.id, digest)
    try {
      const reply = await c.call(steer ? 'turn/steer' : 'turn/start', params)
      if (steer ? reply.turnId !== turn.id : typeof reply.turn?.id !== 'string')
        throw new Error('The adapter did not confirm the turn')
      receipts.prepare("UPDATE receipts SET status='done' WHERE message=?").run(key)
    } catch (e) {
      if (e.rpcCode === -32602 || e.rpcCode === -32601)
        receipts.prepare("DELETE FROM receipts WHERE message=? AND status='pending'").run(key)
      throw e
    }
    rt.sessionsChanged(0)
  })
}
async function onEvent(c, m) {
  const p = m.params ?? {}
  if (m.method === 'serverRequest/resolved') {
    asks.get(`${c.generation}:${JSON.stringify(p.requestId)}`)?.abort()
    return
  }
  if (!p.threadId || !observed.has(p.threadId)) return
  if (m.id !== undefined) {
    const item = {
      id: fingerprint(`${c.generation}|${p.threadId}|${JSON.stringify(m.id)}`).slice(0, 32),
      session_id: pub(p.threadId),
      cwd: p.cwd ?? catalog.get(pub(p.threadId))?.cwd,
      session_title: catalog.get(pub(p.threadId))?.name,
      tool_use_id: p.itemId,
      created_at: new Date().toISOString(),
    }
    let decision
    if (
      m.method === 'item/commandExecution/requestApproval' ||
      m.method === 'item/fileChange/requestApproval'
    ) {
      const cmd = m.method.includes('commandExecution')
      Object.assign(item, {
        kind: 'permission',
        tool_name: cmd ? 'Bash' : 'Edit',
        summary: cmd ? p.command : p.reason || p.grantRoot || 'Edit files',
        tool_input: cmd ? { command: p.command } : { file_path: p.grantRoot },
      })
      decision = (r) =>
        typeof r.allow === 'boolean'
          ? { decision: r.allow ? (r.always ? 'acceptForSession' : 'accept') : 'decline' }
          : undefined
    } else if (m.method === 'item/permissions/requestApproval') {
      Object.assign(item, {
        kind: 'permission',
        tool_name: 'Permissions',
        summary: p.reason || '会话请求额外Permissions',
        tool_input: p.permissions,
      })
      decision = (r) =>
        typeof r.allow === 'boolean'
          ? {
              permissions: r.allow ? p.permissions : {},
              scope: r.allow && r.always ? 'session' : 'turn',
            }
          : undefined
    } else if (m.method === 'item/tool/requestUserInput') {
      Object.assign(item, {
        kind: 'question',
        tool_name: 'request_user_input',
        can_cancel: true,
        questions: p.questions,
      })
      decision = (r) =>
        r.cancel
          ? { answers: {} }
          : r.answers && p.questions.every((q) => typeof r.answers[q.question] === 'string')
            ? {
                answers: Object.fromEntries(
                  p.questions.map((q) => [q.id, { answers: [r.answers[q.question]] }]),
                ),
              }
            : undefined
    } else if (m.method === 'mcpServer/elicitation/request' && p._meta?.kind === 'mcp_tool_call') {
      Object.assign(item, {
        kind: 'permission',
        tool_name: `mcp__${p.serverName}`,
        summary: p.message,
        tool_input: p._meta.toolParams,
      })
      decision = (r) =>
        typeof r.allow === 'boolean'
          ? { action: r.allow ? 'accept' : 'decline', content: r.allow ? {} : null, _meta: null }
          : undefined
    } else return
    const controller = new AbortController(),
      key = `${c.generation}:${JSON.stringify(m.id)}`
    asks.set(key, controller)
    try {
      const r = await rt.ask(item, { signal: controller.signal })
      if (!controller.signal.aborted && r && !r.dismiss) {
        const reply = decision(r)
        if (reply) c.respond(m.id, reply)
      }
    } catch {
    } finally {
      if (asks.get(key) === controller) asks.delete(key)
    }
  } else if (
    m.method === 'thread/settings/updated' ||
    m.method === 'turn/completed' ||
    m.method === 'turn/started' ||
    m.method === 'thread/status/changed'
  ) {
    const cached = progress.get(p.threadId)
    if (cached) cached.checked = 0
    rt.sessionsChanged(120)
  }
}
const driver = {
  async models() {
    models = await readModels(await owner.connect())
    return launcherModels()
  },
  async modes(p) {
    const initial = await lookup(p.session_id, true)
    return withThread(initial.id, async () => {
      const t = await lookup(p.session_id, true)
      const c = await owner.connect()
      if (p.permission_mode)
        throw typed('This adapter manages permission settings in the Codex client')
      if (t.status?.type === 'active' || (await recentTurn(c, t.id))?.status === 'inProgress')
        throw typed('Wait for the running turn to finish before changing its settings', 'busy')
      models = await readModels(c)
      const choice = selectedModel(models, p.model, t.model)
      const params = settings(choice, p.effort)
      if (p.model) params.model = choice.profile
      if (!Object.keys(params).length) return
      // Profile and backend pinning are enforced atomically by the adapter.
      // A refusal is returned to Persona before any accompanying effort can change.
      await c.call('thread/settings/update', { threadId: t.id, ...params })
      const actual = await lookup(p.session_id, true)
      if (
        (params.model && actual.model !== params.model) ||
        (params.effort && actual.reasoningEffort !== params.effort)
      )
        throw typed('The adapter did not confirm the requested settings')
      rt.sessionsChanged(0)
    })
  },
  async seen(p) {
    const t = await lookup(p.session_id)
    const offered = progress.get(t.id)?.turn
    if (!finished(offered)) return
    const latest = await recentTurn(await owner.connect(), t.id)
    if (finished(latest) && latest.id === offered.id) {
      markSeen.run(t.id, latest.id)
      rt.sessionsChanged(0)
    }
  },
  start,
  async listSessions() {
    try {
      await syncCatalog()
    } catch {
      online = false
    }
    return [...catalog.values()].map(session)
  },
  async items(p) {
    const t = await lookup(p.session_id, false, true)
    return hist.items(t.id, p)
  },
  async cursor(id) {
    const t = await lookup(id, false, true)
    const s = await hist.read(t.id)
    const w = watches.get(id)
    if (w && !w.last) w.last = { history: s.history, toSeq: s.toSeq }
    return { history: s.history, to_seq: s.toSeq }
  },
  async item(p) {
    const t = await lookup(p.session_id, false, true)
    const s = await hist.read(t.id)
    const it = s.items.find((i) => i.id === p.item_id)
    if (!it) throw typed('Unknown item', 'not_found')
    return it
  },
  async image(p) {
    const it = await driver.item(p)
    if (!it.image) throw typed('Unknown image', 'not_found')
    return it.image
  },
  watchChanged(id, watching) {
    if (!watching) {
      watches.delete(id)
      return
    }
    if (watches.has(id)) return
    const w = { last: null }
    watches.set(id, w)
    void (async () => {
      const t = await lookup(id),
        c = await owner.connect()
      if (!observed.has(t.id) && t.status?.type === 'active' && watches.get(id) === w) {
        // A viewer can answer the running thread's questions. Opening history
        // never wakes a dormant thread or requests a new turn.
        const loaded = await collect(c, 'thread/loaded/list', { limit: 200 })
        if (loaded.includes(t.id) && watches.get(id) === w) await subscribe(c, t)
      }
    })().catch(() => {})
  },
  send,
  async interrupt(p) {
    const t = await lookup(p.session_id, true),
      c = await owner.connect()
    const turn = await recentTurn(c, t.id)
    if (turn?.status !== 'inProgress') return { settled: true }
    await c.call('turn/interrupt', { threadId: t.id, turnId: turn.id })
    return { settled: (await recentTurn(c, t.id))?.status !== 'inProgress' }
  },
  async archive(p) {
    const t = await lookup(p.session_id, false, true)
    await withThread(t.id, async () => {
      await refresh()
      if (!catalog.has(p.session_id)) return
      const c = await owner.connect()
      if ((await recentTurn(c, t.id))?.status === 'inProgress')
        throw typed('Wait for the turn to finish before archiving')
      await c.call('thread/archive', { threadId: t.id })
      await refresh()
    })
    rt.sessionsChanged(0)
  },
  async unarchive(p) {
    const t = await lookup(p.session_id, false, true)
    await withThread(t.id, async () => {
      await refresh()
      if (catalog.has(p.session_id)) return
      const c = await owner.connect()
      const reply = await c.call('thread/unarchive', { threadId: t.id })
      if (reply.thread?.id !== t.id) throw typed('The adapter did not restore the requested thread')
      await refresh()
    })
    rt.sessionsChanged(0)
  },
  async rename(p) {
    const t = await lookup(p.session_id, true)
    await (await owner.connect()).call('thread/name/set', {
      threadId: t.id,
      name: p.title ?? p.name,
    })
    rt.sessionsChanged(0)
  },
}
// A list revision must advance before anybody opens the conversation. The
// adapter's thread timestamp need not change for an item inside a running turn.
async function probeProgress(t) {
  const prior = progress.get(t.id),
    now = Date.now()
  if (
    prior &&
    prior.updated === t.updatedAt &&
    prior.state === t.status?.type &&
    prior.turn?.status !== 'inProgress' &&
    t.status?.type !== 'active' &&
    // The adapter's thread clock has one-second resolution. A short turn
    // can start and finish between polls without advancing that timestamp.
    now - t.updatedAt * 1000 > 2500 &&
    now - prior.checked < 60000
  )
    return
  const c = await owner.connect()
  const [summary, tail] = await Promise.all([
    c.call('thread/turns/list', {
      threadId: t.id,
      limit: 1,
      itemsView: 'summary',
      sortDirection: 'desc',
    }),
    c
      .call('thread/items/list', { threadId: t.id, limit: 1, sortDirection: 'desc' })
      .catch(() => null),
  ])
  const turn = summary.data?.[0],
    last = tail?.data?.[0]?.item
  const preview = turn?.items?.findLast((i) => i.type === 'agentMessage')?.text?.slice(0, 180)
  const mark = fingerprint(JSON.stringify([turn?.id, turn?.status, preview, last]))
  progress.set(t.id, {
    updated: t.updatedAt,
    state: t.status?.type,
    checked: now,
    mark,
    preview: preview ?? prior?.preview,
    rev: prior?.mark === mark ? prior.rev : Math.max(now, (prior?.rev ?? 0) + 1),
    // The latest turn's lifecycle (session: done, and updated_at = its end);
    // null when the thread never ran one.
    turn: turn
      ? {
          id: turn.id,
          status: turn.status,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
        }
      : null,
  })
}
async function poll() {
  if (polling) return
  polling = true
  try {
    const rows = await syncCatalog()
    const live = new Set([...rows.values()].map((t) => t.id))
    for (const id of progress.keys()) if (!live.has(id)) progress.delete(id)
    const all = [...rows.values()]
    const sig = JSON.stringify(
      all.map((t) => [
        t.id,
        t.updatedAt,
        t.name,
        t.model,
        t.reasoningEffort,
        t.status,
        progress.get(t.id)?.rev,
        session(t).status,
      ]),
    )
    if (signature !== sig) {
      signature = sig
      rt.sessionsChanged(50)
    }
    for (const [id, w] of watches) {
      const t = rows.get(id)
      if (!t) continue
      try {
        const latest = await hist.push(t.id, id, w.last, rt)
        if (watches.get(id) === w) w.last = latest
      } catch {
        /* A later poll retries against the same owner. */
      }
    }
  } catch {
    if (online) {
      online = false
      rt.sessionsChanged(0)
    }
  } finally {
    polling = false
  }
}
rt = createRuntime(driver, {
  runtime,
  name: label,
  launcher: runtime,
  modelSwitch: true,
  launchers: [],
  agent: 'claude',
  version: '1',
  log: (m) =>
    console.error(
      String(m)
        .replace(/[\r\n]/g, ' ')
        .slice(0, 240),
    ),
})
await rt.start()
setInterval(() => void poll(), 2200)
void poll()
