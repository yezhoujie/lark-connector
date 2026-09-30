// The card JSON this skill sends, checked field by field: header colours and
// icons, the button row of a single-choice question, the form of a
// multi-choice one, and the language each card shell is rendered in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askCard, awayCard, notifyCard, receiptCard, statusCard, type StatusState, type StatusView } from '../src/cards.js';
import type { ParsedScreen } from '../src/screen.js';
import type { AskPayload } from '../src/validate.js';

interface Card {
  schema: string;
  header: { title: { tag: string; content: string }; template: string };
  body: { elements: Array<Record<string, unknown>> };
}
const asCard = (c: object): Card => c as Card;
const tags = (c: Card): string[] => c.body.elements.map((e) => String(e.tag));

const single: AskPayload = {
  title: 'Keep the scratch dir?',
  doing: 'wiring',
  description: 'bg',
  blocker: 'blk',
  options: [
    { id: 'keep', label: 'Keep', consequence: 'stays' },
    { id: 'drop', label: 'Drop', consequence: 'gone' },
    { id: 'wipe', label: 'Wipe', consequence: 'all gone', danger: true },
  ],
  recommend: 'keep',
  reasoning: 'why',
  question: 'keep or drop?',
  select: 'single',
};
const multi: AskPayload = { ...single, select: 'multi', recommend: ['keep', 'drop'] };

test('pending single-choice: blue header, one button per option (primary = recommended, danger = confirm), hint last, no form', () => {
  const c = asCard(askCard({ payload: single, projectLabel: 'proj', reqId: 'r1', state: 'pending', lang: 'zh' }));
  assert.equal(c.schema, '2.0');
  assert.equal(c.header.template, 'blue');
  assert.equal(c.header.title.content, '🤔 [proj] Keep the scratch dir?');
  assert.deepEqual(tags(c), ['markdown', 'markdown', 'markdown', 'hr', 'markdown', 'hr', 'markdown', 'markdown', 'button', 'button', 'button', 'markdown']);
  const buttons = c.body.elements.filter((e) => e.tag === 'button');
  assert.deepEqual(
    buttons.map((b) => [(b.text as { content: string }).content, b.type, 'confirm' in b, b.value]),
    [
      ['Keep', 'primary', false, { reqId: 'r1', optionId: 'keep' }],
      ['Drop', 'default', false, { reqId: 'r1', optionId: 'drop' }],
      ['Wipe', 'danger', true, { reqId: 'r1', optionId: 'wipe' }],
    ],
  );
  const options = c.body.elements[4]!.content as string;
  // the label / consequence separator is a plain colon (Feishu drops U+3000); the recommendation mark closes the line
  assert.match(options, /^1\. \*\*Keep\*\*：stays　← 我推荐$/m);
  assert.match(options, /^2\. \*\*Drop\*\*：gone$/m);
  assert.match(options, /^3\. \*\*Wipe\*\*　⚠️：all gone$/m);
  const hint = c.body.elements.at(-1)!;
  assert.match(String(hint.content), /红色按钮会二次确认/);
});

test('the background sits under its label, so a table in it starts at the beginning of a line; the other fields keep label and value on one line', () => {
  const table = '| a | b |\n|---|---|\n| 1 | 2 |';
  const c = asCard(askCard({ payload: { ...single, description: table }, projectLabel: 'proj', reqId: 'r1', state: 'pending', lang: 'en' }));
  assert.equal(c.body.elements[1]!.content, `**Background**\n\n${table}`);
  assert.equal(c.body.elements[0]!.content, '**Doing**　wiring');
  assert.equal(c.body.elements[2]!.content, '**Blocker**　blk');
});

test('pending multi-choice with a danger option: one form of checkers plus a submit button that asks for confirmation', () => {
  const c = asCard(askCard({ payload: multi, projectLabel: 'proj', reqId: 'r2', state: 'pending', lang: 'zh' }));
  assert.equal(c.header.template, 'blue');
  assert.deepEqual(tags(c), ['markdown', 'markdown', 'markdown', 'hr', 'markdown', 'hr', 'markdown', 'markdown', 'form', 'markdown']);
  const options = c.body.elements[4]!.content as string;
  assert.match(options, /^1\. \*\*Keep\*\*：stays　← 我推荐$/m);
  assert.match(options, /^2\. \*\*Drop\*\*：gone　← 我推荐$/m);
  assert.match(options, /^3\. \*\*Wipe\*\*　⚠️：all gone$/m);
  const form = c.body.elements[8]!;
  assert.deepEqual(form, {
    tag: 'form',
    name: 'ask',
    elements: [
      { tag: 'checker', name: 'opt:keep', checked: true, text: { tag: 'lark_md', content: '**Keep**：stays' } },
      { tag: 'checker', name: 'opt:drop', checked: true, text: { tag: 'lark_md', content: '**Drop**：gone' } },
      { tag: 'checker', name: 'opt:wipe', checked: false, text: { tag: 'lark_md', content: '**Wipe**：all gone' } },
      {
        tag: 'button',
        name: 'submit',
        form_action_type: 'submit',
        type: 'primary',
        text: { tag: 'plain_text', content: '提交' },
        behaviors: [{ type: 'callback', value: { reqId: 'r2', attempt: 0 } }],
        confirm: {
          title: { tag: 'plain_text', content: '确认执行' },
          text: { tag: 'plain_text', content: '所选项里有不可逆或高代价的操作。确定提交？' },
        },
      },
    ],
  });
  assert.match(String(c.body.elements.at(-1)!.content), /勾选后点提交/);
});

test('checker names are prefixed, so an option id of "submit" or "ask" cannot collide with the form or its button', () => {
  const payload: AskPayload = {
    ...multi,
    options: [
      { id: 'submit', label: 'S', consequence: 'c' },
      { id: 'ask', label: 'A', consequence: 'c' },
    ],
    recommend: ['ask'],
  };
  const c = asCard(askCard({ payload, projectLabel: 'proj', reqId: 'r9', state: 'pending' }));
  const form = c.body.elements.find((e) => e.tag === 'form') as { name: string; elements: Array<Record<string, unknown>> };
  const names = form.elements.map((e) => e.name);
  assert.deepEqual(names, ['opt:submit', 'opt:ask', 'submit']);
  assert.equal(new Set([form.name, ...names]).size, 4, 'a name is used twice on the card');
});

test('pending multi-choice without danger: the submit button carries no confirm; en shell wording', () => {
  const payload: AskPayload = {
    ...multi,
    options: multi.options.filter((o) => !o.danger),
  };
  const c = asCard(askCard({ payload, projectLabel: 'proj', reqId: 'r3', state: 'pending', lang: 'en' }));
  const form = c.body.elements.find((e) => e.tag === 'form')!;
  const submit = (form.elements as Array<Record<string, unknown>>).at(-1)!;
  assert.equal((submit.text as { content: string }).content, 'Submit');
  assert.equal('confirm' in submit, false);
  assert.match(String(c.body.elements.at(-1)!.content), /Tick what applies, then Submit/);
  // en: an em dash separates label and consequence, the recommendation mark closes the line
  const options = c.body.elements[4]!.content as string;
  assert.match(options, /^1\. \*\*Keep\*\* — stays　← recommended$/m);
  assert.match(options, /^2\. \*\*Drop\*\* — gone　← recommended$/m);
});

test('a re-rendered pending multi-choice card carries the attempt in the submit value, so a second submit is a new action', () => {
  const c = asCard(askCard({ payload: multi, projectLabel: 'proj', reqId: 'r2', state: 'pending', attempt: 2 }));
  const form = c.body.elements.find((e) => e.tag === 'form') as { elements: Array<Record<string, unknown>> };
  const submit = form.elements.at(-1) as { behaviors: Array<{ value: unknown }> };
  assert.deepEqual(submit.behaviors[0]!.value, { reqId: 'r2', attempt: 2 });
});

test('pending --urgent: red header; the same card without urgent is blue', () => {
  const urgent = asCard(askCard({ payload: single, projectLabel: 'proj', reqId: 'r4', state: 'pending', urgent: true }));
  assert.equal(urgent.header.template, 'red');
  assert.equal(urgent.header.title.content, '🤔 [proj] Keep the scratch dir?');
  const calm = asCard(askCard({ payload: single, projectLabel: 'proj', reqId: 'r4', state: 'pending', urgent: false }));
  assert.equal(calm.header.template, 'blue');
  assert.deepEqual(tags(urgent), tags(calm));
});

test('answered / timed out / cancelled: green / grey / grey, reply pinned on top, no buttons and no form — for single and multi alike', () => {
  for (const payload of [single, multi]) {
    const answered = asCard(askCard({ payload, projectLabel: 'proj', reqId: 'r5', state: 'answered', reply: 'Keep、Drop', urgent: true, lang: 'zh' }));
    assert.equal(answered.header.template, 'green');
    assert.equal(answered.header.title.content, '✅ [proj] Keep the scratch dir? · 已回答');
    assert.deepEqual(tags(answered).slice(0, 3), ['markdown', 'hr', 'markdown']);
    assert.equal(String(answered.body.elements[0]!.content), '**你的回复**　Keep、Drop');
    assert.equal(tags(answered).includes('button'), false);
    assert.equal(tags(answered).includes('form'), false);
    const timedout = asCard(askCard({ payload, projectLabel: 'proj', reqId: 'r5', state: 'timedout', lang: 'zh' }));
    assert.equal(timedout.header.template, 'grey');
    assert.match(timedout.header.title.content, /^⌛ .* · 已超时$/);
    const cancelled = asCard(askCard({ payload, projectLabel: 'proj', reqId: 'r5', state: 'cancelled', lang: 'zh' }));
    assert.equal(cancelled.header.template, 'grey');
    assert.match(cancelled.header.title.content, /^⚠️ .* · 已取消$/);
  }
});

test('notify: wathet header with the megaphone, one markdown body', () => {
  const c = asCard(notifyCard({ title: 'Tests green', body: 'moving on' }, 'proj'));
  assert.equal(c.header.template, 'wathet');
  assert.equal(c.header.title.content, '📣 [proj] Tests green');
  assert.deepEqual(c.body.elements, [{ tag: 'markdown', content: 'moving on' }]);
});

test('receipt card: orange, shell wording follows the language it is asked for', () => {
  const zh = asCard(receiptCard('proj', 'nowhere to go', 'zh'));
  assert.equal(zh.header.template, 'orange');
  assert.equal(zh.header.title.content, '⚠️ [proj] 没能送达');
  assert.match(String(zh.body.elements[0]!.content), /没能送进终端：nowhere to go/);
  const en = asCard(receiptCard('proj', 'nowhere to go', 'en'));
  assert.equal(en.header.title.content, '⚠️ [proj] Not delivered');
  assert.match(String(en.body.elements[0]!.content), /never reached the terminal: nowhere to go/);
});

test('an ask card with no lang in the context renders the English shell, like the receipt and status cards', () => {
  const c = asCard(askCard({ payload: single, projectLabel: 'proj', reqId: 'r1', state: 'pending' }));
  assert.match(String(c.body.elements[0]!.content), /^\*\*Doing\*\*/);
  // `single` carries a danger option, so the hint is the danger variant — in English.
  assert.match(String(c.body.elements.at(-1)!.content), /Red buttons ask for confirmation/);
  const done = asCard(askCard({ payload: single, projectLabel: 'proj', reqId: 'r1', state: 'answered', reply: 'Keep' }));
  assert.equal(done.header.title.content, '✅ [proj] Keep the scratch dir? · Answered');
});

test('receipt and status cards default to English when no language is given', () => {
  assert.equal(asCard(receiptCard('proj', 'why')).header.title.content, '⚠️ [proj] Not delivered');
  assert.equal(asCard(statusCard('proj', 'pane w1:p1')).header.title.content, '🔔 [proj] waiting for you');
});

test('status card: orange, shell wording follows the language it is asked for', () => {
  const zh = asCard(statusCard('proj', '窗格 w1:p1', 'zh'));
  assert.equal(zh.header.template, 'orange');
  assert.equal(zh.header.title.content, '🔔 [proj] 等你输入');
  const en = asCard(statusCard('proj', 'pane w1:p1', 'en'));
  assert.equal(en.header.title.content, '🔔 [proj] waiting for you');
  assert.deepEqual(en.body.elements, [{ tag: 'markdown', content: 'pane w1:p1' }]);
});

test('awayCard on: green, phone icon, title "[label] Remote mode is on", one markdown body', () => {
  const c = asCard(awayCard('proj', true, 'body text', 'en'));
  assert.equal(c.header.template, 'green');
  assert.equal(c.header.title.content, '📱 [proj] Remote mode is on');
  assert.deepEqual(c.body.elements, [{ tag: 'markdown', content: 'body text' }]);
});

test('awayCard off: grey, moon icon, title "[label] Remote mode is about to turn off"', () => {
  const c = asCard(awayCard('proj', false, 'body text', 'en'));
  assert.equal(c.header.template, 'grey');
  assert.equal(c.header.title.content, '🌙 [proj] Remote mode is about to turn off');
  assert.deepEqual(c.body.elements, [{ tag: 'markdown', content: 'body text' }]);
});

test('awayCard: the shell title follows lang, like the other cards', () => {
  const c = asCard(awayCard('proj', true, '正文', 'zh'));
  assert.equal(c.header.title.content, '📱 [proj] 远程模式已开启');
  const off = asCard(awayCard('proj', false, '正文', 'zh'));
  assert.equal(off.header.title.content, '🌙 [proj] 远程模式即将关闭');
});

test('awayCard: a title override replaces the on/off wording; icon and template still follow `on`', () => {
  const c = asCard(awayCard('proj', false, 'body text', 'en', 'Custom title'));
  assert.equal(c.header.template, 'grey');
  assert.equal(c.header.title.content, '🌙 [proj] Custom title');
});

// ---- status card with a prompt on screen ----

const choiceScreen: ParsedScreen = {
  kind: 'choice',
  block: ['Bash command', '  date > stamp.txt', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'],
  options: [
    { n: 1, label: 'Yes', cursor: true },
    { n: 2, label: 'No', cursor: false },
  ],
  numbered: true,
  fingerprint: 'fp',
};
const fence = (block: object): string => String((block as { content: string }).content);

test('status card with a numbered prompt: code block holds the block, no rule, reply hint as the note', () => {
  const c = asCard(statusCard('p', '**deploy**\npane w1:p1', 'zh', { screen: choiceScreen }));
  assert.equal(c.header.title.content, '🔔 [p] 等你输入');
  assert.equal(c.header.template, 'orange');
  assert.equal(c.body.elements.length, 3);
  assert.equal(c.body.elements[0]!.content, '**deploy**\npane w1:p1');
  assert.equal(c.body.elements[1]!.content, '```\n' + choiceScreen.block.join('\n') + '\n```');
  assert.ok(c.body.elements.every((e) => e.tag !== 'hr'));
  assert.equal(c.body.elements[2]!.content, "<font color='grey'>回复编号即可选择，例如 1</font>");
});

test('status card without a screen is unchanged: one markdown element', () => {
  const c = asCard(statusCard('p', 'pane w1:p1', 'en'));
  assert.deepEqual(c.body.elements, [{ tag: 'markdown', content: 'pane w1:p1' }]);
  assert.equal(c.header.title.content, '🔔 [p] waiting for you');
});

test('status card, prompt without printed numbers: the counted numbers are listed under the code block', () => {
  const screen: ParsedScreen = {
    kind: 'choice',
    block: ['Trust this folder?', '❯ No, exit', '  Yes, I trust this folder'],
    options: [
      { n: 1, label: 'No, exit', cursor: true },
      { n: 2, label: 'Yes, I trust this folder', cursor: false },
    ],
    numbered: false,
    fingerprint: 'x',
  };
  const c = asCard(statusCard('p', 'd', 'en', { screen }));
  assert.equal(c.body.elements.length, 4);
  assert.equal(c.body.elements[2]!.content, '**Reply with the number:**\n\n1. No, exit\n2. Yes, I trust this folder');
});

test('status card, unrecognised prompt: last 20 raw lines in the code block and a go-to-the-computer note', () => {
  const raw = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join('\n') + '\n\n';
  const screen: ParsedScreen = { kind: 'unknown', block: [], options: [], numbered: false, fingerprint: '' };
  const c = asCard(statusCard('p', 'd', 'zh', { screen, raw }));
  const lines = String(c.body.elements[1]!.content).split('\n');
  assert.equal(lines.length, 22);
  assert.equal(lines[1], 'row 11');
  assert.equal(lines[20], 'row 30');
  assert.equal(c.body.elements[2]!.content, "<font color='grey'>认不出选项，请回电脑处理</font>");
});

test('status card clips a line over 160 characters with an ellipsis', () => {
  const screen: ParsedScreen = { ...choiceScreen, block: ['a'.repeat(200), 'b'.repeat(160)] };
  const lines = fence(asCard(statusCard('p', 'd', 'en', { screen })).body.elements[1]!).split('\n');
  assert.equal(lines[1], 'a'.repeat(159) + '…');
  assert.equal(lines[2], 'b'.repeat(160));
});

test('status card keeps the first 8 and last 31 lines of a prompt over 40 lines, with an omission line between', () => {
  const block = Array.from({ length: 60 }, (_, i) => `L${i + 1}`);
  const screen: ParsedScreen = { ...choiceScreen, block };
  const lines = fence(asCard(statusCard('p', 'd', 'en', { screen })).body.elements[1]!).split('\n').slice(1, -1);
  assert.equal(lines.length, 40);
  assert.deepEqual(lines.slice(0, 8), block.slice(0, 8));
  assert.equal(lines[8], '… 21 lines omitted; see the computer for the full text …');
  assert.deepEqual(lines.slice(9), block.slice(-31));
});

test('exactly 40 lines are shown whole', () => {
  const block = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
  const lines = fence(asCard(statusCard('p', 'd', 'en', { screen: { ...choiceScreen, block } })).body.elements[1]!).split('\n').slice(1, -1);
  assert.deepEqual(lines, block);
});

test('a triple backtick inside the prompt cannot close the code fence', () => {
  const screen: ParsedScreen = { ...choiceScreen, block: ['run ```rm``` and ````x'] };
  const content = fence(asCard(statusCard('p', 'd', 'en', { screen })).body.elements[1]!);
  const inner = content.slice(4, -4);
  assert.doesNotMatch(inner, /```/);
  assert.equal(inner.replace(/​/g, ''), 'run ```rm``` and ````x');
});

test('resolved status cards: state word in the title, grey or green, no note, code block kept', () => {
  const cases: Array<[StatusState, string, string, string]> = [
    ['chosen', 'green', '✅ [p] 等你输入 · 已解除 · 手机上选了 2', '手机上选了 2'],
    ['chosenNext', 'grey', '➡️ [p] 等你输入 · 已解除 · 手机上选了 2，下一步见新卡', '下一步'],
    ['terminal', 'grey', '💻 [p] 等你输入 · 已解除 · 已在终端处理', '终端'],
    ['stale', 'grey', '⌛ [p] 等你输入 · 已过期 · 提示已变化，见新卡', '过期'],
    ['closed', 'grey', '🌙 [p] 等你输入 · 已关闭 · 远程模式已关闭', '关闭'],
  ];
  for (const [state, template, title] of cases) {
    const view: StatusView = state === 'chosen' || state === 'chosenNext' ? { screen: choiceScreen, state, choice: 2 } : { screen: choiceScreen, state };
    const c = asCard(statusCard('p', 'd', 'zh', view));
    assert.equal(c.header.title.content, title, state);
    assert.equal(c.header.template, template, state);
    assert.equal(c.body.elements.length, 2, state);
    assert.match(String(c.body.elements[1]!.content), /^```/, state);
  }
  const en = asCard(statusCard('p', 'd', 'en', { screen: choiceScreen, state: 'chosen', choice: 1 }));
  assert.equal(en.header.title.content, '✅ [p] waiting for you · Resolved · you picked 1 on the phone');
});

test('a picked state without the picked number is refused, in the types and at run time', () => {
  // @ts-expect-error a picked state must say which number was picked
  const missing: StatusView = { screen: choiceScreen, state: 'chosen' };
  assert.throws(() => statusCard('p', 'd', 'zh', missing), /choice/);
  const zero = { screen: choiceScreen, state: 'chosenNext', choice: 0 } as StatusView;
  assert.throws(() => statusCard('p', 'd', 'zh', zero), /choice/);
});
