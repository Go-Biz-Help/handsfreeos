/**
 * Social Outreach in the worker: the people a person knows on Facebook, read off their pages, are checked by the AI
 * (the stand-in model here) for whether they fit a playbook (decision 46), a batch at a time; what their pages said is
 * let go once it has. At the day's AI limit the rest wait, unread. Someone found by topic (decision 92) is asked about
 * with how they were found and no chat; what they said under a post goes 2 weeks after it was kept if no check read
 * it, and the country guesser leaves them to their check unless a post of theirs is kept.
 */
import { randomUUID } from 'node:crypto';
import type { AiProvider } from '@hfos/ai';
import { PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { CHECK_PEOPLE_JOB } from '../src/addons/outreach/checks';
import { GUESS_COUNTRIES_JOB } from '../src/addons/outreach/countries';
import { LIVE_PRUNE_JOB } from '../src/addons/outreach/live';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { costlyAi, setAiLimit, testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };

let owner: TestUser;

async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-checks-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

const friend = (n: number) => ({
  profile: { id: null, username: `made.up.${n}`, url: `https://www.facebook.com/made.up.${n}` },
  name: `Made Up Person ${n}`,
  mutualFriends: null,
});

/** A business with the CRM playbook, and these friends read off their pages. */
async function looked(name: string, pages: readonly string[][]) {
  const ws = await outreachBusiness(owner, name);
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: crm.name,
    template: 'crm_demos',
    details: crm.details,
  });
  await runAs(owner, ws, 'outreach.friends.save', {
    list: 'friends',
    people: pages.map((_, i) => friend(i + 1)),
  });
  const next = await runAs(owner, ws, 'outreach.checks.next', {});
  for (const [i, lines] of pages.entries()) {
    const who = next.people.find((p: { name: string }) => p.name === `Made Up Person ${i + 1}`);
    await runAs(owner, ws, 'outreach.check.look', { profileId: who.profileId, lines });
  }
  return ws;
}

const states = (ws: string) =>
  rows<{
    name: string;
    verdict: string;
    lines: string[];
    why: string[];
    about: string | null;
    next_step: string | null;
    playbook: string | null;
  }>(
    admin(),
    sql`select p.name, ch.verdict, ch.lines, ch.why, ch.about, ch.next_step, pb.name as playbook
        from addon_outreach.checks ch join addon_outreach.profiles p on p.id = ch.profile_id
        left join addon_outreach.playbooks pb on pb.id = ch.playbook_id
        where ch.workspace_id = ${ws} order by p.name`,
  );

beforeAll(async () => {
  owner = await createTestUser('outreach-checks-owner', { fullName: 'Pat Owner' });
}, 60_000);

afterAll(closeTestDbs);

describe('checking the people the person knows', () => {
  it('says whether each fits, and lets their pages go', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await looked('Outreach Checks Worker Co', [
      ['Owner at Lane Plumbing'],
      ['Office manager at a dental practice'],
      ['Loves hiking'],
    ]);
    await drain(s, ws);
    expect(await states(ws)).toEqual([
      {
        name: 'Made Up Person 1',
        verdict: 'good',
        lines: [],
        why: ['Owns a business'],
        about: 'Owner at Lane Plumbing',
        next_step: 'Ask how business is going',
        playbook: 'CRM demos',
      },
      {
        name: 'Made Up Person 2',
        verdict: 'maybe',
        lines: [],
        why: ['Runs a team'],
        about: 'Office manager at a dental practice',
        next_step: null,
        playbook: 'CRM demos',
      },
      {
        name: 'Made Up Person 3',
        verdict: 'not',
        lines: [],
        why: [],
        about: null,
        next_step: null,
        playbook: null,
      },
    ]);
  });

  it('weighs where they live from their profile and mutual friends while the business reaches only some countries', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await outreachBusiness(owner, 'Outreach Country Looks Co');
    await rows(
      admin(),
      sql`update app.addon_installations
          set settings = coalesce(settings, '{}'::jsonb) || '{"countries":{"mode":"only","codes":["US"]}}'::jsonb
          where workspace_id = ${ws} and addon_id = 'outreach'`,
    );
    // Two of the owner's friends live in the United States; a third is only From Nigeria.
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [friend(1), friend(2), friend(3)],
    });
    const ids = await rows<{ id: string; username: string }>(
      admin(),
      sql`select id, username from addon_outreach.profiles where workspace_id = ${ws} order by username`,
    );
    const id = (n: number) => ids.find((p) => p.username === `made.up.${n}`)!.id;
    await rows(
      admin(),
      sql`update addon_outreach.profiles set country = 'US', country_how = 'seen', country_at = now()
          where id = any (${`{${id(1)},${id(2)}}`}::uuid[])`,
    );
    await runAs(owner, ws, 'outreach.check.look', {
      profileId: id(3),
      lines: ['From Lagos, Nigeria'],
      friendsCount: 300,
      mutual: [friend(1).profile, friend(2).profile],
    });
    await drain(s, ws);
    const [them] = await rows<{
      country: string;
      country_how: string;
      country_from: string;
      country_unsure: boolean;
      country_mutual: unknown;
    }>(
      admin(),
      sql`select country, country_how, country_from, country_unsure, country_mutual
          from addon_outreach.profiles where id = ${id(3)}`,
    );
    expect(them).toEqual({
      country: 'US',
      country_how: 'friends',
      country_from: 'NG',
      country_unsure: false,
      country_mutual: { read: 2, by: [{ code: 'US', seen: 2, other: 0 }] },
    });
  });

  it('leaves the rest waiting at the day’s AI limit', async () => {
    const none = testServices({ ai: { provider: costlyAi() } });
    const ws = await looked('Outreach Capped Checks Co', [
      ['Owner at Lane Plumbing'],
      ['Owner at Cho Electric'],
      ['Owner at Ford Roofing'],
    ]);
    await setAiLimit(ws, 1);
    await drain(none, ws);
    const waiting = (await states(ws)).filter((c) => c.verdict === 'waiting');
    expect(waiting.length).toBeGreaterThan(0);
    // What their pages said waits with them for the AI.
    expect(waiting[0]!.lines.length).toBe(1);
    const [job] = await rows<{ later: boolean }>(
      admin(),
      sql`select run_at > now() + interval '1 hour' as later from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${CHECK_PEOPLE_JOB} and status = 'pending'`,
    );
    expect(job?.later).toBe(true);
  });
});

describe('checking people found by topic (decision 92)', () => {
  /** The stand-in model, keeping each check it was asked. */
  function asked(inner: AiProvider = scriptedAi()) {
    const checks: string[] = [];
    const provider: AiProvider = {
      ...inner,
      stream: async (request, options) => {
        const said = JSON.stringify(request);
        if (said.includes('Could this person be a customer?')) checks.push(said);
        return inner.stream(request, options);
      },
    };
    return { provider, checks };
  }
  /** A LinkedIn profile someone found, kept as the database would keep it: its id. */
  async function foundOn(
    ws: string,
    username: string,
    name: string,
    find: Record<string, unknown>,
  ) {
    const [made] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name, intro)
          values (${ws}, 'linkedin', ${username}, ${`https://www.linkedin.com/in/${username}/`}, ${name},
            ${`{${((find['intro'] as string[] | undefined) ?? []).map((l) => `"${l}"`).join(',')}}`}::text[])
          returning id`,
    );
    const said = (find['said'] as string | undefined) ?? null;
    const daysAgo = (find['daysAgo'] as number | undefined) ?? 0;
    // What they said was kept when they were found, unless it says otherwise.
    const saidAgo = (find['saidDaysAgo'] as number | undefined) ?? daysAgo;
    await rows(
      admin(),
      sql`insert into addon_outreach.finds
            (workspace_id, user_id, profile_id, platform, how, words, said, said_at, found_at)
          values (${ws}, ${owner.id}, ${made!.id}, 'linkedin', ${find['how'] as string},
            ${(find['words'] as string | undefined) ?? null}, ${said},
            case when ${said}::text is null then null else now() - ${`${saidAgo} days`}::interval end,
            now() - ${`${daysAgo} days`}::interval)`,
    );
    return made!.id;
  }
  const saidOf = (ws: string) =>
    rows<{ name: string; said: string | null }>(
      admin(),
      sql`select p.name, f.said from addon_outreach.finds f
          join addon_outreach.profiles p on p.id = f.profile_id
          where f.workspace_id = ${ws} order by p.name`,
    );

  it('asks with how they were found and what they said, never a chat, then lets what they said go', async () => {
    const ai = asked();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await outreachBusiness(owner, 'Outreach Found Checks Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: { ...crm.details, platforms: ['facebook', 'linkedin'] },
    });
    const id = await foundOn(ws, 'made-up-9', 'Made Up Person 9', {
      how: 'commented',
      words: 'missed calls',
      said: 'Same here every Saturday',
    });
    await runAs(owner, ws, 'outreach.check.look', {
      profileId: id,
      lines: ['Owner at Made Up Roofing'],
    });
    await drain(s, ws);
    expect(ai.checks).toHaveLength(1);
    const [check] = ai.checks;
    expect(check).toContain('found them on LinkedIn');
    expect(check).toContain(
      '<how_found>Commented on a post your search for “missed calls” found</how_found>',
    );
    expect(check).toContain('<what_they_said>Same here every Saturday</what_they_said>');
    expect(check).toContain('Owner at Made Up Roofing');
    expect(check).not.toMatch(/<chat_summary>|<chat>/);
    expect(await states(ws)).toEqual([
      expect.objectContaining({ name: 'Made Up Person 9', verdict: 'good', lines: [] }),
    ]);
    expect(await saidOf(ws)).toEqual([{ name: 'Made Up Person 9', said: null }]);
  });

  it('asks about a follower who isn’t a friend like a friend, told they follow the owner (decision 113)', async () => {
    const ai = asked();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await outreachBusiness(owner, 'Outreach Follower Checks Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await runAs(owner, ws, 'outreach.followers.save', {
      people: [{ profile: friend(8).profile, name: 'Made Up Person 8' }],
      done: true,
    });
    const next = await runAs(owner, ws, 'outreach.checks.next', {});
    expect(next.people).toEqual([expect.objectContaining({ reason: 'follower' })]);
    await runAs(owner, ws, 'outreach.check.look', {
      profileId: next.people[0].profileId,
      lines: ['Owner at Made Up Roofing'],
    });
    await drain(s, ws);
    expect(ai.checks).toHaveLength(1);
    const [check] = ai.checks;
    expect(check).toContain('Follows the owner on Facebook, though they aren’t friends');
    expect(check).not.toContain('<how_found>');
    expect(await states(ws)).toEqual([
      expect.objectContaining({ name: 'Made Up Person 8', verdict: 'good', lines: [] }),
    ]);
  });

  it('asks about someone in one of the business’s groups like a friend, told which group (decision 116)', async () => {
    const ai = asked();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await outreachBusiness(owner, 'Outreach Member Checks Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    const group = {
      id: '423456789',
      slug: null,
      url: 'https://www.facebook.com/groups/423456789/',
      name: 'Made Up Business Owners',
    };
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 900,
      people: [
        {
          profile: friend(6).profile,
          name: 'Made Up Person 6',
          lines: ['Owner at Made Up Plumbing'],
          part: 'Members near you',
          runsGroup: false,
        },
      ],
    });
    await runAs(owner, ws, 'outreach.group.save', { group, people: [], adminsPage: true });
    const next = await runAs(owner, ws, 'outreach.checks.next', {});
    expect(next.people).toEqual([expect.objectContaining({ reason: 'member' })]);
    await runAs(owner, ws, 'outreach.check.look', {
      profileId: next.people[0].profileId,
      lines: ['Owner at Made Up Plumbing'],
    });
    await drain(s, ws);
    expect(ai.checks).toHaveLength(1);
    const [check] = ai.checks;
    expect(check).toContain(
      'In Made Up Business Owners, one of the owner’s groups on Facebook, though they aren’t friends',
    );
    expect(check).not.toContain('Found in the group');
    expect(check).not.toContain('<how_found>');
  });

  it('lets what someone found said go after 2 weeks, and anyone found never checked (decision 116), with the feed’s daily prune', async () => {
    const s = testServices();
    const ws = await outreachBusiness(owner, 'Outreach Found Said Co');
    await runAs(owner, ws, 'outreach.live.beat', {
      computer: { id: randomUUID(), name: 'Chrome on Mac', version: '0.19.0' },
      active: true,
      status: { state: 'idle', line: null, lineAt: null, nextAt: null },
    });
    // Found 15 days ago and never checked: gone.
    await foundOn(ws, 'made-up-1', 'Made Up Person 1', {
      how: 'commented',
      said: 'Old words',
      daysAgo: 15,
    });
    // Found as long ago and checked: kept, without what they said.
    const checked = await foundOn(ws, 'made-up-7', 'Made Up Person 7', {
      how: 'commented',
      said: 'Checked words',
      daysAgo: 15,
    });
    await rows(
      admin(),
      sql`insert into addon_outreach.checks (workspace_id, user_id, profile_id, verdict, via, looked_at)
          values (${ws}, ${owner.id}, ${checked}, 'not', 'found', now() - interval '14 days')`,
    );
    await foundOn(ws, 'made-up-2', 'Made Up Person 2', {
      how: 'commented',
      said: 'New words',
      daysAgo: 2,
    });
    // Found again lately, but what they said was kept 15 days ago: being found again never keeps it longer.
    await foundOn(ws, 'made-up-6', 'Made Up Person 6', {
      how: 'commented',
      said: 'Words kept long ago',
      daysAgo: 2,
      saidDaysAgo: 15,
    });
    await drain(s, ws);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${ws} and kind = ${LIVE_PRUNE_JOB} and status = 'pending'`,
    );
    await drain(s, ws);
    expect(await saidOf(ws)).toEqual([
      { name: 'Made Up Person 2', said: 'New words' },
      { name: 'Made Up Person 6', said: null },
      { name: 'Made Up Person 7', said: null },
    ]);
  });

  it('leaves where someone only found lives to their check', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await outreachBusiness(owner, 'Outreach Found Countries Co');
    await rows(
      admin(),
      sql`update app.addon_installations
          set settings = coalesce(settings, '{}'::jsonb) || '{"countries":{"mode":"only","codes":["US"]}}'::jsonb
          where workspace_id = ${ws} and addon_id = 'outreach'`,
    );
    await foundOn(ws, 'made-up-3', 'Made Up Person 3', {
      how: 'liked',
      intro: ['Lives in Denver, Colorado'],
    });
    // A good post's writer, found by it: their post is theirs to go on, so they're worked out here as before.
    const writer = await foundOn(ws, 'made-up-6', 'Made Up Person 6', {
      how: 'posted',
      intro: ['Lives in Austin, Texas'],
    });
    await rows(
      admin(),
      sql`insert into addon_outreach.posts
            (workspace_id, user_id, profile_id, url, body, found, check_state, seen_at)
          values (${ws}, ${owner.id}, ${writer},
            'https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000006/',
            'Missed calls again this week. What do other crews use?', 'search', 'good', now())`,
    );
    // Someone kept another way, with the same kind of line: worked out here.
    await rows(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name, intro)
          values (${ws}, 'linkedin', 'made-up-5', 'https://www.linkedin.com/in/made-up-5/', 'Made Up Person 5',
            '{"Lives in Austin, Texas"}'::text[])`,
    );
    // A group's member is worked out from the line under their name.
    await runAs(owner, ws, 'outreach.group.save', {
      group: {
        id: '623456789',
        slug: null,
        url: 'https://www.facebook.com/groups/623456789/',
        name: 'Austin Small Business Owners',
      },
      people: [
        {
          profile: { id: null, username: 'made.up.4', url: 'https://www.facebook.com/made.up.4' },
          name: 'Made Up Person 4',
          lines: ['Lives in Austin, Texas'],
        },
      ],
    });
    await drain(s, ws);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${ws} and kind = ${GUESS_COUNTRIES_JOB} and status = 'pending'`,
    );
    await drain(s, ws);
    const where = await rows<{ name: string; country: string | null }>(
      admin(),
      sql`select name, country from addon_outreach.profiles where workspace_id = ${ws} order by name`,
    );
    expect(where).toEqual([
      { name: 'Made Up Person 3', country: null },
      { name: 'Made Up Person 4', country: 'US' },
      { name: 'Made Up Person 5', country: 'US' },
      { name: 'Made Up Person 6', country: 'US' },
    ]);
  });
});
