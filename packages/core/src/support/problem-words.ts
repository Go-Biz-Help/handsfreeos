/**
 * The support desk's Problem reports (schemas/problem-report.ts): what the web's /admin/problems and the phone's
 * desk both say, and the text **Copy for Claude** puts on the clipboard, so a report can be handed to Claude in a
 * session on the code without anyone describing it.
 */
import type {
  ProblemReportFull,
  ProblemReportRow,
  ProblemSource,
  ProblemState,
} from '../schemas/problem-report';
import { PROBLEM_KEEP_DAYS } from '../schemas/problem-report';

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
