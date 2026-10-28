/**
 * Social Outreach's drafts for Today (`outreach.today.draft`), through the worker's actions route against the
 * stand-in model: a few to pick from, each once, none with the playbook's words to avoid. A person's chat is only
 * theirs to draft from.
 */
import { createTokenVerifier } from '@hfos/core/server';
import { people, recordTags, tags, workspaceMemberships } from '@hfos/db/schema';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness } from '../../../packages/core/test/addons/outreach-fixture';
import {
  fileChats,
  followUps,
  friends,
  occasions,
  openerUses,
  playbooks,
  posts,
  profiles,
  setup,
} from '../../../packages/core/src/addons/outreach/tables';
import { PLAYBOOK_TEMPLATES } from '../../../packages/core/src/addons/outreach/playbooks';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let ws: string;
let profileId: string;
let chatId: string;
let postId: string;

const draft = async (u: TestUser, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/addons/outreach/actions/outreach.today.draft',
    headers: { authorization: `Bearer ${await signInTestUser(u)}` },
    payload: { workspaceId: ws, input },
  });

beforeAll(async () => {
  const s = testServices({ ai: { provider: scriptedAi() } });
  [owner, member] = await Promise.all([
    createTestUser('outreach-draft-owner'),
    createTestUser('outreach-draft-member'),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Draft Co');
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await testDbs()
    .admin.db.insert(playbooks)
    .values({
      workspaceId: ws,
      name: crm.name,
      details: { ...crm.details, avoid: ['free trial'] },
    });
  const [p] = await testDbs()
    .admin.db.insert(profiles)
    .values({
      workspaceId: ws,
      platform: 'facebook',
      username: 'dana.reyes.12',
      url: 'https://www.facebook.com/dana.reyes.12',
      name: 'Dana Reyes',
      intro: ['Owner at Reyes Plumbing'],
    })
    .returning({ id: profiles.id });
  profileId = p!.id;
  const [c] = await testDbs()
    .admin.db.insert(fileChats)
    .values({
      workspaceId: ws,
      userId: owner.id,
      platform: 'facebook',
      name: 'Dana Reyes',
      nameKey: 'danareyes',
      firstAt: new Date(),
      lastAt: new Date(),
      messages: 1,
      lastFromMe: false,
      recent: [{ fromMe: false, text: 'How much is it?', at: new Date().toISOString() }],
    })
    .returning({ id: fileChats.id });
  chatId = c!.id;
  const [po] = await testDbs()
    .admin.db.insert(posts)
    .values({
      workspaceId: ws,
      userId: owner.id,
      profileId,
      url: 'https://www.facebook.com/groups/323456789/posts/100001/',
      body: 'Can anyone recommend a CRM for a plumber?',
      found: 'scroll',
      checkState: 'good',
      seenAt: new Date(),
    })
    .returning({ id: posts.id });
  postId = po!.id;
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

describe('drafts for Today', () => {
  it('gives a few to pick from, each once, without the words to avoid', async () => {
    const res = await draft(owner, { kind: 'opener', profileId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'opener',
      answer: null,
      drafts: [
        'Hi Dana, thanks for adding me! How’s business going?',
        'Hey Dana, good to connect. What keeps you busiest these days?',
      ],
      // The playbook's first style: none has been used yet.
      opener: {
        playbookId: expect.any(String),
        kind: 'style',
        text: PLAYBOOK_TEMPLATES.crm_demos.details.openerStyles[0],
      },
      simple: false,
    });
  });

  it('takes turns with the openers, and sends the business’s own as written', async () => {
    const [playbook] = await testDbs()
      .admin.db.select()
      .from(playbooks)
      .where(eq(playbooks.workspaceId, ws));
    const own = 'Hi {first name}! Do you run your own business?';
    await testDbs()
      .admin.db.update(playbooks)
      .set({ details: { ...playbook!.details, ownOpeners: [own] } })
      .where(eq(playbooks.id, playbook!.id));
    // Each style used once by this person, with others: their own opener is next.
    for (const [i, text] of PLAYBOOK_TEMPLATES.crm_demos.details.openerStyles.entries()) {
      const [other] = await testDbs()
        .admin.db.insert(profiles)
        .values({
          workspaceId: ws,
          platform: 'facebook',
          username: `someone.${i}`,
          url: `https://www.facebook.com/someone.${i}`,
          name: `Someone ${i}`,
        })
        .returning({ id: profiles.id });
      await testDbs().admin.db.insert(openerUses).values({
        workspaceId: ws,
        userId: owner.id,
        profileId: other!.id,
        playbookId: playbook!.id,
        kind: 'style',
        text,
        usedAt: new Date(),
      });
    }
    const res = await draft(owner, { kind: 'opener', profileId });
    expect(res.json()).toEqual({
      kind: 'opener',
      answer: null,
      drafts: ['Hi Dana! Do you run your own business?'],
      opener: { playbookId: playbook!.id, kind: 'own', text: own },
      simple: false,
    });
    // Someone else's turns are their own.
    expect((await draft(member, { kind: 'opener', profileId })).json().opener.kind).toBe('style');
  });

  it('keeps a first message close to the one the person wrote themselves in Your messages (decision 87)', async () => {
    const [playbook] = await testDbs()
      .admin.db.select()
      .from(playbooks)
      .where(eq(playbooks.workspaceId, ws));
    const said = {
      messageSamples: {
        playbookId: playbook!.id,
        playbookName: playbook!.name,
        first: ['Hi Sam! Open to more booked calls?', 'Hey, open to more booked calls this month?'],
        video: null,
        link: null,
        followUps: [],
        followUpGaps: [],
        checkIn: null,
        at: new Date().toISOString(),
        version: 1,
        mine: ['first.1'],
      },
      messageNotes: { first: ['Shorter.'] },
    };
    await testDbs()
      .admin.db.insert(setup)
      .values({ workspaceId: ws, userId: member.id, ...said })
      .onConflictDoUpdate({ target: [setup.workspaceId, setup.userId], set: said });
    const res = (await draft(member, { kind: 'opener', profileId })).json();
    expect(res.drafts).toEqual(['Hey, open to more booked calls this month? (for Dana)']);
    // The owner wrote none of theirs: their drafts are as before.
    expect((await draft(owner, { kind: 'comment', postId })).json().drafts).toHaveLength(2);
    await testDbs()
      .admin.db.update(setup)
      .set({ messageSamples: null, messageNotes: {} })
      .where(eq(setup.userId, member.id));
  });

  it('drafts two comments on a post, from what the look-up found too', async () => {
    const res = await draft(owner, {
      kind: 'comment',
      postId,
      lookup: ['Owner at Reyes Plumbing', 'Their business page: Reyes Plumbing'],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().drafts).toHaveLength(2);
    expect((await draft(owner, { kind: 'comment' })).statusCode).toBe(404);
    expect((await draft(member, { kind: 'comment', postId })).statusCode).toBe(404);
  });

  it('drafts from the person’s own chats only', async () => {
    expect((await draft(owner, { kind: 'reply', chatId })).statusCode).toBe(200);
    expect((await draft(member, { kind: 'reply', chatId })).statusCode).toBe(404);
  });

  it('says whether a reply is simple, never for someone who needs the person', async () => {
    const said = async (text: string) => {
      await testDbs()
        .admin.db.update(fileChats)
        .set({ recent: [{ fromMe: false, text, at: new Date().toISOString() }] })
        .where(eq(fileChats.id, chatId));
      return (await draft(owner, { kind: 'reply', chatId })).json().simple;
    };
    expect(await said('How much is it?')).toBe(false);
    expect(await said('Thanks, sounds great.')).toBe(true);
    // The AI found it simple, but it's about a refund: it comes to the person.
    expect(await said('Thanks. I want my money back.')).toBe(false);
  });

  it('reads a yes to the first message, keeps it, and drafts the next step instead', async () => {
    // Dana got the first message; this is her chat, and she wrote back.
    await testDbs()
      .admin.db.update(fileChats)
      .set({
        profileId,
        recent: [
          {
            fromMe: true,
            text: 'Open to more booked calls?',
            at: new Date(Date.now() - 60_000).toISOString(),
          },
          { fromMe: false, text: 'Sure, send it over', at: new Date().toISOString() },
        ],
      })
      .where(eq(fileChats.id, chatId));
    await testDbs()
      .admin.db.insert(followUps)
      .values({
        workspaceId: ws,
        userId: owner.id,
        profileId,
        step: 'first',
        stepAt: new Date(Date.now() - 120_000),
        lastAt: new Date(Date.now() - 120_000),
        next: 'follow_up',
        dueAt: new Date(Date.now() + 86_400_000),
      });
    const res = (await draft(owner, { kind: 'reply', chatId })).json();
    // No video yet: the link is next.
    expect(res).toMatchObject({ kind: 'pitch', answer: 'yes', simple: false });
    expect(res.drafts[0]).toMatch(/link to book a quick call/);
    const [kept] = await testDbs()
      .admin.db.select()
      .from(followUps)
      .where(eq(followUps.profileId, profileId));
    expect(kept).toMatchObject({ answer: 'yes', next: null, dueAt: null });

    // With a video, a yes to the first message gets the video, with its link on the end.
    const [playbook] = await testDbs()
      .admin.db.select()
      .from(playbooks)
      .where(eq(playbooks.workspaceId, ws));
    await testDbs()
      .admin.db.update(playbooks)
      .set({ details: { ...playbook!.details, videoLink: 'https://www.loom.com/share/abc123' } })
      .where(eq(playbooks.id, playbook!.id));
    await testDbs()
      .admin.db.update(followUps)
      .set({ answer: null, answeredAt: null })
      .where(eq(followUps.profileId, profileId));
    const video = (await draft(owner, { kind: 'reply', chatId })).json();
    expect(video).toMatchObject({ kind: 'video', answer: 'yes' });
    expect(video.drafts[0]).toMatch(/short video[\s\S]*https:\/\/www\.loom\.com\/share\/abc123$/);
  });

  it('answers a client’s yes as a reply, with no link or video (decision 91)', async () => {
    // Dana is in Contacts now, tagged Client: the same yes, kept, gets a reply.
    const db = testDbs().admin.db;
    const [person] = await db
      .insert(people)
      .values({ workspaceId: ws, firstName: 'Dana', lastName: 'Reyes' })
      .returning({ id: people.id });
    await db.update(profiles).set({ personId: person!.id }).where(eq(profiles.id, profileId));
    const [tag] = await db
      .insert(tags)
      .values({ workspaceId: ws, name: 'Client' })
      .returning({ id: tags.id });
    await db
      .insert(recordTags)
      .values({ workspaceId: ws, tagId: tag!.id, recordType: 'person', recordId: person!.id });
    await db
      .update(followUps)
      .set({ answer: null, answeredAt: null })
      .where(eq(followUps.profileId, profileId));
    const res = (await draft(owner, { kind: 'reply', chatId })).json();
    expect(res).toMatchObject({ kind: 'reply', answer: 'yes' });
    for (const d of res.drafts as string[]) {
      expect(d).not.toContain('loom.com');
      expect(d).not.toMatch(/link to book/);
    }
  });
});

describe('a first message on Instagram', () => {
  it('to someone who hasn’t followed back goes to their Requests: one short text with no link', async () => {
    const [ig] = await testDbs()
      .admin.db.insert(profiles)
      .values({
        workspaceId: ws,
        platform: 'instagram',
        username: 'sam.lee',
        url: 'https://www.instagram.com/sam.lee/',
        name: 'Sam Lee',
      })
      .returning({ id: profiles.id });
    // The member followed Sam 4 days ago, and Sam hasn't followed back.
    const at = new Date(Date.now() - 4 * 86_400_000);
    await testDbs().admin.db.insert(friends).values({
      workspaceId: ws,
      userId: member.id,
      profileId: ig!.id,
      state: 'request_sent',
      since: at,
      seenAt: at,
    });
    const res = await draft(member, { kind: 'opener', profileId: ig!.id });
    expect(res.statusCode).toBe(200);
    // The one with a link is dropped, and one written as two texts goes as one.
    expect(res.json().drafts).toEqual([
      'Hi Sam, I help local owners get more booked calls. Open to hearing how?',
      'Hi Sam!\nOpen to more booked calls?',
    ]);
    // Once Sam follows back, the first message is written as on any network.
    await testDbs()
      .admin.db.update(friends)
      .set({ state: 'friends' })
      .where(eq(friends.profileId, ig!.id));
    expect((await draft(member, { kind: 'opener', profileId: ig!.id })).json().drafts).toEqual([
      'Hi Sam, thanks for adding me! How’s business going?',
      'Hey Sam, good to connect. What keeps you busiest these days?',
    ]);
  });
});

describe('after a demo (decision 106)', () => {
  it('offers another time with the link to book again, and reminds them without it', async () => {
    const db = testDbs().admin.db;
    await db
      .update(playbooks)
      .set({
        details: {
          ...PLAYBOOK_TEMPLATES.crm_demos.details,
          avoid: ['free trial'],
          link: 'https://example.com/book',
        },
      })
      .where(eq(playbooks.workspaceId, ws));
    const [quinn] = await db
      .insert(profiles)
      .values({
        workspaceId: ws,
        platform: 'facebook',
        username: 'quinn.harper.7',
        url: 'https://www.facebook.com/quinn.harper.7',
        name: 'Quinn Harper',
        intro: ['Owner at Harper Roofing'],
      })
      .returning({ id: profiles.id });
    const rebook = await draft(owner, { kind: 'rebook', profileId: quinn!.id });
    expect(rebook.statusCode).toBe(200);
    const made = rebook.json() as { kind: string; drafts: string[] };
    expect(made.kind).toBe('rebook');
    expect(made.drafts.length).toBeGreaterThan(0);
    for (const d of made.drafts) expect(d).toContain('https://example.com/book');
    const reminder = (
      await draft(owner, { kind: 'demo_reminder', profileId: quinn!.id })
    ).json() as { kind: string; drafts: string[] };
    expect(reminder.kind).toBe('demo_reminder');
    for (const d of reminder.drafts) expect(d).not.toContain('https://example.com/book');
  });
});

describe('birthday and new-job notes (decision 108)', () => {
  it('writes a short note with nothing about the business and no link, the new job in the page’s words', async () => {
    const db = testDbs().admin.db;
    const [avery] = await db
      .insert(profiles)
      .values({
        workspaceId: ws,
        platform: 'linkedin',
        username: 'avery-brooks-12',
        url: 'https://www.linkedin.com/in/avery-brooks-12/',
        name: 'Avery Brooks',
        intro: ['Owner at Brooks Roofing'],
      })
      .returning({ id: profiles.id });
    await db.insert(occasions).values({
      workspaceId: ws,
      userId: member.id,
      profileId: avery!.id,
      kind: 'new_job',
      onDay: '2026-10-27',
      detail: 'Started a new position as Owner at Brooks Roofing',
      seenAt: new Date('2026-10-27T15:00:00Z'),
    });
    const job = (await draft(member, { kind: 'new_job', profileId: avery!.id })).json() as {
      kind: string;
      drafts: string[];
    };
    expect(job.kind).toBe('new_job');
    expect(job.drafts).toEqual([
      'Congratulations, Avery! Saw this: Started a new position as Owner at Brooks Roofing.',
    ]);
    // The playbook's link never goes on a note, and a draft with one is dropped.
    const birthday = (await draft(member, { kind: 'birthday', profileId: avery!.id })).json() as {
      drafts: string[];
    };
    expect(birthday.drafts).toEqual(['Happy birthday, Avery! Hope it’s a great one.']);
  });
});
