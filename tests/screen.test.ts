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
// prompt waits; the prompt is the same one throughout. Its wording differs
// between releases, so every test of it runs against each wording seen so far.
interface Wording {
  /** The Claude Code release that drew it. */
  release: string;
  /** A bash approval waiting on it, at `1:22` left. The 2.1.316 sample is the
   *  2.1.312 capture with only the notice line reworded. */
  fixture: string;
  /** What the notice says will happen to the request. */
  verb: string;
  /** Everything after the time, from the comma on. */
  tail: string;
}
const WORDINGS: Wording[] = [
  { release: '2.1.312', fixture: 'claude-bash-autodeny', verb: 'deny', tail: ', to avoid blocking progress on an unattended session' },
  { release: '2.1.316', fixture: 'claude-bash-autodeny-block', verb: 'block', tail: ', to avoid holding up an unattended session' },
];
const notice = (w: Wording, left: string): string => `⚠ Claude Code will automatically ${w.verb} this request in ${left}${w.tail}`;
const remaining = (text: string, left: string): string => text.replace('request in 1:22,', `request in ${left},`);
const fingerprint = (text: string): string => parseScreen(text, 'claude').fingerprint;
/** `text` with a narrow pane's line break put in front of `word` (which starts with a space). */
const foldBefore = (text: string, word: string): string => text.replace(word, `\n${word}`);

for (const w of WORDINGS) {
  const text = load(w.fixture);

  test(`[${w.release}] claude bash approval with an auto-deny countdown is a numbered choice that keeps the countdown in its block`, () => {
    const p = parseScreen(text, 'claude');
    assert.equal(p.kind, 'choice');
    assert.equal(p.numbered, true);
    assert.deepEqual(summary(p), [
      [1, 'Yes', true],
      [2, 'No', false],
    ]);
    assert.equal(first(p), 'Bash command');
    assert.equal(last(p), 'Esc to cancel · Tab to amend');
    assert.ok(p.block.some((l) => l.trim() === notice(w, '1:22')));
  });

  test(`[${w.release}] the auto-deny countdown ticking does not change the fingerprint`, () => {
    const fp = fingerprint(text);
    for (const left of ['1:21', '0:57', '0:00', '10:05']) {
      const ticked = remaining(text, left);
      assert.notEqual(ticked, text, left);
      assert.equal(fingerprint(ticked), fp, left);
    }
  });

  test(`[${w.release}] the countdown is recognised behind each warning sign Claude Code draws for it`, () => {
    for (const sign of ['‼', '⚠\uFE0F']) {
      const signed = text.replace('⚠ Claude Code will', `${sign} Claude Code will`);
      assert.notEqual(signed, text, sign);
      assert.equal(fingerprint(remaining(signed, '0:57')), fingerprint(signed), sign);
    }
  });

  test(`[${w.release}] the screen-reader wording of the countdown does not change the fingerprint as it counts down`, () => {
    const fp = fingerprint(remaining(text, 'about 2 minutes'));
    for (const left of ['about 1 minute', 'about 45 seconds', 'about 1 second']) {
      assert.equal(fingerprint(remaining(text, left)), fp, left);
    }
  });

  test(`[${w.release}] a countdown folded over two lines by a narrow pane does not change the fingerprint as it ticks`, () => {
    const folds: Array<[string, string]> = [
      [`${w.verb} this request in 1:22, to`, `${w.verb} this request in\n 1:22, to`],
      [`⚠ Claude Code will automatically ${w.verb}`, `⚠ Claude Code will automatically\n ${w.verb}`],
      ['an unattended', 'an\n unattended'],
    ];
    for (const [from, to] of folds) {
      const folded = text.replace(from, to);
      assert.notEqual(folded, text, to);
      const fp = fingerprint(folded);
      for (const left of ['0:57', '10:05']) {
        const ticked = folded.replace(/in(\s+)1:22,/, `in$1${left},`);
        assert.notEqual(ticked, folded, `${to} / ${left}`);
        assert.equal(fingerprint(ticked), fp, `${to} / ${left}`);
      }
    }
  });

  test(`[${w.release}] a countdown that folds at another word once its time gets shorter keeps the fingerprint`, () => {
    const at = `in 1:22${w.tail}`;
    const pairs: Array<[string, string]> = [
      [`in 10:00${foldBefore(w.tail, ' unattended')}`, `in 9:59${foldBefore(w.tail, ' session')}`],
      [`in about 1 minute${foldBefore(w.tail, ' an unattended')}`, `in about 59 seconds${foldBefore(w.tail, ' unattended')}`],
    ];
    for (const [longer, shorter] of pairs) {
      const a = text.replace(at, longer);
      const b = text.replace(at, shorter);
      assert.notEqual(a, text, longer);
      assert.notEqual(b, text, shorter);
      assert.equal(fingerprint(a), fingerprint(b), shorter);
    }
  });

  test(`[${w.release}] only the time of the countdown is left out: the rest of its line still counts`, () => {
    const edited = text.replace('an unattended session', 'an unattended run');
    assert.notEqual(edited, text);
    assert.notEqual(fingerprint(edited), fingerprint(text));
  });

  test(`[${w.release}] with a countdown on screen, a change to the command still changes the fingerprint, numbers included`, () => {
    const fp = fingerprint(text);
    const edits: Array<[string, string]> = [
      ['$(seq 1 15)', '$(seq 1 16)'],
      ['app:v1.2.3', 'app:v1.2.4'],
      ['head -c 30', 'head -c 31'],
      ['runs rm and could not be checked', 'runs rm and was refused'],
    ];
    for (const [from, to] of edits) {
      const edited = text.replace(from, to);
      assert.notEqual(edited, text, to);
      assert.notEqual(fingerprint(edited), fp, to);
    }
  });

  test(`[${w.release}] the countdown wording quoted inside the command is part of the command, so its time still counts`, () => {
    const bash = load('claude-bash');
    const quoting = (left: string): string => bash.replace('   date > stamp2.txt\n', `   grep "${notice(w, left)}" log.txt\n`);
    assert.notEqual(quoting('1:22'), bash);
    assert.notEqual(fingerprint(quoting('1:22')), fingerprint(quoting('0:57')));
  });

  test(`[${w.release}] a line of the prompt that starts with the countdown wording, without its warning sign, is not the countdown`, () => {
    const wording = (left: string): string => `Claude Code will automatically ${w.verb} this request in ${left}${w.tail}`;
    // [where, the line it replaces, what the line starts with]
    const places: Array<[string, string, string]> = [
      ['a line of the command', ' │ import json,sys,base64\n', ' │ '],
      ['the description under the title', ' 核对镜像 digest、健康检查与回滚命令序列\n', ' '],
    ];
    for (const [where, at, lead] of places) {
      const quoting = (left: string): string => text.replace(at, `${lead}${wording(left)}\n`);
      assert.notEqual(quoting('0:30'), text, where);
      assert.notEqual(fingerprint(quoting('0:30')), fingerprint(quoting('0:31')), where);
    }
  });
}

// Only the frame around the time is relied on: the warning sign, `Claude Code
// will automatically`, `this request in`, and the time. The verb and the words
// after the time are free, since Claude Code has reworded exactly those.
const LATEST = load('claude-bash-autodeny-block');
const LATEST_AT = 'in 1:22, to avoid holding up an unattended session';

test('a countdown with a verb not seen before does not change the fingerprint as it ticks', () => {
  const text = LATEST.replace('automatically block this request', 'automatically reject this request');
  assert.notEqual(text, LATEST);
  const fp = fingerprint(text);
  for (const left of ['1:21', '0:05', '12:00']) {
    assert.equal(fingerprint(remaining(text, left)), fp, left);
  }
});

test('a countdown with new words after its time does not change the fingerprint as it ticks', () => {
  const text = LATEST.replace(LATEST_AT, 'in 1:22, so a session left alone does not stall');
  assert.notEqual(text, LATEST);
  const fp = fingerprint(text);
  for (const left of ['1:21', '0:05', '12:00']) {
    assert.equal(fingerprint(remaining(text, left)), fp, left);
  }
  const fpScreenReader = fingerprint(remaining(text, 'about 2 minutes'));
  for (const left of ['about 1 minute', 'about 9 seconds']) {
    assert.equal(fingerprint(remaining(text, left)), fpScreenReader, left);
  }
});

test('a countdown with new words after its time, folded at a place that moves as the time gets shorter, keeps the fingerprint', () => {
  const pairs: Array<[string, string]> = [
    ['in 10:00, so a session left\n alone does not stall', 'in 9:59, so a session left alone\n does not stall'],
    ['in 1:22,\n so a session left alone\n does not stall', 'in 0:57, so\n a session left alone does\n not stall'],
  ];
  for (const [longer, shorter] of pairs) {
    const a = LATEST.replace(LATEST_AT, longer);
    const b = LATEST.replace(LATEST_AT, shorter);
    assert.notEqual(a, LATEST, longer);
    assert.notEqual(b, LATEST, shorter);
    assert.equal(fingerprint(a), fingerprint(b), shorter);
  }
});

test('a countdown with new words after its time still counts those words', () => {
  const a = LATEST.replace(LATEST_AT, 'in 1:22, so a session left alone does not stall');
  const b = LATEST.replace(LATEST_AT, 'in 1:22, so a session left alone does not wait');
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('a warning line with a time that lacks the frame of the countdown still counts its time', () => {
  const frame = '⚠ Claude Code will automatically block this request in 1:22,';
  const broken: Array<[string, (left: string) => string]> = [
    ['without "automatically"', (left) => `⚠ Claude Code will block this request in ${left},`],
    ['without "this request in"', (left) => `⚠ Claude Code will automatically block it at ${left},`],
    ['without "Claude Code"', (left) => `⚠ This tool will automatically block this request in ${left},`],
  ];
  for (const [what, line] of broken) {
    const at = (left: string): string => LATEST.replace(frame, line(left));
    assert.notEqual(at('1:22'), LATEST, what);
    assert.notEqual(fingerprint(at('1:22')), fingerprint(at('0:57')), what);
  }
});

test('a warning line right above the countdown, with no blank line between, keeps both counted while only the time is left out', () => {
  const above = '⚠ This command writes outside the project';
  const withAbove = (warning: string, text: string): string =>
    text.replace(' ⚠ Claude Code will automatically block', ` ${warning}\n ⚠ Claude Code will automatically block`);
  const text = withAbove(above, LATEST);
  assert.notEqual(text, LATEST);
  const fp = fingerprint(text);
  for (const left of ['1:21', '0:05']) {
    assert.equal(fingerprint(remaining(text, left)), fp, left);
  }
  assert.notEqual(fingerprint(withAbove('⚠ This command writes inside the project', LATEST)), fp);
  const countdownEdited = text.replace('an unattended session', 'an unattended run');
  assert.notEqual(countdownEdited, text);
  assert.notEqual(fingerprint(countdownEdited), fp);
});
