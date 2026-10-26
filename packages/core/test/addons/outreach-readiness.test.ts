/**
 * Get ready for your best results (decision 63), in a business: until every item is done, Start my day is refused
 * naming what's left, Today's list is empty with nothing done on its own, and the extension posts no helpful post on
 * its own. Someone who can't do the business's items waits on them and does their own. A new main offer asks for a
 * look again at the profile. The goal keeps its working days in the person's settings, and counts the safe pace of
 * every network they work (decision 88).
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withNetwork } from '../../src/addons/outreach/network-words';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { PROFILE_ITEMS } from '../../src/addons/outreach/readiness';
import { outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

/** The AI's check of someone's profile, as the worker keeps it once their extension read it: every item right. */
const checked = (userId: string, version: number | null) =>
  runAsSystem(ws, 'outreach.profile.check_save', {
    userId,
    check: {
      items: Object.fromEntries(
        PROFILE_ITEMS.map((i) => [i, { ok: true, why: 'Looks right.', fix: null }]),
      ),
      bios: ['I help roofers fill their calendars.'],
      coverLine: 'More booked jobs for roofers',
      feature: ['A customer’s review'],
      at: new Date().toISOString(),
      version,
    },
  });

/** The samples the AI wrote for someone's Your messages, against `version`, as the worker keeps them. */
const samplesSeen = (userId: string, playbookId: string, version: number) =>
  runAsSystem(ws, 'outreach.messages.samples_save', {
    userId,
    samples: {
      playbookId,
      playbookName: 'CRM demos',
      first: ['Hi Casey! Open to more booked inspections?'],
      video: null,
      link: 'Great! Here’s my link to book a quick call.',
      followUps: ['Just checking you saw this.', 'Any thoughts?'],
      checkIn: 'Here’s a checklist you might like.',
      at: new Date().toISOString(),
      version,
    },
  });

const admin = () => testDbs().admin.db;

let owner: TestUser;
let member: TestUser;
let ws: string;

const offer = (price: string) => ({
  who: { work: 'Roofers', slice: 'with 2 to 3 crews', problem: 'No steady jobs' },
  outcome: { result: '10 to 20 booked inspections a month' },
  timeframe: { typical: '60 days' },
  method: { steps: ['Find the homes', 'Run the ads', 'Book the calls'] },
  guarantee: { promise: 'If you don’t get 10 in 60 days, you don’t pay' },
  price: { amount: price },
  line: 'We help roofers with 2 to 3 crews get 10 to 20 booked inspections a month.',
  inAFewWords: { outcome: '10 to 20 booked inspections', guarantee: 'you only pay for results' },
});

/** Puts a version of the main offer live, as publishing does. */
async function goLive(version: number, price: string) {
  await rows(
    admin(),
    sql`insert into app.main_offer_versions (workspace_id, version, parts, line, score)
        values (${ws}, ${version}, ${JSON.stringify(offer(price))}::jsonb, 'We help roofers.', '{}'::jsonb)`,
  );
  await rows(
    admin(),
    sql`insert into app.main_offers (workspace_id, live_version) values (${ws}, ${version})
        on conflict (workspace_id) do update set live_version = excluded.live_version`,
  );
}

const states = (r: { items: { item: string; state: string }[] }) =>
  Object.fromEntries(r.items.map((i) => [i.item, i.state]));

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('ready-owner', { fullName: 'Casey Owner' }),
    createTestUser('ready-member', { fullName: 'Jordan Member' }),
  ]);
  ws = await outreachBusiness(owner, 'Ready Roofing Co', { ready: false });
  await testDbs()
    .admin.db.insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
}, 60_000);

afterAll(closeTestDbs);

describe('before they’re ready', () => {
  it('refuses Start my day naming what’s left, and empties Today’s list', async () => {
    const r = await runAs(owner, ws, 'outreach.readiness', {});
    expect(r).toMatchObject({ ready: false, next: 'offer', offer: null });
    expect(states(r)).toEqual({
      offer: 'todo',
      playbook: 'todo',
      profile: 'todo',
      messages: 'todo',
      numbers: 'todo',
    });

    const said = await runAs(owner, ws, 'outreach.day.start', {}).catch(
      (e: { rule?: string; message: string }) => e,
    );
    expect(said).toMatchObject({ rule: 'outreach_not_ready' });
    expect((said as { message: string }).message).toContain('main offer isn’t live yet');

    const today = await runAs(owner, ws, 'outreach.today', {});
    expect(today).toMatchObject({ ready: false, items: [], auto: [], messages: [] });
    expect((await runAs(owner, ws, 'outreach.helpful.next', {})).post).toBeNull();
  });

  it('has a member wait on the business’s items, and do their own meanwhile', async () => {
    const r = await runAs(member, ws, 'outreach.readiness', {});
    expect(states(r)).toMatchObject({ offer: 'waiting', playbook: 'waiting' });
    expect(r.items[0].left).toContain('Ask an owner of this business');
    for (const item of PROFILE_ITEMS)
      await runAs(member, ws, 'outreach.readiness.profile', { item, done: true });
    const set = await runAs(member, ws, 'outreach.readiness.numbers', {
      goal: 8,
      days: [1, 2, 3, 4, 5],
    });
    // Ticked, but not read yet: the extension reads it first.
    expect(states(set)).toMatchObject({ profile: 'todo', numbers: 'done' });
    expect(set.items[2].left).toContain('Have the extension read your Facebook profile');
    const read = await checked(member.id, null);
    expect(states(read)).toMatchObject({ profile: 'done' });
    expect(read.profileCheck.bios).toEqual(['I help roofers fill their calendars.']);
    expect(set.numbers).toMatchObject({
      goal: 8,
      days: [1, 2, 3, 4, 5],
      canSend: 15,
      networks: [{ platform: 'facebook', canSend: 15 }],
      more: ['linkedin', 'instagram', 'alignable'],
    });
    expect(await refused(runAs(member, ws, 'outreach.day.start', {}))).toBe('outreach_not_ready');
  });
});

describe('getting ready', () => {
  it('goes ready once the offer is live, a playbook has its niche, and the person’s own are done', async () => {
    await goLive(1, '$2,000 a month');
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      details: { ...PLAYBOOK_TEMPLATES.crm_demos.details, niche: null },
    });
    expect(states(await runAs(owner, ws, 'outreach.readiness', {}))).toMatchObject({
      offer: 'done',
      playbook: 'todo',
    });
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.playbooks where workspace_id = ${ws}`,
    );
    await runAs(owner, ws, 'outreach.playbook.save', {
      playbookId: p!.id,
      name: 'CRM demos',
      details: PLAYBOOK_TEMPLATES.crm_demos.details,
    });

    // The member ticked theirs before the offer went live: they count for the first version. Their messages are
    // left: OK'd only once they've seen samples for the live version.
    expect(await runAs(member, ws, 'outreach.readiness', {})).toMatchObject({
      ready: false,
      next: 'messages',
    });
    expect(await refused(runAs(member, ws, 'outreach.readiness.messages', {}))).toBe(
      'outreach_messages_unseen',
    );
    await samplesSeen(member.id, p!.id, 1);
    const okd = await runAs(member, ws, 'outreach.readiness.messages', {});
    expect(okd.messages.samples.first).toEqual(['Hi Casey! Open to more booked inspections?']);
    // A short video is never waited on (decision 83): OK'd, the messages are done.
    expect(okd).toMatchObject({ ready: true, next: null, messages: { version: 1 } });
    // A video, when the business links one, is still an https link with a real host.
    const video = (videoLink: string) =>
      runAs(owner, ws, 'outreach.playbook.save', {
        playbookId: p!.id,
        name: 'CRM demos',
        details: { ...PLAYBOOK_TEMPLATES.crm_demos.details, videoLink },
      });
    expect(await refused(video('http://www.loom.com/share/abc123'))).toBe('validation');
    await video('https://www.loom.com/share/abc123');
    const theirs = await runAs(member, ws, 'outreach.readiness', {});
    expect(theirs).toMatchObject({ ready: true, next: null, messages: { version: 1 } });

    // Saturdays too: the goal keeps its days in the owner's working hours.
    await checked(owner.id, 1);
    await samplesSeen(owner.id, p!.id, 1);
    await runAs(owner, ws, 'outreach.readiness.messages', {});
    const mine = await runAs(owner, ws, 'outreach.readiness.numbers', {
      goal: 12,
      days: [6, 1, 2, 3, 4, 5],
    });
    expect(mine).toMatchObject({ ready: true, numbers: { goal: 12, days: [1, 2, 3, 4, 5, 6] } });
    const settings = await runAs(owner, ws, 'outreach.automation', {});
    expect(settings.settings.hours.days).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await runAs(owner, ws, 'outreach.today', {})).ready).toBe(true);
    // Past the gate, Start my day refuses only for what it did before: here, Sending is off.
    expect(await refused(runAs(owner, ws, 'outreach.day.start', {}))).toBe('outreach_sending_off');
  });

  it('asks everyone to look at their profile again when the main offer changes, saying what changed', async () => {
    await goLive(2, '$2,500 a month');
    const r = await runAs(member, ws, 'outreach.readiness', {});
    expect(r).toMatchObject({ ready: false, next: 'profile', changed: ['Price'] });
    expect(states(r).profile).toBe('look_again');
    expect(await refused(runAs(member, ws, 'outreach.day.start', {}))).toBe('outreach_not_ready');
    // Taking one back, then ticking it, counts it for the new version; the rest still want a look.
    await runAs(member, ws, 'outreach.readiness.profile', { item: 'bio', done: false });
    const one = await runAs(member, ws, 'outreach.readiness.profile', { item: 'bio', done: true });
    expect(one.profile.bio.version).toBe(2);
    expect(states(one).profile).toBe('look_again');
  });

  it('keeps the AI’s check only from the worker', async () => {
    expect(
      await refused(
        runAs(owner, ws, 'outreach.profile.check_save', { userId: owner.id, check: {} }),
      ),
    ).toBe('forbidden');
  });

  it('keeps a goal to whole calls within its limits', async () => {
    expect(
      await refused(runAs(owner, ws, 'outreach.readiness.numbers', { goal: 0, days: [1] })),
    ).toBe('validation');
    expect(
      await refused(runAs(owner, ws, 'outreach.readiness.numbers', { goal: 8, days: [] })),
    ).toBe('validation');
  });
});

describe('the goal across networks', () => {
  it('adds up the safe pace of every network the person turns on, for Results’ targets too', async () => {
    const { settings } = await runAs(member, ws, 'outreach.automation', {});
    await runAs(member, ws, 'outreach.automation.save', {
      settings: withNetwork(settings, 'linkedin', { on: true }),
    });
    const set = await runAs(member, ws, 'outreach.readiness.numbers', {
      goal: 20,
      days: [1, 2, 3, 4, 5],
    });
    expect(set.numbers).toMatchObject({
      canSend: 30,
      networks: [
        { platform: 'facebook', canSend: 15 },
        { platform: 'linkedin', canSend: 15 },
      ],
      more: ['instagram', 'alignable'],
    });
    // 20 calls a month take 35 to 69 first messages a day: a day's target is all 30 the two send safely.
    const today = await runAs(member, ws, 'outreach.tracking', { period: 'today' });
    expect(today.target).toMatchObject({ goal: 20, messages: 30 });
  });
});
