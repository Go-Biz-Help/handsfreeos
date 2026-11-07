import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  executeCommand,
  executeQuery,
  formatPhone,
  hasWorkspacePermission,
  organizationCreate,
  registry,
  SAFETY_CONTACT_WORDS,
  SAFETY_PHONE_WORDS,
  safetyMapLink,
  screenReadName,
  type AssistantCard,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import {
  safetyAutoTools,
  safetyConfirmTools,
  safetyStepLabels,
} from '../src/assistant/tools-safety';
import { allScreenReadTools } from '../src/assistant/tools-screen-reads';
import { createToolExecutor } from '../src/assistant/tools-write';

/**
 * The person's own safety, by asking (the owner's rules for check-ins): checking in, adding time and checking out
 * run on their own and change only their own check-in; asking for help waits on a card that first says to call 911
 * and names who is told; their own contacts change on a card. Each runs the phone's own command, as them.
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

let owner: TestUser;
let agent: TestUser;
let mate: TestUser;
let workspaceId: string;
let organizationId: string;
const businessName = 'Safe Hands Plumbing';
const samPhone = `+1512555${String(Math.floor(1000 + Math.random() * 8999))}`;

const ctx = (u: TestUser): ToolContext => ({
  actor: actor(u),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
/** Runs a tool that changes things on its own, the way the runtime does. */
const run = async (name: string, args: Record<string, unknown>, u: TestUser) => {
  const tool = assistantToolByName.get(name)!;
  return (await createToolExecutor(api()).run(tool, tool.input.parse(args) as never, ctx(u))) as {
    result: Record<string, unknown>;
    command?: string;
    record?: { outcome: string; href: string | null };
  };
};
const prepare = async (name: string, args: Record<string, unknown>, u: TestUser) => {
  const tool = assistantToolByName.get(name)!;
  const parsed = tool.input.parse(args) as Record<string, unknown>;
  const out = await createToolExecutor(api()).prepare(tool, parsed, ctx(u), randomUUID());
  return { card: out.card as ConfirmCard, parsed, result: out.result as Record<string, unknown> };
};
const confirm = (name: string, parsed: Record<string, unknown>, u: TestUser) =>
  createToolExecutor(api()).commit(assistantToolByName.get(name)!, parsed, ctx(u), {
    toolCallId: randomUUID(),
  });
const field = (card: ConfirmCard, label: string) =>
  card.fields.find((f) => f.label === label)?.value;

interface Mine {
  contacts: { id: string; contactUserId: string | null; name: string; status: string }[];
  open: {
    id: string;
    place: string;
    plannedEndAt: string;
    state: string;
    follows: boolean;
    locatedAt: string | null;
  } | null;
}
const mineOf = (u: TestUser) =>
  executeQuery(
    api(),
    registry.query('safety.mine')!,
    { workspaceId },
    actor(u),
    meta(),
  ) as Promise<Mine>;
/** Reads a screen's query by asking, as the person. */
const read = async (query: string, args: Record<string, unknown>, u: TestUser) => {
  const tool = allScreenReadTools().find((t) => t.name === screenReadName(query))!;
  return (
    (await createToolExecutor(api()).run(tool, tool.input.parse(args) as never, ctx(u))) as {
      result: { data: unknown };
    }
  ).result.data;
};
/** An hour or two from now, as the model passes a time. */
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeAll(async () => {
  [owner, agent, mate] = await Promise.all([
    createTestUser('asafe-owner', { fullName: 'Hana Owner' }),
    createTestUser('asafe-agent', { fullName: 'Dana Reyes' }),
    createTestUser('asafe-mate', { fullName: 'Marcus Lee' }),
  ]);
  const org = (
    await executeCommand(api(), organizationCreate, { businessName }, actor(owner), meta())
  ).output as { workspaceId: string; organizationId: string };
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  for (const u of [agent, mate])
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${u.id}, 'member')`,
    );
}, 60_000);
afterAll(closeTestDbs);

describe('the person’s own safety by asking', () => {
  it('checks in on its own, asks first for help and contacts, and is everyone’s', () => {
    expect(assistantToolByName.get('my_check_in')?.autonomy).toBe('auto');
    expect(assistantToolByName.get('ask_for_help')?.autonomy).toBe('confirm');
    expect(assistantToolByName.get('manage_my_safety_contacts')?.autonomy).toBe('confirm');
    const names = [...Object.keys(safetyAutoTools), ...Object.keys(safetyConfirmTools)];
    expect(names.sort()).toEqual(['ask_for_help', 'manage_my_safety_contacts', 'my_check_in']);
    const member = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    for (const name of names) {
      expect(safetyStepLabels[name], name).toBeTruthy();
      expect(member, name).toContain(name);
    }
    // The words first say to call 911, and that HandsFreeOS never does.
    expect(assistantToolByName.get('ask_for_help')!.description).toContain('911');
  });

  it('adds a teammate and someone outside as their own contacts, on a card that says how each is told', async () => {
    const teammate = await prepare(
      'manage_my_safety_contacts',
      { action: 'add_teammate', contactUserId: mate.id },
      agent,
    );
    expect(teammate.card.title).toBe('Tell Marcus Lee if you don’t check out');
    expect(field(teammate.card, 'How they’re told')).toBe(SAFETY_CONTACT_WORDS.teammate);
    expect(field(teammate.card, 'Who’s told now')).toBe('Nobody of your own (0 of 5)');
    expect(teammate.card.warnings[0]!.text).toContain('Marcus gets an alert in the app');
    // Nothing changes before Confirm.
    expect((await mineOf(agent)).contacts).toEqual([]);
    const added = await confirm('manage_my_safety_contacts', teammate.parsed, agent);
    expect(added.outcome).toBe('Added Marcus Lee');
    expect(added.href).toBe(`/app/w/${workspaceId}/safety`);
    expect((await mineOf(agent)).contacts.map((c) => [c.name, c.status])).toEqual([
      ['Marcus Lee', 'teammate'],
    ]);
    await expect(
      prepare(
        'manage_my_safety_contacts',
        { action: 'add_teammate', contactUserId: mate.id },
        agent,
      ),
    ).rejects.toMatchObject({ rule: 'safety_contact_already' });

    // An email alone is never asked, so the card says they'd never be told.
    const emailOnly = await prepare(
      'manage_my_safety_contacts',
      { action: 'add_outside', name: 'Sam Ortiz', email: 'sam.ortiz@safehands.example' },
      agent,
    );
    expect(field(emailOnly.card, 'Email')).toBe('sam.ortiz@safehands.example');
    expect(field(emailOnly.card, 'Phone')).toBeUndefined();
    expect(emailOnly.card.warnings.map((w) => w.text).join(' ')).toContain('never told');
    // No text asks them, so the card doesn't say one will.
    expect(emailOnly.card.warnings.map((w) => w.text)).not.toContain(
      SAFETY_PHONE_WORDS.outsideNote,
    );

    const outside = await prepare(
      'manage_my_safety_contacts',
      {
        action: 'add_outside',
        name: 'Sam Ortiz',
        phone: samPhone,
        email: 'sam.ortiz@safehands.example',
      },
      agent,
    );
    expect(outside.card.title).toBe('Tell Sam Ortiz if you don’t check out');
    expect(field(outside.card, 'Phone')).toBe(formatPhone(samPhone));
    expect(field(outside.card, 'Who’s told now')).toBe('Marcus Lee (1 of 5)');
    expect(outside.card.warnings.map((w) => w.text)).toEqual([SAFETY_PHONE_WORDS.outsideNote]);
    const asked = await confirm('manage_my_safety_contacts', outside.parsed, agent);
    expect(asked.outcome).toBe('Added Sam Ortiz: they get a text asking them to reply OK');
    const sam = (await mineOf(agent)).contacts.find((c) => c.name === 'Sam Ortiz')!;
    expect(sam.status).toBe('asked');

    // Only ever their own: a teammate can't touch them.
    await expect(
      prepare('manage_my_safety_contacts', { action: 'remove', contactId: sam.id }, mate),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('checks them in, adds time and checks out, and only ever theirs', async () => {
    await expect(run('my_check_in', { action: 'check_out' }, agent)).rejects.toMatchObject({
      rule: 'safety_not_checked_in',
    });
    await expect(
      run('my_check_in', { action: 'start', place: '14 Elm St' }, agent),
    ).rejects.toMatchObject({ code: 'validation' });

    const started = await run(
      'my_check_in',
      { action: 'start', place: 'The Garcias’ place, 14 Elm St', until: inHours(2) },
      agent,
    );
    expect(started.command).toBe('safety.check_in');
    expect(started.record?.href).toBe(`/app/w/${workspaceId}/safety`);
    expect(started.result['checkedIn']).toBe('The Garcias’ place, 14 Elm St');
    // Marcus is told; Sam hasn't agreed yet, so isn't.
    expect(started.result['ifYouDontCheckOut']).toContain('Marcus Lee is told');
    expect(started.result['notTold']).toEqual([`Sam Ortiz: ${SAFETY_CONTACT_WORDS.asked}`]);
    expect(started.result['note']).toBeUndefined();
    expect(started.result['sharingWhereYouAre']).toContain('only the phone');
    const open = (await mineOf(agent)).open!;
    expect(open).toMatchObject({
      place: 'The Garcias’ place, 14 Elm St',
      state: 'in',
      follows: false,
    });
    expect(open.locatedAt).toBeNull();

    const more = await run('my_check_in', { action: 'add_time', minutes: 30 }, agent);
    expect(more.command).toBe('safety.extend');
    const later = (await mineOf(agent)).open!;
    expect(Date.parse(later.plannedEndAt) - Date.parse(open.plannedEndAt)).toBe(30 * 60_000);
    // Left out, it adds 15 minutes, as the banner's +15 min does.
    await run('my_check_in', { action: 'add_time' }, agent);
    expect(
      Date.parse((await mineOf(agent)).open!.plannedEndAt) - Date.parse(later.plannedEndAt),
    ).toBe(15 * 60_000);

    // A teammate can't check them out: theirs is the only one the tool sees.
    await expect(run('my_check_in', { action: 'check_out' }, mate)).rejects.toMatchObject({
      rule: 'safety_not_checked_in',
    });
    expect((await mineOf(agent)).open).not.toBeNull();

    const out = await run('my_check_in', { action: 'check_out' }, agent);
    expect(out.command).toBe('safety.check_out');
    expect(out.result['said']).toBe(SAFETY_PHONE_WORDS.checkedOut);
    expect(out.result['told']).toBeUndefined();
    expect((await mineOf(agent)).open).toBeNull();
  });

  it('asks for help only on a card that first says to call 911, and names who is told', async () => {
    // Not checked in, and nowhere said: it asks where, with the 911 words.
    await expect(prepare('ask_for_help', {}, agent)).rejects.toThrow(/911/);

    await run(
      'my_check_in',
      { action: 'start', place: 'Unit 4B, 220 Lake Rd', until: inHours(1) },
      agent,
    );
    const help = await prepare('ask_for_help', {}, agent);
    expect(help.card.title).toBe('Ask for help now');
    expect(help.card.confirmLabel).toBe('Tell them now');
    expect(help.card.warnings[0]).toEqual({
      kind: 'caution',
      text: 'In danger? Call 911 now. HandsFreeOS never calls 911.',
    });
    expect(help.card.warnings[1]!.text).toContain('Marcus Lee is told at once');
    expect(field(help.card, 'Where')).toBe('Unit 4B, 220 Lake Rd');
    expect(field(help.card, 'Told at once')).toBe('Marcus Lee in the app');
    expect(field(help.card, 'Then')).toContain('every 10 minutes');
    expect(field(help.card, 'Not told')).toContain('Sam Ortiz');
    expect(help.result['toldAtOnce']).toEqual(['Marcus Lee']);
    // Nobody is told before Confirm.
    expect((await mineOf(agent)).open!.state).toBe('in');

    const done = await confirm('ask_for_help', help.parsed, agent);
    expect(done.command).toBe('safety.help');
    expect(done.outcome).toBe(
      'Marcus is being told now, with where you are. If you’re in danger, call 911.',
    );
    const open = (await mineOf(agent)).open!;
    expect(open.state).toBe('help');

    // A new check-in would leave this one telling them, out of my_check_in's reach: it asks to check out first.
    await expect(
      run('my_check_in', { action: 'start', place: '9 Pine Ct', until: inHours(1) }, agent),
    ).rejects.toMatchObject({
      rule: 'safety_still_told',
      message: expect.stringContaining('check out of it first'),
    });
    expect((await mineOf(agent)).open!.id).toBe(open.id);

    // Marcus, told in the app, reads the alert with the map link its Where their phone was opens.
    await rows(
      admin(),
      sql`update app.safety_checkins set latitude = 30.2672, longitude = -97.7431, located_at = now()
          where id = ${open.id}`,
    );
    await rows(
      admin(),
      sql`insert into app.safety_escalations (workspace_id, checkin_id, told_user_id, channel)
          values (${workspaceId}, ${open.id}, ${mate.id}, 'app')`,
    );
    const alert = (await read('safety.alert', { checkInId: open.id }, mate)) as {
      alert: { personName: string; place: string; mapUrl: string | null } | null;
    };
    expect(alert.alert).toMatchObject({ personName: 'Dana Reyes', place: 'Unit 4B, 220 Lake Rd' });
    expect(alert.alert!.mapUrl).toBe(safetyMapLink(30.2672, -97.7431));
    // Someone who wasn't told reads nothing.
    expect(
      ((await read('safety.alert', { checkInId: open.id }, owner)) as { alert: unknown }).alert,
    ).toBeNull();

    // Checking out after asking tells everyone who was told that they're OK.
    const out = await run('my_check_in', { action: 'check_out' }, agent);
    expect(out.result['told']).toContain('hears you’re OK');
  });

  it('with nobody of their own, names the safety person, or the owners and admins', async () => {
    // The only owner, with nobody of their own and no safety person: nobody would be told, and the card says so.
    const alone = await prepare('ask_for_help', { place: 'Warehouse on 5th St' }, owner);
    expect(field(alone.card, 'Told at once')).toContain('Nobody');
    expect(field(alone.card, 'Then')).toBeUndefined();
    expect(alone.card.warnings[0]!.text).toContain('911');
    expect(alone.card.warnings[1]).toMatchObject({
      kind: 'caution',
      text: expect.stringContaining('Nobody in HandsFreeOS would be told'),
    });
    expect(alone.result['toldAtOnce']).toEqual([]);
    const ownerIn = await run(
      'my_check_in',
      { action: 'start', place: 'Warehouse on 5th St', until: inHours(1) },
      owner,
    );
    expect(ownerIn.result['ifYouDontCheckOut']).toContain('nobody else is told');
    await run('my_check_in', { action: 'check_out' }, owner);

    const owners = await prepare('ask_for_help', { place: 'Warehouse on 5th St' }, mate);
    expect(field(owners.card, 'Where')).toBe('Warehouse on 5th St');
    expect(field(owners.card, 'Told at once')).toBe(
      'Hana Owner, the business’s owners and admins, in the app',
    );
    expect(owners.result['because']).toBeTruthy();

    await executeCommand(
      api(),
      registry.command('safety.settings_save')!,
      { workspaceId, askAfterMinutes: 5, alertAfterMinutes: 10, safetyUserId: agent.id },
      actor(owner),
      meta(),
    );
    const person = await prepare('ask_for_help', { place: 'Warehouse on 5th St' }, mate);
    expect(field(person.card, 'Told at once')).toBe(
      'Dana Reyes, the business’s safety person, in the app',
    );
    // Starting a check-in with nobody of their own says how to choose someone.
    const started = await run(
      'my_check_in',
      { action: 'start', place: 'Warehouse on 5th St', until: inHours(1) },
      mate,
    );
    expect(started.result['ifYouDontCheckOut']).toContain('Dana Reyes is told');
    expect(started.result['note']).toContain('manage_my_safety_contacts');
    await run('my_check_in', { action: 'check_out' }, mate);
  });

  it('removes one of their own contacts on a card that says they won’t be told', async () => {
    const marcus = (await mineOf(agent)).contacts.find((c) => c.name === 'Marcus Lee')!;
    const { card, parsed } = await prepare(
      'manage_my_safety_contacts',
      { action: 'remove', contactId: marcus.id },
      agent,
    );
    expect(card.title).toBe('Remove Marcus Lee');
    expect(field(card, 'How they’re told now')).toBe(SAFETY_CONTACT_WORDS.teammate);
    // Sam is still listed, with how he's told: not yet, since he hasn't replied OK.
    expect(field(card, 'Still on your list')).toBe(`Sam Ortiz (${SAFETY_CONTACT_WORDS.asked})`);
    expect(card.warnings[0]!.text).toBe(
      'Marcus won’t be told if you don’t check out or ask for help.',
    );
    // Sam hasn't agreed, so nobody of their own is left to tell.
    expect(card.warnings[1]!.text).toContain('safety person');
    const done = await confirm('manage_my_safety_contacts', parsed, agent);
    expect(done.outcome).toBe('Removed Marcus Lee');
    expect((await mineOf(agent)).contacts.map((c) => c.name)).toEqual(['Sam Ortiz']);
    await expect(
      prepare('manage_my_safety_contacts', { action: 'remove', contactId: marcus.id }, agent),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
