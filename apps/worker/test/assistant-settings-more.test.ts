import { randomUUID } from 'node:crypto';
import {
  ADDON_MOVE_WORDS,
  ADDON_PAGE_WORDS,
  addonHoldsLines,
  assistantToolByName,
  BIN_WORDS,
  binDeletedWords,
  catalogAddon,
  executeCommand,
  executeQuery,
  hasWorkspacePermission,
  organizationCreate,
  personCreate,
  registry,
  screenReadName,
  type AssistantCard,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import {
  moreSettingsConfirmTools,
  moreSettingsStepLabels,
} from '../src/assistant/tools-settings-more';
import { allScreenReadTools } from '../src/assistant/tools-screen-reads';
import { createToolExecutor } from '../src/assistant/tools-write';

/**
 * The last settings the Assistant used to hand back (the owner, 2026-10-26): add-ons on and off and their own
 * settings, the Deleted bin, partners and Settings → Safety; and moving things to the bin (2026-10-27). Each card says what will really change, nothing changes until Confirm, and then
 * the screen's own command runs as the person.
 */

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
) => (await executeCommand(api(), cmd, input, actor(owner), meta())).output;

let owner: TestUser;
let workspaceId: string;
let organizationId: string;

const ctx = (): ToolContext => ({
  actor: actor(owner),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
const prepare = async (name: string, args: Record<string, unknown>) => {
  const tool = assistantToolByName.get(name)!;
  const parsed = tool.input.parse(args) as Record<string, unknown>;
  const out = await createToolExecutor(api()).prepare(tool, parsed, ctx(), randomUUID());
  return { card: out.card as ConfirmCard, parsed };
};
const confirm = (name: string, parsed: Record<string, unknown>) =>
  createToolExecutor(api()).commit(assistantToolByName.get(name)!, parsed, ctx(), {
    toolCallId: randomUUID(),
  });
const field = (card: ConfirmCard, label: string) =>
  card.fields.find((f) => f.label === label)?.value;
const q = async <T>(name: string, input: Record<string, unknown> = {}) =>
  (await executeQuery(
    api(),
    registry.query(name)!,
    { workspaceId, ...input },
    actor(owner),
    meta(),
  )) as T;
const customer = async (firstName: string) =>
  (
    (await run(personCreate, { workspaceId, firstName, lastName: 'Test' })) as {
      personId: string;
    }
  ).personId;

beforeAll(async () => {
  owner = await createTestUser('amore-owner', { fullName: 'Morgan Owner' });
  const org = (await run(organizationCreate, { businessName: 'More Settings Co' })) as {
    workspaceId: string;
    organizationId: string;
  };
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  // Social Outreach on: it brings partners.
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${workspaceId}, 'outreach', 'enabled', ${catalogAddon('outreach').version})`,
  );
}, 60_000);
afterAll(closeTestDbs);

describe('the last settings by asking', () => {
  it('each has a step label, asks first, and goes only to people the screens allow', () => {
    const names = Object.keys(moreSettingsConfirmTools);
    expect(names).toHaveLength(7);
    for (const name of names) {
      expect(assistantToolByName.get(name)?.autonomy, name).toBe('confirm');
      expect(moreSettingsStepLabels[name], name).toBeTruthy();
    }
    const member = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    const adminTools = toolsFor((p) => hasWorkspacePermission('admin', p)).map((t) => t.name);
    for (const name of ['manage_add_on', 'update_safety_settings', 'update_partner_settings'])
      expect(member, name).not.toContain(name);
    // The bin is for whoever is trusted with deleting: owners, to start.
    const ownerTools = toolsFor((p) => hasWorkspacePermission('owner', p)).map((t) => t.name);
    for (const name of names) expect(ownerTools, name).toContain(name);
    for (const name of names.filter((n) => n !== 'restore_from_bin' && n !== 'move_to_bin'))
      expect(adminTools, name).toContain(name);
    expect(adminTools).not.toContain('move_to_bin');
  });

  it('changes Safety’s times and safety person on Confirm', async () => {
    const before = await q<{ askAfterMinutes: number }>('safety.settings');
    const { card, parsed } = await prepare('update_safety_settings', {
      askAfterMinutes: before.askAfterMinutes === 10 ? 12 : 10,
      safetyUserId: owner.id,
    });
    expect(card.title).toBe('Change Safety');
    expect(field(card, 'Safety person')).toBe('Morgan Owner');
    expect(field(card, 'Was')).toBe('The owners and admins');
    expect((await q<{ safetyUserId: string | null }>('safety.settings')).safetyUserId).toBeNull();
    await confirm('update_safety_settings', parsed);
    const now = await q<{ askAfterMinutes: number; safetyUserId: string | null }>(
      'safety.settings',
    );
    expect(now.safetyUserId).toBe(owner.id);
    expect(now.askAfterMinutes).toBe(before.askAfterMinutes === 10 ? 12 : 10);
    await expect(prepare('update_safety_settings', { safetyUserId: owner.id })).rejects.toThrow(
      'Nothing would change',
    );
  });

  it('changes how partners are paid, and each partner, on Confirm', async () => {
    const { card, parsed } = await prepare('update_partner_settings', {
      sharePercent: 15,
      terms: 'Paid monthly for 12 months.',
    });
    expect(field(card, 'Their share')).toBe('15%');
    expect(card.warnings.map((w) => w.text).join(' ')).toContain('accept the new terms');
    await confirm('update_partner_settings', parsed);
    const { settings } = await q<{ settings: { rateBp: number; terms: string } }>(
      'partners.settings',
    );
    expect(settings).toMatchObject({ rateBp: 1500, terms: 'Paid monthly for 12 months.' });

    const dana = await customer('Dana');
    const add = await prepare('manage_partner', { action: 'add', personId: dana });
    expect(add.card.title).toBe('Make Dana Test a partner');
    expect((await confirm('manage_partner', add.parsed)).outcome).toBe('They’re a partner now');
    const { partners } = await q<{ partners: { partnerId: string; status: string }[] }>(
      'partner.list',
    );
    const partnerId = partners[0]!.partnerId;

    const share = await prepare('manage_partner', {
      action: 'set_share',
      partnerId,
      sharePercent: 20,
    });
    expect(field(share.card, 'Was')).toBe('15% (the business’s)');
    await confirm('manage_partner', share.parsed);

    const sam = await customer('Sam');
    const sent = await prepare('manage_partner', {
      action: 'set_referral',
      personId: sam,
      partnerId,
    });
    expect(sent.card.title).toBe('Mark Sam Test as sent by Dana Test');
    await confirm('manage_partner', sent.parsed);

    const pause = await prepare('manage_partner', { action: 'pause', partnerId });
    await confirm('manage_partner', pause.parsed);
    const after = await q<{ partners: { status: string; rateBp: number; clients: number }[] }>(
      'partner.list',
    );
    expect(after.partners[0]).toMatchObject({ status: 'paused', rateBp: 2000, clients: 1 });

    // A calendar nobody has is turned back before a card; taking the terms off asks no partner anything.
    await expect(prepare('update_partner_settings', { calendarId: randomUUID() })).rejects.toThrow(
      'No calendar has that id',
    );
    const noTerms = await prepare('update_partner_settings', { terms: '' });
    expect(field(noTerms.card, 'Terms')).toBe(
      'None: partners get their link without accepting any',
    );
    expect(noTerms.card.warnings.map((w) => w.text).join(' ')).not.toContain('accept');
  });

  it('changes one of an add-on’s own settings on Confirm, keeping the rest as they are', async () => {
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${workspaceId}, 'realestate', 'enabled', ${catalogAddon('realestate').version})`,
    );
    await run(registry.command('addon.save_settings')!, {
      workspaceId,
      addonId: 'realestate',
      settings: { keepClosedYears: 9, closedDays: { '2026-12-24': 'Christmas Eve' } },
    });
    const drafts = {
      under_contract: true,
      inspection_done: false,
      clear_to_close: true,
      closed: true,
    };
    const { card, parsed } = await prepare('update_addon_settings', {
      addonId: 'realestate',
      settings: { alertPersonUserIds: [owner.id], milestoneDrafts: drafts },
    });
    expect(card.title).toBe('Change Real Estate Agent’s settings');
    expect(card.fields).toEqual([
      { label: 'Who else hears critical alerts (none: the owners)', value: 'Morgan Owner' },
      {
        label: 'Client updates drafted at each milestone',
        value: 'Under contract: on; Inspection done: off; Clear to close: on; Closed: on',
      },
    ]);
    expect(card.warnings[0]!.text).toContain('Only what is listed changes');
    const before = await q<{ settings: Record<string, unknown> }>('addon.settings', {
      addonId: 'realestate',
    });
    // The screen's save keeps every setting, its defaults filled in: nobody else hears alerts yet.
    expect(before.settings).toMatchObject({ alertPersonUserIds: [], keepClosedYears: 9 });
    expect((await confirm('update_addon_settings', parsed)).outcome).toBe(
      'Saved Real Estate Agent’s settings',
    );
    const after = await q<{ settings: Record<string, unknown> }>('addon.settings', {
      addonId: 'realestate',
    });
    expect(after.settings).toMatchObject({
      keepClosedYears: 9,
      closedDays: { '2026-12-24': 'Christmas Eve' },
      alertPersonUserIds: [owner.id],
      milestoneDrafts: drafts,
    });

    const days = await prepare('update_addon_settings', {
      addonId: 'realestate',
      settings: { closedDays: { '2026-12-31': 'New Year’s Eve', '2026-12-24': 'Christmas Eve' } },
    });
    expect(field(days.card, 'Days the office is closed')).toBe(
      'Dec 31, 2026 (New Year’s Eve); Dec 24, 2026 (Christmas Eve)',
    );
    const refused = (settings: Record<string, unknown>) =>
      prepare('update_addon_settings', { addonId: 'realestate', settings });
    await expect(refused({ keepClosedYears: 9 })).rejects.toThrow('Nothing would change');
    await expect(
      refused({ closedDays: { '2026-12-24': 'Christmas Eve' }, keepClosedYears: 9 }),
    ).rejects.toThrow('Nothing would change');
    await expect(refused({ keepClosedYears: 0 })).rejects.toThrow(
      'That won’t work for “Years a closed deal is kept”: Keep closed deals at least 1 year.',
    );
    await expect(refused({ closingDays: {} })).rejects.toThrow(
      'Real Estate Agent has no setting called closingDays',
    );
    await expect(refused({ tourCalendarId: randomUUID() })).rejects.toThrow(
      'isn’t anyone on the team or any calendar here',
    );
    await expect(
      prepare('update_addon_settings', { addonId: 'nosuch', settings: { a: 1 } }),
    ).rejects.toThrow('No add-on has that id');

    // Read as the settings page shows them, each setting named in the page's words.
    const reader = allScreenReadTools().find((t) => t.name === screenReadName('addon.settings'))!;
    const shown = (await createToolExecutor(api()).run(
      reader,
      reader.input.parse({ addonId: 'realestate' }) as never,
      ctx(),
    )) as { result: { data: { labels?: Record<string, string> } } };
    expect(shown.result.data.labels).toMatchObject({
      keepClosedYears: 'Years a closed deal is kept',
    });
    // Someone who doesn't see every deal would never hear its alerts: refused by name, before any card.
    const agent = await createTestUser('amore-agent', { fullName: 'Avery Agent' });
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${workspaceId}, ${agent.id}, 'member')`,
    );
    await expect(refused({ alertPersonUserIds: [owner.id, agent.id] })).rejects.toThrow(
      'Avery Agent doesn’t see every deal',
    );
  });

  it('changes one part of a group of Social Outreach’s settings, keeping the rest, and links to where they are', async () => {
    // Saved before its defaults were filled in: the Assistant reads them as the settings page shows them.
    await rows(
      admin(),
      sql`update app.addon_installations
          set settings = ${JSON.stringify({ rules: { dailyLimits: { like: 30 } } })}::jsonb
          where workspace_id = ${workspaceId} and addon_id = 'outreach'`,
    );
    const reader = allScreenReadTools().find((t) => t.name === screenReadName('addon.settings'))!;
    const shown = (await createToolExecutor(api()).run(
      reader,
      reader.input.parse({ addonId: 'outreach' }) as never,
      ctx(),
    )) as { result: { data: { settings: Record<string, unknown> } } };
    expect(shown.result.data.settings).toMatchObject({
      weeklyReport: true,
      extensionLink: null,
      rules: { dailyLimits: { like: 30 }, autopilotAllowed: true },
    });

    // One daily limit: the others, and the rest of the team's rules, stay as they are.
    const { card, parsed } = await prepare('update_addon_settings', {
      addonId: 'outreach',
      settings: { rules: { dailyLimits: { friend_request: 12 } } },
    });
    expect(card.fields).toHaveLength(1);
    expect(card.fields[0]!.label).toBe('Rules → Daily limits');
    expect(card.fields[0]!.value).toContain('Friend request: 12');
    expect(card.fields[0]!.value).toContain('Like: 30');
    const done = await confirm('update_addon_settings', parsed);
    expect(done.outcome).toBe('Saved Social Outreach’s settings');
    // Its settings are on its own Settings page, under Team.
    expect(done.href).toBe(`/app/w/${workspaceId}/a/outreach/settings/team`);
    const rulesNow = async () =>
      (
        await q<{ settings: { rules: Record<string, unknown> } }>('addon.settings', {
          addonId: 'outreach',
        })
      ).settings.rules;
    expect(await rulesNow()).toMatchObject({
      dailyLimits: { friend_request: 12, like: 30 },
      autopilotAllowed: true,
    });

    // Null takes one limit off, back to none; the other stays.
    const off = await prepare('update_addon_settings', {
      addonId: 'outreach',
      settings: { rules: { dailyLimits: { like: null } } },
    });
    expect(field(off.card, 'Rules → Daily limits')).toBe('Friend request: 12');
    await confirm('update_addon_settings', off.parsed);
    expect((await rulesNow())['dailyLimits']).toEqual({ friend_request: 12 });
    await expect(
      prepare('update_addon_settings', {
        addonId: 'outreach',
        settings: { rules: { dailyLimits: { friend_request: 12 } } },
      }),
    ).rejects.toThrow('Nothing would change');
    // A part its group doesn't have is refused by its name, never dropped as the settings are checked.
    await expect(
      prepare('update_addon_settings', {
        addonId: 'outreach',
        settings: { rules: { dailyLimit: { like: 5 } } },
      }),
    ).rejects.toThrow(
      'Social Outreach has no setting called rules.dailyLimit. The parts of rules are sendingAllowed',
    );
  });

  it('brings something back from the Deleted bin on Confirm, never empties it', async () => {
    const lee = await customer('Lee');
    const deleted = (await run(registry.command('person.delete')!, {
      workspaceId,
      personIds: [lee],
    })) as { deleted: { binItemId: string }[] };
    const binItemId = deleted.deleted[0]!.binItemId;
    const { card, parsed } = await prepare('restore_from_bin', { binItemId });
    expect(card.title).toBe('Bring back Lee Test');
    expect(field(card, 'Customer')).toBe('Lee Test');
    expect((await confirm('restore_from_bin', parsed)).outcome).toBe('Lee Test is back');
    const { items } = await q<{ items: { id: string }[] }>('bin.list');
    expect(items.map((i) => i.id)).not.toContain(binItemId);
    expect(assistantToolByName.has('empty_bin')).toBe(false);
  });

  it('moves a customer to the Deleted bin on Confirm, saying what goes with them', async () => {
    const kai = await customer('Kai');
    const { card, parsed } = await prepare('move_to_bin', { kind: 'person', ids: [kai] });
    expect(card.title).toBe('Delete Kai Test for good?');
    expect(field(card, 'Customer')).toBe('Kai Test');
    expect(card.confirmLabel).toBe(BIN_WORDS.submit);
    // Nothing goes until Confirm.
    expect(
      (await q<{ items: { name: string }[] }>('bin.list')).items.map((i) => i.name),
    ).not.toContain('Kai Test');
    const done = await confirm('move_to_bin', parsed);
    expect(done.outcome).toBe(binDeletedWords('person', ['Kai Test']));
    expect((await q<{ items: { name: string }[] }>('bin.list')).items.map((i) => i.name)).toContain(
      'Kai Test',
    );
    // Gone already: said before any card, in the bin's own words.
    await expect(prepare('move_to_bin', { kind: 'person', ids: [kai] })).rejects.toThrow(
      'That isn’t here any more',
    );
  });

  it('turns an add-on off and on again, saying what everyone loses', async () => {
    await expect(
      prepare('manage_add_on', { action: 'turn_on', addonId: 'outreach' }),
    ).rejects.toThrow('Nothing would change');
    const off = await prepare('manage_add_on', { action: 'turn_off', addonId: 'outreach' });
    expect(off.card.title).toBe('Turn off Social Outreach');
    // The page's own words for what turning it off does, and what it has here that stays.
    expect(off.card.warnings[0]!.text).toBe(ADDON_MOVE_WORDS.disable.consequence);
    const { holds } = await q<{ holds: Parameters<typeof addonHoldsLines>[1] }>('addon.impact', {
      addonId: 'outreach',
      action: 'disable',
    });
    const held = addonHoldsLines('disable', holds);
    expect(field(off.card, ADDON_PAGE_WORDS.whatItHolds)).toBe(
      held.length ? held.join(' ') : undefined,
    );
    expect((await confirm('manage_add_on', off.parsed)).outcome).toBe('Social Outreach is off');
    const state = async () =>
      (
        await rows<{ state: string }>(
          admin(),
          sql`select state::text from app.addon_installations
              where workspace_id = ${workspaceId} and addon_id = 'outreach'`,
        )
      )[0]?.state;
    expect(await state()).toBe('disabled');
    const on = await prepare('manage_add_on', { action: 'turn_on', addonId: 'outreach' });
    await confirm('manage_add_on', on.parsed);
    expect(await state()).toBe('enabled');
  });
});
