/**
 * Social Outreach: a playbook's Test console (`outreach.playbook.test`; docs/outreach.md, decision 164), through the
 * worker's actions route against the stand-in model. Each move writes the message that would go to someone made up,
 * with the same writer as Today's drafts: the first message from the playbook's own words, the next follow-up when
 * they go quiet, a reply that reads their answer, and the ask for a time after a yes. The AI can play them. Nothing is
 * sent, counted or kept.
 */
import { createTokenVerifier } from '@hfos/core/server';
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
import { outreachBusiness } from '../../../packages/core/test/addons/outreach-fixture';
import {
  TEST_POSTS,
  TEST_READ,
  TEST_START,
  TEST_WORDS,
  type PlaybookTestOutput,
} from '../../../packages/core/src/addons/outreach/playbook-test';
import {
  CRM_FIRST_MESSAGE,
  PLAYBOOK_TEMPLATES,
} from '../../../packages/core/src/addons/outreach/playbooks';
import { playbooks } from '../../../packages/core/src/addons/outreach/tables';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: string;
let playbookId: string;

const crm = PLAYBOOK_TEMPLATES.crm_demos;
const SAYS =
  'if I could get you more deals while also saving you time for your business using my easy to use CRM software, would you be interested?';
const sam = { name: 'Sam Rivera', business: 'Owns a roofing company in Tulsa' };

const ask = async (u: TestUser, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/addons/outreach/actions/outreach.playbook.test',
    headers: { authorization: `Bearer ${await signInTestUser(u)}` },
    payload: { workspaceId: ws, input },
  });
const move = async (input: Record<string, unknown>): Promise<PlaybookTestOutput> => {
  const res = await ask(owner, { playbookId, person: sam, ...input });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
/** Everything the add-on keeps of a real conversation: a test leaves none of it. */
const kept = async () => {
  const [n] = await rows<{ n: number }>(
    testDbs().admin.db,
    sql`select (select count(*) from addon_outreach.opener_uses where workspace_id = ${ws})
             + (select count(*) from addon_outreach.follow_ups where workspace_id = ${ws})
             + (select count(*) from addon_outreach.sends where workspace_id = ${ws})
             + (select count(*) from addon_outreach.profiles where workspace_id = ${ws})
             + (select count(*) from addon_outreach.file_chats where workspace_id = ${ws}) as n`,
  );
  return Number(n!.n);
};

beforeAll(async () => {
  const s = testServices({ ai: { provider: scriptedAi() } });
  [owner, member, outsider] = await Promise.all([
    createTestUser('outreach-ptest-owner'),
    createTestUser('outreach-ptest-member'),
    createTestUser('outreach-ptest-outsider'),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Playbook Test Co');
  await testDbs()
    .admin.db.insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  const [p] = await testDbs()
    .admin.db.insert(playbooks)
    .values({
      workspaceId: ws,
      name: crm.name,
      details: { ...crm.details, avoid: ['free trial'] },
    })
    .returning({ id: playbooks.id });
  playbookId = p!.id;
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

describe('a playbook’s Test console', () => {
  it('starts with the playbook’s own first message, fitted to the made-up person', async () => {
    const out = await move({ move: 'start' });
    expect(out).toEqual({
      theirs: null,
      answer: null,
      read: null,
      kind: 'opener',
      label: 'First message',
      // The playbook's words with the blanks filled; the repeat and the one with a word to avoid are dropped.
      message: `Hey Sam, ${SAYS}`,
      others: [`Hi Sam, ${SAYS}`],
      note: 'It goes 1 day after they accept, as Steps and pace says.',
      next: 'If they stay quiet, follow-up 1 of 6 goes 1 day later.',
      unanswered: null,
      state: { step: 'first', sent: 0, answer: null, stopped: false },
      about: null,
      aboutYou: false,
    });
    // A member tests it too: it reads, and changes nothing.
    expect((await ask(member, { playbookId, person: sam, move: 'start' })).statusCode).toBe(200);
  });

  it('tests a playbook as it is on screen, before it’s saved, and each version of its first message', async () => {
    const second = 'Hey [first name], who does your follow-ups today?';
    const details = { ...crm.details, script: { first: [CRM_FIRST_MESSAGE, second] } };
    const one = await move({ playbookId: null, name: 'Not saved yet', details, move: 'start' });
    expect(one.label).toBe('First message, version 1 of 2');
    expect(one.message).toBe(`Hey Sam, ${SAYS}`);
    const two = await move({
      playbookId: null,
      name: 'Not saved yet',
      details,
      move: 'start',
      version: 1,
    });
    expect(two.label).toBe('First message, version 2 of 2');
    expect(two.message).toBe('Hey Sam, who does your follow-ups today?');
    // Someone talked with a while ago gets Reconnect, never the first message.
    const old = await move({ person: { ...sam, known: 'old' }, move: 'start' });
    expect(old).toMatchObject({ kind: 'reconnect', label: 'Reconnect' });
    expect(old.message).toBeTruthy();
    // Threads only comments for now: no message goes, and it says what to do.
    const threads = await move({ person: { ...sam, platform: 'threads' }, move: 'start' });
    expect(threads).toMatchObject({ kind: null, message: null, state: TEST_START });
    expect(threads.note).toMatch(/On Threads it only comments on posts for now/);
  });

  it('follows up when they go quiet, reads their reply, and asks for a time after a yes', async () => {
    const first = await move({ move: 'start' });
    const chat = [{ fromMe: true, text: first.message! }];
    // They go quiet: the first follow-up, a day later.
    const quiet = await move({ move: 'quiet', chat, state: first.state });
    expect(quiet).toMatchObject({
      theirs: null,
      kind: 'follow_up',
      label: 'Follow-up 1 of 6',
      state: { step: 'first', sent: 1 },
      next: 'If they stay quiet, follow-up 2 of 6 goes 1 day later.',
    });
    expect(quiet.message).toBeTruthy();
    chat.push({ fromMe: true, text: quiet.message! });

    // They say yes: read as a yes, and the message is the ask for a time.
    const yes = await move({
      move: 'reply',
      text: 'Yes, I’d be interested',
      chat,
      state: quiet.state,
    });
    expect(yes).toMatchObject({
      theirs: 'Yes, I’d be interested',
      answer: 'yes',
      read: TEST_READ.yes,
      kind: 'pitch',
      label: 'They said yes: your ask for a time',
      state: { step: 'link', sent: 0, answer: null, stopped: false },
    });
    expect(yes.message).toBe('Here’s my link to book a quick call, Sam.');

    // They say no instead: a kind word, and nothing more goes.
    const no = await move({
      move: 'reply',
      text: 'No thanks, I’m not interested',
      chat,
      state: quiet.state,
    });
    expect(no).toMatchObject({
      answer: 'no',
      read: TEST_READ.no,
      kind: 'reply',
      label: 'Your reply',
      state: { answer: 'no', stopped: true },
      next: 'They said no, so nothing more goes to them unless they write.',
    });
    const after = await move({
      move: 'quiet',
      chat: [...chat, { fromMe: false, text: no.theirs! }, { fromMe: true, text: no.message! }],
      state: no.state,
    });
    expect(after).toMatchObject({
      kind: null,
      message: null,
      note: 'They said no, so nothing more goes to them unless they write.',
    });
  });

  it('has the AI play them as the kind of person picked, then answers what they wrote', async () => {
    const first = await move({ move: 'start' });
    const chat = [{ fromMe: true, text: first.message! }];
    const played = await move({ move: 'play', persona: 'busy', chat, state: first.state });
    expect(played).toMatchObject({
      theirs: 'Not right now, maybe later.',
      answer: 'later',
      read: TEST_READ.later,
      kind: 'reply',
      // Not now: no follow-ups, only the monthly check-in.
      state: { answer: 'later', sent: 6, stopped: false },
      next: 'If they stay quiet, a check-in goes in 30 days, then once a month.',
    });
    const keen = await move({ move: 'play', persona: 'interested', chat, state: first.state });
    expect(keen).toMatchObject({ theirs: 'Sure, sounds good.', answer: 'yes', kind: 'pitch' });
    // Nothing of yours for them to answer yet: it says what to press.
    const early = await ask(owner, { playbookId, person: sam, move: 'play' });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({
      rule: 'outreach_playbook_test_not_started',
      message:
        'There’s no message of yours for them to answer yet. Press See the first message, then let the AI play them.',
    });
  });

  it('tries a comment on what a post says, checked as a real one, with About you as it’s saved (decision 165)', async () => {
    const post = (key: (typeof TEST_POSTS)[number]['key']) =>
      TEST_POSTS.find((p) => p.key === key)!.text;
    // A win: the comment that names it stays, and the one in a brochure's words is dropped.
    const win = await move({ move: 'comment', post: post('win'), comment: 'warm' });
    expect(win).toMatchObject({
      theirs: null,
      kind: 'comment',
      label: 'Warm-up comment',
      message: 'Congrats on this, Sam, big step!',
      others: [],
      note: null,
      next: TEST_WORDS.comment.next,
      // The post's own words it is about, as the AI pointed at them.
      about: 'Just got the keys',
      aboutYou: false,
      // The chat stays where it was.
      state: TEST_START,
    });
    // Someone on their own heritage: with nothing said in About you, the comment that makes the owner one of them is
    // dropped, and the playful one stays.
    const notMine = await move({ move: 'comment', post: post('heritage'), comment: 'warm' });
    expect(notMine).toMatchObject({
      message: 'Day five and nothing, Sam?',
      others: [],
      about: 'Day 5 of Hispanic',
      aboutYou: false,
    });
    // Once the person says so of themselves in About you, speaking as one of them stays.
    await testDbs().admin.db.execute(
      sql`insert into app.user_about (user_id, about) values (${owner.id}, 'I’m Mexican-American, from San Antonio.')`,
    );
    const mine = await move({ move: 'comment', post: post('heritage'), comment: 'warm' });
    expect(mine.aboutYou).toBe(true);
    expect([mine.message, ...mine.others]).toEqual([
      'Still waiting on mine too, same',
      'Day five and nothing, Sam?',
    ]);
    // A teammate's About you is their own: the member's test knows nothing of the owner's.
    const theirs = await ask(member, {
      playbookId,
      person: sam,
      move: 'comment',
      post: post('heritage'),
    });
    expect(theirs.json()).toMatchObject({
      message: 'Day five and nothing, Sam?',
      others: [],
      aboutYou: false,
    });
    await testDbs().admin.db.execute(sql`delete from app.user_about where user_id = ${owner.id}`);
    // A caption that leans on its video: nothing real to say, so no comment, and it says so.
    const video = await move({ move: 'comment', post: post('video'), comment: 'warm' });
    expect(video).toMatchObject({
      kind: null,
      label: null,
      message: null,
      others: [],
      note: TEST_WORDS.comment.none,
      about: null,
    });
    // An expert comment speaks from the owner's field, so it needn't point at the post's words.
    const expert = await move({ move: 'comment', post: post('asking'), comment: 'expert' });
    expect(expert).toMatchObject({ kind: 'comment', label: 'Expert comment' });
    expect(expert.message).toBeTruthy();
    // With no post there's nothing to comment on.
    const none = await ask(owner, { playbookId, person: sam, move: 'comment' });
    expect(none.statusCode).toBe(400);
    expect(none.body).toContain('Paste what the post says, or pick one of the examples.');
    expect(await kept()).toBe(0);
  });

  it('refuses what it can’t test, saying what to do, and keeps nothing of a test', async () => {
    const gone = await ask(owner, {
      playbookId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      person: sam,
      move: 'start',
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.message).toBe(
      'That playbook isn’t there anymore. Open Social Outreach → Playbooks and pick one to test.',
    );
    const unfinished = await ask(owner, {
      playbookId: null,
      details: { ...crm.details, script: { first: ['One', 'Two', 'Three', 'Four'] } },
      person: sam,
      move: 'start',
    });
    expect(unfinished.statusCode).toBe(422);
    expect(unfinished.json().error).toMatchObject({ rule: 'outreach_playbook_test_unfinished' });
    expect(unfinished.json().error.message).toMatch(
      /^This playbook isn’t ready to test yet: Up to 3 first messages\. Fix it in the playbook/,
    );
    const noReply = await ask(owner, { playbookId, person: sam, move: 'reply' });
    expect(noReply.statusCode).toBe(400);
    expect(noReply.body).toContain('Type what they write back, or tap one of the quick replies.');
    // Someone outside the business tests nothing of it.
    expect(
      (await ask(outsider, { playbookId, person: sam, move: 'start' })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    // No opener counted, no conversation, no message queued, nobody saved.
    expect(await kept()).toBe(0);
  });
});
