/**
 * Social Outreach: a lead in the pipeline for whoever wants a demo (docs/outreach.md, decision 105). Someone reached
 * who wants a demo or answered the playbook's questions goes in Contacts, and a lead goes in the main pipeline's first
 * stage, marked with the network and group they came from and assigned to whoever reached them; once a profile, and
 * their open lead is used when they have one. Never contact, Don't pitch and clients get none.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LEAD_SOURCE_MOST,
  leadSourceOf,
  leadTitleOf,
  leadWords,
} from '../../src/addons/outreach/leads';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { leadCreate } from '../../src/commands/lead.create';
import { executeCommand } from '../../src/server';
import { human, outreachBusiness, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;

describe('what a lead says of where they came from', () => {
  it('names the network and the group, kept to what a source holds', () => {
    expect(leadSourceOf('facebook', 'Round Rock  Contractors ')).toBe(
      'Facebook · Round Rock Contractors',
    );
    expect(leadSourceOf('linkedin', null)).toBe('LinkedIn');
    const long = leadSourceOf('facebook', 'Contractors '.repeat(12));
    expect(long.length).toBe(LEAD_SOURCE_MOST);
    expect(long.endsWith('…')).toBe(true);
    expect(leadTitleOf('Dana  Reyes', 'instagram')).toBe('Dana Reyes (Instagram)');
  });

  it('says where the lead is now', () => {
    const lead = { leadId: randomUUID(), title: 'Dana Reyes (Facebook)', stage: 'New' };
    expect(leadWords({ ...lead, status: 'open' })).toBe('In your pipeline: New');
    expect(leadWords({ ...lead, status: 'won' })).toBe('Won in your pipeline');
    expect(leadWords({ ...lead, status: 'lost' })).toBe('Lost in your pipeline');
  });
});

describe('a lead for whoever wants a demo', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  const group = {
    id: '334455667',
    slug: null,
    url: 'https://www.facebook.com/groups/334455667/',
    name: 'Round Rock Contractors',
  };
  const person = (username: string, name: string) => ({
    profile: { id: null, username, url: `https://www.facebook.com/${username}` },
    name,
  });
  const dana = person('dana.reyes.21', 'Dana Reyes');
  const lee = person('lee.park.22', 'Lee Park');
  const sam = person('sam.ortiz.23', 'Sam Ortiz');
  const kai = person('kai.brooks.24', 'Kai Brooks');
  const ari = person('ari.lane.25', 'Ari Lane');
  const mo = person('mo.quinn.26', 'Mo Quinn');
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const wanted = async (profileId: string) =>
    (
      await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.events
            where workspace_id = ${ws} and event_type = 'outreach.lead.wanted' and entity_id = ${profileId}`,
      )
    )[0]!.n;
  const open = (profileId: string, userId = owner.id) =>
    runAsSystem(ws, 'outreach.lead.open', { profileId, userId }) as Promise<{
      leadId: string | null;
      opened: boolean;
      skipped: string | null;
    }>;
  const leadRow = async (leadId: string) =>
    (
      await rows<{
        title: string;
        source: string | null;
        assignee_user_id: string | null;
        person_id: string;
        position: number;
        stage_kind: string;
        stage_position: number;
      }>(
        admin(),
        sql`select l.title, l.source, l.assignee_user_id, l.person_id, p.position, s.kind as stage_kind,
                   s.position as stage_position
            from app.leads l join app.pipelines p on p.id = l.pipeline_id
            join app.pipeline_stages s on s.id = l.stage_id
            where l.id = ${leadId}`,
      )
    )[0]!;

  beforeAll(async () => {
    owner = await createTestUser('outl-owner', { fullName: 'Pat Owner' });
    riley = await createTestUser('outl-riley', { fullName: 'Riley Member' });
    ws = await outreachBusiness(owner, 'Outreach Leads Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: { ...PLAYBOOK_TEMPLATES.crm_demos.details, link: 'https://example.com/book' },
    });
    await runAs(owner, ws, 'outreach.groups.save', {
      groups: [{ group, members: 4_210, privacy: 'public', joined: true }],
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      people: [dana, lee, sam, kai].map((p) => ({ ...p, lines: [], part: 'Members near you' })),
    });
    for (const p of [dana, lee, sam, kai, ari, mo])
      await runAs(owner, ws, 'outreach.touch.save', { kind: 'friend_request', ...p, group });
  }, 60_000);
  afterAll(closeTestDbs);

  it('opens one when the person marks them ready: in Contacts, the first stage, from the group, theirs', async () => {
    const danaId = await idOf(dana.profile.username);
    await runAs(owner, ws, 'outreach.stage.mark', { profileId: danaId, mark: 'ready' });
    expect(await wanted(danaId)).toBe(1);

    const got = await open(danaId);
    expect(got).toMatchObject({ opened: true, skipped: null });
    const lead = await leadRow(got.leadId!);
    expect(lead).toMatchObject({
      title: 'Dana Reyes (Facebook)',
      source: 'Facebook · Round Rock Contractors',
      assignee_user_id: owner.id,
      stage_kind: 'open',
    });
    // The main pipeline, and its first open stage.
    const [first] = await rows<{ position: number; stage_position: number }>(
      admin(),
      sql`select p.position, min(s.position)::int as stage_position from app.pipelines p
          join app.pipeline_stages s on s.pipeline_id = p.id and s.kind = 'open'
          where p.workspace_id = ${ws} and p.archived_at is null
          group by p.id, p.position, p.created_at order by p.position, p.created_at limit 1`,
    );
    expect([lead.position, lead.stage_position]).toEqual([first!.position, first!.stage_position]);
    // They're a customer now, with their profile on them and a line on their timeline.
    const [profile] = await rows<{ person_id: string; lead_id: string; lead_at: string | null }>(
      admin(),
      sql`select person_id, lead_id, lead_at from addon_outreach.profiles where id = ${danaId}`,
    );
    expect(profile).toMatchObject({ person_id: lead.person_id, lead_id: got.leadId });
    expect(profile!.lead_at).not.toBeNull();
    const lines = await rows<{ body: string | null }>(
      admin(),
      sql`select body from app.activities
          where lead_id = ${got.leadId} and subtype = 'addon_line' and meta->>'words' like '%want a demo%'`,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toBe('Found in Round Rock Contractors');

    // Their customer page's Social panel says where the lead is.
    const social = (await runAs(owner, ws, 'outreach.person', { personId: lead.person_id })) as {
      profiles: { journey: { lead: unknown } }[];
    };
    expect(social.profiles[0]!.journey.lead).toMatchObject({
      leadId: got.leadId,
      title: 'Dana Reyes (Facebook)',
      status: 'open',
    });

    // Once a profile: asked again, nothing new, and nothing asks any more.
    expect(await open(danaId)).toEqual({ leadId: got.leadId, opened: false, skipped: 'had_one' });
    await runAs(owner, ws, 'outreach.demo.mark', { profileId: danaId, booked: true });
    expect(await wanted(danaId)).toBe(1);
  });

  it('opens one for a demo marked booked', async () => {
    const leeId = await idOf(lee.profile.username);
    await runAs(owner, ws, 'outreach.demo.mark', { profileId: leeId, booked: true });
    expect(await wanted(leeId)).toBe(1);
    expect(await open(leeId)).toMatchObject({ opened: true, skipped: null });
  });

  it('opens one for a yes to the step before the link: the first message, with no video', async () => {
    const moId = await idOf(mo.profile.username);
    await runAs(owner, ws, 'outreach.conversation.note', { profileId: moId, kind: 'opener' });
    await runAsSystem(ws, 'outreach.answer.note', {
      userId: owner.id,
      profileId: moId,
      answer: 'yes',
      writtenAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await wanted(moId)).toBe(1);
    expect(await open(moId)).toMatchObject({ opened: true, skipped: null });
  });

  it('waits for a sign they want it, and for whoever reached them', async () => {
    const samId = await idOf(sam.profile.username);
    expect(await open(samId)).toEqual({ leadId: null, opened: false, skipped: 'not_yet' });
    // Riley's mark is Riley's: the owner's lead waits for the owner's sign.
    await runAs(riley, ws, 'outreach.stage.mark', { profileId: samId, mark: 'ready' });
    expect(await open(samId)).toMatchObject({ skipped: 'not_yet' });
    expect(await open(samId, riley.id)).toMatchObject({ opened: true });
    const [row] = await rows<{ assignee_user_id: string }>(
      admin(),
      sql`select l.assignee_user_id from app.leads l join addon_outreach.profiles p on p.lead_id = l.id
          where p.id = ${samId}`,
    );
    expect(row!.assignee_user_id).toBe(riley.id);
  });

  it('gives none to someone on Don’t pitch, or for someone who left', async () => {
    const kaiId = await idOf(kai.profile.username);
    await runAs(owner, ws, 'outreach.stage.mark', { profileId: kaiId, mark: 'ready' });
    await runAs(owner, ws, 'outreach.friend.set', { profileId: kaiId, dontPitch: true });
    expect(await open(kaiId)).toMatchObject({ opened: false, skipped: 'not_open' });
    expect(await open(kaiId, randomUUID())).toMatchObject({ skipped: 'gone' });
  });

  it('uses the customer’s open lead rather than a second', async () => {
    const ariId = await idOf(ari.profile.username);
    const { personId } = await runAs(owner, ws, 'outreach.profile.contact', { profileId: ariId });
    const had = await executeCommand(
      testDbs().api.db,
      leadCreate,
      { workspaceId: ws, title: 'Ari Lane', personId },
      human(owner),
      { correlationId: randomUUID(), channel: 'test' },
    );
    await runAs(owner, ws, 'outreach.stage.mark', { profileId: ariId, mark: 'ready' });
    expect(await open(ariId)).toEqual({
      leadId: had.output.leadId,
      opened: false,
      skipped: null,
    });
    const leads = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.leads where workspace_id = ${ws} and person_id = ${personId}`,
    );
    expect(leads[0]!.n).toBe(1);
    // Marked with where they came from all the same.
    const lines = await rows<{ words: string }>(
      admin(),
      sql`select meta->>'words' as words from app.activities
          where lead_id = ${had.output.leadId} and subtype = 'addon_line' and meta->>'words' like '%want a demo%'`,
    );
    expect(lines.map((l) => l.words)).toEqual([
      'noted on their lead: they want a demo, from Facebook',
    ]);
  });
});
