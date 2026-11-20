// The suites, the adapter code they run in-process and the adapters they
// spawn all inherit this environment. Drop what a developer's shell or Claude
// Code session exports (credentials, a Claude config folder, a live adapter or
// Codex home with its debug and run logs), as CI never has any of it. npm test
// preloads this file into every suite (node --test --import, which node --test
// passes on to each file's process), so it runs before any suite loads. The
// suites that start adapters or run adapter code in-process, and the shared
// harness and in-process fixture, import it as well, so a direct node --test
// run of one of them is safe too. A test that wants one of these variables
// sets it itself.
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE|CODEX_)/.test(key)) delete process.env[key]
}
