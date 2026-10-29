/**
 * Birthday and new-job notes (docs/outreach.md decision 108, the owner's pick 5a): what the person's computer read on
 * Facebook's Birthdays page and LinkedIn's Catch up is kept for the people already kept, and Today offers a short note
 * to those the person has chatted with or who fit a playbook, with no pitch and no link, always waiting for their OK.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OCCASION_WORDS } from '../../src/addons/outreach/occasions';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { goesAsItIs } from '../../src/addons/outreach/sends';
import { fitsOccasion, todayDraftPrompt, type TodayItem } from '../../src/addons/outreach/today';
import { checkedAs, outreachBusiness, runAs } from './outreach-fixture';

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

afterAll(closeTestDbs);

describe('what a note says', () => {
  const base = {
    business: 'Cole Plumbing',
    name: 'Quinn Harper',
    facts: [],
    recent: [],
    playbook: {
      name: 'CRM demos',
      ...PLAYBOOK_TEMPLATES.crm_demos.details,
      link: 'https://example.com/book?ref=so-1',
    },
  };

  it('is about them, with nothing about the business and no link', () => {
    const birthday = todayDraftPrompt({ ...base, kind: 'birthday' });
    expect(birthday).toContain('It’s their birthday today');
    expect(birthday).not.toContain('example.com/book');
    expect(birthday).not.toContain('Offer:');
    const job = todayDraftPrompt({
      ...base,
      kind: 'new_job',
      occasion: 'Started a new position as Owner at Harper Roofing',
    });
    expect(job).toContain('What the page said: Started a new position as Owner at Harper Roofing');
    expect(job).not.toContain('example.com/book');
    expect(fitsOccasion('Happy birthday, Quinn!')).toBe(true);
    expect(fitsOccasion('Happy birthday! Book a call: example.com/book')).toBe(false);
  });

  it('always waits for the person’s OK, whatever Sending says', () => {
    const o = { replies: 'everything', wheels: false, simple: false, needsYou: null } as const;
    expect(goesAsItIs({ ...o, sending: 'everything', kind: 'follow_up' })).toBe(true);
    expect(goesAsItIs({ ...o, sending: 'everything', kind: 'birthday' })).toBe(false);
    expect(goesAsItIs({ ...o, sending: 'everything', kind: 'new_job' })).toBe(false);
  });
});

describe('birthdays and new jobs on Today', () => {
  let owner: TestUser;
  let ws: string;
  const ids: Record<string, string> = {};
  const notes = async (platform: 'facebook' | 'linkedin') =>
    ((await runAs(owner, ws, 'outreach.today', { platform })).items as TodayItem[]).filter(
      (i) => i.kind === 'birthday' || i.kind === 'new_job',
    );

  beforeAll(async () => {
    owner = await createTestUser('outoc-owner', { fullName: 'Morgan Lane' });
    ws = await outreachBusiness(owner, 'Occasions Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    const friends = [
      ['dana.reyes.72', 'Dana Reyes'],
      ['casey.m.72', 'Casey Moreno'],
      ['riley.s.72', 'Riley Stone'],
      ['jo.n.72', 'Jo Nash'],
    ] as const;
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: friends.map(([u, name]) => ({ profile: fb(u), name, mutualFriends: 3 })),
    });
    await runAs(owner, ws, 'outreach.friends.save', {
      platform: 'linkedin',
      list: 'friends',
      people: [{ profile: li('avery-brooks-72'), name: 'Avery Brooks', mutualFriends: null }],
    });
    for (const p of await rows<{ id: string; username: string }>(
      admin(),
      sql`select id, username from addon_outreach.profiles where workspace_id = ${ws}`,
    ))
      ids[p.username] = p.id;
    // Dana and Morgan chatted a while ago; the AI found Casey and Avery a fit; Riley neither; Jo is on Never contact.
    await rows(
      admin(),
      sql`insert into addon_outreach.file_chats (workspace_id, user_id, platform, name, name_key, first_at,
            last_at, messages, last_from_me, profile_id, read_state, prospect)
          values (${ws}, ${owner.id}, 'facebook', 'Dana Reyes', 'dana reyes', now() - interval '400 days',
            now() - interval '200 days', 6, true, ${ids['dana.reyes.72']}, 'read', false)`,
    );
    for (const u of ['casey.m.72', 'jo.n.72', 'avery-brooks-72'])
      await checkedAs(owner, ws, ids[u]!, { fit: 'good', why: ['Owns a trades business'] });
    await rows(
      admin(),
      sql`update addon_outreach.profiles set never_contact = true where id = ${ids['jo.n.72']}`,
    );
  }, 90_000);

  it('keeps what the page shows of people already kept, and adds nobody', async () => {
    const saved = await runAs(owner, ws, 'outreach.occasions.save', {
      platform: 'facebook',
      occasions: [
        { profile: fb('dana.reyes.72'), name: 'Dana Reyes', kind: 'birthday' },
        { profile: fb('casey.m.72'), name: 'Casey Moreno', kind: 'birthday' },
        { profile: fb('riley.s.72'), name: 'Riley Stone', kind: 'birthday' },
        { profile: fb('jo.n.72'), name: 'Jo Nash', kind: 'birthday' },
        { profile: fb('someone.new.72'), name: 'Sam New', kind: 'birthday' },
        // Facebook shows no new jobs: one sent from there is left.
        { profile: fb('dana.reyes.72'), name: 'Dana Reyes', kind: 'new_job', detail: 'New job' },
      ],
    });
    expect(saved).toEqual({ kept: 4, left: 2 });
    const [count] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.profiles
          where workspace_id = ${ws} and username = 'someone.new.72'`,
    );
    expect(count!.n).toBe(0);
    // Read again the same day: still one each.
    await runAs(owner, ws, 'outreach.occasions.save', {
      platform: 'facebook',
      occasions: [{ profile: fb('dana.reyes.72'), name: 'Dana Reyes', kind: 'birthday' }],
    });
    const [kept] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.occasions where workspace_id = ${ws}`,
    );
    expect(kept!.n).toBe(4);
  });

  it('offers a note only to someone chatted with or who fits a playbook', async () => {
    const listed = await notes('facebook');
    expect(listed.map((i) => i.name).sort()).toEqual(['Casey Moreno', 'Dana Reyes']);
    expect(listed[0]).toMatchObject({
      kind: 'birthday',
      why: [OCCASION_WORDS.birthdayWhy],
      demoLink: null,
    });
  });

  it('offers a note on a new job read on LinkedIn, in its words', async () => {
    await runAs(owner, ws, 'outreach.occasions.save', {
      platform: 'linkedin',
      occasions: [
        {
          profile: li('avery-brooks-72'),
          name: 'Avery Brooks',
          kind: 'new_job',
          detail: 'Started a new position as Owner at Brooks Roofing',
        },
      ],
    });
    expect(await notes('linkedin')).toEqual([
      expect.objectContaining({
        kind: 'new_job',
        name: 'Avery Brooks',
        why: ['Started a new position as Owner at Brooks Roofing'],
      }),
    ]);
  });

  it('waits for the person’s OK, and leaves Today once written or skipped', async () => {
    const queued = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: ids['casey.m.72'],
      kind: 'birthday',
      text: 'Happy birthday, Casey!',
    });
    expect(queued).toMatchObject({ state: 'waiting', needsYou: OCCASION_WORDS.needsYou });
    const casey = (await notes('facebook')).find((i) => i.name === 'Casey Moreno');
    expect(casey?.send).toMatchObject({ state: 'waiting', text: 'Happy birthday, Casey!' });

    await runAs(owner, ws, 'outreach.send.skip', { sendId: (queued as { sendId: string }).sendId });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      profile: fb('dana.reyes.72'),
      name: 'Dana Reyes',
    });
    expect(await notes('facebook')).toEqual([]);
  });
});
