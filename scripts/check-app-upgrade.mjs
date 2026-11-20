#!/usr/bin/env node

// Checks a Codex desktop App build against what the adapter assumes about it,
// before the build joins VERIFIED_APP_VERSIONS in src/app-compat.mts:
//
// - the app-server protocol of its codex (methods the App may call that the
//   adapter answers with "method not found", methods the adapter sends that
//   the schema no longer has), as its bundled codex generates it or as --protocol-source
//   reads it from codex's source;
// - the methods the App's scripts name: a client request the adapter does not
//   answer is a problem, and so is, with --bundle-only, a name the protocol
//   lists do not know;
// - the App's feature-gate table and minimum app-server version, against the
//   version the adapter reports, and the methods each gate it turns on makes
//   the App call (GATED_METHODS in src/app-compat.mts);
// - the clientInfo name the App sends in initialize, which must be one of
//   DESKTOP_CLIENT_NAMES;
// - the App rules, which only a person can re-check.
//
// --app takes an App bundle, its app.asar, or a directory app.asar was
// extracted to. The comparison is with scripts/app-baseline.json (the last
// verified build), or with another App given as --old. --protocol-source reads
// the protocol from a codex checkout (the release tag of the App's codex)
// instead of running a codex binary; --bundle-only reads no protocol and takes
// the baseline's lists for it.
//
//   npm run check:app-upgrade -- --app /Applications/Codex.app
//   npm run check:app-upgrade -- --app <new.app> --old <old.app>
//   npm run check:app-upgrade -- --app <new.app> --protocol-source <codex checkout>
//   npm run check:app-upgrade -- --app <new.app> --bundle-only
//   npm run check:app-upgrade -- --app <verified.app> --write-baseline

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    old: { type: 'string' },
    codex: { type: 'string' },
    'protocol-source': { type: 'string' },
    'bundle-only': { type: 'boolean', default: false },
    baseline: { type: 'string', default: join(root, 'scripts', 'app-baseline.json') },
    'write-baseline': { type: 'boolean', default: false },
  },
})

// The check ends by setting process.exitCode and letting Node exit once
// stdout is written: exiting at once would drop what a pipe has not taken
// yet. fail() stops it with a CheckStopped, which only sets the code.
class CheckStopped extends Error {}
process.on('uncaughtException', (error) => {
  if (error instanceof CheckStopped) return
  console.error(error)
  process.exitCode = 1
})

function fail(message) {
  console.error(`check-app-upgrade: ${message}`)
  process.exitCode = 2
  throw new CheckStopped(message)
}

const baselinePath = resolve(args.baseline)
const bundleOnly = args['bundle-only']
const protocolSource = args['protocol-source'] && resolve(args['protocol-source'])
if (!args.app) fail('pass the App bundle to check with --app <path/to/Codex.app>')
if (args.codex && protocolSource) fail('pass either --codex or --protocol-source')
if (bundleOnly && (args.codex || protocolSource))
  fail('--bundle-only reads no protocol; drop --codex and --protocol-source')
if (bundleOnly && args['write-baseline'])
  fail('a baseline records the protocol; write it without --bundle-only')
const recorded = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null
if (bundleOnly && !recorded)
  fail(`--bundle-only takes the protocol from ${baselinePath}, which is missing`)

const {
  APP_RULES,
  DESKTOP_CLIENT_NAMES,
  dispatchCases,
  GATED_METHODS,
  KEPT_OFF_GATES,
  VERIFIED_APP_VERSIONS,
} = await import(join(root, 'dist', 'src', 'app-compat.mjs')).catch(() =>
  fail('dist/ is missing; run it through `npm run check:app-upgrade`'),
)
const { codexCompatVersion } = await import(join(root, 'dist', 'src', 'util.mjs'))

// --- App bundle ------------------------------------------------------------

function resourcesDir(app) {
  const mac = join(app, 'Contents', 'Resources')
  if (existsSync(mac)) return mac
  const other = join(app, 'resources')
  if (existsSync(other)) return other
  return app
}

// The App's files: out of app.asar in an App bundle (or app.asar itself), or
// out of a directory app.asar was extracted to.
function openBundle(path) {
  if (statSync(path, { throwIfNoEntry: false })?.isFile()) return openAsar(path)
  const asarPath = join(resourcesDir(path), 'app.asar')
  if (existsSync(asarPath)) return openAsar(asarPath)
  if (existsSync(join(path, 'package.json'))) return openDirectory(path)
  fail(`no app.asar under ${path}`)
}

// The directories that hold the App's scripts.
const SCRIPT_DIRS = ['webview/assets/', '.vite/build/']

function openDirectory(dir) {
  const files = [{ path: 'package.json' }]
  const walk = (prefix) => {
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push({ path })
    }
  }
  for (const scripts of SCRIPT_DIRS) if (existsSync(join(dir, scripts))) walk(scripts.slice(0, -1))
  return {
    files,
    read: (file) => readFileSync(join(dir, file.path), 'latin1'),
    close() {},
  }
}

// Reads files straight out of app.asar: a pickled JSON index, then the file
// bodies at offsets relative to the end of that index.
function openAsar(path) {
  const fd = openSync(path, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonSize)
  readSync(fd, json, 0, jsonSize, 16)
  const index = JSON.parse(json.toString('utf8'))
  const base = 8 + headerSize
  const files = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, path)
      else if (typeof entry.offset === 'string' && !entry.unpacked) files.push({ path, ...entry })
    }
  }
  walk(index, '')
  return {
    files,
    read(file) {
      const body = Buffer.alloc(file.size)
      readSync(fd, body, 0, file.size, base + Number(file.offset))
      return body.toString('latin1')
    },
    close: () => closeSync(fd),
  }
}

// The minifier wrote string literals as template literals (`…`) up to
// 26.1013 and as double-quoted strings ("…") from 26.1111, so the patterns
// take either quote.
const QUOTE = '["\'`]'
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`
const KEY = String.raw`[A-Za-z_$][\w$]*`
// A gate needs a version, or is null when no version turns it on (26.1111).
const GATE = String.raw`${KEY}:(?:${QUOTE}${VERSION}${QUOTE}|null)`
const GATE_TABLE = new RegExp(String.raw`\{(?:${GATE},){8,}${GATE}\}`, 'g')
const GATE_ENTRY = new RegExp(String.raw`(${KEY}):(?:${QUOTE}(${VERSION})${QUOTE}|null)`, 'g')
const UNSUPPORTED = 'codex-app-server-version-unsupported:'
// The minimum, declared together with the prefix of the error that rejects
// a server below it (26.1013), or in a constant of its own that the
// update-required error names (26.1111).
const MINIMUM = new RegExp(String.raw`${QUOTE}(${VERSION})${QUOTE},${KEY}=${QUOTE}${UNSUPPORTED}`)
const MINIMUM_NAME = new RegExp(String.raw`minRequiredVersion:(${KEY})[,}]`)
// clientInfo.name in initialize: a literal (26.1013), or a constant of
// another module (26.1111: name:lr.EW, lr=r(87329)).
const CLIENT_NAME = new RegExp(
  String.raw`clientInfo:\{name:(?:${QUOTE}([^"'\`]+)${QUOTE}|(${KEY})\.(${KEY})[,}])`,
  'g',
)
// A string literal shaped like an app-server method: namespace/name[/...].
const METHOD_NAME = /[`'"]([a-z][A-Za-z]*(?:\/[A-Za-z_]+)+)[`'"]/g

const asPattern = (name) => name.replaceAll('$', '\\$')

// The version the minimum's constant is set to: the declaration of that name
// closest before the error prefix, as minified names repeat across modules.
function minimumIn(text) {
  const old = text.match(MINIMUM)?.[1]
  if (old) return old
  const name = text.match(MINIMUM_NAME)?.[1]
  if (!name) return null
  const before = text.indexOf(UNSUPPORTED)
  let found = null
  const declaration = new RegExp(
    String.raw`(?:^|[^\w$.])${asPattern(name)}=${QUOTE}(${VERSION})${QUOTE}`,
    'g',
  )
  for (const match of text.matchAll(declaration)) {
    if (found && match.index > before) break
    found = match[1]
  }
  return found
}

// The module a minified name used at `at` was bound to in a script
// (`lr=r(87329)`, `e2=n("N2rm")`): the binding closest before the use, as
// minified names repeat across modules. Then the constant `key` that module
// exports.
function moduleOf(text, name, at) {
  const binding = new RegExp(
    String.raw`(?:^|[^\w$.])${asPattern(name)}=${KEY}\(\s*"?([\w$]+)"?\s*\)`,
    'g',
  )
  let found = null
  for (const match of text.matchAll(binding)) {
    if (found && match.index > at) break
    found = match[1]
  }
  return found
}

function exportedConstant(text, id, key) {
  const start = new RegExp(
    String.raw`(?:^|[,{])"?${asPattern(id)}"?\(${KEY},${KEY},${KEY}\)\{`,
  ).exec(text)
  if (!start) return null
  const body = text.slice(start.index, start.index + 50_000)
  return new RegExp(String.raw`[,{]${asPattern(key)}:${QUOTE}([^"'\`]+)${QUOTE}`).exec(body)?.[1]
}

function bundleFacts(app) {
  const asar = openBundle(app)
  try {
    const pkg = asar.files.find((file) => file.path === 'package.json')
    const appVersion = pkg ? JSON.parse(asar.read(pkg)).version : null
    let gates = null
    let minimum = null
    const clientNames = new Set()
    // clientInfo names that are another module's constant, found in a second
    // pass over the scripts of the same directory.
    const exported = []
    const names = new Set()
    const scripts = asar.files.filter(
      (file) => file.path.endsWith('.js') && SCRIPT_DIRS.some((dir) => file.path.startsWith(dir)),
    )
    for (const file of scripts) {
      const text = asar.read(file)
      for (const match of text.matchAll(METHOD_NAME)) names.add(match[1])
      if (/threadQueue:["'`]/.test(text)) {
        for (const match of text.matchAll(GATE_TABLE)) {
          const table = Object.fromEntries(
            [...match[0].matchAll(GATE_ENTRY)].map((entry) => [entry[1], entry[2] ?? null]),
          )
          if (
            'threadQueue' in table &&
            (!gates || Object.keys(table).length > Object.keys(gates).length)
          )
            gates = table
        }
      }
      if (!minimum && text.includes(UNSUPPORTED)) minimum = minimumIn(text)
      if (text.includes('clientInfo:{name:'))
        for (const match of text.matchAll(CLIENT_NAME)) {
          if (match[1]) clientNames.add(match[1])
          else {
            const id = moduleOf(text, match[2], match.index)
            const dir = SCRIPT_DIRS.find((prefix) => file.path.startsWith(prefix))
            if (id) exported.push({ id, key: match[3], dir, expression: match[0] })
            else notes.push(`could not tell which module ${match[2]} is in ${file.path}`)
          }
        }
    }
    for (const file of exported.length > 0 ? scripts : []) {
      const pending = exported.filter((ref) => !ref.value && file.path.startsWith(ref.dir))
      if (pending.length === 0) continue
      const text = asar.read(file)
      for (const ref of pending) ref.value = exportedConstant(text, ref.id, ref.key)
    }
    for (const ref of exported) {
      if (ref.value) clientNames.add(ref.value)
      else notes.push(`could not resolve the clientInfo name of \`${ref.expression}\``)
    }
    return { appVersion, gates, minimum, clientNames: [...clientNames].sort(), names }
  } finally {
    asar.close()
  }
}

// --- Protocol --------------------------------------------------------------

function looksLikeAdapterShim(path) {
  try {
    if (statSync(path).size > 128_000) return false
    const text = readFileSync(path, 'utf8')
    return (
      text.includes('CLAUDE_CODEX_ADAPTER') ||
      text.includes('codex shim') ||
      text.includes('CODEX_REAL')
    )
  } catch {
    return false
  }
}

function codexVersion(path) {
  const result = spawnSync(path, ['--version'], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return result.status === 0 && /\bcodex-cli\b/.test(output) ? output.trim() : null
}

// The App's own codex, never an adapter shim installed over it.
function appCodex(app, explicit) {
  const resources = resourcesDir(app)
  const candidates = explicit
    ? [explicit]
    : [
        join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
        join(resources, 'codex.real'),
        join(resources, 'codex'),
        join(resources, 'codex.exe'),
      ]
  for (const candidate of candidates) {
    if (!existsSync(candidate) || looksLikeAdapterShim(candidate)) continue
    const version = codexVersion(candidate)
    if (version) return { path: candidate, version }
  }
  fail(`found no real codex in ${resources}; pass one with --codex`)
}

function protocolFacts(codex) {
  const out = mkdtempSync(join(tmpdir(), 'claude-codex-app-schema-'))
  try {
    const result = spawnSync(
      codex.path,
      ['app-server', 'generate-ts', '--experimental', '--out', out],
      { encoding: 'utf8', env: { ...process.env, CODEX_HOME: out } },
    )
    const methodsIn = (file) => {
      const path = join(out, file)
      if (!existsSync(path)) fail(`${codex.path} generated no ${file}: ${result.stderr.trim()}`)
      return [
        ...new Set(
          [...readFileSync(path, 'utf8').matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]),
        ),
      ].sort()
    }
    const types = {}
    for (const dir of ['', 'v2']) {
      const path = join(out, dir)
      if (!existsSync(path)) continue
      for (const file of readdirSync(path)) {
        if (!file.endsWith('.ts')) continue
        const name = dir ? `${dir}/${file.slice(0, -3)}` : file.slice(0, -3)
        types[name] = createHash('sha256')
          .update(readFileSync(join(path, file)))
          .digest('hex')
          .slice(0, 12)
      }
    }
    return {
      codexVersion: codex.version,
      clientRequests: methodsIn('ClientRequest.ts'),
      serverRequests: methodsIn('ServerRequest.ts'),
      serverNotifications: methodsIn('ServerNotification.ts'),
      types,
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

// The protocol lists from codex's source: the entries of the macros that
// define them in app-server-protocol, `Name => "method" { params: ... }` for a
// request and `Name => "method" (Type)` for a notification.
function sourceFacts(dir) {
  const path = [join(dir, 'codex-rs'), dir]
    .map((base) => join(base, 'app-server-protocol', 'src', 'protocol', 'common.rs'))
    .find((candidate) => existsSync(candidate))
  if (!path) fail(`no app-server-protocol/src/protocol/common.rs under ${dir}`)
  const text = withoutComments(readFileSync(path, 'utf8'))
  // An entry with the attributes before it. Its wire name is the `=> "…"`
  // literal, else a #[serde(rename = "…")] among the attributes, else the
  // variant name in camelCase.
  const attributes = String.raw`((?:#\[[^\]]*\]\s*)*)`
  const request = new RegExp(
    String.raw`${attributes}\b([A-Z]\w*)\s*(?:=>\s*"([^"]+)")?\s*\{\s*params\b`,
    'g',
  )
  const notification = new RegExp(
    String.raw`${attributes}\b([A-Z]\w*)\s*(?:=>\s*"([^"]+)")?\s*\(`,
    'g',
  )
  const methods = (macro, entry) => {
    const body = macroBody(text, macro)
    if (body == null) fail(`found no ${macro}! in ${path}; did its format change?`)
    const names = [...body.matchAll(entry)].map(
      ([, attrs, variant, wire]) =>
        wire ??
        /#\[serde\(\s*rename\s*=\s*"([^"]+)"\s*\)\]/.exec(attrs)?.[1] ??
        `${variant[0].toLowerCase()}${variant.slice(1)}`,
    )
    return [...new Set(names)].sort()
  }
  const facts = {
    codexVersion: `codex-cli ${sourceVersion(resolve(dirname(path), '..', '..', '..'))}`,
    clientRequests: methods('client_request_definitions', request),
    serverRequests: methods('server_request_definitions', request),
    serverNotifications: methods('server_notification_definitions', notification),
  }
  for (const [key, least, members] of [
    ['clientRequests', 50, ['initialize', 'thread/start', 'turn/start']],
    ['serverRequests', 3, ['item/commandExecution/requestApproval']],
    ['serverNotifications', 20, ['turn/started', 'turn/completed']],
  ]) {
    const missing = members.filter((method) => !facts[key].includes(method))
    if (facts[key].length < least || missing.length > 0)
      fail(
        `read ${facts[key].length} ${key} from ${path}` +
          (missing.length > 0 ? `, without ${missing.join(', ')}` : '') +
          '; did the macro format change?',
      )
  }
  return facts
}

// Rust source without its comments.
function withoutComments(source) {
  let out = ''
  let from = 0
  let i = 0
  while (i < source.length) {
    if (source[i] === '"') {
      i = stringEnd(source, i)
    } else if (source.startsWith('//', i) || source.startsWith('/*', i)) {
      out += source.slice(from, i)
      const block = source[i + 1] === '*'
      const end = source.indexOf(block ? '*/' : '\n', i + 2)
      i = end < 0 ? source.length : block ? end + 2 : end
      from = i
    } else {
      i += 1
    }
  }
  return out + source.slice(from)
}

// The index just past the string literal that starts at `start`.
function stringEnd(source, start) {
  let i = start + 1
  while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1
  return i + 1
}

// The body of the macro invocation `name! { ... }` that starts a line.
function macroBody(text, name) {
  const start = new RegExp(String.raw`^${name}!\s*\{`, 'm').exec(text)
  if (!start) return null
  const open = start.index + start[0].length - 1
  let depth = 0
  let i = open
  while (i < text.length) {
    if (text[i] === '"') {
      i = stringEnd(text, i)
      continue
    }
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
    i += 1
  }
  return null
}

// The version of a codex checkout: the workspace version in Cargo.toml, which
// only a release sets (the source tree says 0.0.0), else the release tag git
// describes.
function sourceVersion(codexRs) {
  const cargo = join(codexRs, 'Cargo.toml')
  if (existsSync(cargo)) {
    const version = /\[workspace\.package\][^[]*?\bversion\s*=\s*"([^"]+)"/.exec(
      readFileSync(cargo, 'utf8'),
    )?.[1]
    if (version && version !== '0.0.0') return version
  }
  const tag = spawnSync('git', ['-C', codexRs, 'describe', '--tags'], { encoding: 'utf8' })
  return tag.status === 0 ? tag.stdout.trim().replace(/^rust-v/, '') : 'unknown'
}

function protocolLists(from) {
  return {
    clientRequests: from.clientRequests,
    serverRequests: from.serverRequests,
    serverNotifications: from.serverNotifications,
  }
}

// What the protocol makes of the method-shaped names in the App's scripts:
// the client requests among them, and the names in a protocol namespace that
// the protocol does not have (methods of other hosts the App talks to, MIME
// types such as model/obj).
function appMethods(names, protocol) {
  const requests = new Set(protocol.clientRequests)
  const outgoing = new Set([...protocol.serverRequests, ...protocol.serverNotifications])
  const namespaces = new Set([...requests, ...outgoing].map((method) => method.split('/')[0]))
  const sorted = [...names].sort()
  return {
    appRequests: sorted.filter((name) => requests.has(name)),
    appOtherMethods: sorted.filter(
      (name) => namespaces.has(name.split('/')[0]) && !requests.has(name) && !outgoing.has(name),
    ),
  }
}

// With --bundle-only the baseline's protocol lists stand in for the App's.
function facts(app, { codex, source } = {}) {
  const bundle = bundleFacts(app)
  const protocol = bundleOnly
    ? { codexVersion: null, ...protocolLists(recorded) }
    : source
      ? sourceFacts(source)
      : protocolFacts(appCodex(app, codex))
  return { ...bundle, ...protocol, ...appMethods(bundle.names, protocol) }
}

// --- Adapter side ------------------------------------------------------------

// The files whose switch answers the App's requests.
const DISPATCH_FILES = new Set(['server.mts', 'host-methods.mts'])

// handled: the requests a case answers, leaving out the cases that only
// answer "method not found" (dispatchCases in src/app-compat.mts). byDesign:
// those of them an App rule says the App copes with.
function adapterFacts() {
  const handled = new Set()
  const byDesign = new Map()
  const sent = new Set()
  const srcDir = join(root, 'src')
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.mts')) continue
    const text = readFileSync(join(srcDir, file), 'utf8')
    if (DISPATCH_FILES.has(file)) {
      const switchCases = dispatchCases(text)
      for (const method of switchCases.cases)
        if (!switchCases.notFound.has(method)) handled.add(method)
      for (const [method, rule] of switchCases.byDesign) byDesign.set(method, rule)
    }
    for (const match of text.matchAll(
      /method: '([a-zA-Z]+(?:\/[a-zA-Z_]+)+|configWarning|error|warning)'/g,
    ))
      sent.add(match[1])
  }
  return { handled, byDesign, sent }
}

// A method the adapter answers with "method not found", and why when that is
// by design.
const notFound = (method) =>
  adapter.byDesign.has(method)
    ? `${method} (by design, rule ${adapter.byDesign.get(method)})`
    : method

// --- Versions --------------------------------------------------------------

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]
      ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  }
}

// Semver precedence, as the App compares gate versions.
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return Number.NaN
  for (let i = 0; i < 3; i += 1)
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i]
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

// --- Report ----------------------------------------------------------------

const problems = []
const notes = []

function diff(before, after) {
  const old = new Set(before)
  const now = new Set(after)
  return { added: after.filter((x) => !old.has(x)), removed: before.filter((x) => !now.has(x)) }
}

function list(label, items, describe = (x) => x) {
  if (items.length === 0) return
  console.log(`  ${label}:`)
  for (const item of items) console.log(`    ${describe(item)}`)
}

const next = facts(resolve(args.app), { codex: args.codex, source: protocolSource })
let previous
let previousLabel
if (args.old) {
  previous = facts(resolve(args.old))
  previousLabel = `--old ${previous.appVersion}`
} else if (recorded) {
  previous = recorded
  previousLabel = `baseline ${previous.appVersion}`
} else if (args['write-baseline']) {
  previous = next
  previousLabel = 'itself (no baseline yet)'
} else {
  fail(`no ${baselinePath}; pass --old or create it with --write-baseline`)
}
const adapter = adapterFacts()
const reported = codexCompatVersion()
const verified = VERIFIED_APP_VERSIONS.includes(next.appVersion)

console.log(
  `Codex App ${next.appVersion} against ${previousLabel}` +
    (verified ? ' (already verified)' : ' (not verified yet)'),
)
if (bundleOnly)
  console.log(
    `  codex: not read (--bundle-only); the protocol of baseline ${recorded.appVersion} (${recorded.codexVersion}) stands in`,
  )
else
  console.log(`  codex: ${next.codexVersion}${protocolSource ? ` (source ${protocolSource})` : ''}`)

if (!bundleOnly) {
  console.log('\nProtocol')
  for (const [key, label] of [
    ['clientRequests', 'client requests'],
    ['serverRequests', 'server requests'],
    ['serverNotifications', 'server notifications'],
  ]) {
    const { added, removed } = diff(previous[key], next[key])
    console.log(`  ${label}: ${next[key].length} (+${added.length} -${removed.length})`)
    if (key === 'clientRequests') {
      list(
        'new, answered with "method not found"',
        added.filter((m) => !adapter.handled.has(m)),
        (m) => `+ ${notFound(m)}`,
      )
      list(
        'new, already handled',
        added.filter((m) => adapter.handled.has(m)),
        (m) => `+ ${m}`,
      )
    } else {
      list('new', added, (m) => `+ ${m}`)
    }
    list('removed', removed, (m) => `- ${m}`)
  }
  const unanswered = next.clientRequests.filter((m) => !adapter.handled.has(m))
  console.log(
    `  answered with "method not found" (${unanswered.length}): ${unanswered.map(notFound).join(', ')}`,
  )
  const schemaOut = new Set([...next.serverRequests, ...next.serverNotifications])
  const previousOut = new Set([...previous.serverRequests, ...previous.serverNotifications])
  const gone = [...adapter.sent].filter((m) => !schemaOut.has(m) && previousOut.has(m)).sort()
  for (const method of gone)
    problems.push(`the adapter sends ${method}, which the new schema dropped`)
  if (previous.types && next.types) {
    const names = diff(Object.keys(previous.types).sort(), Object.keys(next.types).sort())
    const changed = Object.keys(next.types)
      .filter((name) => name in previous.types && previous.types[name] !== next.types[name])
      .sort()
    console.log(
      `  types: ${Object.keys(next.types).length} (+${names.added.length} -${names.removed.length} ~${changed.length})`,
    )
    list('changed', changed, (name) => `~ ${name}`)
    list('removed', names.removed, (name) => `- ${name}`)
  }
}

function appMethodsReport() {
  console.log('\nMethods the App names')
  const requests = diff(previous.appRequests ?? [], next.appRequests)
  console.log(
    `  client requests: ${next.appRequests.length}` +
      (previous.appRequests ? ` (+${requests.added.length} -${requests.removed.length})` : ''),
  )
  if (previous.appRequests) {
    list('newly named', requests.added, (m) => `+ ${m}`)
    list('no longer named', requests.removed, (m) => `- ${m}`)
  }
  const unanswered = next.appRequests.filter((m) => !adapter.handled.has(m))
  list(
    '-32601 by design',
    unanswered.filter((m) => adapter.byDesign.has(m)),
    (m) => `${m} (rule ${adapter.byDesign.get(m)})`,
  )
  for (const method of unanswered.filter((m) => !adapter.byDesign.has(m)))
    problems.push(`the App calls ${method}, which the adapter answers with "method not found"`)
  const others = previous.appOtherMethods
  const other = diff(others ?? [], next.appOtherMethods)
  console.log(
    `  not in the protocol: ${next.appOtherMethods.length}` +
      (others ? ` (+${other.added.length} -${other.removed.length})` : ''),
  )
  if (!others) {
    list('names', next.appOtherMethods)
    notes.push(
      `${previousLabel} records no names outside the protocol; check the ones the App names by hand`,
    )
    return
  }
  list('newly named', other.added, (m) => `+ ${m}`)
  for (const method of other.added.filter(
    (m) => !adapter.handled.has(m) && !adapter.byDesign.has(m),
  )) {
    if (bundleOnly)
      problems.push(
        `the App names ${method}, which the adapter does not answer and the protocol of ${previousLabel} does not have; read the App's protocol with --protocol-source`,
      )
    else
      notes.push(
        `the App names ${method}, which is no app-server method; make sure the App does not send it to the adapter`,
      )
  }
}
appMethodsReport()

// A gate is on from its version up; a null gate is off for every version
// but the App's own development builds (0.0.0).
const gateOn = (version) => version != null && compareVersions(reported, version) >= 0

console.log(`\nFeature gates (adapter reports ${reported})`)
if (!next.gates) {
  problems.push('found no feature-gate table in the bundle; check the gates by hand')
} else {
  const before = previous.gates ?? {}
  for (const [name, version] of Object.entries(next.gates).sort()) {
    const state = gateOn(version) ? 'on ' : 'off'
    const change = !(name in before)
      ? '  (new)'
      : before[name] !== version
        ? `  (was ${before[name] ?? 'never'})`
        : ''
    console.log(`  ${state} ${name.padEnd(32)} ${version ?? 'never'}${change}`)
    if (name in before && gateOn(before[name]) && !gateOn(version))
      notes.push(
        `${name} was on for ${reported} and is off now: it needs ${version ?? 'a 0.0.0 build'}`,
      )
  }
  for (const name of Object.keys(before).filter((name) => !(name in next.gates)))
    console.log(`  --  ${name.padEnd(32)} removed`)
  for (const [name, methods] of Object.entries(GATED_METHODS)) {
    if (!(name in next.gates)) {
      notes.push(`GATED_METHODS lists ${name}, which App ${next.appVersion} does not gate on`)
      continue
    }
    if (!gateOn(next.gates[name])) continue
    const unanswered = methods.filter(
      (method) => !adapter.handled.has(method) && !adapter.byDesign.has(method),
    )
    if (unanswered.length > 0)
      problems.push(
        `the adapter's version turns on ${name}, but it does not answer ${unanswered.join(', ')}`,
      )
  }
  for (const [name, reason] of Object.entries(KEPT_OFF_GATES)) {
    if (!(name in next.gates)) {
      notes.push(`KEPT_OFF_GATES lists ${name}, which App ${next.appVersion} does not gate on`)
      continue
    }
    if (gateOn(next.gates[name]))
      problems.push(
        `the adapter's version turns on ${name} (needs ${next.gates[name]}), which KEPT_OFF_GATES keeps off: ${reason}`,
      )
  }
  for (const name of Object.keys(next.gates).filter(
    (name) => !(name in before) && !(name in GATED_METHODS) && !(name in KEPT_OFF_GATES),
  ))
    if (gateOn(next.gates[name]))
      notes.push(
        `the new gate ${name} is on; find what the App calls behind it and add those methods to GATED_METHODS`,
      )
  if (!gateOn(next.gates.threadQueue))
    notes.push(
      `the App keeps queued messages in the window: threadQueue needs ${next.gates.threadQueue}, set CLAUDE_CODEX_COMPAT_VERSION to use the server-side queue`,
    )
}
if (!next.minimum) {
  problems.push('found no minimum app-server version in the bundle; check it by hand')
} else {
  console.log(`  minimum app-server version: ${next.minimum}`)
  if (compareVersions(reported, next.minimum) < 0)
    problems.push(`the App requires app-server ${next.minimum}; the adapter reports ${reported}`)
}

console.log(`\nclientInfo names: ${next.clientNames.join(', ') || '(none found)'}`)
if (!next.clientNames.some((name) => DESKTOP_CLIENT_NAMES.includes(name)))
  problems.push(
    `the App sends none of the desktop clientInfo names the adapter knows (${DESKTOP_CLIENT_NAMES.join(', ')})`,
  )

console.log('\nApp rules to re-check by hand (src/app-compat.mts, docs/reference/app-compat.md)')
for (const rule of APP_RULES) {
  console.log(`  [ ] ${rule.id}: ${rule.app}`)
  console.log(`      check: ${rule.verify}`)
}

for (const note of notes) console.log(`\nnote: ${note}`)
for (const problem of problems) console.log(`\nproblem: ${problem}`)

if (args['write-baseline']) {
  if (problems.length > 0) fail('not writing a baseline while there are problems')
  if (!verified)
    fail(`add ${next.appVersion} to VERIFIED_APP_VERSIONS before writing it as the baseline`)
  const { types: _types, names: _names, ...baseline } = next
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
  // Lay it out the way `npm run check` expects.
  const biome = spawnSync(join(root, 'node_modules', '.bin', 'biome'), [
    'format',
    '--write',
    baselinePath,
  ])
  if (biome.status !== 0) console.log(`\nrun \`npx biome format --write ${baselinePath}\``)
  console.log(`\nwrote ${baselinePath}`)
} else if (!verified && problems.length === 0) {
  console.log(
    `\nOnce the rules hold, add ${next.appVersion} to VERIFIED_APP_VERSIONS and rerun with --write-baseline` +
      (bundleOnly ? " and the protocol (--protocol-source or the App's codex)." : '.'),
  )
}

process.exitCode = problems.length > 0 ? 1 : 0
