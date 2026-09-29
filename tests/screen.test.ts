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

test('options without a rule above them are unknown', () => {
  const text = 'Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n';
  const p = parseScreen(text, 'claude');
  assert.equal(p.kind, 'unknown');
  assert.deepEqual(p.options, []);
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

test('a question whose top has scrolled off is unknown, not a one-option question', () => {
  const lines = load('claude-ask-single').split('\n');
  const top = lines.findIndex((l) => l.includes(RULE));
  assert.ok(top >= 0);
  const clipped = lines.slice(top + 1).join('\n');
  assert.ok(clipped.includes('5. Chat about this'));
  assert.equal(parseScreen(clipped, 'claude').kind, 'unknown');
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
