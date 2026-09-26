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
  TEAMMATE_TOOL_NAMES,
  settingsMapText,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
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
});

const q = async <T>(name: string, input: Record<string, unknown> = {}) =>
  (await executeQuery(api(), registry.query(name)!, { workspaceId, ...input }, actor(owner), {
    correlationId: randomUUID(),
    channel: 'test' as const,
  })) as T;

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
    expect(early.card.warnings[0]!.text).toContain('before the invoice');
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

describe('what Home watches for', () => {
  it('turns a kind off without touching the others, and refuses automatic follow-ups it cannot turn on', async () => {
    const { card, parsed, tool } = await prepare(
      'update_action_center_settings',
      { kindsOff: ['overdue_task'], bigJobDollars: 7500 },
      owner,
    );
    expect(card.fields.find((f) => f.label === 'A big job is')!.value).toBe('$7,500.00 or more');
    await confirm(tool!, parsed, owner);
    const after = await q<{
      settings: { kinds: Record<string, boolean>; hot: { minValueCents: number } };
    }>('attention.settings');
    expect(after.settings.kinds['overdue_task']).toBe(false);
    expect(after.settings.kinds['hot_lead']).toBe(true);
    expect(after.settings.hot.minValueCents).toBe(750_000);

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
      'Not working until set up: New lead greeting: Turn on Respond on the AI teammate’s page to start.',
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
});
