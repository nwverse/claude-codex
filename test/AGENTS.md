# test/AGENTS.md

Tests run with the built-in `node:test` runner against compiled output. See the
[root AGENTS.md](../AGENTS.md) for project-wide conventions.

## Layout

- `*.test.mts` — sources compiled to `dist/test/*.mjs`.
- `fixtures/` — shared test fixtures.

## Running

```bash
npm test            # builds, then runs node --test dist/test/*.mjs, 2 min per test
npm run build       # if you want to compile without running
node --test dist/test/adapter.test.mjs   # a single suite, after a build
```

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
  test `git commit` passes `-c commit.gpgsign=false`.
- Add new suites as `<area>.test.mts`; the `npm test` glob picks them up.
