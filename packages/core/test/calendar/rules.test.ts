import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  configFromPreset,
  defaultConfig,
  hasBlockingIssues,
  ISSUE_CODES,
  PRESET_KEYS,
  validateCalendar,
  type CalendarCatalogs,
  type ConfigPatch,
  type IssueCode,
} from '../../src/calendar/index';
import {
  catalogs,
  DALE,
  DUCT,
  JESS,
  NOW,
  OLD_VAN,
  presetContext,
  PRIYA,
  SALES,
  SOUTH,
  STAGE_OLD,
  TRUCK,
} from './fixtures';

interface Case {
  readonly code: IssueCode;
  readonly severity: 'error' | 'warning';
  readonly patch: ConfigPatch;
  readonly catalogs?: Partial<CalendarCatalogs>;
  readonly message: string;
}

const me = { userId: DALE };
const address = { options: [{ kind: 'customer_address' as const }] };

/** The smallest settings that trigger each rule. */
const CASES: Case[] = [
  {
    code: 'collective_needs_two',
    severity: 'error',
    patch: { team: { members: [me], assignment: 'collective' } },
    message: 'Collective needs at least two people',
  },
  {
    code: 'crew_exceeds_team',
    severity: 'error',
    patch: { team: { members: [me, { userId: PRIYA }], assignment: 'round_robin', crewSize: 3 } },
    message: 'Crew of 3 but only 2 people',
  },
  {
    code: 'weights_ignored',
    severity: 'warning',
    patch: { team: { members: [{ userId: DALE, weight: 3 }] } },
    message: 'Weights only matter for weighted round robin',
  },
  {
    code: 'choice_with_one',
    severity: 'warning',
    patch: { team: { members: [me], assignment: 'customer_choice' } },
    message: 'Customer’s choice with one person',
  },
  {
    code: 'sessions_multi_duration',
    severity: 'error',
    patch: { schedule: { mode: 'sessions' }, durations: { minutes: [30, 60] } },
    message: 'Fixed sessions use one length',
  },
  {
    code: 'sessions_customer_series',
    severity: 'error',
    patch: { schedule: { mode: 'sessions' }, recurring: { customerSeries: true } },
    message: 'Customers can’t repeat fixed sessions',
  },
  {
    code: 'travel_without_visits',
    severity: 'warning',
    patch: { buffers: { travelMinutes: 30 } },
    message: 'Travel time needs a customer-address location',
  },
  {
    code: 'zip_without_visits',
    severity: 'error',
    patch: { territory: { routing: 'zip' } },
    message: 'ZIP routing needs a customer-address location',
  },
  {
    code: 'zip_uncovered',
    severity: 'warning',
    patch: {
      team: { members: [{ userId: PRIYA }] },
      territory: { routing: 'zip', territoryIds: [SOUTH] },
      locations: address,
    },
    message: 'Priya isn’t in any selected territory',
  },
  {
    code: 'party_over_seats',
    severity: 'error',
    patch: { capacity: { seats: 2, maxPartySize: 3 } },
    message: 'Party size larger than seats',
  },
  {
    code: 'resource_archived',
    severity: 'error',
    patch: { resources: { required: [{ resourceId: OLD_VAN }] } },
    message: 'Old van was archived',
  },
  {
    code: 'resource_quantity',
    severity: 'error',
    patch: { resources: { required: [{ resourceId: TRUCK, quantity: 3 }] } },
    message: 'Truck 2: needs 3 but only 2 exist',
  },
  {
    code: 'service_no_staff',
    severity: 'error',
    patch: { team: { members: [me] }, services: { mode: 'one', items: [{ serviceId: DUCT }] } },
    message: 'No one on this calendar can do Duct cleaning',
  },
  {
    code: 'duration_no_fit',
    severity: 'warning',
    patch: {
      team: { members: [me] },
      schedule: { hours: [{ day: 1, start: '09:00', end: '12:00' }] },
      durations: { minutes: [240] },
    },
    message: '4 hours doesn’t fit in any open window',
  },
  {
    code: 'window_inverted',
    severity: 'error',
    patch: { window: { minNoticeMinutes: 3 * 1440, maxDaysAhead: 2 } },
    message: 'Maximum notice shorter than minimum notice',
  },
  {
    code: 'window_past',
    severity: 'warning',
    patch: { window: { dateFrom: '2026-08-01', dateTo: '2026-09-12' } },
    message: 'Date range already ended',
  },
  {
    code: 'payment_unavailable',
    severity: 'error',
    patch: { payments: { mode: 'deposit' } },
    message: 'Payments arrive with Milestone 9',
  },
  {
    code: 'member_gone',
    severity: 'error',
    patch: { team: { members: [{ userId: JESS }] } },
    message: 'Jess is no longer on the team',
  },
  {
    code: 'public_without_team',
    severity: 'error',
    patch: { public: true },
    message: 'A public calendar needs someone to book',
  },
  {
    code: 'lead_stage_gone',
    severity: 'error',
    patch: { crm: { createLead: { pipelineId: SALES, stageId: STAGE_OLD } } },
    message: 'The lead stage was archived',
  },
  {
    code: 'text_not_ready',
    severity: 'warning',
    patch: {},
    catalogs: { textingReady: false },
    message: 'Text reminders wait until texting is set up',
  },
];

const presets = PRESET_KEYS.map((key) => [key, configFromPreset(key, presetContext)] as const);

it('has one case per rule', () => {
  expect(CASES.map((c) => c.code).sort()).toEqual([...ISSUE_CODES].sort());
});

it('defaults and every preset validate clean', () => {
  expect(validateCalendar(defaultConfig(), catalogs, NOW)).toEqual([]);
  for (const [key, config] of presets)
    expect(validateCalendar(config, catalogs, NOW), key).toEqual([]);
});

describe.each(CASES)('$code', (c) => {
  const cats = { ...catalogs, ...c.catalogs };
  const config = applyPatch(defaultConfig(), c.patch);
  const issues = validateCalendar(config, cats, NOW);
  const issue = issues.find((i) => i.code === c.code);

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
        validateCalendar(preset, catalogs, NOW).map((i) => i.code),
        key,
      ).not.toContain(c.code);
  });

  it('is cleared by its first fix', () => {
    const fixed = applyPatch(config, issue!.fixes[0]!.patch);
    expect(validateCalendar(fixed, cats, NOW).map((i) => i.code)).not.toContain(c.code);
  });

  it('every fix applies to a valid document', () => {
    for (const fix of issue!.fixes)
      expect(() => applyPatch(config, fix.patch), fix.id).not.toThrow();
  });
});

it('offers the plan’s second fixes too', () => {
  const labels = (patch: ConfigPatch, code: IssueCode) =>
    validateCalendar(applyPatch(defaultConfig(), patch), catalogs, NOW)
      .find((i) => i.code === code)!
      .fixes.map((f) => f.id);
  expect(labels(CASES[0]!.patch, 'collective_needs_two')).toEqual([
    'switch_to_fixed',
    'add_teammate',
  ]);
  expect(labels(CASES[2]!.patch, 'weights_ignored')).toEqual([
    'clear_weights',
    'switch_to_weighted',
  ]);
  expect(labels(CASES[6]!.patch, 'travel_without_visits')).toEqual([
    'travel_zero',
    'add_customer_address',
  ]);
  expect(labels(CASES[7]!.patch, 'zip_without_visits')).toEqual([
    'routing_off',
    'add_customer_address',
  ]);
  expect(labels(CASES[12]!.patch, 'service_no_staff')).toEqual([
    'add_eligible_staff',
    'remove_service',
  ]);
  expect(labels(CASES[13]!.patch, 'duration_no_fit')).toEqual(['shorten', 'widen_hours']);
  expect(labels(CASES[18]!.patch, 'public_without_team')).toEqual(['add_person', 'make_private']);
  expect(labels(CASES[19]!.patch, 'lead_stage_gone')).toEqual(['pick_stage', 'lead_off']);
});

it('adds the eligible person to a narrowed service list', () => {
  const config = applyPatch(defaultConfig(), {
    team: { members: [me] },
    services: { mode: 'one', items: [{ serviceId: DUCT, overrides: { userIds: [DALE] } }] },
  });
  const issue = validateCalendar(config, catalogs, NOW).find((i) => i.code === 'service_no_staff')!;
  const fixed = applyPatch(config, issue.fixes[0]!.patch);
  expect(validateCalendar(fixed, catalogs, NOW).map((i) => i.code)).not.toContain(
    'service_no_staff',
  );
});

it('only warnings leave a calendar saveable', () => {
  const warn = validateCalendar(applyPatch(defaultConfig(), CASES[6]!.patch), catalogs, NOW);
  const err = validateCalendar(applyPatch(defaultConfig(), CASES[7]!.patch), catalogs, NOW);
  expect(hasBlockingIssues(warn)).toBe(false);
  expect(hasBlockingIssues(err)).toBe(true);
});

it('writes messages and labels with curly apostrophes', () => {
  for (const c of CASES) {
    const cats = { ...catalogs, ...c.catalogs };
    for (const issue of validateCalendar(applyPatch(defaultConfig(), c.patch), cats, NOW)) {
      expect(issue.message).not.toMatch(/'/);
      for (const fix of issue.fixes) expect(fix.label).not.toMatch(/'/);
    }
  }
});
