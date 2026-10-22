// The screen parser, run against real captures of the prompts a coding agent
// stops on: which kind each one is, which options it offers and where the
// cursor sits, where the prompt block starts and ends, and what the
// fingerprint does (and does not) react to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScreen } from '../src/screen.js';
import type { ParsedScreen } from '../src/screen.js';

// The test runner starts from the repository root, whichever directory the
// compiled tests sit in.
const load = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'screens', `${name}.txt`), 'utf8');

const RULE = '─'.repeat(60);
const summary = (p: ParsedScreen): Array<[number, string, boolean]> =>
  p.options.map((o) => [o.n, o.label, o.cursor]);
const first = (p: ParsedScreen): string => p.block[0]?.trim() ?? '';
const last = (p: ParsedScreen): string => p.block[p.block.length - 1]?.trim() ?? '';

test('claude bash approval is a numbered choice with the cursor on 1', () => {
  const p = parseScreen(load('claude-bash'), 'claude');
  assert.equal(p.kind, 'choice');
  assert.equal(p.numbered, true);
  assert.deepEqual(summary(p), [
    [1, 'Yes', true],
    [2, 'Yes, and always allow access to /tmp/project from this project', false],
    [3, 'No', false],
  ]);
  assert.equal(first(p), 'Bash command');
  assert.equal(last(p), 'Esc to cancel · Tab to amend');
  assert.ok(p.block.every((l) => !l.includes(RULE)));
  assert.ok(p.block.some((l) => l.includes('date > stamp2.txt')));
  assert.ok(!p.block.some((l) => l.includes('Claude Code v')));
});

test('claude file-write approval is a numbered choice', () => {
  const p = parseScreen(load('claude-write'), 'claude');
  assert.equal(p.kind, 'choice');
  assert.equal(p.numbered, true);
  assert.deepEqual(
    p.options.map((o) => o.n),
    [1, 2, 3],
  );
  assert.equal(p.options[0]?.label, 'Yes');
  assert.equal(p.options[2]?.label, 'No');
  assert.equal(p.options[0]?.cursor, true);
  assert.equal(first(p), 'Create file');
  assert.equal(last(p), 'Esc to cancel · Tab to amend');
});

test('claude trust prompt has no numbers on screen, so they are counted from the top', () => {
  const p = parseScreen(load('claude-trust'), 'claude');
  assert.equal(p.kind, 'choice');
  assert.equal(p.numbered, false);
  assert.deepEqual(summary(p), [
    [1, 'No, exit', true],
    [2, 'Yes, I trust this folder', false],
  ]);
  assert.equal(first(p), 'Accessing workspace:');
  assert.equal(last(p), 'Enter to confirm · Esc to cancel');
});

test('claude single-select question: options 1-5 with the chat row past the inner rule', () => {
  const p = parseScreen(load('claude-ask-single'), 'claude');
  assert.equal(p.kind, 'question');
  assert.equal(p.numbered, true);
  assert.deepEqual(summary(p), [
    [1, 'Red', true],
    [2, 'Green', false],
    [3, 'Blue', false],
    [4, 'Type something.', false],
    [5, 'Chat about this', false],
  ]);
  assert.equal(first(p), '☐ Color');
  assert.equal(last(p), 'Enter to select · ↑/↓ to navigate · Esc to cancel');
  assert.ok(p.block.some((l) => l.includes('Which color do you prefer?')));
  assert.ok(p.block.every((l) => !l.includes(RULE)));
});

test('claude multi-select question keeps the checkbox in the label', () => {
  const p = parseScreen(load('claude-ask-multi'), 'claude');
  assert.equal(p.kind, 'question');
  assert.equal(p.numbered, true);
  assert.deepEqual(summary(p), [
    [1, '[ ] Apple', true],
    [2, '[ ] Banana', false],
    [3, '[ ] Cherry', false],
    [4, '[ ] Type something', false],
    [5, 'Chat about this', false],
  ]);
  assert.equal(first(p), '←  ☐ Fruits  ✔ Submit  →');
});

test('claude two-question form shows the current question only', () => {
  const p = parseScreen(load('claude-ask-twoq'), 'claude');
  assert.equal(p.kind, 'question');
  assert.deepEqual(summary(p), [
    [1, 'Red', true],
    [2, 'Green', false],
    [3, 'Type something.', false],
    [4, 'Chat about this', false],
  ]);
  assert.ok(p.block.some((l) => l.includes('Which color do you prefer?')));
  assert.equal(last(p), 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel');
});

test('claude submit page has no footer line and ends on the last option', () => {
  const p = parseScreen(load('claude-ask-review'), 'claude');
  assert.equal(p.kind, 'question');
  assert.equal(p.numbered, true);
  assert.deepEqual(summary(p), [
    [1, 'Submit answers', true],
    [2, 'Cancel', false],
  ]);
  assert.equal(first(p), '←  ☒ Color  ☒ Pet  ✔ Submit  →');
  assert.equal(last(p), '2. Cancel');
});

test('kimi command approval is a numbered choice with four options', () => {
  const p = parseScreen(load('kimi-approval'), 'kimi');
  assert.equal(p.kind, 'choice');
  assert.equal(p.numbered, true);
  assert.deepEqual(summary(p), [
    [1, 'Approve once', true],
    [2, 'Approve for this session', false],
    [3, 'Reject', false],
    [4, 'Reject with feedback', false],
  ]);
  assert.equal(first(p), '▶ Run this command?');
  assert.equal(last(p), '↑/↓ select · 1/2/3/4 choose · ↵ confirm');
  assert.ok(p.block.some((l) => l.includes('$ date > stamp3.txt')));
});

test('kimi question is recognised by its first line', () => {
  const p = parseScreen(load('kimi-question'), 'kimi');
  assert.equal(p.kind, 'question');
  assert.equal(p.numbered, true);
  assert.deepEqual(summary(p), [
    [1, 'red', true],
    [2, 'green', false],
    [3, 'blue', false],
    [4, 'Other', false],
  ]);
  assert.equal(first(p), 'question');
  assert.equal(last(p), '↑↓ select  1-4 / ↵ choose  ←/→/tab switch  esc cancel');
});

test('kimi submit page is a question with Submit and Cancel', () => {
  const p = parseScreen(load('kimi-question-submit'), 'kimi');
  assert.equal(p.kind, 'question');
  assert.deepEqual(summary(p), [
    [1, 'Submit', true],
    [2, 'Cancel', false],
  ]);
  assert.equal(first(p), 'question');
});

test('empty text is unknown', () => {
  for (const cli of ['claude', 'kimi'] as const) {
    const p = parseScreen('', cli);
    assert.equal(p.kind, 'unknown');
    assert.deepEqual(p.options, []);
    assert.deepEqual(p.block, []);
    assert.equal(p.numbered, false);
    assert.equal(p.fingerprint, '');
  }
});

test('text without option lines is unknown', () => {
  const text = `plain output\n${RULE}\nDo you want to proceed?\n\nEsc to cancel\n`;
  assert.equal(parseScreen(text, 'claude').kind, 'unknown');
});

test('numbered options from 1 with a hint line below and no rule above: the prompt starts at the first line on screen', () => {
  const text = '\nDo you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n';
  const p = parseScreen(text, 'claude');
  assert.equal(p.kind, 'choice');
  assert.deepEqual(summary(p), [
    [1, 'Yes', true],
    [2, 'No', false],
  ]);
  assert.equal(first(p), 'Do you want to proceed?');
  assert.equal(last(p), 'Esc to cancel');
});

test('without a rule above, unnumbered options stay unknown', () => {
  const text = 'Trust this folder?\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n';
  const p = parseScreen(text, 'claude');
  assert.equal(p.kind, 'unknown');
  assert.deepEqual(p.options, []);
});

test('without a rule above, numbered options with no hint line below stay unknown', () => {
  const text = 'some list\n 1. Yes\n 2. No\n';
  assert.equal(parseScreen(text, 'claude').kind, 'unknown');
});

test('without a rule above, numbered options that do not start at 1 stay unknown', () => {
  const text = 'more\n 2. Yes\n 3. No\n\n Esc to cancel\n';
  assert.equal(parseScreen(text, 'claude').kind, 'unknown');
});

test('a long bash approval whose top rule scrolled off is still a numbered choice, from the first line on screen', () => {
  const p = parseScreen(load('claude-bash-long'), 'claude');
  assert.equal(p.kind, 'choice');
  assert.equal(p.numbered, true);
  assert.deepEqual(
    p.options.map((o) => [o.n, o.cursor]),
    [
      [1, true],
      [2, false],
      [3, false],
    ],
  );
  assert.equal(p.options[0]!.label, 'Yes');
  assert.equal(p.options[2]!.label, 'No');
  assert.equal(first(p), '│ {');
  assert.equal(last(p), 'Esc to cancel · Tab to amend');
});

test('moving only the cursor keeps the fingerprint and moves the cursor flag', () => {
  const text = load('claude-bash');
  const moved = text.replace(' ❯ 1. Yes', '   1. Yes').replace('   3. No', ' ❯ 3. No');
  assert.notEqual(moved, text);
  const a = parseScreen(text, 'claude');
  const b = parseScreen(moved, 'claude');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, '');
  assert.deepEqual(
    b.options.map((o) => o.cursor),
    [false, false, true],
  );
});

test('moving the cursor on an unnumbered prompt keeps the fingerprint too', () => {
  const text = load('claude-trust');
  const moved = text.replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust', ' ❯ Yes, I trust');
  assert.notEqual(moved, text);
  const a = parseScreen(text, 'claude');
  const b = parseScreen(moved, 'claude');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(
    b.options.map((o) => o.cursor),
    [false, true],
  );
});

test('changing a line of the prompt changes the fingerprint', () => {
  const text = load('claude-bash');
  const edited = text.replace('date > stamp2.txt\n   Write', 'date > stamp9.txt\n   Write');
  assert.notEqual(edited, text);
  assert.notEqual(parseScreen(text, 'claude').fingerprint, parseScreen(edited, 'claude').fingerprint);
});

test('whitespace differences alone do not change the fingerprint', () => {
  const text = load('kimi-approval');
  const spaced = text.replace('Approve for this session', 'Approve  for   this session');
  assert.equal(parseScreen(text, 'kimi').fingerprint, parseScreen(spaced, 'kimi').fingerprint);
});

test('a numbered line inside the shown content is not taken for an option', () => {
  const text = [
    RULE,
    ' Create file',
    '  1. first line of the file',
    '  2. second line of the file',
    ' Do you want to create it?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel',
  ].join('\n');
  const p = parseScreen(text, 'claude');
  assert.deepEqual(summary(p), [
    [1, 'Yes', true],
    [2, 'No', false],
  ]);
});

test('a question whose top has scrolled off is still the whole question, not a one-option question', () => {
  const lines = load('claude-ask-single').split('\n');
  const top = lines.findIndex((l) => l.includes(RULE));
  assert.ok(top >= 0);
  const clipped = lines.slice(top + 1).join('\n');
  assert.ok(clipped.includes('5. Chat about this'));
  const p = parseScreen(clipped, 'claude');
  assert.equal(p.kind, 'question');
  assert.deepEqual(
    p.options.map((o) => o.n),
    [1, 2, 3, 4, 5],
  );
});

test('a bare option-and-rule tail is unknown', () => {
  const text = ['3. Blue', '4. Type something.', RULE, '5. Chat about this', '', 'Esc to cancel'].join('\n');
  assert.equal(parseScreen(text, 'claude').kind, 'unknown');
});

test('an echoed cursor line under a rule is not a prompt', () => {
  const text = [RULE, '❯ run the thing', 'some text'].join('\n');
  assert.equal(parseScreen(text, 'claude').kind, 'unknown');
});

test('a numbered block with a single option line is unknown', () => {
  const text = [RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '', ' Esc to cancel'].join('\n');
  assert.equal(parseScreen(text, 'claude').kind, 'unknown');
});

test('a permission prompt whose command mentions the question markers is still a permission prompt', () => {
  const bash = load('claude-bash');
  for (const marker of ['Chat about this', 'Ready to submit your answers?']) {
    const text = bash.replace('   date > stamp2.txt\n', `   grep "${marker}" src/screen.ts\n`);
    assert.ok(text.includes(`grep "${marker}"`), marker);
    const p = parseScreen(text, 'claude');
    assert.equal(p.kind, 'choice', marker);
    assert.deepEqual(
      p.options.map((o) => o.n),
      [1, 2, 3],
    );
  }
});

test('every claude question sample is still a question', () => {
  for (const name of ['claude-ask-single', 'claude-ask-multi', 'claude-ask-twoq', 'claude-ask-review']) {
    assert.equal(parseScreen(load(name), 'claude').kind, 'question', name);
  }
});

// Claude Code's unattended-session notice counts down every second while the
// prompt waits; the prompt is the same one throughout.
const COUNTDOWN = '⚠ Claude Code will automatically deny this request in 1:22, to avoid blocking progress on an unattended session';
const remaining = (text: string, left: string): string => text.replace('request in 1:22,', `request in ${left},`);

test('claude bash approval with an auto-deny countdown is a numbered choice that keeps the countdown in its block', () => {
  const p = parseScreen(load('claude-bash-autodeny'), 'claude');
  assert.equal(p.kind, 'choice');
  assert.equal(p.numbered, true);
  assert.deepEqual(summary(p), [
    [1, 'Yes', true],
    [2, 'No', false],
  ]);
  assert.equal(first(p), 'Bash command');
  assert.equal(last(p), 'Esc to cancel · Tab to amend');
  assert.ok(p.block.some((l) => l.trim() === COUNTDOWN));
});

test('the auto-deny countdown ticking does not change the fingerprint', () => {
  const text = load('claude-bash-autodeny');
  const fp = parseScreen(text, 'claude').fingerprint;
  for (const left of ['1:21', '0:57', '0:00', '10:05']) {
    const ticked = remaining(text, left);
    assert.notEqual(ticked, text, left);
    assert.equal(parseScreen(ticked, 'claude').fingerprint, fp, left);
  }
});

test('the countdown is recognised behind each warning sign Claude Code draws for it', () => {
  const text = load('claude-bash-autodeny');
  for (const sign of ['‼', '⚠\uFE0F']) {
    const signed = text.replace('⚠ Claude Code will', `${sign} Claude Code will`);
    assert.notEqual(signed, text, sign);
    assert.equal(parseScreen(remaining(signed, '0:57'), 'claude').fingerprint, parseScreen(signed, 'claude').fingerprint, sign);
  }
});

test('the screen-reader wording of the countdown does not change the fingerprint as it counts down', () => {
  const text = load('claude-bash-autodeny');
  const fp = parseScreen(remaining(text, 'about 2 minutes'), 'claude').fingerprint;
  for (const left of ['about 1 minute', 'about 45 seconds', 'about 1 second']) {
    assert.equal(parseScreen(remaining(text, left), 'claude').fingerprint, fp, left);
  }
});

test('a countdown folded over two lines by a narrow pane does not change the fingerprint as it ticks', () => {
  const text = load('claude-bash-autodeny');
  const folds: Array<[string, string]> = [
    ['deny this request in 1:22, to', 'deny this request in\n 1:22, to'],
    ['⚠ Claude Code will automatically deny', '⚠ Claude Code will automatically\n deny'],
    ['progress on an unattended', 'progress on an\n unattended'],
  ];
  for (const [from, to] of folds) {
    const folded = text.replace(from, to);
    assert.notEqual(folded, text, to);
    const fp = parseScreen(folded, 'claude').fingerprint;
    for (const left of ['0:57', '10:05']) {
      const ticked = folded.replace(/in(\s+)1:22,/, `in$1${left},`);
      assert.notEqual(ticked, folded, `${to} / ${left}`);
      assert.equal(parseScreen(ticked, 'claude').fingerprint, fp, `${to} / ${left}`);
    }
  }
});

test('a countdown that folds at another word once its time gets shorter keeps the fingerprint', () => {
  const text = load('claude-bash-autodeny');
  const pairs: Array<[string, string]> = [
    ['in 10:00, to avoid blocking progress on an\n unattended session', 'in 9:59, to avoid blocking progress on an unattended\n session'],
    ['in about 1 minute, to avoid blocking progress on\n an unattended session', 'in about 59 seconds, to avoid blocking progress on an\n unattended session'],
  ];
  for (const [longer, shorter] of pairs) {
    const a = text.replace('in 1:22, to avoid blocking progress on an unattended session', longer);
    const b = text.replace('in 1:22, to avoid blocking progress on an unattended session', shorter);
    assert.notEqual(a, text, longer);
    assert.notEqual(b, text, shorter);
    assert.equal(parseScreen(a, 'claude').fingerprint, parseScreen(b, 'claude').fingerprint, shorter);
  }
});

test('only the time of the countdown is left out: the rest of its line still counts', () => {
  const text = load('claude-bash-autodeny');
  const edited = text.replace('on an unattended session', 'on an unattended run');
  assert.notEqual(edited, text);
  assert.notEqual(parseScreen(edited, 'claude').fingerprint, parseScreen(text, 'claude').fingerprint);
});

test('with a countdown on screen, a change to the command still changes the fingerprint, numbers included', () => {
  const text = load('claude-bash-autodeny');
  const fp = parseScreen(text, 'claude').fingerprint;
  const edits: Array<[string, string]> = [
    ['$(seq 1 15)', '$(seq 1 16)'],
    ['app:v1.2.3', 'app:v1.2.4'],
    ['head -c 30', 'head -c 31'],
    ['runs rm and could not be checked', 'runs rm and was refused'],
  ];
  for (const [from, to] of edits) {
    const edited = text.replace(from, to);
    assert.notEqual(edited, text, to);
    assert.notEqual(parseScreen(edited, 'claude').fingerprint, fp, to);
  }
});

test('the countdown wording quoted inside the command is part of the command, so its time still counts', () => {
  const bash = load('claude-bash');
  const quoting = (left: string): string =>
    bash.replace('   date > stamp2.txt\n', `   grep "${remaining(COUNTDOWN, left)}" log.txt\n`);
  assert.notEqual(parseScreen(quoting('1:22'), 'claude').fingerprint, parseScreen(quoting('0:57'), 'claude').fingerprint);
});

test('a line of the prompt that starts with the countdown wording, without its warning sign, is not the countdown', () => {
  const text = load('claude-bash-autodeny');
  const wording = (left: string): string =>
    `Claude Code will automatically deny this request in ${left}, to avoid blocking progress on an unattended session`;
  // [where, the line it replaces, what the line starts with]
  const places: Array<[string, string, string]> = [
    ['a line of the command', ' │ import json,sys,base64\n', ' │ '],
    ['the description under the title', ' 核对镜像 digest、健康检查与回滚命令序列\n', ' '],
  ];
  for (const [where, at, lead] of places) {
    const quoting = (left: string): string => text.replace(at, `${lead}${wording(left)}\n`);
    assert.notEqual(quoting('0:30'), text, where);
    assert.notEqual(parseScreen(quoting('0:30'), 'claude').fingerprint, parseScreen(quoting('0:31'), 'claude').fingerprint, where);
  }
});
