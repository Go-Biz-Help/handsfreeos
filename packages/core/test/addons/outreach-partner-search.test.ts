/**
 * Social Outreach: finding partners by search (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 4). HandsFreeOS says
 * which searches the person's computer does today on a network, with the Find partners playbooks' words: creators
 * through post search, businesses through people search, two a day, each once a week, none while plenty wait to be
 * read. It keeps who a search found (never anyone left alone or read lately), reads them next for the AI's partner
 * check, and lets each go once the AI has answered. Each person's own.
 */
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PARTNER_LEADS_WAITING_MOST,
  PARTNER_SEARCHES_PER_DAY,
  partnerLeadFact,
  partnerSearchWords,
} from '../../src/addons/outreach/partners';
import { blankPlaybook, PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const api = () => testDbs().api.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const partnerPlaybook = {
  ...blankPlaybook(),
  goal: 'partner' as const,
  offer: 'A share of what each customer you send pays, for a year',
  audience: 'Homeowners in Austin',
  area: 'Austin',
  signs: ['“Realtor” in their intro'],
  groupWords: ['Austin homeowners', 'Austin moms'],
  platforms: ['facebook' as const],
};

describe('the words a partner search uses', () => {
  it('are the partner playbooks’ on the network: their signs’ quoted words, then their words for groups', () => {
    const linkedIn = {
      details: { signs: [], groupWords: ['Roofers'], platforms: ['linkedin' as const] },
    };
    expect(partnerSearchWords([{ details: partnerPlaybook }, linkedIn], 'facebook')).toEqual([
      'Realtor',
      'Austin homeowners',
      'Austin moms',
    ]);
    expect(partnerSearchWords([{ details: partnerPlaybook }, linkedIn], 'linkedin')).toEqual([
      'Roofers',
    ]);
    expect(partnerSearchWords([{ details: partnerPlaybook }], 'instagram')).toEqual([]);
  });

  it('tells the AI how someone was found', () => {
    expect(partnerLeadFact('linkedin', 'creator', 'Austin homeowners')).toBe(
      'Wrote a post LinkedIn’s post search found for “Austin homeowners”',
    );
    expect(partnerLeadFact('facebook', 'business', 'Realtor')).toBe(
      'Found by Facebook’s people search for “Realtor”',
    );
  });
});

describe('finding partners by search', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  const fb = (username: string) => ({
    id: null,
    username,
    url: `https://www.facebook.com/${username}`,
  });
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  type Searches = {
    searches: { kind: string; words: string }[];
    today: number;
    perDay: number;
    waiting: number;
  };
  const searches = (u = owner, input: Record<string, unknown> = {}) =>
    runAs(u, ws, 'outreach.partners.searches', input) as Promise<Searches>;
  const leads = (
    kind: string,
    words: string,
    people: { username: string; name: string; lines?: string[]; followers?: number }[],
    u = owner,
  ) =>
    runAs(u, ws, 'outreach.partner.leads', {
      kind,
      words,
      people: people.map((p) => ({
        profile: fb(p.username),
        name: p.name,
        lines: p.lines ?? [],
        followers: p.followers ?? null,
      })),
    }) as Promise<{ kept: number }>;
  const next = () =>
    runAs(owner, ws, 'outreach.partners.next', {}) as Promise<{
      people: { name: string; kind: string; profileId: string }[];
    }>;
  const leadRows = async () =>
    (
      await rows<{ username: string; kind: string; words: string }>(
        admin(),
        sql`select p.username, l.kind, l.words from addon_outreach.partner_leads l
            join addon_outreach.profiles p on p.id = l.profile_id
            where l.workspace_id = ${ws} order by p.username`,
      )
    ).map((r) => [r.username, r.kind, r.words]);

  beforeAll(async () => {
    owner = await createTestUser('outps-owner', { fullName: 'Pat Owner' });
    riley = await createTestUser('outps-riley', { fullName: 'Riley Member' });
    ws = await outreachBusiness(owner, 'Outreach Partner Search Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: PLAYBOOK_TEMPLATES.crm_demos.details,
    });
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Partners',
      template: null,
      details: partnerPlaybook,
    });
    // Someone on Don't pitch, kept already.
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [{ profile: fb('nina.never.1'), name: 'Nina Never', mutualFriends: null }],
    });
    await runAs(owner, ws, 'outreach.friend.set', {
      profileId: await idOf('nina.never.1'),
      dontPitch: true,
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('says what to search today: each word for creators and businesses, two a day, only where a partner playbook works', async () => {
    expect(await searches()).toEqual({
      searches: [
        { kind: 'creator', words: 'Realtor' },
        { kind: 'business', words: 'Realtor' },
      ],
      today: 0,
      perDay: PARTNER_SEARCHES_PER_DAY,
      waiting: 0,
    });
    expect((await searches(owner, { platform: 'linkedin' })).searches).toEqual([]);
  });

  it('keeps who a search found, nobody in Contacts and never anyone left alone, and counts the search as done', async () => {
    expect(
      await leads('business', 'Realtor', [
        { username: 'rae.realtor.2', name: 'Rae Realtor', lines: ['Realtor at Hill Homes'] },
        { username: 'ivy.inspector.3', name: 'Ivy Inspector', lines: ['Home inspector, Austin'] },
        { username: 'nina.never.1', name: 'Nina Never' },
        { username: 'rae.realtor.2', name: 'Rae Realtor' },
      ]),
    ).toEqual({ kept: 2 });
    expect(await leadRows()).toEqual([
      ['ivy.inspector.3', 'business', 'Realtor'],
      ['rae.realtor.2', 'business', 'Realtor'],
    ]);
    const [kept] = await rows<{ intro: string[]; person_id: string | null }>(
      admin(),
      sql`select intro, person_id from addon_outreach.profiles where workspace_id = ${ws}
            and username = 'rae.realtor.2'`,
    );
    expect(kept).toEqual({ intro: ['Realtor at Hill Homes'], person_id: null });
    // Found again, they're kept once.
    expect(
      await leads('business', 'Realtor', [{ username: 'rae.realtor.2', name: 'Rae' }]),
    ).toEqual({ kept: 0 });
    // One search done today: the next is the same words for creators.
    expect(await searches()).toMatchObject({
      searches: [{ kind: 'creator', words: 'Realtor' }],
      today: 1,
      waiting: 2,
    });
  });

  it('counts a search that found nobody, and none past two a day', async () => {
    expect(await leads('creator', 'Realtor', [])).toEqual({ kept: 0 });
    expect(await searches()).toMatchObject({ searches: [], today: 2 });
  });

  it('searches the words not searched in a week, the longest ago first', async () => {
    await rows(
      admin(),
      sql`update addon_outreach.partner_searches set searched_at = ${daysAgo(8)}::timestamptz
          where workspace_id = ${ws}`,
    );
    // Never searched first: Austin homeowners, for creators and then businesses.
    expect((await searches()).searches).toEqual([
      { kind: 'creator', words: 'Austin homeowners' },
      { kind: 'business', words: 'Austin homeowners' },
    ]);
  });

  it('reads who a search found next for the AI: a creator till their following is known small, a business unless they may be a customer', async () => {
    await leads('creator', 'Austin homeowners', [
      { username: 'cole.creator.4', name: 'Cole Creator' },
      { username: 'sam.small.5', name: 'Sam Small', followers: 300 },
    ]);
    const got = (await next()).people.map((p) => [p.name, p.kind]);
    expect(got).toEqual(
      expect.arrayContaining([
        ['Cole Creator', 'creator'],
        ['Rae Realtor', 'business'],
        ['Ivy Inspector', 'business'],
      ]),
    );
    expect(got.map(([name]) => name)).not.toContain('Sam Small');
    expect(got.map(([name]) => name)).not.toContain('Nina Never');
    // Creators before businesses.
    expect(got.findIndex(([name]) => name === 'Cole Creator')).toBeLessThan(
      got.findIndex(([name]) => name === 'Rae Realtor'),
    );
  });

  it('lets someone found go once the AI has answered, and doesn’t keep them if found again soon', async () => {
    const rae = await idOf('rae.realtor.2');
    const looked = (await runAs(owner, ws, 'outreach.partner.look', {
      profileId: rae,
      kind: 'business',
      lines: ['Realtor at Hill Homes', 'Sells homes across Austin'],
    })) as { partnerId: string };
    const [at] = await rows<{ looked_at: string }>(
      admin(),
      sql`select looked_at from addon_outreach.partners where id = ${looked.partnerId}`,
    );
    // Read, waiting for the AI: no longer waiting to be read.
    expect((await searches()).waiting).toBe(3);
    await runAsSystem(ws, 'outreach.partner.save', {
      partnerId: looked.partnerId,
      lookedAt: new Date(at!.looked_at).toISOString(),
      answer: {
        fit: 'not',
        playbookId: null,
        kind: 'business',
        audience: null,
        audienceSize: null,
        why: ['Sells homes, but nobody listens to her'],
        nextStep: null,
      },
    });
    expect((await leadRows()).map(([u]) => u)).not.toContain('rae.realtor.2');
    // Checked lately, a search finding her again doesn't keep her.
    expect(
      await leads('business', 'Austin moms', [{ username: 'rae.realtor.2', name: 'Rae' }]),
    ).toEqual({ kept: 0 });
  });

  it('searches no more while plenty found by search wait to be read', async () => {
    await rows(
      admin(),
      sql`with made as (
            insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
            select ${ws}, 'facebook', 'waiting.lead.' || g, 'https://www.facebook.com/waiting.lead.' || g, 'Lead ' || g
            from generate_series(1, ${PARTNER_LEADS_WAITING_MOST}) g
            returning id)
          insert into addon_outreach.partner_leads (workspace_id, user_id, profile_id, platform, kind, words, found_at)
          select ${ws}, ${owner.id}, id, 'facebook', 'business', 'Austin moms', now() from made`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.partner_searches set searched_at = ${daysAgo(8)}::timestamptz
          where workspace_id = ${ws}`,
    );
    const got = await searches();
    expect(got.searches).toEqual([]);
    expect(got.waiting).toBeGreaterThanOrEqual(PARTNER_LEADS_WAITING_MOST);
    // Found more than a week ago, they stop counting.
    await rows(
      admin(),
      sql`update addon_outreach.partner_leads set found_at = ${daysAgo(8)}::timestamptz
          where workspace_id = ${ws}`,
    );
    expect((await searches()).searches.length).toBe(PARTNER_SEARCHES_PER_DAY);
  });

  it('keeps each person’s own: a teammate sees none of the leads or searches', async () => {
    const seen = await asUser(api(), riley.claims, (tx) =>
      rows<{ leads: number; searches: number }>(
        tx,
        sql`select (select count(*)::int from addon_outreach.partner_leads where workspace_id = ${ws}) as leads,
              (select count(*)::int from addon_outreach.partner_searches where workspace_id = ${ws}) as searches`,
      ),
    );
    expect(seen[0]).toEqual({ leads: 0, searches: 0 });
    expect(await searches(riley)).toMatchObject({ today: 0, waiting: 0 });
  });
});
