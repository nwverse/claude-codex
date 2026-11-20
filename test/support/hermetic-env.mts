// Preloaded into every suite: npm test runs `node --test --import` with this
// file, and node --test passes the flag on to each file's process. The suites,
// the adapter code they run in-process and the adapters they spawn all inherit
// this environment. Drop what a developer's shell or Claude Code session
// exports (credentials, a Claude config folder, a live adapter or Codex home
// with its debug and run logs), as CI never has any of it. It runs before any
// suite loads, so a test that wants one of these sets it itself.
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE|CODEX_)/.test(key)) delete process.env[key]
}
