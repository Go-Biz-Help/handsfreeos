/**
 * Social Outreach: the person's own say on their messages (docs/outreach.md, decision 87;
 * ../../src/addons/outreach/conversation.ts). In Your messages, each sample can be put in their own words, or written
 * again by the AI with a note on what's not quite right. Their own stay as they wrote them when the rest are written
 * again, their notes are kept for every message of that part, and their real messages follow both.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkedRewrite,
  isMine,
  MESSAGE_NOTES_KEPT,
  MESSAGE_REWRITE_ASK,
  MESSAGE_REWRITE_SYSTEM,
  MESSAGE_SAMPLES_ASK,
  MESSAGE_SAMPLES_SYSTEM,
  messageNotesOf,
  messageRewritePrompt,
  MessageSamples,
  messageSamplesPrompt,
  NO_MESSAGE_NOTES,
  ownWordsFor,
  sampleAt,
  slotKey,
  slotsOf,
  withMineKept,
  withNote,
  withoutNote,
  withSample,
  type SamplesFacts,
} from '../../src/addons/outreach/conversation';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { todayDraftPrompt } from '../../src/addons/outreach/today';
import { outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

const kept = {
  playbookId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  playbookName: 'CRM demos',
  first: [
    'Hi Sam! Open to more booked calls?',
    'Hey Sam, would more booked calls be worth a look?',
  ],
  video: null,
  link: 'Here’s my link to book a quick call: [booking link]',
  followUps: ['Just checking in.', 'Any thoughts?', 'Still around?'],
  followUpGaps: [1, 1, 2],
  checkIn: 'Thought you might like this checklist.',
  at: '2026-10-25T09:00:00.000Z',
  version: 1,
};
const samples = MessageSamples.parse(kept);

const facts: SamplesFacts = {
  business: 'Pine Roof Leads',
  playbook: {
    name: 'CRM demos',
    niche: 'Roofers with 2 to 3 crews',
    problem: null,
    tone: null,
    samples: [],
    avoid: [],
    disclaimer: null,
    usefulWhat: null,
    hasVideo: false,
  },
  offer: { line: null, outcome: 'more booked calls' },
  followUps: 6,
  voice: 'No emoji.',
};

describe('the person’s own words and notes', () => {
  it('reads samples from before with none of their own, slot by slot', () => {
    expect(samples.mine).toEqual([]);
    expect(isMine(samples, { part: 'first', index: 0 })).toBe(false);
    expect(slotsOf(samples).map(slotKey)).toEqual([
      'first.0',
      'first.1',
      'link.0',
      'followUps.0',
      'followUps.1',
      'followUps.2',
      'checkIn.0',
    ]);
    expect(sampleAt(samples, { part: 'video', index: 0 })).toBeNull();
    expect(sampleAt(samples, { part: 'followUps', index: 5 })).toBeNull();
  });

  it('puts one in their own words, and keeps it where the next samples still have it', () => {
    const mine = withSample(samples, { part: 'followUps', index: 1 }, 'No rush, just say.', true);
    expect(mine.followUps).toEqual(['Just checking in.', 'No rush, just say.', 'Still around?']);
    expect(mine.mine).toEqual(['followUps.1']);
    // Written again by the AI on their say, it's no longer theirs.
    expect(withSample(mine, { part: 'followUps', index: 1 }, 'Any news?', false).mine).toEqual([]);
    // The next samples: theirs put back, and one past the pace now let go.
    const two = withSample(mine, { part: 'followUps', index: 2 }, 'Mine too.', true);
    const next = MessageSamples.parse({
      ...kept,
      followUps: ['A new one.', 'Another.'],
      followUpGaps: [1, 1],
    });
    const after = withMineKept(next, two);
    expect(after.followUps).toEqual(['A new one.', 'No rush, just say.']);
    expect(after.mine).toEqual(['followUps.1']);
    expect(withMineKept(next, null)).toBe(next);
    // Theirs were written for their playbook: samples for another keep none.
    const other = { ...next, playbookId: '0f8fad5b-d9cb-469f-a165-70867728950e' };
    expect(withMineKept(other, two)).toBe(other);
  });

  it('keeps what they told the AI of each part, the latest last and each once, and lets one go', () => {
    let notes = withNote(NO_MESSAGE_NOTES, 'first', 'Shorter.');
    notes = withNote(notes, 'first', 'Warmer.');
    notes = withNote(notes, 'first', 'shorter.');
    expect(notes.first).toEqual(['Warmer.', 'shorter.']);
    expect(withNote(notes, 'first', null)).toBe(notes);
    for (let i = 0; i < 10; i++) notes = withNote(notes, 'followUps', `Note ${i}.`);
    expect(notes.followUps).toHaveLength(MESSAGE_NOTES_KEPT);
    expect(notes.followUps.at(-1)).toBe('Note 9.');
    expect(withoutNote(notes, 'first', 'warmer.').first).toEqual(['shorter.']);
    // A row from before them, or one that doesn't read, has none.
    expect(messageNotesOf(null)).toEqual(NO_MESSAGE_NOTES);
    expect(messageNotesOf({ first: 'Shorter.' })).toEqual(NO_MESSAGE_NOTES);
    expect(messageNotesOf({ first: ['Shorter.'] }).first).toEqual(['Shorter.']);
  });

  it('has each kind of real message follow its part: either first message, a follow-up its own number after the first only', () => {
    const mine = withSample(
      withSample(samples, { part: 'first', index: 1 }, 'Hey, open to more calls?', true),
      { part: 'followUps', index: 0 },
      'Did you see this?',
      true,
    );
    const notes = withNote(NO_MESSAGE_NOTES, 'followUps', 'Less pushy.');
    expect(ownWordsFor('opener', mine, notes)).toEqual({
      notes: [],
      examples: ['Hey, open to more calls?'],
    });
    expect(ownWordsFor('follow_up', mine, notes, { step: 'first', sent: 0 })).toEqual({
      notes: ['Less pushy.'],
      examples: ['Did you see this?'],
    });
    // After the video, the samples' follow-ups don't fit: only the notes go.
    expect(ownWordsFor('follow_up', mine, notes, { step: 'video', sent: 0 })).toEqual({
      notes: ['Less pushy.'],
      examples: [],
    });
    expect(ownWordsFor('pitch', mine, notes)).toBeNull();
    expect(ownWordsFor('reply', mine, notes)).toBeNull();
    expect(ownWordsFor('opener', null, NO_MESSAGE_NOTES)).toBeNull();
    // A draft for another playbook follows their notes, never what they wrote for this one.
    expect(
      ownWordsFor(
        'follow_up',
        mine,
        notes,
        { step: 'first', sent: 0 },
        '0f8fad5b-d9cb-469f-a165-70867728950e',
      ),
    ).toEqual({ notes: ['Less pushy.'], examples: [] });
  });
});

describe('what the AI is asked', () => {
  it('writes the samples following the notes and in line with their own, and asks as before without', () => {
    const plain = messageSamplesPrompt(facts);
    expect(plain).not.toContain('<notes>');
    expect(plain).not.toContain('<own>');
    const said = messageSamplesPrompt({
      ...facts,
      notes: withNote(NO_MESSAGE_NOTES, 'first', 'Shorter.'),
      mine: [{ slot: { part: 'followUps', index: 1 }, text: 'Did you see this?' }],
    });
    expect(said).toContain('<notes>\nFirst messages:\n- Shorter.\n</notes>');
    expect(said).toContain('- follow-up 2: Did you see this?');
    expect(said.endsWith(MESSAGE_SAMPLES_ASK)).toBe(true);
  });

  it('leaves the guarantee out of every sample (decision 65, 2026-10-26)', () => {
    const prompt = messageSamplesPrompt(facts);
    expect(prompt).toContain('The outcome, in a few words: more booked calls');
    expect(prompt).not.toMatch(/guarantee,|on the guarantee/);
    for (const system of [MESSAGE_SAMPLES_SYSTEM, MESSAGE_REWRITE_SYSTEM])
      expect(system).toMatch(/leave its guarantee out/);
  });

  it('writes one again unlike it and the rest, with the notes on its part alone', () => {
    const prompt = messageRewritePrompt({
      ...facts,
      notes: withNote(withNote(NO_MESSAGE_NOTES, 'first', 'Shorter.'), 'followUps', 'Less pushy.'),
      slot: { part: 'followUps', index: 2 },
      before: 'Still around?',
      others: [{ slot: { part: 'first', index: 0 }, text: 'Hi Sam!' }],
    });
    expect(prompt).toContain('<before>Still around?</before>');
    expect(prompt).toContain('- first message 1: Hi Sam!');
    expect(prompt).toContain('What to write: follow-up 3 of 6');
    expect(prompt).toContain('Follow-ups:\n- Less pushy.');
    expect(prompt).not.toContain('Shorter.');
    expect(prompt.endsWith(MESSAGE_REWRITE_ASK)).toBe(true);
  });

  it('keeps one written again only when it’s new, plain and without the words to avoid', () => {
    const f = { avoid: ['cheap'], before: 'Still around?', others: ['Hi Sam!'] };
    expect(checkedRewrite('Still  around?', f)).toBeNull();
    expect(checkedRewrite('hi sam!', f)).toBeNull();
    expect(checkedRewrite('A Cheap way to more calls?', f)).toBeNull();
    expect(checkedRewrite('   ', f)).toBeNull();
    expect(checkedRewrite('Any news — on this one?', f)).not.toContain('—');
  });

  it('tells a real draft what the person said and wrote of its part, but not what they wrote to someone’s Requests', () => {
    const own = { notes: ['Shorter.'], examples: ['Hey, open to more calls?'] };
    const base = {
      kind: 'opener' as const,
      business: 'Pine Roof Leads',
      name: 'Dana Reyes',
      facts: [],
      recent: [],
      playbook: null,
      own,
    };
    const prompt = todayDraftPrompt(base);
    expect(prompt).toContain('<owner_notes>\n- Shorter.\n</owner_notes>');
    expect(prompt).toContain('<owner_example>\n- Hey, open to more calls?\n</owner_example>');
    expect(prompt).toContain('Keep each draft close to it');
    const requests = todayDraftPrompt({ ...base, platform: 'instagram', requests: true });
    expect(requests).toContain('<owner_notes>');
    expect(requests).not.toContain('<owner_example>');
    expect(todayDraftPrompt({ ...base, own: null })).not.toContain('owner_');
  });
});

describe('in a business', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  let playbookId: string;

  /** The samples the AI wrote for someone, as the worker keeps them. */
  const written = (userId: string, followUps: readonly string[]) =>
    runAsSystem(ws, 'outreach.messages.samples_save', {
      userId,
      samples: { ...kept, playbookId, followUps, followUpGaps: followUps.map(() => 1) },
    });

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('messages-owner', { fullName: 'Casey Owner' }),
      createTestUser('messages-member', { fullName: 'Jordan Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Messages Roofing Co', { ready: false });
    await testDbs()
      .admin.db.insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      details: { ...PLAYBOOK_TEMPLATES.crm_demos.details, avoid: ['cheap'] },
    });
    const [p] = await rows<{ id: string }>(
      testDbs().admin.db,
      sql`select id from addon_outreach.playbooks where workspace_id = ${ws}`,
    );
    playbookId = p!.id;
  }, 60_000);

  afterAll(closeTestDbs);

  it('changes one only once there are samples, and only one they have, saying why it isn’t there', async () => {
    expect(
      await refused(
        runAs(member, ws, 'outreach.messages.edit', { part: 'first', index: 0, text: 'Hi!' }),
      ),
    ).toBe('outreach_messages_unseen');
    await written(member.id, ['Just checking in.', 'Any thoughts?']);
    // No video message: the playbook has no short video yet, and the refusal says so, never "written again".
    const noVideo = await runAs(member, ws, 'outreach.messages.edit', {
      part: 'video',
      index: 0,
      text: 'Hi!',
    }).catch((e: unknown) => e as { rule: string; message: string });
    expect(noVideo).toMatchObject({ rule: 'outreach_message_no_video' });
    expect((noVideo as { message: string }).message).toMatch(
      /has no short video yet\. Paste its link under Your short video/,
    );
    const past = await runAs(member, ws, 'outreach.messages.edit', {
      part: 'followUps',
      index: 4,
      text: 'Hi!',
    }).catch((e: unknown) => e as { rule: string; message: string });
    expect(past).toMatchObject({
      rule: 'outreach_message_gone',
      message: expect.stringContaining(
        'Your samples have 2 follow-ups, so there’s no follow-up 5.',
      ),
    });
  });

  it('puts one in their own words, keeps the words to avoid out, and keeps theirs when written again', async () => {
    await written(owner.id, ['Just checking in.', 'Any thoughts?', 'Still around?']);
    const changed = await runAs(owner, ws, 'outreach.messages.edit', {
      part: 'followUps',
      index: 1,
      text: '  No rush at all, just say if now’s not good.  ',
    });
    expect(changed.messages.samples.followUps[1]).toBe(
      'No rush at all, just say if now’s not good.',
    );
    expect(changed.messages.samples.mine).toEqual(['followUps.1']);

    // The playbook keeps its words to avoid out of every message: the owner can change them, a member asks.
    const avoided = (u: TestUser) =>
      runAs(u, ws, 'outreach.messages.edit', {
        part: 'first',
        index: 0,
        text: 'A cheap way to more booked calls?',
      }).catch((e: { rule?: string; message: string }) => e);
    const theOwner = (await avoided(owner)) as { rule?: string; message: string };
    expect(theOwner.rule).toBe('outreach_message_avoid');
    expect(theOwner.message).toContain('Your playbook “CRM demos” keeps “cheap” out');
    expect(theOwner.message).toContain('change Words to avoid on the playbook');
    const theMember = (await avoided(member)) as { message: string };
    expect(theMember.message).toContain('ask an owner of this business');

    // Written again: theirs stays as they wrote it, the rest are new.
    const again = await written(owner.id, ['A new one.', 'Another.', 'And one more.']);
    expect(again.messages.samples.followUps).toEqual([
      'A new one.',
      'No rush at all, just say if now’s not good.',
      'And one more.',
    ]);
    expect(again.messages.samples.mine).toEqual(['followUps.1']);
  });

  it('keeps the note with one written again, each person’s own, and forgets it when asked', async () => {
    const rewritten = await runAsSystem(ws, 'outreach.messages.rewrite_save', {
      userId: owner.id,
      part: 'followUps',
      index: 1,
      text: 'Any news on this?',
      note: 'Less pushy.',
    });
    expect(rewritten.messages.samples.followUps[1]).toBe('Any news on this?');
    expect(rewritten.messages.samples.mine).toEqual([]);
    expect(rewritten.messages.notes.followUps).toEqual(['Less pushy.']);
    // Another person's are their own.
    expect((await runAs(member, ws, 'outreach.readiness', {})).messages.notes).toEqual(
      NO_MESSAGE_NOTES,
    );
    const forgot = await runAs(owner, ws, 'outreach.messages.forget', {
      part: 'followUps',
      note: 'less pushy.',
    });
    expect(forgot.messages.notes.followUps).toEqual([]);
    const [row] = await rows<{ message_notes: unknown }>(
      testDbs().admin.db,
      sql`select message_notes from addon_outreach.setup where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    expect(messageNotesOf(row!.message_notes)).toEqual(NO_MESSAGE_NOTES);
  });
});
