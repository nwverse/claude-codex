import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { askRuleCovers, askRulesGuard, bashRuleCovers } from '../src/ask-rules.mjs'

test('a Bash ask rule covers every command of a command line and what wrappers run', () => {
  const covered = (specifier: string, line: string) => bashRuleCovers(specifier, line)
  for (const line of [
    'git push',
    'git push origin main',
    'npm test && git push',
    'npm test || git push; echo done',
    'git fetch | git push',
    'npm test & git push',
    'FOO=1 BAR="a b" git push',
    'timeout 30 git push',
    'nice -n 5 nohup git push',
    'sh -c "git push --force"',
    "bash -lc 'cd app && git push'",
    'eval git push',
    'echo hi > out.txt; git  push',
    'git push 2>&1 | tee log',
    '/usr/bin/git push',
    'if true; then git push; fi',
    'xargs -n1 git push < remotes',
  ])
    assert.equal(covered('git push:*', line), true, line)
  for (const line of [
    'git status',
    'git status 2>&1 | grep push',
    'echo git push',
    "echo 'git push'",
    'npm test # git push',
  ])
    assert.equal(covered('git push:*', line), false, line)

  // A command line whose commands only the shell can work out could run
  // anything, so any Bash rule asks about it.
  for (const line of [
    'echo $(git push)',
    'echo `git push`',
    'cat <<EOF\ngit push\nEOF',
    '$GIT push',
    'echo $(date)',
    'diff <(ls a) <(ls b)',
    "echo 'unterminated",
    'sh -c "echo $(id)"',
  ]) {
    assert.equal(covered('git push:*', line), true, line)
    assert.equal(covered('rm *', line), true, line)
  }

  // Wildcards: `cmd *` covers cmd and its arguments, not a longer name.
  assert.equal(covered('ls *', 'ls'), true)
  assert.equal(covered('ls *', 'ls -la'), true)
  assert.equal(covered('ls *', 'lsof'), false)
  assert.equal(covered('git * main', 'git push origin main'), true)
  assert.equal(covered('git * main', 'git push origin dev'), false)
  // A plain command covers more arguments too, and its quoting need not
  // match.
  assert.equal(covered('git commit -m "wip"', "git commit -m 'wip'"), true)
  assert.equal(covered('git commit', 'git commit --amend'), true)
  assert.equal(covered('git commit', 'git commits'), false)
  assert.equal(covered('rm:*', 'find . -name "*.tmp" -exec rm {} \\;'), true)
})

test('a Bash ask rule reads the script a shell runs with -c after its other options', () => {
  for (const line of [
    "bash -c -- 'rm -rf build'",
    "bash -c -e 'rm -rf build'",
    "bash -c -o pipefail 'rm -rf build'",
    "bash -ceo pipefail 'rm -rf build'",
    "bash -O extglob -c 'rm -rf build'",
    "sh -c - 'rm -rf build'",
    "zsh -fc 'rm -rf build'",
    "fish -c 'rm -rf build'",
    "ksh -c -R x 'rm -rf build'",
    // Behind a wrapper, with more than one command in the script.
    "nohup bash -c 'cd app && rm -rf build'",
    "timeout 5 sh -c 'true; rm -rf build'",
    "sudo bash -c 'echo hi; rm -rf build'",
    "env FOO=1 bash -c 'true; rm -rf build'",
    "xargs sh -c 'echo x; rm -rf build'",
    'find . -exec sh -c \'true && rm -rf "$1"\' _ {} \\;',
    // Quoting the outer shell takes away before the inner one reads it.
    'bash -c "r\\\nm -rf build"',
    'bash -c "echo \\\'; rm -rf build; \\\'"',
  ])
    assert.equal(bashRuleCovers('rm:*', line), true, line)
  // The words after the script are its arguments, and a script file is not
  // read.
  assert.equal(bashRuleCovers('rm:*', 'bash -c \'echo "$1"\' _ rm'), false)
  assert.equal(bashRuleCovers('rm:*', 'bash -c \'ls\' _ "$X"'), false)
  assert.equal(bashRuleCovers('rm:*', 'bash script.sh -c rm'), false)
  assert.equal(bashRuleCovers('rm:*', 'bash --version'), false)
  // A shell reading its commands from stdin could run anything.
  for (const line of [
    "echo 'rm -rf build' | sh",
    'cat cmds | bash -s',
    'echo x | sudo -s',
    'su root',
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
})

test('a Bash ask rule covers what wrappers run, whichever of their options take a value', () => {
  for (const line of [
    'setsid rm -rf build',
    'chrt -f 1 rm -rf build',
    'flock /tmp/lock rm -rf build',
    "flock /tmp/lock -c 'rm -rf build'",
    'pkexec rm -rf build',
    'strace -f -o out rm -rf build',
    'unshare -r rm -rf build',
    'script -q /dev/null rm -rf build',
    "script -c 'rm -rf build' log",
    'noglob rm -rf build',
    'nocorrect rm -rf build',
    'true; - rm -rf build',
    'repeat 1 rm -rf build',
    'coproc rm -rf build',
    'arch -x86_64 /bin/rm -rf build',
    'caffeinate -i rm -rf build',
    'busybox rm -rf build',
    'nice -n 5 rm -rf build',
    'nice -5 rm -rf build',
    'timeout -s KILL 5 rm -rf build',
    'sudo -u root rm -rf build',
    'sudo -uroot rm -rf build',
    'sudo -EH -u root rm -rf build',
    'sudo --user=root -- rm -rf build',
    'nohup nice timeout 5 sudo -u x env A=1 rm -rf build',
    'exec -a name rm -rf build',
    'time -p rm -rf build',
    "env -S 'FOO=1 rm -rf build'",
    "watch -n 1 'cd app && rm -rf build'",
    "su -c 'true; rm -rf build' root",
    "su -lc 'rm -rf build'",
    "trap 'rm -rf build' EXIT",
    'function f { rm -rf build; }; f',
    // xargs and find put their input in place of {} or after the command.
    'ls | xargs rm',
    'xargs -I % rm % -r',
    'find . -exec rm {} +',
    "find . -ok rm {} ';'",
    'fd -e tmp -x rm',
  ])
    assert.equal(bashRuleCovers('rm -rf:*', line), true, line)
  assert.equal(bashRuleCovers('git push:*', 'echo push | xargs git'), true)
  assert.equal(bashRuleCovers('git push:*', 'command git push -v'), true)
  // The script of xargs sh -c {} comes from its input.
  assert.equal(bashRuleCovers('git push:*', 'xargs -I{} sh -c {}'), true)
})

test('a word the shell expands may be any text under a Bash ask rule', () => {
  for (const line of [
    "rm $'-rf' build",
    "$'\\x72m' -rf build",
    "$'\\162m' -rf build",
    'r$"m" -rf build',
    "'r'm -rf build",
    '"r\\\nm" -rf build',
    '/bin/r? -rf build',
    '/bin/r[m] -rf build',
    '{rm,-rf,build}',
    'timeout 5 /bin/r? -rf build',
    'sudo $RM -rf build',
    'rm -rf $DIR',
    'rm $FLAGS build',
    'rm${IFS}-rf${IFS}build',
    // Assignments the shell takes before a command.
    'FOO+=1 rm -rf build',
    'a[1]=x rm -rf build',
    // macOS finds a command whatever its case; zsh runs =cmd from the PATH.
    'RM -rf build',
    '/BIN/RM -rf build',
    '=rm -rf build',
    '{fd}>/dev/null rm -rf build',
    // zsh's short forms run a command right after a test or a brace.
    'if [[ -n x ]] rm -rf build',
    '{ true } always { rm -rf build }',
  ])
    assert.equal(bashRuleCovers('rm -rf:*', line), true, line)
  // What only the shell can tell asks under any Bash rule: a zsh glob in a
  // command name, a subscript a builtin evaluates, an alias.
  for (const line of [
    '/bin/r(m|x) -rf build',
    "printf -v 'a[$(rm -rf build)]' x",
    "x='a[$(rm -rf build)]'; (( x ))",
    'alias r=rm; eval r -rf build',
    'echo $((a[$(rm -rf build)]))',
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  assert.equal(bashRuleCovers('git push *', 'git $SUB'), true)
  assert.equal(bashRuleCovers('git push:*', 'git "$SUB" origin'), true)
  assert.equal(bashRuleCovers('git push:*', 'GIT PUSH'), true)
  // An exact rule naming a compound command covers that line.
  assert.equal(bashRuleCovers('git add . && git push', 'git add . && git push'), true)
})

test('a Bash ask rule stays out of calls it does not cover', () => {
  for (const line of [
    'echo rm -rf build',
    "grep -r 'rm -rf' .",
    'git rm file',
    'docker run --rm image',
    'timeout 5 grep rm log.txt',
    'sudo -u rm ls',
    'command -v rm',
    'env | grep rm',
    'watch -n 1 ls',
    'xargs -I{} echo {}',
    "find . -name '*.rm' -exec echo {} \\;",
    'for f in *.ts; do echo "$f"; done',
    '[[ $x == rm ]] && echo y',
    'case $x in rm) echo hi;; esac',
    'echo $(( 1 + 2 ))',
    'echo "${HOME}/rm"',
    'ls *.txt src/{a,b}',
  ])
    assert.equal(bashRuleCovers('rm:*', line), false, line)
  assert.equal(bashRuleCovers('git push:*', 'ls | xargs git add'), false)
})

test('Bash ask rules are matched in time linear in the command', () => {
  const start = performance.now()
  assert.equal(bashRuleCovers('* a * b * c * d *', `echo ${'a b c '.repeat(400)}`), false)
  assert.equal(bashRuleCovers('rm:*', `sudo ${'-z a '.repeat(100)}ls`), false)
  // A command too big to take apart asks.
  assert.equal(bashRuleCovers('rm:*', `echo ${'a[b]{c,d}*?'.repeat(20000)}`), true)
  assert.ok(performance.now() - start < 5000)
})

test('a Bash ask rule covers the command a Monitor call runs', () => {
  const covers = (rule: string, input: Record<string, unknown>) =>
    askRuleCovers(rule, 'Monitor', input, '/')
  assert.equal(covers('Bash(rm:*)', { command: 'rm -rf build', description: 'x' }), true)
  assert.equal(covers('Bash', { command: 'tail -f log', description: 'x' }), true)
  assert.equal(covers('Bash(rm:*)', { command: 'tail -f log', description: 'x' }), false)
  assert.equal(covers('Bash', { ws: { url: 'wss://example.com' }, description: 'x' }), false)
  assert.equal(covers('Monitor', { ws: { url: 'wss://example.com' } }), true)
})

test('file ask rules match paths in any case, through .., and where a glob reaches', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ask-rules-')))
  const cwd = join(root, 'repo')
  try {
    await mkdir(join(cwd, 'secrets'), { recursive: true })
    await mkdir(join(root, 'other', 'deep'), { recursive: true })
    await mkdir(join(root, 'outside', 'secrets'), { recursive: true })
    await symlink(join(root, 'other', 'deep'), join(cwd, 'hop'))
    const covers = (rule: string, tool: string, input: Record<string, unknown>) =>
      askRuleCovers(rule, tool, input, cwd)
    const outside = `//${root.slice(1)}/outside/secrets/**`
    assert.equal(covers('Read(/secrets/**)', 'Read', { file_path: join(cwd, 'SECRETS/a') }), true)
    assert.equal(covers('Edit(/secrets/**)', 'Write', { file_path: join(cwd, 'Secrets/n') }), true)
    assert.equal(covers('Read(~/.ssh/**)', 'Read', { file_path: join(homedir(), '.SSH/id') }), true)
    // Every path the input holds counts.
    assert.equal(
      covers('Edit(/secrets/**)', 'NotebookEdit', {
        file_path: join(cwd, 'notes.ipynb'),
        notebook_path: join(cwd, 'secrets/n.ipynb'),
      }),
      true,
    )
    assert.equal(
      covers('Read(/secrets/[ab].txt)', 'Read', { file_path: join(cwd, 'secrets/a.txt') }),
      true,
    )
    assert.equal(
      covers('Read(/secrets/[!ab].txt)', 'Read', { file_path: join(cwd, 'secrets/a.txt') }),
      false,
    )
    assert.equal(
      covers('Read(/caf\u00e9/**)', 'Read', { file_path: join(cwd, 'cafe\u0301/x') }),
      true,
    )
    assert.equal(
      covers(`Read(//${root.slice(1)}//outside/secrets/**)`, 'Read', {
        file_path: join(root, 'outside/secrets/k'),
      }),
      true,
    )
    // hop/.. is the folder above where hop leads, not the thread's folder.
    assert.equal(
      covers(`Read(//${root.slice(1)}/other/secrets/**)`, 'Read', {
        file_path: `${cwd}/hop/../secrets/k`,
      }),
      true,
    )
    // A glob lists below its fixed folders, wherever they are.
    assert.equal(covers(`Read(${outside})`, 'Glob', { pattern: `${root}/outside/secrets/*` }), true)
    assert.equal(covers(`Read(${outside})`, 'Glob', { pattern: '../outside/secrets/*' }), true)
    assert.equal(covers('Read(/secrets/**)', 'Glob', { pattern: 'secrets/*.txt' }), true)
    assert.equal(covers('Read(/secrets/**)', 'Grep', { pattern: 'x', glob: 'secrets/**' }), true)
    assert.equal(covers('Read(/secrets/**)', 'Glob', { pattern: 'src/**/*.ts' }), false)
    assert.equal(covers('Read(/secrets/**)', 'Grep', { pattern: 'x' }), false)
    // A relative path starts from the session's folder at the time too.
    const guard = askRulesGuard([`Read(${outside})`], cwd)
    const output = await guard.hooks[0]?.(
      { tool_name: 'Read', tool_input: { file_path: 'k' }, cwd: join(root, 'outside', 'secrets') },
      undefined,
      { signal: new AbortController().signal },
    )
    assert.equal(
      (output?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision,
      'ask',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('domain, tool-name and subagent ask rules cover what Claude Code covers', () => {
  const covers = (rule: string, tool: string, input: Record<string, unknown> = {}) =>
    askRuleCovers(rule, tool, input, '/')
  const fetch = (rule: string, url: string) => covers(rule, 'WebFetch', { url })
  assert.equal(fetch('WebFetch(domain:example.com)', 'https://example.com./x'), true)
  assert.equal(fetch('WebFetch(domain:example.com.)', 'https://EXAMPLE.com/x'), true)
  assert.equal(fetch('WebFetch(domain:example.com:8080)', 'https://example.com:8080/x'), true)
  assert.equal(fetch('WebFetch(domain:*)', 'https://anything.org/x'), true)
  assert.equal(fetch('WebFetch(domain:api.*.com)', 'https://api.foo.com/x'), true)
  assert.equal(fetch('WebFetch(domain:*.example.com)', 'https://a.b.example.com/x'), true)
  assert.equal(fetch('WebFetch(domain:b\u00fccher.de)', 'https://b\u00fccher.de/x'), true)
  assert.equal(fetch('WebFetch(domain:api.*.com)', 'https://api.foo.org/x'), false)
  assert.equal(fetch('WebFetch(domain:*.example.com)', 'https://example.org/x'), false)
  // Ask and deny rules take * anywhere in a tool name.
  assert.equal(covers('mcp__*', 'mcp__github__create_issue'), true)
  assert.equal(covers('mcp__*__delete_*', 'mcp__github__delete_repo'), true)
  assert.equal(covers('mcp__*__delete_*', 'mcp__github__get_repo'), false)
  assert.equal(covers('*', 'WebSearch'), true)
  assert.equal(covers('Web*', 'WebSearch'), true)
  assert.equal(covers('Web*', 'Read'), false)
  // Renamed tools, and a call that names no subagent runs the default one.
  assert.equal(covers('KillShell', 'TaskStop'), true)
  assert.equal(covers('Agent(general-purpose)', 'Agent'), true)
  assert.equal(covers('Task(reviewer)', 'Agent', { subagent_type: 'reviewer' }), true)
})

test('file ask rules cover the tools that read or edit the file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ask-rules-')))
  const cwd = join(root, 'repo')
  try {
    await mkdir(join(cwd, 'src'), { recursive: true })
    await symlink(cwd, join(root, 'link'))
    const covers = (rule: string, tool: string, input: Record<string, unknown>) =>
      askRuleCovers(rule, tool, input, cwd)

    // Edit rules cover every tool that edits files, relative paths start at
    // the thread's folder, and a pattern without a slash matches anywhere.
    assert.equal(covers('Edit(/src/**)', 'Write', { file_path: join(cwd, 'src/new.ts') }), true)
    assert.equal(covers('Edit(/src/**)', 'MultiEdit', { file_path: 'src/a/b.ts' }), true)
    assert.equal(covers('Edit(/src/**)', 'Edit', { file_path: join(cwd, 'test/a.ts') }), false)
    assert.equal(covers('Edit(src)', 'Edit', { file_path: join(cwd, 'src/a.ts') }), true)
    assert.equal(
      covers('Edit(*.ipynb)', 'NotebookEdit', { notebook_path: join(cwd, 'a/b/c.ipynb') }),
      true,
    )
    assert.equal(covers('Edit', 'Write', { file_path: '/anywhere' }), true)
    assert.equal(covers('Edit(/src/**)', 'Read', { file_path: join(cwd, 'src/a.ts') }), false)
    // Through a symlink to the folder too.
    assert.equal(
      covers('Edit(/src/**)', 'Edit', { file_path: join(root, 'link', 'src', 'a.ts') }),
      true,
    )

    // Read rules cover reading tools, a search tool by the folder it looks in.
    assert.equal(covers('Read(./.env)', 'Read', { file_path: join(cwd, '.env') }), true)
    assert.equal(covers('Read(.env)', 'Read', { file_path: join(cwd, 'app/.env') }), true)
    assert.equal(covers('Read(./.env)', 'Read', { file_path: join(cwd, 'x.env') }), false)
    assert.equal(covers('Read(/src/**)', 'Grep', { pattern: 'x', path: 'src' }), true)
    assert.equal(covers('Read(/src/**)', 'Glob', { pattern: '*.ts' }), false)
    assert.equal(covers('Read(//etc/**)', 'Read', { file_path: '/etc/hosts' }), true)
    assert.equal(covers('Read(~/.ssh/**)', 'Read', { file_path: '~/.ssh/id' }), true)
    assert.equal(
      covers('Read(~/.ssh/**)', 'Read', { file_path: join(homedir(), '.ssh', 'id') }),
      true,
    )
    // A call that names no file is asked about.
    assert.equal(covers('Read(./.env)', 'Read', {}), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('other ask rules: whole tools, domains, MCP servers and subagents', () => {
  const covers = (rule: string, tool: string, input: Record<string, unknown> = {}) =>
    askRuleCovers(rule, tool, input, '/')
  assert.equal(covers('WebSearch', 'WebSearch'), true)
  assert.equal(covers('WebSearch', 'WebFetch'), false)
  assert.equal(covers('Bash', 'Bash', { command: 'ls' }), true)
  assert.equal(covers('Bash(*)', 'Bash', { command: 'ls' }), true)
  const fetch = (url: string) => covers('WebFetch(domain:example.com)', 'WebFetch', { url })
  assert.equal(fetch('https://example.com/a'), true)
  assert.equal(fetch('https://api.example.com/a'), true)
  assert.equal(fetch('https://example.org/a'), false)
  assert.equal(fetch('https://notexample.com/a'), false)
  assert.equal(fetch('not a url'), true)
  assert.equal(covers('mcp__docs', 'mcp__docs__read'), true)
  assert.equal(covers('mcp__docs__*', 'mcp__docs__read'), true)
  assert.equal(covers('mcp__docs__write', 'mcp__docs__read'), false)
  assert.equal(covers('mcp__docs__read', 'mcp__docs__read'), true)
  assert.equal(covers('mcp__docs', 'mcp__docsearch__read'), false)
  assert.equal(covers('mcp__docs__*', 'mcp__docsearch__read'), false)
  // A server whose name holds `__`: a rule naming it covers its tools.
  assert.equal(covers('mcp__docs__v2', 'mcp__docs__v2__read'), true)
  assert.equal(covers('mcp__docs__v2', 'mcp__docs__v2read'), false)
  assert.equal(covers('Agent(reviewer)', 'Task', { subagent_type: 'reviewer' }), true)
  assert.equal(covers('Task(reviewer)', 'Agent', { subagent_type: 'other' }), false)
  assert.equal(covers('Agent', 'Agent', { subagent_type: 'other' }), true)
  // A specifier the guard cannot read asks.
  assert.equal(covers('NewTool(something)', 'NewTool'), true)
})

test('the ask guard answers ask with the rule, and nothing for other calls', async () => {
  const guard = askRulesGuard(['WebSearch', 'Bash(git push:*)'], '/')
  const run = (tool_name: string, tool_input: Record<string, unknown>) =>
    guard.hooks[0]?.({ tool_name, tool_input }, undefined, {
      signal: new AbortController().signal,
    })
  assert.equal(guard.matcher, undefined)
  assert.deepEqual(await run('Bash', { command: 'git push' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'Your Claude Code settings ask before Bash(git push:*).',
    },
  })
  assert.deepEqual(await run('Bash', { command: 'git status' }), {})
  // Whatever runs inside $(...) is not known: the Bash rule asks.
  assert.deepEqual(await run('Bash', { command: 'echo $(date)' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'Your Claude Code settings ask before Bash(git push:*).',
    },
  })
  assert.deepEqual(await run('Read', { file_path: '/a' }), {})
})
