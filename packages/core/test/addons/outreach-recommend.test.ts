/**
 * Social Outreach: recommending a business on Alignable, by hand only (the Instagram and Alignable plan's question 8;
 * the partners plan's stage 6, part 3d). Today suggests one a day, a partner of theirs or a customer they've done work
 * for, never one recommended already, and the extension notes the recommendation once the person has sent it. Don't
 * pitch holds back the outreach, never a recommendation; Never contact holds back both. Only Alignable has them.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { RECOMMEND_WORDS } from '../../src/addons/outreach/today';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const AL = 'https://www.alignable.com';

describe('a business to recommend on Alignable', () => {
  let owner: TestUser;
  let ws: string;

  beforeAll(async () => {
    owner = await createTestUser('outrec-owner', { fullName: 'Casey Owner' });
    ws = await outreachBusiness(owner, 'Outreach Recommend Co');
    // A playbook in use, so they're ready and Today lists more than replies (decision 63).
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: PLAYBOOK_TEMPLATES.crm_demos.details,
    });
  }, 60_000);

  afterAll(closeTestDbs);

  /** A business on Alignable, by Alignable's id, saved to a customer when there is one. */
  async function business(name: string, personId: string | null = null) {
    const id = `b${randomUUID().slice(0, 8)}`;
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, platform_id, url, name, person_id)
          values (${ws}, 'alignable', ${id}, ${`${AL}/biz/businesses/${id}`}, ${name}, ${personId})
          returning id`,
    );
    return { profileId: p!.id, ref: { id, username: null, url: `${AL}/biz/businesses/${id}` } };
  }

  async function customer(first: string, job: 'done' | 'scheduled') {
    const [person] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, ${first}, 'Owner')
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.jobs (workspace_id, person_id, title, status)
          values (${ws}, ${person!.id}, 'Roof repair', ${job})`,
    );
    return person!.id;
  }

  const suggested = async () =>
    (
      (await runAs(owner, ws, 'outreach.today', { platform: 'alignable' })).items as {
        kind: string;
        name: string;
        why: string[];
        nextStep: string | null;
      }[]
    ).filter((i) => i.kind === 'recommend');

  const recommend = (ref: { id: string; username: null; url: string }, name: string) =>
    runAs(owner, ws, 'outreach.touch.save', {
      platform: 'alignable',
      kind: 'recommend',
      profile: ref,
      name,
    });

  it('suggests one a day, a customer with work done or a partner, and stops once it’s recommended', async () => {
    const done = await business('Pine Street Bakery', await customer('Dana', 'done'));
    // Work not done yet, and nobody's customer: neither is suggested.
    await business('Oak Plumbing', await customer('Sam', 'scheduled'));
    await business('A Stranger Co');
    const partner = await business('Summit Insurance');
    await rows(
      admin(),
      sql`insert into addon_outreach.partners (workspace_id, user_id, profile_id, kind, fit, stage, looked_at, partner_at)
          values (${ws}, ${owner.id}, ${partner.profileId}, 'business', 'good', 'partner', now(), now())`,
    );

    const first = await suggested();
    expect(first).toHaveLength(1);
    expect(['Pine Street Bakery', 'Summit Insurance']).toContain(first[0]!.name);
    expect(first[0]!.why).toEqual([
      first[0]!.name === 'Summit Insurance' ? RECOMMEND_WORDS.partner : RECOMMEND_WORDS.customer,
    ]);
    expect(first[0]!.nextStep).toBe(RECOMMEND_WORDS.next);

    // Recommended today: nothing more to recommend till tomorrow.
    const [picked, other] =
      first[0]!.name === 'Pine Street Bakery'
        ? [
            { ...done, name: 'Pine Street Bakery' },
            { ...partner, name: 'Summit Insurance' },
          ]
        : [
            { ...partner, name: 'Summit Insurance' },
            { ...done, name: 'Pine Street Bakery' },
          ];
    const noted = await recommend(picked.ref, picked.name);
    expect(noted).toMatchObject({ profileId: picked.profileId, repeated: false });
    expect(await suggested()).toEqual([]);
    // Recommended again: noted once.
    expect(await recommend(picked.ref, picked.name)).toMatchObject({ repeated: true });

    // A day on, the other one, never the one recommended.
    await rows(
      admin(),
      sql`update addon_outreach.touches set at = now() - interval '2 days'
          where workspace_id = ${ws} and kind = 'recommend'`,
    );
    expect((await suggested()).map((i) => i.name)).toEqual([other.name]);
  });

  it('notes a recommendation of a customer on Don’t pitch, but not of one on Never contact', async () => {
    const friend = await business('Maple Florist', await customer('Lee', 'done'));
    await rows(
      admin(),
      sql`update addon_outreach.profiles set dont_pitch = true where id = ${friend.profileId}`,
    );
    expect(await recommend(friend.ref, 'Maple Florist')).toMatchObject({ repeated: false });

    const off = await business('Birch Cafe', await customer('Kim', 'done'));
    await rows(
      admin(),
      sql`update addon_outreach.profiles set never_contact = true where id = ${off.profileId}`,
    );
    expect(await refused(recommend(off.ref, 'Birch Cafe'))).toBe('outreach_never_contact');
  });

  it('notes recommendations on Alignable only', async () => {
    expect(
      await refused(
        runAs(owner, ws, 'outreach.touch.save', {
          platform: 'linkedin',
          kind: 'recommend',
          profile: {
            id: null,
            username: 'dana-reyes',
            url: 'https://www.linkedin.com/in/dana-reyes/',
          },
          name: 'Dana Reyes',
        }),
      ),
    ).toBe('outreach_no_recommendations');
  });
});
