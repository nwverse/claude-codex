import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { askRuleCovers, askRulesGuard, bashRuleCovers } from '../src/ask-rules.mjs'

// How a check's time grows from input of size n / 10 to size n: about 10x
// for linear code, 100x for quadratic. A ratio holds on a loaded machine or
// a slow CI runner, where a fixed number of milliseconds does not. Each
// size takes the best of three runs, so one stall of the machine does not
// count, and 5 ms keeps a tiny small run from making the ratio jumpy.
// `answer` checks the result as well.
function growth(
  make: (size: number) => string,
  size: number,
  answer: (line: string) => void,
): number {
  const time = (line: string): number => {
    const start = performance.now()
    answer(line)
    return performance.now() - start
  }
  const best = (line: string): number => Math.min(time(line), time(line), time(line))
  return best(make(size)) / (best(make(Math.floor(size / 10))) + 5)
}

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
    // zsh runs =cmd from the PATH.
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
  const ratio = growth(
    (size) => `echo ${'a b c '.repeat(size)}`,
    400,
    (line) => assert.equal(bashRuleCovers('* a * b * c * d *', line), false),
  )
  assert.ok(ratio < 30, `grew ${ratio}x`)
  assert.equal(bashRuleCovers('rm:*', `sudo ${'-z a '.repeat(100)}ls`), false)
  // A command line with too many readings to take apart asks.
  assert.equal(bashRuleCovers('rm:*', `sudo ${'-z a '.repeat(3000)}ls`), true)
  // One long command is still read, and so is a long host.
  assert.equal(bashRuleCovers('git push:*', `echo '${'{"a":1}'.repeat(25000)}' | jq .`), false)
  const hosts = growth(
    (size) => `https://${'a.'.repeat(size)}com/`,
    5000,
    (url) =>
      assert.equal(
        askRuleCovers('WebFetch(domain:*.*.*.example.com)', 'WebFetch', { url }, '/'),
        false,
      ),
  )
  assert.ok(hosts < 30, `grew ${hosts}x`)
})

test('pathological input makes the ask guard ask rather than throw', async () => {
  const guard = askRulesGuard(['Bash(rm:*)', 'Read(~/.ssh/**)'], '/')
  const decision = async (tool_name: string, tool_input: Record<string, unknown>) => {
    const output = await guard.hooks[0]?.({ tool_name, tool_input }, undefined, {
      signal: new AbortController().signal,
    })
    return (output?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision
  }
  // Thousands of options, and a path of thousands of x/../ parts.
  assert.equal(await decision('Bash', { command: `sudo ${'-z '.repeat(8000)}rm -rf build` }), 'ask')
  assert.equal(
    await decision('Bash', { command: `nice ${'-z '.repeat(60000)}rm -rf build` }),
    'ask',
  )
  const deep = `/tmp/${'x/../'.repeat(5000)}zz`
  assert.equal(await decision('Read', { file_path: deep }), 'ask')
  // A call the guard cannot read is asked about.
  const unreadable = {
    get command(): string {
      throw new Error('unreadable')
    },
  }
  assert.equal(await decision('Bash', unreadable), 'ask')
})

test('a Bash ask rule reads $((...)) and ${...} as bash and zsh do', () => {
  // $((cmd)|(cmd)) closes its first group early: command substitution.
  for (const line of [
    'echo $((rm -rf build)|(cat))',
    'echo $((rm -rf build) && (true))',
    'x=$((rm -rf build) || (true)); echo $x',
    // bash closes ${...} at its first }, whatever braces or quotes come
    // before; ${ cmd; } runs cmd.
    'echo ${x:-{}; rm -rf build; echo }',
    "echo ${x:-'{'}; rm -rf build; echo }",
    'echo "${x:-{}"; rm -rf build; echo "}"',
    'echo ${x#{}; rm -rf build; echo }',
    'echo ${ rm -rf build; }',
    'echo ${| rm -rf build; }',
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  for (const line of ['echo $((1 + 2))', 'count=$((count + 1))', 'echo "${HOME}/x" ${#arr[@]}'])
    assert.equal(bashRuleCovers('rm:*', line), false, line)
})

test('a Bash ask rule asks where quoted text runs as code later', () => {
  for (const line of [
    // zsh: (e) evaluates, ~ globs (a qualifier can run code), the function
    // table defines.
    "x='$(rm -rf build)'; echo ${(e)x}",
    "x='*(e:rm -rf build:)'; ls $~x",
    "x='*(e:rm -rf build:)'; ls ${~x}",
    "functions[f]='rm -rf build'; f",
    // bash: PS4 under set -x, @P, exported functions, arrays declare reads
    // again, mapfile's callback.
    "PS4='$(rm -rf build)'; set -x; :",
    "PS4='$(rm -rf build)' bash -xc :",
    "x='$(rm -rf build)'; echo ${x@P}",
    "env 'BASH_FUNC_f%%=() { rm -rf build; }' bash -c f",
    "declare -a 'x=($(rm -rf build))'",
    "echo x | mapfile -c 1 -C 'rm -rf build' arr",
    // A subscript evaluated later, with its $ built when the line runs.
    'd=\'$\'; x="a[${d}(rm -rf build)]"; (( x ))',
    "printf -v x 'a[\\x24(rm -rf build)]'; (( x ))",
    "x='a[b[1]+$(rm -rf build)]'; (( x ))",
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
})

test('a Bash ask rule takes env and sudo assignments whatever their quoting', () => {
  for (const line of [
    "env 'FOO=1' rm -rf build",
    'sudo "FOO=1" rm -rf build',
    'env A\\=1 rm -rf build',
    'doas "A=1" rm -rf build',
  ])
    assert.equal(bashRuleCovers('rm:*', line), true, line)
})

test('a shell reading stdin through a path or after BASH_ENV asks under any Bash rule', () => {
  for (const line of [
    "echo 'rm -rf build' | bash /dev/stdin",
    "echo 'rm -rf build' | zsh /dev/stdin",
    "echo 'rm -rf build' | sh /dev/fd/0",
    "echo 'rm -rf build' | bash /proc/self/fd/0",
    'echo "$CMD" | bash "$SCRIPT"',
    "echo 'rm -rf build' | source /dev/stdin",
    "echo 'rm -rf build' | . /dev/stdin",
    "echo 'rm -rf build' | BASH_ENV=/dev/stdin bash -c true",
    "echo 'rm -rf build' | env ENV=/dev/stdin sh -i",
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  for (const line of ['bash ./build.sh', 'source ~/.nvm/nvm.sh && nvm use', 'bash "$HOME/x.sh"'])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
})

test('wrappers that run their input, or a shell, with no command ask', () => {
  for (const line of [
    "parallel ::: 'rm -rf build'",
    "echo 'rm -rf build' | parallel",
    "echo 'rm -rf build' | script -q /dev/null",
    "echo 'rm -rf build' | doas -s",
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  for (const line of [
    'autoload zargs; zargs -- *.tmp -- rm -rf',
    'gtimeout 5 rm -rf build',
    'xcrun rm -rf build',
    "sandbox-exec -p '(version 1)' rm -rf build",
  ])
    assert.equal(bashRuleCovers('rm:*', line), true, line)
  for (const line of ['parallel -k echo ::: a b', 'script -q /dev/null make', 'sudo -u admin ls'])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
})

test('case patterns, array elements, [[ ]] tests and markdown are not read as commands', () => {
  for (const line of [
    'case "$1" in start|stop) echo ok;; *) echo no;; esac',
    'case $f in *.md|*.txt) echo doc;; *) echo other;; esac',
    'while [[ $# -gt 0 ]]; do case "$1" in --dry-run) DRY=1; shift;; *) shift;; esac; done',
    'case "$1" in\n  -h|--help) usage;;\n  (*) run "$@";;\nesac',
    'files=(*.ts); echo ${#files[@]}',
    'declare -a arr=(src/*.ts)',
    '[[ $v =~ v([0-9]+)\\.([0-9]+) ]] && echo "${BASH_REMATCH[1]}"',
    'if [[ "$OSTYPE" =~ ^(darwin|linux) ]]; then echo unix; fi',
    '[[ $x == @(a|b) ]] && echo ab',
    '[[ $a == 1 && $b == 2 ]] && echo both',
    "git commit -m 'fix(guard): handle [x] in `foo`'",
    'git commit -m "fix: [x] use \\`foo\\`"',
    "gh pr create --title t --body 'See [the docs](https://x.dev) and run `npm test`.'",
  ]) {
    assert.equal(bashRuleCovers('git push:*', line), false, line)
    assert.equal(bashRuleCovers('zzz-no-such-command:*', line), false, line)
  }
  // What a case, an array or a test leaves to run still counts.
  for (const line of [
    'case x in a) git push;; esac',
    'case x in a) echo;; *) git push;; esac',
    'case x in (a|b) echo;; esac; git push',
    'files=(*.ts) git push',
    '[[ -n x ]] && git push',
    '[[ -n x ]] git push',
    '[[ a ]]&&git push',
    '[[ a ]]||git push',
    'x=1 [[ a || git push ]]',
    'case x in $(git push)) echo;; esac',
    'a=( $(git push) )',
    'echo =(git push)',
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
})

test('a redirection before [[ makes it a command, and name=( is an array only where it assigns', () => {
  // bash runs [[ after a redirection as a command that fails, so || runs.
  for (const line of [
    '>/dev/null [[ x || rm -rf build ]]',
    '2>/dev/null [[ x || rm -rf build ]]',
    '</dev/null [[ x || rm -rf build ]]',
    'true; >/dev/null [[ x || rm -rf build ]]',
  ])
    assert.equal(bashRuleCovers('rm:*', line), true, line)
  // Outside an assignment zsh reads x=(...) as a glob with qualifiers.
  for (const line of ["touch x=; echo x=(e:'rm -rf build':)", "touch x=; ls x=(e:'rm -rf build':)"])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  for (const line of ['x=(a b); echo "${x[0]}"', 'local -a files=(*.ts)', 'if x=(1); then :; fi'])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
})

test('text the shell runs later is found by name, however it is set', () => {
  for (const line of [
    "PS4+='$(rm -rf build)'; set -x; :",
    "printf -v PS4 '$(rm -rf build)'; set -x; :",
    "echo 'rm -rf build' | { : ${BASH_ENV:=/dev/stdin}; export BASH_ENV; bash -c :; }",
    "echo 'rm -rf build' | { printf -v BASH_ENV /dev/stdin; export BASH_ENV; bash -c :; }",
    ': ${functions[f]::=rm -rf build}; f',
    "setopt globsubst; x='*(e:rm -rf build:)'; ls $x",
    'setopt GLOB_SUBST; ls $x',
    "zstyle -e ':x' y 'rm -rf build'; zstyle -s ':x' y z",
    "y='($(rm -rf build))'; declare -a x=$y",
    'read -a x <<< q; declare x=$y',
    // ENV runs only for an interactive POSIX shell, set however.
    "echo 'rm -rf build' | { export ENV=/dev/stdin; sh -ic true; }",
    "echo 'rm -rf build' | ENV=/dev/stdin dash -ic true",
    "echo 'rm -rf build' | { : ${ENV:=/dev/stdin}; export ENV; ksh -i -c true; }",
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  // ENV for anything else, and declarations that read no array, are quiet.
  for (const line of [
    'ENV=prod bash scripts/deploy.sh',
    'ENV=test sh -c "npm test"',
    "export ENV=staging && bash -c 'npm run deploy'",
    'make ENV=prod && bash x.sh',
    'f() { local dir=$1; cd "$dir"; }',
    'export PATH="$HOME/.local/bin:$PATH"',
    'declare x=$y',
  ])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
})

test('arithmetic and name evaluation ask only for text the line does not show', () => {
  // A subscript built at run time, or read from input, that arithmetic or a
  // name lookup then evaluates.
  for (const line of [
    "x='a['; x+='$(rm -rf build)]'; (( x ))",
    "o='['; d='$'; x=\"a${o}${d}(rm -rf build)]\"; (( x ))",
    "printf -v x 'a\\x5b\\x24(rm -rf build)]'; (( x ))",
    "printf -v x '%s%s%s' 'a[' '$(' 'rm -rf build)]'; (( x ))",
    "y='$(rm -rf build)'; printf '%s[%s]\\n' a \"$y\" | { read x; (( x )); }",
    "x='a['; x+='$(rm -rf build)]'; s=abc; echo ${s:x}",
    "x='a['; x+='$(rm -rf build)]'; a[x]=1",
    "x='a['; x+='$(rm -rf build)]'; a=(1); echo $a[x]",
    "x='a['; x+='$(rm -rf build)]'; echo ${!x}",
    'read y; x=y; (( x ))',
    'declare -i n; read x; n=x',
    "bash -c 'read x; (( x ))'",
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  // A line that evaluates nothing, or only names it shows, stays quiet.
  for (const line of [
    'while read l; do (( n++ )); done < file.txt',
    'git commit -m "[$TICKET] fix login"',
    'echo "[$i/$n] $f"',
    'jq ".[$i].name" data.json',
    "LC_ALL=C grep -n '[^\\x00-\\x7F]' file.txt",
    "tr -d '[\\000-\\037]' < in > out",
    'echo -e "[\\033[32mOK\\033[0m]"',
    'count=0; count=$((count + 1)); echo $count',
    'for f in *.ts; do (( n++ )); echo "[$n] $f"; done',
    'if (( $# > 0 )); then echo args; fi',
    'for ((i = 0; i < 3; i++)); do echo $i; done',
  ])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
})

test('${...} holding "..." or ${...} is read as bash and zsh both read it', () => {
  for (const line of [
    'echo "${NAME:-"world"}"',
    'dir="${1:-"."}"; ls "$dir"',
    'echo "${HOME:+"$HOME/bin"}"',
    'echo "${x%%"-suffix"}"',
    'echo "${x:-${y:-z}}"',
  ])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
  // A single quote, a backtick or $(...) inside still asks.
  for (const line of ["echo ${x:-'{'}; git push; echo }", 'echo "${x:-$(git push)}"'])
    assert.equal(bashRuleCovers('rm:*', line), true, line)
})

test('GNU parallel inputs end its command, and many reserved words read in linear time', () => {
  for (const line of ["parallel sh -c ::: 'rm -rf build'", "parallel bash -c ::: 'rm -rf build'"])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  assert.equal(bashRuleCovers('rm:*', 'parallel echo ::: a b'), false)
  for (const word of ['if ', '! ']) {
    const ratio = growth(
      (size) => `${word.repeat(size)}true`,
      60000,
      (line) => assert.equal(bashRuleCovers('rm:*', line), false),
    )
    assert.ok(ratio < 30, `${word}grew ${ratio}x`)
  }
})

test('an arithmetic command ends where bash and zsh both end it, and $1 in it is hidden text', () => {
  // zsh ends (( at the first )); bash counts the parens inside ${...}.
  for (const line of ['(( ${x:-((} )); rm -rf build # ))', '(( ${x:-((} )); rm -rf build; : # ))'])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  // The positional parameters come from the caller.
  for (const line of [
    "x='a['; x+='$(rm -rf build)]'; set -- \"$x\"; (( $1 ))",
    "f() { (( $1 )); }; x='a['; x+='$(rm -rf build)]'; f \"$x\"",
    'f() { echo $(( ${1} + 1 )); }; f "$y"',
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  for (const line of [
    'if (( $# > 0 )); then echo args; fi',
    'while (( i < 10 )); do (( i++ )); done',
    '(( n = 16#ff ))',
  ])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
})

test('long chains of names and runs of (( read in linear time', () => {
  const chain = (size: number): string => {
    let line = ''
    for (let index = 0; index < size; index += 1) line += `a${index}=a${index + 1}; `
    return `${line}read a${size}; (( a0 ))`
  }
  for (const [rule, make, size, asks] of [
    ['rm:*', chain, 15000, true],
    ['git push:*', (n: number) => `${'(( '.repeat(n)}; rm -rf build`, 66000, true],
    ['rm:*', (n: number) => `echo ${'(('.repeat(n)}`, 60000, false],
    ['rm:*', (n: number) => '(( 1 )); '.repeat(n), 20000, false],
  ] as const) {
    const ratio = growth(make, size, (line) =>
      assert.equal(bashRuleCovers(rule, line), asks, line.slice(0, 40)),
    )
    assert.ok(ratio < 30, `${make(2).slice(0, 20)} grew ${ratio}x`)
  }
})

test('a setter whose target is built at run time, and quoted names, count as run-later text', () => {
  for (const line of [
    "printf -v 'PS''4' '$(rm -rf build)'; set -x; :",
    'n=PS; printf -v "${n}4" \'$(rm -rf build)\'; set -x; :',
    'declare "P""S4=\\$(rm -rf build)"; set -x; :',
    'echo \'rm -rf build\' | { export "BASH_""ENV=/dev/stdin"; bash -c :; }',
    'echo \'rm -rf build\' | { n=BASH; printf -v "${n}_ENV" /dev/stdin; export "${n}_ENV"; bash -c :; }',
    "n=y; printf -v \"$n\" '%s%s' 'a[' '$(rm -rf build)]'; (( y ))",
    'typeset "func""tions[f]=rm -rf build"; f',
    "n=functions; set -A $n f 'rm -rf build'; f",
    "set -A functions f 'rm -rf build'; f",
    "setopt glo_bsubst; x='*(e:rm -rf build:)'; ls $x",
    "setopt GLOB_S_UBST; x='*(e:rm -rf build:)'; ls $x",
    "n=globsub; setopt ${n}st; x='*(e:rm -rf build:)'; ls $x",
    'options[globsubst]=on; ls $x',
    // Arrays declare reads an expansion into: made by a[i]=, or bash's own.
    "x[0]=1; y='($(rm -rf build))'; declare x=$y",
    "y='($(rm -rf build))'; declare PIPESTATUS=$y",
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  for (const line of [
    "printf 'rm -rf %s' x",
    'export "FOO=bar"',
    'read -r -p "Name: " name',
    'local -a files=("$@")',
    'declare x=$y',
  ])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
})

test('array index loops are not read as evaluating hidden text', () => {
  for (const line of [
    'for i in "${!arr[@]}"; do echo "$i ${arr[$i]}"; done',
    'arr=(a b c); for i in "${!arr[@]}"; do echo "$i: ${arr[$i]}"; done',
    'arr=(a b c); for ((i=0; i<${#arr[@]}; i++)); do echo "$i ${arr[i]}"; done',
    'files=(*.ts); for ((i=0; i<${#files[@]}; i++)); do echo "${files[$i]}"; done',
    'arr=(a b c); i=0; while (( i < ${#arr[@]} )); do echo "${arr[i]}"; ((i++)); done',
  ])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
  // Keys of an associative array are text, and ${!x} still follows a name.
  for (const line of [
    'declare -A m; read k; m[$k]=1; for i in "${!m[@]}"; do (( i )); done',
    "x='a['; x+='$(rm -rf build)]'; echo ${!x}",
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
})

test('zsh skips the parens in ${...} inside ((, and builtin or command hide no setter', () => {
  // zsh reads these as subshells around a command, bash as arithmetic.
  for (const line of [
    '(( ${x:-(} ) || rm -rf build || ( ${y:-)} ))',
    '(( ${x:-(} ) | rm -rf build | ( ${y:-)} ))',
    '(( ${x:-(} ) && rm -rf build && ( ${y:-)} ))',
  ])
    assert.equal(bashRuleCovers('rm:*', line), true, line)
  // A setter behind builtin, command or time names its target too.
  for (const line of [
    'n=PS; builtin printf -v "${n}4" \'$(rm -rf build)\'; set -x; :',
    'n=PS; command printf -v "${n}4" \'$(rm -rf build)\'; set -x; :',
    'n=PS; builtin declare "${n}4=\\$(rm -rf build)"; set -x; :',
    'n=PS; time printf -v "${n}4" \'$(rm -rf build)\'; set -x; :',
  ])
    assert.equal(bashRuleCovers('git push:*', line), true, line)
  for (const line of [
    'while (( i < ${#arr[@]} )); do echo "${arr[i]}"; (( i++ )); done',
    'if (( $# > 0 )); then echo args; fi',
    '(( n = ${#name} + 1 ))',
    'command -v printf',
    'builtin printf -v out "%s" hi',
  ])
    assert.equal(bashRuleCovers('git push:*', line), false, line)
})

test('only a command name matches in any case, and only where the system ignores case', () => {
  const folds = process.platform === 'darwin' || process.platform === 'win32'
  assert.equal(bashRuleCovers('rm -rf:*', 'RM -rf build'), folds)
  assert.equal(bashRuleCovers('rm -rf:*', '/BIN/RM -rf build'), folds)
  assert.equal(bashRuleCovers('Git push:*', 'git push'), folds)
  assert.equal(bashRuleCovers('git branch -D:*', 'git branch -d old'), false)
  assert.equal(bashRuleCovers('git push:*', 'git PUSH'), false)
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
  assert.equal(covers('Agent(Explore)', 'Agent'), false)
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
