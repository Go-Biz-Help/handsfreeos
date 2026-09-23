/**
 * Ideas, the roadmap and What's new (0100), through the command pipeline.
 *
 * The database's own tests (packages/db/test/ideas-rls.test.ts) prove who the policies let through. These prove
 * the board works as the people using it see it: sharing an idea votes for it and follows it, another business
 * sees a short name and nothing else, the roadmap is the team's to move and their note reaches the story, a
 * duplicate takes its votes with it, and What's new marks the ideas it delivers Done.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  ideaComment,
  ideaEdit,
  ideaFollow,
  ideaGet,
  ideaList,
  ideaMerge,
  ideaRoadmap,
  ideaSetCommentHidden,
  ideaSetHidden,
  ideaSetStatus,
  ideaShare,
  ideaSimilar,
  ideaTeamView,
  ideaTriage,
  ideaUnvote,
  ideaVote,
  organizationCreate,
  whatsNewList,
  whatsNewMarkSeen,
  whatsNewPublish,
  whatsNewSave,
  whatsNewUnseen,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

async function refusal(fn: () => Promise<unknown>): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    return e as HfosError;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

const beStaff = (u: TestUser, role: 'agent' | 'lead', displayName: string) =>
  admin().execute(
    sql`insert into platform.staff (user_id, role, display_name) values (${u.id}, ${role}, ${displayName})
        on conflict (user_id) do update set role = ${role}, status = 'active', display_name = ${displayName}`,
  );

/**
 * A word nothing else on a long-lived test database has in its title, nor anything like it: search matches
 * titles that look alike as well as the same words, so two marks must not share their letters' order.
 */
const mark = () => Array.from(randomBytes(10), (b) => String.fromCharCode(97 + (b % 26))).join('');

let dale: TestUser;
// A second person sharing, so no one person here shares more than the ten a day everybody gets.
let marco: TestUser;
let renee: TestUser;
let stranger: TestUser;
let lead: TestUser;
let agent: TestUser;
let daleWs: string;
let marcoWs: string;
let reneeWs: string;

beforeAll(async () => {
  [dale, marco, renee, stranger, lead, agent] = await Promise.all([
    createTestUser('ideas-dale', { fullName: 'Dale Ramsey' }),
    createTestUser('ideas-marco', { fullName: 'Marco Diaz' }),
    createTestUser('ideas-renee', { fullName: 'Renee Broussard' }),
    createTestUser('ideas-stranger', { fullName: 'Nobody Yet' }),
    createTestUser('ideas-lead', { fullName: 'Samantha Lead' }),
    createTestUser('ideas-agent', { fullName: 'Al Agent' }),
  ]);
  daleWs = (await run(organizationCreate, { businessName: 'Ideas HVAC' }, dale)).workspaceId;
  marcoWs = (await run(organizationCreate, { businessName: 'Ideas Roofing' }, marco)).workspaceId;
  reneeWs = (await run(organizationCreate, { businessName: 'Ideas Plumbing' }, renee)).workspaceId;
  await beStaff(lead, 'lead', 'Sam');
  await beStaff(agent, 'agent', '');
});
afterAll(closeTestDbs);

async function share(u: TestUser, ws: string, title: string, body = '', areaId = 'money') {
  return run(ideaShare, { workspaceId: ws, title, body, areaId }, u);
}

describe('who takes part', () => {
  it('somebody who never made a business can neither share nor read', async () => {
    const e = await refusal(() => run(ideaShare, { title: 'Let me in please' }, stranger));
    expect(e).toMatchObject({ code: 'forbidden', rule: 'ideas_closed' });
    await share(dale, daleWs, `Board check ${mark()}`);
    const board = await ask(ideaList, { status: 'all' }, stranger);
    expect(board.ideas).toEqual([]);
  });

  it('nobody shares from a business they do not work in', async () => {
    const e = await refusal(() => share(renee, daleWs, `Not my business ${mark()}`));
    expect(e.code).toBe('not_found');
  });
});

describe('sharing, voting and following', () => {
  it('sharing an idea votes for it and follows it; another business sees a short name only', async () => {
    const word = mark();
    const { ideaId, number } = await share(
      dale,
      daleWs,
      `Send invoices by WhatsApp ${word}`,
      'Half my customers never read email.',
    );
    expect(number).toBeGreaterThan(0);

    const mine = await ask(ideaGet, { ideaId }, dale);
    expect(mine.idea).toMatchObject({
      voteCount: 1,
      voted: true,
      following: true,
      canEdit: true,
      votingOpen: true,
      status: 'under_review',
      author: { name: 'Dale R.', you: true },
    });

    const theirs = await ask(ideaGet, { ideaId }, renee);
    expect(theirs.idea.author).toEqual({ name: 'Dale R.', you: false });
    expect(theirs.idea.voted).toBe(false);
    expect(theirs.idea.canEdit).toBe(false);
    // Nothing in what another business reads names Dale's business or his address.
    const said = JSON.stringify(theirs);
    expect(said).not.toContain('Ideas HVAC');
    expect(said).not.toContain(dale.email);
  });

  it('a vote counts once, and taking it back takes it off', async () => {
    const { ideaId } = await share(marco, marcoWs, `Bulk edit tags ${mark()}`);
    expect(await run(ideaVote, { ideaId, workspaceId: reneeWs }, renee)).toMatchObject({
      voted: true,
      voteCount: 2,
    });
    // A second press is the same vote.
    expect((await run(ideaVote, { ideaId }, renee)).voteCount).toBe(2);
    expect((await ask(ideaGet, { ideaId }, renee)).idea.following).toBe(true);
    expect(await run(ideaUnvote, { ideaId }, renee)).toMatchObject({ voted: false, voteCount: 1 });
    // Taking the vote back does not stop the updates: that is its own choice.
    expect((await ask(ideaGet, { ideaId }, renee)).idea.following).toBe(true);
    await run(ideaFollow, { ideaId, following: false }, renee);
    expect((await ask(ideaGet, { ideaId }, renee)).idea.following).toBe(false);
  });

  it('finds an idea already on the board while somebody is still typing', async () => {
    const word = mark();
    const { ideaId } = await share(marco, marcoWs, `Recurring estimates for ${word} contracts`);
    const found = await ask(ideaSimilar, { text: `${word} estimates` }, renee);
    expect(found.ideas.map((i) => i.id)).toContain(ideaId);
    expect((await ask(ideaSimilar, { text: 'an' }, renee)).ideas).toEqual([]);
  });

  it('lists the board by status, area, search and what is mine', async () => {
    const word = mark();
    const { ideaId } = await share(marco, marcoWs, `Calendar colors ${word}`, '', 'calendar');
    const bySearch = await ask(ideaList, { search: word, status: 'all' }, renee);
    expect(bySearch.ideas.map((i) => i.id)).toEqual([ideaId]);
    const byArea = await ask(ideaList, { areaId: 'calendar', sort: 'new', limit: 50 }, renee);
    expect(byArea.ideas.map((i) => i.id)).toContain(ideaId);
    const shared = await ask(ideaList, { mine: 'shared', sort: 'new', limit: 50 }, marco);
    expect(shared.ideas.every((i) => i.author.you)).toBe(true);
    expect(shared.ideas.map((i) => i.id)).toContain(ideaId);
    const voted = await ask(ideaList, { mine: 'voted', search: word }, renee);
    expect(voted.ideas).toEqual([]);
  });

  it('its author fixes their own words until the team answers', async () => {
    const { ideaId } = await share(dale, daleWs, `Tipping on invoces ${mark()}`);
    await run(
      ideaEdit,
      { ideaId, title: 'Tipping on invoices', body: 'Like a tip line', areaId: 'money' },
      dale,
    );
    expect((await ask(ideaGet, { ideaId }, dale)).idea.title).toBe('Tipping on invoices');
    const notTheirs = await refusal(() =>
      run(ideaEdit, { ideaId, title: 'Hijacked idea', areaId: 'money' }, renee),
    );
    expect(notTheirs).toMatchObject({ code: 'forbidden', rule: 'idea_protected' });
    await run(ideaSetStatus, { ideaId, status: 'planned' }, lead);
    const answered = await refusal(() =>
      run(ideaEdit, { ideaId, title: 'Tipping, changed after', areaId: 'money' }, dale),
    );
    expect(answered).toMatchObject({ code: 'conflict', rule: 'idea_answered' });
  });
});

describe('the roadmap is the team’s', () => {
  it('a business cannot move an idea; to it the team’s side does not exist', async () => {
    const { ideaId } = await share(marco, marcoWs, `Move me ${mark()}`);
    const e = await refusal(() => run(ideaSetStatus, { ideaId, status: 'planned' }, marco));
    expect(e.code).toBe('not_found');
    const triage = await refusal(() => ask(ideaTriage, {}, marco));
    expect(triage.code).toBe('not_found');
  });

  it('an agent answers and tidies but does not move the roadmap', async () => {
    const { ideaId } = await share(marco, marcoWs, `Agent check ${mark()}`);
    const e = await refusal(() => run(ideaSetStatus, { ideaId, status: 'planned' }, agent));
    expect(e.code).toBe('forbidden');
    await run(ideaComment, { ideaId, body: 'Thanks, Marco — we are looking at this.' }, agent);
    const got = await ask(ideaGet, { ideaId }, marco);
    expect(got.comments.at(-1)).toMatchObject({ author: { name: 'Al A.', team: true } });
  });

  it('a lead moves it along with a note the followers read, and voting closes when it is done', async () => {
    const { ideaId } = await share(marco, marcoWs, `Roadmap walk ${mark()}`);
    await run(ideaVote, { ideaId, workspaceId: reneeWs }, renee);
    const moved = await run(
      ideaSetStatus,
      { ideaId, status: 'planned', note: 'On the list for spring.' },
      lead,
    );
    expect(moved.updateId).toBeTruthy();
    const [event] = await rows<{
      event_type: string;
      workspace_id: string | null;
      payload: object;
    }>(
      admin(),
      sql`select e.event_type, e.workspace_id, e.payload from app.events e
          join app.outbox o on o.event_id = e.id
          where e.entity_id = ${ideaId} and e.event_type = 'platform.idea_status_changed'`,
    );
    // Nobody's business: the worker reads it with no tenant in scope.
    expect(event).toMatchObject({
      workspace_id: null,
      payload: { updateId: moved.updateId, from: 'under_review', to: 'planned', notify: true },
    });

    const got = await ask(ideaGet, { ideaId }, renee);
    expect(got.idea.status).toBe('planned');
    expect(got.updates).toEqual([
      expect.objectContaining({
        kind: 'status',
        fromStatus: 'under_review',
        toStatus: 'planned',
        note: 'On the list for spring.',
        by: 'Sam',
      }),
    ]);
    const roadmap = await ask(ideaRoadmap, {}, renee);
    expect(roadmap.planned.map((c) => c.id)).toContain(ideaId);

    // The same status with nothing to say is no change; with a note, it is an update people hear about.
    expect((await run(ideaSetStatus, { ideaId, status: 'planned' }, lead)).updateId).toBeNull();
    await run(ideaSetStatus, { ideaId, status: 'done', note: 'Shipped.' }, lead);
    const closed = await refusal(() => run(ideaVote, { ideaId }, stranger));
    expect(closed.code).toBe('forbidden');
    const late = await refusal(() =>
      run(ideaUnvote, { ideaId }, renee).then(() => run(ideaVote, { ideaId }, renee)),
    );
    expect(late).toMatchObject({ code: 'conflict', rule: 'idea_voting_closed' });
    expect((await ask(ideaRoadmap, {}, renee)).done.map((c) => c.id)).toContain(ideaId);
  });
});

describe('comments', () => {
  it('its author takes their own comment down; nobody else’s, and only the team puts one back', async () => {
    const { ideaId } = await share(marco, marcoWs, `Comment rules ${mark()}`);
    const { commentId } = await run(ideaComment, { ideaId, body: 'Me too, weekly.' }, renee);
    const other = await refusal(() => run(ideaSetCommentHidden, { commentId, hidden: true }, dale));
    expect(other).toMatchObject({ status: 403, rule: 'idea_comment_protected' });
    await run(ideaSetCommentHidden, { commentId, hidden: true }, renee);
    expect((await ask(ideaGet, { ideaId }, dale)).comments).toEqual([]);
    expect((await ask(ideaGet, { ideaId }, dale)).idea.commentCount).toBe(0);
    const back = await refusal(() =>
      run(ideaSetCommentHidden, { commentId, hidden: false }, renee),
    );
    expect(back).toMatchObject({ status: 403, rule: 'idea_comment_protected' });
    // The team still sees it, marked, and can put it back.
    const team = await ask(ideaGet, { ideaId }, agent);
    expect(team.comments).toEqual([expect.objectContaining({ id: commentId, hidden: true })]);
    await run(ideaSetCommentHidden, { commentId, hidden: false }, agent);
    expect((await ask(ideaGet, { ideaId }, dale)).idea.commentCount).toBe(1);
  });
});

describe('merging and taking down', () => {
  it('a duplicate takes its votes and followers to the idea it repeats', async () => {
    const word = mark();
    const original = await share(dale, daleWs, `Two-way Google Calendar sync ${word}`);
    const duplicate = await share(renee, reneeWs, `Google calendar two way ${word}`);
    const merged = await run(
      ideaMerge,
      { ideaId: duplicate.ideaId, intoIdeaId: original.ideaId, note: 'Same idea, one place.' },
      agent,
    );
    expect(merged).toMatchObject({ movedVotes: 1, movedFollowers: 1 });

    const into = await ask(ideaGet, { ideaId: original.ideaId }, renee);
    expect(into.idea).toMatchObject({ voteCount: 2, voted: true, following: true });
    const dup = await ask(ideaGet, { ideaId: duplicate.ideaId }, renee);
    expect(dup.idea.mergedInto).toMatchObject({ id: original.ideaId, number: original.number });
    expect(dup.idea.votingOpen).toBe(false);
    expect(dup.updates[0]).toMatchObject({ kind: 'merged', other: { id: original.ideaId } });
    const board = await ask(ideaList, { search: word, status: 'all' }, renee);
    expect(board.ideas.map((i) => i.id)).toEqual([original.ideaId]);

    const again = await refusal(() => run(ideaVote, { ideaId: duplicate.ideaId }, dale));
    expect(again).toMatchObject({ code: 'conflict', rule: 'idea_merged' });
    const self = await refusal(() =>
      run(ideaMerge, { ideaId: original.ideaId, intoIdeaId: original.ideaId }, agent),
    );
    expect(self.rule).toBe('idea_merge_itself');
  });

  it('a taken-down idea leaves the board, but its author still finds it', async () => {
    const word = mark();
    const { ideaId } = await share(marco, marcoWs, `Buy cheap followers ${word}`);
    await run(ideaSetHidden, { ideaId, hidden: true }, agent);
    expect((await ask(ideaList, { search: word, status: 'all' }, renee)).ideas).toEqual([]);
    expect(await refusal(() => ask(ideaGet, { ideaId }, renee))).toMatchObject({
      code: 'not_found',
    });
    expect((await ask(ideaGet, { ideaId }, marco)).idea).toMatchObject({
      hidden: true,
      votingOpen: false,
    });
    const triage = await ask(ideaTriage, { show: 'hidden', search: word }, agent);
    expect(triage.ideas.map((i) => i.id)).toEqual([ideaId]);
  });
});

describe('the team sees who is behind an idea', () => {
  it('names, addresses and businesses, and how many businesses want it', async () => {
    const word = mark();
    const { ideaId } = await share(dale, daleWs, `Truck inventory ${word}`);
    await run(ideaVote, { ideaId, workspaceId: reneeWs }, renee);
    const view = await ask(ideaTeamView, { ideaId }, agent);
    expect(view.author).toMatchObject({ name: 'Dale Ramsey', email: dale.email });
    expect(view.business).toMatchObject({ id: daleWs, name: 'Ideas HVAC' });
    expect(view.businessCount).toBe(2);
    expect(view.followerCount).toBe(2);
    expect(view.voters.map((v) => v.business?.name).sort()).toEqual([
      'Ideas HVAC',
      'Ideas Plumbing',
    ]);
    const triage = await ask(ideaTriage, { search: word }, agent);
    expect(triage.ideas[0]).toMatchObject({
      id: ideaId,
      businessCount: 2,
      author: { email: dale.email },
    });
  });
});

describe('What’s new', () => {
  it('a draft is the team’s; publishing it marks the ideas it delivers Done', async () => {
    const word = mark();
    const { ideaId } = await share(dale, daleWs, `Deposits on estimates ${word}`);
    const { id } = await run(
      whatsNewSave,
      {
        title: `Deposits on estimates ${word}`,
        body: 'Ask for a deposit when a customer accepts.\n- Card or bank\n- Refunds any time',
        kind: 'new',
        areaId: 'money',
        ideaIds: [ideaId],
      },
      lead,
    );
    const before = await ask(whatsNewList, { includeDrafts: true }, dale);
    expect(before.entries.map((e) => e.id)).not.toContain(id);
    const drafts = await ask(whatsNewList, { includeDrafts: true }, lead);
    expect(drafts.entries[0]).toMatchObject({ id, publishedAt: null });

    const published = await run(whatsNewPublish, { id }, lead);
    expect(published.ideasDone).toBe(1);
    // Publishing twice publishes once.
    expect((await run(whatsNewPublish, { id }, lead)).ideasDone).toBe(0);

    const idea = await ask(ideaGet, { ideaId }, renee);
    expect(idea.idea.status).toBe('done');
    expect(idea.shipped.map((s) => s.id)).toEqual([id]);
    expect(idea.updates.at(-1)).toMatchObject({ toStatus: 'done', whatsNew: { id } });

    const seenBefore = await ask(whatsNewUnseen, {}, renee);
    expect(seenBefore.unseen).toBeGreaterThan(0);
    const list = await ask(whatsNewList, {}, renee);
    expect(list.entries.find((e) => e.id === id)).toMatchObject({
      unseen: true,
      ideas: [expect.objectContaining({ id: ideaId, status: 'done' })],
    });
    await run(whatsNewMarkSeen, {}, renee);
    expect((await ask(whatsNewUnseen, {}, renee)).unseen).toBe(0);
  });
});

describe('limits', () => {
  it('ten ideas a day each, however they arrive', async () => {
    const busy = await createTestUser('ideas-busy', { fullName: 'Busy Body' });
    const ws = (await run(organizationCreate, { businessName: 'Busy Biz' }, busy)).workspaceId;
    await admin().execute(
      sql`insert into platform.ideas (title, author_user_id, workspace_id)
          select 'Earlier idea ' || n, ${busy.id}, ${ws} from generate_series(1, 10) n`,
    );
    const e = await refusal(() => share(busy, ws, 'The eleventh one'));
    expect(e).toMatchObject({ status: 429, rule: 'too_many_ideas' });
  });
});
