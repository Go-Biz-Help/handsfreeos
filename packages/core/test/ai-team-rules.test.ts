import { describe, expect, it } from 'vitest';
import {
  applyTeammatePatch,
  hasBlockingTeammateIssues,
  isPatchFix,
  TEAMMATE_ISSUE_CODES,
  TEAMMATE_PRESET_KEYS,
  teammateConfigFromPreset,
  validateTeammate,
  workflowTextsNewLeads,
  type TeammateCatalogs,
  type TeammateIssueCode,
  type TeammatePatch,
} from '../src/ai-team/index';
import { recipeDefinition } from '../src/workflows/index';
import {
  catalogs,
  JESS,
  NOW,
  OFFICE_CAL,
  OLD_CAL,
  presetContext,
  SPEED_WF,
  SPEED_WF_2,
  uid,
  WEEKDAYS_8_TO_5,
} from './ai-team-fixtures';

interface Case {
  readonly code: TeammateIssueCode;
  readonly severity: 'error' | 'warning';
  readonly patch: TeammatePatch;
  readonly catalogs?: Partial<TeammateCatalogs>;
  readonly message: string;
  /** What following a link fix sets up, for rules whose fixes are only links (or to show the links work). */
  readonly clearedBy?: Partial<TeammateCatalogs>;
}

/** Start from scratch, with the business's address, widget and calendar: valid and clean. */
const base = () => teammateConfigFromPreset('blank', presetContext);

/** The smallest settings (or setup) that trigger each rule. */
const CASES: Case[] = [
  {
    code: 'no_channel',
    severity: 'error',
    patch: { channels: { sms: false, email: false, chat: false } },
    message: 'Turn on at least one channel',
  },
  {
    code: 'texting_not_ready',
    severity: 'warning',
    patch: {},
    catalogs: { textingReady: false },
    message: 'Texting isn’t set up yet, so it can’t text customers',
    clearedBy: { textingReady: true },
  },
  {
    code: 'no_email_address',
    severity: 'error',
    patch: { channels: { emailAddressId: null } },
    message: 'Pick the address it emails from',
  },
  {
    code: 'no_chat_widget',
    severity: 'error',
    patch: { channels: { widgetId: null } },
    message: 'Pick the website chat it answers',
  },
  {
    code: 'booking_needs_calendar',
    severity: 'error',
    patch: { book: { enabled: true, calendarIds: [] } },
    message: 'Booking needs a calendar',
  },
  {
    code: 'calendar_not_bookable',
    severity: 'error',
    patch: { book: { enabled: true, calendarIds: [OFFICE_CAL] } },
    message: 'Office visits isn’t open for online booking',
  },
  {
    code: 'no_qualifying_questions',
    severity: 'error',
    patch: { qualify: { enabled: true, questions: [] } },
    message: 'Qualifying needs questions',
  },
  {
    code: 'nobody_to_notify',
    severity: 'error',
    patch: { handOff: { notify: { kind: 'users', userIds: [JESS] } } },
    message: 'Nobody hears about hand-offs',
  },
  {
    code: 'thin_knowledge',
    severity: 'warning',
    patch: {},
    catalogs: { knowledge: { published: 2 } },
    message: 'The knowledge base has only 2 answers',
    clearedBy: { knowledge: { published: 12 } },
  },
  {
    code: 'after_hours_without_hours',
    severity: 'error',
    patch: { hours: { mode: 'after_hours' } },
    catalogs: { businessHours: null },
    message: 'After-hours mode needs your business hours',
    clearedBy: { businessHours: WEEKDAYS_8_TO_5 },
  },
  {
    code: 'quiet_hours_overlap',
    severity: 'warning',
    patch: { hours: { mode: 'custom', custom: [{ day: 1, start: '07:00', end: '22:00' }] } },
    message: 'Its hours overlap quiet hours (9:00 PM–8:00 AM), when it only answers new texts',
    clearedBy: { quietHours: { enabled: false, start: '21:00', end: '08:00' } },
  },
  {
    code: 'double_texting',
    severity: 'warning',
    patch: {},
    catalogs: { newLeadTextWorkflows: [{ id: SPEED_WF, name: 'Speed to lead' }] },
    message: '“Speed to lead” also texts new leads',
  },
];

const presets = TEAMMATE_PRESET_KEYS.map(
  (key) => [key, teammateConfigFromPreset(key, presetContext)] as const,
);
const codes = (patch: TeammatePatch, cats: TeammateCatalogs = catalogs) =>
  validateTeammate(applyTeammatePatch(base(), patch), cats, NOW).map((i) => i.code);
const issueOf = (patch: TeammatePatch, code: TeammateIssueCode, cats = catalogs) =>
  validateTeammate(applyTeammatePatch(base(), patch), cats, NOW).find((i) => i.code === code)!;

it('has one case per rule', () => {
  expect(CASES.map((c) => c.code).sort()).toEqual([...TEAMMATE_ISSUE_CODES].sort());
});

it('the blank start and every preset validate clean', () => {
  expect(validateTeammate(base(), catalogs, NOW)).toEqual([]);
  for (const [key, config] of presets)
    expect(validateTeammate(config, catalogs, NOW), key).toEqual([]);
});

describe.each(CASES)('$code', (c) => {
  const cats = { ...catalogs, ...c.catalogs };
  const config = applyTeammatePatch(base(), c.patch);
  const issue = validateTeammate(config, cats, NOW).find((i) => i.code === c.code);

  it('fires on the smallest settings, with a short message', () => {
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe(c.severity);
    expect(issue!.message).toBe(c.message);
    expect(issue!.fields.length).toBeGreaterThan(0);
    expect(issue!.fixes.length).toBeGreaterThan(0);
  });

  it('never fires on a preset', () => {
    for (const [key, preset] of presets)
      expect(
        validateTeammate(preset, catalogs, NOW).map((i) => i.code),
        key,
      ).not.toContain(c.code);
  });

  it('is cleared by its first patch fix', () => {
    const fix = issue!.fixes.find(isPatchFix);
    if (!fix)
      return expect(
        c.clearedBy,
        'a rule with only link fixes names what they set up',
      ).toBeDefined();
    const fixed = applyTeammatePatch(config, fix.patch);
    expect(validateTeammate(fixed, cats, NOW).map((i) => i.code)).not.toContain(c.code);
  });

  it('is cleared by what its link fixes set up', () => {
    if (!issue!.fixes.some((f) => !isPatchFix(f))) return;
    if (!c.clearedBy) return; // the link is a second way; the patch fix above clears it
    expect(
      validateTeammate(config, { ...cats, ...c.clearedBy }, NOW).map((i) => i.code),
    ).not.toContain(c.code);
  });

  it('every patch fix applies to a valid document, and links stay inside the workspace', () => {
    for (const fix of issue!.fixes) {
      if (isPatchFix(fix))
        expect(() => applyTeammatePatch(config, fix.patch), fix.id).not.toThrow();
      else expect(fix.href, fix.id).toMatch(/^[a-z][a-z0-9/_-]*$/);
    }
  });

  it('blocks turning it on only when it’s an error', () => {
    expect(hasBlockingTeammateIssues([issue!])).toBe(c.severity === 'error');
  });
});

it('offers the second fixes too', () => {
  const ids = (c: Case) => {
    const cats = { ...catalogs, ...c.catalogs };
    return validateTeammate(applyTeammatePatch(base(), c.patch), cats, NOW)
      .find((i) => i.code === c.code)!
      .fixes.map((f) => f.id);
  };
  expect(Object.fromEntries(CASES.map((c) => [c.code, ids(c)]))).toEqual({
    no_channel: ['email_on', 'chat_on', 'sms_on'],
    texting_not_ready: ['set_up_texting', 'sms_off'],
    no_email_address: ['use_address', 'email_off'],
    no_chat_widget: ['use_widget', 'chat_off'],
    booking_needs_calendar: ['add_calendar', 'booking_off'],
    calendar_not_bookable: ['remove_calendar', 'open_calendar'],
    no_qualifying_questions: ['add_suggested', 'qualify_off'],
    nobody_to_notify: ['notify_admins', 'notify_person'],
    thin_knowledge: ['add_answers'],
    after_hours_without_hours: ['work_always', 'set_business_hours'],
    quiet_hours_overlap: ['trim_hours', 'change_quiet_hours'],
    double_texting: ['new_leads_off', 'open_workflow'],
  });
});

describe('channels', () => {
  it('link to setting up an address or widget when the business has none', () => {
    const cats = { ...catalogs, emailAddresses: [], chatWidgets: [] };
    const email = issueOf({}, 'no_email_address', cats);
    expect(email.message).toBe('The address it emailed from was removed');
    expect(email.fixes).toEqual([
      { id: 'add_address', label: 'Add an email address', href: 'settings/email' },
      { id: 'email_off', label: 'Turn off email', patch: { channels: { email: false } } },
    ]);
    const chat = issueOf({}, 'no_chat_widget', cats);
    expect(chat.message).toBe('The website chat it answered was removed');
    expect(chat.fixes.map((f) => f.id)).toEqual(['set_up_chat', 'chat_off']);
  });
});

describe('booking', () => {
  it('names archived and deleted calendars', () => {
    const gone = uid(799);
    const issues = validateTeammate(
      applyTeammatePatch(base(), { book: { enabled: true, calendarIds: [OLD_CAL, gone] } }),
      catalogs,
      NOW,
    ).filter((i) => i.code === 'calendar_not_bookable');
    expect(issues.map((i) => [i.message, i.fixes.map((f) => f.id)])).toEqual([
      ['Old calendar was archived', ['remove_calendar']],
      ['A calendar it books on was deleted', ['remove_calendar']],
    ]);
  });

  it('links to making a calendar when none can be booked online', () => {
    const cats = { ...catalogs, calendars: catalogs.calendars.filter((c) => !c.bookableOnline) };
    const issue = issueOf(
      { book: { enabled: true, calendarIds: [] } },
      'booking_needs_calendar',
      cats,
    );
    expect(issue.fixes.map((f) => f.id)).toEqual(['new_calendar', 'booking_off']);
  });
});

describe('who hears about things', () => {
  it('warns when nobody hears about qualified leads', () => {
    const patch: TeammatePatch = {
      qualify: {
        enabled: true,
        questions: [{ id: 'q', question: 'Budget?' }],
        whenQualified: { notify: { kind: 'users', userIds: [JESS] } },
      },
    };
    const issue = issueOf(patch, 'nobody_to_notify');
    expect(issue).toMatchObject({
      severity: 'warning',
      message: 'Nobody hears about qualified leads',
      fields: ['qualify.whenQualified.notify'],
    });
    expect(issue.fixes.map((f) => f.id)).toEqual(['notify_admins', 'notify_nobody']);
    const quiet = applyTeammatePatch(applyTeammatePatch(base(), patch), {
      qualify: { whenQualified: { notify: null } },
    });
    expect(validateTeammate(quiet, catalogs, NOW)).toEqual([]);
  });

  it('can’t know the lead’s assignee ahead of time, so it trusts it', () => {
    expect(codes({ handOff: { notify: { kind: 'lead_assignee' } } })).toEqual([]);
  });
});

describe('knowledge', () => {
  it('says when the knowledge base is empty or the profile is thin, only while it answers questions', () => {
    expect(
      issueOf({}, 'thin_knowledge', { ...catalogs, knowledge: { published: 0 } }).message,
    ).toBe('The knowledge base is empty, so it can’t answer questions');
    const profile = issueOf({}, 'thin_knowledge', {
      ...catalogs,
      profile: { filled: 2, total: 7 },
    });
    expect(profile.message).toBe('The business profile is mostly empty');
    expect(profile.fixes).toEqual([
      { id: 'fill_profile', label: 'Fill in the business profile', href: 'knowledge/profile' },
    ]);
    expect(
      codes({ answer: { enabled: false } }, { ...catalogs, knowledge: { published: 0 } }),
    ).toEqual([]);
  });
});

describe('hours', () => {
  const fixOf = (patch: TeammatePatch, cats = catalogs) =>
    issueOf(patch, 'quiet_hours_overlap', cats).fixes.find(isPatchFix);

  it('trims its hours out of quiet hours, across midnight', () => {
    const fix = fixOf({
      hours: {
        mode: 'custom',
        custom: [
          { day: 1, start: '09:00', end: '17:00' },
          { day: 5, start: '18:00', end: '24:00' },
          { day: 6, start: '00:00', end: '02:00' },
        ],
      },
    });
    expect(fix?.patch).toEqual({
      hours: {
        custom: [
          { day: 1, start: '09:00', end: '17:00' },
          { day: 5, start: '18:00', end: '21:00' },
        ],
      },
    });
  });

  it('only links to quiet hours when its hours are all inside them', () => {
    const issue = issueOf(
      { hours: { mode: 'custom', custom: [{ day: 2, start: '22:00', end: '23:00' }] } },
      'quiet_hours_overlap',
    );
    expect(issue.fixes).toEqual([
      { id: 'change_quiet_hours', label: 'Change quiet hours', href: 'settings/texting' },
    ]);
  });

  it('leaves quiet hours alone when it can’t text, quiet hours are off, or it works set to always', () => {
    const night = { mode: 'custom' as const, custom: [{ day: 1, start: '07:00', end: '22:00' }] };
    expect(codes({ hours: night, channels: { sms: false } })).toEqual([]);
    expect(
      codes(
        { hours: night },
        { ...catalogs, quietHours: { ...catalogs.quietHours, enabled: false } },
      ),
    ).toEqual([]);
    expect(codes({ hours: { mode: 'always' } })).toEqual([]);
    expect(codes({ hours: { mode: 'after_hours' } })).toEqual([]);
  });
});

describe('double texting', () => {
  it('counts several workflows, and minds only texts to new leads', () => {
    const two = {
      ...catalogs,
      newLeadTextWorkflows: [
        { id: SPEED_WF, name: 'Speed to lead' },
        { id: SPEED_WF_2, name: 'Web form follow-up' },
      ],
    };
    expect(issueOf({}, 'double_texting', two).message).toBe('2 workflows also text new leads');
    expect(codes({ respond: { newLeads: { channel: 'email' } } }, two)).toEqual([]);
    expect(codes({ respond: { newLeads: { enabled: false } } }, two)).toEqual([]);
    expect(codes({ respond: { enabled: false } }, two)).toEqual([]);
  });

  it('knows which workflows text new leads', () => {
    expect(workflowTextsNewLeads(recipeDefinition('speed_to_lead'))).toBe(true);
    expect(workflowTextsNewLeads(recipeDefinition('speed_to_lead_ai'))).toBe(false);
    expect(workflowTextsNewLeads(recipeDefinition('missed_call_text_back'))).toBe(false);
  });
});

it('saving is never blocked: only turning it on checks for errors', () => {
  const issues = validateTeammate(
    applyTeammatePatch(base(), { book: { enabled: true, calendarIds: [] } }),
    catalogs,
    NOW,
  );
  expect(hasBlockingTeammateIssues(issues)).toBe(true);
  expect(hasBlockingTeammateIssues(validateTeammate(base(), catalogs, NOW))).toBe(false);
});

it('writes messages and labels with curly apostrophes', () => {
  for (const c of CASES) {
    const cats = { ...catalogs, ...c.catalogs };
    for (const issue of validateTeammate(applyTeammatePatch(base(), c.patch), cats, NOW)) {
      expect(issue.message).not.toMatch(/'/);
      for (const fix of issue.fixes) expect(fix.label).not.toMatch(/'/);
    }
  }
});
