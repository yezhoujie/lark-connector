// herdr as the daemon sees it, without spawning anything.
import type { HerdrDeps } from '../../src/daemon.js';
import { findPaneForProject, type AgentInfo, type HerdrView, type PromptOutcome } from '../../src/herdr.js';

export interface FakeHerdr {
  deps: HerdrDeps;
  agents: AgentInfo[];
  prompts: Array<{ paneId: string; text: string }>;
  /** Keys pressed with sendKeys, oldest first. */
  keys: Array<{ paneId: string; key: string }>;
  /** Every sendKeys call with its exact key sequence, oldest first (`keys` holds the same calls, the sequence joined by a space). */
  presses: Array<{ paneId: string; keys: string[] }>;
  /** Screen text per pane for readScreen; a pane not listed reads as null. */
  screens: Record<string, string>;
  /** Panes whose readScreen fails (null) even when a screen is configured. */
  screenFails: Set<string>;
  /** Panes readScreen was asked about, oldest first. */
  reads: string[];
  /** What promptPane answers; defaults to accepted. */
  outcome: PromptOutcome;
  /** What sendKeys answers; defaults to accepted. */
  keysOutcome: PromptOutcome;
  /** What deps.view() answers; defaults to a herdr found on PATH and reachable. */
  view: HerdrView;
}

/** An agent entry as `herdr agent list` reports it, with the fields a test cares about on top. */
export function agentEntry(over: Partial<AgentInfo> & { pane_id: string }): AgentInfo {
  return { agent: 'claude', agent_status: 'idle', cwd: '/p', focused: false, ...over };
}

export function createFakeHerdr(opts: { agents?: AgentInfo[]; outcome?: PromptOutcome; view?: HerdrView } = {}): FakeHerdr {
  const fake: FakeHerdr = {
    agents: opts.agents ?? [],
    prompts: [],
    keys: [],
    presses: [],
    screens: {},
    screenFails: new Set(),
    reads: [],
    outcome: opts.outcome ?? { ok: true },
    keysOutcome: { ok: true },
    view: opts.view ?? { bin: '/fake/herdr', reachable: true },
    deps: {
      agentList: async () => fake.agents,
      promptPane: async (paneId, text) => {
        fake.prompts.push({ paneId, text });
        return fake.outcome;
      },
      sendKeys: async (paneId, keys) => {
        const seq = Array.isArray(keys) ? keys : [keys];
        fake.keys.push({ paneId, key: seq.join(' ') });
        fake.presses.push({ paneId, keys: seq });
        return fake.keysOutcome;
      },
      readScreen: async (paneId) => {
        fake.reads.push(paneId);
        if (fake.screenFails.has(paneId)) return null;
        return fake.screens[paneId] ?? null;
      },
      findPaneForProject,
      view: async () => fake.view,
    },
  };
  return fake;
}
