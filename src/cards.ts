import type { ParsedScreen } from './screen.js';
import { fill, t } from './texts.js';
import type { AskOption, AskPayload, Lang, NotifyPayload } from './validate.js';

export type AskState = 'pending' | 'answered' | 'timedout' | 'cancelled';

/**
 * Card JSON 2.0. The `markdown` element is a real rich-text component —
 * tables, ordered/unordered lists and fenced code blocks all render — unlike
 * 1.0's `lark_md`, which is only an *inline* formatting tag on a text
 * component and supports none of them. The one breaking change from 1.0:
 * `tag: "action"` is gone, buttons sit directly in `body.elements`.
 */
const md = (content: string): object => ({ tag: 'markdown', content });
const hr = (): object => ({ tag: 'hr' });

/**
 * Small grey caption line. Colour is an inline `<font>` tag in the content:
 * the markdown element has `text_size` and `text_align`, but no `text_color`.
 */
const note = (content: string): object => ({
  tag: 'markdown',
  content: `<font color='grey'>${content}</font>`,
  text_size: 'notation',
});

function card(header: { icon: string; title: string; template: string }, elements: object[]): object {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: `${header.icon} ${header.title}` },
      template: header.template,
    },
    body: { elements },
  };
}

function field(label: string, value: string): string {
  return `**${label}**　${value}`;
}

/** The ids the agent leans towards, whether one or several. */
export function recommendedIds(p: AskPayload): string[] {
  return Array.isArray(p.recommend) ? p.recommend : [p.recommend];
}

/**
 * One line per option. Observed on the desktop client: inside a numbered
 * list item, an ideographic space (U+3000) right after a bold run renders
 * with no gap at all; the field lines above (`**label**　value`) are not
 * affected. So label and consequence are joined by a real separator here,
 * and the recommendation mark closes the line.
 */
function optionLines(options: AskOption[], recommended: string[], lang: Lang): string {
  const T = t(lang);
  return options
    .map((o, i) => {
      const danger = o.danger ? '　⚠️' : '';
      const tail = recommended.includes(o.id) ? `　${T.recommended}` : '';
      return `${i + 1}. **${o.label}**${danger}${T.optionSep}${o.consequence}${tail}`;
    })
    .join('\n');
}

export interface AskCardContext {
  payload: AskPayload;
  projectLabel: string;
  reqId: string;
  state: AskState;
  reply?: string;
  /** Flagged in-app to the owner; the pending header turns red. */
  urgent?: boolean;
  /** How many times the pending card has been re-rendered after a refused submit; part of the submit action's value. */
  attempt?: number;
  /** The wrapper's language (section labels, hints, button texts, the status word); the caller's own, never read off the payload. */
  lang?: Lang;
}

const HEADER: Record<AskState, { template: string; icon: string }> = {
  pending: { template: 'blue', icon: '🤔' },
  answered: { template: 'green', icon: '✅' },
  timedout: { template: 'grey', icon: '⌛' },
  cancelled: { template: 'grey', icon: '⚠️' },
};

/** A native confirm dialog on a button. */
function confirm(T: ReturnType<typeof t>, text: string): object {
  return {
    title: { tag: 'plain_text', content: T.confirmTitle },
    text: { tag: 'plain_text', content: text },
  };
}

/**
 * Single choice: one button per option. Both the 1.0 `value` field and 2.0
 * `behaviors` reach the callback as `action.value`; `value` is kept because it
 * is the shorter of the two and was verified to work on a schema-2.0 card.
 */
function optionButtons(p: AskPayload, reqId: string, recommended: string[], T: ReturnType<typeof t>): object[] {
  return p.options.map((o) => {
    const button: Record<string, unknown> = {
      tag: 'button',
      text: { tag: 'plain_text', content: o.label },
      type: o.danger ? 'danger' : recommended.includes(o.id) ? 'primary' : 'default',
      value: { reqId, optionId: o.id },
    };
    if (o.danger) button.confirm = confirm(T, fill(T.confirmText, { label: o.label }));
    return button;
  });
}

/** Form field name of an option's checker; option ids are free-form, the prefix keeps them clear of the form's own names. */
export const checkerName = (optionId: string): string => `opt:${optionId}`;
export const optionIdOf = (checkerName: string): string | null => (checkerName.startsWith('opt:') ? checkerName.slice(4) : null);

/**
 * Multi choice: a form with one checker per option and a submit button. The
 * checkers only hold their state locally; the submit button sends them all in
 * one callback carrying `reqId`. A danger option cannot get its own confirm
 * dialog inside a form, so the dialog sits on the submit button whenever the
 * card holds one.
 */
function optionForm(p: AskPayload, reqId: string, attempt: number, recommended: string[], T: ReturnType<typeof t>): object {
  // The channel SDK drops a repeat of the same action on the same card for
  // twelve hours, keyed on the button's value; a refused submit re-renders
  // the card with the next attempt so the human's retry is a new action.
  const submit: Record<string, unknown> = {
    tag: 'button',
    name: 'submit',
    form_action_type: 'submit',
    type: 'primary',
    text: { tag: 'plain_text', content: T.submit },
    behaviors: [{ type: 'callback', value: { reqId, attempt } }],
  };
  if (p.options.some((o) => o.danger)) submit.confirm = confirm(T, T.confirmMultiText);
  return {
    tag: 'form',
    name: 'ask',
    elements: [
      ...p.options.map((o) => ({
        tag: 'checker',
        name: checkerName(o.id),
        checked: recommended.includes(o.id),
        text: { tag: 'lark_md', content: `**${o.label}**${T.optionSep}${o.consequence}` },
      })),
      submit,
    ],
  };
}

export function askCard(ctx: AskCardContext): object {
  const { payload: p, state } = ctx;
  const lang = ctx.lang ?? 'en';
  const T = t(lang);
  const head = HEADER[state];
  const template = state === 'pending' && ctx.urgent ? 'red' : head.template;
  const recommended = recommendedIds(p);
  const statusWord =
    state === 'answered' ? T.answered : state === 'timedout' ? T.timedout : state === 'cancelled' ? T.cancelled : '';

  const elements: object[] = [];
  if (state === 'answered' && ctx.reply) {
    elements.push(md(field(T.yourReply, ctx.reply)), hr(), note(T.theQuestion));
  }

  elements.push(
    md(field(T.doing, p.doing)),
    md(field(T.background, p.description)),
    md(field(T.blocker, p.blocker)),
    hr(),
    md(`**${T.options}**\n\n${optionLines(p.options, recommended, lang)}`),
    hr(),
    md(field(T.recommend, p.reasoning)),
    md(`**${T.question}**　${p.question}`),
  );

  if (state === 'pending') {
    if (p.select === 'multi') {
      elements.push(optionForm(p, ctx.reqId, ctx.attempt ?? 0, recommended, T), note(T.hintMulti));
    } else {
      elements.push(...optionButtons(p, ctx.reqId, recommended, T));
      elements.push(note(p.options.some((o) => o.danger) ? T.hintDanger : T.hint));
    }
  }

  return card(
    { icon: head.icon, title: `[${ctx.projectLabel}] ${p.title}${statusWord ? ` · ${statusWord}` : ''}`, template },
    elements,
  );
}

export function notifyCard(p: NotifyPayload, projectLabel: string): object {
  return card({ icon: '📣', title: `[${projectLabel}] ${p.title}`, template: 'wathet' }, [md(p.body)]);
}

/**
 * Sent into the group when a phone message could not reach the terminal —
 * or, with `uncertain`, when it did reach the agent's queue but the wake-up
 * key was refused, so whether it gets read is not known.
 */
export function receiptCard(projectLabel: string, why: string, lang: Lang = 'en', uncertain = false): object {
  const T = t(lang);
  return card({ icon: '⚠️', title: `[${projectLabel}] ${uncertain ? T.maybeNotDelivered : T.notDelivered}`, template: 'orange' }, [
    md(uncertain ? why : fill(T.notDeliveredBody, { why })),
  ]);
}

/** How a "waiting for you" card ends: still open, or rewritten once the prompt is resolved. */
export type StatusState = 'open' | 'chosen' | 'chosenNext' | 'terminal' | 'stale' | 'closed';

/**
 * What a "waiting for you" card shows. The two picked states carry the number
 * picked on the phone; the others have none, so a picked card can never be
 * rendered without its number.
 */
export type StatusView = {
  /** What the parser made of the pane's screen. */
  screen: ParsedScreen;
  /** The raw screen text; its last lines are shown when `screen.kind` is `unknown` (the parser keeps no block then). */
  raw?: string;
} & (
  | {
      /** Defaults to `open`. */
      state?: Exclude<StatusState, 'chosen' | 'chosenNext'>;
      choice?: undefined;
    }
  | {
      state: 'chosen' | 'chosenNext';
      /** The number picked on the phone. */
      choice: number;
    }
);

const MAX_LINE = 160;
const MAX_LINES = 40;
const HEAD_LINES = 8;
const UNKNOWN_TAIL = 20;

/** Cuts one line to `MAX_LINE` characters (counted by code point), ending in an ellipsis. */
function clipLine(line: string): string {
  const chars = [...line];
  return chars.length <= MAX_LINE ? line : `${chars.slice(0, MAX_LINE - 1).join('')}…`;
}

/**
 * The lines to show inside the code block: over-long lines cut, and a long
 * prompt reduced to its first lines and its last ones (the options sit at the
 * bottom) with a one-line note in between; the result is `MAX_LINES` lines.
 */
function clipBlock(lines: string[], T: ReturnType<typeof t>): string[] {
  const clipped = lines.map(clipLine);
  if (clipped.length <= MAX_LINES) return clipped;
  const tail = MAX_LINES - HEAD_LINES - 1;
  const omitted = clipped.length - HEAD_LINES - tail;
  return [...clipped.slice(0, HEAD_LINES), fill(T.statusOmitted, { n: omitted }), ...clipped.slice(-tail)];
}

/** A fenced code block; a triple backtick in the text is broken up so it cannot close the fence early. */
function codeBlock(lines: string[]): object {
  const body = lines.join('\n').replace(/`(?=``)/g, '`\u200b');
  return md('```\n' + body + '\n```');
}

/** Pushed while remote mode is on and the agent is stuck on a prompt only a human can answer. */
export function statusCard(projectLabel: string, detail: string, lang: Lang = 'en', view?: StatusView): object {
  const T = t(lang);
  const elements: object[] = [md(detail)];
  if (!view) return card({ icon: '🔔', title: `[${projectLabel}] ${T.statusBlocked}`, template: 'orange' }, elements);

  const { screen } = view;
  const state = view.state ?? 'open';
  const lines = screen.kind === 'unknown' ? trimBlank((view.raw ?? '').split('\n')).slice(-UNKNOWN_TAIL) : screen.block;
  if (lines.length) elements.push(codeBlock(clipBlock(lines, T)));

  if (state === 'open') {
    if (screen.kind === 'unknown') {
      elements.push(note(T.statusHintUnknown));
    } else {
      if (!screen.numbered) {
        elements.push(md(`**${T.statusNumbering}**\n\n${screen.options.map((o) => `${o.n}. ${o.label}`).join('\n')}`));
      }
      elements.push(note(T.statusHintReply));
    }
    return card({ icon: '🔔', title: `[${projectLabel}] ${T.statusBlocked}`, template: 'orange' }, elements);
  }

  // The type already demands a number for the picked states; this catches a caller that cast its way past it.
  if ((state === 'chosen' || state === 'chosenNext') && !(Number.isInteger(view.choice) && (view.choice as number) > 0))
    throw new Error(`statusCard: state ${state} needs the picked number (choice), got ${String(view.choice)}`);
  const n = view.choice ?? 0;
  const resolved: Record<Exclude<StatusState, 'open'>, { icon: string; template: string; word: string }> = {
    chosen: { icon: '✅', template: 'green', word: fill(T.statusChosen, { n }) },
    chosenNext: { icon: '➡️', template: 'grey', word: fill(T.statusChosenNext, { n }) },
    terminal: { icon: '💻', template: 'grey', word: T.statusTerminal },
    stale: { icon: '⌛', template: 'grey', word: T.statusStale },
    closed: { icon: '🌙', template: 'grey', word: T.statusClosed },
  };
  const r = resolved[state];
  return card({ icon: r.icon, title: `[${projectLabel}] ${T.statusBlocked} · ${r.word}`, template: r.template }, elements);
}

/** Drops blank lines from both ends. */
function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !(lines[a] as string).trim()) a++;
  while (b > a && !(lines[b - 1] as string).trim()) b--;
  return lines.slice(a, b);
}

/**
 * Pushed on each remote-mode transition, so the human on the phone learns the
 * channel just opened or is about to close — and, with `title`, on a group
 * that is about to stop carrying the project at all (an unbind, a switch to
 * another group), where the on/off wording does not fit.
 */
export function awayCard(projectLabel: string, on: boolean, detail: string, lang: Lang, title?: string): object {
  const T = t(lang);
  return card(
    { icon: on ? '📱' : '🌙', title: `[${projectLabel}] ${title ?? (on ? T.awayOnTitle : T.awayOffTitle)}`, template: on ? 'green' : 'grey' },
    [md(detail)],
  );
}
