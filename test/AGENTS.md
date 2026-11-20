# test/AGENTS.md

Tests run with the built-in `node:test` runner against compiled output. See the
[root AGENTS.md](../AGENTS.md) for project-wide conventions.

## Layout

- `*.test.mts` — sources compiled to `dist/test/*.mjs`.
- `adapter-*.test.mts` — end-to-end suites that spawn the mock adapter, split
  by area (protocol, models-config, daemon, turn-items, subagents, approvals,
  turn-lifecycle, mcp-skills).
- `support/` — shared helpers, such as `support/adapter-harness.mts` for the
  `adapter-*` suites. They compile to `dist/test/support/`, outside the
  `npm test` glob, so they never run as suites.
- `fixtures/` — shared test fixtures.

## Running

```bash
npm test            # builds, then runs node --test dist/test/*.mjs, 2 min per test
npm run build       # if you want to compile without running
# a single suite, after a build
node --test --import ./dist/test/support/hermetic-env.mjs dist/test/adapter-daemon.test.mjs
```

`npm test` preloads `dist/test/support/hermetic-env.mjs` into every suite. It
drops the `ANTHROPIC_*`, `CLAUDE*` and `CODEX_*` variables of the calling
shell, so a shell or Claude Code chat that exports `CLAUDE_CODEX_HOME`,
`CODEX_HOME` or `CLAUDE_CONFIG_DIR` cannot have the suites write into a live
adapter home or read that shell's Claude config. The suites that start
adapters or run adapter code in-process import it as well, so a direct run of
one of them is safe too; pass the same `--import` when you run `node --test`
yourself to get the environment `npm test` gives every suite.

## Conventions

- Tests import from `dist/` (compiled `.mjs`), so **always build first** —
  `npm test` does this for you; editing a `.mts` and re-running raw
  `node --test` without a rebuild tests stale output.
- Use `CLAUDE_CODEX_MOCK=1` to exercise protocol behavior without Claude
  credentials. Credentialed end-to-end checks live in `scripts/acceptance-*`,
  not here.
- Keep suites independent of the developer's machine: a suite that runs
  adapter code in-process sets `process.env.CLAUDE_CODEX_DEBUG_LOG = '0'` (or
  a temp `CLAUDE_CODEX_HOME`) so nothing lands in the real `~/.codex`, and a
  test `git commit` passes `-c commit.gpgsign=false`. A suite that starts
  adapters or runs adapter code in-process imports
  `./support/hermetic-env.mjs` first (or the harness or the in-process
  fixture, which do).
- Add new suites as `<area>.test.mts`; the `npm test` glob picks them up.
- `node --test` runs files in parallel but the tests in one file in order, so
  the slowest file sets the wall time. Add a slow mock-adapter test to the
  `adapter-*` suite of its area, or start a new one, rather than growing a
  single suite.
