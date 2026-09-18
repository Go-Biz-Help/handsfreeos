import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  AssistantCard,
  calendarCreate,
  executeCommand,
  executeQuery,
  hasWorkspacePermission,
  organizationCreate,
  registry,
  serviceCreate,
  SETTINGS_AREAS,
  settingsArea,
  settingsMapText,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';

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
  const org = (await run(
    organizationCreate,
    { businessName: 'Settings HVAC', timezone: CHI },
    owner,
  )) as { workspaceId: string; organizationId: string };
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
    expect(JSON.stringify(result['business'])).toContain('Settings HVAC');
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
        minNoticeHours: 4,
      },
      owner,
    );
    expect(card.type).toBe('confirm');
    expect(card.title).toBe('Set up Duct cleaning');
    expect(card.confirmLabel).toBe('Set it up');
    expect(card.editable).toBe(false);
    expect(card.fields.map((f) => f.label)).toContain('Hours');
    expect(card.fields.find((f) => f.label === 'Notice to book')!.value).toBe('4 hours');
    expect(AssistantCard.safeParse(card).success).toBe(true);
    // Nothing happened yet: the card is a proposal.
    expect((await calendars()).items.length).toBe(before);

    const done = await confirm(tool!, parsed, owner);
    expect(done.command).toBe('calendar.create');
    expect(done.outcome).toContain('Duct cleaning');
    const made = (await calendars()).items.find((c) => c.name === 'Duct cleaning');
    expect(made).toBeTruthy();
    expect(done.href).toContain(made!.id);
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
    expect(card.fields.find((f) => f.label === 'Price')!.value).toBe('$129.00');
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
    expect(card.fields.find((f) => f.label === 'Name')!.value).toBe('Settings HVAC');
    expect(card.fields.find((f) => f.label === 'Address')!.value).toBe('/book/settings-hvac');
    expect(card.warnings[0]!.text).toContain('book themselves');
    await confirm(tool!, parsed, owner);
    const now = await site();
    expect(now!.enabled).toBe(false);
    expect(now!.name).toBe('Settings HVAC');
  });
});
