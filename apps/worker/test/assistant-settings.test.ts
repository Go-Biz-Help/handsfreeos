import { randomUUID } from 'node:crypto';
import {
  ADDON_STATE_WORDS,
  assistantToolByName,
  AssistantCard,
  bookingSiteSetPage,
  calendarCreate,
  calendarSave,
  catalogAddon,
  executeCommand,
  executeQuery,
  hasWorkspacePermission,
  leadCreate,
  localMinutes,
  money,
  organizationCreate,
  PERMISSION_GROUPS,
  personCreate,
  phoneUpdateSettings,
  registry,
  resourceCreate,
  ROLE_DESCRIPTIONS,
  serviceCreate,
  SETTINGS_AREAS,
  settingsArea,
  TEAMMATE_TOOL_NAMES,
  settingsMapText,
  workspaceUpdate,
  type CalendarConfig,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import pino from 'pino';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import { settingsReadTools } from '../src/assistant/tools-settings';
import { settingsBusinessConfirmTools } from '../src/assistant/tools-settings-business';
import { settingsCalendarConfirmTools } from '../src/assistant/tools-settings-calendar';
import { settingsChannelConfirmTools } from '../src/assistant/tools-settings-channels';
import { settingsMeConfirmTools } from '../src/assistant/tools-settings-me';
import { settingsMoneyConfirmTools } from '../src/assistant/tools-settings-money';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';
import { createFakeGeocoder } from '../src/geo/geocoder';
import type { WorkerServices } from '../src/services';
import { createFakeTelephony, FAKE_MASTER_SID } from '../src/telephony/fake';

/**
 * Setting the business up by asking (M12), step one: the Assistant can read how any part of the business is set
 * up, and knows where each part lives and what only the person can do. Both tools run on their own — they change
 * nothing — and a part someone's role may not see comes back as "not yours to see", never as a failure.
 */

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) =>
  (
    await executeCommand(api(), cmd, input, actor(u), {
      correlationId: randomUUID(),
      channel: 'test' as const,
    })
  ).output;

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
/** Booking-site addresses are unique across every business, so this run gets its own name. */
const suffix = randomUUID().slice(0, 8);
const businessName = `Settings HVAC ${suffix}`;

const ctxFor = (u: TestUser): ToolContext => ({
  actor: actor(u),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});

/** Runs one of the two read tools the way the runtime does. */
const readTool = async (name: 'get_settings' | 'settings_help', area: string, u: TestUser) => {
  const tool = assistantToolByName.get(name)!;
  const out = await createToolExecutor(api()).run(tool, { area }, ctxFor(u));
  return out as { result: Record<string, unknown>; card?: AssistantCard };
};

beforeAll(async () => {
  owner = await createTestUser('aset-dale', { fullName: 'Dale Owner' });
  const org = (await run(organizationCreate, { businessName, timezone: CHI }, owner)) as {
    workspaceId: string;
    organizationId: string;
  };
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  const service = (await run(
    serviceCreate,
    { workspaceId, name: 'AC tune-up', durations: [60] },
    owner,
  )) as { serviceId: string };
  await run(
    calendarCreate,
    {
      workspaceId,
      name: 'Service calls',
      teammates: [owner.id],
      services: [service.serviceId],
      resources: [],
    },
    owner,
  );
}, 60_000);

afterAll(closeTestDbs);

describe('the settings map', () => {
  it('names every part of the setup, where it lives, and what only the person can do', () => {
    for (const area of SETTINGS_AREAS) {
      const info = settingsArea(area);
      expect(info.label, area).toBeTruthy();
      expect(info.what, area).toBeTruthy();
      expect(info.path.startsWith('/'), area).toBe(true);
      // Everything is either something it can change or something it hands back — never neither.
      expect(info.canChange.length + info.handovers.length, area).toBeGreaterThan(0);
      for (const h of info.handovers)
        expect(h.steps.length, `${area}: ${h.what}`).toBeGreaterThan(0);
    }
    const text = settingsMapText();
    for (const area of SETTINGS_AREAS) expect(text).toContain(settingsArea(area).label);
    // The things people are told to do elsewhere are in the fixed prompt, so it never invents steps.
    expect(text).toContain('connect Stripe or Square');
    expect(text).toContain('put the chat box on your website');
  });

  it('is never handed to the AI teammate: it answers customers, it does not set the business up', () => {
    // The tools themselves, not a guess from their names: update_customer is the teammate's, and rightly.
    const settingsTools = [
      ...Object.keys(settingsReadTools),
      ...Object.keys(settingsCalendarConfirmTools),
      ...Object.keys(settingsBusinessConfirmTools),
      ...Object.keys(settingsChannelConfirmTools),
      ...Object.keys(settingsMoneyConfirmTools),
      ...Object.keys(settingsMeConfirmTools),
    ];
    expect(settingsTools.length).toBe(25);
    for (const name of settingsTools) expect(assistantToolByName.get(name), name).toBeTruthy();
    for (const name of settingsTools)
      expect(TEAMMATE_TOOL_NAMES as readonly string[], name).not.toContain(name);
  });

  it('is offered to anyone who may use the Assistant, and changes nothing on its own', () => {
    for (const name of ['get_settings', 'settings_help'] as const) {
      const tool = assistantToolByName.get(name)!;
      expect(tool.autonomy, name).toBe('auto');
      expect(executorFor(name), name).toBeTruthy();
    }
    const member = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    expect(member).toContain('get_settings');
    expect(member).toContain('settings_help');
  });
});

describe('get_settings', () => {
  it('reads the business as it really is, and says where it is changed', async () => {
    const { result } = await readTool('get_settings', 'business', owner);
    expect(result['where']).toBe('Settings → Workspace');
    expect(JSON.stringify(result['business'])).toContain(businessName);
    expect(result['canChange']).toContain('open hours');
  });

  it('reads a part that has something in it, and one that has nothing yet', async () => {
    const calendars = await readTool('get_settings', 'calendars', owner);
    expect(JSON.stringify(calendars.result['calendars'])).toContain('Service calls');
    expect(calendars.result['theyDoThemselves']).toContain('connect a Google or Outlook calendar');

    const territories = await readTool('get_settings', 'territories', owner);
    expect(territories.result['area']).toBe('territories');
    expect(territories.result['territories']).toBeTruthy();
  });

  it('reads the add-ons as the page shows them, and leaves every move to a person', async () => {
    const { result } = await readTool('get_settings', 'add_ons', owner);
    expect(result['where']).toBe('Add-ons');
    // Nothing built yet, as until the first add-on ships; Real Estate Agent is coming soon, and the rest are voted on.
    expect(result['addOns']).toEqual({ inThisBusiness: [], availableToAdd: [] });
    const vote = result['vote'] as { comingSoon: unknown[]; mostVotes: unknown[]; planned: number };
    // Each with its id, which do_addon_vote and do_addon_unvote take.
    expect(vote.comingSoon).toContainEqual(
      expect.objectContaining({
        addonId: 'realestate',
        name: 'Real Estate Agent',
        youVoted: false,
      }),
    );
    expect(vote.planned).toBeGreaterThan(100);
    expect(JSON.stringify(result['theyDoThemselves'])).toContain('delete an add-on’s data');

    // One in the business, turned off here, comes with its id, which manage_add_on and update_addon_settings take.
    await rows(
      testDbs().admin.db,
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${workspaceId}, 'realestate', 'disabled', ${catalogAddon('realestate').version})`,
    );
    const again = await readTool('get_settings', 'add_ons', owner);
    expect((again.result['addOns'] as { inThisBusiness: unknown[] }).inThisBusiness).toEqual([
      expect.objectContaining({
        addonId: 'realestate',
        name: 'Real Estate Agent',
        // In the page's words, with what it lets the business do.
        state: ADDON_STATE_WORDS.disabled.label,
        whatThatMeans: ADDON_STATE_WORDS.disabled.detail,
        whatItLetsYouDo: expect.arrayContaining([
          expect.objectContaining({ label: expect.any(String) }),
        ]),
      }),
    ]);
    // Coming soon leaves out the one the business has, as the page does.
    expect(
      (again.result['vote'] as { comingSoon: { addonId: string }[] }).comingSoon.map(
        (c) => c.addonId,
      ),
    ).not.toContain('realestate');
  });

  it('reads Permissions as its cards say them, with what waits on another permission', async () => {
    const setRole = (allowed: boolean | null) =>
      run(
        registry.command('permission.set_role')!,
        { workspaceId, role: 'member', permission: 'members.invite', allowed },
        owner,
      );
    await setRole(true);
    try {
      const { result } = await readTool('get_settings', 'permissions', owner);
      const read = result['permissions'] as {
        cards: {
          title: string;
          permissions: {
            permission: string;
            label: string;
            byDefault: { admins: boolean; members: boolean };
            needs?: string[];
          }[];
        }[];
        roles: { role: string; offUntil?: { permission: string; note: string }[] }[];
      };
      expect(read.cards.map((c) => c.title)).toEqual(PERMISSION_GROUPS.map((g) => g.title));
      const invite = read.cards
        .flatMap((c) => c.permissions)
        .find((p) => p.permission === 'members.invite')!;
      expect(invite).toMatchObject({
        label: 'Invite people',
        byDefault: { admins: true, members: false },
        needs: ['See pending invitations'],
      });
      // On for members, but it needs what they don't have yet, as the page greys it out.
      expect(read.roles.find((r) => r.role === 'member')!.offUntil).toEqual([
        { permission: 'Invite people', note: 'Off until “See pending invitations” is on' },
      ]);
    } finally {
      await setRole(null);
    }
  });

  it('reads Safety with how often contacts are told again, and who’s told when someone has nobody', async () => {
    const { result } = await readTool('get_settings', 'safety', owner);
    const safety = result['safety'] as {
      repeatMinutes: number;
      thenTold: string;
      nobodyToTell: string;
    };
    expect(safety.repeatMinutes).toBe(10);
    expect(safety.thenTold).toContain('every 10 minutes, for an hour');
    expect(safety.nobodyToTell).toContain('replied OK');
    expect(JSON.stringify(result)).toContain('Who’s told when someone has nobody to tell');
  });

  it('reads every part without failing, whatever is set up', async () => {
    for (const area of SETTINGS_AREAS) {
      const { result } = await readTool('get_settings', area, owner);
      expect(result['area'], area).toBe(area);
    }
  });
});

describe('settings_help', () => {
  it('gives the steps for what only the person can do, as a card that links to the screen', async () => {
    const { result, card } = await readTool('settings_help', 'payments', owner);
    const theirs = result['theyDoThemselves'] as { what: string; steps: string[] }[];
    expect(theirs[0]!.what).toBe('connect Stripe or Square');
    expect(theirs[0]!.steps.length).toBeGreaterThan(1);
    // An account that needs reconnecting is the person's own sign-in too, with Reconnect's steps.
    const reconnect = theirs.find((t) => t.what === 'reconnect a payout account that needs it')!;
    expect(reconnect.steps.join(' ')).toContain('press Reconnect');

    expect(card).toBeTruthy();
    expect(AssistantCard.safeParse(card).success).toBe(true);
    const list = card as Extract<AssistantCard, { type: 'list' }>;
    expect(list.type).toBe('list');
    expect(list.items[0]!.href).toBe(`/app/w/${workspaceId}/settings/payments`);
    expect(list.items[0]!.title).toContain('1.');
  });

  it('has no card for a part the Assistant can do all of, and still says what it can change', async () => {
    const { result, card } = await readTool('settings_help', 'pipelines', owner);
    expect(card).toBeUndefined();
    expect(result['canChange']).toContain('add, rename or archive a pipeline');
  });

  it('hands over an add-on’s data, Start fresh and its sign-ins and keys, and votes and disconnects itself', async () => {
    const { result } = await readTool('settings_help', 'add_ons', owner);
    const theirs = result['theyDoThemselves'] as { what: string; steps: string[] }[];
    expect(theirs.map((t) => t.what)).toEqual([
      'delete an add-on’s data',
      'start an add-on fresh',
      'connect an add-on to another service with a sign-in or a key',
    ]);
    for (const t of theirs) expect(t.steps.length, t.what).toBeGreaterThan(1);
    expect(result['canChange']).toEqual(
      expect.arrayContaining([
        'vote for a planned add-on as the business, or take its vote back',
        'disconnect an account the business connected for an add-on',
      ]),
    );
  });

  it('leaves only paying on the provider’s page to the person on Usage & balance: topping up and the AI limit are its to do', async () => {
    const { result } = await readTool('settings_help', 'usage', owner);
    const theirs = result['theyDoThemselves'] as { what: string; steps: string[] }[];
    expect(theirs.map((t) => t.what)).toEqual([
      'add a card, or use a different one',
      'pay a refused founding plan renewal with another card',
    ]);
    expect(theirs[1]!.steps).toContain(
      'On Your founding spot, press Pay with another card, then pay on Stripe’s page.',
    );
    expect(result['canChange']).toEqual(
      expect.arrayContaining([
        'top up the balance now, from the card on file',
        'the daily AI limit',
      ]),
    );
  });
});

/** Prepares a confirm tool the way the runtime does, then presses Confirm. */
const prepare = async (name: string, args: Record<string, unknown>, u: TestUser) => {
  const tool = assistantToolByName.get(name)!;
  const parsed = tool.input.parse(args) as Record<string, unknown>;
  const id = randomUUID();
  const { card } = await createToolExecutor(api()).prepare(tool, parsed, ctxFor(u), id);
  return { card: card as Extract<AssistantCard, { type: 'confirm' }>, parsed, tool };
};
const confirm = async (
  tool: ReturnType<typeof assistantToolByName.get> & object,
  parsed: Record<string, unknown>,
  u: TestUser,
) =>
  createToolExecutor(api()).commit(tool as never, parsed, ctxFor(u), { toolCallId: randomUUID() });

const calendars = () =>
  executeQuery(api(), registry.query('calendar.list')!, { workspaceId }, actor(owner), {
    correlationId: randomUUID(),
    channel: 'test' as const,
  }) as Promise<{ items: { id: string; name: string; status: string }[] }>;
const calendarOf = async (calendarId: string) =>
  (
    (await executeQuery(
      api(),
      registry.query('calendar.get')!,
      { workspaceId, calendarId },
      actor(owner),
      { correlationId: randomUUID(), channel: 'test' as const },
    )) as {
      calendar: { status: string; color: string; revision: number; config: CalendarConfig };
    }
  ).calendar;

describe('setting up a calendar by asking', () => {
  it('shows what it will do, changes nothing until Confirm, then sets it up', async () => {
    const before = (await calendars()).items.length;
    const { card, parsed, tool } = await prepare(
      'manage_calendar',
      {
        action: 'create',
        name: 'Duct cleaning',
        teammates: [owner.id],
        hours: [{ day: 1, start: '08:00', end: '17:00' }],
        minNoticeMinutes: 240,
      },
      owner,
    );
    expect(card.type).toBe('confirm');
    expect(card.title).toBe('Set up Duct cleaning');
    expect(card.confirmLabel).toBe('Set it up');
    expect(card.editable).toBe(false);
    expect(card.fields.map((f) => f.label)).toContain('Hours');
    expect(card.fields.find((f) => f.label === 'How it works')!.value).toBe('Start from scratch');
    expect(card.fields.find((f) => f.label === 'Notice to book')!.value).toBe('4 hours');
    expect(card.warnings[0]!.text).toContain('starts as a draft');
    expect(AssistantCard.safeParse(card).success).toBe(true);
    // Nothing happened yet: the card is a proposal.
    expect((await calendars()).items.length).toBe(before);

    const done = await confirm(tool!, parsed, owner);
    expect(done.command).toBe('calendar.create');
    expect(done.outcome).toContain('Duct cleaning');
    expect(done.outcome).toContain('isn’t taking bookings yet');
    const made = (await calendars()).items.find((c) => c.name === 'Duct cleaning');
    expect(made).toBeTruthy();
    expect(made!.status).toBe('draft');
    expect(done.href).toContain(made!.id);
    // The people asked for are on it, though Start from scratch puts nobody on.
    expect((await calendarOf(made!.id)).config.team.members.map((m) => m.userId)).toEqual([
      owner.id,
    ]);
  });

  it('sets one up from how it should work, with what each booking needs and how many', async () => {
    const { resourceId } = await run(
      resourceCreate,
      { workspaceId, name: 'Duct vacuum', quantity: 3 },
      owner,
    );
    const { card, parsed, tool } = await prepare(
      'manage_calendar',
      {
        action: 'create',
        name: 'Crew jobs',
        preset: 'round_robin',
        teammates: [owner.id],
        resources: [{ resourceId, quantity: 2 }],
        minNoticeMinutes: 1440,
        color: '#0e7490',
      },
      owner,
    );
    const shown = (label: string) => card.fields.find((f) => f.label === label)?.value;
    expect(shown('How it works')).toBe('Round Robin');
    expect(shown('Who works it')).toBe('Dale Owner');
    expect(shown('What each booking needs')).toBe('Duct vacuum × 2');
    expect(shown('Notice to book')).toBe('1 day');
    expect(shown('Colour')).toBe('teal');
    await confirm(tool!, parsed, owner);

    const made = (await calendars()).items.find((c) => c.name === 'Crew jobs')!;
    const calendar = await calendarOf(made.id);
    expect(calendar.status).toBe('draft');
    expect(calendar.color).toBe('#0e7490');
    expect(calendar.config.team.assignment).toBe('round_robin');
    expect(calendar.config.team.members.map((m) => m.userId)).toEqual([owner.id]);
    expect(calendar.config.resources.required).toEqual([{ resourceId, quantity: 2 }]);
    expect(calendar.config.window.minNoticeMinutes).toBe(1440);
  });

  it('makes nothing when what it was asked for can’t be saved, and asks for a name first', async () => {
    await expect(prepare('manage_calendar', { action: 'create' }, owner)).rejects.toThrow(
      'Name the calendar.',
    );
    const before = (await calendars()).items.length;
    // No such service: the calendar and the settings on top are one unit, so no half-made calendar is left.
    const { parsed, tool } = await prepare(
      'manage_calendar',
      { action: 'create', name: 'Gutter cleaning', services: [randomUUID()] },
      owner,
    );
    await expect(confirm(tool!, parsed, owner)).rejects.toThrow();
    expect((await calendars()).items.length).toBe(before);
    expect((await calendars()).items.some((c) => c.name === 'Gutter cleaning')).toBe(false);
  });

  it('archives one, still finds it, and brings it back as a draft', async () => {
    const id = (await calendars()).items.find((c) => c.name === 'Crew jobs')!.id;
    const archive = await prepare('manage_calendar', { action: 'archive', calendarId: id }, owner);
    expect(archive.card.title).toBe('Archive Crew jobs');
    expect(archive.card.warnings).toEqual([
      {
        kind: 'caution',
        text: 'It stops taking bookings and leaves the calendar. Its history stays.',
      },
    ]);
    await confirm(archive.tool!, archive.parsed, owner);
    // Off the list the screen opens on, but what the Assistant reads still has it, so it can bring it back.
    expect((await calendars()).items.some((c) => c.id === id)).toBe(false);
    const listed = await readTool('get_settings', 'calendars', owner);
    expect(JSON.stringify(listed.result)).toContain(id);

    const back = await prepare('manage_calendar', { action: 'to_draft', calendarId: id }, owner);
    expect(back.card.title).toBe('Bring Crew jobs back as a draft');
    const done = await confirm(back.tool!, back.parsed, owner);
    expect(done.outcome).toContain('back to a draft');
    expect((await calendars()).items.find((c) => c.id === id)!.status).toBe('draft');
    await expect(
      prepare('manage_calendar', { action: 'to_draft', calendarId: id }, owner),
    ).rejects.toThrow('Crew jobs is already a draft.');
  });

  it('pauses one, and says visits already booked stay', async () => {
    const id = (await calendars()).items.find((c) => c.name === 'Service calls')!.id;
    const { card, parsed, tool } = await prepare(
      'manage_calendar',
      { action: 'turn_off', calendarId: id },
      owner,
    );
    expect(card.title).toBe('Pause Service calls');
    expect(card.warnings[0]!.text).toContain('stay');
    await confirm(tool!, parsed, owner);
    expect((await calendars()).items.find((c) => c.id === id)!.status).toBe('paused');
  });
});

describe('setting up a service by asking', () => {
  it('prices it in dollars, and says who can do it', async () => {
    const { card, parsed, tool } = await prepare(
      'manage_service',
      {
        action: 'create',
        name: 'Furnace check',
        durationsMinutes: [45, 90],
        priceDollars: 129,
        staffUserIds: [owner.id],
      },
      owner,
    );
    expect(card.title).toBe('Add Furnace check');
    expect(card.fields.find((f) => f.label === 'Price shown')!.value).toBe('$129.00');
    expect(card.fields.find((f) => f.label === 'How long')!.value).toBe('45 min or 90 min');
    expect(card.fields.find((f) => f.label === 'Who can do it')!.value).toBe('Dale Owner');

    const done = await confirm(tool!, parsed, owner);
    expect(done.command).toBe('service.create');
    const { items } = (await executeQuery(
      api(),
      registry.query('service.list')!,
      { workspaceId },
      actor(owner),
      { correlationId: randomUUID(), channel: 'test' as const },
    )) as { items: { name: string; priceCents: number | null }[] };
    expect(items.find((s) => s.name === 'Furnace check')!.priceCents).toBe(12_900);
  });
});

describe('changing a calendar that is already set up', () => {
  it('saves on the revision it read, and keeps everything it was not asked to change', async () => {
    const id = (await calendars()).items.find((c) => c.name === 'Duct cleaning')!.id;
    const read = async () =>
      (await executeQuery(
        api(),
        registry.query('calendar.get')!,
        { workspaceId, calendarId: id },
        actor(owner),
        { correlationId: randomUUID(), channel: 'test' as const },
      )) as {
        calendar: {
          revision: number;
          config: {
            schedule: { hours: { day: number }[] | null };
            buffers: { before: number; after: number };
            window: { minNoticeMinutes: number };
          };
        };
      };
    const before = await read();

    const { card, parsed, tool } = await prepare(
      'manage_calendar',
      { action: 'change', calendarId: id, bufferBeforeMinutes: 15, bufferAfterMinutes: 30 },
      owner,
    );
    expect(card.title).toBe('Change Duct cleaning');
    expect(card.fields[0]).toEqual({ label: 'Calendar', value: 'Duct cleaning' });
    expect(card.fields.find((f) => f.label === 'Gap around a visit')!.value).toBe(
      '15 min before, 30 min after',
    );
    await confirm(tool!, parsed, owner);

    const after = await read();
    expect(after.calendar.config.buffers).toMatchObject({ before: 15, after: 30 });
    // The hours and the notice it was set up with are still there.
    expect(after.calendar.config.schedule.hours).toEqual(before.calendar.config.schedule.hours);
    expect(after.calendar.config.window.minNoticeMinutes).toBe(240);
    expect(after.calendar.revision).toBeGreaterThan(before.calendar.revision);
  });

  it('keeps each person’s weight when the team is sent again, and sets the booking rules', async () => {
    const id = (await calendars()).items.find((c) => c.name === 'Duct cleaning')!.id;
    const now = await calendarOf(id);
    await run(
      calendarSave,
      {
        workspaceId,
        calendarId: id,
        baseRevision: now.revision,
        draft: {
          ...now.config,
          team: {
            ...now.config.team,
            members: now.config.team.members.map((m) => ({ ...m, weight: 3 })),
          },
        },
        impactDecisions: {},
      },
      owner,
    );

    const { card, parsed, tool } = await prepare(
      'manage_calendar',
      {
        action: 'change',
        calendarId: id,
        teammates: [owner.id],
        maxDaysAhead: 30,
        dailyLimitPerPerson: 4,
        bookOnlyTo: '2099-12-31',
      },
      owner,
    );
    const shown = (label: string) => card.fields.find((f) => f.label === label)?.value;
    expect(shown('Who works it')).toBe('Dale Owner');
    expect(shown('Books up to')).toBe('30 days ahead');
    expect(shown('Daily limit per person')).toBe('4');
    expect(shown('Only between')).toBe('now to 2099-12-31');
    await confirm(tool!, parsed, owner);

    const after = await calendarOf(id);
    expect(after.config.team.members).toEqual([
      expect.objectContaining({ userId: owner.id, weight: 3 }),
    ]);
    expect(after.config.window).toMatchObject({
      maxDaysAhead: 30,
      dailyLimitPerPerson: 4,
      dateTo: '2099-12-31',
      minNoticeMinutes: 240,
    });
  });
});

describe('the booking page', () => {
  it('names itself after the business the first time, and says what turning it off costs', async () => {
    const site = async () =>
      (
        (await executeQuery(
          api(),
          registry.query('booking_site.get')!,
          { workspaceId },
          actor(owner),
          {
            correlationId: randomUUID(),
            channel: 'test' as const,
          },
        )) as { site: { name: string; enabled: boolean } | null }
      ).site;
    // Nothing set up yet: it takes the business's own name and a link made from it, rather than asking.
    expect(await site()).toBeNull();
    const { card, parsed, tool } = await prepare('update_booking_site', { enabled: false }, owner);
    expect(card.title).toBe('Set up your booking page');
    expect(card.fields.find((f) => f.label === 'Name')!.value).toBe(businessName);
    expect(card.fields.find((f) => f.label === 'Address')!.value).toBe(
      `/book/settings-hvac-${suffix}`,
    );
    expect(card.warnings[0]!.text).toContain('book themselves');
    await confirm(tool!, parsed, owner);
    const now = await site();
    expect(now!.enabled).toBe(false);
    expect(now!.name).toBe(businessName);
  });

  it('gives the model whole links, never a path it would have to finish', async () => {
    // The setup keeps a calendar's link as a path. Once given only that, the model guessed the address in front.
    const web = 'https://app.hfos.test';
    const executor = createToolExecutor(api(), null, null, web);
    const out = await executor.run(
      assistantToolByName.get('get_settings')!,
      { area: 'calendars' },
      ctxFor(owner),
    );
    const said = JSON.stringify(out.result);
    expect(said).toContain(`"${web}/book/settings-hvac-${suffix}/`);
    expect(said).toContain(`"${web}/book/c/`);
    expect(said).not.toContain('"/book/');
    // The card keeps the address Settings shows, and so does what the model is told about it.
    const tool = assistantToolByName.get('update_booking_site')!;
    const prepared = await executor.prepare(
      tool,
      tool.input.parse({}) as never,
      ctxFor(owner),
      randomUUID(),
    );
    const address = (prepared.card as Extract<AssistantCard, { type: 'confirm' }>).fields.find(
      (f) => f.label === 'Address',
    )!.value;
    expect(address).toBe(`${web}/book/settings-hvac-${suffix}`);
    expect(prepared.result).toMatchObject({ address });
  });

  it('changes a calendar’s link name, says the whole new link, and keeps the old one working', async () => {
    const web = 'https://app.hfos.test';
    const executor = createToolExecutor(api(), null, null, web);
    const id = (await calendars()).items.find((c) => c.name === 'Duct cleaning')!.id;
    const tool = assistantToolByName.get('manage_calendar')!;
    const parsed = tool.input.parse({ action: 'change', calendarId: id, bookingLink: 'ducts' });
    const { card } = await executor.prepare(tool, parsed as never, ctxFor(owner), randomUUID());
    const fields = (card as Extract<AssistantCard, { type: 'confirm' }>).fields;
    expect(fields.find((f) => f.label === 'Booking link')!.value).toBe(
      `${web}/book/settings-hvac-${suffix}/ducts`,
    );
    const done = await executor.commit(tool as never, parsed as never, ctxFor(owner), {
      toolCallId: randomUUID(),
    });
    expect(done.outcome).toContain(`/book/settings-hvac-${suffix}/ducts`);
    expect(done.outcome).toContain('The old link keeps working.');

    // The booking page's own address keeps no old one, so the card says what moving it costs.
    const site = assistantToolByName.get('update_booking_site')!;
    const moved = await executor.prepare(
      site,
      site.input.parse({ slug: `hvac-${suffix}` }) as never,
      ctxFor(owner),
      randomUUID(),
    );
    expect((moved.card as Extract<AssistantCard, { type: 'confirm' }>).warnings).toContainEqual({
      kind: 'caution',
      text: 'Links you’ve already shared stop working.',
    });
  });

  it('says whether Your page shows, and gives the privacy policy and terms links whole', async () => {
    const web = 'https://app.hfos.test';
    const executor = createToolExecutor(api(), null, null, web);
    const read = async (area: string) =>
      (await executor.run(assistantToolByName.get('get_settings')!, { area }, ctxFor(owner)))
        .result as Record<string, Record<string, unknown>>;
    const slug = (await q<{ site: { slug: string } }>('booking_site.get')).site.slug;

    // Off until it's turned on, and the model is told where.
    const before = (await read('booking_site'))['bookingSite']!;
    expect(before.yourPage).toContain('Show your page on Settings → Workspace');
    expect(before.privacyAndTerms).toMatchObject({
      privacyPolicy: `${web}/legal/${slug}/privacy`,
      terms: `${web}/legal/${slug}/terms`,
    });

    expect((await read('business'))['yourPage']).toMatchObject({ yourPageLink: null });

    await run(bookingSiteSetPage, { workspaceId, on: true }, owner);
    const after = (await read('booking_site'))['bookingSite']!;
    expect(after.yourPage).toContain(`Showing at ${web}/book/${slug}`);
    // Settings → Workspace's Your page card: the link Copy the link copies, written out whole.
    expect((await read('business'))['yourPage']).toEqual({
      yourPage: expect.stringContaining(`Showing at ${web}/book/${slug}.`),
      yourPageLink: `${web}/book/${slug}`,
    });

    // Texting's registration links to the same two.
    expect((await read('texting'))['privacyAndTerms']).toMatchObject({
      privacyPolicy: `${web}/legal/${slug}/privacy`,
      terms: `${web}/legal/${slug}/terms`,
    });
  });
});

const q = async <T>(name: string, input: Record<string, unknown> = {}) =>
  (await executeQuery(api(), registry.query(name)!, { workspaceId, ...input }, actor(owner), {
    correlationId: randomUUID(),
    channel: 'test' as const,
  })) as T;

/** The executor as the worker builds it, with a map that finds any address but one with "nowhere" in it. */
const withMap = () =>
  createToolExecutor(api(), null, null, '', undefined, {
    services: { geocoder: createFakeGeocoder() } as unknown as WorkerServices,
  });
const prepareOn = async (
  executor: ReturnType<typeof createToolExecutor>,
  name: string,
  args: Record<string, unknown>,
) => {
  const tool = assistantToolByName.get(name)!;
  const parsed = tool.input.parse(args) as Record<string, unknown>;
  const { card } = await executor.prepare(tool, parsed, ctxFor(owner), randomUUID());
  const done = () =>
    executor.commit(tool as never, parsed, ctxFor(owner), { toolCallId: randomUUID() });
  return { card: card as Extract<AssistantCard, { type: 'confirm' }>, done };
};
const fieldOf = (card: { fields: { label: string; value: string }[] }, label: string) =>
  card.fields.find((f) => f.label === label)?.value;

interface ServiceRow {
  id: string;
  name: string;
  durations: number[];
  defaultDuration: number;
  repeatMonths: number | null;
  resources: { resourceId: string; quantity: number }[];
  hours: { day: number; start: string; end: string }[] | null;
}
interface ResourceRow {
  id: string;
  name: string;
  kind: string;
  quantity: number;
  hours: { day: number }[] | null;
}
interface TerritoryRow {
  id: string;
  name: string;
  kind: string;
  postalCodes: string[];
  centerAddress: string | null;
  radiusMiles: number | null;
  userIds: string[];
}

describe('Settings → Calendars: services, resources and territories', () => {
  let chairId: string;

  it('adds a resource of any kind the screen has, with its own hours, only on Confirm', async () => {
    const args = {
      action: 'create',
      name: 'Styling chair',
      kind: 'chair',
      quantity: 2,
      hours: [{ day: 2, start: '09:00', end: '13:00' }],
    };
    const { card, done } = await prepareOn(createToolExecutor(api()), 'manage_resource', args);
    expect(card.title).toBe('Add Styling chair');
    expect(fieldOf(card, 'What it is')).toBe('Chair');
    expect(fieldOf(card, 'How many')).toBe('2');
    expect(fieldOf(card, 'Hours')).toBe('Tue 09:00–13:00');
    const before = (await q<{ items: ResourceRow[] }>('resource.list')).items;
    expect(before.some((r) => r.name === 'Styling chair')).toBe(false);
    await done();
    const chair = (await q<{ items: ResourceRow[] }>('resource.list')).items.find(
      (r) => r.name === 'Styling chair',
    )!;
    chairId = chair.id;
    expect([chair.kind, chair.quantity, chair.hours?.length]).toEqual(['chair', 2, 1]);

    await expect(
      prepareOn(createToolExecutor(api()), 'manage_resource', { ...args, name: 'styling chair' }),
    ).rejects.toThrow('There’s already a resource called “styling chair”.');
    await expect(
      prepareOn(createToolExecutor(api()), 'manage_resource', {
        action: 'change',
        resourceId: chairId,
        quantity: 2,
      }),
    ).rejects.toThrow('Nothing would change.');
  });

  it('changes how often a service repeats, what it needs and its hours, saying only what changes', async () => {
    const furnace = (await q<{ items: ServiceRow[] }>('service.list')).items.find(
      (s) => s.name === 'Furnace check',
    )!;
    const args = {
      action: 'change',
      serviceId: furnace.id,
      repeatMonths: 12,
      resources: [{ resourceId: chairId }],
      hours: [{ day: 1, start: '08:00', end: '12:00' }],
    };
    const { card, done } = await prepareOn(createToolExecutor(api()), 'manage_service', args);
    expect(card.title).toBe('Change Furnace check');
    expect(fieldOf(card, 'Repeats')).toBe('Every 12 months');
    expect(fieldOf(card, 'Needs')).toBe('Styling chair × 1');
    expect(fieldOf(card, 'Hours')).toBe('Mon 08:00–12:00');
    expect(fieldOf(card, 'How long')).toBeUndefined();
    await done();
    const now = (await q<{ items: ServiceRow[] }>('service.list')).items.find(
      (s) => s.id === furnace.id,
    )!;
    expect(now.repeatMonths).toBe(12);
    expect(now.resources).toEqual([{ resourceId: chairId, quantity: 1 }]);
    expect(now.hours).toEqual([{ day: 1, start: '08:00', end: '12:00' }]);

    await expect(prepareOn(createToolExecutor(api()), 'manage_service', args)).rejects.toThrow(
      'Nothing would change. Furnace check is already set up that way.',
    );
    await expect(
      prepareOn(createToolExecutor(api()), 'manage_service', {
        ...args,
        resources: [{ resourceId: randomUUID() }],
      }),
    ).rejects.toThrow('No resource has that id.');
    await expect(
      prepareOn(createToolExecutor(api()), 'manage_service', {
        action: 'create',
        name: 'furnace check',
      }),
    ).rejects.toThrow('There’s already a service called “furnace check”.');

    // New lengths pick the first as the one booked unless they choose, as the screen does.
    const shorter = await prepareOn(createToolExecutor(api()), 'manage_service', {
      action: 'change',
      serviceId: furnace.id,
      durationsMinutes: [30],
    });
    expect(fieldOf(shorter.card, 'How long')).toBe('30 min');
    await shorter.done();
    const short = (await q<{ items: ServiceRow[] }>('service.list')).items.find(
      (s) => s.id === furnace.id,
    )!;
    expect([short.durations, short.defaultDuration]).toEqual([[30], 30]);
  });

  it('archives a resource only on Confirm, saying what needs it will show something to fix', async () => {
    const { card, done } = await prepareOn(createToolExecutor(api()), 'manage_resource', {
      action: 'archive',
      resourceId: chairId,
    });
    expect(card.title).toBe('Archive Styling chair');
    expect(card.warnings[0]!.text).toContain('show something to fix');
    await done();
    expect(
      (await q<{ items: ResourceRow[] }>('resource.list')).items.some((r) => r.id === chairId),
    ).toBe(false);
  });

  it('adds a ZIP area, and one so many miles from an address found on the map', async () => {
    const zip = await prepareOn(createToolExecutor(api()), 'manage_territory', {
      action: 'create',
      name: 'North',
      postalCodes: ['75201', '75202'],
      userIds: [owner.id],
    });
    expect(zip.card.title).toBe('Add North');
    expect(fieldOf(zip.card, 'Covers')).toBe('75201, 75202');
    expect(fieldOf(zip.card, 'Who covers it')).toBe('Dale Owner');
    await zip.done();

    const miles = {
      action: 'create',
      name: 'Downtown',
      milesFrom: { address: '1500 Main St, Dallas TX 75201', miles: 10 },
    };
    // Without the map there is nothing to measure from, and it says what to do instead.
    await expect(prepareOn(createToolExecutor(api()), 'manage_territory', miles)).rejects.toThrow(
      'I can’t look addresses up on the map right now.',
    );
    await expect(
      prepareOn(withMap(), 'manage_territory', {
        ...miles,
        milesFrom: { address: 'nowhere at all', miles: 10 },
      }),
    ).rejects.toThrow('wasn’t found on the map');
    await expect(
      prepareOn(withMap(), 'manage_territory', { ...miles, postalCodes: ['75201'] }),
    ).rejects.toThrow('not both');
    const far = await prepareOn(withMap(), 'manage_territory', miles);
    expect(fieldOf(far.card, 'Covers')).toBe('10 miles from 1500 Main St, Dallas TX 75201');
    await far.done();

    const areas = (await q<{ items: TerritoryRow[] }>('territory.list')).items;
    const north = areas.find((t) => t.name === 'North')!;
    expect([north.kind, north.postalCodes.sort(), north.userIds]).toEqual([
      'zip',
      ['75201', '75202'],
      [owner.id],
    ]);
    const downtown = areas.find((t) => t.name === 'Downtown')!;
    expect([downtown.kind, downtown.radiusMiles, downtown.centerAddress]).toEqual([
      'radius',
      10,
      '1500 Main St, Dallas TX 75201',
    ]);
    await expect(
      prepareOn(withMap(), 'manage_territory', {
        action: 'change',
        territoryId: downtown.id,
        milesFrom: miles.milesFrom,
      }),
    ).rejects.toThrow('Nothing would change.');
  });

  it('turns a ZIP area into a distance, saying its codes come off, and deletes one only on Confirm', async () => {
    const north = (await q<{ items: TerritoryRow[] }>('territory.list')).items.find(
      (t) => t.name === 'North',
    )!;
    const change = await prepareOn(withMap(), 'manage_territory', {
      action: 'change',
      territoryId: north.id,
      milesFrom: { address: '200 Elm St, Plano TX 75074', miles: 5 },
    });
    expect(fieldOf(change.card, 'Covers')).toBe('5 miles from 200 Elm St, Plano TX 75074');
    expect(fieldOf(change.card, 'Was')).toBe('75201, 75202');
    expect(change.card.warnings[0]!.text).toContain('Its 2 ZIP codes come off');
    await change.done();
    const moved = (await q<{ items: TerritoryRow[] }>('territory.list')).items.find(
      (t) => t.id === north.id,
    )!;
    expect([moved.kind, moved.postalCodes, moved.radiusMiles]).toEqual(['radius', [], 5]);

    const gone = await prepareOn(createToolExecutor(api()), 'manage_territory', {
      action: 'delete',
      territoryId: north.id,
    });
    expect(gone.card.title).toBe('Delete North');
    expect(gone.card.warnings[0]!.text).toContain('stop sending visits there');
    expect(
      (await q<{ items: TerritoryRow[] }>('territory.list')).items.some((t) => t.id === north.id),
    ).toBe(true);
    await gone.done();
    expect(
      (await q<{ items: TerritoryRow[] }>('territory.list')).items.some((t) => t.id === north.id),
    ).toBe(false);
  });

  it('adds and takes off a few ZIP codes without the whole list sent again', async () => {
    const east = await prepareOn(createToolExecutor(api()), 'manage_territory', {
      action: 'create',
      name: 'East',
      postalCodes: ['75214', '75218', '75223'],
    });
    await east.done();
    const eastOf = async () =>
      (await q<{ items: TerritoryRow[] }>('territory.list')).items.find((t) => t.name === 'East')!;
    const id = (await eastOf()).id;

    const change = await prepareOn(createToolExecutor(api()), 'manage_territory', {
      action: 'change',
      territoryId: id,
      addPostalCodes: ['75228'],
      removePostalCodes: ['75223'],
    });
    expect(fieldOf(change.card, 'Adds')).toBe('75228');
    expect(fieldOf(change.card, 'Takes off')).toBe('75223');
    expect(fieldOf(change.card, 'Covers')).toBe('3 ZIP codes');
    await change.done();
    expect([...(await eastOf()).postalCodes].sort()).toEqual(['75214', '75218', '75228']);

    await expect(
      prepareOn(createToolExecutor(api()), 'manage_territory', {
        action: 'change',
        territoryId: id,
        addPostalCodes: ['75214'],
      }),
    ).rejects.toThrow('Nothing would change. East is already set up that way.');
  });
});

describe('the business itself', () => {
  it('changes the name and the open hours, and leaves the rest of the settings alone', async () => {
    const before = await q<{ workspace: { settings: Record<string, unknown> } }>('workspace.get');
    const { card, parsed, tool } = await prepare(
      'update_business',
      {
        name: `${businessName} & Plumbing`,
        website: 'https://settingshvac.example',
        openHours: [
          { day: 1, start: '07:00', end: '18:00' },
          { day: 2, start: '07:00', end: '18:00' },
        ],
      },
      owner,
    );
    expect(card.title).toBe(`Change ${businessName}`);
    expect(card.fields.find((f) => f.label === 'Was')!.value).toBe(businessName);
    expect(card.fields.find((f) => f.label === 'Open hours')!.value).toBe(
      'Mon 07:00–18:00, Tue 07:00–18:00',
    );
    await confirm(tool!, parsed, owner);

    const after = await q<{ workspace: { name: string; settings: Record<string, unknown> } }>(
      'workspace.get',
    );
    expect(after.workspace.name).toBe(`${businessName} & Plumbing`);
    expect(after.workspace.settings['website']).toBe('https://settingshvac.example');
    expect((after.workspace.settings['openHours'] as unknown[]).length).toBe(2);
    // A settings save replaces only its own keys.
    for (const key of Object.keys(before.workspace.settings))
      if (key !== 'website' && key !== 'openHours')
        expect(after.workspace.settings[key], key).toEqual(before.workspace.settings[key]);
  });

  it('keeps the street address the setup asks, and says when it’s on another time zone', async () => {
    const { card, parsed, tool } = await prepare(
      'update_business',
      { address: { line1: '1600 Larimer St', city: 'Denver', state: 'co', postalCode: '80202' } },
      owner,
    );
    expect(card.fields.find((f) => f.label === 'Address')!.value).toBe(
      '1600 Larimer St, Denver, CO 80202',
    );
    // The setup sets the time zone from the address; here it stays as it is, and the card says so.
    expect(card.warnings).toContainEqual({
      kind: 'note',
      text: 'That address is on Mountain time, but the business keeps Central time. Change the time zone too if it should follow.',
    });
    await confirm(tool!, parsed, owner);
    const after = await q<{ workspace: { timezone: string; settings: Record<string, unknown> } }>(
      'workspace.get',
    );
    expect(after.workspace.settings['address']).toMatchObject({
      line1: '1600 Larimer St',
      city: 'Denver',
      state: 'CO',
      postalCode: '80202',
    });
    expect(after.workspace.timezone).toBe(CHI);

    await expect(
      prepare('update_business', { address: { line1: '1 Main St', city: 'Nowhere' } }, owner),
    ).rejects.toThrow();
  });

  it('takes the website and review link off, as an emptied box does, and keeps the other links', async () => {
    const set = await prepare(
      'update_business',
      { reviewLink: 'https://g.page/settings-hvac/review' },
      owner,
    );
    await confirm(set.tool!, set.parsed, owner);
    // Another link kept by name, as a workflow might keep one: a change to the review link leaves it.
    await rows(
      testDbs().admin.db,
      sql`update app.workspaces
          set settings = jsonb_set(settings, '{links,booking}', '"https://book.settingshvac.example"')
          where id = ${workspaceId}`,
    );

    const { card, parsed, tool } = await prepare(
      'update_business',
      { website: null, reviewLink: null },
      owner,
    );
    expect(fieldOf(card, 'Website')).toBe('None (taken off)');
    expect(fieldOf(card, 'Review link')).toBe('None (taken off)');
    await confirm(tool!, parsed, owner);
    const after = await q<{ workspace: { settings: Record<string, unknown> } }>('workspace.get');
    expect(after.workspace.settings['website']).toBeNull();
    expect(after.workspace.settings['links']).toEqual({
      booking: 'https://book.settingshvac.example',
      review: null,
    });
  });
});

describe('pipelines and stages', () => {
  it('adds a stage where it was asked for, and says what a deleted stage does with its leads', async () => {
    const { pipelines } = await q<{
      pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[];
    }>('pipeline.list');
    const pipeline = pipelines[0]!;
    const contacted = pipeline.stages.find((s) => s.name === 'Contacted')!;

    const added = await prepare(
      'manage_pipeline',
      {
        action: 'add_stage',
        pipelineId: pipeline.id,
        name: 'Quoted',
        stageKind: 'open',
        afterStageId: contacted.id,
      },
      owner,
    );
    expect(added.card.title).toBe('Add the Quoted stage');
    expect(added.card.fields.find((f) => f.label === 'Counts as')!.value).toBe('open');
    await confirm(added.tool!, added.parsed, owner);

    const after = await q<{ pipelines: { id: string; stages: { id: string; name: string }[] }[] }>(
      'pipeline.list',
    );
    const stages = after.pipelines.find((p) => p.id === pipeline.id)!.stages.map((s) => s.name);
    expect(stages).toContain('Quoted');
    expect(stages.indexOf('Quoted')).toBe(stages.indexOf('Contacted') + 1);

    const quoted = after.pipelines
      .find((p) => p.id === pipeline.id)!
      .stages.find((s) => s.name === 'Quoted')!;
    const deleted = await prepare(
      'manage_pipeline',
      {
        action: 'delete_stage',
        stageId: quoted.id,
        moveLeadsToStageId: contacted.id,
      },
      owner,
    );
    expect(deleted.card.fields.find((f) => f.label === 'Leads in it go to')!.value).toBe(
      'Contacted',
    );
    await confirm(deleted.tool!, deleted.parsed, owner);
    const end = await q<{ pipelines: { id: string; stages: { name: string }[] }[] }>(
      'pipeline.list',
    );
    expect(
      end.pipelines.find((p) => p.id === pipeline.id)!.stages.map((s) => s.name),
    ).not.toContain('Quoted');
  });

  it('changes what an empty stage counts as on a card that says so, and keeps a stage with leads as it is', async () => {
    type Stages = {
      pipelines: {
        id: string;
        name: string;
        stages: { id: string; name: string; kind: string; leadCount: number }[];
      }[];
    };
    const stagesOf = async () => (await q<Stages>('pipeline.list')).pipelines[0]!;
    const pipeline = await stagesOf();
    const added = await prepare(
      'manage_pipeline',
      { action: 'add_stage', pipelineId: pipeline.id, name: 'On hold', stageKind: 'open' },
      owner,
    );
    await confirm(added.tool!, added.parsed, owner);
    const onHold = (await stagesOf()).stages.find((s) => s.name === 'On hold')!;

    const change = await prepare(
      'manage_pipeline',
      { action: 'rename_stage', stageId: onHold.id, stageKind: 'lost' },
      owner,
    );
    expect(change.card.title).toBe('Change On hold');
    expect(fieldOf(change.card, 'Counts as')).toBe('lost');
    expect(fieldOf(change.card, 'Counted as')).toBe('open');
    expect(change.card.warnings[0]!.text).toContain('nothing there now changes');
    const done = await confirm(change.tool!, change.parsed, owner);
    expect(done.outcome).toBe('Saved. It counts as lost now');
    expect((await stagesOf()).stages.find((s) => s.id === onHold.id)!.kind).toBe('lost');

    // A stage with a lead in it keeps its kind, as the screen's Edit locks it.
    const { personId } = (await run(
      personCreate,
      { workspaceId, firstName: 'Lena', lastName: 'Stage', email: `lena-${suffix}@example.com` },
      owner,
    )) as { personId: string };
    const contacted = pipeline.stages.find((s) => s.name === 'Contacted')!;
    await run(
      leadCreate,
      {
        workspaceId,
        title: 'Furnace swap',
        personId,
        pipelineId: pipeline.id,
        stageId: contacted.id,
      },
      owner,
    );
    await expect(
      prepare(
        'manage_pipeline',
        { action: 'rename_stage', stageId: contacted.id, stageKind: 'won' },
        owner,
      ),
    ).rejects.toThrow('Contacted has a lead in it, so it keeps counting as open.');

    // Deleting a stage with leads takes them to the first other stage of its kind, unless another is named.
    const del = await prepare(
      'manage_pipeline',
      { action: 'delete_stage', stageId: contacted.id },
      owner,
    );
    const firstOpen = pipeline.stages.find((s) => s.kind === 'open' && s.id !== contacted.id)!;
    expect(fieldOf(del.card, 'Leads in it')).toBe('1');
    expect(fieldOf(del.card, 'Leads in it go to')).toBe(firstOpen.name);
    await expect(
      prepare(
        'manage_pipeline',
        { action: 'delete_stage', stageId: contacted.id, moveLeadsToStageId: onHold.id },
        owner,
      ),
    ).rejects.toThrow('can only go to another open stage');

    // The only won stage can't go: every pipeline keeps one of each kind.
    const won = pipeline.stages.find((s) => s.kind === 'won')!;
    await expect(
      prepare('manage_pipeline', { action: 'delete_stage', stageId: won.id }, owner),
    ).rejects.toThrow(`${won.name} is the only won stage`);

    // Tidy up: On hold goes again, so the board is as the other tests expect.
    const tidy = await prepare(
      'manage_pipeline',
      { action: 'delete_stage', stageId: onHold.id },
      owner,
    );
    await confirm(tidy.tool!, tidy.parsed, owner);
  });
});

describe('the team', () => {
  let tess: TestUser;
  let rae: TestUser;
  beforeAll(async () => {
    [tess, rae] = await Promise.all([
      createTestUser('aset-tess', { fullName: 'Tess Member' }),
      createTestUser('aset-rae', { fullName: 'Rae Admin' }),
    ]);
    await rows(
      testDbs().admin.db,
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${workspaceId}, ${tess.id}, 'member'), (${workspaceId}, ${rae.id}, 'admin')`,
    );
  });
  const team = async () =>
    (await q<{ members: { userId: string; role: string }[] }>('workspace.members')).members;

  it('says an invitation is an email to a person, with the role as Invite teammate says it', async () => {
    const invite = await prepare(
      'manage_team',
      { action: 'invite', email: 'marco@settingshvac.example', role: 'member' },
      owner,
    );
    expect(invite.card.title).toBe('Invite marco@settingshvac.example');
    expect(fieldOf(invite.card, 'Role')).toBe(`Member — ${ROLE_DESCRIPTIONS.member}`);
    expect(fieldOf(invite.card, 'Business')).toBe(businessName);
    expect(invite.card.warnings[0]!.text).toContain('email');
    expect(invite.card.warnings[0]!.text).toContain('Accept invitation');
    await confirm(invite.tool!, invite.parsed, owner);
    const { invitations } = await q<{
      invitations: { id: string; email: string; role: string }[];
    }>('workspace.invitations');
    const marco = invitations.find((i) => i.email === 'marco@settingshvac.example')!;
    expect(marco.role).toBe('member');
    // The same email again is refused before a card, as the screen refuses it.
    await expect(
      prepare(
        'manage_team',
        { action: 'invite', email: 'marco@settingshvac.example', role: 'member' },
        owner,
      ),
    ).rejects.toMatchObject({ rule: 'invitation_pending' });

    // Sending it again and cancelling it name the invitation as Pending invitations lists it.
    const sending = await prepare(
      'manage_team',
      { action: 'resend_invitation', invitationId: marco.id },
      owner,
    );
    expect(fieldOf(sending.card, 'Sent')).toBe('Sending now');
    expect(fieldOf(sending.card, 'Expires')).toBeUndefined();
    await rows(
      testDbs().admin.db,
      sql`update app.invitations set sent_at = '2026-11-02T15:00:00Z', expires_at = '2026-11-09T15:00:00Z'
          where id = ${marco.id}`,
    );
    const resend = await prepare(
      'manage_team',
      { action: 'resend_invitation', invitationId: marco.id },
      owner,
    );
    expect(resend.card.title).toBe('Send marco@settingshvac.example’s invitation again');
    expect(fieldOf(resend.card, 'Email')).toBe('marco@settingshvac.example');
    expect(fieldOf(resend.card, 'Role')).toBe(`Member — ${ROLE_DESCRIPTIONS.member}`);
    expect(fieldOf(resend.card, 'Invited by')).toBe('Dale Owner');
    expect(fieldOf(resend.card, 'Sent')).toBe('Nov 2, 2026');
    expect(fieldOf(resend.card, 'Expires')).toBe('Nov 9, 2026');
    expect(resend.card.warnings[0]!.text).toContain('old link');
    expect((await confirm(resend.tool!, resend.parsed, owner)).outcome).toBe(
      'Invitation re-sent to marco@settingshvac.example. The old link no longer works.',
    );

    const cancel = await prepare(
      'manage_team',
      { action: 'cancel_invitation', invitationId: marco.id },
      owner,
    );
    expect(cancel.card.title).toBe('Cancel marco@settingshvac.example’s invitation');
    expect(cancel.card.warnings[0]!.text).toContain('link stops working');
    await confirm(cancel.tool!, cancel.parsed, owner);
    const after = await q<{ invitations: { id: string }[] }>('workspace.invitations');
    expect(after.invitations.map((i) => i.id)).not.toContain(marco.id);
    await expect(
      prepare('manage_team', { action: 'cancel_invitation', invitationId: marco.id }, owner),
    ).rejects.toThrow('isn’t pending anymore');
  });

  it('changes a role and removes someone on cards that name them, their email and role', async () => {
    const change = await prepare(
      'manage_team',
      { action: 'change_role', userId: rae.id, role: 'member' },
      owner,
    );
    expect(change.card.title).toBe('Change Rae Admin’s role');
    expect(fieldOf(change.card, 'Email')).toBe(rae.email);
    expect(fieldOf(change.card, 'Now')).toBe(`Member — ${ROLE_DESCRIPTIONS.member}`);
    expect(fieldOf(change.card, 'Was')).toBe(`Admin — ${ROLE_DESCRIPTIONS.admin}`);
    await expect(
      prepare('manage_team', { action: 'change_role', userId: rae.id, role: 'admin' }, owner),
    ).rejects.toMatchObject({ rule: 'nothing_changes' });

    const removal = await prepare('manage_team', { action: 'remove', userId: rae.id }, owner);
    expect(removal.card.title).toBe('Remove Rae Admin?');
    expect(fieldOf(removal.card, 'Teammate')).toBe('Rae Admin');
    expect(fieldOf(removal.card, 'Email')).toBe(rae.email);
    expect(fieldOf(removal.card, 'Role')).toBe(`Admin — ${ROLE_DESCRIPTIONS.admin}`);
    expect(removal.card.warnings[0]!.text).toContain('lose access');
    // Nothing changes before Confirm.
    expect((await team()).map((m) => m.userId)).toContain(rae.id);
    expect((await confirm(removal.tool!, removal.parsed, owner)).outcome).toBe('Removed Rae Admin');
    expect((await team()).map((m) => m.userId)).not.toContain(rae.id);

    // The only owner can't leave, so no card is offered.
    await expect(
      prepare('manage_team', { action: 'remove', userId: owner.id }, owner),
    ).rejects.toMatchObject({ rule: 'last_owner' });
  });

  it('refuses what someone’s role doesn’t cover, and lets anyone leave on a card that says what they lose', async () => {
    await expect(
      prepare('manage_team', { action: 'invite', email: 'cousin@settingshvac.example' }, tess),
    ).rejects.toMatchObject({
      rule: 'team_not_yours',
      message: expect.stringContaining('Invite people'),
    });
    await expect(
      prepare('manage_team', { action: 'remove', userId: owner.id }, tess),
    ).rejects.toMatchObject({ rule: 'team_not_yours' });

    const leave = await prepare('manage_team', { action: 'remove', userId: tess.id }, tess);
    expect(leave.card.title).toBe(`Leave ${businessName}?`);
    expect(leave.card.confirmLabel).toBe('Leave');
    expect(fieldOf(leave.card, 'You')).toBe(tess.email);
    expect(fieldOf(leave.card, 'Role')).toBe(`Member — ${ROLE_DESCRIPTIONS.member}`);
    expect(leave.card.warnings[0]!.text).toContain('You lose access immediately');
    const left = await confirm(leave.tool!, leave.parsed, tess);
    expect(left.outcome).toBe(`You left ${businessName}`);
    expect(left.href).toBeNull();
    expect((await team()).map((m) => m.userId)).not.toContain(tess.id);
  });
});

describe('what the AI knows about the business', () => {
  it('keeps the parts nobody mentioned, and warns before letting it quote prices', async () => {
    const first = await prepare(
      'update_knowledge_profile',
      { description: 'Residential heating and cooling in Houston.', tone: 'Plain and friendly.' },
      owner,
    );
    await confirm(first.tool!, first.parsed, owner);

    const second = await prepare('update_knowledge_profile', { allowPrices: true }, owner);
    expect(second.card.warnings[0]!.text).toContain('quote the prices');
    await confirm(second.tool!, second.parsed, owner);

    const { profile } = await q<{ profile: Record<string, unknown> }>('knowledge.profile');
    expect(profile['allowPrices']).toBe(true);
    expect(profile['description']).toBe('Residential heating and cooling in Houston.');
    expect(profile['tone']).toBe('Plain and friendly.');
  });

  it('sets the services and the words to use and avoid, clears a field, and says when nothing would change', async () => {
    const services = [
      { name: 'AC tune-up', description: 'Clean, check and top up.', price: '$89' },
      { name: 'Duct cleaning' },
    ];
    const { card, parsed, tool } = await prepare(
      'update_knowledge_profile',
      { services, wordsToUse: ['comfort', 'on time'], wordsToAvoid: ['cheap'], tone: '' },
      owner,
    );
    const value = (label: string) => card.fields.find((f) => f.label === label)?.value;
    expect(value('Services')).toBe('AC tune-up · $89 · Clean, check and top up.; Duct cleaning');
    expect(value('Words to use')).toBe('comfort, on time');
    expect(value('Words to avoid')).toBe('cheap');
    expect(value('How it sounds')).toBe('Cleared (was “Plain and friendly.”)');
    await confirm(tool!, parsed, owner);

    const { profile } = await q<{ profile: Record<string, unknown> }>('knowledge.profile');
    expect(profile['services']).toEqual([
      { name: 'AC tune-up', description: 'Clean, check and top up.', price: '$89' },
      { name: 'Duct cleaning', description: '', price: null },
    ]);
    expect(profile['wordsToUse']).toEqual(['comfort', 'on time']);
    expect(profile['wordsToAvoid']).toEqual(['cheap']);
    expect(profile['tone']).toBe('');
    // The rest stays as it was.
    expect(profile['description']).toBe('Residential heating and cooling in Houston.');
    expect(profile['allowPrices']).toBe(true);

    await expect(
      prepare('update_knowledge_profile', { wordsToAvoid: ['cheap'], tone: '' }, owner),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('get_settings'),
    });
  });
});

describe('texting and calls', () => {
  it('keeps the parts of quiet hours nobody mentioned, and warns when they are turned off', async () => {
    const before = await q<{
      settings: { quietHours: { enabled: boolean; start: string; end: string } };
    }>('phone.setup_status');
    const { card, parsed, tool } = await prepare(
      'update_texting_settings',
      { quietHoursStart: '21:00', remindTeamAfterMinutes: 15 },
      owner,
    );
    expect(card.fields.find((f) => f.label === 'Quiet hours')!.value).toBe(
      `21:00–${before.settings.quietHours.end}`,
    );
    expect(card.fields.find((f) => f.label === 'Remind the team')!.value).toBe(
      'After 15 min waiting',
    );
    await confirm(tool!, parsed, owner);

    const after = await q<{
      settings: {
        quietHours: { enabled: boolean; start: string; end: string };
        unansweredReminderMinutes: number;
      };
    }>('phone.setup_status');
    expect(after.settings.quietHours.start).toBe('21:00');
    expect(after.settings.quietHours.end).toBe(before.settings.quietHours.end);
    expect(after.settings.quietHours.enabled).toBe(before.settings.quietHours.enabled);
    expect(after.settings.unansweredReminderMinutes).toBe(15);

    const off = await prepare('update_texting_settings', { quietHoursEnabled: false }, owner);
    expect(off.card.warnings[0]!.text).toContain('any hour');
  });
});

describe('the business number', () => {
  it('says a number costs money, and that giving one up cannot be undone', async () => {
    const getting = await prepare(
      'manage_phone_number',
      { action: 'get', number: '+17135550188', numberType: 'local' },
      owner,
    );
    expect(getting.card.title).toBe('Get (713) 555-0188');
    expect(getting.card.fields.find((f) => f.label === 'Number')!.value).toBe('(713) 555-0188');
    // The price, as Settings → Usage & balance shows it to someone who may see prices, on the card and its warning.
    const prices = await q<{ items: { key: string | null; cents: number }[] }>('usage.prices');
    const monthly = `${money(prices.items.find((i) => i.key === 'number.local.month')!.cents)} a month`;
    expect(getting.card.fields.find((f) => f.label === 'Costs')!.value).toBe(monthly);
    expect(getting.card.warnings[0]!.text).toBe(
      `This costs ${monthly}, from your balance, every month you keep it.`,
    );

    const giving = await prepare(
      'manage_phone_number',
      { action: 'give_up', number: '+17135550188' },
      owner,
    );
    expect(giving.card.warnings[0]!.kind).toBe('blocked');
    expect(giving.card.warnings[0]!.text).toContain('reaches nobody');
  });

  it('looks for free numbers near the business first, through the worker’s telephony, and buys none', async () => {
    await run(
      workspaceUpdate,
      {
        workspaceId,
        settings: {
          address: { line1: '100 Main St', city: 'Huntsville', state: 'AL', postalCode: '35801' },
        },
      },
      owner,
    );
    const telephony = createFakeTelephony({
      approvalMs: 0,
      callbacks: false,
      log: pino({ level: 'silent' }),
    });
    // The worker's own connection, as in production (main.ts): the permission check asks the database as the worker.
    const executor = createToolExecutor(testDbs().worker.db, null, null, '', undefined, {
      services: { telephony } as unknown as WorkerServices,
    });
    const tool = assistantToolByName.get('find_phone_numbers')!;
    type Found = {
      searched: string;
      numbers: { number: string; shown: string; town?: string; state?: string }[];
      note: string;
    };
    const look = async (args: Record<string, unknown>) =>
      (await executor.run(tool, tool.input.parse(args) as never, ctxFor(owner))).result as Found;

    const near = await look({});
    expect(near.searched).toBe('Within 25 miles of Huntsville, AL, the business’s town');
    expect(near.numbers.length).toBeGreaterThan(0);
    expect(near.numbers[0]).toMatchObject({ town: 'Huntsville', state: 'AL' });
    expect(near.numbers[0]!.shown).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
    expect(near.note).toContain('manage_phone_number');
    // "Within 50 miles of us" widens the business's own town.
    expect((await look({ withinMiles: 50 })).searched).toBe(
      'Within 50 miles of Huntsville, AL, the business’s town',
    );
    // A state alone isn't a place the carriers look in, so it's refused rather than searched somewhere else.
    await expect(look({ state: 'TN' })).rejects.toMatchObject({
      code: 'validation',
      message: 'Name a city in TN too, or give an area code there instead.',
    });

    expect((await look({ anywhere: true })).searched).toBe('Anywhere');

    const area = await look({ areaCode: '256' });
    expect(area.searched).toBe('Area code 256');
    expect(area.numbers.every((n) => n.number.startsWith('+1256'))).toBe(true);

    const tollFree = await look({ numberType: 'toll_free' });
    expect(tollFree.searched).toBe('Toll-free');
    expect(tollFree.numbers.every((n) => n.town === undefined)).toBe(true);
    // Starts with, on the screen's toll-free search.
    expect((await look({ numberType: 'toll_free', areaCode: '833' })).searched).toBe(
      'Toll-free · Starting 833',
    );

    // It only looks: nothing is bought or held.
    const owned = await rows<{ n: number }>(
      testDbs().admin.db,
      sql`select count(*)::int as n from app.phone_numbers where workspace_id = ${workspaceId}`,
    );
    expect(owned[0]!.n).toBe(0);
    expect(executor.reads?.(tool)).toBe(true);
    expect(executorFor('find_phone_numbers')).toBeTruthy();

    // Without the worker's telephony it says where to look instead of guessing numbers.
    await expect(
      createToolExecutor(testDbs().worker.db).run(tool, {}, ctxFor(owner)),
    ).rejects.toMatchObject({
      rule: 'numbers_unavailable',
    });
  });
});

describe('the carrier registration', () => {
  it('fills in the answers its steps pick up, sends nothing, and says what’s still to answer', async () => {
    const tool = assistantToolByName.get('fill_in_carrier_registration')!;
    const executor = createToolExecutor(api());
    type Filled = {
      saved: Record<string, string>;
      opensAt: string;
      stillToAnswer?: string[];
      sent: boolean;
      note: string;
    };
    const fill = async (args: Record<string, unknown>) =>
      (await executor.run(tool, tool.input.parse(args) as never, ctxFor(owner))) as {
        result: Filled;
        card?: AssistantCard | null;
      };
    type Draft = { answers: { form: Record<string, unknown>; at: number } | null };
    const sample = 'Hi Mike, this is Dale at Settings HVAC confirming your visit tomorrow at 9 AM.';

    const first = await fill({
      legalName: 'Settings HVAC LLC',
      businessType: 'llc',
      ein: '12-3456789',
      samples: [sample],
    });
    expect(first.result.sent).toBe(false);
    expect(first.result.saved).toMatchObject({
      'Legal name': 'Settings HVAC LLC',
      'Kind of business': 'llc',
      EIN: '12-3456789',
    });
    // No way customers agree yet, so the screen opens on that step.
    expect(first.result.opensAt).toBe('How customers agree to get texts');
    expect(first.result.stillToAnswer).toEqual(
      expect.arrayContaining([
        'Website',
        'How customers agree',
        'Topics the carriers treat differently',
      ]),
    );
    expect(first.result.stillToAnswer).not.toContain('Legal name');
    expect(first.card).toMatchObject({
      type: 'done',
      title: 'Filled in your texting registration',
    });
    expect(AssistantCard.safeParse(first.card).success).toBe(true);
    // Saved where the wizard reads it: its own field names, two example texts, and the step it opens on.
    const saved = await q<Draft>('registration.get_draft');
    expect(saved.answers!.form).toMatchObject({
      legalName: 'Settings HVAC LLC',
      businessType: 'llc',
      ein: '12-3456789',
      samples: [sample, ''],
    });
    expect(saved.answers!.at).toBe(5);

    // A later answer keeps the earlier ones. With a way customers agree but nothing yet to tell the carriers about
    // it, it still opens on How customers agree, which writes that (and sets up the hosted sign-up chat).
    const second = await fill({
      website: 'https://settingshvac.example',
      optInPath: 'hosted',
      sensitive: [],
      ownPolicyUrl: null,
    });
    expect(second.result.opensAt).toBe('How customers agree to get texts');
    expect(second.result.saved).toMatchObject({
      'How customers agree': 'The sign-up page HandsFreeOS hosts',
      'Topics the carriers treat differently': 'None of these',
      'Privacy policy': 'The one HandsFreeOS hosts',
    });
    expect(second.result.stillToAnswer).toContain('What we will tell the carriers');
    expect(second.result.stillToAnswer).not.toContain('Topics the carriers treat differently');
    const again = await q<Draft>('registration.get_draft');
    expect(again.answers!.form).toMatchObject({
      legalName: 'Settings HVAC LLC',
      website: 'https://settingshvac.example',
      optInPath: 'hosted',
      sensitive: [],
      ownPolicyUrl: '',
      samples: [sample, ''],
    });
    expect(again.answers!.at).toBe(5);

    // Once that's written it opens at Before it goes, and the ticks the person gave there on other answers are
    // cleared, so they tick them again on these: the Assistant never gives one.
    await rows(
      testDbs().admin.db,
      sql`update app.registration_drafts
          set answers = jsonb_set(answers, '{form,confirmed}', '["only_these_ways"]'::jsonb)
          where workspace_id = ${workspaceId}`,
    );
    const third = await fill({
      optIn: 'Customers start a chat on settingshvac.example and tick a box to get texts.',
    });
    expect(third.result.opensAt).toBe('Before it goes');
    expect(third.result.stillToAnswer).not.toContain('What we will tell the carriers');
    const last = await q<Draft>('registration.get_draft');
    expect(last.answers!.form['optIn']).toBe(
      'Customers start a chat on settingshvac.example and tick a box to get texts.',
    );
    expect(last.answers!.form['confirmed']).toEqual([]);
    expect(last.answers!.at).toBe(7);

    // Nothing went to the carriers.
    const sent = await rows<{ n: number }>(
      testDbs().admin.db,
      sql`select count(*)::int as n from app.telephony_registrations where workspace_id = ${workspaceId}`,
    );
    expect(sent[0]!.n).toBe(0);
    await expect(fill({})).rejects.toMatchObject({ rule: 'nothing_to_fill_in' });
    expect(executorFor('fill_in_carrier_registration')).toBeTruthy();
    // Sending it stays on Before it goes: the Assistant has no tool that sends it.
    expect(assistantToolByName.get('submit_carrier_registration')).toBeUndefined();
  });
});

describe('email', () => {
  it('adds a sending address on the shared domain', async () => {
    const { card, parsed, tool } = await prepare(
      'manage_email_settings',
      { action: 'add_address', localPart: `desk-${suffix}`, displayName: businessName },
      owner,
    );
    expect(card.title).toBe('Add a sending address');
    expect(card.fields.find((f) => f.label === 'Address')!.value).toContain(`desk-${suffix}@`);
    const done = await confirm(tool!, parsed, owner);
    expect(done.command).toBe('email_address.create');
    const { addresses } = await q<{ addresses: { address: string }[] }>('email.setup_status');
    expect(addresses.some((a) => a.address.startsWith(`desk-${suffix}@`))).toBe(true);
  });
});

describe('how you get paid', () => {
  it('changes the tax and keeps every reminder, and says when a reminder would land too early', async () => {
    const before = await q<{ settings: { reminders: { afterDueDays: number[] } } }>(
      'money.settings',
    );
    const { card, parsed, tool } = await prepare(
      'update_money_settings',
      { taxRatePercent: 8.25, taxName: 'Sales tax', estimateGoodForDays: 30 },
      owner,
    );
    expect(card.fields.find((f) => f.label === 'Sales tax')!.value).toBe('8.25%');
    expect(card.fields.find((f) => f.label === 'Estimates good for')!.value).toBe('30 days');
    await confirm(tool!, parsed, owner);

    const after = await q<{
      settings: {
        tax: { rateBp: number };
        estimateGoodForDays: number;
        reminders: { afterDueDays: number[] };
      };
    }>('money.settings');
    expect(after.settings.tax.rateBp).toBe(825);
    expect(after.settings.estimateGoodForDays).toBe(30);
    expect(after.settings.reminders.afterDueDays).toEqual(before.settings.reminders.afterDueDays);

    const early = await prepare('update_money_settings', { terms: 'due_on_receipt' }, owner);
    expect(early.card.warnings[0]!.text).toContain(
      'a reminder before the due date never goes out. To fix it: only remind from the due date',
    );
  });

  it('still saves once invoices have gone out and the counter has moved past the saved number', async () => {
    // Sending an invoice moves the counter on; the saved setting still says where it started. Saving anything else
    // must not trip "the next number only moves forward" over a number the person never touched.
    await testDbs().admin.db.execute(
      sql`insert into app.document_counters (workspace_id, kind, next_number)
          values (${workspaceId}, 'invoice', 1500)
          on conflict (workspace_id, kind) do update set next_number = 1500`,
    );
    const { parsed, tool } = await prepare('update_money_settings', { taxRatePercent: 6 }, owner);
    await confirm(tool!, parsed, owner);
    const after = await q<{ settings: { tax: { rateBp: number } }; nextInvoiceNumber: string }>(
      'money.settings',
    );
    expect(after.settings.tax.rateBp).toBe(600);
    expect(after.nextInvoiceNumber).toMatch(/1500$/);
  });
});

interface MoneyRow {
  businessAddress: string;
  notes: { invoice: string; estimate: string };
  deposit: { kind: string; percentBp: number };
  reminders: { beforeDueDays: number[]; onDue: boolean; afterDueDays: number[] };
}

describe('Settings → Payments: every row', () => {
  const money = (args: Record<string, unknown>) =>
    prepareOn(createToolExecutor(api()), 'update_money_settings', args);

  it('takes the address and a note off, asks for a share up front, and lists only what changes', async () => {
    const set = await money({
      businessAddress: 'Lone Star HVAC\n2210 Oak St\nHouston, TX 77008',
      invoiceNote: 'Thanks for choosing us.',
    });
    expect(fieldOf(set.card, 'Your address')).toBe(
      'Lone Star HVAC, 2210 Oak St, Houston, TX 77008',
    );
    expect(fieldOf(set.card, 'Note on invoices')).toBe('“Thanks for choosing us.”');
    expect(set.card.fields.map((f) => f.label)).toEqual(['Your address', 'Note on invoices']);
    await set.done();

    const off = await money({
      businessAddress: null,
      invoiceNote: null,
      depositPercent: 30,
      remindBeforeDueDays: [],
      remindOnDueDay: true,
      remindAfterDueDays: [14, 7, 7],
    });
    expect(fieldOf(off.card, 'Your address')).toBe('Off documents');
    expect(fieldOf(off.card, 'Note on invoices')).toBe('None');
    // A share on its own turns the deposit on, the way typing in the screen's box does.
    expect(fieldOf(off.card, 'Deposit')).toBe('30% up front');
    expect(fieldOf(off.card, 'Invoice reminders')).toBe('on the day, 7 and 14 days after');
    expect(off.card.warnings.map((w) => w.text).join(' ')).toContain('New estimates and invoices');
    await off.done();

    const { settings } = await q<{ settings: MoneyRow }>('money.settings');
    expect(settings.businessAddress).toBe('');
    expect(settings.notes.invoice).toBe('');
    expect(settings.deposit).toMatchObject({ kind: 'percent', percentBp: 3_000 });
    expect(settings.reminders).toMatchObject({
      beforeDueDays: [],
      onDue: true,
      afterDueDays: [7, 14],
    });

    await expect(money({ depositPercent: 30 })).rejects.toThrow('Nothing would change.');
    await expect(money({ depositDollars: 0 })).rejects.toThrow('A deposit of $0 asks for nothing.');
  });

  it('says when a change sets two settings fighting, with the fixes in words', async () => {
    const { card } = await money({ estimateGoodForDays: 10, nudgeEstimateAfterDays: 12 });
    expect(fieldOf(card, 'Nudge an unanswered estimate')).toBe('After 12 days, once');
    expect(card.warnings.map((w) => w.text)).toContain(
      'The estimate nudge would go out after the estimate stops being good (10 days). To fix it: nudge after 3 days, or don’t nudge.',
    );
  });

  it('renames a payout account, makes another the default, and leaves plans billing only when told to', async () => {
    const admin = testDbs().admin.db;
    const account = async (label: string, isDefault: boolean, daysAgo: number) =>
      (
        await rows<{ id: string }>(
          admin,
          sql`insert into app.payment_connections (workspace_id, provider, environment, status,
                external_account_id, label, display_name, token_enc, token_key_id, connected_at, is_default)
              values (${workspaceId}, 'stripe', 'live', 'active', ${`acct_${randomUUID().slice(0, 12)}`},
                ${label}, ${label}, 'sealed', 'key-1', now() - make_interval(days => ${daysAgo}::int), ${isDefault})
              returning id`,
        )
      )[0]!.id;
    const main = await account('Main', true, 30);
    const spare = await account('Spare', false, 1);
    const pay = (args: Record<string, unknown>) =>
      prepareOn(createToolExecutor(api()), 'manage_payment_account', args);

    const rename = await pay({ action: 'rename', connectionId: spare, label: 'Truck sales' });
    expect(rename.card.title).toBe('Rename Stripe · Spare');
    expect(fieldOf(rename.card, 'Now called')).toBe('Truck sales');
    await rename.done();
    await expect(
      pay({ action: 'rename', connectionId: spare, label: 'Truck sales' }),
    ).rejects.toThrow('It’s already called Truck sales.');

    const def = await pay({ action: 'make_default', connectionId: spare });
    expect(fieldOf(def.card, 'New invoices')).toBe('Paid into Stripe · Truck sales');
    expect(def.card.warnings[0]!.text).toContain('Instead of Stripe · Main.');
    await def.done();

    // A plan billing through Main: disconnecting refuses until the person says it may keep billing.
    const { personId } = (await run(
      personCreate,
      { workspaceId, firstName: 'Gus', lastName: 'Plan', email: `gus-${suffix}@example.com` },
      owner,
    )) as { personId: string };
    await rows(
      admin,
      sql`insert into app.subscriptions (workspace_id, plan_name, person_id, connection_id, status)
          values (${workspaceId}, 'Comfort Club', ${personId}, ${main}, 'unmanaged')`,
    );
    await rows(
      admin,
      sql`update app.subscriptions set status = 'active' where person_id = ${personId}`,
    );
    await expect(pay({ action: 'disconnect', connectionId: main })).rejects.toThrow(
      'A plan still bills through Stripe · Main. Cancel it first',
    );
    const anyway = await pay({ action: 'disconnect', connectionId: main, keepPlansBilling: true });
    expect(anyway.card.title).toBe('Disconnect Stripe · Main');
    expect(fieldOf(anyway.card, 'Plans billing through it')).toBe('1, still billing at Stripe');
    expect(anyway.card.warnings.map((w) => w.text).join(' ')).toContain(
      'Stripe keeps charging that customer every cycle',
    );
    await anyway.done();

    const { connections } = await q<{
      connections: { id: string; status: string; isDefault: boolean; label: string | null }[];
    }>('payment_connection.list', { includeDisconnected: true });
    expect(connections.find((c) => c.id === main)!.status).toBe('disconnected');
    expect(connections.find((c) => c.id === spare)).toMatchObject({
      isDefault: true,
      label: 'Truck sales',
    });
    const [plan] = await rows<{ status: string }>(
      admin,
      sql`select status::text as status from app.subscriptions where person_id = ${personId}`,
    );
    expect(plan!.status).toBe('unmanaged');
    await expect(pay({ action: 'make_default', connectionId: main })).rejects.toThrow(
      'No connected payment account has that id.',
    );
  });
});

describe('Settings → Payments as the page reads it', () => {
  it('says the address documents show, the page’s warnings and how getting paid works', async () => {
    // An earlier test took Payments' own address off. The setup's street address is set here, since the free-numbers
    // test moved it to Huntsville: documents show the setup's until one is written here, as the page says.
    await run(
      workspaceUpdate,
      {
        workspaceId,
        settings: {
          address: { line1: '1600 Larimer St', city: 'Denver', state: 'CO', postalCode: '80202' },
        },
      },
      owner,
    );
    expect((await q<{ settings: MoneyRow }>('money.settings')).settings.businessAddress).toBe('');
    const { result } = await readTool('get_settings', 'payments', owner);
    const payments = result['payments'] as {
      addressOnDocuments: { address: string | null; from: string };
      issues: { message: string; saving: string; fixes: string[] }[];
      howItWorks: string[];
    };
    expect(payments.addressOnDocuments).toEqual({
      address: '1600 Larimer St, Denver, CO 80202',
      from: 'Your setup: until one is written under Your address, documents show this one',
    });
    expect(payments.howItWorks).toContain(
      'Money goes straight to your own account. HandsFreeOS never holds it.',
    );
    expect(payments.howItWorks.join(' ')).toContain('Surcharging is banned in four states');
    // With the setup's address on documents, nothing warns about it; whatever else does says whether it stops a save.
    expect(payments.issues.map((i) => i.message)).not.toContain(
      'Estimates and invoices go out without your address on them',
    );
    for (const issue of payments.issues)
      expect(['Nothing is saved until this is fixed', 'Doesn’t stop it saving']).toContain(
        issue.saving,
      );
    const accounts = result['accounts'] as { connections: { badge: string }[] };
    for (const c of accounts.connections) expect(c.badge).toBeTruthy();
  });
});

describe('Settings → Products', () => {
  interface ProductRow {
    id: string;
    name: string;
    sku: string | null;
    kind: string;
    unitPriceCents: number;
    unitLabel: string;
    taxable: boolean;
    archivedAt: string | null;
  }
  const product = (args: Record<string, unknown>) =>
    prepareOn(createToolExecutor(api()), 'manage_product', args);
  const catalogue = async () =>
    (await q<{ products: ProductRow[] }>('product.list', { includeArchived: true })).products;

  it('adds an item with its code and kind, reprices it, archives it and puts it back, each on Confirm', async () => {
    const name = `Duct sealing ${suffix}`;
    const add = await product({
      action: 'create',
      name,
      code: `DS-${suffix}`,
      kind: 'service',
      priceDollars: 125,
      unitLabel: 'hour',
      taxable: true,
    });
    expect(add.card.title).toBe(`Add ${name}`);
    expect(fieldOf(add.card, 'Kind')).toBe('Service');
    expect(fieldOf(add.card, 'Price')).toBe('$125 per hour');
    expect(fieldOf(add.card, 'Code')).toBe(`DS-${suffix}`);
    expect(fieldOf(add.card, 'Sales tax')).toContain('Charged');
    // Nothing is made until Confirm.
    expect((await catalogue()).some((p) => p.name === name)).toBe(false);
    const made = await add.done();
    expect(made.outcome).toBe(`${name} is in the catalogue.`);
    const item = (await catalogue()).find((p) => p.name === name)!;
    expect(item).toMatchObject({
      sku: `DS-${suffix}`,
      kind: 'service',
      unitPriceCents: 12_500,
      unitLabel: 'hour',
      taxable: true,
      archivedAt: null,
    });

    // A second item of the same name is refused before a card.
    await expect(product({ action: 'create', name, priceDollars: 10 })).rejects.toThrow(
      'That already exists',
    );

    const reprice = await product({ action: 'change', productId: item.id, priceDollars: 140 });
    expect(reprice.card.title).toBe(`Change ${name}`);
    expect(fieldOf(reprice.card, 'Price')).toBe('$140 per hour (was $125 per hour)');
    expect(reprice.card.fields.map((f) => f.label)).toEqual(['Item', 'Price']);
    expect(reprice.card.warnings.map((w) => w.text)).toContain(
      'Estimates and invoices already sent keep the price they went out with.',
    );
    expect((await reprice.done()).outcome).toBe(`${name} saved.`);
    // A change the editor has no box for still says on the card what changes.
    const described = await product({
      action: 'change',
      productId: item.id,
      description: 'Sealing leaky ducts, by the hour.',
    });
    expect(described.card.fields.map((f) => f.label)).toEqual(['Item', 'Description']);
    expect(fieldOf(described.card, 'Description')).toBe('Sealing leaky ducts, by the hour.');
    await expect(
      product({ action: 'change', productId: item.id, priceDollars: 140 }),
    ).rejects.toThrow('Nothing would change.');

    const archive = await product({ action: 'archive', productId: item.id });
    expect(archive.card.title).toBe(`Archive ${name}`);
    expect(archive.card.warnings[0]!.text).toBe(
      'It stays on every document it’s already on, and stops showing in the picker.',
    );
    expect((await archive.done()).outcome).toBe(
      'Archived. It stays on the documents it’s already on.',
    );
    expect((await catalogue()).find((p) => p.id === item.id)!.archivedAt).not.toBeNull();
    await expect(product({ action: 'archive', productId: item.id })).rejects.toThrow(
      'is already archived',
    );

    // get_settings lists it with the archived ones, as Show archived items does.
    const { result } = await readTool('get_settings', 'products', owner);
    const read = result['products'] as {
      items: { id: string }[];
      archived: { id: string; price: string }[];
    };
    expect(read.items.some((p) => p.id === item.id)).toBe(false);
    expect(read.archived.find((p) => p.id === item.id)!.price).toBe('$140 per hour');

    const back = await product({ action: 'put_back', productId: item.id });
    expect(back.card.title).toBe(`Put ${name} back`);
    expect((await back.done()).outcome).toBe(`${name} is back in the picker.`);
    expect((await catalogue()).find((p) => p.id === item.id)!.archivedAt).toBeNull();
  });

  it('says which item it can’t find instead of failing, and asks for a name first', async () => {
    await expect(
      product({ action: 'change', productId: randomUUID(), priceDollars: 1 }),
    ).rejects.toThrow('No item in Settings → Products has that id.');
    await expect(product({ action: 'create', priceDollars: 1 })).rejects.toThrow(
      'Give the new item a name',
    );
  });
});

describe('what Home watches for', () => {
  let ada: TestUser;
  beforeAll(async () => {
    ada = await createTestUser('aset-ada', { fullName: 'Ada Admin' });
    await rows(
      testDbs().admin.db,
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${workspaceId}, ${ada.id}, 'admin')`,
    );
  });

  it('turns a kind off without touching the others, and lets only an owner turn follow-ups on, after reading them', async () => {
    const { card, parsed, tool } = await prepare(
      'update_action_center_settings',
      { kindsOff: ['overdue_task'], bigJobDollars: 7500, ignoreBalancesUnderDollars: 25 },
      owner,
    );
    expect(card.fields.find((f) => f.label === 'A big job is')!.value).toBe('$7,500.00 or more');
    expect(card.fields.find((f) => f.label === 'Ignore balances under')!.value).toBe('$25.00');
    await confirm(tool!, parsed, owner);
    const after = await q<{
      settings: {
        kinds: Record<string, boolean>;
        hot: { minValueCents: number };
        money: { minBalanceCents: number };
      };
    }>('attention.settings');
    expect(after.settings.kinds['overdue_task']).toBe(false);
    expect(after.settings.kinds['hot_lead']).toBe(true);
    expect(after.settings.hot.minValueCents).toBe(750_000);
    expect(after.settings.money.minBalanceCents).toBe(2_500);

    // Follow-ups stay off until an owner has read the wording. Anyone else is told to ask an owner, with no Confirm,
    // and a Confirm sent anyway is refused.
    const asAdmin = await prepare(
      'update_action_center_settings',
      { followUpOnQuietLeads: true },
      ada,
    );
    expect(asAdmin.card.confirmLabel).toBe('');
    expect(asAdmin.card.warnings[0]!.text).toBe(
      'An owner turns follow-ups on after reading the wording. Ask an owner of this business.',
    );
    await expect(confirm(asAdmin.tool!, asAdmin.parsed, ada)).rejects.toThrow(
      'An owner turns follow-ups on after reading the wording.',
    );

    // An owner reads the wording first on the card: their Confirm is the screen's Looks good, turn on.
    const wording = (await q<{ settings: { nudge: { template: string } } }>('attention.settings'))
      .settings.nudge.template;
    const nudges = await prepare(
      'update_action_center_settings',
      { followUpOnQuietLeads: true },
      owner,
    );
    expect(nudges.card.title).toBe('Turn on follow-ups');
    expect(nudges.card.fields[0]).toEqual({ label: 'Follow-up wording', value: wording });
    expect(nudges.card.confirmLabel).toBe('Looks good, turn on');
    expect(nudges.card.warnings[0]!.text).toContain('Read the wording above first');
    await confirm(nudges.tool!, nudges.parsed, owner);
    const on = await q<{ settings: { auto: { nudges: boolean; nudgeReviewedAt: string | null } } }>(
      'attention.settings',
    );
    expect(on.settings.auto.nudges).toBe(true);
    expect(on.settings.auto.nudgeReviewedAt).not.toBeNull();

    // Once read, switching them is anyone's who may change the settings, as the screen's switch is.
    const off = await prepare(
      'update_action_center_settings',
      { followUpOnQuietLeads: false },
      ada,
    );
    expect(off.card.confirmLabel).toBe('Save the change');
    await confirm(off.tool!, off.parsed, ada);
    const after2 = await q<{
      settings: { auto: { nudges: boolean; nudgeReviewedAt: string | null } };
    }>('attention.settings');
    expect(after2.settings.auto.nudges).toBe(false);
    expect(after2.settings.auto.nudgeReviewedAt).toBe(on.settings.auto.nudgeReviewedAt);

    // Turned back on, or customers asked to confirm again, the card says it reaches customers on its own.
    const backOn = await prepare(
      'update_action_center_settings',
      { followUpOnQuietLeads: true },
      ada,
    );
    expect(backOn.card.confirmLabel).toBe('Save the change');
    expect(backOn.card.warnings).toEqual([
      {
        kind: 'caution',
        text: expect.stringContaining('HandsFreeOS texts quiet leads a follow-up on its own'),
      },
    ]);
    const quiet = await prepare(
      'update_action_center_settings',
      { askCustomersToConfirmVisits: false },
      owner,
    );
    // Turning something off reaches nobody.
    expect(quiet.card.warnings).toEqual([]);
    await confirm(quiet.tool!, quiet.parsed, owner);
    const askAgain = await prepare(
      'update_action_center_settings',
      { askCustomersToConfirmVisits: true },
      owner,
    );
    expect(askAgain.card.warnings[0]!.text).toContain('asks customers to confirm their visits');
    await confirm(askAgain.tool!, askAgain.parsed, owner);
  });

  it('sets gone quiet by open stage, as the screen does, and says which stages keep their own number', async () => {
    const { pipelines } = await q<{
      pipelines: { stages: { id: string; name: string; kind: string }[] }[];
    }>('pipeline.list');
    const first = pipelines[0]!.stages.find((s) => s.kind === 'open')!;
    const stale = async () =>
      (
        await q<{ settings: { stale: { days: number; stageDays: Record<string, number> } } }>(
          'attention.settings',
        )
      ).settings.stale;

    const byStage = await prepare(
      'update_action_center_settings',
      { goneQuietByStage: [{ stageId: first.id, days: 3 }] },
      owner,
    );
    expect(fieldOf(byStage.card, 'Gone quiet after, by stage')).toBe(`${first.name}: 3 days`);
    await confirm(byStage.tool!, byStage.parsed, owner);
    expect((await stale()).stageDays).toEqual({ [first.id]: 3 });

    // get_settings lists each open stage by name, with its number and whether it is its own.
    const { result } = await readTool('get_settings', 'action_center', owner);
    const listed = (result['actionCenter'] as { goneQuietByStage: unknown[] }).goneQuietByStage;
    expect(listed).toContainEqual(
      expect.objectContaining({ stageId: first.id, days: 3, ownNumber: true }),
    );

    const every = await prepare('update_action_center_settings', { goneQuietAfterDays: 10 }, owner);
    expect(fieldOf(every.card, 'Gone quiet after')).toBe(
      `10 days, in every open stage without its own number (${first.name} keeps 3 days)`,
    );
    await confirm(every.tool!, every.parsed, owner);
    expect(await stale()).toEqual({ days: 10, stageDays: { [first.id]: 3 } });

    // Back to every stage's number: its own is dropped, as the screen drops it.
    const back = await prepare(
      'update_action_center_settings',
      { goneQuietByStage: [{ stageId: first.id, days: null }] },
      owner,
    );
    expect(fieldOf(back.card, 'Gone quiet after, by stage')).toBe(`${first.name}: 10 days`);
    await confirm(back.tool!, back.parsed, owner);
    expect(await stale()).toEqual({ days: 10, stageDays: {} });

    const won = pipelines[0]!.stages.find((s) => s.kind === 'won')!;
    await expect(
      prepare(
        'update_action_center_settings',
        { goneQuietByStage: [{ stageId: won.id, days: 5 }] },
        owner,
      ),
    ).rejects.toThrow('Won and lost stages never go quiet');
  });

  it('tells an admin who can see the Deleted bin, from the permission it needs', async () => {
    const { result } = await readTool('get_settings', 'deleted_bin', ada);
    expect(result['deletedBin']).toBeNull();
    // Delete for good is the owners’ unless an owner gives it, so “An owner or admin can” would be wrong here.
    expect(result['note']).toContain(
      'deletedBin. An owner can, or someone an owner gave “Delete for good” to in Settings → Permissions.',
    );
  });

  it('won’t switch off what the screen always shows', async () => {
    const locked = await prepare(
      'update_action_center_settings',
      { kindsOff: ['ai_approval', 'overdue_task'] },
      owner,
    );
    expect(locked.card.confirmLabel).toBe('');
    expect(locked.card.warnings[0]!.text).toContain('Drafts awaiting review is always on');
    const after = await q<{ settings: { kinds: Record<string, boolean> } }>('attention.settings');
    expect(after.settings.kinds['ai_approval']).not.toBe(false);
  });
});

describe('the AI teammate', () => {
  it('sets one up switched off, then puts it on training wheels', async () => {
    const setup = await prepare(
      'manage_ai_teammate',
      { action: 'create', name: 'Ava', preset: 'lead_responder', answersTexts: true },
      owner,
    );
    expect(setup.card.title).toBe('Set up your AI teammate');
    expect(setup.card.warnings[0]!.text).toContain('training wheels');
    const done = await confirm(setup.tool!, setup.parsed, owner);
    expect(done.outcome).toContain('off until you turn it on');
    const made = await q<{ teammate: { name: string; status: string } | null }>('ai_teammate.get');
    expect(made.teammate!.name).toBe('Ava');
    expect(made.teammate!.status).toBe('off');

    const training = await prepare(
      'manage_ai_teammate',
      { action: 'set_status', status: 'training' },
      owner,
    );
    expect(training.card.fields.find((f) => f.label === 'Now')!.value).toContain('waits for you');
    await confirm(training.tool!, training.parsed, owner);
    const now = await q<{ teammate: { status: string } | null }>('ai_teammate.get');
    expect(now.teammate!.status).toBe('training');

    const auto = await prepare(
      'manage_ai_teammate',
      { action: 'set_status', status: 'automatic' },
      owner,
    );
    expect(auto.card.warnings[0]!.text).toContain('without waiting for you');
  });

  it('changes one thing about it and leaves its name and the rest alone', async () => {
    const before = await q<{
      teammate: { name: string; config: { answer: { enabled: boolean } } };
    }>('ai_teammate.get');
    const { parsed, tool } = await prepare(
      'manage_ai_teammate',
      { action: 'change', booksVisits: false },
      owner,
    );
    await confirm(tool!, parsed, owner);
    const after = await q<{
      teammate: {
        name: string;
        config: { answer: { enabled: boolean }; book: { enabled: boolean } };
      };
    }>('ai_teammate.get');
    expect(after.teammate.config.book.enabled).toBe(false);
    expect(after.teammate.name).toBe(before.teammate.name);
    expect(after.teammate.config.answer.enabled).toBe(before.teammate.config.answer.enabled);
  });

  it('shows every change on the card: questions, when it isn’t sure, and where it books', async () => {
    const { items } = await q<{ items: { id: string; name: string }[] }>('calendar.list');
    const calls = items.find((c) => c.name === 'Service calls')!;
    const { card } = await prepare(
      'manage_ai_teammate',
      {
        action: 'change',
        answersQuestions: false,
        handOffWhenUnsure: false,
        bookableCalendarIds: [calls.id],
      },
      owner,
    );
    expect(card.fields).toContainEqual({ label: 'Answers questions', value: 'No' });
    expect(card.fields).toContainEqual({ label: 'When it isn’t sure', value: 'Takes a message' });
    expect(card.fields).toContainEqual({ label: 'Books on', value: 'Service calls' });
  });

  it('keeps Respond and the New lead greeting apart, and says how they go together', async () => {
    type Respond = { enabled: boolean; newLeads: { enabled: boolean } };
    const respond = async () =>
      (await q<{ teammate: { config: { respond: Respond } } }>('ai_teammate.get')).teammate.config
        .respond;
    const off = await prepare(
      'manage_ai_teammate',
      { action: 'change', repliesToLeads: false },
      owner,
    );
    expect(off.card.fields).toContainEqual({ label: 'Respond', value: 'Off' });
    expect(off.card.warnings[0]!.text).toBe(
      'New leads get no first message while Respond is off, even with New lead greeting on. Ava still answers people who write in.',
    );
    await confirm(off.tool!, off.parsed, owner);
    // Only the section's own switch: the greeting inside it stays as it was.
    expect(await respond()).toMatchObject({ enabled: false, newLeads: { enabled: true } });

    const greetingOff = await prepare(
      'update_automations',
      { turnOff: ['new_lead_greeting'] },
      owner,
    );
    await confirm(greetingOff.tool!, greetingOff.parsed, owner);
    expect(await respond()).toMatchObject({ enabled: false, newLeads: { enabled: false } });
    const greetingOn = await prepare(
      'update_automations',
      { turnOn: ['new_lead_greeting'] },
      owner,
    );
    expect(greetingOn.card.warnings.map((w) => w.text)).toContain(
      'Not working until set up: New lead greeting: Turn on Respond for your AI teammate to start.',
    );

    const on = await prepare(
      'manage_ai_teammate',
      { action: 'change', repliesToLeads: true },
      owner,
    );
    expect(on.card.warnings[0]!.text).toContain('only once New lead greeting is on too');
    await confirm(on.tool!, on.parsed, owner);
    expect(await respond()).toMatchObject({ enabled: true, newLeads: { enabled: false } });
  });
});

describe('your own account', () => {
  it('reads every alert as it is set now, defaults filled in, and the phones they reach', async () => {
    const { result } = await readTool('get_settings', 'my_account', owner);
    const me = result['me'] as {
      alerts: {
        title: string;
        about: string;
        phone: boolean | null;
        email: boolean | 'always' | null;
      }[];
      alwaysOn: string;
    };
    // Never changed, so every one shows its default: a booking alert on, a payment's push off.
    expect(me.alerts.find((a) => a.title === 'Your appointments')).toMatchObject({
      about: expect.stringMatching(/book/i),
      phone: true,
    });
    expect(me.alerts.find((a) => a.title === 'A customer pays')).toMatchObject({ phone: false });
    expect(me.alwaysOn).toContain('Safety');
    // No phone signed in to the app yet: phone alerts reach nobody, and the note says how to fix it.
    expect(result['phonesForAlerts']).toEqual({
      phones: [],
      note: expect.stringContaining('More, then Settings, then Notifications'),
    });
  });

  it('reads only the rows their own screen has, and what else Settings → Account shows them', async () => {
    const { result } = await readTool('get_settings', 'my_account', owner);
    const me = result['me'] as Record<string, unknown> & {
      alerts: { title: string }[];
      appearance: { web: string; note: string };
      sideMenu: { summary: string; asDrawn: string };
      businesses: { name: string; role: string; current?: true; link: string }[];
      organizations: { name: string; role: string }[];
    };
    // A founder owns an organization of one business: no agency digest, and never New support tickets.
    const titles = me.alerts.map((a) => a.title);
    expect(titles).not.toContain('Daily agency digest');
    expect(titles).not.toContain('New support tickets');
    // The saved settings themselves stay out: only what the screen says.
    expect(me).not.toHaveProperty('settings');
    expect(me['emailNote']).toContain('can’t be changed yet');
    expect(me.appearance).toEqual({
      web: 'System',
      note: expect.stringContaining('phone app keeps its own'),
    });
    // The side menu as it's drawn, top to bottom.
    expect(me.sideMenu.asDrawn).toMatch(/^Home, Inbox, .*Settings/);
    expect(me.sideMenu.summary).toBeTruthy();
    // The businesses switcher's list, with their role and the one asked from (renamed under "the business itself").
    expect(me.businesses).toEqual([
      {
        name: `${businessName} & Plumbing`,
        organization: expect.any(String),
        role: 'Owner',
        current: true,
        link: `/app/w/${workspaceId}`,
      },
    ]);
    expect(me.organizations).toEqual([{ name: expect.any(String), role: 'Owner' }]);
    // No cell yet: the note hands over adding it.
    expect(result['myCell']).toEqual({
      number: null,
      note: expect.stringContaining('My cell phone'),
    });

    const cell = `+1312555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    await rows(
      testDbs().admin.db,
      sql`insert into app.user_phones (user_id, e164) values (${owner.id}, ${cell})`,
    );
    const waiting = (await readTool('get_settings', 'my_account', owner)).result['myCell'];
    expect(waiting).toEqual({
      number: expect.stringContaining(cell.slice(-4)),
      state: 'Not verified yet',
    });
    await rows(
      testDbs().admin.db,
      sql`update app.user_phones set verified_at = '2026-03-04T18:00:00Z' where user_id = ${owner.id}`,
    );
    const verified = (await readTool('get_settings', 'my_account', owner)).result['myCell'];
    expect(verified).toMatchObject({ state: 'Verified Wed, Mar 4' });
    // Taken off again: the test text below asks for a phone when there's no confirmed cell.
    await rows(testDbs().admin.db, sql`delete from app.user_phones where user_id = ${owner.id}`);
  });

  it('gives the steps they asked about: confirming their cell, not the first one', async () => {
    const help = async (what?: string) => {
      const tool = assistantToolByName.get('settings_help')!;
      const args = tool.input.parse({ area: 'my_account', ...(what ? { what } : {}) });
      const out = await createToolExecutor(api()).run(tool, args as never, ctxFor(owner));
      return (out as { card: Extract<AssistantCard, { type: 'list' }> }).card;
    };
    expect((await help()).title).toBe('Change your password, Google sign-in or passkeys');
    // Apple sign-in is the iPhone app's own, and the same card says where.
    expect((await help('sign in with Apple')).items.map((i) => i.title)).toContain(
      '3. Apple sign-in is on the iPhone app’s sign-in screen (Continue with Apple), not under Sign-in methods.',
    );
    // Named as the area says it, or in their own words.
    expect((await help('confirm your cell number')).title).toBe('Confirm your cell number');
    const cell = await help('how do I verify my cell?');
    expect(cell.title).toBe('Confirm your cell number');
    expect(cell.items.map((i) => i.title)).toContain('3. Answer the call and press 1.');
    expect((await help('delete my account')).title).toBe('Delete your account');
  });

  it('turns one email off without touching the others, and keeps your name', async () => {
    const { card, parsed, tool } = await prepare(
      'update_my_account',
      { morningEmail: false, appearance: 'dark' },
      owner,
    );
    // Each named as its row on Notifications, and the look said to be the web app's alone.
    expect(card.fields.find((f) => f.label === 'Web app’s appearance')!.value).toBe('Dark');
    expect(card.fields.find((f) => f.label === 'Email: Morning summary')!.value).toBe('Off');
    expect(card.warnings.map((w) => w.text)).toContain(
      'This changes the web app, for every browser you sign in on. The phone app keeps its own: set it on the phone under More → Settings → Appearance.',
    );
    const saved = await confirm(tool!, parsed, owner);
    expect(saved.href).toBe(`/app/w/${workspaceId}/settings`);

    const me = await q<{ user: { fullName: string; settings: Record<string, unknown> } }>(
      'account.me',
    );
    expect(me.user.fullName).toBe('Dale Owner');
    expect(me.user.settings['theme']).toBe('dark');
    const notifications = me.user.settings['notifications'] as Record<string, boolean>;
    expect(notifications['attentionDigest']).toBe(false);

    // A second change leaves the first alone, and opens Notifications itself, where the phone has a screen of it.
    const again = await prepare('update_my_account', { emailWhenPaid: false }, owner);
    expect(again.card.fields).toEqual([{ label: 'Email: A customer pays', value: 'Off' }]);
    expect(again.card.warnings).toEqual([]);
    const second = await confirm(again.tool!, again.parsed, owner);
    expect(second.href).toBe(`/app/w/${workspaceId}/settings#notifications`);
    const after = await q<{ user: { settings: Record<string, unknown> } }>('account.me');
    const now = after.user.settings['notifications'] as Record<string, boolean>;
    expect(now['attentionDigest']).toBe(false);
    expect(now['paymentEmail']).toBe(false);
    expect(after.user.settings['theme']).toBe('dark');

    // Nothing named, nothing to save: no empty card.
    await expect(prepare('update_my_account', {}, owner)).rejects.toThrow('Nothing would change.');
  });
});

describe('your own hours', () => {
  it('books time off in plain words, and says visits already booked stay', async () => {
    const { card, parsed, tool } = await prepare(
      'update_my_hours',
      { action: 'add_time_off', startDate: '2026-12-24', endDate: '2026-12-26', note: 'Christmas' },
      owner,
    );
    expect(card.title).toBe('Put time off in your calendar');
    expect(card.fields.find((f) => f.label === 'When')!.value).toBe('Dec 24 to Dec 26');
    expect(card.fields.find((f) => f.label === 'What it is')!.value).toBe('Christmas');
    expect(card.warnings[0]!.text).toContain('Visits already booked stay');
    const done = await confirm(tool!, parsed, owner);
    expect(done.command).toBe('time_off.add');
  });

  it('reads your own week, time zone and time off in words, with the ids that take time off out', async () => {
    const { result } = await readTool('get_settings', 'my_calendar', owner);
    const mine = result['schedules'] as {
      name: string;
      userId: string;
      weeklyHours: string;
      hoursIn: string;
      timeOff: { exceptionId: string; when: string }[];
      calendarLink: string;
      note: string;
    };
    expect(mine).toMatchObject({
      name: 'Dale Owner',
      userId: owner.id,
      hoursIn: expect.stringContaining('the business’s time zone'),
      calendarLink: 'No calendar linked',
    });
    expect(typeof mine.weeklyHours).toBe('string');
    expect(Array.isArray(mine.timeOff)).toBe(true);
    expect(mine.note).toContain('exceptionId');
  });
});

describe('a teammate’s hours', () => {
  let marco: TestUser;
  beforeAll(async () => {
    marco = await createTestUser('aset-marco', { fullName: 'Marco Member' });
    await rows(
      testDbs().admin.db,
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${workspaceId}, ${marco.id}, 'member')`,
    );
  });

  it('lets an owner set a teammate’s week, as Members → Edit hours does, naming whose on the card', async () => {
    const { card, parsed, tool } = await prepare(
      'update_my_hours',
      {
        action: 'set_hours',
        userId: marco.id,
        weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '07:00', end: '15:00' })),
      },
      owner,
    );
    expect(card.title).toBe('Change Marco’s working hours');
    expect(card.fields.find((f) => f.label === 'Whose')!.value).toBe('Marco Member');
    expect(card.confirmLabel).toBe('Save the hours');
    const done = await confirm(tool!, parsed, owner);
    expect(done).toMatchObject({
      command: 'schedule.set',
      outcome: 'Marco’s hours are saved',
      href: expect.stringContaining(`?user=${marco.id}`),
    });
    const [saved] = await rows<{ weekly: { day: number; start: string }[] }>(
      testDbs().admin.db,
      sql`select weekly from app.schedules
          where workspace_id = ${workspaceId} and owner_kind = 'user' and owner_id = ${marco.id}`,
    );
    expect(saved!.weekly.map((w) => w.start)).toEqual([
      '07:00',
      '07:00',
      '07:00',
      '07:00',
      '07:00',
    ]);
  });

  it('names the time off it takes out and whose it is, and won’t take a teammate’s out as yours', async () => {
    const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const { exceptionId } = (await run(
      registry.command('time_off.add')! as CommandDef<z.ZodType, z.ZodType>,
      { workspaceId, ownerKind: 'user', ownerId: marco.id, startDate: day, note: 'Dentist' },
      owner,
    )) as { exceptionId: string };

    // Named as the owner's own, it isn't on their calendar: said before any card.
    await expect(
      prepare('update_my_hours', { action: 'remove_time_off', exceptionId }, owner),
    ).rejects.toMatchObject({
      rule: 'time_off_not_found',
      message: expect.stringContaining('give userId for a teammate’s'),
    });

    const { card, parsed, tool } = await prepare(
      'update_my_hours',
      { action: 'remove_time_off', userId: marco.id, exceptionId },
      owner,
    );
    expect(card.title).toBe('Put that time back');
    expect(card.fields).toEqual(
      expect.arrayContaining([
        { label: 'Whose', value: 'Marco Member' },
        { label: 'When', value: expect.stringContaining('all day') },
        { label: 'What it is', value: 'Dentist' },
        { label: 'What changes', value: 'Marco can be booked then again' },
      ]),
    );
    const done = await confirm(tool!, parsed, owner);
    expect(done).toMatchObject({ command: 'time_off.remove', outcome: 'Put back' });
    expect(
      await rows(
        testDbs().admin.db,
        sql`select id from app.schedule_exceptions where id = ${exceptionId}`,
      ),
    ).toEqual([]);
  });

  it('tells a member, before any card, that only owners and admins set someone else’s hours', async () => {
    await expect(
      prepare(
        'update_my_hours',
        { action: 'add_time_off', userId: owner.id, startDate: '2027-01-04' },
        marco,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Only owners and admins change someone else’s hours'),
    });
  });

  it('won’t set the hours of someone who isn’t on the team', async () => {
    await expect(
      prepare('update_my_hours', { action: 'set_hours', userId: randomUUID(), weekly: [] }, owner),
    ).rejects.toMatchObject({ message: expect.stringContaining('isn’t on this business’s team') });
  });
});

describe('the phone account, numbers from elsewhere, RCS senders and a test text', () => {
  /** The executor as the worker builds it, on the worker's own connection, with its telephony. */
  const withPhone = () =>
    createToolExecutor(testDbs().worker.db, null, null, '', undefined, {
      services: {
        telephony: createFakeTelephony({
          approvalMs: 0,
          callbacks: false,
          log: pino({ level: 'silent' }),
        }),
        publicUrl: 'https://worker.example.test',
      } as unknown as WorkerServices,
    });
  const ask = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = assistantToolByName.get(name)!;
    return (await withPhone().run(tool, tool.input.parse(args) as never, ctxFor(owner)))
      .result as Record<string, unknown>;
  };

  it('reads Phone & texting as the screen does: off, then on with its Account SIDs', async () => {
    const off = await ask('get_phone_account');
    expect(off['phoneAndTexting']).toBe('Off');
    expect(off['accountSid']).toBeUndefined();
    expect(off['numbersInTheAccount']).toBeUndefined();
    expect((await ask('list_rcs_senders'))['note']).toContain('Phone & texting is off');

    await rows(
      testDbs().admin.db,
      sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
          values (${workspaceId}, 'fake', ${`ACpa${suffix}`}, 'active')`,
    );
    const on = await ask('get_phone_account');
    expect(on).toMatchObject({
      phoneAndTexting: 'On',
      accountSid: `ACpa${suffix}`,
      parentAccountSid: FAKE_MASTER_SID,
      alreadySetUpHere: 0,
      numbersInTheAccount: [],
    });
    const tool = assistantToolByName.get('get_phone_account')!;
    expect(withPhone().reads?.(tool)).toBe(true);
  });

  it('looks up where a number is, saying how it would come here, and refuses what isn’t a number', async () => {
    const inTwilio = await ask('check_number_host', { e164: '+15125550142' });
    expect(inTwilio).toMatchObject({ number: '(512) 555-0142', inTwilio: true, alreadyHere: null });
    expect(inTwilio['note']).toContain('do_number_import_start');
    // Never give it up where it is, as the screen warns; a US number needs nothing more.
    expect(inTwilio['keepIt']).toContain('not to release or delete it');
    expect(inTwilio['outsideUsAndCanada']).toBeUndefined();
    const elsewhere = await ask('check_number_host', { e164: '+15125550009' });
    expect(elsewhere['inTwilio']).toBe(false);
    expect(elsewhere['note']).toContain('do_number_port_start');
    const abroad = await ask('check_number_host', { e164: '+442071838750' });
    expect(abroad['outsideUsAndCanada']).toContain('Regulatory Bundle SID');
    await expect(ask('check_number_host', { e164: 'call me' })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('says a Twilio account that isn’t connected isn’t, before listing or disconnecting anything', async () => {
    await expect(ask('list_twilio_numbers', { connectionId: randomUUID() })).rejects.toThrow(
      'That Twilio account is not connected any more.',
    );
    await expect(
      prepare('disconnect_twilio_account', { connectionId: randomUUID() }, owner),
    ).rejects.toThrow('That Twilio account isn’t connected.');
  });

  it('texts a test only on Confirm, to the phone given, and asks for one when there’s no confirmed cell', async () => {
    await expect(prepare('send_test_text', {}, owner)).rejects.toMatchObject({ rule: 'no_cell' });
    // The send's own refusals come before any card: with no business number yet, nothing could go.
    const to = { toPhone: '+17135550123' };
    await expect(prepare('send_test_text', to, owner)).rejects.toMatchObject({
      rule: 'no_number',
    });

    // A toll-free number cleared to text, and quiet hours from an hour ago to an hour from now.
    const [account] = await rows<{ id: string }>(
      testDbs().admin.db,
      sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
          values (${workspaceId}, 'fake', ${`ACtt${suffix}`}, 'active')
          on conflict (workspace_id) do update set status = 'active'
          returning id`,
    );
    const [number] = await rows<{ id: string }>(
      testDbs().admin.db,
      sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
          values (${workspaceId}, ${account!.id}, ${`PNtt${suffix}`},
            ${`+1833${String((Date.now() + 11) % 10_000_000).padStart(7, '0')}`}, 'toll_free', 'active')
          returning id`,
    );
    await rows(
      testDbs().admin.db,
      sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
          values (${workspaceId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved',
            ${`HHtt${suffix}`}, now())`,
    );
    const hhmm = (m: number) => {
      const x = ((m % 1440) + 1440) % 1440;
      return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    };
    const local = localMinutes(new Date(), CHI);
    await run(
      phoneUpdateSettings,
      {
        workspaceId,
        quietHours: { enabled: true, start: hhmm(local - 60), end: hhmm(local + 60) },
      },
      owner,
    );
    // In quiet hours it asks first, as Text me a test does; it goes then only when they said to send it anyway.
    await expect(prepare('send_test_text', to, owner)).rejects.toMatchObject({
      rule: 'quiet_hours',
    });

    const { card, parsed, tool } = await prepare(
      'send_test_text',
      { ...to, duringQuietHours: true },
      owner,
    );
    expect(card.title).toBe('Text a test to (713) 555-0123');
    expect(card.fields.find((f) => f.label === 'Says')!.value).toBe(
      `This is a test text from ${businessName} & Plumbing on HandsFreeOS. Replies land in the inbox.`,
    );
    expect(card.warnings[0]!.text).toContain('real text from your business number');
    expect(AssistantCard.safeParse(card).success).toBe(true);
    const tests = () =>
      rows<{ n: number }>(
        testDbs().admin.db,
        sql`select count(*)::int as n from app.messages
            where workspace_id = ${workspaceId} and body_text like 'This is a test text from%'`,
      );
    expect((await tests())[0]!.n).toBe(0);

    const done = await confirm(tool, parsed, owner);
    expect(done.outcome).toBe('Texted a test to (713) 555-0123');
    expect((await tests())[0]!.n).toBe(1);
  });
});
