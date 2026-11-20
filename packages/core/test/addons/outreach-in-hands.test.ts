/**
 * Social Outreach: In your hands (docs/outreach.md, decision 182; core's side is test/in-hands.test.ts).
 * - A message the person typed themselves puts that person in their hands: noted by the extension, or read in a chat.
 *   One HandsFreeOS drafted (the whole of it, a paragraph, or enough of it), one the extension sent then, or a line
 *   the reader took from the page, never does.
 * - Someone in a person's hands gets no message from the AI: none is queued or OK'd, and Take over skips the ones
 *   waiting. Give back, one or all, lets it pick up again; Keep it mine is only for someone in hands.
 * - A customer in Contacts goes into the same hands there, and back; given back in Contacts, they're out here too.
 * - The ask: an hour of working hours after they write back, on Needs you and once to the phone.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  byHandAt,
  HANDS_OUTREACH_WORDS as HW,
  notSaidByHand,
  saysADraft,
  workingAfter,
  type ByHandClues,
} from '../../src/addons/outreach/in-hands';
import { personMenuItems } from '../../src/addons/outreach/person-menu';
import { outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

describe('who wrote a message', () => {
  const now = Date.UTC(2026, 10, 19, 17);
  const clues: ByHandClues = {
    name: 'Dana Cole',
    drafts: ['Hi Dana! Saw your post about the new shop.\n\nHow do you keep track of customers?'],
    sentAt: [],
    copiedAt: null,
    backAt: null,
    now,
  };
  const said = (text: string, at = now - HOUR) => ({
    fromMe: true,
    text,
    at: new Date(at).toISOString(),
  });
  const always = () => true;

  it('is the AI’s when a draft said it: all of it, a paragraph, or enough of it', () => {
    const [draft] = clues.drafts;
    expect(saysADraft(draft!, clues.drafts)).toBe(true);
    expect(saysADraft('how do you keep track of customers', clues.drafts)).toBe(true);
    expect(saysADraft('Saw your post about the new shop', clues.drafts)).toBe(true);
    // Too short to be more than chance, unless it's the whole of a paragraph.
    expect(saysADraft('new shop', clues.drafts)).toBe(false);
    expect(saysADraft('Running late, call you tomorrow', clues.drafts)).toBe(false);
  });

  it('is nobody’s for a picture alone, a member count, a line headed with their name, or a row of a chat list', () => {
    expect(notSaidByHand('(a picture, sticker or file)', 'Dana Cole')).toBe(true);
    expect(notSaidByHand('Austin Owners · 12.4K members', 'Dana Cole')).toBe(true);
    expect(notSaidByHand('Dana Cole\nDana: see you then', 'Dana Cole')).toBe(true);
    expect(notSaidByHand('See you then', 'Dana Cole')).toBe(false);
    // A row of LinkedIn's list of chats, read into someone else's chat: never theirs, never the person's by hand.
    expect(
      notSaidByHand(
        'Jennifer Jones, MHR\nYou: Hey Jennifer, how is it going?\n. Press return to go to the conversation',
        'Aaron Welch',
      ),
    ).toBe(true);
    expect(notSaidByHand('Amanda Herber\nAmanda: Hi Chris, quick one', 'John Reid')).toBe(true);
    // Two lines typed by hand stay the person's.
    expect(notSaidByHand('Hi John\nQuick question: are you free Friday?', 'John Reid')).toBe(false);
  });

  it('takes them only when the latest of the person’s is new, theirs, and nothing went after it', () => {
    const mine = said('Running late, call you tomorrow');
    expect(byHandAt([mine], always, clues)).toBe(now - HOUR);
    // Already read last time.
    expect(byHandAt([mine], () => false, clues)).toBeNull();
    // A draft's words.
    expect(byHandAt([said('How do you keep track of customers?')], always, clues)).toBeNull();
    // The extension sent them something then, or since.
    expect(byHandAt([mine], always, { ...clues, sentAt: [now - HOUR + 5 * MINUTE] })).toBeNull();
    expect(byHandAt([mine], always, { ...clues, sentAt: [now - 10 * MINUTE] })).toBeNull();
    // Copied from Today just before.
    expect(byHandAt([mine], always, { ...clues, copiedAt: now - 2 * HOUR })).toBeNull();
    // Written before they were given back.
    expect(byHandAt([mine], always, { ...clues, backAt: now - 30 * MINUTE })).toBeNull();
    // Older than the 30 days looked back.
    expect(byHandAt([said('Hi again', now - 31 * DAY)], always, clues)).toBeNull();
    // Their own message after the person's still leaves the person's as the latest of theirs.
    const theirs = {
      fromMe: false,
      text: 'Sounds good',
      at: new Date(now - 30 * MINUTE).toISOString(),
    };
    expect(byHandAt([mine, theirs], always, clues)).toBe(now - HOUR);
  });

  it('asks after an hour of working hours', () => {
    const hours = { days: [1, 2, 3, 4, 5], start: 9, end: 17 };
    // Wednesday 19 November 2026, 4:30 PM in Chicago: half an hour today, half tomorrow from 9.
    const wed = Date.parse('2026-11-19T22:30:00Z');
    expect(
      new Date(workingAfter(hours as never, 'America/Chicago', wed, HOUR)!).toISOString(),
    ).toBe('2026-11-20T15:30:00.000Z');
  });
});

describe('In your hands', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  const handsOf = async (u: TestUser, input: Record<string, unknown> = {}) =>
    (await runAs(u, ws, 'outreach.hands', input)) as {
      people: {
        profileId: string;
        how: string;
        place: string | null;
        user: { id: string } | null;
      }[];
      total: number;
    };
  const held = async (profileId: string) =>
    (await handsOf(owner)).people.some((p) => p.profileId === profileId);
  const message = async (username: string, name: string, extra: Record<string, unknown> = {}) =>
    (
      (await runAs(owner, ws, 'outreach.touch.save', {
        kind: 'message',
        profile: fb(username),
        name,
        threadKey: `9${username.length}${Date.now() % 100000}`,
        ...extra,
      })) as { profileId: string }
    ).profileId;
  const queue = (profileId: string, text: string) =>
    runAs(owner, ws, 'outreach.send.queue', { profileId, kind: 'opener', text });

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outh-owner', { fullName: 'Chris Owner' }),
      createTestUser('outh-member', { fullName: 'Sam Member' }),
    ]);
    ws = await outreachBusiness(owner, 'In Your Hands Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
  }, 60_000);

  afterAll(closeTestDbs);

  it('takes someone the person wrote to themselves, not someone the extension wrote to', async () => {
    const dana = await message('dana.cole.181', 'Dana Cole');
    const eli = await message('eli.ray.181', 'Eli Ray', { auto: true });
    const list = await handsOf(owner);
    expect(list.people.find((p) => p.profileId === dana)).toMatchObject({
      how: 'wrote',
      place: 'facebook',
      user: { id: owner.id },
    });
    expect(list.people.some((p) => p.profileId === eli)).toBe(false);
    // Only mine: the member has nobody.
    expect((await handsOf(member, { mine: true })).people).toEqual([]);
    expect((await handsOf(member)).people.some((p) => p.profileId === dana)).toBe(true);

    // The person menu says whose hands, with Give back; for Eli, Take over.
    const marks = await runAs(owner, ws, 'outreach.profile.marks', { profileId: dana });
    expect(marks.inHands).toMatchObject({ profileId: dana, how: 'wrote' });
    const items = personMenuItems({
      row: { url: null, platform: 'facebook' },
      marks,
      contactsWrite: true,
      online: true,
      me: owner.id,
    });
    expect(items.find((i) => i.key === 'hands-line')?.label).toBe(
      `${HW.title}: You messaged them on Facebook`,
    );
    expect(items.some((i) => i.key === 'give-back')).toBe(true);
    const eliMarks = await runAs(owner, ws, 'outreach.profile.marks', { profileId: eli });
    expect(eliMarks.inHands).toBeNull();
    expect(
      personMenuItems({
        row: { url: null, platform: 'facebook' },
        marks: eliMarks,
        contactsWrite: true,
        online: true,
      }).some((i) => i.key === 'take-over'),
    ).toBe(true);
  });

  it('holds the AI off them, and Take over skips its messages waiting', async () => {
    const fay = await message('fay.lin.181', 'Fay Lin');
    expect(await refused(queue(fay, 'Hi Fay!'))).toBe('outreach_in_your_hands');

    const gus = await message('gus.hale.181', 'Gus Hale', { auto: true });
    const waiting = await queue(gus, 'Hi Gus! How do you keep track of customers?');
    expect(waiting).toMatchObject({ state: 'waiting' });
    const took = await runAs(owner, ws, 'outreach.hands.take', { profileId: gus });
    expect(took).toMatchObject({ profileId: gus, already: false, skipped: 1 });
    const [send] = await rows<{ state: string }>(
      admin(),
      sql`select state from addon_outreach.sends where id = ${waiting.sendId}`,
    );
    expect(send!.state).toBe('skipped');
    expect(await held(gus)).toBe(true);
    // Taken again: already theirs.
    expect(await runAs(owner, ws, 'outreach.hands.take', { profileId: gus })).toMatchObject({
      already: true,
    });
  });

  it('gives them back one at a time, or all at once', async () => {
    const hal = await message('hal.moss.181', 'Hal Moss');
    const ivy = await message('ivy.park.181', 'Ivy Park');
    expect(await refused(runAs(owner, ws, 'outreach.hands.give_back', {}))).toBe('validation');
    expect(await runAs(owner, ws, 'outreach.hands.give_back', { profileIds: [hal] })).toEqual({
      handedBack: 1,
    });
    expect(await held(hal)).toBe(false);
    expect(await queue(hal, 'Hi Hal!')).toMatchObject({ state: 'waiting' });
    expect(await refused(runAs(owner, ws, 'outreach.hands.keep', { profileId: hal }))).toBe(
      'outreach_not_in_hands',
    );

    expect(await held(ivy)).toBe(true);
    const all = await runAs(owner, ws, 'outreach.hands.give_back', { all: true });
    expect(all.handedBack).toBeGreaterThanOrEqual(1);
    expect((await handsOf(owner)).people).toEqual([]);
  });

  it('reads a chat: the person’s own words take them, the AI’s draft doesn’t', async () => {
    const draft =
      'Hi Jo! Saw your post about the bakery.\n\nHow do you keep track of your regulars?';
    const jo = await message('jo.vance.181', 'Jo Vance', {
      kind: 'friend_request',
      threadKey: null,
    });
    await queue(jo, draft);
    const collect = (messages: { fromMe: boolean; text: string; at: string }[]) =>
      runAs(owner, ws, 'outreach.chats.collect', {
        chats: [
          { name: 'Jo Vance', thread: { id: '9181000001' }, profile: fb('jo.vance.181'), messages },
        ],
      });
    // A paragraph of the draft, as its own bubble.
    const first = [
      { fromMe: true, text: 'How do you keep track of your regulars?', at: ago(3 * HOUR) },
    ];
    await collect(first);
    expect(await held(jo)).toBe(false);
    // Then something they typed themselves.
    await collect([
      ...first,
      { fromMe: true, text: 'Running late, call you tomorrow', at: ago(HOUR) },
    ]);
    expect(await held(jo)).toBe(true);
  });

  it('puts a customer in the same hands in Contacts, and back', async () => {
    const kim = await message('kim.ortiz.181', 'Kim Ortiz', { auto: true });
    const { personId } = await runAs(owner, ws, 'outreach.profile.contact', { profileId: kim });
    await runAs(owner, ws, 'outreach.hands.take', { profileId: kim });
    const inCore = () =>
      rows<{ user_id: string | null; how: string }>(
        admin(),
        sql`select user_id, how from app.people_in_hands where person_id = ${personId}`,
      );
    expect(await inCore()).toEqual([{ user_id: owner.id, how: 'took_over' }]);
    await runAs(owner, ws, 'outreach.hands.give_back', { profileIds: [kim] });
    expect(await inCore()).toEqual([]);

    // Taken over in Contacts: in their hands here too, through the customer.
    await runAs(owner, ws, 'person.take_over', { personId });
    expect(await held(kim)).toBe(true);
    expect(await refused(queue(kim, 'Hi Kim!'))).toBe('outreach_in_your_hands');

    // Given back in Contacts: the worker gives their profiles back here too.
    const lee = await message('lee.wong.181', 'Lee Wong');
    const linked = await runAs(owner, ws, 'outreach.profile.contact', { profileId: lee });
    await runAs(owner, ws, 'person.hand_back', { personIds: [linked.personId] });
    expect(await runAsSystem(ws, 'outreach.hands.release', { personId: linked.personId })).toEqual({
      released: 1,
    });
    expect(await held(lee)).toBe(false);
  });

  it('asks once they write back, on Needs you and once to the phone', async () => {
    const mo = await message('mo.reed.181', 'Mo Reed', { kind: 'friend_request', threadKey: null });
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          name: 'Mo Reed',
          thread: { id: '9181000002' },
          profile: fb('mo.reed.181'),
          messages: [
            { fromMe: true, text: 'Great meeting you at the expo, Mo', at: ago(6 * DAY) },
            { fromMe: false, text: 'Likewise! Can you send me your prices?', at: ago(5 * DAY) },
          ],
        },
      ],
    });
    expect(await held(mo)).toBe(true);
    const asks = async () =>
      (
        (await runAs(owner, ws, 'outreach.waiting', { items: true })) as {
          hands: { profileId: string }[];
        }
      ).hands;
    expect((await asks()).find((a) => a.profileId === mo)).toMatchObject({
      why: 'reply',
      name: 'Mo Reed',
      theirs: 'Likewise! Can you send me your prices?',
    });
    // Only to whoever has them.
    expect(
      ((await runAs(member, ws, 'outreach.waiting', { items: true })) as { hands: unknown[] })
        .hands,
    ).toEqual([]);

    const pushed = await runAsSystem(ws, 'outreach.hands.asked', {
      profileId: mo,
      userId: owner.id,
    });
    expect(pushed).toEqual({
      push: { title: 'Mo Reed wrote back on Facebook', body: expect.any(String) },
      again: null,
    });
    expect(
      await runAsSystem(ws, 'outreach.hands.asked', { profileId: mo, userId: owner.id }),
    ).toEqual({ push: null, again: null });

    // Keep it mine: the ask goes.
    await runAs(owner, ws, 'outreach.hands.keep', { profileId: mo });
    expect((await asks()).some((a) => a.profileId === mo)).toBe(false);
    expect(await held(mo)).toBe(true);
    expect(HW.letAi).toBe('Let the AI take it');
  });
});
