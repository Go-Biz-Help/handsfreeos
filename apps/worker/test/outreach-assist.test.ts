/**
 * Social Outreach's AI help in the playbook builder (`outreach.playbook.assist`), through the worker's actions route
 * against the stand-in model: words to pick from, lines to add that aren't there already, and questions with only
 * the playbook's own tags. Owners and admins only, as they write the playbooks. And whether a playbook's niche fits
 * the business's main offer (`outreach.playbook.niche_fit`): nothing to check against until one is live.
 */
import { createTokenVerifier, MainOfferParts } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYBOOK_TEMPLATES } from '../../../packages/core/src/addons/outreach/playbooks';
import { outreachBusiness } from '../../../packages/core/test/addons/outreach-fixture';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let ws: string;

const assist = async (u: TestUser, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/addons/outreach/actions/outreach.playbook.assist',
    headers: { authorization: `Bearer ${await signInTestUser(u)}` },
    payload: { workspaceId: ws, input },
  });

const nicheFit = async (u: TestUser, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/addons/outreach/actions/outreach.playbook.niche_fit',
    headers: { authorization: `Bearer ${await signInTestUser(u)}` },
    payload: { workspaceId: ws, input },
  });

const draft = {
  name: 'CRM demos',
  goal: 'demo',
  offer: 'A 20-minute demo',
  signs: ['Business owner'],
  tags: ['Uses a spreadsheet'],
};

beforeAll(async () => {
  const s = testServices({ ai: { provider: scriptedAi() } });
  [owner, member] = await Promise.all([
    createTestUser('outreach-assist-owner'),
    createTestUser('outreach-assist-member'),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Assist Co');
  await testDbs()
    .admin.db.insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  const env = testEnv();
  app = await buildHttpServer({
    ...s,
    addonConnect: { fake: true, platformKeys: {} },
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('AI help on a playbook', () => {
  it('suggests lines that aren’t there yet, and words to pick from', async () => {
    const signs = await assist(owner, { part: 'signs', mode: 'suggest', draft });
    expect(signs.statusCode).toBe(200);
    expect(signs.json()).toEqual({
      options: [
        'A better signs someone fits',
        'Another signs someone fits',
        'A third signs someone fits',
      ],
      questions: [],
    });

    const offer = await assist(owner, { part: 'offer', mode: 'improve', draft });
    // Words are three to pick from, at most.
    expect(offer.json().options).toHaveLength(3);
  });

  it('suggests questions with only the playbook’s own tags', async () => {
    const res = await assist(owner, { part: 'questions', mode: 'suggest', draft });
    expect(res.json()).toEqual({
      options: [],
      questions: [
        {
          text: 'How do you keep track of your customers now?',
          answers: [
            { label: 'A spreadsheet', tag: 'Uses a spreadsheet', next: 'offer' },
            { label: 'A CRM', tag: null, next: 'continue' },
          ],
        },
      ],
    });
  });

  it('is for owners and admins, who write the playbooks', async () => {
    const res = await assist(member, { part: 'signs', mode: 'suggest', draft });
    expect(res.statusCode).toBe(403);
  });
});

describe('whether a niche fits the main offer', () => {
  it('has nothing to check against until the main offer is live, then says inside or a second offer', async () => {
    const roofers = {
      niche: 'Roofers with 2 to 3 crews',
      problem: 'No steady jobs between storms',
    };
    const none = await nicheFit(owner, roofers);
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ fit: 'no_offer' });

    const parts = MainOfferParts.parse({
      who: { work: 'Roofers', slice: 'with 2 to 3 crews', problem: 'No steady jobs' },
      line: 'We help roofers with 2 to 3 crews get 10 to 20 booked inspections a month.',
      inAFewWords: {
        outcome: '10 to 20 booked inspections',
        guarantee: 'you only pay for results',
      },
    });
    await rows(
      testDbs().admin.db,
      sql`with v as (
            insert into app.main_offer_versions (workspace_id, version, parts, line, score)
            values (${ws}, 1, ${JSON.stringify(parts)}::jsonb, ${parts.line}, '{}'::jsonb) returning version)
          insert into app.main_offers (workspace_id, live_version) select ${ws}, version from v`,
    );

    expect((await nicheFit(owner, roofers)).json()).toEqual({
      fit: 'inside',
      why: 'roofers is in the offer’s who.',
    });
    // The model's long dash never reaches the screen.
    expect((await nicheFit(owner, { niche: 'Dentists in Ohio' })).json()).toEqual({
      fit: 'second_offer',
      why: 'They’d need another outcome, and price.',
    });
  });

  it('is for owners and admins, and needs a niche', async () => {
    expect((await nicheFit(member, { niche: 'Roofers' })).statusCode).toBe(403);
    expect((await nicheFit(owner, { niche: ' ' })).statusCode).toBe(400);
  });
});

describe('your profile, checked by the AI', () => {
  const read = {
    name: 'Casey Owner',
    picture: 'May be an image of 1 person, smiling',
    cover: null,
    bio: 'I help roofers get booked jobs',
    intro: ['Owner at Summit Roof Leads', 'Lives in Columbus, Ohio'],
    featured: [],
    posts: ['Another roof done before the storm.'],
  };
  const check = async (u: TestUser) =>
    app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.profile.check',
      headers: { authorization: `Bearer ${await signInTestUser(u)}` },
      payload: { workspaceId: ws, input: read },
    });

  it('scores what the extension read against the live main offer, and keeps only its answer', async () => {
    const res = await check(owner);
    expect(res.statusCode).toBe(200);
    const got = res.json();
    expect(got.items).toMatchObject({
      picture: { ok: true },
      cover: { ok: false, fix: 'Change your cover.' },
      bio: { ok: true },
      work: { ok: true },
      featured: { ok: false },
    });
    // The third bio was too long for Facebook's short bio.
    expect(got.bios).toEqual([
      'I help Roofers with 2 to 3 crews get more booked calls.',
      'More booked calls for Roofers with 2 to 3 crews.',
    ]);
    expect(got.version).toBe(1);
    const [kept] = await rows<{ profile_check: unknown }>(
      testDbs().admin.db,
      sql`select profile_check from addon_outreach.setup where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    expect(kept!.profile_check).toEqual(got);
    // What the page said goes no further.
    expect(JSON.stringify(kept!.profile_check)).not.toContain('Lives in Columbus');
  });

  it('is for everyone using the add-on, each their own', async () => {
    expect((await check(member)).statusCode).toBe(200);
  });

  it('says how the whole profile comes across, and keeps the parts shown side by side', async () => {
    const got = (await check(owner)).json();
    expect(got.look).toMatchObject({ reads: 'person', work: 'same', ok: true });
    expect(got.seen).toMatchObject({ name: 'Casey Owner', line: 'I help roofers get booked jobs' });
  });

  const more = async (u: TestUser, input: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.profile.more',
      headers: { authorization: `Bearer ${await signInTestUser(u)}` },
      payload: { workspaceId: ws, input },
    });

  it('writes more of one part with the person’s note, kept for the next check (decision 84)', async () => {
    const res = await more(owner, { part: 'bio', chips: ['Warmer'], note: 'say Columbus' });
    expect(res.statusCode).toBe(200);
    const got = res.json();
    expect(got.options).toEqual(['A new bio, again.', 'Another bio, again.', 'One more bio.']);
    expect(got.check.bios).toEqual(got.options);
    expect(got.check.notes).toEqual({ bio: ['Warmer. say Columbus.'] });
    // Facebook usernames take no underscores: that one's left out.
    const names = (await more(owner, { part: 'username' })).json();
    expect(names.options).toEqual(['casey.first', 'casey.roofs']);
    // The next check follows the note, and keeps it.
    const again = (await check(owner)).json();
    expect(again.notes).toEqual({ bio: ['Warmer. say Columbus.'] });
  });

  it('asks for more only of a profile read already', async () => {
    const fresh = await createTestUser('outreach-assist-fresh');
    await testDbs()
      .admin.db.insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: fresh.id, role: 'member' });
    const res = await more(fresh, { part: 'bio' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.rule).toBe('outreach_profile_not_read');
  });

  it('writes the work for the business, the post to feature and the links to take off, read on its own (decision 99)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.profile.check',
      headers: { authorization: `Bearer ${await signInTestUser(owner)}` },
      payload: {
        workspaceId: ws,
        input: { ...read, intro: [], links: ['https://oldjob.example.com/'], own: true },
      },
    });
    expect(res.statusCode).toBe(200);
    const got = res.json();
    // The work is added for the business's own name, never one the AI made up.
    expect(got.workDraft).toEqual({
      title: 'Owner',
      company: 'Outreach Assist Co',
      words: expect.stringContaining('get more booked calls'),
    });
    expect(got.featurePost).toBe('Another roof done before the storm.');
    // No link of theirs is known yet, so the one about another business is taken off, not changed.
    expect(got.linkChanges).toEqual([
      { link: 'https://oldjob.example.com/', to: null, why: 'It’s about another business.' },
    ]);
    expect(got.own).toBe(true);
  });
});

describe('your messages, written by the AI', () => {
  const samples = async (u: TestUser) =>
    app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.messages.samples',
      headers: { authorization: `Bearer ${await signInTestUser(u)}` },
      payload: { workspaceId: ws, input: {} },
    });

  it('writes samples for the playbook from the live main offer, as many follow-ups as the pace sends, and keeps them', async () => {
    await rows(
      testDbs().admin.db,
      sql`insert into addon_outreach.playbooks (workspace_id, name, details)
          values (${ws}, 'Roofers', ${JSON.stringify({
            ...PLAYBOOK_TEMPLATES.crm_demos.details,
            niche: 'Roofers with 2 to 3 crews',
          })}::jsonb)`,
    );
    const res = await samples(owner);
    expect(res.statusCode).toBe(200);
    const got = res.json();
    expect(got).toMatchObject({ playbookName: 'Roofers', version: 1, video: null });
    // Each once, the video only with one, and the pace's 6 follow-ups.
    expect(got.first).toHaveLength(2);
    expect(got.followUps).toHaveLength(6);
    expect(got.link).toContain('[booking link]');
    const [kept] = await rows<{ message_samples: unknown }>(
      testDbs().admin.db,
      sql`select message_samples from addon_outreach.setup where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    expect(kept!.message_samples).toEqual(got);
  });

  const rewrite = async (u: TestUser, input: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.messages.rewrite',
      headers: { authorization: `Bearer ${await signInTestUser(u)}` },
      payload: { workspaceId: ws, input },
    });

  it('writes one again with the person’s note, keeps the note for its part, and keeps their own when written again (decision 87)', async () => {
    const res = await rewrite(owner, {
      part: 'followUps',
      index: 2,
      chips: ['Less pushy'],
      note: 'say my name',
    });
    expect(res.statusCode).toBe(200);
    const got = res.json();
    expect(got.messages.samples.followUps[2]).toBe(
      'Written again, follow-up 3, Less pushy. say my name.',
    );
    expect(got.messages.notes.followUps).toEqual(['Less pushy. say my name.']);
    // Again, unlike the last: the note is kept once.
    const again = (await rewrite(owner, { part: 'followUps', index: 2 })).json();
    expect(again.messages.samples.followUps[2]).toBe(
      'Written again, follow-up 3, Less pushy. say my name, once more.',
    );
    expect(again.messages.notes.followUps).toEqual(['Less pushy. say my name.']);

    // One in their own words stays as they wrote it when the rest are written again.
    await rows(
      testDbs().admin.db,
      sql`update addon_outreach.setup
          set message_samples = jsonb_set(jsonb_set(message_samples, '{followUps,0}', '"Mine, as I wrote it."'),
            '{mine}', '["followUps.0"]')
          where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    const written = (await samples(owner)).json();
    expect(written.followUps[0]).toBe('Mine, as I wrote it.');
    expect(written.followUps[1]).toBe('Follow-up 2: just checking in.');
    expect(written.mine).toEqual(['followUps.0']);
  });

  it('writes one again only of the samples there are, for the main offer live now', async () => {
    expect((await rewrite(owner, { part: 'video' })).json().error.rule).toBe(
      'outreach_message_no_video',
    );
    expect((await rewrite(member, { part: 'first' })).json().error.rule).toBe(
      'outreach_messages_unseen',
    );
    // A new version of the main offer: these are written again whole first.
    await rows(
      testDbs().admin.db,
      sql`update addon_outreach.setup set message_samples = jsonb_set(message_samples, '{version}', '7')
          where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    const older = await rewrite(owner, { part: 'first' });
    expect(older.statusCode).toBe(409);
    expect(older.json().error.rule).toBe('outreach_messages_older');
  });
});

describe('the short video’s script, written by the AI', () => {
  const script = async (u: TestUser, input: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.video.script',
      headers: { authorization: `Bearer ${await signInTestUser(u)}` },
      payload: { workspaceId: ws, input },
    });
  const roofers = { name: 'Roofers', niche: 'Roofers with 2 to 3 crews' };

  it('writes every part from the live main offer and the playbook, then one part again', async () => {
    const res = await script(owner, { draft: roofers });
    expect(res.statusCode).toBe(200);
    const got = res.json();
    expect(got.parts.map((p: { part: string }) => p.part)).toEqual([
      'who',
      'cost',
      'method',
      'proof',
      'call',
      'next',
    ]);
    expect(got.parts[0].say).toContain('Roofers with 2 to 3 crews');
    expect(got.version).toBe(1);

    const again = await script(owner, {
      draft: roofers,
      mode: 'improve',
      part: 'call',
      script: got,
    });
    expect(again.statusCode).toBe(200);
    const better = again.json();
    expect(better.parts[4].say).toContain('Said even more plainly.');
    expect(better.parts.filter((p: { part: string }) => p.part !== 'call')).toEqual(
      got.parts.filter((p: { part: string }) => p.part !== 'call'),
    );
  });

  it('is for owners and admins, who write the playbooks', async () => {
    expect((await script(member, { draft: roofers })).statusCode).toBe(403);
    expect((await script(owner, { draft: roofers, mode: 'improve' })).statusCode).toBe(400);
  });
});
