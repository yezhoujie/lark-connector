// Reads the text of a terminal pane (what a coding-agent CLI has on screen)
// and works out whether it is stopped on a prompt with options, what kind of
// prompt that is, and which options it offers. Pure: text in, result out.

/** The coding-agent CLIs whose prompts can be recognised. */
export type ScreenCli = 'claude' | 'kimi';

export interface ScreenOption {
  /** The number that picks this option: the one printed on screen, or, when
   *  the screen prints none, its position from the top (1-based). */
  n: number;
  /** The option text without the number and the cursor marker. */
  label: string;
  /** True for the option the cursor sits on right now. */
  cursor: boolean;
}

export interface ParsedScreen {
  /** `question`: the agent is asking the user something (single / multi
   *  select, submit page). `choice`: any other prompt whose options were
   *  recognised (permission approval, trust check). `unknown`: no options
   *  could be found; every other field is then empty. */
  kind: 'question' | 'choice' | 'unknown';
  /** The prompt as printed, from its top to its bottom hint line, without
   *  separator rules and without leading or trailing blank lines. */
  block: string[];
  /** The options, top to bottom. */
  options: ScreenOption[];
  /** Whether the screen itself prints a number in front of each option.
   *  When false, `n` was counted here and number keys will not work. */
  numbered: boolean;
  /** The block with cursor markers dropped and whitespace collapsed. Moving
   *  the cursor does not change it; any change to the prompt text does. */
  fingerprint: string;
}

const RULE = /^\s*─{20,}\s*$/;
const FOOTER = /esc to cancel|esc cancel|↵ confirm|enter to confirm|enter to select/i;
const NUMBERED = /^\s*(?<cur>[❯▶→])?\s*(?:(?<n>\d+)\.|\[(?<m>\d+)\])\s+(?<label>.+?)\s*$/;
const CURSOR_ONLY = /^\s*❯\s+\S/;
const CURSOR_MARK = /^\s*[❯▶→]\s*/;

const indentOf = (l: string): number => l.length - l.trimStart().length;

const unknown = (): ParsedScreen => ({ kind: 'unknown', block: [], options: [], numbered: false, fingerprint: '' });

/** Finds the prompt at the bottom of `text` and describes it. */
export function parseScreen(text: string, cli: ScreenCli): ParsedScreen {
  const lines = text.split('\n').map((l) => l.trimEnd());

  // The last option line anchors everything else.
  let anchor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    if (NUMBERED.test(l) || CURSOR_ONLY.test(l)) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return unknown();
  const numbered = NUMBERED.test(lines[anchor] as string);

  // Unnumbered options: the cursor line plus its neighbours indented like
  // the rest of the list (the cursor marker takes two columns).
  let group: [number, number] = [anchor, anchor];
  if (!numbered) {
    const ind = indentOf(lines[anchor] as string) + 2;
    let j = anchor;
    while (j > 0 && (lines[j - 1] as string).trim() !== '' && indentOf(lines[j - 1] as string) === ind) j--;
    let k = anchor;
    while (
      k + 1 < lines.length &&
      (lines[k + 1] as string).trim() !== '' &&
      indentOf(lines[k + 1] as string) === ind &&
      !FOOTER.test(lines[k + 1] as string)
    ) {
      k++;
    }
    group = [j, k];
  }

  // Bottom: a hint line within three lines below the options, if any.
  let end = group[1];
  let footer = false;
  for (let i = group[1] + 1; i <= Math.min(group[1] + 3, lines.length - 1); i++) {
    if (FOOTER.test(lines[i] as string)) {
      end = i;
      footer = true;
      break;
    }
  }

  // Top: the nearest rule above. A rule sitting right above an option line
  // (the row that follows a rule in Claude's question forms) belongs inside
  // the prompt, so take the one above it; if there is none, the view is clipped.
  const rules: number[] = [];
  for (let i = 0; i < group[0]; i++) if (RULE.test(lines[i] as string)) rules.push(i);
  let r = rules.length - 1;
  const firstBelow = (at: number): string =>
    (lines.slice(at + 1, end + 1).find((l) => l.trim() !== '' && !RULE.test(l)) as string | undefined) ?? '';
  while (r >= 0) {
    const below = firstBelow(rules[r] as number);
    if (!NUMBERED.test(below) && !CURSOR_ONLY.test(below)) break;
    r--;
  }
  // No usable rule: none at all, or every rule has an option line right under
  // it, so the top of the prompt has scrolled off (a long command pushes it
  // out, and a blocked pane cannot be read beyond what is visible). A
  // numbered list with a hint line below it is still a prompt: it is taken
  // to start at the first line on screen, provided its numbers run from 1
  // (checked with the options below). Anything else is a clipped view.
  const clipped = r < 0;
  if (clipped && !(numbered && footer)) return unknown();
  const start = clipped ? lines.findIndex((l) => l.trim() !== '') - 1 : (rules[r] as number);

  const block = lines.slice(start + 1, end + 1).filter((l) => !RULE.test(l));
  while (block.length > 0 && (block[0] as string).trim() === '') block.shift();
  while (block.length > 0 && (block[block.length - 1] as string).trim() === '') block.pop();
  if (block.length === 0) return unknown();

  const options: ScreenOption[] = [];
  if (numbered) {
    // Walk up from the last option through consecutive numbers, so numbered
    // lines in content shown above the options are left out.
    let want = 0;
    for (let i = anchor; i > start; i--) {
      const m = NUMBERED.exec(lines[i] as string);
      if (!m?.groups) continue;
      const n = Number(m.groups.n ?? m.groups.m);
      if (options.length > 0 && n !== want) break;
      options.unshift({ n, label: m.groups.label as string, cursor: Boolean(m.groups.cur) });
      want = n - 1;
      if (n <= 1) break;
    }
  } else {
    for (let i = group[0]; i <= group[1]; i++) {
      options.push({
        n: i - group[0] + 1,
        label: (lines[i] as string).replace(CURSOR_MARK, '').trim(),
        cursor: i === anchor,
      });
    }
  }

  // Real prompts always offer at least two options; a lone one is a misread
  // (an echoed `❯ message` line, an idle input box).
  if (options.length < 2) return unknown();
  // Without a rule to mark its top, only a list numbered from 1 is trusted to be the whole list.
  if (clipped && options[0]?.n !== 1) return unknown();

  // Matched whole, never as a substring: a permission prompt's command may
  // quote these very words (a grep for them, say) and is still a permission.
  const isQuestion =
    cli === 'claude'
      ? options.some((o) => o.label.trim() === 'Chat about this') || block.some((l) => l.trim() === 'Ready to submit your answers?')
      : (block[0] as string).trim() === 'question';

  const fingerprint = block
    .map((l) => l.replace(CURSOR_MARK, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');

  return { kind: isQuestion ? 'question' : 'choice', block, options, numbered, fingerprint };
}
