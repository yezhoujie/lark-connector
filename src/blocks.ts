// What the daemon does while an agent in an away project's pane is stuck on a
// prompt only a human can answer. Each project has at most one open record of
// such a prompt, kept in memory only: the "waiting for you" card pushed for it
// and what the screen showed then.
//
// - A question the agent asks (its own question form) is cancelled with Esc
//   and the agent is told to ask again through `ask`, so the question arrives
//   as a proper question card instead.
// - Any other prompt (a permission, a trust check, or one that cannot be told
//   apart) is pushed as a card showing the prompt. A bare number sent back in
//   the group is pressed as that option, after checking the screen still shows
//   the same prompt; the outcome is then checked a few times and the card is
//   rewritten to say how the prompt ended.
//
// Every herdr / Feishu effect goes through the injected deps, so the flow can
// be driven with fakes and millisecond timings.
import type { LarkChannel } from '@larksuite/channel';
import type { Binding } from './bindings.js';
import { statusCard, type StatusView } from './cards.js';
import type { AgentInfo, AgentStatus, agentList, readScreen, sendKeys } from './herdr.js';
import { parseScreen, type ParsedScreen, type ScreenCli } from './screen.js';
import { fill, msg, t } from './texts.js';
import type { Lang } from './validate.js';

/** Put on a phone number whose key was pressed and took effect. */
export const CHOSEN_EMOJI = 'DONE';
/** Put on a phone number that was not pressed: the prompt had already ended or changed. */
export const IGNORED_EMOJI = 'SILENT';

export interface BlockTiming {
  /** After a key, when the pane is looked at again (ms from the key); the first conclusive look ends the check. */
  verifyAtMs: number[];
  /** How long after Esc on a question the pane may stay blocked before the question is pushed as a card instead. */
  escWaitMs: number;
  /** How often the pane is looked at while waiting for Esc to take. */
  escPollMs: number;
}
export const BLOCK_TIMING: BlockTiming = { verifyAtMs: [1000, 2500, 5000], escWaitMs: 20_000, escPollMs: 1000 };

export interface BlockRelayDeps {
  herdr: { agentList: typeof agentList; readScreen: typeof readScreen; sendKeys: typeof sendKeys };
  channel: Pick<LarkChannel, 'send' | 'updateCard' | 'addReaction'>;
  /** The project's live binding while remote mode is on for it; anything else ends a flow in progress. */
  binding: (root: string) => Binding | undefined;
  langOf: (b: Binding) => Lang;
  /** A "not delivered" card in the project's group saying why. */
  receipt: (b: Binding, why: string) => Promise<void>;
  /** The daemon's ordinary delivery of a line into the project's pane. */
  inject: (b: Binding, text: string) => Promise<void>;
  /** A card this relay sent, so a phone message quoting it can name it. */
  onCardSent: (messageId: string, title: string) => void;
  log: (event: string, detail?: Record<string, unknown>) => void;
  timing?: Partial<BlockTiming>;
}

export interface BlockRelay {
  /**
   * The poll saw `agent` (the pane of an away project with no question
   * pending). A blocked pane with no card out for the prompt it shows gets
   * one (a question is redirected instead); a card whose prompt ended at the
   * terminal is closed, one whose prompt changed goes stale.
   */
  onPoll(b: Binding, agent: AgentInfo): Promise<void>;
  /**
   * A phone message for the project. True when it was dealt with here (a
   * number pressed, a receipt sent, a reaction put on it) and must not also
   * be injected; false when the daemon should deliver it as usual.
   */
  onMessage(b: Binding, text: string, messageId: string): Promise<boolean>;
  /** Remote mode ended for the project (or its group changed): forget the record and say so on its card. */
  drop(b: Binding): Promise<void>;
  /** Whether the project has an open record. */
  has(root: string): boolean;
  /** The daemon is going down: every flow in progress stops where it is; cards are left as they are. */
  stop(): void;
  /** Resolves once no flow is running in the background. */
  idle(): Promise<void>;
}

/** The agents whose screens can be read; any other agent keeps the plain card. */
export function isRelayed(agent: AgentInfo): agent is AgentInfo & { agent: ScreenCli } {
  return agent.agent === 'claude' || agent.agent === 'kimi';
}

/** The top of a "waiting for you" card: the terminal title in bold, when there is one, over the pane. */
export function statusDetail(agent: AgentInfo, lang: Lang): string {
  return (agent.terminal_title_stripped ? `**${agent.terminal_title_stripped}**\n` : '') + fill(t(lang).statusPane, { pane: agent.pane_id });
}

interface BlockRecord {
  root: string;
  chatId: string;
  paneId: string;
  cli: ScreenCli;
  cardId: string;
  /** The card's top lines, kept so every rewrite shows the same header. */
  detail: string;
  screen: ParsedScreen;
  raw: string;
  /** False for a prompt whose options could not be read: numbers are not pressed. */
  replyable: boolean;
  /** A phone reply is being pressed or checked; the poll leaves the record alone meanwhile. */
  busy: boolean;
}

/** How a record's prompt ended; the two picked outcomes carry the number picked. */
type Outcome = { how: 'chosen' | 'chosenNext'; choice: number } | { how: 'terminal' | 'stale' | 'closed' };

const UNKNOWN_LOG_LINES = 5;
const UNKNOWN_LOG_WIDTH = 120;

/** Anything herdr positively reports as not waiting on a prompt; `unknown` says nothing either way. */
const settled = (s: AgentStatus): boolean => s === 'idle' || s === 'working' || s === 'done';

export function createBlockRelay(deps: BlockRelayDeps): BlockRelay {
  const timing: BlockTiming = { ...BLOCK_TIMING, ...deps.timing };
  const { herdr, channel, log } = deps;
  const records = new Map<string, BlockRecord>();
  /** Projects whose question was just cancelled with Esc and whose redirect is not done yet, each with the token of that redirect. */
  const redirecting = new Map<string, object>();
  /** Projects a poll is working on right now; a poll running over it leaves the project alone. */
  const polling = new Set<string>();
  /** Bumped when a project's record is dropped; a background flow started under an older value stops. */
  const epochs = new Map<string, number>();
  const flows = new Set<Promise<void>>();
  const sleeps = new Set<{ timer: NodeJS.Timeout; wake: () => void }>();
  let stopped = false;

  const epochOf = (root: string): number => epochs.get(root) ?? 0;
  /** Whether a flow started at `epoch` may still act: not stopped, not dropped, remote mode still on in the same group. */
  const alive = (root: string, epoch: number, chatId: string): Binding | undefined => {
    if (stopped || epochOf(root) !== epoch) return undefined;
    const b = deps.binding(root);
    return b && b.away && b.chatId === chatId ? b : undefined;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      const entry = {
        timer: setTimeout(() => {
          sleeps.delete(entry);
          resolve();
        }, Math.max(0, ms)),
        wake: resolve,
      };
      sleeps.add(entry);
    });

  const background = (name: string, fn: () => Promise<void>): void => {
    const p = fn()
      .catch((err) => log(`${name}.failed`, { err: String(err).slice(0, 200) }))
      .finally(() => flows.delete(p));
    flows.add(p);
  };

  const paneState = async (paneId: string): Promise<AgentInfo | undefined> => (await herdr.agentList()).find((a) => a.pane_id === paneId);

  const react = async (messageId: string, emoji: string): Promise<void> => {
    try {
      await channel.addReaction(messageId, emoji);
    } catch (err) {
      log('reaction.failed', { messageId, err: String(err).slice(0, 200) });
    }
  };

  /** Rewrite the record's card to say how its prompt ended. Never throws: a lost rewrite is logged and the flow goes on. */
  const rewrite = async (b: Binding, rec: BlockRecord, outcome: Outcome): Promise<void> => {
    const base = { screen: rec.screen, raw: rec.raw };
    const view: StatusView = outcome.how === 'chosen' || outcome.how === 'chosenNext' ? { ...base, state: outcome.how, choice: outcome.choice } : { ...base, state: outcome.how };
    const how = outcome.how;
    let ok = true;
    try {
      await channel.updateCard(rec.cardId, statusCard(b.label, rec.detail, deps.langOf(b), view));
    } catch (err) {
      ok = false;
      log('status.failed', { root: rec.root, cardId: rec.cardId, err: String(err).slice(0, 200) });
    }
    log('block.closed', { root: rec.root, paneId: rec.paneId, cardId: rec.cardId, how, ok });
  };

  /** Take the record off the books (only if it is still the project's record) and rewrite its card. */
  const close = async (b: Binding, rec: BlockRecord, outcome: Outcome): Promise<void> => {
    if (records.get(rec.root) === rec) records.delete(rec.root);
    await rewrite(b, rec, outcome);
  };

  /**
   * Push a "waiting for you" card for what the pane shows and open a record
   * for it. False when Feishu did not take the card: no record is opened, so
   * the next poll that finds the pane still blocked tries again.
   */
  const pushCard = async (b: Binding, epoch: number, agent: AgentInfo & { agent: ScreenCli }, raw: string, screen: ParsedScreen, replyable: boolean): Promise<boolean> => {
    const lang = deps.langOf(b);
    const detail = statusDetail(agent, lang);
    let cardId: string;
    try {
      const sent = await channel.send(b.chatId, { card: statusCard(b.label, detail, lang, { screen, raw }) });
      cardId = sent.messageId;
    } catch (err) {
      log('status.failed', { root: b.root, err: String(err).slice(0, 200) });
      return false;
    }
    deps.onCardSent(cardId, t(lang).statusBlocked);
    const rec: BlockRecord = { root: b.root, chatId: b.chatId, paneId: agent.pane_id, cli: agent.agent, cardId, detail, screen, raw, replyable, busy: false };
    // Remote mode may have ended (or the group changed) while the card was on
    // its way: nothing is left to answer it, so it is closed on the spot
    // rather than left waiting forever with a record nobody will clear.
    if (!alive(b.root, epoch, b.chatId)) {
      log('block.opened', { root: b.root, paneId: agent.pane_id, cardId, dropped: true });
      await rewrite(b, rec, { how: 'closed' });
      return false;
    }
    records.set(b.root, rec);
    log('block.opened', { root: b.root, paneId: agent.pane_id, cli: agent.agent, kind: screen.kind, numbered: screen.numbered, options: screen.options.length, cardId, replyable });
    if (screen.kind === 'unknown') {
      const tail = raw
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim() !== '')
        .slice(-UNKNOWN_LOG_LINES)
        .map((l) => [...l].slice(0, UNKNOWN_LOG_WIDTH).join(''));
      log('block.unknown', { root: b.root, paneId: agent.pane_id, cli: agent.agent, readable: raw !== '', tail });
    }
    return true;
  };

  /**
   * The pane is on a prompt nobody has a record for (just turned blocked, or
   * the prompt behind an open record changed): a question is redirected, any
   * other prompt is pushed as a card. False only when that card could not be sent.
   */
  const present = async (b: Binding, epoch: number, agent: AgentInfo & { agent: ScreenCli }, raw: string, screen: ParsedScreen): Promise<boolean> => {
    if (screen.kind === 'question') {
      startRedirect(b, agent);
      return true;
    }
    return pushCard(b, epoch, agent, raw, screen, screen.kind === 'choice');
  };

  /**
   * The prompt behind an open record gave way to another one: present the new
   * one first, and only once that went out rewrite the old card (`old` says
   * how). The old record stays in place, busy, until the new one takes its
   * place, so neither a poll nor a reply can act on the gap. When the new card
   * could not be sent the old card is left as it is and the record is gone, so
   * the next poll presents the prompt again.
   */
  const replace = async (
    b: Binding,
    epoch: number,
    rec: BlockRecord,
    agent: AgentInfo & { agent: ScreenCli },
    seen: { raw: string; screen: ParsedScreen },
    old: Outcome,
  ): Promise<void> => {
    rec.busy = true;
    let ok = false;
    try {
      ok = await present(b, epoch, agent, seen.raw, seen.screen);
    } finally {
      if (records.get(rec.root) === rec) records.delete(rec.root);
      rec.busy = false;
    }
    // Dropped meanwhile: the drop already closed the old card.
    if (ok && alive(b.root, epoch, b.chatId)) await rewrite(b, rec, old);
  };

  /** Read and parse the pane's screen; a failed read is an unrecognised screen. */
  const look = async (paneId: string, cli: ScreenCli): Promise<{ raw: string; screen: ParsedScreen; readable: boolean }> => {
    const text = await herdr.readScreen(paneId);
    return { raw: text ?? '', screen: parseScreen(text ?? '', cli), readable: text !== null };
  };

  /**
   * Cancel the question with Esc, wait for the pane to leave blocked, then
   * tell the agent to ask again through `ask`. When Esc never takes, the
   * prompt is pushed as a card after all — one that says to go to the
   * computer, since pressing numbers on a question form is not done.
   */
  const startRedirect = (b: Binding, agent: AgentInfo & { agent: ScreenCli }): void => {
    const { root, chatId } = b;
    const epoch = epochOf(root);
    const token = {};
    redirecting.set(root, token);
    /** The pane has left blocked: tell the agent to ask again. False while it is still blocked (or herdr says nothing). */
    const redirectIfSettled = async (): Promise<boolean> => {
      const a = await paneState(agent.pane_id);
      if (!a || !settled(a.agent_status)) return false;
      const live = alive(root, epoch, chatId);
      if (!live) return true;
      log('block.redirected', { root, paneId: agent.pane_id, cli: agent.agent, outcome: 'asked', status: a.agent_status });
      await deps.inject(live, msg.promptRedirect);
      return true;
    };
    background('block.redirect', async () => {
      try {
        const esc = await herdr.sendKeys(agent.pane_id, ['esc']);
        log('block.keys', { root, paneId: agent.pane_id, keys: ['esc'], ok: esc.ok, code: esc.code });
        if (esc.ok) {
          const deadline = Date.now() + timing.escWaitMs;
          while (Date.now() < deadline) {
            await sleep(Math.min(timing.escPollMs, Math.max(0, deadline - Date.now())));
            if (!alive(root, epoch, chatId)) return;
            if (await redirectIfSettled()) return;
          }
        }
        if (!alive(root, epoch, chatId)) return;
        // One last look: the pane may have left blocked right at the deadline.
        if (esc.ok && (await redirectIfSettled())) return;
        const live = alive(root, epoch, chatId);
        if (!live) return;
        const now = (await paneState(agent.pane_id)) ?? agent;
        const seen = await look(agent.pane_id, agent.agent);
        if (!alive(root, epoch, chatId)) return;
        log('block.redirected', { root, paneId: agent.pane_id, cli: agent.agent, outcome: esc.ok ? 'esc-ignored' : 'esc-refused' });
        const screen = seen.screen.kind === 'question' ? { ...seen.screen, kind: 'unknown' as const } : seen.screen;
        await pushCard(live, epoch, { ...now, agent: agent.agent }, seen.raw, screen, screen.kind === 'choice');
      } finally {
        // A later redirect for the same project (after a drop and a new block) keeps its own mark.
        if (redirecting.get(root) === token) redirecting.delete(root);
      }
    });
  };

  /** The keys that pick option `n` on `screen`: its number, or arrows from where the cursor is now and enter. */
  const keysFor = (screen: ParsedScreen, n: number): string[] => {
    if (screen.numbered) return [String(n)];
    const at = screen.options.find((o) => o.cursor)?.n ?? 1;
    const d = n - at;
    return [...Array<string>(Math.abs(d)).fill(d > 0 ? 'down' : 'up'), 'enter'];
  };

  /** Look at the pane after the key until it shows what the key did, then close or hand over the record. */
  const verify = async (rec: BlockRecord, n: number, messageId: string, epoch: number): Promise<void> => {
    const { root, chatId, paneId } = rec;
    const start = Date.now();
    const last = timing.verifyAtMs.length - 1;
    for (const [i, at] of timing.verifyAtMs.entries()) {
      await sleep(start + at - Date.now());
      if (!alive(root, epoch, chatId) || records.get(root) !== rec) return;
      const listed = await herdr.agentList();
      // An empty list is what a failed herdr call looks like: nothing learned from this look.
      if (listed.length === 0) continue;
      const a = listed.find((x) => x.pane_id === paneId);
      // A pane missing from a list herdr did answer has lost its agent: it left the prompt too (a trust prompt's "exit" ends the agent).
      if (!a || settled(a.agent_status)) {
        const live = alive(root, epoch, chatId);
        if (!live || records.get(root) !== rec) return;
        log('block.verify', { root, paneId, at, outcome: 'resolved', status: a?.agent_status ?? 'gone' });
        records.delete(root);
        await react(messageId, CHOSEN_EMOJI);
        await rewrite(live, rec, { how: 'chosen', choice: n });
        return;
      }
      if (a.agent_status !== 'blocked') continue;
      const seen = await look(paneId, rec.cli);
      // Nothing read is nothing learned; the next look may do better.
      if (!seen.readable) continue;
      if (seen.screen.fingerprint === rec.screen.fingerprint) continue;
      // A screen with no recognisable prompt while herdr still says blocked is
      // usually one caught mid-redraw: only the last look may conclude from it.
      if (seen.screen.kind === 'unknown' && i < last) continue;
      const live = alive(root, epoch, chatId);
      if (!live || records.get(root) !== rec) return;
      log('block.verify', { root, paneId, at, outcome: 'next', kind: seen.screen.kind });
      await react(messageId, CHOSEN_EMOJI);
      await replace(live, epoch, rec, { ...a, agent: rec.cli }, seen, { how: 'chosenNext', choice: n });
      return;
    }
    const live = alive(root, epoch, chatId);
    if (!live || records.get(root) !== rec) return;
    log('block.verify', { root, paneId, outcome: 'no-effect' });
    rec.busy = false;
    await deps.receipt(live, t(deps.langOf(live)).promptKeysIgnored);
  };

  /** A record that belongs to another group than the project's current one is stale: forgotten without a word. */
  const recordFor = (b: Binding): BlockRecord | undefined => {
    const rec = records.get(b.root);
    if (rec && rec.chatId !== b.chatId) {
      records.delete(b.root);
      return undefined;
    }
    return rec;
  };

  const onPoll = async (b: Binding, agent: AgentInfo): Promise<void> => {
    if (stopped || !isRelayed(agent)) return;
    const { root } = b;
    if (redirecting.has(root) || polling.has(root)) return;
    polling.add(root);
    try {
      let rec = recordFor(b);
      if (rec?.busy) return;
      const epoch = epochOf(root);
      if (rec && rec.paneId === agent.pane_id && settled(agent.agent_status)) {
        await close(b, rec, { how: 'terminal' });
        return;
      }
      if (agent.agent_status !== 'blocked') return;
      // Blocked: every poll looks at the screen, whether or not a card is out
      // for it — the pane may have been blocked since before it was first seen,
      // or moved on to another prompt while nobody was watching.
      const seen = await look(agent.pane_id, agent.agent);
      if (!alive(root, epoch, b.chatId) || redirecting.has(root)) return;
      rec = recordFor(b);
      if (rec?.busy) return;
      if (rec && rec.paneId === agent.pane_id) {
        // A screen that cannot be read or parsed says nothing about whether the prompt changed.
        if (!seen.readable || seen.screen.kind === 'unknown') return;
        if (seen.screen.fingerprint === rec.screen.fingerprint) return;
        log('block.verify', { root, paneId: rec.paneId, outcome: 'changed-unanswered', kind: seen.screen.kind });
        await replace(b, epoch, rec, agent, seen, { how: 'stale' });
        return;
      }
      // A record left over from another pane.
      if (rec) await close(b, rec, { how: 'terminal' });
      await present(b, epoch, agent, seen.raw, seen.screen);
    } finally {
      polling.delete(root);
    }
  };

  const onMessage = async (b: Binding, text: string, messageId: string): Promise<boolean> => {
    if (stopped) return false;
    const rec = recordFor(b);
    if (!rec) return false;
    const T = t(deps.langOf(b));
    const trimmed = text.trim();
    const isNumber = /^\d+$/.test(trimmed);
    if (rec.busy) {
      if (!isNumber) return false;
      await deps.receipt(b, T.promptBusy);
      return true;
    }
    const epoch = epochOf(b.root);
    rec.busy = true;
    let checking = false;
    try {
      const a = await paneState(rec.paneId);
      if (stopped) return true;
      if (!alive(b.root, epoch, b.chatId) || records.get(b.root) !== rec) {
        if (!isNumber) return false;
        await react(messageId, IGNORED_EMOJI);
        return true;
      }
      // herdr does not list the pane: no telling what is on it, so the message goes the ordinary way.
      if (!a) return false;
      if (settled(a.agent_status)) {
        await close(b, rec, { how: 'terminal' });
        if (!isNumber) return false;
        await react(messageId, IGNORED_EMOJI);
        return true;
      }
      if (!rec.replyable) {
        await deps.receipt(b, T.promptUnreadable);
        return true;
      }
      if (!isNumber) {
        await deps.receipt(b, T.promptReplyNumber);
        return true;
      }
      const n = Number(trimmed);
      const seen = await look(rec.paneId, rec.cli);
      if (stopped) return true;
      if (!alive(b.root, epoch, b.chatId) || records.get(b.root) !== rec) {
        await react(messageId, IGNORED_EMOJI);
        return true;
      }
      // Not knowing what is on screen is no reason to give up on the card: nothing is pressed, and the human tries again.
      if (!seen.readable) {
        log('block.verify', { root: b.root, paneId: rec.paneId, outcome: 'unreadable-before-keys' });
        await deps.receipt(b, T.promptScreenUnreadable);
        return true;
      }
      if (seen.screen.fingerprint !== rec.screen.fingerprint) {
        log('block.verify', { root: b.root, paneId: rec.paneId, outcome: 'stale-before-keys', kind: seen.screen.kind });
        await react(messageId, IGNORED_EMOJI);
        await replace(b, epoch, rec, { ...a, agent: rec.cli }, seen, { how: 'stale' });
        return true;
      }
      if (!seen.screen.options.some((o) => o.n === n)) {
        await deps.receipt(b, fill(T.promptNoSuchOption, { n }));
        return true;
      }
      const keys = keysFor(seen.screen, n);
      const r = await herdr.sendKeys(rec.paneId, keys);
      log('block.keys', { root: b.root, paneId: rec.paneId, n, keys, ok: r.ok, code: r.code });
      if (!r.ok) {
        await deps.receipt(b, fill(T.promptKeysRefused, { why: [r.code, r.message].filter(Boolean).join(' ') || '?' }));
        return true;
      }
      checking = true;
      background('block.verify', () => verify(rec, n, messageId, epoch).finally(() => (rec.busy = false)));
      return true;
    } finally {
      if (!checking) rec.busy = false;
    }
  };

  const drop = async (b: Binding): Promise<void> => {
    epochs.set(b.root, epochOf(b.root) + 1);
    redirecting.delete(b.root);
    const rec = records.get(b.root);
    if (!rec) return;
    records.delete(b.root);
    if (rec.chatId !== b.chatId) return;
    await rewrite(b, rec, { how: 'closed' });
  };

  return {
    onPoll,
    onMessage,
    drop,
    has: (root) => records.has(root),
    stop: () => {
      stopped = true;
      for (const s of sleeps) {
        clearTimeout(s.timer);
        s.wake();
      }
      sleeps.clear();
    },
    idle: async () => {
      while (flows.size) await Promise.all([...flows]);
    },
  };
}
