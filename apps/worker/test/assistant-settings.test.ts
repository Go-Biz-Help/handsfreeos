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
  organizationCreate,
  personCreate,
  registry,
  resourceCreate,
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
import { createFakeTelephony } from '../src/telephony/fake';

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

  it('leaves only the card to the person on Usage & balance: topping up and the AI limit are its to do', async () => {
    const { result } = await readTool('settings_help', 'usage', owner);
    const theirs = result['theyDoThemselves'] as { what: string }[];
    expect(theirs.map((t) => t.what)).toEqual(['add a card, or use a different one']);
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

    await run(bookingSiteSetPage, { workspaceId, on: true }, owner);
    const after = (await read('booking_site'))['bookingSite']!;
    expect(after.yourPage).toContain(`Showing at ${web}/book/${slug}`);

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
});

describe('the team', () => {
  it('says an invitation is an email to a person, and what losing a teammate means', async () => {
    const invite = await prepare(
      'manage_team',
      { action: 'invite', email: 'marco@settingshvac.example', role: 'member' },
      owner,
    );
    expect(invite.card.title).toBe('Invite marco@settingshvac.example');
    expect(invite.card.fields.find((f) => f.label === 'Role')!.value).toContain('Member');
    expect(invite.card.warnings[0]!.text).toContain('email');
    await confirm(invite.tool!, invite.parsed, owner);
    const { invitations } = await q<{ invitations: { email: string; role: string }[] }>(
      'workspace.invitations',
    );
    expect(invitations.map((i) => i.email)).toContain('marco@settingshvac.example');

    const removal = await prepare('manage_team', { action: 'remove', userId: owner.id }, owner);
    expect(removal.card.warnings[0]!.text).toContain('way in');
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
    expect(getting.card.warnings[0]!.text).toContain('costs money every month');

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
  it('reads the whole form back before it goes, and says the carriers decide', async () => {
    const { card } = await prepare(
      'submit_carrier_registration',
      {
        kind: 'a2p_10dlc',
        legalName: 'Settings HVAC LLC',
        businessType: 'llc',
        ein: '12-3456789',
        website: 'https://settingshvac.example',
        addressLine1: '400 Main St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        contactFirstName: 'Dale',
        contactLastName: 'Owner',
        contactEmail: 'dale@settingshvac.example',
        contactPhone: '+17135550100',
        useCase: 'customer_care',
        messageSamples: [
          'Hi Mike, this is Dale at Settings HVAC confirming your visit tomorrow at 9 AM.',
          'Your technician is on the way and should arrive in about 20 minutes.',
        ],
        optInDescription:
          'Customers give us their number on our booking page and tick a box agreeing to get texts about their visit.',
        monthlyVolume: 'under_1000',
      },
      owner,
    );
    expect(card.title).toBe('Send your texting registration');
    expect(card.fields.find((f) => f.label === 'Business')!.value).toBe('Settings HVAC LLC');
    expect(card.fields.find((f) => f.label === 'Address')!.value).toBe(
      '400 Main St, Houston, TX, 77002',
    );
    expect(card.fields.find((f) => f.label === 'Texts are for')!.value).toBe('Answering customers');
    expect(card.fields.find((f) => f.label === 'Examples')!.value).toBe('2 example texts');
    expect(card.warnings[0]!.text).toContain('few days');
    // A local registration's carrier fees are the business's (0105), and the card says so before it goes.
    expect(card.warnings[1]!.text).toContain('carrier fees, passed on at cost');
    expect(AssistantCard.safeParse(card).success).toBe(true);
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

describe('what Home watches for', () => {
  it('turns a kind off without touching the others, and refuses automatic follow-ups it cannot turn on', async () => {
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

    // Follow-ups stay off until someone has read the wording, so the card offers no Confirm at all.
    const nudges = await prepare(
      'update_action_center_settings',
      { followUpOnQuietLeads: true },
      owner,
    );
    expect(nudges.card.confirmLabel).toBe('');
    expect(nudges.card.warnings[0]!.text).toContain('read and agreed');
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
    // No phone signed in to the app yet: phone alerts reach nobody, and the model can say so.
    expect(result['phonesForAlerts']).toEqual([]);
  });

  it('turns one email off without touching the others, and keeps your name', async () => {
    const { card, parsed, tool } = await prepare(
      'update_my_account',
      { morningEmail: false, appearance: 'dark' },
      owner,
    );
    expect(card.fields.find((f) => f.label === 'Appearance')!.value).toBe('Dark');
    expect(card.fields.find((f) => f.label === 'Email when: The morning list')!.value).toBe('No');
    await confirm(tool!, parsed, owner);

    const me = await q<{ user: { fullName: string; settings: Record<string, unknown> } }>(
      'account.me',
    );
    expect(me.user.fullName).toBe('Dale Owner');
    expect(me.user.settings['theme']).toBe('dark');
    const notifications = me.user.settings['notifications'] as Record<string, boolean>;
    expect(notifications['attentionDigest']).toBe(false);

    // A second change leaves the first alone.
    const again = await prepare('update_my_account', { emailWhenPaid: false }, owner);
    await confirm(again.tool!, again.parsed, owner);
    const after = await q<{ user: { settings: Record<string, unknown> } }>('account.me');
    const now = after.user.settings['notifications'] as Record<string, boolean>;
    expect(now['attentionDigest']).toBe(false);
    expect(now['paymentEmail']).toBe(false);
    expect(after.user.settings['theme']).toBe('dark');
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
