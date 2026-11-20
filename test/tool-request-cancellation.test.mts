import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type {
  ElicitationResponse,
  PermissionDecision,
  RuntimeHandlers,
  UserInputAnswers,
} from '../src/types.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

type CardKind = 'command' | 'question' | 'mcp'

// Opens the kind's card the way native-runtime does, with can_use_tool's signal.
function askThroughCard(
  kind: CardKind,
  handlers: RuntimeHandlers,
  signal: AbortSignal,
): Promise<PermissionDecision | UserInputAnswers> {
  if (kind === 'question') {
    assert.ok(handlers.onUserInputRequest)
    return handlers.onUserInputRequest(
      {
        type: 'user_input_request',
        requestId: 'cancel-question',
        toolUseId: 'question',
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Continue?',
            isOther: true,
            isSecret: false,
            options: [{ label: 'Yes', description: 'Continue the work' }],
          },
        ],
      },
      signal,
    )
  }
  return handlers.onPermissionRequest(
    {
      type: 'permission_request',
      requestId: 'cancel-permission',
      requiresUser: true,
      toolUseId: 'permission',
      toolName: kind === 'mcp' ? 'mcp__fixture__write' : 'Bash',
      input: kind === 'mcp' ? { text: 'hello' } : { command: 'echo hello' },
    },
    signal,
  )
}

function cardMethod(kind: CardKind): string {
  return kind === 'question'
    ? 'item/tool/requestUserInput'
    : kind === 'mcp'
      ? 'mcpServer/elicitation/request'
      : 'item/commandExecution/requestApproval'
}

for (const kind of ['command', 'question', 'mcp'] as const) {
  test(`cancelled ${kind} request withdraws its card without interrupting the turn`, async () => {
    const controller = new AbortController()
    let resumeTurn: () => void = () => {}
    const continued = new Promise<void>((resolve) => {
      resumeTurn = resolve
    })
    let outcome: PermissionDecision | UserInputAnswers | undefined
    let interrupts = 0
    const runtime = scriptedRuntime(
      async (_context, handlers) => {
        outcome = await askThroughCard(kind, handlers, controller.signal)
        await continued
        await handlers.onEvent({ type: 'text_delta', delta: 'The turn is still healthy.' })
        await handlers.onEvent({ type: 'completed', success: true })
      },
      {
        interrupt: async () => {
          interrupts++
        },
      },
    )
    await withInProcessApp(runtime, async (app) => {
      const threadId = await app.startThread({ approvalPolicy: 'untrusted', model: 'sonnet' })
      const turnId = await app.startTurn(threadId, 'Ask before running the tool')
      const method = cardMethod(kind)
      try {
        const request = await app.waitFor(() =>
          app.messages.find((message) => message.method === method),
        )
        controller.abort()
        await app.waitFor(() =>
          app
            .notified('serverRequest/resolved')
            .find((message) => message.requestId === request.id && message.threadId === threadId),
        )
        await app.waitFor(() => outcome)
        assert.deepEqual(outcome, kind === 'question' ? { answers: {} } : { decision: 'decline' })
        // The card is gone while the turn is still alive. An already-in-flight
        // click on Cancel must not be allowed to interrupt that healthy turn.
        assert.equal(app.notified('turn/completed').length, 0)
        await app.respond(
          request.id,
          kind === 'mcp' ? { action: 'cancel' } : { decision: 'cancel' },
        )
        assert.equal(interrupts, 0)
        resumeTurn()
        assert.equal((await app.turnCompleted(turnId)).status, 'completed')
        assert.equal(interrupts, 0)
        assert.equal(
          app
            .notified('serverRequest/resolved')
            .filter((message) => message.requestId === request.id).length,
          1,
        )
        if (kind === 'question') {
          // A question Claude Code withdrew is not shown as answered.
          const asked = app
            .notified('item/completed')
            .find((message) => message.item.tool === 'AskUserQuestion')
          assert.equal(asked?.item.status, 'failed')
          assert.equal(asked?.item.success, false)
        }
      } finally {
        controller.abort()
        resumeTurn()
      }
    })
  })

  test(`interrupting a turn with an open ${kind} card leaves the thread idle and ignores a late answer`, async () => {
    const controller = new AbortController()
    let resumeTurn: () => void = () => {}
    const continued = new Promise<void>((resolve) => {
      resumeTurn = resolve
    })
    let outcome: PermissionDecision | UserInputAnswers | undefined
    const runtime = scriptedRuntime(
      async (_context, handlers) => {
        outcome = await askThroughCard(kind, handlers, controller.signal)
        await continued
        await handlers.onEvent({ type: 'text_delta', delta: 'The turn is still healthy.' })
        await handlers.onEvent({ type: 'completed', success: true })
      },
      // The SDK aborts every pending can_use_tool call when the query closes.
      { interrupt: async () => controller.abort() },
    )
    await withInProcessApp(runtime, async (app) => {
      const threadId = await app.startThread({ approvalPolicy: 'untrusted', model: 'sonnet' })
      const turnId = await app.startTurn(threadId, 'Ask before running the tool')
      const method = cardMethod(kind)
      try {
        const request = await app.waitFor(() =>
          app.messages.find((message) => message.method === method),
        )
        await app.request('turn/interrupt', { threadId, turnId })
        assert.equal((await app.turnCompleted(turnId)).status, 'interrupted')
        // The card comes down with the turn, and Claude's call returns.
        await app.waitFor(() =>
          app
            .notified('serverRequest/resolved')
            .find((message) => message.requestId === request.id && message.threadId === threadId),
        )
        await app.waitFor(() => outcome)
        assert.deepEqual(outcome, kind === 'question' ? { answers: {} } : { decision: 'cancel' })
        await app.respond(
          request.id,
          kind === 'mcp' ? { action: 'accept', content: {} } : { decision: 'accept' },
        )
        await new Promise((resolve) => setImmediate(resolve))
        const statuses = app
          .notified('thread/status/changed')
          .filter((message) => message.threadId === threadId)
        assert.equal(statuses.at(-1)?.status.type, 'idle')
      } finally {
        resumeTurn()
        controller.abort()
      }
    })
  })
}

for (const kind of ['command', 'mcp'] as const) {
  test(`a turn that ends on its own declines a background agent's open ${kind} card without stopping it`, async () => {
    let finishMainLoop: () => void = () => {}
    const mainLoop = new Promise<void>((resolve) => {
      finishMainLoop = resolve
    })
    let outcome: PermissionDecision | UserInputAnswers | undefined
    let interrupts = 0
    const runtime = scriptedRuntime(
      async (_context, handlers) => {
        // A background agent asks; the main loop does not wait on its card.
        void askThroughCard(kind, handlers, new AbortController().signal).then((decision) => {
          outcome = decision
        })
        await mainLoop
        await handlers.onEvent({ type: 'text_delta', delta: 'Started a background agent.' })
        await handlers.onEvent({ type: 'completed', success: true })
      },
      {
        interrupt: async () => {
          interrupts++
        },
      },
    )
    await withInProcessApp(runtime, async (app) => {
      const threadId = await app.startThread({ approvalPolicy: 'untrusted', model: 'sonnet' })
      const turnId = await app.startTurn(threadId, 'Launch a background agent')
      try {
        const request = await app.waitFor(() =>
          app.messages.find((message) => message.method === cardMethod(kind)),
        )
        finishMainLoop()
        assert.equal((await app.turnCompleted(turnId)).status, 'completed')
        await app.waitFor(() =>
          app
            .notified('serverRequest/resolved')
            .find((message) => message.requestId === request.id && message.threadId === threadId),
        )
        // Declined, not cancelled: Claude Code takes a cancel for the user's
        // and stops the agent, though nobody stopped anything. Claude is told
        // why, so it does not report that the user declined.
        const tool = kind === 'mcp' ? 'mcp__fixture__write' : 'Bash'
        assert.deepEqual(await app.waitFor(() => outcome), {
          decision: 'decline',
          message: `${tool} was denied because the turn it asked for approval in had ended; the user can re-run it in a turn.`,
        })
        assert.equal(interrupts, 0)
      } finally {
        finishMainLoop()
      }
    })
  })

  test(`the user's Cancel on a background agent's ${kind} card still cancels while the turn winds down`, async () => {
    let finishMainLoop: () => void = () => {}
    const mainLoop = new Promise<void>((resolve) => {
      finishMainLoop = resolve
    })
    let mainLoopDone = false
    let outcome: PermissionDecision | UserInputAnswers | undefined
    const runtime = scriptedRuntime(async (_context, handlers) => {
      void askThroughCard(kind, handlers, new AbortController().signal).then((decision) => {
        outcome = decision
      })
      await mainLoop
      await handlers.onEvent({ type: 'completed', success: true })
      mainLoopDone = true
    })
    await withInProcessApp(runtime, async (app) => {
      const threadId = await app.startThread({
        approvalPolicy: 'untrusted',
        model: 'sonnet',
        cwd: app.home,
      })
      const turnId = await app.startTurn(threadId, 'Launch a background agent')
      const proceed = join(app.home, 'proceed')
      try {
        const request = await app.waitFor(() =>
          app.messages.find((message) => message.method === cardMethod(kind)),
        )
        // A shell the user joined to the turn keeps it open after Claude's
        // main loop finishes, with the agent's card still up.
        await app.request('thread/shellCommand', {
          threadId,
          command: 'printf ready; while [ ! -f proceed ]; do sleep 0.05; done',
        })
        await app.waitFor(() =>
          app.notified('item/commandExecution/outputDelta').find((p) => p.delta.includes('ready')),
        )
        finishMainLoop()
        await app.waitFor(() => (mainLoopDone ? true : undefined))
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(app.store.getTurn(turnId)?.status, 'inProgress')
        await app.respond(
          request.id,
          kind === 'mcp' ? { action: 'cancel' } : { decision: 'cancel' },
        )
        assert.deepEqual(await app.waitFor(() => outcome), { decision: 'cancel' })
        await writeFile(proceed, '')
        assert.equal((await app.turnCompleted(turnId)).status, 'completed')
      } finally {
        finishMainLoop()
        await writeFile(proceed, '').catch(() => {})
      }
    })
  })
}

test('interrupting a turn with an open MCP form leaves the thread idle', async () => {
  const controller = new AbortController()
  let outcome: ElicitationResponse | undefined
  const runtime = scriptedRuntime(
    async (_context, handlers) => {
      assert.ok(handlers.onElicitationRequest)
      outcome = await handlers.onElicitationRequest(
        {
          serverName: 'fixture',
          message: 'Which branch?',
          mode: 'form',
          requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } },
          url: null,
          elicitationId: null,
        },
        controller.signal,
      )
    },
    // The SDK withdraws the server's elicitation when the query closes.
    { interrupt: async () => controller.abort() },
  )
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread({ approvalPolicy: 'untrusted', model: 'sonnet' })
    const turnId = await app.startTurn(threadId, 'Ask the MCP server for a form')
    try {
      const request = await app.waitFor(() =>
        app.messages.find((message) => message.method === 'mcpServer/elicitation/request'),
      )
      await app.request('turn/interrupt', { threadId, turnId })
      assert.equal((await app.turnCompleted(turnId)).status, 'interrupted')
      await app.waitFor(() =>
        app
          .notified('serverRequest/resolved')
          .find((message) => message.requestId === request.id && message.threadId === threadId),
      )
      assert.deepEqual(await app.waitFor(() => outcome), { action: 'cancel' })
      await new Promise((resolve) => setImmediate(resolve))
      const statuses = app
        .notified('thread/status/changed')
        .filter((message) => message.threadId === threadId)
      assert.equal(statuses.at(-1)?.status.type, 'idle')
    } finally {
      controller.abort()
    }
  })
})
