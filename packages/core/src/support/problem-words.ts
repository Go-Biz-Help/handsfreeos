/**
 * The support desk's Problem reports (schemas/problem-report.ts): what the web's /admin/problems and the phone's
 * desk both say, and the text **Copy for Claude** puts on the clipboard, so a report can be handed to Claude in a
 * session on the code without anyone describing it.
 */
import type {
  HelperMove,
  HelperNotLooked,
  HelperResult,
  HelperVerdict,
  LearnedWayShape,
  ProblemHelper,
  ProblemReportFull,
  ProblemReportRow,
  ProblemSource,
  ProblemState,
  ProblemStep,
} from '../schemas/problem-report';
import { PROBLEM_KEEP_DAYS, PROBLEM_STEP_DAYS } from '../schemas/problem-report';

export const PROBLEM_SOURCE_WORDS: Readonly<Record<ProblemSource, string>> = {
  extension: 'Browser extension',
  web: 'Web app',
  phone: 'Phone app',
};

export const PROBLEM_STATE_WORDS: Readonly<Record<ProblemState, string>> = {
  open: 'Open',
  handled: 'Handled',
  all: 'All',
};

/** The state a page address asks for (`?state=handled`); anything else is the open ones. */
export const problemState = (value: unknown): ProblemState =>
  value === 'handled' || value === 'all' ? value : 'open';

/** An area a page address asks for (`?area=linkedin`), or every one. */
export const problemArea = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : null;

export const DESK_PROBLEM_WORDS = {
  intro: `What our own tools saw when something didn’t go, from every business. Each is kept ${PROBLEM_KEEP_DAYS} days, handled or not.`,
  none: {
    open: 'Nothing open. Every report is handled.',
    handled: 'Nothing has been marked handled yet.',
    all: `No reports in the last ${PROBLEM_KEEP_DAYS} days.`,
  } satisfies Record<ProblemState, string>,
  everyArea: 'Every area',
  older: 'Show older',
  newest: 'Back to the newest',
  open: 'Open',
  markHandled: 'Mark handled',
  reopen: 'Open again',
  markAllHandled: (n: number) => (n === 1 ? 'Mark this one handled' : `Mark these ${n} handled`),
  copyForClaude: 'Copy for Claude',
  /** The phone shares it instead, into a message or a note. */
  shareForClaude: 'Share for Claude',
  copied: 'Copied. Paste it to Claude in a session on the HandsFreeOS code.',
  downloadOutline: 'Download outline',
  outline: 'Page outline',
  noOutline: 'No outline was kept with this one.',
  found: 'What it found',
  nothingFound: 'Nothing was counted.',
  back: 'Problem reports',
  withOutline: 'outline kept',
  noNote: 'No note: it was sent to show the page.',
  shown: (shown: boolean | null) =>
    shown === null
      ? null
      : shown
        ? 'Chrome showed the page.'
        : 'Chrome didn’t show the page: its window was behind another.',
  handled: (when: string, by: string | null) => `Handled ${when}${by ? ` by ${by}` : ''}.`,
  gone: 'That report isn’t there anymore. Reports go after 30 days. Go back to the list and pick another.',
} as const;

/** How the AI helper sorted a step that didn't go (decision 142): the badge on a report and its heading. */
export const HELPER_VERDICT_WORDS: Readonly<Record<HelperVerdict, string>> = {
  in_the_way: 'Something in the way',
  moved: 'Layout changed',
  refused: 'Refused',
  warning: 'Warning',
  unclear: 'Couldn’t tell',
};

/** How it ended. */
export const HELPER_RESULT_WORDS: Readonly<Record<HelperResult, string>> = {
  fixed_itself: 'Fixed itself',
  done_by_helper: 'Done by the AI helper',
  reported: 'Reported',
};

const MOVE_DONE: Readonly<Record<HelperMove, string>> = {
  click: 'Clicked',
  scroll: 'Scrolled',
  escape: 'Pressed Escape',
  wait: 'Waited',
  press: 'Pressed the step’s button',
};

/** One of its moves, as the report lists it: "Clicked button “Not now”". */
export const helperMoveWords = (m: ProblemHelper['moves'][number]) =>
  `${MOVE_DONE[m.do]}${m.on ? ` ${m.on}` : ''}${m.went ? '' : ' (didn’t go)'}`;

/** A report's badge: "Layout changed · Done by the AI helper". */
export const helperBadge = (h: { verdict: HelperVerdict; result: HelperResult }) =>
  h.result === 'reported'
    ? HELPER_VERDICT_WORDS[h.verdict]
    : `${HELPER_VERDICT_WORDS[h.verdict]} · ${HELPER_RESULT_WORDS[h.result]}`;

export const DESK_HELPER_WORDS = {
  heading: 'What the AI helper found',
  notAsked:
    'The AI helper couldn’t look this time (its daily limit, the business’s AI balance, or the AI was busy).',
  /** Why it didn't look, as the computer said (decision 144); `notAsked` for a report from before it. */
  notLooked: {
    looks_used: 'The AI helper didn’t look: this computer’s looks for the day were all used.',
    no_view: 'The AI helper didn’t look: the page couldn’t be read for it.',
    not_asked:
      'The AI helper couldn’t look: the AI wasn’t asked (its daily limit, the business’s AI balance, or the AI was busy).',
    no_answer: 'The AI helper couldn’t look: HandsFreeOS didn’t answer when the computer asked.',
  } satisfies Record<HelperNotLooked, string>,
  nothingSaid: 'It didn’t say more.',
  moves: 'What it did',
  noMoves: 'It only looked.',
  looks: (n: number) => (n === 1 ? 'Looked once.' : `Looked ${n} times.`),
  learned: {
    worked: 'A way it learned before found the button.',
    failed: 'A way it learned before didn’t work here.',
  },
  steps: `By step, last ${PROBLEM_STEP_DAYS} days`,
  noSteps: `No reports in the last ${PROBLEM_STEP_DAYS} days.`,
  /** "12 reports, 3 open · 4 in the way, 2 layout changed, 1 refused · 3 fixed themselves, 1 done by the helper". */
  step: (t: ProblemStep) => {
    const parts = [`${t.reports} ${t.reports === 1 ? 'report' : 'reports'}, ${t.open} open`];
    const sorted = [
      t.inTheWay ? `${t.inTheWay} in the way` : null,
      t.moved ? `${t.moved} layout changed` : null,
      t.refused ? `${t.refused} refused` : null,
    ].filter(Boolean);
    if (sorted.length) parts.push(sorted.join(', '));
    const ended = [
      t.fixed ? `${t.fixed} fixed ${t.fixed === 1 ? 'itself' : 'themselves'}` : null,
      t.doneByHelper ? `${t.doneByHelper} done by the helper` : null,
    ].filter(Boolean);
    if (ended.length) parts.push(ended.join(', '));
    return parts.join(' · ');
  },
  ways: 'Learned ways',
  waysIntro:
    'How the AI helper found a step’s button in a new place. Once one has worked twice, every computer tries it before asking the AI. Set one aside and no computer tries it again. One that hasn’t worked in 90 days goes.',
  noWays: 'The AI helper hasn’t learned any ways yet.',
  trusted: 'Every computer tries it',
  learning: 'Learning: needs to work twice',
  removedWay: 'Set aside',
  setAside: 'Set aside',
  bringBack: 'Bring back',
  wayCounts: (w: { worked: number; failed: number; businesses: number }) =>
    `Worked ${w.worked} ${w.worked === 1 ? 'time' : 'times'} for ${w.businesses} ${
      w.businesses === 1 ? 'business' : 'businesses'
    }${w.failed ? `, didn’t ${w.failed} ${w.failed === 1 ? 'time' : 'times'}` : ''}.`,
} as const;

/** How a learned way finds its button, in words: "button “Add Friend (their name)” in main, under link “More”". */
export function learnedWayWords(way: LearnedWayShape): string {
  const part = (p: Pick<LearnedWayShape, 'tag' | 'role' | 'label' | 'words'>) => {
    const said = p.label ?? p.words;
    return `${p.role ?? p.tag}${said ? ` “${said}”` : ''}`;
  };
  return [
    part(way),
    way.inside ? `in ${way.inside}` : null,
    way.menu ? `under ${part(way.menu)}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The network's button a way presses, in words: "add_friend" → "Add friend". */
export const learnedButtonWords = (button: string) =>
  `${button[0]?.toUpperCase() ?? ''}${button.slice(1).replace(/_/g, ' ')}`;

/** "linkedin · checkup · own-profile": where, what it was doing, and which page. */
export const problemWhere = (r: Pick<ProblemReportRow, 'area' | 'job' | 'page'>) =>
  [r.area, r.job, r.page].join(' · ');

/** "Browser extension 0.48.0 (outreach)": what sent it. */
export const problemFrom = (r: Pick<ProblemReportRow, 'source' | 'version' | 'addonId'>) =>
  `${PROBLEM_SOURCE_WORDS[r.source]}${r.version ? ` ${r.version}` : ''}${r.addonId ? ` (${r.addonId})` : ''}`;

/** The outline's file name when it's downloaded. */
export const problemOutlineFile = (r: Pick<ProblemReportRow, 'area' | 'page' | 'at'>) =>
  `outline-${r.area}-${r.page}-${r.at.slice(0, 19).replace(/[:T]/g, '-')}.txt`;

/**
 * What **Copy for Claude** puts on the clipboard: the report, and the outline when one was kept, as a message to
 * Claude in a session on the code. Never the business's name: Claude needs the page, not whose it was.
 */
export function problemForClaude(r: ProblemReportFull): string {
  const lines = [
    `A problem report from HandsFreeOS’s ${PROBLEM_SOURCE_WORDS[r.source].toLowerCase()}${
      r.addonId ? ` (the ${r.addonId} add-on)` : ''
    }${r.version ? `, version ${r.version}` : ''}, sent ${r.at}.`,
    '',
    `- Area: ${r.area}`,
    `- Job: ${r.job}${r.ref ? ` (ref ${r.ref})` : ''}`,
    `- Page: ${r.page}${r.path ? ` ${r.path}` : ''}`,
  ];
  if (r.shown !== null) lines.push(`- Chrome showed the page: ${r.shown ? 'yes' : 'no'}`);
  if (r.note) lines.push(`- Note: ${r.note}`);
  if (Object.keys(r.found).length) lines.push(`- Found: ${JSON.stringify(r.found)}`);
  if (r.helper) {
    lines.push(
      `- AI helper: ${HELPER_VERDICT_WORDS[r.helper.verdict]} · ${HELPER_RESULT_WORDS[r.helper.result]}`,
    );
    if (r.helper.notLooked) lines.push(`- ${DESK_HELPER_WORDS.notLooked[r.helper.notLooked]}`);
    if (r.helper.said) lines.push(`- It said: ${r.helper.said}`);
    for (const m of r.helper.moves) lines.push(`  - ${helperMoveWords(m)}`);
    if (r.helper.learned) lines.push(`- ${DESK_HELPER_WORDS.learned[r.helper.learned]}`);
  }
  lines.push(
    '',
    `Find why the tool got this page wrong and fix it, with a test built from the outline. Report ${r.reportId}.`,
  );
  if (r.outline)
    lines.push(
      '',
      'The page’s outline (everything a person wrote is masked as "[2 words]"):',
      '',
      '```text',
      r.outline,
      '```',
    );
  return lines.join('\n');
}
