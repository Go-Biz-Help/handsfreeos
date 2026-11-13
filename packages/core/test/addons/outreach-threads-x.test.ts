/**
 * Social Outreach on Threads and X (docs/outreach.md decision 163): follow networks whose main work is an hourly search
 * for posts on the business's topic and a comment on the good ones, with the good fits warmed up and followed, no
 * messages, a pitch only when a post asks for someone who offers what the business offers, and replies to the person's
 * comments kept to answer, each answer waiting for their OK.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_DEFAULTS,
  NETWORK_CHOICES_DEFAULTS,
  NETWORKS_DEFAULTS,
} from '../../src/addons/outreach/automation';
import {
  demoYesPushWords,
  REPLY_PLATFORMS,
  REPLY_WHY,
  saysYesToDemo,
} from '../../src/addons/outreach/comment-replies';
import {
  FOLLOW_PLATFORMS,
  MESSAGE_PLATFORMS,
  messagesOn,
  networkLimitsNow,
  networkOfLink,
  NETWORKS,
  THREADS_X_SINCE,
  withArticle,
} from '../../src/addons/outreach/networks';
import { blankPlaybook, FIND_WORDS_PER_DAY } from '../../src/addons/outreach/playbooks';
import { postSearchWords, searchTurn } from '../../src/addons/outreach/posts';
import { COMMENT_NEEDS_YOU } from '../../src/addons/outreach/sends';
import { fitsComment, todayDraftPrompt, type TodayItem } from '../../src/addons/outreach/today';
import { findWordsHint } from '../../src/addons/outreach/words';
import { computerOn, outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const TH = 'https://www.threads.com';
const X = 'https://x.com';
const HOUR = 3_600_000;

describe('Threads’ and X’s kits (decision 163)', () => {
  it('are follow networks with no messages, an hourly search, and the owner’s daily limits', () => {
    for (const p of ['threads', 'x'] as const) {
      expect(NETWORKS[p]).toMatchObject({
        stage: 'working',
        follows: true,
        messages: false,
        commentsWait: 'hold',
        postSearch: { everyMinutes: 60, perLook: 2, newestHours: 48 },
      });
      // 3b: 30 comments and 80 likes a day, and nothing written in their messages.
      expect(NETWORKS[p].dailyLimits).toMatchObject({
        comment: 30,
        like: 80,
        first_message: 0,
        follow_up: 0,
      });
      expect(messagesOn(p)).toBe(false);
      // Halved for a new account or after a warning, as everywhere; a step at 0 stays 0.
      expect(networkLimitsNow(p, true)).toMatchObject({ comment: 15, like: 40, first_message: 0 });
    }
    expect(FOLLOW_PLATFORMS).toEqual(['instagram', 'threads', 'x']);
    expect(MESSAGE_PLATFORMS).toEqual(['facebook', 'linkedin', 'instagram', 'alignable']);
    expect(REPLY_PLATFORMS).toEqual(['threads', 'x']);
    expect([NETWORKS.threads.commentCharsMost, NETWORKS.x.commentCharsMost]).toEqual([500, 280]);
    expect(THREADS_X_SINCE).toBe('0.137.0');
    expect(withArticle('X')).toBe('an X');
    expect(withArticle('Threads')).toBe('a Threads');
  });

  it('knows their links, old and new', () => {
    expect(networkOfLink(`${TH}/@sam.roofs`)).toBe('threads');
    expect(networkOfLink('https://www.threads.net/@sam.roofs/post/DQabc123')).toBe('threads');
    expect(networkOfLink(`${X}/samroofs/status/1857000000000000000`)).toBe('x');
    expect(networkOfLink('https://twitter.com/samroofs')).toBe('x');
    expect(networkOfLink('https://mobile.x.com/samroofs')).toBe('x');
  });

  it('keeps a comment within each network’s length', () => {
    expect(
      fitsComment('Missed calls are lost jobs. Text back every missed call in a minute.', 'x'),
    ).toBe(true);
    expect(fitsComment(`${'word '.repeat(40)}and more`, 'x')).toBe(false);
    const prompt = todayDraftPrompt({
      kind: 'comment',
      business: 'Bright Books',
      name: 'samroofs',
      facts: [],
      recent: [],
      playbook: null,
      post: { text: 'Anyone know a good CRM for a roofing crew?', group: null, asking: true },
      platform: 'x',
    });
    expect(prompt).toContain('so the comment ends with the short offer to show them');
  });
});

describe('the hourly search’s words (decision 163, 2a)', () => {
  const playbook = (over: Partial<ReturnType<typeof blankPlaybook>> = {}) => ({
    details: { ...blankPlaybook(), niche: 'Roofers', ...over },
  });

  it('takes 2 of the playbook’s own phrases each hour, in turn, and makes none up', () => {
    const own = playbook({
      threadsSearches: ['anyone use a CRM', 'missed calls', 'losing leads'],
      wordsWritten: ['threads'],
    });
    const turn = searchTurn('threads', 10 * HOUR)!;
    expect(turn).toBe(10);
    expect(searchTurn('threads', 11 * HOUR)).toBe(11);
    expect(searchTurn('facebook', 10 * HOUR)).toBeNull();
    expect(postSearchWords([own], 'threads', 0)).toEqual(['anyone use a CRM', 'missed calls']);
    expect(postSearchWords([own], 'threads', 1)).toEqual(['losing leads', 'anyone use a CRM']);
    // Before the AI wrote them, nothing is searched: never words made up from the signs (decision 141).
    expect(postSearchWords([playbook({ signs: ['“Owner” in their bio'] })], 'x', 0)).toEqual([]);
    expect(FIND_WORDS_PER_DAY.threads).toBe(12);
    expect(
      findWordsHint({ threadsSearches: ['missed calls'], wordsWritten: ['threads'] }, 'threads'),
    ).toContain('it searches with 2 every hour');
  });
});

describe('a yes to a demo under the person’s comment (decision 163, 8a)', () => {
  const OFFER = 'Missed calls are lost jobs. I can show you a demo if you’re interested.';

  it('is a yes that isn’t a no, to a comment that offered one', () => {
    expect(saysYesToDemo('Yes please!', OFFER)).toBe(true);
    expect(saysYesToDemo('Sure, sounds good', OFFER)).toBe(true);
    expect(saysYesToDemo('I’d love to see it', OFFER)).toBe(true);
    expect(saysYesToDemo('No thanks, we’re good', OFFER)).toBe(false);
    expect(saysYesToDemo('Not interested', OFFER)).toBe(false);
    expect(saysYesToDemo('Great point about callbacks', OFFER)).toBe(false);
    // A comment that offered nothing: only a reply that asks for a demo itself.
    expect(saysYesToDemo('Yes, so true', 'Text back every missed call.')).toBe(false);
    expect(saysYesToDemo('Yes, can I get a demo?', 'Text back every missed call.')).toBe(true);
    expect(demoYesPushWords('samroofs', 'x')).toEqual({
      title: 'samroofs said yes to a demo',
      body: 'They answered your comment on X. An answer waits for your OK on Needs you.',
    });
  });
});

describe('replies to the person’s comments, in a business (decision 163, 8a)', () => {
  let owner: TestUser;
  let ws: string;
  const account = (username: string) => ({ id: null, username, url: `${TH}/@${username}` });
  const POST = `${TH}/@sam.roofs/post/DQpost0001`;
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles
            where workspace_id = ${ws} and platform = 'threads' and username = ${username}`,
      )
    )[0]!.id;
  const save = (replies: Record<string, unknown>[]) =>
    runAs(owner, ws, 'outreach.comment_replies.save', { platform: 'threads', replies });

  beforeAll(async () => {
    owner = await createTestUser('outtx-replies', { fullName: 'Robin Owner' });
    ws = await outreachBusiness(owner, 'Outreach Threads Replies Co');
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: { ...blankPlaybook(), niche: 'Roofers', platforms: ['threads'] },
    });
    await computerOn(owner, ws, THREADS_X_SINCE);
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...NETWORKS_DEFAULTS,
          threads: { ...NETWORK_CHOICES_DEFAULTS, on: true, sending: 'everything' },
        },
      },
    });
    // A good post the person commented on, offering a demo.
    await runAs(owner, ws, 'outreach.posts.save', {
      platform: 'threads',
      found: 'search',
      words: 'anyone use a CRM',
      posts: [
        {
          url: POST,
          author: account('sam.roofs'),
          name: 'sam.roofs',
          text: 'Anyone use a CRM for a small roofing crew? Calls keep slipping.',
        },
      ],
    });
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, post_url, comment_text, at)
          values (${ws}, ${await profileOf('sam.roofs')}, ${owner.id}, 'comment', ${POST},
            'Calls slip when nobody owns the callback. I can show you a demo if you’re interested.', now() - interval '2 hours')`,
    );
  }, 60_000);
  afterAll(closeTestDbs);

  it('keeps a reply from someone they commented to, or shown answering their comment, and pushes a yes', async () => {
    const out = await save([
      {
        url: `${TH}/@sam.roofs/post/DQreply0001`,
        author: account('sam.roofs'),
        name: 'sam.roofs',
        text: 'Yes please, how does it work?',
      },
      // Someone they never commented to, not shown answering their comment: left alone.
      {
        url: `${TH}/@lee.gutters/post/DQreply0002`,
        author: account('lee.gutters'),
        name: 'lee.gutters',
        text: 'Interesting take',
      },
      // Shown answering their comment: kept.
      {
        url: `${TH}/@kim.siding/post/DQreply0003`,
        author: account('kim.siding'),
        name: 'kim.siding',
        text: 'We tried that and it didn’t stick. What would you do differently?',
        toComment: true,
      },
    ]);
    expect(out).toEqual({ kept: 2 });
    // Seen again: nothing new.
    expect(
      await save([
        {
          url: `${TH}/@sam.roofs/post/DQreply0001`,
          author: account('sam.roofs'),
          name: 'sam.roofs',
          text: 'Yes please, how does it work?',
        },
      ]),
    ).toEqual({ kept: 0 });
    const said = await rows<{ payload: { yes: boolean; platform: string } }>(
      admin(),
      sql`select payload from app.events where workspace_id = ${ws}
            and event_type = 'outreach.comment.replied' order by created_at`,
    );
    expect(said.map((e) => [e.payload.platform, e.payload.yes])).toEqual([
      ['threads', true],
      ['threads', false],
    ]);
  });

  it('lists the replies first on Today, and holds each answer for an OK, Autopilot’s too', async () => {
    const list = await runAs(owner, ws, 'outreach.today', { platform: 'threads' });
    const comments = (list.items as TodayItem[]).filter((i) => i.kind === 'comment');
    expect(comments.slice(0, 2).map((i) => [i.name, i.why[0]])).toEqual([
      ['kim.siding', REPLY_WHY],
      ['sam.roofs', REPLY_WHY],
    ]);
    expect(list.messages).not.toContain('first_message');
    const reply = comments.find((i) => i.name === 'sam.roofs' && i.why[0] === REPLY_WHY)!;
    const queued = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: reply.profileId,
      kind: 'comment',
      text: 'Happy to. It texts back every missed call within a minute. Want a quick look this week?',
      postId: reply.postId,
    });
    expect(queued.state).toBe('waiting');
    const [held] = await rows<{ needs_you: string | null }>(
      admin(),
      sql`select needs_you from addon_outreach.sends where workspace_id = ${ws} and post_id = ${reply.postId}`,
    );
    expect(held!.needs_you).toBe(COMMENT_NEEDS_YOU.reply);
  });

  it('refuses replies on a network that doesn’t read them', async () => {
    await expect(
      runAs(owner, ws, 'outreach.comment_replies.save', {
        platform: 'instagram',
        replies: [
          {
            url: 'https://www.instagram.com/p/DQx/',
            author: {
              id: null,
              username: 'sam.roofs',
              url: 'https://www.instagram.com/sam.roofs/',
            },
            name: 'sam.roofs',
            text: 'Yes',
          },
        ],
      }),
    ).rejects.toThrow(/fields need attention/);
  });
});
