/**
 * Social Outreach: the AI decides the friend requests the person gets (docs/outreach.md, decision 136). Someone who
 * asked is read first after a Research press; the AI says Confirm, Delete or Not sure, kept beside its usual read.
 * Its yes is on Today to confirm, its no is deleted once a day when the person picked that, and the rest wait for
 * them with Confirm and Delete, whose press goes first, whatever they picked. One not read yet waits off the list a
 * day. On LinkedIn the same.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS, type AnswerMode } from '../../src/addons/outreach/automation';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { checkedAs, outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});
const li = (username: string) => ({
  id: null,
  username,
  url: `https://www.linkedin.com/in/${username}/`,
});
const names = (list: { name: string }[]) => list.map((c) => c.name).sort();

type Shown = { profileId: string; name: string; why: string[]; said: string | null };

describe('the AI deciding the requests the person gets', () => {
  let owner: TestUser;
  let ws: string;
  const idOf = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
    );
    return p!.id;
  };
  const says = async (
    username: string,
    answer: 'confirm' | 'delete' | 'ask',
    why: string,
    fit: 'good' | 'maybe' | 'not' = 'maybe',
  ) => checkedAs(owner, ws, await idOf(username), { fit, why: [why], request: { answer, why } });
  const waiting = async (): Promise<Shown[]> =>
    ((await runAs(owner, ws, 'outreach.waiting', {})).items as { request?: Shown }[]).flatMap(
      (i) => (i.request ? [i.request] : []),
    );
  const confirms = async (platform = 'facebook') =>
    (
      (await runAs(owner, ws, 'outreach.today', { platform })).items as {
        kind: string;
        name: string;
        why: string[];
      }[]
    ).filter((i) => i.kind === 'confirm');
  const declines = async (platform = 'facebook') =>
    (await runAs(owner, ws, 'outreach.friends.tidy', { platform })).own.decline as {
      name: string;
    }[];
  // Left to the person (`mine`) is confirming turned off; the rest are the choice under it.
  const pick = (requests: AnswerMode | 'mine') => {
    const picked = requests === 'mine' ? {} : { requests };
    return runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        sending: 'steps',
        confirmRequests: requests !== 'mine',
        networks: {
          ...AUTOMATION_DEFAULTS.networks,
          facebook: { ...AUTOMATION_DEFAULTS.networks.facebook, ...picked },
          linkedin: {
            ...AUTOMATION_DEFAULTS.networks.linkedin,
            on: true,
            confirmRequests: requests !== 'mine',
            ...picked,
          },
        },
      },
    });
  };

  beforeAll(async () => {
    owner = await createTestUser('outdecide-owner', { fullName: 'Robin Owner' });
    ws = await outreachBusiness(owner, 'Outreach Decide Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await pick('fits');
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'requests',
      people: [
        { profile: fb('frank.sinclair.1'), name: 'Frank Sinclair', mutualFriends: 58 },
        { profile: fb('spam.bot.2'), name: 'Spam Bot', mutualFriends: 0 },
        { profile: fb('casey.unsure.3'), name: 'Casey Unsure', mutualFriends: 3 },
        { profile: fb('nova.new.4'), name: 'Nova New', mutualFriends: 1 },
      ],
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('reads someone who asked first after a Research press, for what to do with it', async () => {
    const next = (await runAs(owner, ws, 'outreach.checks.next', {})) as {
      people: { name: string; reason: string }[];
    };
    expect(
      next.people
        .filter((p) => p.reason === 'request')
        .map((p) => p.name)
        .sort(),
    ).toEqual(['Casey Unsure', 'Frank Sinclair', 'Nova New', 'Spam Bot']);
    expect(next.people[0]!.reason).toBe('request');
  });

  it('keeps one not read yet off the list for a day, then shows it saying so', async () => {
    expect(await waiting()).toEqual([]);
    expect(await confirms()).toEqual([]);
    await rows(
      admin(),
      sql`update addon_outreach.friends set since = now() - interval '2 days'
          where workspace_id = ${ws} and profile_id = ${await idOf('nova.new.4')}`,
    );
    expect((await waiting()).map((r) => [r.name, r.why])).toEqual([
      ['Nova New', ['The AI hasn’t read their profile yet']],
    ]);
  });

  it('confirms its yes, leaves its no and its not sure to the person, as it starts', async () => {
    await says('frank.sinclair.1', 'confirm', '58 mutual friends, and a real person', 'not');
    await says('spam.bot.2', 'delete', 'Nothing but crypto posts', 'not');
    await says('casey.unsure.3', 'ask', 'Paints houses, but nothing says they hire');
    const today = await confirms();
    expect(names(today)).toEqual(['Frank Sinclair']);
    expect(today[0]!.why).toEqual([
      'Asked to be your friend',
      '58 mutual friends, and a real person',
    ]);
    const shown = await waiting();
    expect(shown.map((r) => [r.name, r.said, r.why])).toEqual(
      expect.arrayContaining([
        ['Spam Bot', 'delete', ['The AI says delete: Nothing but crypto posts']],
        ['Casey Unsure', 'ask', ['The AI isn’t sure: Paints houses, but nothing says they hire']],
      ]),
    );
    expect(await declines()).toEqual([]);
  });

  it('deletes its no once a day when the person picked that, and never one kept', async () => {
    await pick('fits_delete');
    expect(names(await declines())).toEqual(['Spam Bot']);
    expect(names(await waiting())).toEqual(['Casey Unsure', 'Nova New']);
    // Kept: theirs to decide, saying why it isn't deleted.
    await runAs(owner, ws, 'outreach.friend.set', {
      profileId: await idOf('spam.bot.2'),
      keep: true,
    });
    expect(await declines()).toEqual([]);
    expect((await waiting()).find((r) => r.name === 'Spam Bot')!.why).toEqual([
      'The AI says delete: Nothing but crypto posts',
      'It never deletes someone in Contacts, kept, chatted with, or a partner',
    ]);
  });

  it('does the person’s Confirm or Delete first, whatever they picked, and takes it off the list', async () => {
    await pick('mine');
    expect(await confirms()).toEqual([]);
    const casey = await idOf('casey.unsure.3');
    expect(
      await runAs(owner, ws, 'outreach.request.answer', { profileId: casey, answer: 'confirm' }),
    ).toEqual({ profileId: casey, answer: 'confirm' });
    expect(names(await waiting())).not.toContain('Casey Unsure');
    const today = await confirms();
    expect(names(today)).toEqual(['Casey Unsure']);
    expect(today[0]!.why).toEqual(['Asked to be your friend', 'You pressed Confirm']);
    // Changed their mind: Delete, even someone kept.
    await runAs(owner, ws, 'outreach.request.answer', { profileId: casey, answer: 'delete' });
    expect(await confirms()).toEqual([]);
    expect(names(await declines())).toEqual(['Casey Unsure']);
    await runAs(owner, ws, 'outreach.request.answer', {
      profileId: await idOf('spam.bot.2'),
      answer: 'delete',
    });
    expect(names(await declines())).toEqual(['Casey Unsure', 'Spam Bot']);
    // Deleted on Facebook: no longer waiting, so nothing to answer.
    await runAs(owner, ws, 'outreach.friend.note', {
      answer: 'delete',
      profile: fb('casey.unsure.3'),
      name: 'Casey Unsure',
    });
    expect(
      await refused(
        runAs(owner, ws, 'outreach.request.answer', { profileId: casey, answer: 'confirm' }),
      ),
    ).toBe('not_found');
    expect(names(await declines())).toEqual(['Spam Bot']);
  });

  it('never answers anyone on Never contact', async () => {
    const nova = await idOf('nova.new.4');
    await runAs(owner, ws, 'outreach.friend.set', { profileId: nova, neverContact: true });
    expect(
      await refused(
        runAs(owner, ws, 'outreach.request.answer', { profileId: nova, answer: 'confirm' }),
      ),
    ).toBe('outreach_never_contact');
  });

  it('answers LinkedIn’s invitations the same way', async () => {
    await pick('fits');
    await runAs(owner, ws, 'outreach.friends.save', {
      platform: 'linkedin',
      list: 'requests',
      people: [{ profile: li('dana-reyes-9'), name: 'Dana Reyes', mutualFriends: 12 }],
    });
    await says('dana-reyes-9', 'confirm', 'Owns a plumbing company in Austin', 'good');
    const today = await confirms('linkedin');
    expect(names(today)).toEqual(['Dana Reyes']);
    expect(today[0]!.why[1]).toBe('Owns a plumbing company in Austin');
    expect(
      (await runAs(owner, ws, 'outreach.friends.tidy', { platform: 'linkedin' })).limits.decline
        .most,
    ).toBeGreaterThan(0);
  });
});
