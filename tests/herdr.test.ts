// The pane side of the herdr adapter: quoting for `pane run`, and the three
// calls the interactive setup hand-off makes, against a scripted `herdr`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { platform as hostPlatform, tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import {
  closePane,
  findHerdrOnPath,
  herdrView,
  promptPane,
  quoteForPaneShell,
  runInPane,
  sendKeys,
  splitPane,
  type HerdrRun,
  type HerdrRunner,
} from '../src/herdr.js';

function recorder(answer: (args: string[]) => HerdrRun): { run: HerdrRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return answer(args);
    },
  };
}

test('POSIX quoting: plain words pass, anything else is single-quoted, a word starting with = is always quoted (zsh expands =cmd)', () => {
  assert.equal(quoteForPaneShell(['/usr/bin/node', '/a/b.mjs', 'setup', '--reuse'], 'darwin'), '/usr/bin/node /a/b.mjs setup --reuse');
  assert.equal(quoteForPaneShell(['x y', "it's", '$HOME', ''], 'linux'), `'x y' 'it'\\''s' '$HOME' ''`);
  assert.equal(quoteForPaneShell(['=ls', 'a=b'], 'linux'), `'=ls' a=b`);
});

test('Windows quoting follows CommandLineToArgvW as list2cmdline applies it: spaces force quoting, a quote is escaped, a trailing backslash inside quotes is doubled', () => {
  assert.equal(quoteForPaneShell(['C:\\node.exe', 'a b', 'say "hi"', 'C:\\dir\\', 'x y\\'], 'win32'), 'C:\\node.exe "a b" "say \\"hi\\"" C:\\dir\\ "x y\\\\"');
});

test('splitPane: the split is asked below the caller with cwd, taking focus; the new pane id comes out of result.pane.pane_id', async () => {
  const ok = recorder(() => ({ ok: true, stdout: JSON.stringify({ id: 'x', result: { pane: { pane_id: 'w1:p7' } } }) }));
  assert.equal(await splitPane('/work', 'w1:p2', ok.run), 'w1:p7');
  // The new pane takes focus: the human types the secret there next.
  assert.deepEqual(ok.calls, [['pane', 'split', '--pane', 'w1:p2', '--direction', 'down', '--cwd', '/work']]);
  const refused = recorder(() => ({ ok: false, stdout: '', error: 'herdr: not found' }));
  assert.equal(await splitPane('/work', 'w1:p2', refused.run), null);
  const odd = recorder(() => ({ ok: true, stdout: '{"result":{}}' }));
  assert.equal(await splitPane('/work', 'w1:p2', odd.run), null);
});

test('runInPane types one quoted command line into the pane; closePane closes it', async () => {
  const rec = recorder(() => ({ ok: true, stdout: '{}' }));
  assert.equal(await runInPane('w1:p7', ['/usr/bin/node', '/skill/cli.mjs', '--home', '/tmp/h', 'setup', '--reuse'], rec.run), true);
  assert.deepEqual(rec.calls[0], ['pane', 'run', 'w1:p7', quoteForPaneShell(['/usr/bin/node', '/skill/cli.mjs', '--home', '/tmp/h', 'setup', '--reuse'])]);
  assert.equal((await closePane('w1:p7', rec.run)).ok, true);
  assert.deepEqual(rec.calls[1], ['pane', 'close', 'w1:p7']);
});

// ---- the agent side: prompt / send-keys against a scripted `herdr`, and how a refusal is read ----

const refusal = JSON.stringify({ error: { code: 'agent_not_found', message: 'agent target w1:p9 not found' }, id: 'cli:agent:prompt' });

test('promptPane: a refusal herdr prints on stderr with exit 1 comes back as its own error code, not as spawn_failed', async () => {
  // herdr 0.9.1: the error envelope goes to stderr and the process exits 1.
  const rec = recorder(() => ({ ok: false, stdout: '', stderr: refusal, error: 'Command failed: herdr agent prompt w1:p9 hi' }));
  const out = await promptPane('w1:p9', 'hi', rec.run);
  assert.deepEqual(rec.calls, [['agent', 'prompt', 'w1:p9', 'hi']]);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'agent_not_found');
  assert.match(out.message ?? '', /not found/);
});

test('promptPane: an envelope on stdout is read the same way; a plain result is ok; a herdr that cannot be spawned is spawn_failed', async () => {
  const onStdout = recorder(() => ({ ok: true, stdout: refusal }));
  assert.equal((await promptPane('w1:p9', 'hi', onStdout.run)).code, 'agent_not_found');
  const fine = recorder(() => ({ ok: true, stdout: JSON.stringify({ id: 'cli:agent:prompt', result: { type: 'agent_prompted' } }) }));
  assert.deepEqual(await promptPane('w1:p1', 'hi', fine.run), { ok: true });
  const missing = recorder(() => ({ ok: false, stdout: '', stderr: '', error: 'spawn herdr ENOENT' }));
  const out = await promptPane('w1:p1', 'hi', missing.run);
  assert.equal(out.code, 'spawn_failed');
  assert.match(out.message ?? '', /ENOENT/);
});

test('sendKeys sends one logical key to the agent and reads the answer like promptPane', async () => {
  const ok = recorder(() => ({ ok: true, stdout: JSON.stringify({ id: 'cli:agent:send-keys', result: { type: 'ok' } }) }));
  assert.deepEqual(await sendKeys('w1:p1', 'ctrl+enter', ok.run), { ok: true });
  assert.deepEqual(ok.calls, [['agent', 'send-keys', 'w1:p1', 'ctrl+enter']]);
  const gone = recorder(() => ({ ok: false, stdout: '', stderr: refusal, error: 'Command failed' }));
  assert.equal((await sendKeys('w1:p1', 'ctrl+s', gone.run)).code, 'agent_not_found');
});

test('promptPane: a zero exit with no envelope on either stream is bad_output, not ok', async () => {
  const noise = recorder(() => ({ ok: true, stdout: 'not json at all', stderr: '' }));
  const out = await promptPane('w1:p1', 'hi', noise.run);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'bad_output');
});

test('promptPane: bad_output on a zero exit names what was on stderr when stdout is empty', async () => {
  const noisy = recorder(() => ({ ok: true, stdout: '', stderr: 'warning: something odd' }));
  const out = await promptPane('w1:p1', 'hi', noisy.run);
  assert.equal(out.code, 'bad_output');
  assert.match(out.message ?? '', /something odd/);
});

test('outcomeOf via promptPane: a spawn failure whose error code is ENOENT is herdr_missing, not spawn_failed', async () => {
  const rec = recorder(() => ({ ok: false, stdout: '', stderr: '', error: 'spawn herdr ENOENT', code: 'ENOENT' }));
  const out = await promptPane('w1:p1', 'hi', rec.run);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'herdr_missing');
});

test('outcomeOf via promptPane: a spawn failure with a different (or no) error code stays spawn_failed', async () => {
  const rec = recorder(() => ({ ok: false, stdout: '', stderr: '', error: 'spawn herdr EACCES', code: 'EACCES' }));
  const out = await promptPane('w1:p1', 'hi', rec.run);
  assert.equal(out.code, 'spawn_failed');
});

// ---- findHerdrOnPath: a pure PATH walk, no process spawned ----

const scratch: string[] = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
function writeExecutable(path: string, mode = 0o755): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, mode);
}

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

test('findHerdrOnPath: finds an executable herdr on a later PATH entry, ahead of dirs without it', () => {
  const empty = freshDir('al-path-empty-');
  const withBin = freshDir('al-path-has-herdr-');
  const bin = join(withBin, 'herdr');
  writeExecutable(bin);
  // posix.delimiter, not the bare `delimiter` import (host-fixed: `;` on
  // Windows): the platform passed to findHerdrOnPath is 'darwin', so the
  // PATH string must be joined the same way that branch will split it,
  // regardless of what host is actually running the test.
  const env = { PATH: [empty, withBin].join(posix.delimiter) };
  assert.equal(findHerdrOnPath(env, 'darwin'), bin);
});

test('findHerdrOnPath: nothing on PATH is null', () => {
  const empty = freshDir('al-path-empty-');
  assert.equal(findHerdrOnPath({ PATH: empty }, 'darwin'), null);
});

test('findHerdrOnPath: a non-executable file on PATH is skipped on POSIX', { skip: hostPlatform() === 'win32' }, () => {
  const dir = freshDir('al-path-noexec-');
  const bin = join(dir, 'herdr');
  writeExecutable(bin, 0o644);
  assert.equal(findHerdrOnPath({ PATH: dir }, 'linux'), null);
});

test('findHerdrOnPath: win32 tries PATHEXT-suffixed names, defaulting to .EXE;.CMD;.BAT;.COM, across a `;`-joined multi-entry PATH', () => {
  const empty = freshDir('al-path-win-empty-');
  const dir = freshDir('al-path-win-');
  const bin = join(dir, 'herdr.CMD');
  writeFileSync(bin, '@echo off\n');
  // Joined with a literal `;`, not the host's own `path.delimiter` (`:` on
  // this test's POSIX host): the win32 branch must split on `;` regardless
  // of what OS is actually running the test.
  const env = { PATH: [empty, dir].join(';') };
  assert.equal(findHerdrOnPath(env, 'win32'), bin);
});

test('findHerdrOnPath: win32 honors a custom PATHEXT', () => {
  const dir = freshDir('al-path-win-ext-');
  const bin = join(dir, 'herdr.FOO');
  writeFileSync(bin, 'x');
  assert.equal(findHerdrOnPath({ PATH: dir, PATHEXT: '.FOO' }, 'win32'), bin);
});

// ---- herdrView: findHerdrOnPath plus (when found) a probe run ----
//
// herdrView (unlike findHerdrOnPath) takes no injected platform: it always
// calls findHerdrOnPath() with no arguments, which falls back to the real
// process.env / process.platform of whatever host is running this test. So
// the fixture below is named and probed the way that host's own lookup
// actually resolves it — a bare, executable `herdr` on POSIX; `herdr.CMD`
// under a PATHEXT pinned for the duration of the call on win32, so the match
// does not depend on whatever PATHEXT the real environment happens to carry.
const HERDR_VIEW_PATHEXT = '.EXE;.CMD;.BAT;.COM';

function herdrViewBin(dir: string): string {
  if (hostPlatform() === 'win32') {
    const bin = join(dir, 'herdr.CMD');
    writeFileSync(bin, '@echo off\r\n');
    return bin;
  }
  const bin = join(dir, 'herdr');
  writeExecutable(bin);
  return bin;
}

async function withHerdrViewPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const savedPath = process.env.PATH;
  const savedExt = process.env.PATHEXT;
  process.env.PATH = dir;
  if (hostPlatform() === 'win32') process.env.PATHEXT = HERDR_VIEW_PATHEXT;
  try {
    return await fn();
  } finally {
    process.env.PATH = savedPath;
    if (savedExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = savedExt;
  }
}

test('herdrView: bin null when nothing is on PATH; the probe is never run', async () => {
  const empty = freshDir('al-view-empty-');
  const saved = process.env.PATH;
  process.env.PATH = empty;
  let called = false;
  try {
    const view = await herdrView(async () => {
      called = true;
      return { ok: true, stdout: '{}' };
    });
    assert.deepEqual(view, { bin: null, reachable: false, error: 'not found on PATH' });
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(called, false);
});

test('herdrView: bin found and `agent list` answers ok is reachable, no error', async () => {
  const dir = freshDir('al-view-ok-');
  const bin = herdrViewBin(dir);
  const view = await withHerdrViewPath(dir, () =>
    herdrView(async () => ({ ok: true, stdout: JSON.stringify({ id: 'x', result: { agents: [] } }) })),
  );
  assert.deepEqual(view, { bin, reachable: true });
});

test('herdrView: bin found but the envelope refuses is not reachable, error is the envelope code', async () => {
  const dir = freshDir('al-view-refused-');
  const bin = herdrViewBin(dir);
  const view = await withHerdrViewPath(dir, () =>
    herdrView(async () => ({
      ok: false,
      stdout: '',
      stderr: JSON.stringify({ error: { code: 'agent_blocked', message: 'busy' } }),
    })),
  );
  assert.equal(view.bin, bin);
  assert.equal(view.reachable, false);
  assert.equal(view.error, 'agent_blocked');
});

test('herdrView: a non-envelope spawn failure surfaces the real diagnostic, not the bare "spawn_failed" label', async () => {
  const dir = freshDir('al-view-spawnfail-');
  const bin = herdrViewBin(dir);
  const view = await withHerdrViewPath(dir, () =>
    herdrView(async () => ({
      ok: false,
      stdout: '',
      stderr: 'boom: cannot connect to server',
      error: 'Command failed: herdr agent list',
    })),
  );
  assert.equal(view.bin, bin);
  assert.equal(view.reachable, false);
  assert.notEqual(view.error, 'spawn_failed');
  assert.match(view.error ?? '', /Command failed: herdr agent list/);
});

test('herdrView: bad_output (zero exit, unparseable stdout) surfaces the stdout excerpt, not the bare "bad_output" label', async () => {
  const dir = freshDir('al-view-badoutput-');
  const bin = herdrViewBin(dir);
  const view = await withHerdrViewPath(dir, () => herdrView(async () => ({ ok: true, stdout: 'not json at all garbage', stderr: '' })));
  assert.equal(view.bin, bin);
  assert.equal(view.reachable, false);
  assert.notEqual(view.error, 'bad_output');
  assert.match(view.error ?? '', /not json at all garbage/);
});

test('herdrView: bad_output with an empty message (zero exit, whitespace-only output on both streams) falls back to the label, never an empty string', async () => {
  const dir = freshDir('al-view-badoutput-empty-');
  const bin = herdrViewBin(dir);
  const view = await withHerdrViewPath(dir, () => herdrView(async () => ({ ok: true, stdout: '  ', stderr: '' })));
  assert.equal(view.bin, bin);
  assert.equal(view.reachable, false);
  assert.equal(view.error, 'bad_output');
});
