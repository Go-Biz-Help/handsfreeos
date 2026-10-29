/**
 * Social Outreach's phone alerts, openers and demo link (docs/outreach.md, decisions 22 to 24): a reply the extension
 * saw counts once for each message of the person's it answers, and shows on Today; first messages take turns with the
 * playbook's openers, and the results card counts what each got; a demo counts once, through the person's demo link
 * or marked by them.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptedPushWords,
  hourWords,
  morningPushWords,
  nextMorning,
  replyPushWords,
} from '../../src/addons/outreach/alerts';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { outreachSettings } from '../../src/addons/outreach/chat-read';
import { demoLink, demoRef, readDemoRef } from '../../src/addons/outreach/demos';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import { demoNote } from '../../src/addons/outreach/ops/demos';
import {
  nextOpener,
  openerKey,
  openersOf,
  ownOpenerText,
  rateWords,
  type Opener,
} from '../../src/addons/outreach/openers';
import { checkedAssist, PlaybookAssistInput } from '../../src/addons/outreach/playbook-assist';
import { PLAYBOOK_TEMPLATES, PlaybookDetails } from '../../src/addons/outreach/playbooks';
import { linkRefOf } from '../../src/schemas/calendar';
import { executeCommand, type SystemActor } from '../../src/server';
import {
  bookOnline,
  isoAt,
  makeCalendar,
  nextWeekday,
  setupTeam,
  type Team,
} from '../calendar-helpers';
import { human, outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});
const MIN = 60_000;

afterAll(closeTestDbs);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('openers', () => {
  const styles: Opener[] = [
    { kind: 'style', text: 'Ask about their business' },
    { kind: 'style', text: 'Mention the group' },
  ];
  const own: Opener = { kind: 'own', text: 'Hi {first name}, how’s business?' };

  it('take turns: the one used least, the first of those in the playbook’s order', () => {
    const all = [...styles, own];
    expect(nextOpener(all, new Map())).toEqual(styles[0]);
    const used = new Map([
      [openerKey(styles[0]!), 2],
      [openerKey(styles[1]!), 1],
    ]);
    expect(nextOpener(all, used)).toEqual(own);
    used.set(openerKey(own), 1);
    expect(nextOpener(all, used)).toEqual(styles[1]);
    expect(nextOpener([], used)).toBeNull();
    // Known by their words, whatever the spaces and capitals.
    expect(openerKey({ kind: 'style', text: '  Mention   the GROUP ' })).toBe(
      openerKey(styles[1]!),
    );
  });

  it('puts their first name in the business’s own opener', () => {
    expect(ownOpenerText(own.text, 'Dana Reyes')).toBe('Hi Dana, how’s business?');
    expect(ownOpenerText('Hey { First_Name } !', 'Sam')).toBe('Hey Sam!');
  });

  it('are kept in the playbook, two or three styles and up to three of the business’s own', () => {
    const crm = PLAYBOOK_TEMPLATES.crm_demos.details;
    expect(openersOf(crm).map((o) => o.kind)).toEqual(['style', 'style', 'style']);
    // A playbook saved before openers has none.
    const { openerStyles: _s, ownOpeners: _o, ...old } = crm;
    const parsed = PlaybookDetails.parse(old);
    expect([parsed.openerStyles, parsed.ownOpeners]).toEqual([[], []]);
    const twice = PlaybookDetails.safeParse({ ...crm, ownOpeners: ['Hi!', ' hi! '] });
    expect(twice.success).toBe(false);
  });

  it('the AI’s own openers keep their lines', () => {
    const input = PlaybookAssistInput.parse({
      part: 'ownOpeners',
      mode: 'suggest',
      draft: { name: 'CRM demos', ownOpeners: ['Hi {first name}!'] },
    });
    expect(
      checkedAssist(
        { options: ['Hi {first name}!', 'Hey {first name},\nquick question.'], questions: [] },
        input,
      ).options,
    ).toEqual(['Hey {first name},\nquick question.']);
  });

  it('says how one did', () => {
    expect(rateWords(4, 12, 'wrote back')).toBe('4 of 12 wrote back (33%)');
    expect(rateWords(0, 0, 'wrote back')).toBe('None sent yet');
  });
});

describe('the demo link', () => {
  const user = randomUUID();
  const profile = randomUUID();

  it('names who sent it to whom, short, and nothing else', () => {
    const ref = demoRef(user, profile);
    expect(ref).toMatch(/^so-[A-Za-z0-9_-]{44}$/);
    expect(readDemoRef(ref)).toEqual({ userId: user, profileId: profile });
    expect(linkRefOf(ref)).toBe(ref);
    for (const junk of ['so-short', `xx-${ref.slice(3)}`, `${ref}A`, null, ''])
      expect(readDemoRef(junk)).toBeNull();
    // Another add-on's or a campaign's ref is passed on, and isn't a demo.
    expect(linkRefOf('spring-mailer')).toBe('spring-mailer');
    expect(linkRefOf('not a ref!')).toBeNull();
  });

  it('is the playbook’s link with the ref on it, keeping what the link had', () => {
    const ref = demoRef(user, profile);
    expect(demoLink('https://book.example.com/s/acme/demo?service=intro', ref)).toBe(
      `https://book.example.com/s/acme/demo?service=intro&ref=${ref}`,
    );
    expect(demoLink(null, ref)).toBeNull();
    expect(demoLink('javascript:alert(1)', ref)).toBeNull();
  });
});

describe('the pushes', () => {
  it('say who wrote back, and how much is on today’s list', () => {
    expect(replyPushWords('Dana Reyes').title).toBe('Dana Reyes wrote back');
    // On the network they wrote on (decision 125: Instagram's and LinkedIn's replies are seen within a minute too).
    expect(replyPushWords('Dana Reyes', 'instagram').body).toBe(
      'On Instagram. Your list for today has them, with drafts for your reply.',
    );
    expect(morningPushWords([])).toBeNull();
    expect(
      morningPushWords([{ kind: 'friend_request' }, { kind: 'friend_request' }, { kind: 'reply' }]),
    ).toEqual({
      title: '3 on your list for today',
      body: '1 reply and 2 friend requests. Open the extension on Facebook to start.',
    });
    // One other network, in its words; several, named.
    expect(morningPushWords([{ kind: 'friend_request' }], ['linkedin'])?.body).toBe(
      '1 invitation to connect. Open the extension on LinkedIn to start.',
    );
    expect(
      morningPushWords([{ kind: 'friend_request' }, { kind: 'reply' }], ['facebook', 'alignable']),
    ).toEqual({
      title: '2 on your list for today',
      body: '1 reply and 1 friend request, on Facebook and Alignable. Open Today to start.',
    });
  });

  it('say who accepted the person’s requests, in each network’s words, several in one', () => {
    expect(acceptedPushWords(['Dana Reyes'], 'facebook')).toEqual({
      title: 'Dana Reyes accepted your friend request',
      body: 'On Facebook. Tap for your list for today.',
    });
    expect(acceptedPushWords(['Dana Reyes'], 'linkedin').title).toBe(
      'Dana Reyes accepted your invitation to connect',
    );
    expect(acceptedPushWords(['Dana Reyes'], 'alignable').title).toBe(
      'Dana Reyes accepted your connection request',
    );
    expect(acceptedPushWords(['Dana Reyes'], 'instagram').title).toBe(
      'Dana Reyes followed you back',
    );
    expect(
      acceptedPushWords(['Dana Reyes', 'Sam Lee', 'Kit Lowe', 'Jo Banks'], 'linkedin'),
    ).toEqual({
      title: '4 people accepted your invitations to connect',
      body: 'Dana Reyes, Sam Lee and 2 more. On LinkedIn. Tap for your list for today.',
    });
    expect(acceptedPushWords(['Dana Reyes', 'Sam Lee'], 'instagram').title).toBe(
      '2 people followed you back',
    );
    // Off to start (decision 101).
    expect(AUTOMATION_DEFAULTS.acceptedPush).toBe(false);
  });

  it('come at the business’s hour, in its time zone, 8 to start', () => {
    expect(outreachSettings(null).morningPushHour).toBe(8);
    expect(outreachSettings({ morningPushHour: null }).morningPushHour).toBeNull();
    expect(hourWords(8)).toBe('8 AM');
    expect(hourWords(12)).toBe('12 PM');
    // 7:30 in Chicago (12:30 UTC in October): today at 8; at 8:30, tomorrow.
    const before = Date.parse('2026-10-09T12:30:00Z');
    expect(nextMorning(before, 'America/Chicago', 8).toISOString()).toBe(
      '2026-10-09T13:00:00.000Z',
    );
    expect(nextMorning(before + 60 * MIN, 'America/Chicago', 8).toISOString()).toBe(
      '2026-10-10T13:00:00.000Z',
    );
  });
});

describe('replies, openers and demos in a business', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  let org: string;
  let playbookId: string;
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const message = (u: TestUser, username: string, name: string, at: string, threadKey?: string) =>
    runAs(
      u,
      ws,
      'outreach.touch.save',
      { kind: 'message', profile: fb(username), name, ...(threadKey ? { threadKey } : {}) },
      new Date(at),
    );
  const events = async (type: string) =>
    rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where workspace_id = ${ws} and event_type = ${type} order by created_at`,
    );

  beforeAll(async () => {
    owner = await createTestUser('outa-owner', { fullName: 'Pat Owner' });
    member = await createTestUser('outa-member', { fullName: 'Robin Member' });
    ws = await outreachBusiness(owner, 'Outreach Alerts Co');
    const [found] = await rows<{ organization_id: string }>(
      admin(),
      sql`select organization_id from app.workspaces where id = ${ws}`,
    );
    org = found!.organization_id;
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
    );
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: {
        ...crm.details,
        link: 'https://book.example.com/s/alerts/demo',
        ownOpeners: ['Hi {first name}! Do you run your own business?'],
      },
    });
    playbookId = (await runAs(owner, ws, 'outreach.playbook.list', {})).playbooks[0].id;
  }, 60_000);

  it('a reply counts once for each message of the person’s it answers', async () => {
    const seen = (looking = false) =>
      runAs(owner, ws, 'outreach.replies.note', {
        seen: [{ name: 'Dana Reyes', threadKey: '1001', profile: null }],
        looking,
      });
    // Nothing of the person's noted: an old chat, never a reply.
    expect((await seen()).replies).toEqual([]);
    await message(owner, 'dana.reyes.12', 'Dana Reyes', ago(10 * MIN), '1001');
    const first = await seen();
    expect(first.replies).toEqual([
      { profileId: await profileOf('dana.reyes.12'), name: 'Dana Reyes' },
    ]);
    expect((await seen()).replies).toEqual([]);
    const [pushed] = await events('outreach.reply.seen');
    expect(pushed!.payload).toMatchObject({
      userId: owner.id,
      profileIds: [await profileOf('dana.reyes.12')],
      push: true,
    });
    // It's on Today, to answer, with the demo link.
    const today = await runAs(owner, ws, 'outreach.today', {});
    const reply = today.items.find((i: { name: string }) => i.name === 'Dana Reyes');
    expect(reply).toMatchObject({ kind: 'reply' });
    expect(reply.why.join(' ')).toMatch(/Wrote back/);
    expect(readDemoRef(new URL(reply.demoLink).searchParams.get('ref'))).toEqual({
      userId: owner.id,
      profileId: await profileOf('dana.reyes.12'),
    });
    // Answering takes it off; their next message counts again, unpushed while the person looks at it.
    await rows(
      admin(),
      sql`update addon_outreach.replies set seen_at = now() - interval '8 minutes' where workspace_id = ${ws}`,
    );
    await message(owner, 'dana.reyes.12', 'Dana Reyes', ago(5 * MIN), '1001');
    expect((await runAs(owner, ws, 'outreach.today', {})).items).not.toContainEqual(
      expect.objectContaining({ name: 'Dana Reyes', kind: 'reply' }),
    );
    expect((await seen(true)).replies).toHaveLength(1);
    expect((await events('outreach.reply.seen'))[1]!.payload).toMatchObject({ push: false });
    // A chat seen as the message is noted is the list catching up, not an answer.
    await message(owner, 'dana.reyes.12', 'Dana Reyes', new Date().toISOString(), '1001');
    expect((await seen()).replies).toEqual([]);
  });

  it('copying a first message notes its opener, and the results card counts what it got', async () => {
    await message(owner, 'sam.lee.1', 'Sam Lee', ago(30 * MIN));
    await message(owner, 'casey.m', 'Casey Moreno', ago(30 * MIN));
    const sam = await profileOf('sam.lee.1');
    const casey = await profileOf('casey.m');
    const style = PLAYBOOK_TEMPLATES.crm_demos.details.openerStyles[0]!;
    const own = 'Hi {first name}! Do you run your own business?';
    // Copied before the message was noted (the draft is copied, then sent).
    await rows(
      admin(),
      sql`insert into addon_outreach.opener_uses (workspace_id, user_id, profile_id, playbook_id, kind, text, used_at)
          values (${ws}, ${owner.id}, ${sam}, ${playbookId}, 'style', ${style}, now() - interval '31 minutes'),
                 (${ws}, ${owner.id}, ${casey}, ${playbookId}, 'own', ${own}, now() - interval '31 minutes')`,
    );
    // Once sent, the opener they got stays the one it was.
    expect(
      await runAs(owner, ws, 'outreach.opener.use', {
        profileId: sam,
        opener: { playbookId, kind: 'own', text: own },
      }),
    ).toEqual({ noted: false });
    // Sam wrote back, and Casey booked (marked by the person).
    await runAs(owner, ws, 'outreach.replies.note', {
      seen: [{ name: 'Sam Lee', threadKey: null, profile: fb('sam.lee.1') }],
    });
    await runAs(owner, ws, 'outreach.demo.mark', {
      profile: fb('casey.m'),
      name: 'Casey Moreno',
      booked: true,
    });
    const results = await runAs(owner, ws, 'outreach.openers', { everyone: true });
    const openers = results.playbooks[0].openers as {
      kind: string;
      text: string;
      sent: number;
      replies: number;
      demos: number;
      current: boolean;
    }[];
    expect(openers.map((o) => o.kind)).toEqual(['style', 'style', 'style', 'own']);
    expect(openers.find((o) => o.text === style)).toMatchObject({ sent: 1, replies: 1, demos: 0 });
    expect(openers.find((o) => o.text === own)).toMatchObject({ sent: 1, replies: 0, demos: 1 });
    // The mark comes off; the look-up says so.
    const looked = await runAs(owner, ws, 'outreach.lookup', {
      profiles: [{ id: null, username: 'casey.m' }],
      threads: [],
      names: [],
    });
    expect(looked.marks[0].demo).toBe('marked');
    await runAs(owner, ws, 'outreach.demo.mark', {
      profile: fb('casey.m'),
      name: 'Casey Moreno',
      booked: false,
    });
    expect(
      (await runAs(owner, ws, 'outreach.openers', {})).playbooks[0].openers.find(
        (o: { text: string }) => o.text === own,
      ),
    ).toMatchObject({ demos: 0 });

    // For the weekly report, only openers copied in the week: Sam's was copied ten days ago.
    await rows(
      admin(),
      sql`update addon_outreach.opener_uses set used_at = now() - interval '10 days'
          where workspace_id = ${ws} and profile_id = ${sam}`,
    );
    const sentWith = async (period: string) =>
      (await runAs(owner, ws, 'outreach.openers', { period })).playbooks[0].openers.find(
        (o: { text: string }) => o.text === style,
      ).sent;
    expect(await sentWith('week')).toBe(0);
    expect(await sentWith('all')).toBe(1);
  });

  it('everyone’s openers are for owners and admins; a member sees their own', async () => {
    expect(await refused(runAs(member, ws, 'outreach.openers', { everyone: true }))).toBe(
      'outreach_openers_everyone',
    );
    const mine = await runAs(member, ws, 'outreach.openers', {});
    expect(mine.playbooks[0].openers.every((o: { sent: number }) => o.sent === 0)).toBe(true);
  });

  it('a booking through someone’s demo link counts once, and only names someone here', async () => {
    const sam = await profileOf('sam.lee.1');
    const [person] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Sam', 'Lee') returning id`,
    );
    const personId = person!.id;
    const actor: SystemActor = {
      type: 'system',
      workspaceId: ws,
      organizationId: org,
      addon: { id: outreachAddon.id, name: outreachAddon.name, version: outreachAddon.version },
    };
    const note = (ref: string) =>
      executeCommand(
        testDbs().worker.db,
        demoNote,
        {
          workspaceId: ws,
          ref,
          appointmentId: randomUUID(),
          personId,
          at: new Date().toISOString(),
        },
        actor,
        { correlationId: randomUUID(), channel: 'test' },
      ).then((r) => r.output);
    // Made up, or from someone who can't do outreach here: nobody.
    expect(await note(demoRef(randomUUID(), sam))).toEqual({ counted: false });
    expect(await note('spring-mailer')).toEqual({ counted: false });
    // The person can't run it themselves.
    expect(
      await refused(
        executeCommand(
          testDbs().api.db,
          demoNote,
          {
            workspaceId: ws,
            ref: demoRef(owner.id, sam),
            appointmentId: randomUUID(),
            personId,
            at: new Date().toISOString(),
          },
          human(owner),
          { correlationId: randomUUID(), channel: 'test' },
        ),
      ),
    ).not.toBe('went through');
  });
});

describe('a booking through the demo link', () => {
  let t: Team;
  it('keeps the ref on the booking, and counts the demo once', async () => {
    t = await setupTeam('outa-book');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
    );
    await runAs(
      t.owner,
      t.wsId,
      'outreach.touch.save',
      { kind: 'message', profile: fb('quinn.h'), name: 'Quinn Harper' },
      new Date(ago(MIN)),
    );
    const [quinn] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${t.wsId} and username = 'quinn.h'`,
    );
    const profileId = quinn!.id;
    const ref = demoRef(t.owner.id, profileId);
    const online = await makeCalendar(t, 'Demos', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    const booked = await bookOnline(t, online.id, isoAt(nextWeekday(3), '10:00'), {
      linkRef: ref,
    });
    const [att] = await rows<{ link_ref: string }>(
      admin(),
      sql`select link_ref from app.appointment_attendees where id = ${booked.attendeeId}`,
    );
    expect(att!.link_ref).toBe(ref);
    const actor: SystemActor = {
      ...t.scope,
      type: 'system',
      addon: { id: outreachAddon.id, name: outreachAddon.name, version: outreachAddon.version },
    };
    const note = () =>
      executeCommand(
        testDbs().worker.db,
        demoNote,
        {
          workspaceId: t.wsId,
          ref,
          appointmentId: booked.appointmentId,
          personId: booked.personId,
          at: new Date().toISOString(),
        },
        actor,
        { correlationId: randomUUID(), channel: 'test' },
      ).then((r) => r.output);
    expect(await note()).toEqual({ counted: true });
    expect(await note()).toEqual({ counted: false });
    const looked = await runAs(t.owner, t.wsId, 'outreach.lookup', {
      profiles: [{ id: null, username: 'quinn.h' }],
      threads: [],
      names: [],
    });
    expect(looked.marks[0].demo).toBe('link');
  }, 60_000);
});
