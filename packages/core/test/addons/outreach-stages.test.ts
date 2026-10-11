/**
 * Social Outreach: stages, and the moment to pitch (docs/outreach.md, decision 47). Where each person reached stands
 * is worked out from what HandsFreeOS knows; the AI's read of a chat says when they're ready for the offer, and Today
 * then has them to Pitch, with their demo link, until a pitch goes. A "no" from the AI, or the person marking someone
 * not a fit, ends outreach to them but a reply they're owed; back in play undoes it. Each person's own.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkedChatRead, chatReadPrompt } from '../../src/addons/outreach/chat-read';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachAddonServer } from '../../src/addons/outreach/server';
import { marksFor } from '../../src/addons/outreach/stages';
import { todayDraftPrompt } from '../../src/addons/outreach/today';
import { executeCommand, type CommandDef } from '../../src/server';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const crm = PLAYBOOK_TEMPLATES.crm_demos.details;

describe('the AI’s read of the moment', () => {
  it('asks whether it’s time to offer, with the playbook’s questions', () => {
    const prompt = chatReadPrompt(
      [{ fromMe: false, text: 'How do I start?', at: daysAgo(1) }],
      [],
      [
        {
          name: 'CRM demos',
          offer: 'A free demo',
          audience: 'Plumbers',
          signs: [],
          skip: [],
          questions: ['How do you track calls now?'],
        },
      ],
    );
    expect(prompt).toMatch(/Questions to have answered: How do you track calls now\?/);
  });

  it('keeps the read, and why in a line; an older answer without one is not yet', () => {
    expect(
      checkedChatRead(
        {
          summary: 'Asked about a demo.',
          tags: [],
          prospect: true,
          nextStep: null,
          pitch: 'ready',
          pitchWhy: '  Asked   how to start ',
        },
        [],
      ),
    ).toMatchObject({ pitch: 'ready', pitchWhy: 'Asked how to start' });
    expect(
      checkedChatRead({ summary: 'Hi.', tags: [], prospect: false, nextStep: null }, []),
    ).toMatchObject({ pitch: 'not_yet', pitchWhy: null });
  });

  it('has a pitch carry the link, as written', () => {
    const prompt = todayDraftPrompt({
      kind: 'pitch',
      business: 'Pine Street Bakery',
      name: 'Dana Reyes',
      facts: [],
      recent: [],
      playbook: {
        name: 'CRM demos',
        ...crm,
        link: 'https://example.com/book?ref=abc',
      },
    });
    expect(prompt).toMatch(
      /Put this link in every draft, exactly as written: https:\/\/example\.com/,
    );
  });

  it('offers only the marks that move someone on', () => {
    expect(marksFor('talking')).toEqual(['ready', 'pitched', 'lost']);
    expect(marksFor('ready')).toEqual(['pitched', 'lost']);
    expect(marksFor('lost')).toEqual(['open']);
    expect(marksFor('booked')).toEqual([]);
  });
});

describe('stages and the pitch', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  let org: string;
  const person = (username: string, name: string) => ({
    profile: { id: null, username, url: `https://www.facebook.com/${username}` },
    name,
  });
  const avery = person('avery.lane.5', 'Avery Lane');
  const blake = person('blake.cho.2', 'Blake Cho');
  const casey = person('casey.moreno.8', 'Casey Moreno');
  const drew = person('drew.park.4', 'Drew Park');
  const them = (text: string, at: string) => ({ fromMe: false, text, at });
  const chat = (p: typeof avery, thread: string, text: string, at: string) => ({
    name: p.name,
    thread: { id: thread, encrypted: false },
    profile: p.profile,
    messages: [them(text, at)],
  });
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const read = async (name: string, pitch: string, pitchWhy: string | null) => {
    const [c] = await rows<{ id: string; last_at: string }>(
      admin(),
      sql`select id, last_at from addon_outreach.file_chats where workspace_id = ${ws} and name = ${name}`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.file_chats set read_state = 'waiting' where id = ${c!.id}`,
    );
    return executeCommand(
      worker(),
      outreachAddonServer.commands!.find((x) => x.name === 'outreach.chat.read') as CommandDef,
      {
        workspaceId: ws,
        chatId: c!.id,
        lastAt: new Date(c!.last_at).toISOString(),
        read: {
          summary: 'A chat.',
          tags: [],
          prospect: true,
          nextStep: 'Offer a demo',
          pitch,
          pitchWhy,
        },
      },
      { type: 'system', workspaceId: ws, organizationId: org },
      { correlationId: randomUUID(), channel: 'test' },
    );
  };
  const pipeline = (view = 'all') =>
    runAs(owner, ws, 'outreach.stages', { view }) as Promise<{
      counts: Record<string, number>;
      people: { name: string; stage: string; why: string[]; nextStep: string | null }[];
    }>;
  const stageOf = async (name: string) =>
    (await pipeline()).people.find((p) => p.name === name)?.stage ??
    (await pipeline('lost')).people.find((p) => p.name === name)?.stage;
  const today = async () =>
    (
      (await runAs(owner, ws, 'outreach.today', {})).items as {
        kind: string;
        name: string;
        why: string[];
        demoLink: string | null;
      }[]
    ).map((i) => ({ kind: i.kind, name: i.name, why: i.why, demoLink: i.demoLink }));
  const mark = (profileId: string, mark: string, why: string | null = null) =>
    runAs(owner, ws, 'outreach.stage.mark', { profileId, mark, why });

  beforeAll(async () => {
    owner = await createTestUser('outst-owner', { fullName: 'Pat Owner' });
    riley = await createTestUser('outst-riley', { fullName: 'Riley Member' });
    ws = await outreachBusiness(owner, 'Outreach Stages Co');
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
      details: { ...crm, link: 'https://example.com/book' },
    });
    // Avery and Blake wrote; Casey was liked; Drew is a friend.
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        chat(avery, '3000001', 'How do I get started?', daysAgo(1)),
        chat(blake, '3000002', 'Not interested, thanks', daysAgo(2)),
      ],
    });
    await runAs(owner, ws, 'outreach.touch.save', { kind: 'like', ...casey, postUrl: null });
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [{ ...drew, mutualFriends: null }],
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('works out where each stands from what’s known', async () => {
    const got = await pipeline();
    expect(got.people.map((p) => [p.name, p.stage]).sort()).toEqual([
      ['Avery Lane', 'talking'],
      ['Blake Cho', 'talking'],
      ['Casey Moreno', 'warming'],
    ]);
    // Drew is a friend the person hasn't reached or checked: not in the pipeline.
    expect(got.counts).toMatchObject({ all: 3, talking: 2, warming: 1, friends: 0, lost: 0 });
    expect(got.people.find((p) => p.name === 'Casey Moreno')!.why).toEqual([
      'You liked a post of theirs',
    ]);
  });

  it('has someone ready for the offer on Today to pitch, with their demo link', async () => {
    await read('Avery Lane', 'ready', 'Asked how to get started');
    expect(await stageOf('Avery Lane')).toBe('ready');
    const pitch = (await today()).filter((i) => i.kind === 'pitch');
    expect(pitch).toHaveLength(1);
    expect(pitch[0]).toMatchObject({ name: 'Avery Lane', why: ['Asked how to get started'] });
    expect(pitch[0]!.demoLink).toMatch(/^https:\/\/example\.com\/book\?ref=/);
    // The pitch answers where the chat left off: Avery isn't a reply too.
    expect((await today()).filter((i) => i.name === 'Avery Lane').map((i) => i.kind)).toEqual([
      'pitch',
    ]);

    // Copied or sent, they're pitched, and off the list.
    expect(await mark(await idOf('avery.lane.5'), 'pitched')).toMatchObject({ stage: 'pitched' });
    expect((await today()).some((i) => i.kind === 'pitch')).toBe(false);
    expect((await pipeline('pitched')).people[0]!.why[0]).toBe('Pitched today');
  });

  it('ends outreach to someone the AI read as a no, until a later read says otherwise', async () => {
    await read('Blake Cho', 'not_interested', 'Said no thanks');
    expect(await stageOf('Blake Cho')).toBe('lost');
    const lost = await pipeline('lost');
    expect(lost.people[0]).toMatchObject({
      name: 'Blake Cho',
      why: ['Said no thanks', 'The AI read it so from your chat'],
      nextStep: null,
    });
    expect((await pipeline()).counts.all).toBe(2);
    await read('Blake Cho', 'not_yet', null);
    expect(await stageOf('Blake Cho')).toBe('talking');
  });

  it('keeps the person’s own mark over the AI’s, and back in play clears it', async () => {
    const blake = await idOf('blake.cho.2');
    await mark(blake, 'lost', 'Sells CRMs himself');
    await read('Blake Cho', 'ready', 'Asked about a demo');
    expect(await stageOf('Blake Cho')).toBe('lost');
    expect((await today()).some((i) => i.name === 'Blake Cho' && i.kind === 'pitch')).toBe(false);
    expect(await mark(blake, 'open')).toMatchObject({ stage: 'ready' });
    expect((await today()).some((i) => i.name === 'Blake Cho' && i.kind === 'pitch')).toBe(true);
  });

  it('lets the person mark someone ready themselves', async () => {
    const casey = await idOf('casey.moreno.8');
    expect(await mark(casey, 'ready')).toMatchObject({ stage: 'ready' });
    expect(
      (await today()).find((i) => i.name === 'Casey Moreno' && i.kind === 'pitch')?.why,
    ).toEqual(['You marked them ready']);
    expect(await refused(mark(randomUUID(), 'ready'))).toBe('not_found');
  });

  it('leaves out someone on Don’t pitch, though they were kept twice, by number and by name', async () => {
    expect(await stageOf('Casey Moreno')).toBe('ready');
    // The same Casey, kept again by number from the friends list, and put on Don't pitch there.
    const twin = {
      profile: {
        id: '100004000000077',
        username: null,
        url: 'https://www.facebook.com/profile.php?id=100004000000077',
      },
      name: 'casey  moreno',
    };
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [{ ...twin, mutualFriends: null }],
    });
    await runAs(owner, ws, 'outreach.friend.set', { ...twin, dontPitch: true });
    expect(await stageOf('Casey Moreno')).toBeUndefined();
    expect((await today()).some((i) => i.name === 'Casey Moreno')).toBe(false);
    expect(
      await refused(
        runAs(owner, ws, 'outreach.touch.save', { kind: 'like', ...casey, postUrl: null }),
      ),
    ).toBe('outreach_dont_pitch');
    // Off the list again, they're back.
    await runAs(owner, ws, 'outreach.friend.set', { ...twin, dontPitch: false });
    expect(await stageOf('Casey Moreno')).toBe('ready');
  });

  it('keeps each person’s own: a teammate sees none of it', async () => {
    const seen = await asUser(api(), riley.claims, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from addon_outreach.stages where workspace_id = ${ws}`,
      ),
    );
    expect(seen[0]!.n).toBe(0);
    const theirs = await runAs(riley, ws, 'outreach.stages', {});
    expect(theirs.counts.all).toBe(0);
  });
});
