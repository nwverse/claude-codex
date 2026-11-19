import { CodexAppServerChild } from './codex-app-server-child.mjs'
import {
  AG_MODEL_PREFIX,
  bareCodexModel,
  codexProviderForModel,
  isAgModel,
} from './harness-models.mjs'
import { invalidRequest, RpcError, SERVER_ERROR } from './host-methods.mjs'
import { permissionProfileIdFromParams, permissionProfilePolicy } from './server-helpers.mjs'
import type { SessionStore } from './store.mjs'
import type { RpcPeer, ThreadRecord } from './types.mjs'
import { debugLog, isCodexOpenAiModel } from './util.mjs'

// Codex threads on the native harness: the adapter keeps the thread's sidebar
// record (name, project, section, archive, preview), a real `codex
// app-server` child keeps the conversation and runs it. Every request about
// the conversation goes to the child as the App sent it, and what the child
// says comes back as Codex said it: approvals, diffs, plan mode, MCP, images,
// compaction, steer, rollback and fork behave as in Codex itself.
//
// The App knows a thread by the adapter's id. The child's thread is made on
// the first turn (a new chat's thread exists before the user picks its model,
// and may still move to another harness), so its id differs: ids are mapped
// both ways. A model id `codex-ag:<model>` runs on the AsterGate provider and
// is `<model>` to the child.

export const NOT_ROUTED = Symbol('notRouted')

export interface CodexBridgeHost {
  readonly store: SessionStore
  readonly detachedPeer: RpcPeer
  subscribe(threadId: string, peer: RpcPeer): void
  notifyThread(threadId: string, notification: { method: string; params: unknown }): void
  sidebarMetadata(thread: ThreadRecord): Record<string, unknown>
  notifyAll(notification: { method: string; params: unknown }): void
  sendServerRequest(peer: RpcPeer, method: string, id: string, params: unknown): Promise<unknown>
  dropServerRequest(id: string): void
  // Validates and applies a model change the way the model menu would, and
  // saves the thread; throws the menu's refusal.
  applyModel(thread: ThreadRecord, params: Record<string, unknown>, persist: boolean): void
  clientInfo(): Record<string, unknown>
  configOverrides(): readonly string[]
  finishMirror(peer: RpcPeer, method: string, params: Record<string, unknown>): unknown
  checkIdle(): void
}

// Requests about a thread's conversation, answered by the child.
const FORWARDED = new Set([
  'thread/resume',
  'thread/read',
  'thread/turns/list',
  'thread/turns/items/list',
  'thread/items/list',
  'thread/timeline/list',
  'thread/searchOccurrences',
  'thread/settings/update',
  'thread/compact/start',
  'thread/shellCommand',
  'thread/rollback',
  'thread/revert',
  'thread/inject_items',
  'thread/backgroundTerminals/clean',
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/terminate',
  'thread/goal/set',
  'thread/goal/get',
  'thread/goal/clear',
  'thread/memoryMode/set',
  'thread/approveGuardianDeniedAction',
  'thread/increment_elicitation',
  'thread/decrement_elicitation',
  'thread/fork',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'turn/settings/update',
  'review/start',
])

// The adapter answers these from its own record; the child hears them too so
// its rollout stays in step.
const MIRRORED = new Set(['thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/delete'])

export function isNativeConversationMethod(method: string): boolean {
  return FORWARDED.has(method) || MIRRORED.has(method)
}

// About the child process itself, not about a thread the App shows.
const DROPPED_NOTIFICATIONS = [
  'account/',
  'mcpServer/startupStatus/updated',
  'skills/changed',
  'fs/changed',
  'app/list/updated',
  'remoteControl/',
  'configWarning',
  'windowsSandbox/',
]

interface ActiveTurn {
  turnId: string
  provider: string
}

export class CodexNativeBridge {
  private readonly host: CodexBridgeHost
  private readonly children = new Map<string, CodexAppServerChild>()
  // Child thread id -> adapter thread id, where they differ.
  private readonly adapterIdByChild = new Map<string, string>()
  // provider -> child generation -> threads loaded in that child.
  private readonly loaded = new Map<string, { generation: number; ids: Set<string> }>()
  // Completed turns reported before turn/start answers, while the App waits for its id.
  private readonly startingTurns = new Map<string, Set<string>>()
  private requestsInFlight = 0
  private stopped = false
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly pendingRequests = new Map<string, { threadId: string; turnId: string | null }>()
  private readonly changesInFlight = new Set<string>()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(host: CodexBridgeHost) {
    this.host = host
  }

  busy(): boolean {
    return this.requestsInFlight > 0 || this.activeTurns.size > 0 || this.pendingRequests.size > 0
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearIdleTimer()
    const children = [...this.children.values()].map((child) => child.close())
    this.children.clear()
    for (const id of this.pendingRequests.keys()) this.finishRequest(id)
    this.activeTurns.clear()
    await Promise.all(children)
  }

  // The thread's record when the native harness runs it.
  owned(threadId: string): ThreadRecord | null {
    if (!threadId) return null
    const thread = this.host.store.getThread(threadId)
    if (!thread || thread.runtimeBackend !== 'codex') return null
    if (thread.nativeCodexProvider && thread.codexSessionId) {
      this.adapterIdByChild.set(thread.codexSessionId, thread.id)
      return thread
    }
    // Existing exec chats have no record of the Codex provider that owns
    // their rollout. Continue them through exec and its original config.
    if (thread.codexSessionId || thread.forkedFromId || this.host.store.lastTurn(threadId))
      return null
    return isCodexOpenAiModel(thread.model) ? thread : null
  }

  async route(peer: RpcPeer, method: string, rawParams: unknown): Promise<unknown> {
    if (!isNativeConversationMethod(method)) return NOT_ROUTED
    const params = asRecord(rawParams)
    const threadId = stringField(params.threadId)
    if (!threadId) return NOT_ROUTED
    const startsTurn = method === 'turn/start' || method === 'thread/shellCommand'
    if (
      this.changesInFlight.has(threadId) ||
      (this.startingTurns.has(threadId) &&
        (startsTurn || method === 'thread/settings/update' || MIRRORED.has(method)))
    )
      throw invalidRequest('another change is in progress on this thread; retry when it finishes')
    const model = requestedModel(params)
    if (model && ['thread/resume', 'thread/settings/update', 'turn/start'].includes(method)) {
      const current = this.host.store.getThread(threadId)
      if (current?.nativeCodexProvider) {
        // Validate before forwarding. Commit the change only if the child accepts it.
        this.host.applyModel(current, params, false)
      } else if (
        current &&
        !current.codexSessionId &&
        !current.ephemeral &&
        (current.runtimeBackend === 'codex' || isCodexOpenAiModel(model))
      ) {
        this.host.applyModel(current, params, true)
      }
    }
    const thread = this.owned(threadId)
    if (!thread || (!thread.codexSessionId && !startsTurn)) return NOT_ROUTED
    if (method === 'thread/fork') {
      // A description fork needs its native parent's conversation. The App's
      // default summary model can belong to a different provider.
      if (params.ephemeral === true && params.threadSource === 'thread_description')
        params.model = thread.model
      const model = requestedModel(params)
      if (model && (!isCodexOpenAiModel(model) || isAgModel(model) !== isAgModel(thread.model)))
        throw invalidRequest(
          'a fork uses its parent’s Codex provider; start a new chat to switch providers',
        )
    }
    this.host.subscribe(thread.id, peer)
    this.requestsInFlight += 1
    this.clearIdleTimer()
    if (startsTurn) this.startingTurns.set(threadId, new Set())
    if (MIRRORED.has(method)) this.changesInFlight.add(threadId)
    try {
      if (!thread.codexSessionId) await this.createChildThread(thread)
      if (MIRRORED.has(method)) {
        // Keep the local sidebar record until the owner of the rollout accepts the change.
        const child = this.child(thread.nativeCodexProvider as string)
        const childId = thread.codexSessionId as string
        const active = this.activeTurns.get(threadId)
        const stopsWork = method === 'thread/archive' || method === 'thread/delete'
        if (stopsWork && active) {
          try {
            await child.request('turn/interrupt', { threadId: childId, turnId: active.turnId })
          } catch (error) {
            if (this.activeTurns.get(threadId) === active) throw error
          }
        }
        const result = asRecord(
          await child.request(method, this.inbound(params, thread.id, childId, child.provider)),
        )
        if (stopsWork) {
          this.activeTurns.delete(threadId)
          this.finishThreadRequests(threadId)
          this.loaded.get(child.provider)?.ids.delete(childId)
        }
        const local = await this.host.finishMirror(peer, method, params)
        if (method === 'thread/unarchive') {
          const history = asRecord(result.thread)
          if (Array.isArray(history.turns) && history.turns.length)
            return this.outboundResult(result, child.provider)
          const resumed = asRecord(await this.forward(thread, 'thread/resume', { threadId }))
          return { thread: resumed.thread }
        }
        if (method === 'thread/delete')
          this.adapterIdByChild.delete(thread.codexSessionId as string)
        return local
      }
      const result = await this.forward(thread, method, params)
      if (method === 'thread/settings/update') return NOT_ROUTED
      if (model && (method === 'turn/start' || method === 'thread/resume')) {
        const current = this.host.store.getThread(threadId)
        if (current) this.host.applyModel(current, params, true)
      }
      return result
    } finally {
      if (MIRRORED.has(method)) this.changesInFlight.delete(threadId)
      if (startsTurn) this.startingTurns.delete(threadId)
      this.requestsInFlight -= 1
      this.host.checkIdle()
      this.scheduleIdleStop()
    }
  }

  // Children with nothing to do for a while are stopped; the next request
  // starts them again and reloads its thread.
  private scheduleIdleStop(): void {
    this.clearIdleTimer()
    if (this.stopped) return
    const ms = Number(process.env.CLAUDE_CODEX_NATIVE_IDLE_MS ?? 600_000)
    if (!(ms > 0)) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.busy()) return this.scheduleIdleStop()
      for (const child of this.children.values()) void child.stop()
      debugLog('codexBridge.idleStop', {})
    }, ms)
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private async forward(
    thread: ThreadRecord,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const provider = thread.nativeCodexProvider as string
    const child = this.child(provider)
    const childId = thread.codexSessionId as string
    if (method !== 'thread/resume') await this.ensureLoaded(child, thread)
    if (method === 'turn/start' && !thread.preview) this.rememberPreview(thread, params)
    const outgoing = asRecord(this.inbound(params, thread.id, childId, provider))
    const profile = permissionProfilePolicy(permissionProfileIdFromParams(params))
    if (profile && !profile.sandboxMode) {
      // The adapter displays unknown profile ids with its concrete policy.
      // Preserve that policy (and any explicit sandbox/approval settings).
      delete outgoing.permissions
      delete outgoing.activePermissionProfile
    }
    if (method === 'thread/resume' || method === 'thread/fork') {
      // Both fields override threadId in Codex. An adapter id names a single
      // persisted rollout and the provider that created it.
      delete outgoing.path
      delete outgoing.history
      outgoing.modelProvider = provider
      // On some app-server versions a provider override selects its global
      // default model unless the rollout's model is supplied alongside it.
      outgoing.model ??= bareCodexModel(thread.model)
      if (outgoing.config)
        outgoing.config = { ...asRecord(outgoing.config), model_provider: provider }
    }
    let result: unknown
    try {
      result = await child.request(method, outgoing)
    } catch (error) {
      throw error instanceof RpcError ? error : new RpcError(String(error))
    }
    if (method === 'thread/resume') this.markLoaded(child, childId)
    if (method === 'thread/fork') return this.adoptFork(thread, result, params, child)
    if (method === 'review/start') {
      const reviewId = stringField(asRecord(result).reviewThreadId)
      if (reviewId && reviewId !== childId)
        this.adoptFork(thread, { thread: { id: reviewId, modelProvider: provider } }, {}, child)
    }
    if (method === 'turn/start') {
      const turnId = stringField(asRecord(asRecord(result).turn).id)
      const status = asRecord(asRecord(result).turn).status
      if (turnId && status === 'inProgress' && !this.startingTurns.get(thread.id)?.has(turnId))
        this.activeTurns.set(thread.id, { turnId, provider })
    }
    return this.outboundResult(result, provider)
  }

  private outboundResult(result: unknown, provider: string): unknown {
    const outgoing = this.outbound(result, provider)
    const fields = asRecord(outgoing)
    const native = asRecord(fields.thread)
    const id = stringField(native.id)
    const thread = id ? this.host.store.getThread(id) : null
    return thread
      ? { ...fields, thread: { ...native, ...this.host.sidebarMetadata(thread) } }
      : outgoing
  }

  private async createChildThread(thread: ThreadRecord): Promise<void> {
    const provider = codexProviderForModel(thread.model)
    const child = this.child(provider)
    const result = asRecord(
      await child.request('thread/start', {
        model: bareCodexModel(thread.model),
        modelProvider: provider,
        cwd: thread.cwd,
        approvalPolicy: thread.approvalPolicy,
        ...(permissionProfilePolicy(thread.permissionProfileId)?.sandboxMode
          ? { permissions: thread.permissionProfileId }
          : { sandbox: thread.sandboxMode }),
        ...(thread.approvalsReviewer ? { approvalsReviewer: thread.approvalsReviewer } : {}),
        dynamicTools: this.host.store.getDynamicTools(thread.id),
        ...(thread.baseInstructions ? { baseInstructions: thread.baseInstructions } : {}),
        ...(thread.developerInstructions
          ? { developerInstructions: thread.developerInstructions }
          : {}),
        ...(thread.personality ? { personality: thread.personality } : {}),
        ...(thread.ephemeral ? { ephemeral: true } : {}),
      }),
    )
    const childId = stringField(asRecord(result.thread).id)
    if (!childId) throw new RpcError('codex app-server started no thread')
    if (!this.host.store.bindNativeCodexThread(thread, provider, childId)) {
      // A second adapter or a sidebar change won while the child started.
      // Nobody sent a turn to this empty rollout.
      await child.request('thread/archive', { threadId: childId }).catch(() => {})
      throw invalidRequest('the thread changed while Codex was starting; retry the turn')
    }
    thread.nativeCodexProvider = provider
    if (childId !== thread.id) this.adapterIdByChild.set(childId, thread.id)
    thread.codexSessionId = childId
    this.markLoaded(child, childId)
    debugLog('codexBridge.thread', { threadId: thread.id, childId, provider })
  }

  // The child's fork is a thread of its own; the adapter files it like the
  // parent so the sidebar lists it.
  private adoptFork(
    parent: ThreadRecord,
    result: unknown,
    params: Record<string, unknown>,
    child: CodexAppServerChild,
  ): unknown {
    const record = asRecord(result)
    const forkId = stringField(asRecord(record.thread).id)
    if (forkId && !this.host.store.getThread(forkId)) {
      const model = typeof params.model === 'string' && params.model ? params.model : parent.model
      this.host.store.upsertThread({
        ...parent,
        id: forkId,
        sessionId: forkId,
        forkedFromId: parent.id,
        isPinned: false,
        sectionId: null,
        sectionEnteredAt: null,
        sectionPosition: null,
        name: null,
        model: isAgModel(parent.model) && !isAgModel(model) ? `${AG_MODEL_PREFIX}${model}` : model,
        ephemeral: params.ephemeral === true,
        threadSource: stringField(params.threadSource) ?? parent.threadSource,
        agentNickname: stringField(asRecord(record.thread).agentNickname),
        agentRole: stringField(asRecord(record.thread).agentRole),
        codexSessionId: forkId,
        claudeSessionId: null,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        status: { type: 'idle' },
      })
      if (parent.projectId) this.host.store.setThreadProject(forkId, parent.projectId)
      this.host.store.putDynamicTools(forkId, this.host.store.getDynamicTools(parent.id))
      if (!params.ephemeral) this.host.store.copyThreadAttachments(parent.id, forkId)
      this.markLoaded(child, forkId)
      this.host.notifyThread(parent.id, {
        method: 'thread/started',
        params: { thread: this.outbound(record.thread, child.provider) },
      })
    }
    return this.outboundResult(result, child.provider)
  }

  private async ensureLoaded(child: CodexAppServerChild, thread: ThreadRecord): Promise<void> {
    const childId = thread.codexSessionId as string
    const entry = this.loaded.get(child.provider)
    if (child.running && entry?.generation === child.generation && entry.ids.has(childId)) return
    await child.request('thread/resume', {
      threadId: childId,
      excludeTurns: true,
      model: bareCodexModel(thread.model),
      modelProvider: child.provider,
    })
    this.markLoaded(child, childId)
  }

  private markLoaded(child: CodexAppServerChild, childId: string): void {
    let entry = this.loaded.get(child.provider)
    if (!entry || entry.generation !== child.generation) {
      entry = { generation: child.generation, ids: new Set() }
      this.loaded.set(child.provider, entry)
    }
    entry.ids.add(childId)
  }

  private rememberPreview(thread: ThreadRecord, params: Record<string, unknown>): void {
    const input = Array.isArray(params.input) ? params.input : []
    const text = input
      .map((part) => asRecord(part))
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join(' ')
      .trim()
    if (!text) return
    this.host.store.rememberNativePreview(thread.id, text.slice(0, 200))
  }

  private child(provider: string): CodexAppServerChild {
    if (this.stopped) throw new RpcError('the native Codex bridge is shutting down')
    let child = this.children.get(provider)
    if (!child) {
      child = new CodexAppServerChild(
        provider,
        {
          notification: (from, method, params) => this.onNotification(from, method, params),
          serverRequest: (from, id, method, params) =>
            this.onServerRequest(from, id, method, params),
          exited: (from, generation, reason) => this.onExit(from, generation, reason),
        },
        {
          clientInfo: () => this.host.clientInfo(),
          configOverrides: () => this.host.configOverrides(),
        },
      )
      this.children.set(provider, child)
    }
    return child
  }

  private adapterId(childId: string): string {
    return this.adapterIdByChild.get(childId) ?? childId
  }

  // Adapter ids -> child ids, and the harness prefix off model ids.
  private inbound(
    params: Record<string, unknown>,
    adapterId: string,
    childId: string,
    provider: string,
  ): unknown {
    return rewrite(params, (value, key) => {
      if ((key === 'modelProvider' || key === 'model_provider') && value === 'claude-code')
        return provider
      if (value === adapterId && isThreadIdField(key)) return childId
      if ((key === 'model' || key === 'toModel') && isAgModel(value)) return bareCodexModel(value)
      return value
    })
  }

  // Child ids -> adapter ids, and the harness prefix back on model ids of
  // AsterGate threads. The App files every thread under the adapter's
  // provider, so its composer predictions never fork one.
  // App rule: prediction-provider
  private outbound(payload: unknown, provider: string): unknown {
    const ag = provider !== 'openai'
    return rewrite(payload, (value, key) => {
      const mapped = this.adapterIdByChild.get(value)
      if (mapped && isThreadIdField(key)) return mapped
      if (key === 'modelProvider' || key === 'model_provider') return 'claude-code'
      if (
        ag &&
        (key === 'model' || key === 'fromModel' || key === 'toModel') &&
        value &&
        !isAgModel(value)
      )
        return `${AG_MODEL_PREFIX}${value}`
      return value
    })
  }

  private onNotification(provider: string, method: string, params: unknown): void {
    if (DROPPED_NOTIFICATIONS.some((prefix) => method.startsWith(prefix))) return
    const fields = asRecord(params)
    const childThreadId = stringField(fields.threadId) ?? stringField(asRecord(fields.thread).id)
    // The adapter announces the sidebar thread. The native child can report
    // thread/started before its thread/start response supplies the child id.
    if (method === 'thread/started') {
      const record = asRecord(fields.thread)
      const parentId = stringField(record.parentThreadId)
      const parent = parentId ? this.host.store.getThread(this.adapterId(parentId)) : null
      if (parent?.nativeCodexProvider === provider && childThreadId)
        this.adoptFork(parent, fields, { threadSource: 'subagent' }, this.child(provider))
      return
    }
    if (method === 'serverRequest/resolved') {
      const id = this.resolvedRequestId(provider, fields.requestId)
      if (!id) return
      this.finishRequest(id)
      return
    }
    const threadId = childThreadId ? this.adapterId(childThreadId) : null
    const notification = { method, params: this.outbound(params, provider) }
    if (threadId) this.track(threadId, method, asRecord(notification.params))
    if (threadId) {
      if (this.host.store.getThread(threadId)) this.host.notifyThread(threadId, notification)
    } else this.host.notifyAll(notification)
  }

  // The sidebar record follows the conversation.
  private track(threadId: string, method: string, params: Record<string, unknown>): void {
    const thread = this.host.store.getThread(threadId)
    if (!thread) return
    switch (method) {
      case 'turn/started': {
        const turnId = stringField(asRecord(params.turn).id)
        if (turnId)
          this.activeTurns.set(threadId, {
            turnId,
            provider: thread.nativeCodexProvider as string,
          })
        thread.updatedAt = Math.floor(Date.now() / 1000)
        this.host.store.upsertThread(thread)
        return
      }
      case 'turn/completed': {
        const turnId = stringField(asRecord(params.turn).id)
        if (turnId) this.startingTurns.get(threadId)?.add(turnId)
        if (this.activeTurns.get(threadId)?.turnId === turnId) this.activeTurns.delete(threadId)
        if (turnId) this.finishThreadRequests(threadId, turnId)
        thread.updatedAt = Math.floor(Date.now() / 1000)
        thread.status = { type: 'idle' }
        this.host.store.upsertThread(thread)
        this.host.checkIdle()
        return
      }
      case 'thread/status/changed': {
        const status = asRecord(params.status)
        if (typeof status.type === 'string')
          this.host.store.updateThreadStatus(threadId, status as ThreadRecord['status'])
        return
      }
      case 'thread/name/updated': {
        const name = stringField(params.threadName) ?? stringField(params.name)
        if (name) {
          thread.name = name
          this.host.store.upsertThread(thread)
        }
        return
      }
    }
  }

  private onServerRequest(
    provider: string,
    childRequestId: string | number,
    method: string,
    params: unknown,
  ): void {
    const child = this.children.get(provider)
    if (!child) return
    const generation = child.generation
    const id = `cx:${provider}:${generation}:${childRequestId}`
    const outgoing = this.outbound(params, provider)
    const threadId = stringField(asRecord(outgoing).threadId)
    // Detached reviews and provider-created threads have no adapter sidebar
    // owner. Fail their request explicitly instead of stranding an approval.
    if (!threadId || !this.host.store.getThread(threadId)) {
      child.respond(childRequestId, undefined, {
        code: SERVER_ERROR,
        message: 'native thread is not attached to the adapter',
      })
      return
    }
    this.pendingRequests.set(id, { threadId, turnId: stringField(asRecord(outgoing).turnId) })
    this.host
      .sendServerRequest(this.host.detachedPeer, method, id, outgoing)
      .then((result) => {
        if (child.generation === generation && this.pendingRequests.has(id))
          child.respond(childRequestId, this.childResult(result, threadId))
      })
      .catch((error: unknown) => {
        if (child.generation !== generation || !this.pendingRequests.has(id)) return
        child.respond(childRequestId, undefined, {
          code: SERVER_ERROR,
          message: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        this.finishRequest(id)
      })
  }

  private finishThreadRequests(threadId: string, turnId?: string): void {
    for (const [id, request] of this.pendingRequests) {
      if (request.threadId === threadId && (!turnId || request.turnId === turnId))
        this.finishRequest(id)
    }
  }

  private finishRequest(id: string): void {
    const request = this.pendingRequests.get(id)
    if (!request) return
    this.pendingRequests.delete(id)
    this.host.dropServerRequest(id)
    this.host.notifyThread(request.threadId, {
      method: 'serverRequest/resolved',
      params: { threadId: request.threadId, requestId: id },
    })
    this.host.checkIdle()
  }

  private childResult(result: unknown, threadId: string | null): unknown {
    const thread = threadId ? this.host.store.getThread(threadId) : null
    if (!thread?.codexSessionId || !result || typeof result !== 'object' || Array.isArray(result))
      return result
    return this.inbound(
      asRecord(result),
      thread.id,
      thread.codexSessionId,
      thread.nativeCodexProvider as string,
    )
  }

  private onExit(provider: string, generation: number, reason: string): void {
    for (const [threadId, turn] of this.activeTurns.entries()) {
      if (turn.provider !== provider) continue
      this.activeTurns.delete(threadId)
      const error = { message: `Codex stopped: ${reason}` }
      this.host.notifyThread(threadId, {
        method: 'turn/completed',
        params: { threadId, turn: { id: turn.turnId, items: [], status: 'failed', error } },
      })
      this.host.notifyThread(threadId, {
        method: 'thread/status/changed',
        params: { threadId, status: { type: 'idle' } },
      })
      this.host.store.updateThreadStatus(threadId, { type: 'idle' })
    }
    for (const id of this.pendingRequests.keys()) {
      if (id.startsWith(`cx:${provider}:${generation}:`)) this.finishRequest(id)
    }
    this.host.checkIdle()
  }

  // serverRequest/resolved names the child's request id.
  resolvedRequestId(provider: string, childRequestId: unknown): string | null {
    const child = this.children.get(provider)
    if (!child || childRequestId === undefined || childRequestId === null) return null
    return `cx:${provider}:${child.generation}:${String(childRequestId)}`
  }
}

function requestedModel(params: Record<string, unknown>): string | null {
  if (typeof params.model === 'string' && params.model) return params.model
  const nested = asRecord(asRecord(params.collaborationMode).settings).model
  return typeof nested === 'string' && nested ? nested : null
}

function isThreadIdField(key: string | null): boolean {
  return (
    key === 'id' ||
    key === 'threadId' ||
    key === 'thread_id' ||
    key === 'sessionId' ||
    key === 'parent_thread_id' ||
    key === 'attachedToThreadId' ||
    key === 'forkedFromId' ||
    key === 'parentThreadId' ||
    key === 'reviewThreadId' ||
    key === 'receiverThreadIds' ||
    key === 'senderThreadId'
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

const OPAQUE_FIELDS = new Set([
  'input',
  'content',
  'arguments',
  'inputSchema',
  'dynamicTools',
  'config',
  'outputSchema',
  'output',
])

// Rewrite protocol fields while retaining user and tool payloads.
function rewrite(
  value: unknown,
  map: (value: string, key: string | null) => string,
  key: string | null = null,
): unknown {
  if (typeof value === 'string') return map(value, key)
  if (Array.isArray(value)) return value.map((entry) => rewrite(entry, map, key))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [field, entry] of Object.entries(value)) {
      // User input, schemas, dynamic tool arguments and tool results are opaque.
      out[field] = OPAQUE_FIELDS.has(field) ? entry : rewrite(entry, map, field)
    }
    return out
  }
  return value
}
