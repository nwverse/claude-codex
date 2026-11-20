import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Tests run from dist/test; the script and the baseline sit two levels up.
const root = fileURLToPath(new URL('../../', import.meta.url))
const script = join(root, 'scripts', 'check-app-upgrade.mjs')

// An extracted App bundle holding `files`: package.json and minified scripts.
function bundle(version: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-codex-app-bundle-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'openai-codex', version }))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

function check(app: string, compatVersion?: string) {
  const env = { ...process.env }
  delete env.CLAUDE_CODEX_COMPAT_VERSION
  delete env.CODEX_SHIM_COMPAT_VERSION
  if (compatVersion) env.CLAUDE_CODEX_COMPAT_VERSION = compatVersion
  const result = spawnSync(process.execPath, [script, '--app', app, '--bundle-only'], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  })
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
}

// Ten gates, in either quote; the App compares the version the adapter reports
// with each.
function gateTable(quote: string, extra = ''): string {
  const gates = {
    appRead: '0.145.0-alpha.19',
    audioInputs: '0.145.0-alpha.24',
    projects: '0.148.0-alpha.21',
    threadAttachments: '0.155.0-alpha.2',
    threadForkBeforeTurn: '0.145.0-alpha.14',
    threadQueue: '0.148.0-alpha.14',
    threadRevert: '0.148.0-alpha.13',
    threadTimeline: '0.150.0-alpha.9',
    turnToolOutput: '0.151.0-alpha.4',
    turnApprovalsReviewer: '0.153.0-alpha.4',
  }
  const entries = Object.entries(gates).map(
    ([name, version]) => `${name}:${quote}${version}${quote}`,
  )
  return `{${extra}${entries.join(',')}}`
}

test('check:app-upgrade reads the gates, the minimum and the client name of a 26.1013 bundle', () => {
  // Template literals, the minimum next to the error prefix, and a literal
  // clientInfo name.
  const app = bundle('26.1013.40934', {
    '.vite/build/main-abc.js': [
      `let r=\`0.0.0\`,o=${gateTable('`')};`,
      'let x=`0.141.0`,y=`codex-app-server-version-unsupported:`;',
      'send({id:1,method:`initialize`,params:{clientInfo:{name:`codex_desktop`,title:`Codex Desktop`,version:c},capabilities:a}});',
      'send({method:`initialize`,params:{clientInfo:{name:`codex_latex_preview`,title:null,version:`1`}}});',
    ].join(''),
  })
  try {
    const { status, out } = check(app)
    assert.equal(status, 0, out)
    assert.match(out, /on {2}threadQueue +0\.148\.0-alpha\.14/)
    assert.match(out, /minimum app-server version: 0\.141\.0/)
    assert.match(out, /clientInfo names: codex_desktop, codex_latex_preview/)
    assert.doesNotMatch(out, /problem:/)
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})

test('check:app-upgrade reads the gates, the minimum and the client name of a 26.1111 bundle', () => {
  // Double-quoted strings, gates no version turns on (null), the minimum in a
  // constant of its own that the update-required error names, and a
  // clientInfo name that is another chunk's module constant.
  const app = bundle('26.1111.21308', {
    '.vite/build/early-bootstrap.js': [
      `71415(e,t,n){let r="0.0.0",o=${gateTable('"', 'commandSessionsWorldState:null,desktopMcpSocket:null,')};}`,
      'let ef="0.141.0";var eh=n(84698);let eg="codex-app-server-version-unsupported:",ev="codex-app-server-version-restart-available:";',
      'function e_(e){return e.startsWith(eg)?{code:"update-required",minRequiredVersion:ef,currentVersion:e.slice(eg.length)}:{code:"connection-failed",message:e}}',
      // The same minified name, set to a version in a later module.
      '5014(e,t,n){let ef="9.9.9";}',
    ].join(''),
    '.vite/build/early-bootstrap-631-c364.js':
      '12(e,t,n){n.d(t,{},{EW:"Something Else"})},87329(e,t,n){"use strict";n.d(t,{},{$o:"codex_desktop:browser-page-event",EW:"Codex Desktop",d9:"codex_desktop"})}',
    '.vite/build/early-bootstrap-226-2f6b.js': [
      // The same minified name bound in an earlier module, and in a later one.
      'var lr=r(12);function x(){return lr.EW}',
      'var lr=r(87329);class ln{}',
      'u=new e6.R$j(this.options.messageChannel,{clientInfo:{name:lr.EW,title:"Codex Desktop",version:c},defaultServiceName:lr.d9});',
      'E("initialize",{clientInfo:{name:"codex_latex_preview",title:null,version:"1"}});',
      'var lr=r(12);',
    ].join(''),
    // The renderer's copy imports the minimum.
    'webview/assets/async/976185.js':
      'e.startsWith(i)?{code:"update-required",minRequiredVersion:r.M,currentVersion:e.slice(i.length)}:null;let i="codex-app-server-version-unsupported:";',
  })
  try {
    const { status, out } = check(app)
    assert.equal(status, 0, out)
    assert.match(out, /on {2}threadQueue +0\.148\.0-alpha\.14/)
    assert.match(out, /off desktopMcpSocket +never/)
    assert.match(out, /minimum app-server version: 0\.141\.0/)
    assert.match(out, /clientInfo names: Codex Desktop, codex_latex_preview/)
    assert.doesNotMatch(out, /problem:/)
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})

test('check:app-upgrade reports a bundle without the desktop client name', () => {
  const app = bundle('26.1199.1', {
    '.vite/build/main.js': [
      `o=${gateTable('"')};`,
      'let ef="0.141.0",eg="codex-app-server-version-unsupported:";',
      'x({minRequiredVersion:ef});send({clientInfo:{name:"Codex Mobile",version:c}});',
    ].join(''),
  })
  try {
    const { status, out } = check(app)
    assert.equal(status, 1, out)
    assert.match(out, /clientInfo names: Codex Mobile/)
    assert.match(out, /problem: the App sends none of the desktop clientInfo names/)
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})

test('check:app-upgrade lists a request the adapter answers -32601 by design apart', () => {
  // thread/readState/update answers "method not found" as a Codex without its
  // state database does, under App rule thread-read-state.
  const app = bundle('26.1199.2', {
    '.vite/build/main.js': [
      `o=${gateTable('"')};`,
      'let ef="0.141.0",eg="codex-app-server-version-unsupported:";',
      'x({minRequiredVersion:ef});send({clientInfo:{name:"Codex Desktop",version:c}});',
      'r.sendRequest("thread/readState/update",{threadId:e});',
    ].join(''),
  })
  try {
    const { status, out } = check(app)
    assert.equal(status, 0, out)
    assert.match(
      out,
      /-32601 by design:\n {4}thread\/readState\/update \(rule thread-read-state\)\n/,
    )
    assert.doesNotMatch(out, /problem:/)
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})

test('check:app-upgrade reports a version that turns on a gate the adapter keeps off', () => {
  // feedbackSave is in KEPT_OFF_GATES: the App would save diagnostics
  // through feedback/save, which fails.
  const app = bundle('26.1199.3', {
    '.vite/build/main.js': [
      `o=${gateTable('"', 'feedbackSave:"0.164.0-alpha.11",')};`,
      'let ef="0.141.0",eg="codex-app-server-version-unsupported:";',
      'x({minRequiredVersion:ef});send({clientInfo:{name:"Codex Desktop",version:c}});',
    ].join(''),
  })
  try {
    const kept = check(app)
    assert.equal(kept.status, 0, kept.out)
    assert.match(kept.out, /off feedbackSave +0\.164\.0-alpha\.11/)
    const raised = check(app, '0.169.0-alpha.11.1')
    assert.equal(raised.status, 1, raised.out)
    assert.match(
      raised.out,
      /problem: the adapter's version turns on feedbackSave \(needs 0\.164\.0-alpha\.11\), which KEPT_OFF_GATES keeps off/,
    )
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})

test('check:app-upgrade writes its whole report into a pipe read late', {
  timeout: 30_000,
}, async () => {
  // 3000 names the protocol does not have make a report of several hundred
  // KiB, more than a pipe holds: the script must not exit before it is
  // written.
  const letters = (n: number) => {
    let text = ''
    for (let rest = n + 1; rest > 0; rest = Math.floor((rest - 1) / 26))
      text = String.fromCharCode(97 + ((rest - 1) % 26)) + text
    return text
  }
  const names = Array.from({ length: 3000 }, (_, i) => `"thread/unknown${letters(i)}"`)
  const app = bundle('26.1199.4', {
    '.vite/build/main.js': [
      `o=${gateTable('"')};`,
      'let ef="0.141.0",eg="codex-app-server-version-unsupported:";',
      'x({minRequiredVersion:ef});send({clientInfo:{name:"Codex Desktop",version:c}});',
      `y=[${names.join(',')}];`,
    ].join(''),
  })
  try {
    const env = { ...process.env }
    delete env.CLAUDE_CODEX_COMPAT_VERSION
    delete env.CODEX_SHIM_COMPAT_VERSION
    const child = spawn(process.execPath, [script, '--app', app, '--bundle-only'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const closed = once(child, 'close')
    // Read nothing until the pipe is full and the script is done writing.
    await delay(1500)
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    const [status] = await closed
    const out = Buffer.concat(chunks).toString('utf8')
    assert.equal(status, 1)
    assert.equal(out.match(/^problem: the App names thread\/unknown[a-z]+,/gm)?.length, 3000)
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})
