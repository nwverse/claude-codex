import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import {
  APP_RULES,
  DESKTOP_CLIENT_NAMES,
  GATED_METHODS,
  rendersCompletedSubagentActivity,
  unverifiedAppWarning,
  VERIFIED_APP_VERSIONS,
} from '../src/app-compat.mjs'
import { codexCompatVersion } from '../src/util.mjs'

// Tests run from dist/test; the sources sit two levels up.
const root = new URL('../../', import.meta.url)

function ruleTags(): Map<string, string[]> {
  const tags = new Map<string, string[]>()
  const srcDir = new URL('src/', root)
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.mts')) continue
    const text = readFileSync(new URL(file, srcDir), 'utf8')
    for (const match of text.matchAll(/\/\/ App rule: ([a-z0-9-]+)\s*$/gm)) {
      const id = match[1] as string
      tags.set(id, [...(tags.get(id) ?? []), file])
    }
  }
  return tags
}

test('every App rule is tagged in the source, and every tag names a rule', () => {
  const ids = APP_RULES.map((rule) => rule.id)
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique')
  for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  const tags = ruleTags()
  for (const id of ids) assert.ok(tags.has(id), `App rule ${id} is not tagged in src/`)
  for (const [id, files] of tags)
    assert.ok(ids.includes(id), `src/${files[0]} tags unknown App rule ${id}`)
})

test('every App rule says what to check on a new build', () => {
  for (const rule of APP_RULES) {
    assert.ok(rule.app.trim(), `${rule.id} has no App behavior`)
    assert.ok(rule.adapter.trim(), `${rule.id} has no adapter side`)
    assert.ok(rule.verify.trim(), `${rule.id} has no check`)
  }
})

test('the App baseline is a verified build', () => {
  const baseline = JSON.parse(readFileSync(new URL('scripts/app-baseline.json', root), 'utf8'))
  assert.ok(VERIFIED_APP_VERSIONS.includes(baseline.appVersion))
  assert.ok(baseline.clientNames.some((name: string) => DESKTOP_CLIENT_NAMES.includes(name)))
})

// The methods the adapter's request switches have a case for, the ones whose
// case answers "method not found", and those of them an App rule explains,
// as check:app-upgrade reads them.
function dispatchCases(): {
  cases: Set<string>
  notFound: Set<string>
  byDesign: Map<string, string>
} {
  const cases = new Set<string>()
  const notFound = new Set<string>()
  const byDesign = new Map<string, string>()
  for (const file of ['server.mts', 'host-methods.mts']) {
    const text = readFileSync(new URL(`src/${file}`, root), 'utf8')
    for (const match of text.matchAll(/case '([A-Za-z][\w/]*)':/g)) cases.add(match[1] as string)
    for (const block of text.matchAll(
      /((?:[ \t]*\/\/[^\n]*\n)*)[ \t]*((?:case '[^']+':\s*)+)throw (?:methodNotFound\(method\)|new RpcError\((?:[^()]|\([^()]*\))*?\bMETHOD_NOT_FOUND\b)/g,
    )) {
      const rule = /App rule: ([a-z0-9-]+)/.exec(block[1] as string)?.[1]
      for (const match of (block[2] as string).matchAll(/case '([^']+)':/g)) {
        notFound.add(match[1] as string)
        if (rule) byDesign.set(match[1] as string, rule)
      }
    }
  }
  return { cases, notFound, byDesign }
}

test('every request the verified App can send has a case', () => {
  const baseline = JSON.parse(readFileSync(new URL('scripts/app-baseline.json', root), 'utf8'))
  const { cases } = dispatchCases()
  assert.deepEqual(
    baseline.clientRequests.filter((method: string) => !cases.has(method)),
    [],
  )
})

test('the adapter answers every request the scripts of the verified App name', () => {
  const baseline = JSON.parse(readFileSync(new URL('scripts/app-baseline.json', root), 'utf8'))
  const { cases, notFound, byDesign } = dispatchCases()
  assert.ok(baseline.appRequests.length > 100, 'the baseline records the requests the App names')
  assert.ok(notFound.size > 0, 'the cases that answer "method not found" are found')
  // Unless an App rule says how the App copes with "method not found".
  assert.deepEqual(
    baseline.appRequests.filter(
      (method: string) => !cases.has(method) || (notFound.has(method) && !byDesign.has(method)),
    ),
    [],
  )
  for (const [method, rule] of byDesign)
    assert.ok(
      APP_RULES.some((known) => known.id === rule),
      `${method} names unknown App rule ${rule}`,
    )
})

test('GATED_METHODS names the baseline gates and their requests', () => {
  const baseline = JSON.parse(readFileSync(new URL('scripts/app-baseline.json', root), 'utf8'))
  const { cases, notFound } = dispatchCases()
  for (const [gate, methods] of Object.entries(GATED_METHODS)) {
    assert.ok(gate in baseline.gates, `${gate} is not a gate of the baseline App`)
    for (const method of methods) {
      assert.ok(baseline.clientRequests.includes(method), `${method} is not an App request`)
      assert.ok(cases.has(method) && !notFound.has(method), `${gate} needs an answer to ${method}`)
    }
  }
})

test('the codex shim reports the same compat version as the adapter', () => {
  const shim = readFileSync(new URL('scripts/codex-shim', root), 'utf8')
  const shimDefault = /CODEX_SHIM_COMPAT_VERSION:-([^}]+)\}/.exec(shim)?.[1]
  const saved = {
    CLAUDE_CODEX_COMPAT_VERSION: process.env.CLAUDE_CODEX_COMPAT_VERSION,
    CODEX_SHIM_COMPAT_VERSION: process.env.CODEX_SHIM_COMPAT_VERSION,
  }
  delete process.env.CLAUDE_CODEX_COMPAT_VERSION
  delete process.env.CODEX_SHIM_COMPAT_VERSION
  try {
    assert.equal(shimDefault, codexCompatVersion())
    assert.ok(shim.includes(`default to ${codexCompatVersion()}`), 'the shim comment names it')
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value !== undefined) process.env[name] = value
  }
})

// Semver precedence of two versions such as 0.163.0-alpha.10.2: negative
// when a comes first.
function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = '', pre] = version.split(/-(.*)/s)
    const parts = (text: string) =>
      text.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    return { core: parts(core) as number[], pre: pre ? parts(pre) : [] }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1)
    if (left.core[i] !== right.core[i]) return (left.core[i] ?? 0) - (right.core[i] ?? 0)
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

test('the adapter reports no newer a Codex version than the baseline App has', () => {
  // A newer one would turn on gates no verified App build was checked with.
  // It may be older: 26.1111 ships Codex 0.169.0-alpha.11.1, and the
  // default stays at 26.1013's, whose gates the adapter serves
  // (docs/reference/app-compat.md says which 26.1111 gates that keeps off).
  const baseline = JSON.parse(readFileSync(new URL('scripts/app-baseline.json', root), 'utf8'))
  const saved = {
    CLAUDE_CODEX_COMPAT_VERSION: process.env.CLAUDE_CODEX_COMPAT_VERSION,
    CODEX_SHIM_COMPAT_VERSION: process.env.CODEX_SHIM_COMPAT_VERSION,
  }
  delete process.env.CLAUDE_CODEX_COMPAT_VERSION
  delete process.env.CODEX_SHIM_COMPAT_VERSION
  try {
    const shipped = (baseline.codexVersion as string).replace(/^codex-cli /, '')
    assert.ok(
      compareVersions(codexCompatVersion(), shipped) <= 0,
      `${codexCompatVersion()} is newer than ${shipped}`,
    )
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value !== undefined) process.env[name] = value
  }
  assert.ok(compareVersions('0.163.0-alpha.10.2', '0.169.0-alpha.11.1') < 0)
  assert.ok(compareVersions('0.163.0-alpha.10.2', '0.163.0-alpha.11') < 0)
  assert.ok(compareVersions('0.163.0', '0.163.0-alpha.11') > 0)
  assert.equal(compareVersions('0.163.0-alpha.10.2', '0.163.0-alpha.10.2'), 0)
})

test('unverifiedAppWarning only speaks up for an unlisted desktop build', () => {
  const verified = VERIFIED_APP_VERSIONS[0] as string
  assert.equal(unverifiedAppWarning({ name: 'codex_desktop', version: verified }), null)
  assert.equal(unverifiedAppWarning({ name: 'Codex Desktop', version: verified }), null)
  assert.equal(unverifiedAppWarning({ name: 'codex_latex_preview', version: '1' }), null)
  assert.equal(unverifiedAppWarning({ name: 'codex-tui', version: '0.159.0' }), null)
  assert.equal(unverifiedAppWarning({}), null)

  // 26.1013 and older name themselves codex_desktop, 26.1111 Codex Desktop.
  for (const [name, version] of [
    ['codex_desktop', '26.1015.100'],
    ['Codex Desktop', '26.1199.100'],
  ] as const) {
    const warning = unverifiedAppWarning({ name, version })
    assert.ok(warning, name)
    assert.ok(warning.summary.includes(version))
    assert.ok(warning.details.includes(verified))
    assert.match(warning.details, /check:app-upgrade/)
  }

  assert.match(unverifiedAppWarning({ name: 'Codex Desktop' })?.summary ?? '', /\(no version\)/)
})

test('rendersCompletedSubagentActivity starts at 26.930', () => {
  assert.equal(rendersCompletedSubagentActivity('26.930.21537'), true)
  assert.equal(rendersCompletedSubagentActivity('26.1015.1'), true)
  assert.equal(rendersCompletedSubagentActivity('27.1.0'), true)
  assert.equal(rendersCompletedSubagentActivity('26.818.61809'), false)
  assert.equal(rendersCompletedSubagentActivity('26.818'), false)
  assert.equal(rendersCompletedSubagentActivity('unknown'), false)
  assert.equal(rendersCompletedSubagentActivity(''), false)
})
