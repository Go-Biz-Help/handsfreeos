/**
 * Social Outreach: a playbook that starts with an introduction, on Today (docs/outreach.md, decisions 168 and 173).
 * Everyone who connects gets it, a request the person confirmed too, but only while every playbook in use starts with
 * one; once sent, one nudge follows, then only the monthly check-in, after a reply too; a yes to a networking call is
 * kept as one; and a first message drafted the other way waits no more.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { CHECK_IN_DAYS } from '../../src/addons/outreach/conversation';
import { paceOf, PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { STARTING_INTRO } from '../../src/addons/outreach/script';
import { outreachBusiness, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

describe('an introduction in place of the pitch, on Today', () => {
  let owner: TestUser;
  let ws: string;
  let playbookId: string;
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  const people = ['gina.lake.5', 'hal.moss.5', 'ivy.reed.5'];
  const names = ['Gina Lake', 'Hal Moss', 'Ivy Reed'];
  const group = {
    id: '623456789',
    slug: null,
    url: 'https://www.facebook.com/groups/623456789/',
    name: 'Boise Trades Owners',
  };
  const profileOf = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
    );
    return p!.id;
  };
  /** They sent the person a request two days ago, and the person confirmed it: no check of them. */
  const confirmed = async (username: string) => {
    await rows(
      admin(),
      sql`insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at, answer, answer_at)
          select ${ws}, ${owner.id}, p.id, 'friends', ${daysAgo(2)}::timestamptz, now(), 'confirm', ${daysAgo(2)}::timestamptz
          from addon_outreach.profiles p where p.workspace_id = ${ws} and p.username = ${username}
          on conflict (workspace_id, user_id, profile_id) do update set state = 'friends', since = excluded.since,
            answer = excluded.answer, answer_at = excluded.answer_at`,
    );
    return profileOf(username);
  };
  const opens = (how: 'pitch' | 'intro') =>
    runAs(owner, ws, 'outreach.playbook.save', {
      playbookId,
      name: crm.name,
      details: { ...crm.details, opens: how },
    });
  const listed = async (name: string) =>
    ((await runAs(owner, ws, 'outreach.today', {})).items as { kind: string; name: string }[])
      .filter((i) => i.name === name)
      .map((i) => i.kind);
  const conversation = async (profileId: string) => {
    const [f] = await rows<{
      step: string;
      sent: number;
      next: string | null;
      due_days: number;
      call: boolean;
    }>(
      admin(),
      sql`select step, sent, next, call,
            round(extract(epoch from (due_at - now())) / 86400)::int as due_days
          from addon_outreach.follow_ups where workspace_id = ${ws} and profile_id = ${profileId}`,
    );
    return f ?? null;
  };
  const queue = (profileId: string, kind: 'intro' | 'own', text: string) =>
    runAs(owner, ws, 'outreach.send.queue', {
      profileId,
      kind: 'opener',
      text,
      opener: { playbookId, kind, text },
    });

  beforeAll(async () => {
    owner = await createTestUser('outi-owner', { fullName: 'Morgan Owner' });
    ws = await outreachBusiness(owner, 'Outreach Introduction Co');
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: { ...crm.details, opens: 'intro' },
    });
    playbookId = saved.id;
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 9_100,
      adminsPage: true,
      people: people.map((u, i) => ({
        profile: fb(u),
        name: names[i],
        lines: ['Owner at a plumbing company'],
        part: 'Members near you',
        runsGroup: false,
      })),
    });
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, sending: 'steps' },
    });
  }, 120_000);
  afterAll(closeTestDbs);

  it('says hi to someone whose request the person confirmed, only while every playbook starts with an introduction', async () => {
    await confirmed('gina.lake.5');
    expect(await listed('Gina Lake')).toEqual(['opener']);
    // A pitch needs a check that found them fit, as before.
    await opens('pitch');
    expect(await listed('Gina Lake')).toEqual([]);
    await opens('intro');
    expect(await listed('Gina Lake')).toEqual(['opener']);
    // One a check found not a fit stays out.
    const hal = await confirmed('hal.moss.5');
    await rows(
      admin(),
      sql`insert into addon_outreach.checks (workspace_id, user_id, profile_id, verdict, looked_at, checked_at)
          values (${ws}, ${owner.id}, ${hal}, 'not', now(), now())`,
    );
    expect(await listed('Hal Moss')).toEqual([]);
  });

  it('follows the introduction with one nudge, then the monthly check-in alone, after a reply too', async () => {
    const gina = await profileOf('gina.lake.5');
    const queued = await queue(gina, 'intro', STARTING_INTRO);
    await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: queued.sendId }] });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      profile: fb('gina.lake.5'),
      name: 'Gina Lake',
      at: new Date().toISOString(),
    });
    await runAs(owner, ws, 'outreach.send.done', { sendId: queued.sendId, sent: true });
    const pace = paceOf(crm.details.pace);
    const followUps = pace.followUps;
    // One nudge to come, at the last follow-up's gap (decision 173).
    expect(await conversation(gina)).toMatchObject({
      step: 'intro',
      sent: followUps - 1,
      next: 'follow_up',
      due_days: pace.followUpGaps.at(-1),
      call: false,
    });
    expect(await listed('Gina Lake')).toEqual([]);
    // The nudge goes: then only the check-in.
    await runAs(owner, ws, 'outreach.conversation.note', { profileId: gina, kind: 'follow_up' });
    expect(await conversation(gina)).toMatchObject({
      step: 'intro',
      sent: followUps,
      next: 'check_in',
      due_days: CHECK_IN_DAYS,
    });
    // Their question gets a reply, then the check-in again: no follow-ups start.
    expect(
      await runAsSystem(ws, 'outreach.answer.note', {
        userId: owner.id,
        profileId: gina,
        answer: 'question',
        writtenAt: new Date().toISOString(),
      }),
    ).toEqual({ noted: true });
    expect(await conversation(gina)).toMatchObject({ step: 'intro', sent: followUps });
    await runAs(owner, ws, 'outreach.conversation.note', { profileId: gina, kind: 'reply' });
    expect(await conversation(gina)).toMatchObject({
      step: 'intro',
      sent: followUps,
      next: 'check_in',
      due_days: CHECK_IN_DAYS,
    });
    // A yes to a networking call is kept as one (decision 173): its ask goes on the person's own calendar.
    expect(
      await runAsSystem(ws, 'outreach.answer.note', {
        userId: owner.id,
        profileId: gina,
        answer: 'yes',
        took: 'call',
        writtenAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toEqual({ noted: true });
    expect(await conversation(gina)).toMatchObject({ step: 'intro', call: true });
    // Results counts it as an introduction.
    const results = await runAs(owner, ws, 'outreach.openers', { period: 'all', everyone: false });
    const mine = results.playbooks.find((p: { playbookId: string }) => p.playbookId === playbookId);
    expect(mine.openers).toEqual([
      expect.objectContaining({ kind: 'intro', text: STARTING_INTRO, current: true, sent: 1 }),
    ]);
  });

  it('lets a first message drafted the other way go once the playbook changes (5a)', async () => {
    const ivy = await confirmed('ivy.reed.5');
    const pitch = await queue(ivy, 'own', 'Hey Ivy, quick question?');
    expect(pitch.sendId).toBeTruthy();
    // Queuing anything clears it out: the playbook starts with an introduction now.
    await queue(ivy, 'intro', STARTING_INTRO);
    const left = await rows<{ id: string; kind: string | null }>(
      admin(),
      sql`select id, opener ->> 'kind' as kind from addon_outreach.sends
          where workspace_id = ${ws} and profile_id = ${ivy} and state = 'waiting'`,
    );
    expect(left.map((s) => s.kind)).toEqual(['intro']);
  });
});
