import { describe, expect, it } from 'vitest';
import {
  analyzeImpact,
  applyPatch,
  configFromPreset,
  defaultConfig,
  diffConfigs,
  formatLabels,
  inferLabels,
  undecidedImpacts,
  type ConfigPatch,
  type UpcomingSummary,
} from '../../src/calendar/index';
import { catalogs, DALE, MARCO, presetContext, PRIYA, SALES, STAGE_NEW, TRUCK, TUNE_UP } from './fixtures';

const labelsOf = (patch: ConfigPatch) => inferLabels(applyPatch(defaultConfig(), patch));
const two = [{ userId: DALE }, { userId: PRIYA }];

describe('labels', () => {
  it('names each preset', () => {
    const primary = (key: Parameters<typeof configFromPreset>[0], ctx = presetContext) =>
      inferLabels(configFromPreset(key, ctx)).primary;
    expect(primary('personal')).toBe('personal');
    expect(primary('round_robin')).toBe('round_robin');
    expect(primary('service')).toBe('service');
    expect(primary('group')).toBe('group');
    expect(primary('event')).toBe('event');
    expect(primary('resource', { me: DALE, resources: [TRUCK] })).toBe('resource');
    expect(primary('collective')).toBe('collective');
    expect(primary('dispatch')).toBe('dispatch');
    expect(primary('scratch')).toBe('custom');
  });

  it('follows the plan’s precedence and lists every tag', () => {
    const acTuneUp = labelsOf({
      team: { members: two, assignment: 'round_robin' },
      services: { mode: 'choice', items: [{ serviceId: TUNE_UP }] },
      territory: { routing: 'zip' },
      buffers: { travelMinutes: 30 },
      locations: { options: [{ kind: 'customer_address' }] },
    });
    expect(formatLabels(acTuneUp)).toBe('Dispatch · Round Robin · Service');
    expect(acTuneUp.primary).toBe('dispatch');

    const hvacClass = labelsOf({ team: { members: [{ userId: DALE }] }, schedule: { mode: 'sessions' }, capacity: { seats: 12 }, waitlist: { enabled: true } });
    expect(hvacClass.tags).toEqual(['event', 'group']);

    const walkthrough = labelsOf({ team: { members: two.map((m) => ({ ...m, required: true })), assignment: 'collective' } });
    expect(walkthrough.tags).toEqual(['collective']);

    expect(labelsOf({ team: { members: two, assignment: 'round_robin', crewSize: 2 } }).tags).toEqual(['collective', 'round_robin']);
    expect(labelsOf({ team: { members: [{ userId: DALE }] }, buffers: { travelMinutes: 15 } }).tags).toEqual(['dispatch', 'personal']);
    expect(labelsOf({ team: { members: two, assignment: 'weighted' } }).primary).toBe('round_robin');
    expect(labelsOf({ team: { members: [{ userId: DALE }], assignment: 'round_robin' } }).tags).toEqual(['custom']);
    expect(labelsOf({ team: { members: two, assignment: 'first_available' } }).tags).toEqual(['custom']);
    expect(labelsOf({ team: { members: two, assignment: 'customer_choice' } }).primary).toBe('custom');
    expect(labelsOf({ team: { members: [{ userId: DALE }] }, resources: { required: [{ resourceId: TRUCK }] } }).tags).toEqual([
      'resource',
      'personal',
    ]);
  });

  it('changes as a Personal calendar becomes Round Robin, then Service, then Group', () => {
    const personal = configFromPreset('personal', presetContext);
    expect(formatLabels(inferLabels(personal))).toBe('Personal');
    const rr = applyPatch(personal, { team: { members: [{ userId: PRIYA }, { userId: MARCO }], assignment: 'round_robin' } });
    expect(formatLabels(inferLabels(rr))).toBe('Round Robin');
    const service = applyPatch(rr, { services: { mode: 'choice', items: [{ serviceId: TUNE_UP }] } });
    expect(formatLabels(inferLabels(service))).toBe('Round Robin · Service');
    const group = applyPatch(service, { capacity: { seats: 6 } });
    expect(formatLabels(inferLabels(group))).toBe('Group/Class · Round Robin · Service');
  });
});

describe('diff', () => {
  const personal = configFromPreset('personal', presetContext);

  it('is empty when nothing changed', () => {
    expect(diffConfigs(personal, applyPatch(personal, {}), catalogs)).toEqual([]);
  });

  it('describes team and assignment changes by name', () => {
    const rr = applyPatch(personal, { team: { members: [{ userId: PRIYA }, { userId: MARCO }], assignment: 'round_robin' } });
    expect(diffConfigs(personal, rr, catalogs)).toEqual([
      'Added Priya',
      'Added Marco',
      'Removed Dale',
      'Assignment: fixed person → round robin',
    ]);
    const weighted = applyPatch(rr, { team: { members: [{ userId: PRIYA, weight: 3 }, { userId: MARCO }], assignment: 'weighted' } });
    expect(diffConfigs(rr, weighted, catalogs)).toEqual(['Priya’s weight: 1 → 3', 'Assignment: round robin → weighted round robin']);
  });

  it('describes capacity, services, visits, notice, hours, reminders and CRM', () => {
    const after = applyPatch(personal, {
      capacity: { seats: 10, maxPartySize: 4 },
      waitlist: { enabled: true },
      services: { mode: 'choice', items: [{ serviceId: TUNE_UP }] },
      locations: { options: [{ kind: 'customer_address' }] },
      buffers: { travelMinutes: 30 },
      territory: { routing: 'zip' },
      window: { minNoticeMinutes: 1440 },
      schedule: { hours: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })) },
      notifications: { reminders: [{ kind: 'before', minutes: 60 }] },
      crm: { createLead: { pipelineId: SALES, stageId: STAGE_NEW } },
    });
    expect(diffConfigs(personal, after, catalogs)).toEqual([
      'Services: off → customer picks',
      'Added AC tune-up',
      'Seats: 1 → 10',
      'Largest party: 1 → 4',
      'Calendar hours: none → Mon–Fri 9:00 AM–5:00 PM',
      'Locations: none → customer’s address',
      'Travel time: none → 30 minutes',
      'ZIP routing: off → on',
      'Minimum notice: 4 hours → 1 day',
      'Waitlist: off → on',
      'Reminders: day before at 4:00 PM, 2 hours before → 1 hour before',
      'Create a lead: off → Sales · New',
    ]);
  });

  it('works without catalogs', () => {
    const rr = applyPatch(personal, { team: { members: [{ userId: PRIYA }] } });
    expect(diffConfigs(personal, rr)).toEqual(['Added Someone', 'Removed Someone']);
  });
});

describe('impact', () => {
  const team = applyPatch(defaultConfig(), {
    team: { members: [{ userId: DALE }, { userId: PRIYA }, { userId: MARCO }], assignment: 'round_robin' },
    capacity: { seats: 10 },
    resources: { required: [{ resourceId: TRUCK }] },
  });
  const upcoming: UpcomingSummary = {
    members: [
      { userId: MARCO, appointments: 3 },
      { userId: DALE, appointments: 2 },
      { userId: PRIYA, appointments: 0 },
    ],
    resources: [{ resourceId: TRUCK, appointments: 4 }],
    sessions: [
      { appointmentId: 'a1', seatsBooked: 8 },
      { appointmentId: 'a2', seatsBooked: 5 },
    ],
  };

  it('asks about removed people who have upcoming appointments', () => {
    const after = applyPatch(team, { team: { members: [{ userId: DALE }] } });
    const { impacts, requiresReview } = analyzeImpact(team, after, upcoming, catalogs);
    expect(requiresReview).toBe(true);
    expect(impacts).toEqual([
      {
        key: `member:${MARCO}`,
        code: 'member_removed',
        message: 'Marco has 3 upcoming appointments',
        count: 3,
        userId: MARCO,
        decisions: ['keep', 'reassign', 'cancel_and_notify'],
      },
    ]);
  });

  it('cannot reassign when nobody is left', () => {
    const after = applyPatch(team, { team: { members: [] } });
    const impacts = analyzeImpact(team, after, upcoming, catalogs).impacts;
    expect(impacts.map((i) => i.userId)).toEqual([DALE, MARCO]);
    expect(impacts.every((i) => !i.decisions.includes('reassign'))).toBe(true);
  });

  it('flags seats below what upcoming sessions already hold, keeping existing bookings', () => {
    const after = applyPatch(team, { capacity: { seats: 6 } });
    const [impact] = analyzeImpact(team, after, upcoming, catalogs).impacts;
    expect(impact).toEqual({
      key: 'seats',
      code: 'seats_below_booked',
      message: '1 upcoming session already has more people than the new seats',
      count: 1,
      appointmentIds: ['a1'],
      decisions: ['keep'],
    });
    const unchanged = applyPatch(team, { capacity: { seats: 10 }, waitlist: { enabled: true } });
    expect(analyzeImpact(team, unchanged, upcoming).requiresReview).toBe(false);
  });

  it('asks about removed resources with upcoming appointments', () => {
    const after = applyPatch(team, { resources: { required: [] } });
    expect(analyzeImpact(team, after, upcoming, catalogs).impacts).toEqual([
      {
        key: `resource:${TRUCK}`,
        code: 'resource_removed',
        message: 'Truck 2 is on 4 upcoming appointments',
        count: 4,
        resourceId: TRUCK,
        decisions: ['keep', 'cancel_and_notify'],
      },
    ]);
  });

  it('tracks which impacts still need a decision', () => {
    const after = applyPatch(team, { team: { members: [{ userId: DALE }] }, capacity: { seats: 6 } });
    const analysis = analyzeImpact(team, after, upcoming, catalogs);
    expect(undecidedImpacts(analysis, {}).map((i) => i.key)).toEqual([`member:${MARCO}`, 'seats']);
    expect(undecidedImpacts(analysis, { [`member:${MARCO}`]: 'reassign', seats: 'cancel_and_notify' }).map((i) => i.key)).toEqual(['seats']);
    expect(undecidedImpacts(analysis, { [`member:${MARCO}`]: 'keep', seats: 'keep' })).toEqual([]);
  });
});
