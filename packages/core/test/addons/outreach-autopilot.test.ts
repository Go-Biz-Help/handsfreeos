/**
 * Social Outreach: Autopilot, with a daily OK on who it reaches (docs/outreach.md, decision 151). One switch turns
 * everything on its own on every network the person works, over their own picks, which come back when it's off. An
 * hour before each working day it lists the people it plans to reach whom they haven't OK'd, with a few spares past
 * each limit; nobody on it is reached till they're OK'd, and anyone found later waits for the next day's list.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand, registry, type CommandDef } from '../../src/server';
import {
  AUTOMATION_DEFAULTS,
  autopilotOver,
  BusinessRules,
  keepOwnPicks,
  withinRules,
} from '../../src/addons/outreach/automation';
import {
  AUTOPILOT_WORDS,
  autopilotDayDue,
  autopilotSpares,
  autopilotTimes,
  nextAutopilotList,
  waitsForPeopleOk,
} from '../../src/addons/outreach/autopilot';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { goesAsItIs } from '../../src/addons/outreach/sends';
import { localInstant } from '../../src/calendar/engine/zoned';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const CHICAGO = 'America/Chicago';
const HOURS = AUTOMATION_DEFAULTS.hours;
const at = (date: string, clock: string) => localInstant(date, clock, CHICAGO);

describe('what Autopilot turns on', () => {
  const rules = BusinessRules.parse({});
  const mine = {
    ...AUTOMATION_DEFAULTS,
    sending: 'steps' as const,
    replies: 'draft' as const,
    posting: 'after_ok' as const,
  };

  it('lays everything on its own over the person’s own picks, on every network, and leaves the rest', () => {
    const on = withinRules({ ...mine, autopilot: true }, rules);
    expect(on).toMatchObject({
      autopilot: true,
      sending: 'everything',
      replies: 'everything',
      confirmRequests: true,
      posting: 'own',
    });
    expect(on.networks.facebook.requests).toBe('fits_delete');
    expect(on.networks.linkedin).toMatchObject({ sending: 'everything', replies: 'everything' });
    // The working hours, the voice and the rest are theirs.
    expect(on.hours).toEqual(mine.hours);
    expect(on.voice).toEqual(mine.voice);
    // Off, their own stand.
    expect(withinRules(mine, rules)).toMatchObject({ autopilot: false, sending: 'steps' });
  });

  it('is off where the business doesn’t allow it, and inside what the business allows where it does', () => {
    const notAllowed = BusinessRules.parse({ autopilotAllowed: false });
    expect(withinRules({ ...mine, autopilot: true }, notAllowed)).toMatchObject({
      autopilot: false,
      sending: 'steps',
    });
    const stepsOnly = BusinessRules.parse({ sendingAllowed: ['steps'] });
    expect(withinRules({ ...mine, autopilot: true }, stepsOnly).sending).toBe('steps');
  });

  it('keeps the person’s own picks under it, so a save while it’s on, or turning it off, puts theirs back', () => {
    const shown = autopilotOver({ ...mine, autopilot: true });
    const kept = keepOwnPicks({ ...shown, warmUp: false }, mine);
    expect(kept).toMatchObject({
      sending: 'steps',
      replies: 'draft',
      posting: 'after_ok',
      warmUp: false,
    });
    expect(kept.networks.facebook.requests).toBe(mine.networks.facebook.requests);
    expect(kept.networks.linkedin.sending).toBe(mine.networks.linkedin.sending);
  });

  it('sends a partner’s message, a birthday note and another time after a no-show on their own, as the rest go', () => {
    const base = {
      sending: 'everything' as const,
      replies: 'everything' as const,
      wheels: false,
      simple: false,
      needsYou: null,
    };
    for (const kind of ['partner_ask', 'birthday', 'new_job', 'rebook'] as const) {
      expect(goesAsItIs({ ...base, kind }), kind).toBe(false);
      expect(goesAsItIs({ ...base, kind, autopilot: true }), kind).toBe(true);
    }
    expect(goesAsItIs({ ...base, kind: 'partner_reply', autopilot: true })).toBe(true);
    // A reply where someone needs the person still waits, and so does everything under training wheels.
    expect(
      goesAsItIs({ ...base, kind: 'reply', needsYou: 'they sound upset', autopilot: true }),
    ).toBe(false);
    expect(goesAsItIs({ ...base, kind: 'opener', wheels: true, autopilot: true })).toBe(false);
  });
});

describe('the day’s list, and when it comes', () => {
  it('asks about everyone it reaches first, never someone who reached the person first', () => {
    for (const kind of ['warm_up', 'friend_request', 'opener', 'comment', 'follow_up', 'pitch'])
      expect(waitsForPeopleOk(kind), kind).toBe(true);
    for (const kind of ['reply', 'partner_reply', 'warm_lead', 'confirm', 'recommend'])
      expect(waitsForPeopleOk(kind), kind).toBe(false);
  });

  it('adds a fifth past each daily limit as spares, at least 2, and none for a limit of none', () => {
    expect(autopilotSpares(20)).toBe(4);
    expect(autopilotSpares(3)).toBe(2);
    expect(autopilotSpares(1)).toBe(2);
    expect(autopilotSpares(0)).toBe(0);
  });

  it('is ready an hour before the working hours, with the reminder in the middle of them', () => {
    // 9 to 5, Monday to Friday, on the business's clock.
    const t = autopilotTimes('2026-11-04', HOURS, CHICAGO);
    expect(t.list).toBe(at('2026-11-04', '08:00'));
    expect(t.reminder).toBe(at('2026-11-04', '13:00'));
    expect(t.end).toBe(at('2026-11-04', '17:00'));
  });

  it('comes next on the next day the extension works, and is due from an hour before till the hours end', () => {
    // Wednesday 7 AM: today's at 8.
    expect(nextAutopilotList(HOURS, CHICAGO, at('2026-11-04', '07:00')).getTime()).toBe(
      at('2026-11-04', '08:00'),
    );
    // Friday evening: Saturday's, since likes and requests go every day (decision 139); only on their days once
    // they turn that off.
    expect(nextAutopilotList(HOURS, CHICAGO, at('2026-11-06', '18:00')).getTime()).toBe(
      at('2026-11-07', '08:00'),
    );
    const weekdays = { ...HOURS, everyDay: false };
    expect(nextAutopilotList(weekdays, CHICAGO, at('2026-11-06', '18:00')).getTime()).toBe(
      at('2026-11-09', '08:00'),
    );
    expect(autopilotDayDue(weekdays, CHICAGO, at('2026-11-07', '10:00'))).toBeNull();
    expect(autopilotDayDue(HOURS, CHICAGO, at('2026-11-04', '07:59'))).toBeNull();
    expect(autopilotDayDue(HOURS, CHICAGO, at('2026-11-04', '08:00'))).toBe('2026-11-04');
    expect(autopilotDayDue(HOURS, CHICAGO, at('2026-11-04', '16:59'))).toBe('2026-11-04');
    expect(autopilotDayDue(HOURS, CHICAGO, at('2026-11-04', '17:00'))).toBeNull();
  });

  it('says when it comes, how many wait, and what it waits on, in plain words', () => {
    expect(AUTOPILOT_WORDS.okAll(3)).toBe('OK all 3');
    expect(AUTOPILOT_WORDS.okRest(1)).toBe('OK the one left');
    expect(AUTOPILOT_WORDS.push(1).title).toBe('1 person to OK for today');
    expect(AUTOPILOT_WORDS.reminder(2).title).toBe('2 still wait for your OK');
    expect(AUTOPILOT_WORDS.notAllowed).toContain('Ask an owner of this business');
  });
});

describe('Autopilot in a business', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  const group = {
    id: '323456789',
    slug: null,
    url: 'https://www.facebook.com/groups/323456789/',
    name: 'Round Rock Business Owners',
  };
  const fb = (username: string) => ({
    id: null,
    username,
    url: `https://www.facebook.com/${username}`,
  });
  const member_ = (username: string, name: string, lines: string[], runsGroup = false) => ({
    profile: fb(username),
    name,
    lines,
    part: runsGroup ? 'Admins and moderators' : 'Members near you',
    runsGroup,
  });
  const names = async () =>
    ((await runAs(owner, ws, 'outreach.today', {})).items as { kind: string; name: string }[])
      .filter((i) => i.kind === 'friend_request')
      .map((i) => i.name)
      .sort();
  const save = (autopilot: boolean, u = owner) =>
    runAs(u, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, warmUp: false, autopilot },
    });
  /** The day's list made for `u`, as the worker makes it, on their behalf. */
  const plan = async (u = owner) => {
    const [w] = await rows<{ organization_id: string }>(
      testDbs().admin.db,
      sql`select organization_id from app.workspaces where id = ${ws}`,
    );
    return executeCommand(
      testDbs().worker.db,
      registry.command('outreach.autopilot.plan') as CommandDef,
      { workspaceId: ws },
      {
        type: 'system',
        workspaceId: ws,
        organizationId: w!.organization_id,
        addon: { id: outreachAddon.id, name: outreachAddon.name, version: outreachAddon.version },
        onBehalfOf: u.id,
      },
      { correlationId: randomUUID(), channel: 'test' },
    ).then((r) => r.output as { day: string | null; made: boolean; waiting: number });
  };
  const list = () => runAs(owner, ws, 'outreach.autopilot', {});
  const answer = (said: string, profileIds?: string[]) =>
    runAs(owner, ws, 'outreach.autopilot.answer', {
      answer: said,
      ...(profileIds ? { profileIds } : {}),
    });
  const idOf = async (name: string) =>
    ((await list()).people as { name: string; profileId: string }[]).find((p) => p.name === name)!
      .profileId;

  beforeAll(async () => {
    owner = await createTestUser('outap-owner', { fullName: 'Pat Owner' });
    member = await createTestUser('outap-member', { fullName: 'Riley Member' });
    ws = await outreachBusiness(owner, 'Outreach Autopilot Co');
    await testDbs()
      .admin.db.insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    await save(false);
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 12_400,
      people: [
        member_('dana.reyes.77', 'Dana Reyes', ['Owner at Reyes Plumbing']),
        member_('sam.lee.77', 'Sam Lee', ['Founder of Lee Dental']),
        member_('casey.m.77', 'Casey Moreno', ['CEO at Moreno Roofing']),
      ],
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      people: [member_('lee.park.77', 'Lee Park', [], true)],
      adminsPage: true,
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('reaches nobody new once it’s on, till the day’s list is made and they’re OK’d', async () => {
    expect(await names()).toEqual(['Casey Moreno', 'Dana Reyes', 'Sam Lee']);
    const on = await save(true);
    expect(on.settings).toMatchObject({ autopilot: true, sending: 'everything' });
    expect(await names()).toEqual([]);
    // Before it's made, the list says so.
    expect((await list()).made).toBe(false);
  });

  it('lists who it plans to reach once a day, and reaches those OK’d', async () => {
    const made = await plan();
    expect(made).toMatchObject({ made: true, waiting: 3 });
    // Made already today: left as it is.
    expect(await plan()).toMatchObject({ made: false, waiting: 3 });
    const today = await list();
    expect(today).toMatchObject({ on: true, allowed: true, made: true, waiting: 3 });
    expect(today.people.map((p: { kind: string }) => p.kind)).toEqual([
      'friend_request',
      'friend_request',
      'friend_request',
    ]);
    const casey = await idOf('Casey Moreno');
    expect(await answer('not_today', [casey])).toEqual({ changed: 1, waiting: 2 });
    expect(await answer('ok')).toEqual({ changed: 2, waiting: 0 });
    expect(await names()).toEqual(['Dana Reyes', 'Sam Lee']);
    // Put back, Casey waits again, and still isn't reached.
    expect(await answer('waiting', [casey])).toEqual({ changed: 1, waiting: 1 });
    expect(await names()).toEqual(['Dana Reyes', 'Sam Lee']);
    // Not today and Put back name who; OK alone means everyone waiting.
    expect(await refused(answer('not_today'))).toBe('outreach_autopilot_who');
  });

  it('puts the person’s own picks back when it’s off, and their whole list', async () => {
    const off = await save(false);
    expect(off.settings).toMatchObject({ autopilot: false, sending: AUTOMATION_DEFAULTS.sending });
    expect(await names()).toEqual(['Casey Moreno', 'Dana Reyes', 'Sam Lee']);
    // Off, there's no list to make.
    expect(await plan()).toEqual({ day: null, made: false, waiting: 0 });
  });

  it('keeps each person’s list their own', async () => {
    const theirs = await runAs(member, ws, 'outreach.autopilot', {});
    expect(theirs).toMatchObject({ on: false, people: [] });
    expect(await runAs(member, ws, 'outreach.autopilot.answer', { answer: 'ok' })).toEqual({
      changed: 0,
      waiting: 0,
    });
  });

  it('is the business’s to allow: not allowed, it can’t be turned on', async () => {
    await runAs(owner, ws, 'addon.save_settings', {
      addonId: 'outreach',
      settings: { rules: { autopilotAllowed: false } },
    });
    expect(await refused(save(true, member))).toBe('outreach_autopilot_not_allowed');
    expect((await runAs(member, ws, 'outreach.autopilot', {})).allowed).toBe(false);
  });
});
