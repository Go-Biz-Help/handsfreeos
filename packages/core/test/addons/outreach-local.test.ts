/**
 * Social Outreach: what each person does and where, and the person's own town, radius and local focus
 * (docs/outreach.md, decision 177). Towns are the US Census Bureau's, so how far apart two are needs no lookup; the AI
 * fills what they do and where from their page and the chat, never over what a person typed; each person sets their
 * own town and how far is local, starting from the business's address; and the local focus adds their towns to group
 * searches.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CheckAnswer, checkedAnswer, CHECK_SCHEMA } from '../../src/addons/outreach/checks';
import {
  areaOfTown,
  LOCAL_WORDS,
  locationLine,
  myCalendarsLine,
  NEAR_SHOWN,
  RADIUS_START,
  THEIR_WORK_ASK,
  theirWorkFact,
  TheirWorkFound,
  theirWorkLine,
  townName,
  townOfArea,
} from '../../src/addons/outreach/local';
import { groupSearchWords, withLocalArea } from '../../src/addons/outreach/ops/group-checks';
import { theirWorkShown } from '../../src/addons/outreach/ops/local';
import { knownTown, milesBetweenTowns, townsNear } from '../../src/addons/outreach/ops/towns';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { NETWORKING_ON, startingScript } from '../../src/addons/outreach/script';
import {
  asksTheirWork,
  LOCAL_COFFEE,
  networkingReplyTask,
  theirWorkOf,
  TODAY_DRAFT_SCHEMA,
  TodayDraftAnswer,
  todayDraftPrompt,
} from '../../src/addons/outreach/today';
import { outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;

describe('towns', () => {
  it('reads a US town with its state however it’s written', () => {
    expect(townOfArea('Austin, TX')).toBe('austin-tx');
    expect(townOfArea('austin, texas')).toBe('austin-tx');
    expect(townOfArea('Austin TX')).toBe('austin-tx');
    expect(townOfArea('Round Rock, TX 78664')).toBe('round-rock-tx');
    expect(townOfArea('the Greater Dallas area, TX')).toBe('dallas-tx');
    // No state named, or nothing at all, is no town.
    expect(townOfArea('Austin')).toBeNull();
    expect(townOfArea('')).toBeNull();
    expect(townOfArea(null)).toBeNull();
  });

  it('writes a town back the way people do', () => {
    expect(areaOfTown('round-rock-tx')).toBe('Round Rock, TX');
    expect(areaOfTown('st-louis-mo')).toBe('St. Louis, MO');
    expect(townName('round-rock-tx')).toBe('Round Rock');
  });

  it('knows the towns near one, closest first, inside the radius', () => {
    expect(knownTown('austin-tx')).toBe('austin-tx');
    expect(knownTown('nowhere-at-all-tx')).toBeNull();
    const near = townsNear('austin-tx', 25);
    expect(near).toContain('round-rock-tx');
    expect(near).not.toContain('dallas-tx');
    // A wider radius takes in more.
    expect(townsNear('austin-tx', 50).length).toBeGreaterThan(near.length);
    const miles = milesBetweenTowns('austin-tx', 'round-rock-tx')!;
    expect(miles).toBeGreaterThan(10);
    expect(miles).toBeLessThan(25);
    expect(milesBetweenTowns('austin-tx', null)).toBeNull();
  });
});

describe('what they do and where, as the AI gives it', () => {
  it('asks it of every message the AI writes to them, and keeps it as one shape', () => {
    for (const kind of ['opener', 'reconnect', 'reply', 'pitch'] as const)
      expect(asksTheirWork(kind)).toBe(true);
    expect(asksTheirWork('comment')).toBe(false);
    expect(TODAY_DRAFT_SCHEMA['required']).toEqual(
      expect.arrayContaining(['work', 'area', 'reach']),
    );
    expect(CHECK_SCHEMA['required']).toEqual(expect.arrayContaining(['work', 'area', 'reach']));
    expect(THEIR_WORK_ASK).toMatch(/never guess it from the playbook/);
    const prompt = todayDraftPrompt({
      kind: 'opener',
      business: 'Bright Books',
      name: 'Sam Lee',
      facts: [],
      recent: [],
      playbook: { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details },
      platform: 'facebook',
    });
    expect(prompt).toContain(THEIR_WORK_ASK);
  });

  it('takes an empty answer as none, cuts a long one, and an answer from before as nothing known', () => {
    expect(TheirWorkFound.parse({})).toEqual({ work: null, area: null, reach: null });
    expect(TheirWorkFound.parse({ work: '  ', area: '', reach: null })).toEqual({
      work: null,
      area: null,
      reach: null,
    });
    expect(TheirWorkFound.parse({ work: 'x'.repeat(200) }).work).toHaveLength(80);
    const a = TodayDraftAnswer.parse({
      drafts: ['Hi Sam'],
      answer: null,
      work: ' mobile  car detailing ',
      area: 'Austin, TX',
      reach: 'local',
    });
    expect(theirWorkOf(a)).toEqual({
      work: 'mobile car detailing',
      area: 'Austin, TX',
      reach: 'local',
    });
    expect(theirWorkOf(TodayDraftAnswer.parse({ drafts: ['Hi'], answer: null }))).toEqual({
      work: null,
      area: null,
      reach: null,
    });
    // A check's answer too.
    const checked = checkedAnswer(
      CheckAnswer.parse({
        fit: 'good',
        playbook: null,
        why: [],
        about: null,
        nextStep: null,
        work: 'Roofing',
        area: 'Round Rock, TX',
        reach: 'nonsense',
      }),
      [],
    );
    expect(checked.them).toEqual({ work: 'Roofing', area: 'Round Rock, TX', reach: null });
  });

  it('says how far they are from the person, and tells the AI', () => {
    const shown = theirWorkShown(
      {
        work: 'Roofing',
        area: 'Round Rock, TX',
        town: 'round-rock-tx',
        reach: 'local',
        area_how: 'page',
      },
      { town: 'austin-tx', radiusMiles: 25 },
    );
    expect(shown).toMatchObject({ how: 'page', near: true });
    expect(shown.miles).toBeGreaterThan(10);
    expect(theirWorkLine(shown)).toBe(
      `Roofing · Round Rock, TX · Local · ${shown.miles} miles away`,
    );
    expect(theirWorkFact(shown)).toMatch(/They’re local to the owner/);
    const far = theirWorkShown(
      { work: 'Roofing', area: 'Dallas, TX', town: 'dallas-tx', reach: null, area_how: 'chat' },
      { town: 'austin-tx', radiusMiles: 25 },
    );
    expect(far.near).toBe(false);
    expect(theirWorkFact(far)).toMatch(/outside where the owner meets in person/);
    // Nothing known: nothing said.
    const none = theirWorkShown(
      { work: null, area: null, town: null, reach: null, area_how: null },
      { town: 'austin-tx', radiusMiles: 25 },
    );
    expect(theirWorkLine(none)).toBeNull();
    expect(theirWorkFact(none)).toBeNull();
    expect(locationLine({ area: null, radiusMiles: 25 })).toBe(LOCAL_WORDS.whereNone);
    expect(locationLine({ area: 'Austin, TX', radiusMiles: 25 })).toBe(
      'Within 25 miles of Austin, TX',
    );
  });
});

describe('focus on local groups', () => {
  const playbooks = [{ details: { groupWords: ['small business owners'], worksOnline: false } }];

  it('searches with the person’s towns first, then the words alone', () => {
    expect(groupSearchWords(playbooks, 'facebook', ['austin-tx', 'round-rock-tx'])).toEqual([
      { words: 'Austin small business owners', anywhere: false },
      { words: 'Round Rock small business owners', anywhere: false },
      { words: 'small business owners', anywhere: false },
    ]);
    // Off, the words alone; where groups go by the AI's check, their searches already stay in town.
    expect(groupSearchWords(playbooks, 'facebook', null)).toEqual([
      { words: 'small business owners', anywhere: false },
    ]);
    expect(groupSearchWords(playbooks, 'alignable', ['austin-tx'])).toEqual([
      { words: 'small business owners', anywhere: false },
    ]);
  });

  it('counts a group named for one of their towns as in their area', () => {
    expect(
      withLocalArea([{ details: { area: 'Texas' } }], ['austin-tx', 'round-rock-tx'])[0]!.details
        .area,
    ).toBe('Texas, Austin, Round Rock');
    expect(withLocalArea([{ details: { area: null } }], ['austin-tx'])[0]!.details.area).toBe(
      'Austin',
    );
    expect(withLocalArea([{ details: { area: 'Texas' } }], null)[0]!.details.area).toBe('Texas');
  });
});

describe('where you are, and what they do and where, saved', () => {
  let owner: TestUser;
  let mate: TestUser;
  let ws: string;
  let rio: string;
  let kai: string;

  const profile = async (username: string, name: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
            values (${ws}, 'facebook', ${username}, ${`https://www.facebook.com/${username}`}, ${name})
            returning id`,
      )
    )[0]!.id;

  beforeAll(async () => {
    owner = await createTestUser('local-owner', { fullName: 'Pat Owner' });
    mate = await createTestUser('local-mate', { fullName: 'Sam Teammate' });
    ws = await outreachBusiness(owner, 'Outreach Local Co');
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${ws}, ${mate.id}, 'member')`,
    );
    await rows(
      admin(),
      sql`update app.workspaces set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
        address: {
          line1: '12 Oak St',
          line2: '',
          city: 'Austin',
          state: 'TX',
          postalCode: '78701',
          country: 'US',
        },
      })}::jsonb where id = ${ws}`,
    );
    rio = await profile('rio.roofs', 'Rio Reyes');
    kai = await profile('kai.details', 'Kai Moss');
  }, 60_000);
  afterAll(closeTestDbs);

  it('starts with no town of your own, the business’s to start from, and the focus off', async () => {
    expect(await runAs(owner, ws, 'outreach.location.get', {})).toEqual({
      area: null,
      suggested: 'Austin, TX',
      radiusMiles: RADIUS_START,
      localFocus: false,
      near: [],
      nearCount: 0,
    });
  });

  it('refuses a town it can’t find, and the focus without a town', async () => {
    expect(await refused(runAs(owner, ws, 'outreach.location.set', { area: 'Atlantis, ZZ' }))).toBe(
      'outreach_unknown_town',
    );
    expect(await refused(runAs(owner, ws, 'outreach.location.set', { localFocus: true }))).toBe(
      'outreach_local_needs_town',
    );
    expect(
      await refused(
        runAs(owner, ws, 'outreach.location.set', { area: 'Austin, TX', radiusMiles: 500 }),
      ),
    ).not.toBe('went through');
  });

  it('keeps your own town, how far is local and the focus, and nobody else’s', async () => {
    const set = await runAs(owner, ws, 'outreach.location.set', {
      area: 'austin, texas',
      radiusMiles: 25,
    });
    expect(set).toMatchObject({ area: 'Austin, TX', radiusMiles: 25, localFocus: false });
    // The closest by name, and how many in all.
    expect(set.near).toHaveLength(NEAR_SHOWN);
    expect(set.nearCount).toBeGreaterThan(NEAR_SHOWN);
    expect(LOCAL_WORDS.nearLine(set)).toMatch(/^Local takes in .+, and \d+ more towns\.$/);
    expect(
      await runAs(owner, ws, 'outreach.location.set', { localFocus: true, radiusMiles: 50 }),
    ).toMatchObject({ area: 'Austin, TX', radiusMiles: 50, localFocus: true });
    // The teammate's are still their own.
    expect(await runAs(mate, ws, 'outreach.location.get', {})).toMatchObject({
      area: null,
      localFocus: false,
    });
    const [said] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${ws} and event_type = 'outreach.location.set'`,
    );
    expect(said!.n).toBe(2);
  });

  it('turns the focus off when the town is cleared', async () => {
    expect(await runAs(owner, ws, 'outreach.location.set', { area: null })).toMatchObject({
      area: null,
      localFocus: false,
    });
    await runAs(owner, ws, 'outreach.location.set', { area: 'Austin, TX', radiusMiles: 25 });
  });

  it('keeps what a person sets of what someone does and where, and says how far they are', async () => {
    expect(
      await refused(
        runAs(owner, ws, 'outreach.their_work.set', { profileId: rio, area: 'Atlantis, ZZ' }),
      ),
    ).toBe('outreach_unknown_town');
    const out = await runAs(owner, ws, 'outreach.their_work.set', {
      profileId: rio,
      work: ' Roofing ',
      area: 'round rock, tx',
      reach: 'local',
    });
    expect(out.shown).toMatchObject({
      work: 'Roofing',
      area: 'Round Rock, TX',
      reach: 'local',
      how: 'typed',
      near: true,
    });
    // How far is the person's own: the teammate has no town.
    expect(
      (await runAs(mate, ws, 'outreach.profile.marks', { profileId: rio })).theirWork,
    ).toMatchObject({ work: 'Roofing', miles: null, near: false });
    // The AI never writes over it.
    expect(
      await runAsSystem(ws, 'outreach.their_work.note', {
        userId: owner.id,
        profileId: rio,
        how: 'chat',
        them: { work: 'Plumbing', area: 'Dallas, TX', reach: 'nationwide' },
      }),
    ).toEqual({ saved: false });
    expect(
      (await runAs(owner, ws, 'outreach.profile.marks', { profileId: rio })).theirWork,
    ).toMatchObject({ work: 'Roofing', area: 'Round Rock, TX', how: 'typed' });
    // A part left out stays; an empty one clears.
    expect(
      (await runAs(owner, ws, 'outreach.their_work.set', { profileId: rio, work: '' })).shown,
    ).toMatchObject({ work: null, area: 'Round Rock, TX', reach: 'local' });
  });

  it('fills what the AI read, keeps the chat’s over their page’s, and never clears anything', async () => {
    const note = (how: 'page' | 'chat', them: Record<string, unknown>) =>
      runAsSystem(ws, 'outreach.their_work.note', { userId: owner.id, profileId: kai, how, them });
    expect(await note('page', {})).toEqual({ saved: false });
    expect(await note('page', { work: 'Car detailing', area: 'Austin TX' })).toEqual({
      saved: true,
    });
    const marks = () =>
      runAs(owner, ws, 'outreach.profile.marks', { profileId: kai }).then(
        (m: { theirWork: unknown }) => m.theirWork,
      );
    expect(await marks()).toMatchObject({
      work: 'Car detailing',
      area: 'Austin, TX',
      reach: null,
      how: 'page',
      near: true,
    });
    await note('chat', { work: 'Mobile car detailing', reach: 'local' });
    expect(await marks()).toMatchObject({
      work: 'Mobile car detailing',
      area: 'Austin, TX',
      reach: 'local',
      how: 'chat',
    });
    // Their page again doesn't make it the page's; a place that isn't a known town is kept as it reads.
    await note('page', { area: 'Central Texas' });
    expect(await marks()).toMatchObject({
      work: 'Mobile car detailing',
      area: 'Central Texas',
      how: 'chat',
      miles: null,
      near: false,
    });
  });
});

describe('a call or coffee for locals (decision 177, the owner’s 4a)', () => {
  it('offers coffee only to someone who works near the owner, and never names a place', () => {
    const says = startingScript('demo');
    const wrap = { wroteBack: 2, ownerAsked: false };
    expect(
      networkingReplyTask(says, NETWORKING_ON, wrap, 'https://x.test/book/a/b', true),
    ).toContain(LOCAL_COFFEE);
    expect(networkingReplyTask(says, NETWORKING_ON, wrap, 'https://x.test/book/a/b')).not.toContain(
      LOCAL_COFFEE,
    );
    expect(LOCAL_COFFEE).toMatch(/Never name a place or a time/);
    // With the call switch off, no call and no coffee.
    expect(
      networkingReplyTask(says, { ...NETWORKING_ON, call: false }, wrap, null, true),
    ).not.toContain(LOCAL_COFFEE);
  });
});

describe('your Networking calendar and Lead calendar (decision 178)', () => {
  let owner: TestUser;
  let mate: TestUser;
  let ws: string;
  let site: string;
  const cal = async (name: string, more: { owner?: string; isPublic?: boolean } = {}) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`insert into app.calendars (workspace_id, name, slug, status, public, owner_user_id)
            values (${ws}, ${name}, ${`cal-${randomUUID().slice(0, 8)}`}, 'active', ${more.isPublic ?? true},
              ${more.owner ?? null})
            returning id`,
      )
    )[0]!.id;
  let mine: string;
  let demo: string;
  let hidden: string;

  beforeAll(async () => {
    owner = await createTestUser('cals-owner', { fullName: 'Chris Owner' });
    mate = await createTestUser('cals-mate', { fullName: 'Sam Teammate' });
    ws = await outreachBusiness(owner, 'Outreach Calendars Co');
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${ws}, ${mate.id}, 'member')`,
    );
    site = `cals-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`insert into app.booking_sites (workspace_id, slug, name) values (${ws}, ${site}, 'Calendars Co')`,
    );
    demo = await cal('Demo');
    mine = await cal('Chris’s calendar', { owner: owner.id });
    hidden = await cal('Not public', { owner: owner.id, isPublic: false });
    // The playbook links to the demo page, so with nothing picked a call goes on the person's own calendar.
    const [d] = await rows<{ slug: string }>(
      admin(),
      sql`select slug from app.calendars where id = ${demo}`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.playbooks (workspace_id, name, details)
          values (${ws}, 'CRM demos', ${JSON.stringify({
            ...PLAYBOOK_TEMPLATES.crm_demos.details,
            link: `https://app.handsfreeos.test/book/${site}/${d!.slug}`,
          })}::jsonb)`,
    );
  }, 60_000);
  afterAll(closeTestDbs);

  it('lists the calendars that take bookings online, theirs first, and where a call goes with none picked', async () => {
    const shown = await runAs(owner, ws, 'outreach.my_calendars.get', {});
    expect(shown).toEqual({
      networking: null,
      lead: null,
      networkingOtherwise: 'Chris’s calendar',
      choices: [
        { id: mine, name: 'Chris’s calendar', mine: true },
        { id: demo, name: 'Demo', mine: false },
      ],
    });
    expect(myCalendarsLine(shown)).toBe(LOCAL_WORDS.pickNone);
    // The teammate owns none, so a call of theirs has nowhere to go.
    expect((await runAs(mate, ws, 'outreach.my_calendars.get', {})).networkingOtherwise).toBeNull();
  });

  it('refuses a calendar that can’t be booked online, or isn’t there', async () => {
    expect(
      await refused(runAs(owner, ws, 'outreach.my_calendars.set', { leadCalendarId: hidden })),
    ).toBe('outreach_calendar_not_bookable');
    expect(
      await refused(
        runAs(owner, ws, 'outreach.my_calendars.set', { networkingCalendarId: randomUUID() }),
      ),
    ).toBe('outreach_calendar_gone');
  });

  it('keeps each person’s own picks, and none clears one', async () => {
    const set = await runAs(owner, ws, 'outreach.my_calendars.set', {
      networkingCalendarId: mine,
      leadCalendarId: demo,
    });
    expect(set).toMatchObject({
      networking: { id: mine, name: 'Chris’s calendar' },
      lead: { id: demo, name: 'Demo' },
    });
    expect(myCalendarsLine(set)).toBe('Networking: Chris’s calendar · Leads: Demo');
    expect(await runAs(mate, ws, 'outreach.my_calendars.get', {})).toMatchObject({
      networking: null,
      lead: null,
    });
    expect(
      await runAs(owner, ws, 'outreach.my_calendars.set', { networkingCalendarId: null }),
    ).toMatchObject({ networking: null, lead: { id: demo } });
    // A pick that stops taking bookings shows as none.
    await rows(admin(), sql`update app.calendars set public = false where id = ${demo}`);
    expect((await runAs(owner, ws, 'outreach.my_calendars.get', {})).lead).toBeNull();
    await rows(admin(), sql`update app.calendars set public = true where id = ${demo}`);
    const [said] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${ws} and event_type = 'outreach.my_calendars.set'`,
    );
    expect(said!.n).toBe(2);
  });
});
