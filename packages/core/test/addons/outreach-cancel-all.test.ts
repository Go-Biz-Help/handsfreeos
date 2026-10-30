/**
 * Social Outreach: Cancel all, and the friend requests the person gets (docs/outreach.md, decision 121). Cancel all
 * marks every sent request waiting, however new, leaving out the ones the extension sent unless the person says, and
 * `outreach.friends.tidy` has the extension cancel them the oldest first at the day's limit, whatever they picked for
 * tidying, until Stop. And on Facebook the requests they get go as they pick: confirmed when they fit (as it starts),
 * all confirmed, all deleted, or those confirmed and the rest deleted, never deleting someone in Contacts, kept,
 * chatted with, a partner, or on Don't pitch or Never contact.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS, type AnswerMode } from '../../src/addons/outreach/automation';
import { DECLINES_PER_DAY } from '../../src/addons/outreach/limits';
import { tidyWordsOn } from '../../src/addons/outreach/network-words';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { checkedAs, outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});
const person = (username: string, name: string, mutualFriends: number | null = null) => ({
  profile: fb(username),
  name,
  mutualFriends,
});
const names = (list: { name: string }[]) => list.map((c) => c.name);

describe('Cancel all', () => {
  let owner: TestUser;
  let ws: string;
  const tidy = (platform = 'facebook') => runAs(owner, ws, 'outreach.friends.tidy', { platform });
  const cancelAll = (input: Record<string, unknown>) =>
    runAs(owner, ws, 'outreach.friends.cancel_all', input);
  const profileId = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
    );
    return p!.id;
  };
  const since = (username: string, days: number) =>
    rows(
      admin(),
      sql`update addon_outreach.friends f set since = ${daysAgo(days)}::timestamptz
          from addon_outreach.profiles p
          where p.id = f.profile_id and p.workspace_id = ${ws} and p.username = ${username}`,
    );
  const pickTidy = (tidyMode: 'off' | 'cancel') =>
    runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...AUTOMATION_DEFAULTS.networks,
          facebook: { ...AUTOMATION_DEFAULTS.networks.facebook, tidy: tidyMode },
        },
      },
    });

  beforeAll(async () => {
    owner = await createTestUser('outcancelall-owner', { fullName: 'Sam Owner' });
    ws = await outreachBusiness(owner, 'Outreach Cancel All Co');
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'sent',
      people: [
        person('casey.north.1', 'Casey North'),
        person('drew.hale.2', 'Drew Hale'),
        person('emery.cole.3', 'Emery Cole'),
        person('finley.ross.4', 'Finley Ross'),
      ],
    });
    await since('casey.north.1', 40);
    await since('emery.cole.3', 30);
    await since('drew.hale.2', 5);
    await since('finley.ross.4', 1);
    // The extension sent Emery's on its own (decision 26).
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, auto, at)
          values (${ws}, ${await profileId('emery.cole.3')}, ${owner.id}, 'friend_request', true,
            ${daysAgo(30)}::timestamptz)`,
    );
  }, 60_000);
  afterAll(closeTestDbs);

  it('lists only the old ones before it starts, with how many wait and how many the extension sent', async () => {
    const out = await tidy();
    expect(names(out.cancel)).toEqual(['Casey North', 'Emery Cole']);
    expect(out.waiting).toBe(4);
    expect(out.extension).toBe(1);
    expect(out.all).toBeNull();
    expect(out.cancel.every((c: { going: boolean }) => !c.going)).toBe(true);
  });

  it('marks every one waiting however new, leaving out the extension’s, and starts on the oldest', async () => {
    const started = await cancelAll({ on: true });
    expect(started.marked).toBe(3);
    expect(started.leftOut).toBe(1);
    expect(started.first).toEqual([
      await profileId('casey.north.1'),
      await profileId('drew.hale.2'),
      await profileId('finley.ross.4'),
    ]);
    const out = await tidy();
    expect(names(out.cancel)).toEqual(['Casey North', 'Emery Cole', 'Drew Hale', 'Finley Ross']);
    const going = out.cancel.filter((c: { going: boolean }) => c.going);
    expect(names(going)).toEqual(['Casey North', 'Drew Hale', 'Finley Ross']);
    expect(out.all).toEqual({ left: 3, at: expect.any(String) });
    // Tidying old ones on its own (as it starts) takes the old one it left out too.
    expect(out.own.mode).toBe('cancel');
    expect(names(out.own.cancel)).toEqual([
      'Casey North',
      'Emery Cole',
      'Drew Hale',
      'Finley Ross',
    ]);
  });

  it('cancels only the ones it marked while the person only ticks, and says so to an extension from before it', async () => {
    await pickTidy('off');
    const out = await tidy();
    expect(out.own.mode).toBe('cancel');
    expect(names(out.own.cancel)).toEqual(['Casey North', 'Drew Hale', 'Finley Ross']);
    await pickTidy('cancel');
  });

  it('counts each one cancelled against what’s left', async () => {
    await runAs(owner, ws, 'outreach.friend.end', {
      kind: 'cancel_request',
      profile: fb('casey.north.1'),
      name: 'Casey North',
    });
    const out = await tidy();
    expect(out.all).toEqual({ left: 2, at: expect.any(String) });
    expect(out.limits.cancel_request.done).toBe(1);
    expect(out.waiting).toBe(3);
  });

  it('stops, and the ones left wait as usual', async () => {
    const stopped = await cancelAll({ on: false });
    expect(stopped).toEqual({ marked: 0, leftOut: 0, first: [] });
    const out = await tidy();
    expect(out.all).toBeNull();
    expect(names(out.cancel)).toEqual(['Emery Cole']);
  });

  it('starts afresh when pressed again, with the extension’s too when the person unticks the box', async () => {
    const started = await cancelAll({ on: true, leaveOutOwn: false });
    expect(started.marked).toBe(3);
    expect(started.leftOut).toBe(0);
    expect((await tidy()).all).toMatchObject({ left: 3 });
    await cancelAll({ on: false });
  });

  it('says what’s wrong when there’s nothing it could cancel', async () => {
    // Instagram's follows wait for nobody.
    expect(await refused(cancelAll({ platform: 'instagram', on: true }))).toBe(
      'outreach_cancel_all_follows',
    );
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...AUTOMATION_DEFAULTS.networks,
          linkedin: { ...AUTOMATION_DEFAULTS.networks.linkedin, on: true },
        },
      },
    });
    expect(await refused(cancelAll({ platform: 'linkedin', on: true }))).toBe(
      'outreach_cancel_all_none',
    );
    // On LinkedIn only the extension's wait: left out, none is left.
    const [li] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name, friendship)
          values (${ws}, 'linkedin', 'gray-quill', 'https://www.linkedin.com/in/gray-quill/', 'Gray Quill',
            'request_sent') returning id`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at)
          values (${ws}, ${owner.id}, ${li!.id}, 'request_sent', ${daysAgo(2)}::timestamptz, now())`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, auto, at)
          values (${ws}, ${li!.id}, ${owner.id}, 'friend_request', true, ${daysAgo(2)}::timestamptz)`,
    );
    expect(await refused(cancelAll({ platform: 'linkedin', on: true }))).toBe(
      'outreach_cancel_all_only_own',
    );
    expect((await cancelAll({ platform: 'linkedin', on: true, leaveOutOwn: false })).marked).toBe(
      1,
    );
    expect(names((await tidy('linkedin')).own.cancel)).toEqual(['Gray Quill']);
  });

  it('is in the network’s words, and none on a follow network', () => {
    const fbAll = tidyWordsOn('facebook').all!;
    expect(fbAll.button).toBe('Cancel all');
    expect(fbAll.leaveOut(7)).toBe('Leave out the 7 the extension sent');
    expect(fbAll.leavingOut(7)).toBe('Cancel all but the extension’s 7');
    expect(fbAll.every(207)).toBe('Cancel all 207');
    expect(fbAll.about(207, 30)).toBe(
      'Cancels all 207 of your friend requests waiting for an answer, however new, the oldest first, 30 a day.',
    );
    expect(tidyWordsOn('linkedin').all!.button).toBe('Withdraw all');
    expect(tidyWordsOn('instagram').all).toBeNull();
  });
});

describe('the friend requests the person gets, on Facebook', () => {
  let owner: TestUser;
  let ws: string;
  const tidy = () => runAs(owner, ws, 'outreach.friends.tidy', {});
  const confirms = async () =>
    names(
      (await runAs(owner, ws, 'outreach.today', {})).items.filter(
        (i: { kind: string }) => i.kind === 'confirm',
      ),
    ).sort();
  const pick = (requests: AnswerMode | 'mine') =>
    runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        confirmRequests: requests !== 'mine',
        networks: {
          ...AUTOMATION_DEFAULTS.networks,
          facebook: {
            ...AUTOMATION_DEFAULTS.networks.facebook,
            ...(requests === 'mine' ? {} : { requests }),
          },
        },
      },
    });
  const profileId = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
    );
    return p!.id;
  };

  beforeAll(async () => {
    owner = await createTestUser('outanswer-owner', { fullName: 'Lee Owner' });
    ws = await outreachBusiness(owner, 'Outreach Answers Co');
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'requests',
      people: [
        person('gale.prior.5', 'Gale Prior', 6),
        person('hollis.reed.6', 'Hollis Reed', 0),
        person('indy.marsh.7', 'Indy Marsh', 0),
        person('jules.park.8', 'Jules Park', 0),
      ],
    });
    // Gale runs a roofing company: a good fit once a playbook is in use.
    await rows(
      admin(),
      sql`update addon_outreach.profiles set intro = array['Owner at Prior Roofing']
          where workspace_id = ${ws} and username = 'gale.prior.5'`,
    );
    // Indy is on Don't pitch, and the person has chatted with Jules: never deleted.
    await runAs(owner, ws, 'outreach.friend.set', {
      profile: fb('indy.marsh.7'),
      name: 'Indy Marsh',
      dontPitch: true,
    });
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, auto, at)
          values (${ws}, ${await profileId('jules.park.8')}, ${owner.id}, 'message', false, now())`,
    );
  }, 60_000);
  afterAll(closeTestDbs);

  it('deletes nobody to start, as it confirms who fits', async () => {
    const out = await tidy();
    expect(out.own.decline).toEqual([]);
    expect(out.limits.decline).toEqual({ done: 0, most: DECLINES_PER_DAY });
  });

  it('confirms who fits and deletes the rest only once a playbook is in use', async () => {
    await pick('fits_delete');
    expect((await tidy()).own.decline).toEqual([]);
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    // Not fitting by the lines under a name never deletes on its own: the AI reads them first (decision 136).
    expect((await tidy()).own.decline).toEqual([]);
    await checkedAs(owner, ws, await profileId('hollis.reed.6'), {
      fit: 'not',
      why: ['Nothing on their page'],
      request: { answer: 'delete', why: 'No mutual friends, and nothing on their page' },
    });
    expect(names((await tidy()).own.decline)).toEqual(['Hollis Reed']);
    expect(await confirms()).toEqual(['Gale Prior']);
  });

  it('deletes them all but those it never deletes, and confirms none', async () => {
    await pick('delete');
    expect(names((await tidy()).own.decline).sort()).toEqual(['Gale Prior', 'Hollis Reed']);
    expect(await confirms()).toEqual([]);
  });

  it('confirms them all, fit or not, and deletes none', async () => {
    await pick('all');
    expect((await tidy()).own.decline).toEqual([]);
    expect(await confirms()).toEqual(expect.arrayContaining(['Gale Prior', 'Hollis Reed']));
  });

  it('counts each one deleted today, the extension’s or the person’s, and lists it no more', async () => {
    await pick('delete');
    await runAs(owner, ws, 'outreach.friend.note', {
      answer: 'delete',
      profile: fb('hollis.reed.6'),
      name: 'Hollis Reed',
    });
    const out = await tidy();
    expect(out.limits.decline.done).toBe(1);
    expect(names(out.own.decline)).toEqual(['Gale Prior']);
  });

  it('leaves them all to the person when they pick that', async () => {
    await pick('mine');
    expect((await tidy()).own.decline).toEqual([]);
  });
});
