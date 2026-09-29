// The blocked-prompt relay on its own: fake herdr screens, a fake channel, and
// the daemon's receipt / inject replaced by recorders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createBlockRelay, statusDetail, BLOCK_TIMING, CHOSEN_EMOJI, IGNORED_EMOJI, type BlockTiming } from '../src/blocks.js';
import type { Binding } from '../src/bindings.js';
import type { AgentStatus } from '../src/herdr.js';
import { fill, msg, t } from '../src/texts.js';
import { createFakeChannel } from './fixtures/fake-channel.js';
import { agentEntry, createFakeHerdr } from './fixtures/fake-herdr.js';

const PANE = 'w1:p1';
const T = t('en');
const FAST: BlockTiming = { verifyAtMs: [10, 25, 50], escWaitMs: 100, escPollMs: 10 };
const sample = (name: string): string => readFileSync(join(process.cwd(), 'tests', 'fixtures', 'screens', `${name}.txt`), 'utf8');

interface Card {
  header: { title: { content: string }; template: string };
  body: { elements: Array<{ tag: string; content?: string }> };
}

function setup(opts: { cli?: 'claude' | 'kimi'; timing?: Partial<BlockTiming> } = {}) {
  /** While true, every card send is refused by Feishu. */
  const sendFails = { on: false };
  /** Runs inside every card send, before it resolves. */
  const sendHook: { fn?: () => Promise<void> } = {};
  const cli = opts.cli ?? 'claude';
  const herdr = createFakeHerdr();
  const fake = createFakeChannel({
    send: async () => {
      if (sendHook.fn) await sendHook.fn();
      if (sendFails.on) throw new Error('feishu down');
    },
  });
  const b: Binding = { root: '/p', label: 'p', chatId: 'oc_x', name: null, paneId: PANE, away: true, lang: 'en', boundAt: '', releasedAt: null };
  const receipts: string[] = [];
  const injects: string[] = [];
  const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const relay = createBlockRelay({
    herdr: herdr.deps,
    channel: fake.channel,
    binding: (root) => (root === b.root && b.away ? b : undefined),
    langOf: (x) => x.lang ?? 'en',
    receipt: async (_b, why) => {
      receipts.push(why);
    },
    inject: async (_b, text) => {
      injects.push(text);
    },
    onCardSent: () => {},
    log: (event, detail = {}) => logs.push({ event, detail }),
    timing: { ...FAST, ...opts.timing },
  });
  const agent = (status: AgentStatus) => agentEntry({ pane_id: PANE, agent: cli, agent_status: status, terminal_title_stripped: 'deploy' });
  const setStatus = (status: AgentStatus): void => {
    herdr.agents = [agent(status)];
  };
  const setScreen = (text: string | null): void => {
    if (text === null) herdr.screenFails.add(PANE);
    else {
      herdr.screenFails.delete(PANE);
      herdr.screens[PANE] = text;
    }
  };
  /** Runs `fn` right after every key press the relay makes (the terminal reacting to it). */
  const onKeys = (fn: (keys: string[]) => void): void => {
    const orig = herdr.deps.sendKeys;
    herdr.deps.sendKeys = async (paneId, keys) => {
      const r = await orig(paneId, keys);
      fn(Array.isArray(keys) ? keys : [keys]);
      return r;
    };
  };
  /** The pane is blocked on `screen` and the poll sees it. */
  const block = async (screen: string | null): Promise<void> => {
    setScreen(screen);
    setStatus('blocked');
    await relay.onPoll(b, agent('blocked'));
  };
  const sentCards = (): Array<{ id: string; card: Card }> =>
    fake.sent.flatMap((s, i) => ('input' in s ? [{ id: `om_${i + 1}`, card: (s.input as { card: Card }).card }] : []));
  const updates = (): Array<{ id: string; card: Card }> =>
    fake.sent.flatMap((s) => ('update' in s ? [{ id: s.update, card: s.card as Card }] : []));
  return { sendHook, sendFails, cli, herdr, fake, b, relay, receipts, injects, logs, agent, setStatus, setScreen, onKeys, block, sentCards, updates };
}

const noteOf = (c: Card): string => String(c.body.elements.at(-1)?.content ?? '');

// ---- opening a record from the poll ----

test('a permission prompt becoming blocked pushes one card with the prompt block and the reply hint', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  const cards = s.sentCards();
  assert.equal(cards.length, 1);
  const c = cards[0]!.card;
  assert.equal(c.header.title.content, '🔔 [p] waiting for you');
  assert.equal(c.body.elements[0]!.content, '**deploy**\npane w1:p1');
  assert.match(String(c.body.elements[1]!.content), /^```\n[\s\S]*1\. Yes/);
  assert.match(noteOf(c), new RegExp(T.statusHintReply));
  assert.equal(s.relay.has('/p'), true);
  assert.deepEqual(s.herdr.presses, []);
});

test('the poll seeing the prompt of the open card again keeps that card: no second card, no rewrite', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.sentCards().length, 1);
  assert.equal(s.updates().length, 0);
});

test('a screen that cannot be read opens an unrecognised card, and a number on it is not pressed', async () => {
  const s = setup();
  await s.block(null);
  const c = s.sentCards()[0]!.card;
  assert.match(noteOf(c), new RegExp(T.statusHintUnknown));
  assert.ok(s.logs.some((l) => l.event === 'block.unknown'));
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_h'), true);
  assert.deepEqual(s.receipts, [T.promptUnreadable]);
  assert.deepEqual(s.herdr.presses, []);
});

// ---- replies that are not pressed ----

test('open record, still blocked, a message that is not a number: receipt says to reply with a number; nothing pressed or injected', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  assert.equal(await s.relay.onMessage(s.b, 'yes please', 'om_h'), true);
  assert.deepEqual(s.receipts, [T.promptReplyNumber]);
  assert.deepEqual(s.herdr.presses, []);
  assert.deepEqual(s.injects, []);
});

test('a number the prompt does not offer: receipt names it, nothing pressed, the record stays open', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  assert.equal(await s.relay.onMessage(s.b, ' 9 ', 'om_h'), true);
  assert.deepEqual(s.receipts, [fill(T.promptNoSuchOption, { n: 9 })]);
  assert.deepEqual(s.herdr.presses, []);
  assert.equal(s.relay.has('/p'), true);
});

test('an unrecognised card answered with a number: receipt says to go to the computer, nothing pressed', async () => {
  const s = setup();
  await s.block('some output\nno prompt here\n');
  assert.equal(await s.relay.onMessage(s.b, '2', 'om_h'), true);
  assert.deepEqual(s.receipts, [T.promptUnreadable]);
  assert.deepEqual(s.herdr.presses, []);
});

test('no record: a number is not handled here, so the daemon injects it as before', async () => {
  const s = setup();
  s.setStatus('blocked');
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_h'), false);
  assert.deepEqual(s.herdr.presses, []);
  assert.deepEqual(s.receipts, []);
});

// ---- pressing ----

test('numbered prompt: 1 presses the key 1; once the pane leaves blocked the message gets DONE and the card turns green', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.onKeys(() => s.setStatus('working'));
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_h'), true);
  await s.relay.idle();
  assert.deepEqual(s.herdr.presses, [{ paneId: PANE, keys: ['1'] }]);
  assert.deepEqual(s.fake.reactions, [{ messageId: 'om_h', emoji: CHOSEN_EMOJI }]);
  const u = s.updates();
  assert.equal(u.length, 1);
  assert.equal(u[0]!.id, s.sentCards()[0]!.id);
  assert.equal(u[0]!.card.header.title.content, '✅ [p] waiting for you · Resolved · you picked 1 on the phone');
  assert.equal(u[0]!.card.header.template, 'green');
  assert.equal(s.relay.has('/p'), false);
  assert.deepEqual(s.receipts, []);
});

test('unnumbered prompt: the cursor is moved from where it is now, then enter', async () => {
  const trust = sample('claude-trust');
  const s = setup();
  await s.block(trust);
  s.onKeys(() => s.setStatus('working'));
  await s.relay.onMessage(s.b, '2', 'om_h');
  await s.relay.idle();
  assert.deepEqual(s.herdr.presses.at(-1)?.keys, ['down', 'enter']);

  // the same prompt with the cursor already on the second option
  const onSecond = trust.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust this folder', '❯ Yes, I trust this folder');
  const s2 = setup();
  await s2.block(onSecond);
  s2.onKeys(() => s2.setStatus('working'));
  await s2.relay.onMessage(s2.b, '1', 'om_h');
  await s2.relay.idle();
  assert.deepEqual(s2.herdr.presses.at(-1)?.keys, ['up', 'enter']);
});

test('multi-step prompt: still blocked on a new prompt after the key ⇒ old card says next step, a new card is pushed and becomes the record', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.onKeys(() => s.setScreen(sample('claude-write')));
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  const [first, second] = s.sentCards();
  assert.ok(second, 'a second card');
  assert.match(String(second.card.body.elements[1]!.content), /Do you want to create note\.txt\?/);
  const u = s.updates();
  assert.equal(u.length, 1);
  assert.equal(u[0]!.id, first!.id);
  assert.equal(u[0]!.card.header.title.content, '➡️ [p] waiting for you · ' + fill(T.statusChosenNext, { n: 1 }));
  assert.deepEqual(s.fake.reactions, [{ messageId: 'om_h', emoji: CHOSEN_EMOJI }], 'the pick took effect');
  assert.equal(s.relay.has('/p'), true);
  // the record now belongs to the new card: resolving at the terminal rewrites that one
  s.setStatus('working');
  await s.relay.onPoll(s.b, s.agent('working'));
  assert.equal(s.updates().at(-1)!.id, second.id);
  assert.match(s.updates().at(-1)!.card.header.title.content, new RegExp(T.statusTerminal));
});

test('a claude question is cancelled with esc, no card; once the pane leaves blocked the agent is told to re-ask with ask', async () => {
  const s = setup();
  s.onKeys((keys) => {
    if (keys.includes('esc')) s.setStatus('done');
  });
  await s.block(sample('claude-ask-single'));
  await s.relay.idle();
  assert.deepEqual(s.herdr.presses, [{ paneId: PANE, keys: ['esc'] }]);
  assert.equal(s.sentCards().length, 0);
  assert.deepEqual(s.injects, [msg.promptRedirect]);
  assert.equal(s.relay.has('/p'), false);
  assert.ok(s.logs.some((l) => l.event === 'block.redirected'));
});

test('a kimi question: esc, then the redirect only after the pane has left blocked (working counts)', async () => {
  const s = setup({ cli: 'kimi' });
  let polls = 0;
  const list = s.herdr.deps.agentList;
  s.herdr.deps.agentList = async () => {
    polls += 1;
    return list();
  };
  s.onKeys(() => {
    // still blocked for the first checks, then working
    setTimeout(() => s.setStatus('working'), 30);
  });
  await s.block(sample('kimi-question'));
  await s.relay.idle();
  assert.deepEqual(s.herdr.presses, [{ paneId: PANE, keys: ['esc'] }]);
  assert.deepEqual(s.injects, [msg.promptRedirect]);
  assert.ok(polls >= 2, `checked the state more than once (${polls})`);
  assert.equal(s.sentCards().length, 0);
});

test('esc does nothing for the whole wait: falls back to pushing a card, which cannot be answered by number', async () => {
  const s = setup();
  await s.block(sample('claude-ask-single'));
  await s.relay.idle();
  assert.deepEqual(s.herdr.presses, [{ paneId: PANE, keys: ['esc'] }]);
  assert.deepEqual(s.injects, []);
  const cards = s.sentCards();
  assert.equal(cards.length, 1);
  assert.match(noteOf(cards[0]!.card), new RegExp(T.statusHintUnknown));
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_h'), true);
  assert.deepEqual(s.receipts, [T.promptUnreadable]);
  assert.deepEqual(s.herdr.presses.length, 1);
});

test('the prompt changed before the key: nothing pressed, old card goes stale, a card for the new prompt, the message gets the ignored reaction', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setScreen(sample('claude-write'));
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_h'), true);
  await s.relay.idle();
  assert.deepEqual(s.herdr.presses, []);
  const [first, second] = s.sentCards();
  assert.ok(second);
  assert.equal(s.updates()[0]!.id, first!.id);
  assert.match(s.updates()[0]!.card.header.title.content, new RegExp(T.statusStale));
  assert.deepEqual(s.fake.reactions, [{ messageId: 'om_h', emoji: IGNORED_EMOJI }]);
  assert.equal(s.relay.has('/p'), true);
});

test('the prompt changed into a question before the key: old card goes stale and the question is redirected instead of carded', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setScreen(sample('claude-ask-single'));
  s.onKeys((keys) => {
    if (keys.includes('esc')) s.setStatus('done');
  });
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  assert.deepEqual(s.herdr.presses, [{ paneId: PANE, keys: ['esc'] }]);
  assert.equal(s.sentCards().length, 1);
  assert.match(s.updates()[0]!.card.header.title.content, new RegExp(T.statusStale));
  assert.deepEqual(s.injects, [msg.promptRedirect]);
  assert.equal(s.relay.has('/p'), false);
});

test('a number after the terminal already resolved it: nothing pressed or injected, ignored reaction, card says handled at the terminal', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setStatus('idle');
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_h'), true);
  assert.deepEqual(s.herdr.presses, []);
  assert.deepEqual(s.injects, []);
  assert.deepEqual(s.fake.reactions, [{ messageId: 'om_h', emoji: IGNORED_EMOJI }]);
  assert.match(s.updates()[0]!.card.header.title.content, new RegExp(T.statusTerminal));
  assert.equal(s.relay.has('/p'), false);
});

test('a text message after the terminal already resolved it closes the card and is left to the daemon to inject', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setStatus('working');
  assert.equal(await s.relay.onMessage(s.b, 'carry on', 'om_h'), false);
  assert.match(s.updates()[0]!.card.header.title.content, new RegExp(T.statusTerminal));
  assert.deepEqual(s.fake.reactions, []);
});

test('resolved at the computer: the poll rewrites the card as handled at the terminal and sends nothing new', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setStatus('working');
  await s.relay.onPoll(s.b, s.agent('working'));
  assert.equal(s.sentCards().length, 1);
  assert.equal(s.updates().length, 1);
  assert.match(s.updates()[0]!.card.header.title.content, new RegExp(T.statusTerminal));
  assert.equal(s.relay.has('/p'), false);
  assert.ok(s.logs.some((l) => l.event === 'block.closed' && l.detail.how === 'terminal'));
});

test('while a reply is being pressed and checked, the poll seeing the pane leave blocked leaves the card to the reply', async () => {
  const s = setup({ timing: { verifyAtMs: [60, 80, 100] } });
  await s.block(sample('claude-bash'));
  s.onKeys(() => s.setStatus('working'));
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.onPoll(s.b, s.agent('working'));
  assert.equal(s.updates().length, 0, 'the poll did not rewrite the card');
  await s.relay.idle();
  assert.equal(s.updates().length, 1);
  assert.match(s.updates()[0]!.card.header.title.content, /you picked 1/);
});

test('a second number while the first is still being checked: receipt says to wait, no second key', async () => {
  const s = setup({ timing: { verifyAtMs: [60, 80, 100] } });
  await s.block(sample('claude-bash'));
  await s.relay.onMessage(s.b, '1', 'om_1');
  assert.equal(await s.relay.onMessage(s.b, '2', 'om_2'), true);
  assert.deepEqual(s.receipts, [T.promptBusy]);
  assert.equal(s.herdr.presses.length, 1);
  await s.relay.idle();
});

test('herdr refuses the keys: receipt carries its code, and the next number is tried again (not busy)', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.herdr.keysOutcome = { ok: false, code: 'pane_not_found', message: 'gone' };
  await s.relay.onMessage(s.b, '1', 'om_1');
  assert.deepEqual(s.receipts, [fill(T.promptKeysRefused, { why: 'pane_not_found gone' })]);
  await s.relay.onMessage(s.b, '1', 'om_2');
  assert.equal(s.herdr.presses.length, 2);
  assert.ok(!s.receipts.includes(T.promptBusy));
});

test('the key changes nothing through every check: receipt says it had no effect, the record stays open and takes the next number', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  await s.relay.onMessage(s.b, '1', 'om_1');
  await s.relay.idle();
  assert.deepEqual(s.receipts, [T.promptKeysIgnored]);
  assert.equal(s.relay.has('/p'), true);
  assert.equal(s.updates().length, 0);
  assert.deepEqual(s.fake.reactions, []);
  await s.relay.onMessage(s.b, '1', 'om_2');
  assert.equal(s.herdr.presses.length, 2);
  await s.relay.idle();
});

test('the pane left blocked after a phone pick and blocked again before the poll noticed: the poll still pushes the new prompt', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.onKeys(() => s.setStatus('working'));
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  // the poll last saw blocked (before the key); it never saw the working in between
  s.setScreen(sample('claude-write'));
  s.setStatus('blocked');
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.sentCards().length, 2);
  assert.match(String(s.sentCards()[1]!.card.body.elements[1]!.content), /create note\.txt/);
  // and only once
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.sentCards().length, 2);
});

test('the same after a redirected question: a prompt that follows before the poll noticed still gets its card', async () => {
  const s = setup();
  s.onKeys((keys) => {
    if (keys.includes('esc')) s.setStatus('done');
  });
  await s.block(sample('claude-ask-single'));
  await s.relay.idle();
  s.setScreen(sample('claude-bash'));
  s.setStatus('blocked');
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.sentCards().length, 1);
});

test('a pane already blocked when first seen gets one card (a trust prompt at start-up, remote mode switched on mid-prompt)', async () => {
  const s = setup();
  s.setScreen(sample('claude-trust'));
  s.setStatus('blocked');
  await s.relay.onPoll(s.b, s.agent('blocked'));
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.sentCards().length, 1);
  assert.equal(s.relay.has('/p'), true);
});

test('the prompt changes under an open card while nobody replies: the poll marks the old card stale and pushes the new prompt', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setScreen(sample('claude-write'));
  await s.relay.onPoll(s.b, s.agent('blocked'));
  const cards = s.sentCards();
  assert.equal(cards.length, 2);
  assert.match(String(cards[1]!.card.body.elements[1]!.content), /create note\.txt/);
  assert.equal(s.updates().length, 1);
  assert.equal(s.updates()[0]!.id, cards[0]!.id);
  assert.match(s.updates()[0]!.card.header.title.content, new RegExp(T.statusStale));
  // the record moved to the new card
  s.setStatus('working');
  await s.relay.onPoll(s.b, s.agent('working'));
  assert.equal(s.updates().at(-1)!.id, cards[1]!.id);
});

test('with a card open, a screen that cannot be read or parsed decides nothing', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setScreen(null);
  await s.relay.onPoll(s.b, s.agent('blocked'));
  s.setScreen('redrawing…\n');
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.sentCards().length, 1);
  assert.equal(s.updates().length, 0);
  assert.equal(s.relay.has('/p'), true);
});

test('two polls running over each other on a new prompt push one card', async () => {
  const s = setup();
  s.setScreen(sample('claude-bash'));
  s.setStatus('blocked');
  await Promise.all([s.relay.onPoll(s.b, s.agent('blocked')), s.relay.onPoll(s.b, s.agent('blocked'))]);
  assert.equal(s.sentCards().length, 1);
});

test('a question seen by several polls is cancelled once: one esc, one redirect', async () => {
  const s = setup();
  s.setScreen(sample('claude-ask-single'));
  s.setStatus('blocked');
  let escs = 0;
  s.onKeys((keys) => {
    if (keys.includes('esc')) escs += 1;
    // esc takes a while
    if (keys.includes('esc')) setTimeout(() => s.setStatus('done'), 30);
  });
  await Promise.all([s.relay.onPoll(s.b, s.agent('blocked')), s.relay.onPoll(s.b, s.agent('blocked'))]);
  await s.relay.onPoll(s.b, s.agent('blocked'));
  await s.relay.idle();
  assert.equal(escs, 1);
  assert.deepEqual(s.injects, [msg.promptRedirect]);
});

test('after esc was ignored and the question went out as a card, later polls leave it be (no second esc)', async () => {
  const s = setup();
  await s.block(sample('claude-ask-single'));
  await s.relay.idle();
  assert.equal(s.sentCards().length, 1);
  await s.relay.onPoll(s.b, s.agent('blocked'));
  await s.relay.idle();
  assert.equal(s.herdr.presses.length, 1);
  assert.equal(s.sentCards().length, 1);
  assert.equal(s.updates().length, 0);
});

test('a poll landing while the next prompt card of a phone pick is being sent does not push it a second time', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  let polled = false;
  s.onKeys(() => s.setScreen(sample('claude-write')));
  s.sendHook.fn = async () => {
    if (polled) return;
    polled = true;
    await s.relay.onPoll(s.b, s.agent('blocked'));
  };
  s.setStatus('blocked');
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  assert.ok(polled);
  assert.equal(s.sentCards().length, 2);
});

test('a poll landing while the card for a changed prompt is being sent (reply path) does not push it a second time', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setScreen(sample('claude-write'));
  let polled = false;
  s.sendHook.fn = async () => {
    if (polled) return;
    polled = true;
    await s.relay.onPoll(s.b, s.agent('blocked'));
  };
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  assert.ok(polled);
  assert.equal(s.sentCards().length, 2);
});

test('herdr lists no agents at all after the key: no conclusion from that, so no DONE and no picked card; ends as keys had no effect', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.onKeys(() => {
    s.herdr.agents = [];
  });
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  assert.deepEqual(s.fake.reactions, []);
  assert.equal(s.updates().length, 0);
  assert.deepEqual(s.receipts, [T.promptKeysIgnored]);
  assert.equal(s.relay.has('/p'), true);
});

test('herdr lists other panes but not this one after the key: the agent left the prompt, so it counts as picked', async () => {
  const s = setup();
  await s.block(sample('claude-trust'));
  s.onKeys(() => {
    s.herdr.agents = [agentEntry({ pane_id: 'w9:p9', agent: 'claude', agent_status: 'idle' })];
  });
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  assert.deepEqual(s.fake.reactions, [{ messageId: 'om_h', emoji: CHOSEN_EMOJI }]);
  assert.match(s.updates()[0]!.card.header.title.content, /you picked 1/);
});

test('the screen cannot be read right before the key: nothing pressed, card and record untouched, a receipt asks to reply again; after that it works', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setScreen(null);
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_1'), true);
  assert.deepEqual(s.herdr.presses, []);
  assert.equal(s.updates().length, 0);
  assert.equal(s.sentCards().length, 1);
  assert.deepEqual(s.fake.reactions, []);
  assert.deepEqual(s.receipts, [T.promptScreenUnreadable]);
  assert.equal(s.relay.has('/p'), true);
  s.setScreen(sample('claude-bash'));
  s.onKeys(() => s.setStatus('working'));
  await s.relay.onMessage(s.b, '1', 'om_2');
  await s.relay.idle();
  assert.deepEqual(s.herdr.presses, [{ paneId: PANE, keys: ['1'] }]);
});

test('multi-step, but the card for the next prompt cannot be sent: the old card does not point at a new card, and the next poll pushes one', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.onKeys(() => {
    s.setScreen(sample('claude-write'));
    s.sendFails.on = true;
  });
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  assert.ok(!s.updates().some((u) => u.card.header.title.content.includes(fill(T.statusChosenNext, { n: 1 }))), 'no next-step rewrite');
  assert.deepEqual(s.fake.reactions, [{ messageId: 'om_h', emoji: CHOSEN_EMOJI }]);
  s.sendFails.on = false;
  const before = s.sentCards().length;
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.sentCards().length, before + 1);
  assert.match(String(s.sentCards().at(-1)!.card.body.elements[1]!.content), /create note\.txt/);
  assert.equal(s.relay.has('/p'), true);
});

test('prompt changed before the key, but the card for the new prompt cannot be sent: the old card is not marked stale, and the next poll pushes one', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setScreen(sample('claude-write'));
  s.sendFails.on = true;
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_h'), true);
  assert.deepEqual(s.herdr.presses, []);
  assert.ok(!s.updates().some((u) => new RegExp(T.statusStale).test(u.card.header.title.content)), 'no stale rewrite');
  assert.deepEqual(s.fake.reactions, [{ messageId: 'om_h', emoji: IGNORED_EMOJI }]);
  s.sendFails.on = false;
  const before = s.sentCards().length;
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.sentCards().length, before + 1);
  assert.match(String(s.sentCards().at(-1)!.card.body.elements[1]!.content), /create note\.txt/);
});

test('after the key the pane is still blocked on a screen that cannot be parsed, then leaves blocked: that screen decided nothing, the outcome is picked', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.onKeys(() => {
    // caught mid-redraw at the first look; the agent is done by the last one
    s.setScreen('redrawing…\n');
    setTimeout(() => s.setStatus('working'), 35);
  });
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  assert.deepEqual(s.fake.reactions, [{ messageId: 'om_h', emoji: CHOSEN_EMOJI }]);
  assert.equal(s.sentCards().length, 1, 'no extra card');
  assert.equal(s.updates().length, 1);
  assert.match(s.updates()[0]!.card.header.title.content, /you picked 1/);
  assert.equal(s.relay.has('/p'), false);
});

test('a reply landing while the poll is sending the card for a changed prompt waits: it gets the please-wait receipt and pushes nothing', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setScreen(sample('claude-write'));
  let replied: boolean | undefined;
  s.sendHook.fn = async () => {
    if (replied !== undefined) return;
    replied = await s.relay.onMessage(s.b, '1', 'om_h');
  };
  await s.relay.onPoll(s.b, s.agent('blocked'));
  await s.relay.idle();
  assert.equal(replied, true);
  assert.deepEqual(s.receipts, [T.promptBusy]);
  assert.equal(s.sentCards().length, 2);
  assert.deepEqual(s.herdr.presses, []);
});

// ---- dropping ----

test('remote mode switched off while the card for a new prompt is being sent: no record, the card is rewritten closed, a later number is not taken', async () => {
  const s = setup();
  s.setScreen(sample('claude-bash'));
  s.setStatus('blocked');
  s.sendHook.fn = async () => {
    s.sendHook.fn = undefined;
    s.b.away = false;
    await s.relay.drop(s.b);
  };
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.relay.has('/p'), false);
  const sent = s.sentCards();
  assert.equal(sent.length, 1);
  const u = s.updates();
  assert.equal(u.length, 1);
  assert.equal(u[0]!.id, sent[0]!.id);
  assert.match(u[0]!.card.header.title.content, new RegExp(T.statusClosed));
  s.b.away = true;
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_h'), false);
  assert.deepEqual(s.fake.reactions, []);
});

test('remote mode switched off while the card for a changed prompt is being sent: both cards end closed, no record left', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.setScreen(sample('claude-write'));
  s.sendHook.fn = async () => {
    s.sendHook.fn = undefined;
    s.b.away = false;
    await s.relay.drop(s.b);
  };
  await s.relay.onPoll(s.b, s.agent('blocked'));
  assert.equal(s.relay.has('/p'), false);
  const first = s.sentCards()[0]!;
  assert.equal(s.sentCards().length, 2);
  const closedIds = s.updates().filter((u) => new RegExp(T.statusClosed).test(u.card.header.title.content)).map((u) => u.id);
  // the old card (closed by the drop) and the new one (closed once its send returned)
  assert.equal(closedIds.length, 2);
  assert.ok(closedIds.includes(first.id));
  assert.equal(new Set(closedIds).size, 2);
  assert.ok(!s.updates().some((u) => new RegExp(T.statusStale).test(u.card.header.title.content)), 'the old card is not also marked stale');
});

test('remote mode switched off while the fallback card of an ignored esc is being sent: no record, that card is rewritten closed', async () => {
  const s = setup();
  await s.block(sample('claude-ask-single'));
  s.sendHook.fn = async () => {
    s.sendHook.fn = undefined;
    s.b.away = false;
    await s.relay.drop(s.b);
  };
  await s.relay.idle();
  assert.equal(s.relay.has('/p'), false);
  const sent = s.sentCards();
  assert.equal(sent.length, 1);
  assert.equal(s.updates().length, 1);
  assert.equal(s.updates()[0]!.id, sent[0]!.id);
  assert.match(s.updates()[0]!.card.header.title.content, new RegExp(T.statusClosed));
});

test('remote mode switched off: the record is dropped and the card says remote mode closed; a later number is not handled', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.b.away = false;
  await s.relay.drop(s.b);
  assert.equal(s.relay.has('/p'), false);
  assert.match(s.updates()[0]!.card.header.title.content, new RegExp(T.statusClosed));
  assert.equal(await s.relay.onMessage(s.b, '1', 'om_h'), false);
});

test('dropped while a reply is being checked: the check stops without touching the card or the message', async () => {
  const s = setup({ timing: { verifyAtMs: [40, 60, 80] } });
  await s.block(sample('claude-bash'));
  s.onKeys(() => s.setStatus('working'));
  await s.relay.onMessage(s.b, '1', 'om_h');
  s.b.away = false;
  await s.relay.drop(s.b);
  await s.relay.idle();
  assert.equal(s.updates().length, 1);
  assert.match(s.updates()[0]!.card.header.title.content, new RegExp(T.statusClosed));
  assert.deepEqual(s.fake.reactions, []);
});

test('stopped while waiting on esc: nothing is injected or carded afterwards', async () => {
  const s = setup({ timing: { escWaitMs: 200, escPollMs: 20 } });
  await s.block(sample('claude-ask-single'));
  s.relay.stop();
  s.setStatus('done');
  await s.relay.idle();
  assert.deepEqual(s.injects, []);
  assert.equal(s.sentCards().length, 0);
});

// ---- misc ----

test('the log names every step: opened, keys, verify, closed', async () => {
  const s = setup();
  await s.block(sample('claude-bash'));
  s.onKeys(() => s.setStatus('idle'));
  await s.relay.onMessage(s.b, '1', 'om_h');
  await s.relay.idle();
  const names = s.logs.map((l) => l.event);
  for (const n of ['block.opened', 'block.keys', 'block.verify', 'block.closed']) assert.ok(names.includes(n), n);
});

test('default timing is the documented one: checks at 1 s, 2.5 s and 5 s; esc waits up to 20 s, looking every second', () => {
  assert.deepEqual(BLOCK_TIMING, { verifyAtMs: [1000, 2500, 5000], escWaitMs: 20_000, escPollMs: 1000 });
});

test('the card detail is the terminal title in bold over the pane line, in the project language', () => {
  assert.equal(statusDetail(agentEntry({ pane_id: 'w1:p1', terminal_title_stripped: 'deploy' }), 'zh'), '**deploy**\n窗格 w1:p1');
  assert.equal(statusDetail(agentEntry({ pane_id: 'w1:p1' }), 'en'), 'pane w1:p1');
});
