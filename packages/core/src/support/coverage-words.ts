/**
 * The support desk's Assistant coverage (assistant/coverage.ts): what the web's /admin/assistant and the phone's desk
 * both say, and the text **Copy gaps** puts on the clipboard, so the gaps can be handed to Claude in a session on the
 * code. Everything not listed as a gap the Assistant can do: packages/core/test/assistant-coverage.test.ts fails on
 * a new button or setting until it's covered or listed.
 */
import { ADDON_CATALOG } from '../addons/catalog';
import {
  ASSISTANT_NOT_YET,
  NEVER_FOR_THE_ASSISTANT,
  SCREEN_ACTIONS,
  SETTING_TOOLS,
  SETTINGS_NEVER,
  SETTINGS_NOT_YET,
  type NotYet,
} from '../assistant/coverage';
import { SETTINGS, type SettingEntry } from '../settings/catalog';
import { SETTINGS_PAGES } from '../settings/pages';

/** A Settings page (or an add-on's settings) whose rows aren't checked yet, with the rows. */
export interface SettingsToCheck {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly string[];
}

export interface AssistantCoverage {
  /** The screens' commands it runs through tools made from them. */
  readonly screenActions: number;
  /** What it never does, by command, and why. */
  readonly never: readonly { readonly command: string; readonly why: string }[];
  /** What it can't do yet, by page in menu order. */
  readonly notYet: readonly NotYet[];
  readonly notYetActions: number;
  /** Setting rows, and how many say which tool changes them or why it doesn't. */
  readonly settingRows: number;
  readonly settingRowsChecked: number;
  /** The pages still to check, in menu order. */
  readonly settingsToCheck: readonly SettingsToCheck[];
}

/** The page a setting row is on, as SETTINGS_NOT_YET names it: a Settings page, an add-on, or the phone. */
const pageOf = (s: SettingEntry): string => s.page ?? s.addon ?? 'phone';

/** A page's name as its menu says it. */
function pageLabel(key: string): string {
  return (
    SETTINGS_PAGES.find((p) => p.key === key)?.label ??
    ADDON_CATALOG.find((m) => m.id === key)?.name ??
    (key === 'phone' ? 'The phone app' : key)
  );
}

/** Where the Assistant stands, from the lists the checks hold it to. */
export function assistantCoverage(): AssistantCoverage {
  const rows = SETTINGS.filter((s) => s.kind !== 'page');
  return {
    screenActions: Object.keys(SCREEN_ACTIONS).length,
    never: Object.entries(NEVER_FOR_THE_ASSISTANT).map(([command, why]) => ({ command, why })),
    notYet: ASSISTANT_NOT_YET,
    notYetActions: ASSISTANT_NOT_YET.reduce((n, p) => n + p.actions.length, 0),
    settingRows: rows.length,
    settingRowsChecked: rows.filter((s) => s.key in SETTING_TOOLS || s.key in SETTINGS_NEVER)
      .length,
    settingsToCheck: SETTINGS_NOT_YET.map((key) => ({
      key,
      label: pageLabel(key),
      rows: rows.filter((s) => pageOf(s) === key).map((s) => s.label),
    })),
  };
}

const rowsWord = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

export const DESK_COVERAGE_WORDS = {
  intro:
    'What Ask HandsFreeOS can’t do yet, page by page in the menu’s order. Everything else a screen does, it does: a new button or setting fails the checks until it’s covered or listed here.',
  notYours:
    'Your support role doesn’t open Assistant coverage. Ask a support admin if you need it.',
  copy: 'Copy gaps',
  /** The phone shares them instead, into a message or a note. */
  share: 'Share gaps',
  copied: 'Copied. Paste it to Claude in a session on the HandsFreeOS code.',
  cards: {
    screenActions: 'Screen actions it runs',
    notYet: 'Actions it can’t do yet',
    never: 'Never, on purpose',
    settings: 'Setting rows checked',
  },
  settingsChecked: (c: AssistantCoverage) => `${c.settingRowsChecked} of ${c.settingRows}`,
  notYetTitle: 'What it can’t do yet',
  notYetNone: 'Nothing. It can do every action a screen has.',
  settingsTitle: 'Settings still to check',
  settingsDetail:
    'Each row must say which tool changes it, or why the Assistant doesn’t. These pages haven’t been gone through yet.',
  settingsNone: 'Nothing. Every setting row is checked.',
  rows: rowsWord,
  neverTitle: 'What it never does, and why',
  neverDetail:
    'Deleting for good, signing in, paying on Stripe’s page, uploading files, and what the app does by itself.',
} as const;

/** The cards at the top of the page. */
export const coverageCards = (c: AssistantCoverage) =>
  [
    {
      key: 'screenActions',
      label: DESK_COVERAGE_WORDS.cards.screenActions,
      value: String(c.screenActions),
      gap: false,
    },
    {
      key: 'notYet',
      label: DESK_COVERAGE_WORDS.cards.notYet,
      value: String(c.notYetActions),
      gap: c.notYetActions > 0,
    },
    {
      key: 'never',
      label: DESK_COVERAGE_WORDS.cards.never,
      value: String(c.never.length),
      gap: false,
    },
    {
      key: 'settings',
      label: DESK_COVERAGE_WORDS.cards.settings,
      value: DESK_COVERAGE_WORDS.settingsChecked(c),
      gap: c.settingRowsChecked < c.settingRows,
    },
  ] as const;

/**
 * What **Copy gaps** puts on the clipboard: every gap, page by page in menu order, as a message to Claude in a
 * session on the code, with where the steps are.
 */
export function coverageGapsForClaude(c: AssistantCoverage): string {
  const lines = [
    'The HandsFreeOS Assistant’s gaps, from Assistant coverage in the Admin area.',
    '',
    'Close the first page of each list, as "Keeping the Assistant able to do everything" in docs/operations.md says, take it off packages/core/src/assistant/coverage.ts, and open a pull request.',
  ];
  if (c.notYet.length) {
    lines.push('', 'What it can’t do yet, by page in menu order:');
    for (const p of c.notYet) lines.push(`- ${p.page}: ${p.actions.join(', ')}. ${p.why}`);
  }
  if (c.settingsToCheck.length) {
    lines.push('', 'Settings still to check, by page in menu order (SETTINGS_NOT_YET):');
    for (const p of c.settingsToCheck)
      lines.push(`- ${p.label} (${p.key}, ${rowsWord(p.rows.length)}): ${p.rows.join('; ')}`);
  }
  if (!c.notYet.length && !c.settingsToCheck.length)
    lines.push('', 'There are no gaps: it can do every action and setting a screen has.');
  return lines.join('\n');
}
