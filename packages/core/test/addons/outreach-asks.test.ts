/**
 * Social Outreach: asking the extension (docs/outreach.md, decision 43). The person asks their working computer from
 * HandsFreeOS; only that computer takes it, oldest first; the same thing asked twice is one ask; a day without a
 * computer lets it go, a computer gone mid-way loses it, and a warning that day ends what would open Facebook; its
 * line tells nobody more than every 20 seconds and keeps no receipt; a step handed over waits for the person's reply;
 * and each person sees only their own.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASK_EXPIRED_LINE,
  ASK_LOST_LINE,
  ASK_STOPPED_EARLY_LINE,
} from '../../src/addons/outreach/asks';
import { outreachBusiness, refused, runAs, runWith } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});
const group = {
  id: '424242424',
  slug: null,
  url: 'https://www.facebook.com/groups/424242424/',
  name: 'Austin Small Business Owners',
};

describe('asking the extension', () => {
  let owner: TestUser;
  let riley: TestUser;
  let sam: TestUser;
  let jo: TestUser;
  let ash: TestUser;
  let ws: string;
  const home = randomUUID();
  const office = randomUUID();

  const beat = (u: TestUser, installId: string, active = false) =>
    runWith(
      u,
      ws,
      'outreach.live.beat',
      {
        computer: { id: installId, name: 'Chrome on Windows', version: '0.19.0' },
        active,
        status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
  const ask = (u: TestUser, a: Record<string, unknown>) =>
    runWith(u, ws, 'outreach.ask.make', { ask: a }, { channel: 'web' });
  const take = (u: TestUser, installId: string, underway: string | null = null) =>
    runAs(u, ws, 'outreach.ask.take', { installId, underway });
  const events = async (type: string) =>
    (
      await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.events where workspace_id = ${ws} and event_type = ${type}`,
      )
    )[0]!.n;
  const row = async (askId: string) =>
    (
      await rows<{
        state: string;
        line: string | null;
        computer_id: string | null;
        reply: string | null;
        result: Record<string, unknown> | null;
      }>(
        admin(),
        sql`select state, line, computer_id, reply, result from addon_outreach.asks where id = ${askId}`,
      )
    )[0]!;
  const profileId = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;

  beforeAll(async () => {
    [owner, riley, sam, jo, ash] = await Promise.all([
      createTestUser('outa-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outa-riley', { fullName: 'Riley Member' }),
      createTestUser('outa-sam', { fullName: 'Sam Member' }),
      createTestUser('outa-jo', { fullName: 'Jo Member' }),
      createTestUser('outa-ash', { fullName: 'Ash Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Asks Co');
    await admin()
      .insert(workspaceMemberships)
      .values(
        [riley, sam, jo, ash].map((u) => ({
          workspaceId: ws,
          userId: u.id,
          role: 'member' as const,
        })),
      );
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 34_718,
      people: [
        {
          profile: fb('dana.reyes.12'),
          name: 'Dana Reyes',
          lines: ['Owner at Reyes Plumbing'],
          part: 'Members near you',
        },
      ],
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('needs a computer, and answers the open one when the same thing is asked again', async () => {
    expect(await refused(ask(owner, { kind: 'friends' }))).toBe('outreach_no_computer');
    await beat(owner, home, true);
    const before = await events('outreach.ask.made');
    const made = await ask(owner, { kind: 'friends' });
    expect(made).toMatchObject({
      fresh: true,
      ask: { kind: 'friends', state: 'waiting', via: 'web', about: null },
    });
    const again = await ask(owner, { kind: 'friends' });
    expect(again).toMatchObject({ fresh: false, ask: { askId: made.ask.askId } });
    expect(await events('outreach.ask.made')).toBe(before + 1);

    // A look-up is told apart by who: a second person is a second ask.
    const dana = await profileId('dana.reyes.12');
    const lookup = await ask(owner, {
      kind: 'lookup',
      draft: { kind: 'opener', profileId: dana },
    });
    expect(lookup).toMatchObject({ fresh: true, ask: { about: 'Dana Reyes' } });
    const [task] = await rows<{ task: Record<string, unknown> }>(
      admin(),
      sql`select task from addon_outreach.asks where id = ${lookup.ask.askId}`,
    );
    expect(task!.task).toMatchObject({
      kind: 'lookup',
      profileUrl: 'https://www.facebook.com/dana.reyes.12',
      name: 'Dana Reyes',
    });
    expect(
      (await ask(owner, { kind: 'lookup', draft: { kind: 'opener', profileId: dana } })).fresh,
    ).toBe(false);
    expect(
      await refused(
        ask(owner, { kind: 'lookup', draft: { kind: 'opener', profileId: randomUUID() } }),
      ),
    ).toBe('not_found');

    // Cancelling is one at a time, whoever was ticked.
    const cancel = await ask(owner, { kind: 'cancel', profileIds: [dana] });
    expect(cancel).toMatchObject({ fresh: true, ask: { about: '1 person' } });
    expect(
      (await ask(owner, { kind: 'cancel', profileIds: [randomUUID(), randomUUID()] })).fresh,
    ).toBe(false);
  });

  it('works out the groups: saved ones with their counts, and a pasted link matched to a saved group', async () => {
    const [saved] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.groups where workspace_id = ${ws} and url = ${group.url}`,
    );
    const byId = await ask(owner, { kind: 'members', groupIds: [saved!.id] });
    expect(byId.ask).toMatchObject({
      about: 'Austin Small Business Owners',
      target: `groups:${saved!.id}`,
    });
    const [task] = await rows<{ task: { groups: Record<string, unknown>[] } }>(
      admin(),
      sql`select task from addon_outreach.asks where id = ${byId.ask.askId}`,
    );
    expect(task!.task.groups).toEqual([
      {
        groupId: saved!.id,
        name: 'Austin Small Business Owners',
        url: group.url,
        people: 1,
        adminsRead: false,
      },
    ]);
    // The same group pasted from the phone's site, its members page, with a query: the same ask.
    for (const url of [
      'https://m.facebook.com/groups/424242424/members/?ref=share',
      'facebook.com/groups/424242424',
      'https://www.facebook.com/groups/424242424/?mibextid=abc',
    ])
      expect(await ask(owner, { kind: 'members', url })).toMatchObject({
        fresh: false,
        ask: { askId: byId.ask.askId },
      });
    // A group not saved yet goes by its link; a link that isn't a group is refused with how to get one.
    const pasted = await ask(owner, {
      kind: 'members',
      url: 'https://www.facebook.com/groups/knitting.circle/',
    });
    expect(pasted.ask).toMatchObject({
      about: 'the group you pasted',
      target: 'link:https://www.facebook.com/groups/knitting.circle/',
    });
    expect(
      await refused(ask(owner, { kind: 'members', url: 'https://www.facebook.com/groups/joins/' })),
    ).toBe('outreach_ask_not_a_group');
    expect(
      await refused(ask(owner, { kind: 'members', url: 'https://example.com/groups/1/' })),
    ).toBe('outreach_ask_not_a_group');
    expect(await refused(ask(owner, { kind: 'posts', groupIds: [randomUUID()] }))).toBe(
      'not_found',
    );
    expect((await ask(owner, { kind: 'posts' })).ask.about).toBe('your best groups');
  });

  it('caps the look-ups waiting at once', async () => {
    await beat(jo, randomUUID(), true);
    for (let i = 0; i < 5; i++)
      await runAs(jo, ws, 'outreach.touch.save', {
        kind: 'friend_request',
        profile: fb(`cap.person.${i}`),
        name: `Cap Person ${i}`,
        at: new Date().toISOString(),
      });
    const ids = await Promise.all([0, 1, 2, 3, 4].map((i) => profileId(`cap.person.${i}`)));
    for (const id of ids)
      await ask(jo, { kind: 'lookup', draft: { kind: 'opener', profileId: id } });
    expect(
      await refused(
        ask(jo, {
          kind: 'lookup',
          draft: { kind: 'opener', profileId: await profileId('dana.reyes.12') },
        }),
      ),
    ).toBe('outreach_ask_lookups_full');
  });

  it('is taken by the working computer only, oldest first, and a day-old one is let go', async () => {
    // A second computer that isn't the one that works takes nothing and changes nothing.
    await beat(owner, office);
    const none = await take(owner, office);
    expect(none.ask).toBeNull();
    expect(none.waiting).toBeGreaterThan(0);
    expect((await beat(owner, office)).asks).toBe(0);
    const waiting = (await beat(owner, home)).asks;
    expect(waiting).toBe(none.waiting);

    // The oldest waits more than a day: let go, never taken.
    const [oldest] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.asks where workspace_id = ${ws} and user_id = ${owner.id}
          and state = 'waiting' order by asked_at limit 1`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.asks set asked_at = now() - interval '25 hours' where id = ${oldest!.id}`,
    );
    const listed = await runAs(owner, ws, 'outreach.asks', {});
    expect(listed.asks.find((a: { askId: string }) => a.askId === oldest!.id)).toMatchObject({
      state: 'expired',
      line: ASK_EXPIRED_LINE,
    });
    const before = await events('outreach.ask.started');
    const taken = await take(owner, home);
    expect(taken.ask).not.toBeNull();
    expect(taken.ask.askId).not.toBe(oldest!.id);
    expect(taken.waiting).toBe(waiting - 2);
    expect(await events('outreach.ask.started')).toBe(before + 1);
    expect(await row(oldest!.id)).toMatchObject({ state: 'failed', line: ASK_EXPIRED_LINE });
    const [homeId] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.computers where workspace_id = ${ws} and install_id = ${home}`,
    );
    expect(await row(taken.ask.askId)).toMatchObject({
      state: 'working',
      computer_id: homeId!.id,
    });
  });

  it('says how it goes: a line alone tells at most every 20 seconds and keeps no receipt', async () => {
    const pc = randomUUID();
    await beat(riley, pc, true);
    const made = await ask(riley, { kind: 'file_download' });
    const { ask: taken } = await take(riley, pc);
    expect(taken.askId).toBe(made.ask.askId);
    const before = await events('outreach.ask.progressed');
    const commandId = randomUUID();
    await runWith(
      riley,
      ws,
      'outreach.ask.progress',
      { askId: taken.askId, state: 'working', line: 'Opening Download your information…' },
      { channel: 'extension', commandId, occurredAt: new Date() },
    );
    expect(
      await rows(
        admin(),
        sql`select 1 from app.command_receipts where user_id = ${riley.id} and command_id = ${commandId}`,
      ),
    ).toEqual([]);
    await runAs(riley, ws, 'outreach.ask.progress', {
      askId: taken.askId,
      state: 'working',
      line: 'Pressing Download…',
    });
    expect(await events('outreach.ask.progressed')).toBe(before + 1);
    expect((await row(taken.askId)).line).toBe('Pressing Download…');

    // A step handed over tells at once, and waits for the person's reply.
    expect(
      await runAs(riley, ws, 'outreach.ask.progress', {
        askId: taken.askId,
        state: 'stuck',
        line: 'It couldn’t find Download. Press it yourself, then Carry on.',
      }),
    ).toEqual({ cancelled: false, reply: null });
    expect(await events('outreach.ask.progressed')).toBe(before + 2);
    const [changed] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where workspace_id = ${ws} and event_type = 'outreach.ask.progressed'
          order by created_at desc limit 1`,
    );
    expect(changed!.payload).toMatchObject({ state: 'stuck', changed: true, userId: riley.id });

    // Only a reply its kind allows: a file's step goes on, it isn't skipped.
    expect(
      await refused(
        runWith(
          riley,
          ws,
          'outreach.ask.reply',
          { askId: taken.askId, reply: 'skip' },
          { channel: 'web' },
        ),
      ),
    ).toBe('not_found');
    // It waits on the person: in Waiting for you, counted.
    const waitingNow = await runAs(riley, ws, 'outreach.waiting', {});
    expect(waitingNow.kinds.ask.count).toBe(1);
    expect(waitingNow.items[0]).toMatchObject({
      kind: 'ask',
      ask: { askId: taken.askId, state: 'stuck' },
    });
    expect(
      await runWith(
        riley,
        ws,
        'outreach.ask.reply',
        { askId: taken.askId, reply: 'carry_on' },
        { channel: 'web' },
      ),
    ).toMatchObject({ ask: { reply: 'carry_on', state: 'stuck' } });
    // The computer hears the reply until it says it's working again, which takes it.
    expect(
      await runAs(riley, ws, 'outreach.ask.progress', {
        askId: taken.askId,
        state: 'stuck',
        line: 'It couldn’t find Download. Press it yourself, then Carry on.',
      }),
    ).toEqual({ cancelled: false, reply: 'carry_on' });
    expect(
      await runAs(riley, ws, 'outreach.ask.progress', {
        askId: taken.askId,
        state: 'working',
        line: 'Carrying on…',
      }),
    ).toEqual({ cancelled: false, reply: null });
    expect((await row(taken.askId)).reply).toBeNull();
    expect((await runAs(riley, ws, 'outreach.waiting', {})).kinds.ask.count).toBe(0);
    // Not stuck: a reply is refused.
    expect(
      await refused(
        runWith(
          riley,
          ws,
          'outreach.ask.reply',
          { askId: taken.askId, reply: 'carry_on' },
          { channel: 'web' },
        ),
      ),
    ).toBe('not_found');

    // Stopped in the app: the computer hears it on its next line.
    await runWith(riley, ws, 'outreach.ask.cancel', { askId: taken.askId }, { channel: 'web' });
    expect(
      await runAs(riley, ws, 'outreach.ask.progress', {
        askId: taken.askId,
        state: 'working',
        line: 'Still going…',
      }),
    ).toEqual({ cancelled: true, reply: null });
    // Ending it keeps it stopped, with how far it got.
    expect(
      await runAs(riley, ws, 'outreach.ask.end', {
        askId: taken.askId,
        state: 'done',
        line: 'Stopped after the first page.',
      }),
    ).toEqual({ state: 'cancelled' });
    expect(await row(taken.askId)).toMatchObject({
      state: 'cancelled',
      line: 'Stopped after the first page.',
    });
    expect(
      await refused(
        runWith(riley, ws, 'outreach.ask.cancel', { askId: taken.askId }, { channel: 'web' }),
      ),
    ).toBe('not_found');
  });

  it('ends with a look-up’s drafts, and a retried end gets the first answer', async () => {
    const pc = randomUUID();
    await beat(sam, pc, true);
    await runAs(sam, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb('lee.park.3'),
      name: 'Lee Park',
      at: new Date().toISOString(),
    });
    const lee = await profileId('lee.park.3');
    // Waiting, stopped: it never starts.
    const early = await ask(sam, { kind: 'groups' });
    expect(
      await runWith(sam, ws, 'outreach.ask.cancel', { askId: early.ask.askId }, { channel: 'web' }),
    ).toMatchObject({ ask: { state: 'cancelled', line: ASK_STOPPED_EARLY_LINE } });

    const made = await ask(sam, { kind: 'lookup', draft: { kind: 'opener', profileId: lee } });
    const { ask: taken } = await take(sam, pc);
    expect(taken).toMatchObject({ askId: made.ask.askId, task: { name: 'Lee Park' } });
    const commandId = randomUUID();
    const end = (line: string) =>
      runWith(
        sam,
        ws,
        'outreach.ask.end',
        {
          askId: taken.askId,
          state: 'done',
          line,
          result: { drafts: ['Hi Lee!', 'Hey Lee'], opener: null, simple: false, lookedUp: true },
        },
        { channel: 'extension', commandId, occurredAt: new Date() },
      );
    expect(await end('Wrote 2 drafts after looking Lee Park up.')).toEqual({ state: 'done' });
    // Sent again (the first answer was lost on the way): the first answer, nothing done twice.
    const ended = await events('outreach.ask.ended');
    expect(await end('Wrote 2 drafts after looking Lee Park up.')).toEqual({ state: 'done' });
    expect(await events('outreach.ask.ended')).toBe(ended);
    expect(await row(taken.askId)).toMatchObject({
      state: 'done',
      line: 'Wrote 2 drafts after looking Lee Park up.',
      result: { drafts: ['Hi Lee!', 'Hey Lee'], lookedUp: true },
    });
    // Ended already: another end changes nothing.
    expect(
      await runAs(sam, ws, 'outreach.ask.end', { askId: taken.askId, state: 'failed', line: 'x' }),
    ).toEqual({ state: 'done' });

    // Only their own: someone else's asks never show, and can't be stopped.
    const listed = await runAs(sam, ws, 'outreach.asks', {});
    expect(listed.asks.map((a: { kind: string }) => a.kind).sort()).toEqual(['groups', 'lookup']);
    expect(listed.computer).toMatchObject({ online: true, signedOut: false });
    expect(
      (await runAs(sam, ws, 'outreach.asks', { kinds: ['groups'] })).asks.map(
        (a: { kind: string }) => a.kind,
      ),
    ).toEqual(['groups']);
    const others = await runAs(owner, ws, 'outreach.asks', {});
    expect(others.asks.some((a: { askId: string }) => a.askId === taken.askId)).toBe(false);
    expect(
      await refused(
        runWith(owner, ws, 'outreach.ask.cancel', { askId: made.ask.askId }, { channel: 'web' }),
      ),
    ).toBe('not_found');
    // Three minutes without a beat: offline.
    await rows(
      admin(),
      sql`update addon_outreach.computers set last_seen_at = now() - interval '4 minutes'
          where workspace_id = ${ws} and install_id = ${pc}`,
    );
    expect((await runAs(sam, ws, 'outreach.asks', {})).computer.online).toBe(false);
  });

  it('is lost when its computer goes away, or when Chrome restarted mid-way', async () => {
    const pc = randomUUID();
    const laptop = randomUUID();
    const lost = await createTestUser('outa-lost', { fullName: 'Casey Member' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: lost.id, role: 'member' });
    await beat(lost, pc, true);
    const first = await ask(lost, { kind: 'chats' });
    await take(lost, pc);
    // Its computer isn't seen for a quarter of an hour: the ask shows lost, and asking again makes a new one.
    await rows(
      admin(),
      sql`update addon_outreach.computers set last_seen_at = now() - interval '15 minutes'
          where workspace_id = ${ws} and install_id = ${pc}`,
    );
    expect(
      (await runAs(lost, ws, 'outreach.asks', {})).asks.find(
        (a: { askId: string }) => a.askId === first.ask.askId,
      ),
    ).toMatchObject({ state: 'lost', line: ASK_LOST_LINE });
    const second = await ask(lost, { kind: 'chats' });
    expect(second.fresh).toBe(true);
    expect(await row(first.ask.askId)).toMatchObject({ state: 'failed', line: ASK_LOST_LINE });

    // Another computer works now and takes it; Chrome restarts there, and it takes the next with nothing under way:
    // the one it had is lost.
    await beat(lost, laptop, true);
    const { ask: taken } = await take(lost, laptop);
    expect(taken.askId).toBe(second.ask.askId);
    await ask(lost, { kind: 'requests' });
    const { ask: next } = await take(lost, laptop, null);
    expect(next.kind).toBe('requests');
    expect(await row(second.ask.askId)).toMatchObject({ state: 'failed', line: ASK_LOST_LINE });
    // Taking with the one under way named keeps it.
    await ask(lost, { kind: 'friends' });
    expect((await take(lost, laptop, next.askId)).ask.kind).toBe('friends');
    expect((await row(next.askId)).state).toBe('working');
  });

  it('is refused on a day Facebook warned, but for bringing in the file, and what waits ends at the take', async () => {
    const warned = await createTestUser('outa-warned', { fullName: 'Drew Member' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: warned.id, role: 'member' });
    const pc = randomUUID();
    await beat(warned, pc, true);
    const waitingAsk = await ask(warned, { kind: 'requests' });
    await runAs(warned, ws, 'outreach.warning.note', {
      words: ['You’re temporarily blocked from sending friend requests'],
    });
    expect(await refused(ask(warned, { kind: 'groups' }))).toBe('outreach_warned_today');
    const fileIn = await ask(warned, { kind: 'file_in' });
    expect(fileIn.fresh).toBe(true);
    const { ask: taken } = await take(warned, pc);
    expect(taken.kind).toBe('file_in');
    expect(await row(waitingAsk.ask.askId)).toMatchObject({ state: 'failed' });
    expect((await row(waitingAsk.ask.askId)).line).toContain('Facebook warned you today');
    expect((await runAs(warned, ws, 'outreach.asks', {})).warnedToday).toBe(true);
  });

  it('adds someone to Contacts from the web, marks a demo by the profile kept', async () => {
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb('avery.stone'),
      name: 'Avery Stone',
      at: new Date().toISOString(),
    });
    const avery = await profileId('avery.stone');
    const before = await events('outreach.profile.saved');
    const saved = await runWith(
      owner,
      ws,
      'outreach.profile.contact',
      { profileId: avery },
      { channel: 'web' },
    );
    expect(saved).toMatchObject({ profileId: avery, personName: 'Avery Stone', addedPerson: true });
    expect(await events('outreach.profile.saved')).toBe(before + 1);
    const [person] = await rows<{ source: string | null }>(
      admin(),
      sql`select source from app.people where id = ${saved.personId}`,
    );
    expect(person!.source).toBe('Facebook');
    // Already in Contacts: that customer, nobody new.
    expect(
      await runWith(
        owner,
        ws,
        'outreach.profile.contact',
        { profileId: avery },
        { channel: 'web' },
      ),
    ).toMatchObject({ personId: saved.personId, addedPerson: false });
    // Said to be someone already there: tied to them.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb('avery.stone.2'),
      name: 'Avery Stone',
      at: new Date().toISOString(),
    });
    const twin = await profileId('avery.stone.2');
    expect(
      await runWith(
        owner,
        ws,
        'outreach.profile.contact',
        { profileId: twin, personId: saved.personId },
        { channel: 'web' },
      ),
    ).toMatchObject({ personId: saved.personId, addedPerson: false });
    expect(
      await refused(
        runWith(
          owner,
          ws,
          'outreach.profile.contact',
          { profileId: randomUUID() },
          { channel: 'web' },
        ),
      ),
    ).toBe('not_found');

    expect(
      await runWith(
        owner,
        ws,
        'outreach.demo.mark',
        { profileId: avery, booked: true },
        { channel: 'web' },
      ),
    ).toEqual({ profileId: avery, booked: true });
    expect(
      await refused(runWith(owner, ws, 'outreach.demo.mark', { booked: true }, { channel: 'web' })),
    ).toBe('validation');
  });

  it('looks up the one a chat on Today is with, from the person’s own chats only', async () => {
    const pc = randomUUID();
    await beat(ash, pc, true);
    // A chat of Ash's own with no profile linked, as Today lists it.
    const chat = async (u: TestUser, name: string) =>
      (
        await rows<{ id: string }>(
          admin(),
          sql`insert into addon_outreach.file_chats
                (workspace_id, user_id, platform, name, name_key, first_at, last_at, messages, last_from_me)
              values (${ws}, ${u.id}, 'facebook', ${name}, ${name.toLowerCase()}, now() - interval '9 days',
                now() - interval '1 day', 4, false)
              returning id`,
        )
      )[0]!.id;
    const mine = await chat(ash, 'Quinn Harper');
    const made = await ask(ash, { kind: 'lookup', draft: { kind: 'reply', chatId: mine } });
    expect(made.fresh).toBe(true);
    // Not taken yet: nothing may say how it goes.
    expect(
      await refused(
        runAs(ash, ws, 'outreach.ask.progress', {
          askId: made.ask.askId,
          state: 'working',
          line: 'Looking…',
        }),
      ),
    ).toBe('outreach_ask_not_taken');
    const { ask: taken } = await take(ash, pc);
    expect(taken).toMatchObject({
      askId: made.ask.askId,
      task: { kind: 'lookup', profileUrl: null, name: 'Quinn Harper' },
    });
    // A teammate's chat is theirs alone.
    const theirs = await chat(riley, 'Parker Lane');
    expect(
      await refused(ask(ash, { kind: 'lookup', draft: { kind: 'reply', chatId: theirs } })),
    ).toBe('not_found');
  });
});
