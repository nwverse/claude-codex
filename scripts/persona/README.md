# Persona companion

Expose the top-level Claude threads of one running claude-codex Unix daemon to a local Persona node. The companion uses the adapter's app-server API and Persona's runtime SDK. It checks the adapter identity and canonical Codex home before reading or sending anything.

Build the adapter with Node 24 or later and start the companion alongside the daemon. Set the SDK entry to `integrations/runtime-sdk/index.js` from a local Persona checkout with model switching support.

```sh
npm ci
npm run build
CODEX_HOME=/path/to/adapter-codex-home \
CLAUDE_CODEX_PERSONA_SDK=/path/to/persona/integrations/runtime-sdk/index.js \
node scripts/persona/bridge.mjs
```

The default adapter socket is `app-server-control/app-server-control.sock` inside that home. Set `CLAUDE_CODEX_PERSONA_APP_SERVER` to an alternate Unix socket path when needed. The SDK locates the local Persona runtime socket or accepts `PERSONA_RUNTIME_SOCKET`. The companion never launches an adapter or logs into a provider.

When the daemon has model process profiles, supply its same `CLAUDE_CODEX_MODEL_PROFILES_FILE` to the companion. The launcher reads the daemon's live model catalog and reasoning levels. It maps a unique SDK model name back to its profile and keeps profile IDs distinct when names collide. Pick the profile when creating a thread. After its first turn the adapter pins the process profile, so the phone can still change supported effort levels while the thread is idle. Select a different profile by starting a new thread. On adapters without process profiles the phone can also change the model of an idle thread. The companion leaves permission settings to the adapter's Codex client.

The phone can read, reply, answer supported approvals, interrupt, rename and archive or restore threads. Native Codex model IDs, subagents and ephemeral threads are excluded. New threads appear under this launcher's name. A finished turn reports `done` with its completion timestamp until Persona acknowledges that turn. A rename, settings change or companion restart preserves the read receipt. To also recognize a chat viewed over a remote Codex desktop connection, set `CLAUDE_CODEX_PERSONA_APP_STATE` to its global state JSON. The companion observes a completed turn leaving that host's unread set.

For a second daemon, give it a distinct `CLAUDE_CODEX_PERSONA_ID` and optionally a `CLAUDE_CODEX_PERSONA_NAME`. The default ID is `claude-codex`. Message, start and read receipts live under `persona-companion` inside the selected home. Set `CLAUDE_CODEX_PERSONA_STATE` to reuse the receipt directory when upgrading an existing companion for the same home. Retain its runtime ID as well. Run one companion per home and runtime ID.
