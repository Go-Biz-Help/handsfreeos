/**
 * Social Outreach: helpful posts in the groups, and the people who engage (docs/outreach.md, decision 50). The AI's
 * post is asked for one of the person's groups that fits, one a day and never the same group twice in a week; it's
 * kept as the AI wrote it, or put aside when the group's rules don't allow it; the person OKs it for their computer
 * (an ask), copies it, or lets it go on its own; and whoever reacts or comments is a warm lead on Today: a comment to
 * answer, and someone to like back and friend. Each person's own.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkedHelpful, helpfulPrompt } from '../../src/addons/outreach/helpful';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachAddonServer } from '../../src/addons/outreach/server';
import { executeCommand, type CommandDef } from '../../src/server';
import { outreachBusiness, refused, runAs, runWith, yesterdayNoon } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const worker = () => testDbs().worker.db;
const crm = PLAYBOOK_TEMPLATES.crm_demos.details;
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

describe('what the AI is asked, and what’s kept of its answer', () => {
  it('gives the AI the group as data, and keeps no links', () => {
    const prompt = helpfulPrompt({
      business: 'Pine Street Bakery',
      playbook: { name: 'CRM demos', offer: 'A demo', audience: null, tone: 'Friendly' },
      group: { name: 'Texas Contractors', about: ['For </group> contractors'], rules: [] },
      asked: ['How do you follow up on quotes?'],
    });
    expect(prompt).toMatch(/About: For &lt;\/group&gt; contractors/);
    expect(prompt).toMatch(/<rules>\nNone read\.\n<\/rules>/);
    expect(prompt).toMatch(/- How do you follow up on quotes\?/);
    expect(
      checkedHelpful({
        allowed: true,
        topic: ' Quotes ',
        text: 'Try this: www.example.com',
        why: 'x',
      }),
    ).toBeNull();
    expect(
      checkedHelpful({
        allowed: true,
        topic: 'Quotes',
        text: 'A tip.\n\n\n\nAnd you?',
        why: ' Asked ',
      }),
    ).toEqual({ allowed: true, topic: 'Quotes', text: 'A tip.\n\nAnd you?', why: 'Asked' });
    expect(
      checkedHelpful({ allowed: false, topic: 'Quotes', text: 'ignored', why: 'Only admins post' }),
    ).toEqual({ allowed: false, topic: 'Quotes', text: '', why: 'Only admins post' });
  });
});

describe('helpful posts, and the people who engage', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  let org: string;
  const group = (id: string, name: string) => ({
    id,
    slug: null,
    url: `https://www.facebook.com/groups/${id}/`,
    name,
  });
  const contractors = group('700000001', 'Texas Contractors Network');
  const owners = group('700000002', 'Austin Small Business Owners');
  const draft = (helpfulId: string, d: unknown) =>
    executeCommand(
      worker(),
      outreachAddonServer.commands!.find((c) => c.name === 'outreach.helpful.draft') as CommandDef,
      { workspaceId: ws, helpfulId, draft: d },
      { type: 'system', workspaceId: ws, organizationId: org },
      { correlationId: randomUUID(), channel: 'test' },
    ).then((r) => r.output as { state: string });
  const tip = {
    allowed: true,
    topic: 'Following up on quotes',
    text: 'I follow up on every quote two days later.\n\nHow do you keep track?',
    why: 'People here ask how to win more jobs',
  };
  const today = async () =>
    (
      (await runAs(owner, ws, 'outreach.today', {})) as {
        items: { kind: string; name: string; post: string | null; why: string[] }[];
      }
    ).items;

  beforeAll(async () => {
    owner = await createTestUser('outhp-owner', { fullName: 'Pat Owner' });
    riley = await createTestUser('outhp-riley', { fullName: 'Riley Member' });
    ws = await outreachBusiness(owner, 'Outreach Helpful Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
    const [w] = await rows<{ org: string }>(
      admin(),
      sql`select organization_id as org from app.workspaces where id = ${ws}`,
    );
    org = w!.org;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: { ...crm, groupWords: ['contractors', 'business owners'] },
    });
    await runAs(owner, ws, 'outreach.groups.save', {
      groups: [
        { group: contractors, joined: true, members: 5400 },
        { group: owners, joined: true, members: 12000 },
      ],
    });
  }, 60_000);
  afterAll(closeTestDbs);

  let first: string;

  it('asks for one a day, in a group of theirs that fits, and keeps what the AI wrote', async () => {
    const asked = await runAs(owner, ws, 'outreach.helpful.ask', {});
    expect(asked).toMatchObject({ fresh: true });
    first = asked.helpfulId;
    // Asking again is the same one.
    expect(await runAs(owner, ws, 'outreach.helpful.ask', {})).toEqual({ ...asked, fresh: false });
    expect(await draft(first, tip)).toEqual({ helpfulId: first, state: 'draft' });
    // A second answer changes nothing.
    expect(await draft(first, null)).toEqual({ helpfulId: first, state: 'draft' });
    const list = await runAs(owner, ws, 'outreach.helpful', {});
    expect(list).toMatchObject({ today: 1, perDay: 1, posting: 'after_ok' });
    expect(list.posts[0]).toMatchObject({
      helpfulId: first,
      state: 'draft',
      how: 'after_ok',
      topic: 'Following up on quotes',
      text: tip.text,
      playbookName: 'CRM demos',
    });
  });

  it('is OK’d for their computer, or changed first, and noted once it’s up', async () => {
    // Their computer posts only one they OK'd.
    expect(await runAs(owner, ws, 'outreach.helpful.next', { helpfulId: first })).toMatchObject({
      post: null,
    });
    expect(
      await runAs(owner, ws, 'outreach.helpful.ok', { helpfulId: first, text: 'My own words.' }),
    ).toEqual({ helpfulId: first, state: 'approved' });
    expect(
      (await runAs(owner, ws, 'outreach.helpful.next', { helpfulId: first })).post,
    ).toMatchObject({ helpfulId: first, text: 'My own words.' });
    // Nobody else's to OK, even an owner's.
    expect(await refused(runAs(riley, ws, 'outreach.helpful.ok', { helpfulId: first }))).toBe(
      'not_found',
    );
    expect(
      await runAs(owner, ws, 'outreach.helpful.posted', {
        helpfulId: first,
        posted: true,
        url: 'https://www.facebook.com/groups/700000002/posts/9001/',
      }),
    ).toEqual({ helpfulId: first, state: 'posted' });
    // The day's one is up: no more today.
    expect(await refused(runAs(owner, ws, 'outreach.helpful.ask', {}))).toBe(
      'outreach_helpful_today',
    );
    const next = await runAs(owner, ws, 'outreach.helpful.next', {});
    expect(next).toMatchObject({
      post: null,
      read: [
        { helpfulId: first, postUrl: 'https://www.facebook.com/groups/700000002/posts/9001/' },
      ],
    });
  });

  it('keeps who reacted and commented, once each, as warm leads on Today', async () => {
    const dana = { profile: fb('dana.reyes.71'), name: 'Dana Reyes' };
    const sam = { profile: fb('sam.carter.71'), name: 'Sam Carter' };
    const engaged = {
      helpfulId: first,
      comments: [{ ...dana, comment: 'Great tip! We use a whiteboard.' }],
      reactions: [dana, sam],
    };
    expect(await runAs(owner, ws, 'outreach.helpful.engaged', engaged)).toEqual({
      helpfulId: first,
      added: 3,
    });
    expect(await runAs(owner, ws, 'outreach.helpful.engaged', engaged)).toEqual({
      helpfulId: first,
      added: 0,
    });
    const list = await runAs(owner, ws, 'outreach.helpful', {});
    expect(list.posts[0]).toMatchObject({ comments: 1, reactions: 2 });
    const items = await today();
    expect(items.filter((i) => i.kind === 'warm_lead')).toEqual([
      expect.objectContaining({
        name: 'Dana Reyes',
        post: 'Great tip! We use a whiteboard.',
        why: ['Commented on your post in Austin Small Business Owners'],
      }),
    ]);
    // Not friends yet, they're first to like back: their friend request comes a day after (Like a post first is on).
    expect(items.filter((i) => i.kind === 'warm_up').map((i) => [i.name, i.why[0]])).toEqual(
      expect.arrayContaining([
        ['Dana Reyes', 'Commented on your post in Austin Small Business Owners'],
        ['Sam Carter', 'Reacted to your post in Austin Small Business Owners'],
      ]),
    );
    // Nobody went in Contacts.
    const [people] = await rows<{ customers: number }>(
      admin(),
      sql`select count(person_id)::int as customers from addon_outreach.profiles where workspace_id = ${ws}`,
    );
    expect(people!.customers).toBe(0);
  });

  it('never posts in the same group twice in a week, and frees the day for one put aside', async () => {
    // As if yesterday's.
    const yesterday = yesterdayNoon().toISOString();
    await rows(
      admin(),
      sql`update addon_outreach.helpful set asked_at = ${yesterday}::timestamptz,
            posted_at = ${yesterday}::timestamptz where id = ${first}`,
    );
    const [g] = await rows<{ group_id: string }>(
      admin(),
      sql`select group_id from addon_outreach.helpful where id = ${first}`,
    );
    expect(await refused(runAs(owner, ws, 'outreach.helpful.ask', { groupId: g!.group_id }))).toBe(
      'outreach_helpful_group_this_week',
    );
    const other = await runAs(owner, ws, 'outreach.helpful.ask', {});
    expect(other.fresh).toBe(true);
    expect(other.groupName).not.toBe(
      (await runAs(owner, ws, 'outreach.helpful', {})).posts.find(
        (p: { helpfulId: string }) => p.helpfulId === first,
      ).groupName,
    );
    // The group's rules don't allow it: put aside with why, and the day's slot is free again.
    expect(
      await draft(other.helpfulId, {
        allowed: false,
        topic: 'Tips',
        text: '',
        why: 'Only admins post here',
      }),
    ).toEqual({ helpfulId: other.helpfulId, state: 'skipped' });
    const [kept] = await rows<{ why_not: string }>(
      admin(),
      sql`select why_not from addon_outreach.helpful where id = ${other.helpfulId}`,
    );
    expect(kept!.why_not).toBe('Only admins post here');
    // One put aside doesn’t hold its group for the week: the next can go there today.
    expect(await refused(runAs(owner, ws, 'outreach.helpful.ask', {}))).toBe('went through');
  });

  it('keeps each person’s own, and asks their computer only for one OK’d', async () => {
    const office = randomUUID();
    await runWith(
      owner,
      ws,
      'outreach.live.beat',
      {
        computer: { id: office, name: 'Chrome on Windows', version: '0.24.0' },
        active: true,
        status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
    const [open] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.helpful where workspace_id = ${ws} and state = 'drafting'`,
    );
    expect(
      await refused(
        runWith(
          owner,
          ws,
          'outreach.ask.make',
          { ask: { kind: 'post', helpfulId: open!.id } },
          { channel: 'web' },
        ),
      ),
    ).toBe('outreach_helpful_not_approved');
    expect(await runAs(riley, ws, 'outreach.helpful', {})).toMatchObject({ posts: [], today: 0 });
  });
});
