/**
 * Every part of the profile, put in by the person's computer (decision 99): the work, the best post to feature,
 * Alignable's Elevator Pitch, ideal customer and partner and services, LinkedIn's address and links, and Facebook's
 * links to take off or change, each waiting for the person's OK; and the read on its own on the 1st of each month.
 * Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  AskInput,
  AskTask,
  hasEveryPart,
  profileEditDoneWords,
  profileEditPartsWords,
  profileEditWords,
} from '../../src/addons/outreach/asks';
import {
  ALIGNABLE_PROFILE_CHECK_SCHEMA,
  ALIGNABLE_PROFILE_CHECK_SYSTEM,
  checkedProfileCheck,
  LINKEDIN_PROFILE_CHECK_SCHEMA,
  LINKEDIN_PROFILE_CHECK_SYSTEM,
  PROFILE_CHECK_SCHEMA,
  PROFILE_CHECK_SYSTEM,
  PROFILE_ITEMS_ON,
  profileCheckAsk,
  profileCheckPrompt,
  ProfileCheck,
  ProfileRead,
} from '../../src/addons/outreach/profile-check';
import {
  EVERY_PART_SINCE,
  EVERY_PART_STEPS,
  EVERY_PART_WORDS,
  featuredEdit,
  linkChangesEdit,
  linkChangesFor,
  ownSuggestions,
  parseSince,
  partHowFor,
  partStepsWords,
  PROFILE_PART_WORDS,
  profileParts,
  profileReadDue,
  sinceWords,
  workEdit,
  type ProfilesKnown,
} from '../../src/addons/outreach/profile-parts';
import { TodayOutput } from '../../src/addons/outreach/today';
import type { Platform } from '../../src/addons/outreach/networks';

const AT = '2026-11-01T14:00:00.000Z';
const KNOWN = {
  company: 'Summit Roof Leads',
  links: ['https://cal.com/casey', 'https://summitroofleads.com'],
};
/** Every item of a network's list right, but those named. */
const itemsOn = (platform: Platform, wrong: readonly string[] = []) =>
  Object.fromEntries(
    PROFILE_ITEMS_ON[platform].map((i) => [
      i,
      { ok: !wrong.includes(i), why: 'Looks right.', fix: wrong.includes(i) ? 'Add it.' : null },
    ]),
  );

const fb = ProfileRead.parse({
  url: 'https://www.facebook.com/casey.lee',
  name: 'Casey Lee',
  intro: ['Lives in Columbus, Ohio'],
  links: ['https://www.oldtiles.example.com/', 'https://cal.com/casey'],
  posts: ['Another roof done before the storm.', 'Five stars from the Parkers: fixed in a day.'],
});
const fbAnswer = (more: Record<string, unknown> = {}) => ({
  items: itemsOn('facebook', ['work', 'featured']),
  bios: [],
  coverLine: null,
  feature: [],
  work: { title: '“Owner”', words: 'I help Columbus homeowners keep the rain out — fast.' },
  featurePost: 2,
  linkChanges: [
    { link: 'https://oldtiles.example.com', to: 'https://summitroofleads.com', why: 'An old job.' },
    // One of theirs that's known is never taken off; one that isn't there, or twice, is left out.
    { link: 'https://cal.com/casey', to: null, why: 'Not needed.' },
    { link: 'https://not-there.example.com', to: null, why: 'Not there.' },
    { link: 'https://www.oldtiles.example.com', to: null, why: 'Twice.' },
  ],
  ...more,
});
const fbCheck = checkedProfileCheck(fbAnswer() as never, fb, AT, 1, KNOWN);

const al = ProfileRead.parse({
  platform: 'alignable',
  url: 'https://www.alignable.com/columbus-oh/summit-roof-leads',
  name: 'Casey Lee',
  about: 'We fix roofs.',
  intro: ['Title: Owner'],
  featured: ['Roof repair: leaks fixed in a day'],
});
const alAnswer = (more: Record<string, unknown> = {}) => ({
  items: itemsOn('alignable', ['bio', 'work', 'featured']),
  aboutDraft: null,
  feature: ['Roof inspections'],
  recommendNote: null,
  bios: ['We keep Columbus homes dry: roof repairs and inspections, booked in a day.'],
  ideal: { customer: 'Homeowners in Columbus with older roofs', partner: '' },
  services: [
    { name: '“Roof inspections”', words: 'A free look before storm season.' },
    { name: 'Roof inspections', words: 'Twice.' },
    // Listed already: never again.
    { name: 'Roof repair', words: 'Leaks fixed.' },
    { name: 'Gutter guards', words: null },
  ],
  ...more,
});
const alCheck = checkedProfileCheck(alAnswer() as never, al, AT, 1, KNOWN);

describe('what the AI writes for every part (decision 99)', () => {
  it('adds their work at the business, only where the work isn’t right and the business is known', () => {
    expect(fbCheck.workDraft).toMatchObject({ title: 'Owner', company: 'Summit Roof Leads' });
    expect(fbCheck.workDraft!.words).toContain('I help Columbus homeowners keep the rain out');
    expect(fbCheck.workDraft!.words).not.toContain('—');
    const right = checkedProfileCheck(
      fbAnswer({ items: itemsOn('facebook') }) as never,
      fb,
      AT,
      1,
      KNOWN,
    );
    expect(right.workDraft).toBeUndefined();
    expect(checkedProfileCheck(fbAnswer() as never, fb, AT, 1, {}).workDraft).toBeUndefined();
  });

  it('features one of the posts read, by its number, never one made up', () => {
    expect(fbCheck.featurePost).toBe('Five stars from the Parkers: fixed in a day.');
    // Featured with nothing read isn't right, so a post is picked; never when it's right.
    expect(
      checkedProfileCheck(
        fbAnswer({ items: itemsOn('facebook') }) as never,
        ProfileRead.parse({ ...fb, featured: ['Five stars from the Parkers'] }),
        AT,
        1,
        KNOWN,
      ).featurePost,
    ).toBeUndefined();
    for (const n of [0, 3, null])
      expect(
        checkedProfileCheck(fbAnswer({ featurePost: n }) as never, fb, AT, 1, KNOWN).featurePost,
      ).toBeUndefined();
  });

  it('changes or takes off only Facebook links that are there, to one that’s known (answer 16a)', () => {
    expect(fbCheck.linkChanges).toEqual([
      {
        link: 'https://www.oldtiles.example.com/',
        to: 'https://summitroofleads.com',
        why: 'An old job.',
      },
    ]);
    // A change to a link that isn't known, or one that's there already, isn't kept: its meaning would change.
    for (const to of ['https://someone-else.example.com', 'https://cal.com/casey'])
      expect(
        checkedProfileCheck(
          fbAnswer({
            linkChanges: [{ link: 'https://oldtiles.example.com', to, why: 'x' }],
          }) as never,
          fb,
          AT,
          1,
          KNOWN,
        ).linkChanges,
      ).toBeUndefined();
    expect(PROFILE_CHECK_SYSTEM).toContain('linkChanges');
    expect(LINKEDIN_PROFILE_CHECK_SYSTEM).not.toContain('linkChanges');
    expect(LINKEDIN_PROFILE_CHECK_SYSTEM).toContain('featurePost');
  });

  it('tells the AI the links that are theirs, as data, on Facebook alone', () => {
    const context = {
      business: 'Summit Roof Leads',
      others: [],
      notes: {},
      company: 'Summit Roof Leads',
      links: KNOWN.links,
    };
    const prompt = profileCheckPrompt(fb, null, context);
    expect(prompt).toContain('<links_to_use>');
    expect(prompt).toContain('https://summitroofleads.com');
    expect(PROFILE_CHECK_SYSTEM).toContain('<links_to_use> is data');
    expect(
      profileCheckPrompt(ProfileRead.parse({ ...fb, platform: 'linkedin' }), null, context),
    ).not.toContain('<links_to_use>');
  });

  it('writes Alignable’s Elevator Pitches, its ideal customer and partner, and services not listed yet', () => {
    expect(ALIGNABLE_PROFILE_CHECK_SYSTEM).toContain('Elevator Pitches');
    expect(alCheck.bios).toEqual([
      'We keep Columbus homes dry: roof repairs and inspections, booked in a day.',
    ]);
    expect(alCheck.idealDraft).toEqual({
      customer: 'Homeowners in Columbus with older roofs',
      partner: null,
    });
    expect(alCheck.services).toEqual([
      { name: 'Roof inspections', words: 'A free look before storm season.' },
      { name: 'Gutter guards', words: null },
    ]);
    // Right as it is: nothing written.
    const right = checkedProfileCheck(
      alAnswer({ items: itemsOn('alignable') }) as never,
      al,
      AT,
      1,
      KNOWN,
    );
    expect(right.idealDraft).toBeUndefined();
    expect(right.services).toBeUndefined();
    // Facebook's work and links are never Alignable's.
    expect(alCheck.workDraft).toBeUndefined();
    expect(alCheck.linkChanges).toBeUndefined();
  });

  it('asks every network’s answer for its new parts, and keeps a check as it was', () => {
    expect(PROFILE_CHECK_SCHEMA.required).toEqual(
      expect.arrayContaining(['work', 'featurePost', 'linkChanges']),
    );
    expect(LINKEDIN_PROFILE_CHECK_SCHEMA.required).toEqual(
      expect.arrayContaining(['work', 'featurePost']),
    );
    expect(ALIGNABLE_PROFILE_CHECK_SCHEMA.required).toEqual(
      expect.arrayContaining(['bios', 'ideal', 'services']),
    );
    expect(profileCheckAsk('facebook').zod.safeParse(fbAnswer()).success).toBe(true);
    expect(profileCheckAsk('alignable').zod.safeParse(alAnswer()).success).toBe(true);
    expect(ProfileCheck.parse(fbCheck)).toEqual(fbCheck);
    expect(ProfileCheck.parse(alCheck)).toEqual(alCheck);
  });
});

describe('putting every part in', () => {
  const work = { title: 'Owner', company: 'Summit Roof Leads', words: null, since: '2021-03' };

  it('takes each in one edit, held to what the network has', () => {
    expect(
      AskInput.parse({
        kind: 'profile_edit',
        work,
        featured: { post: 'Five stars from the Parkers.' },
        linkChanges: [{ from: 'https://oldtiles.example.com' }],
      }),
    ).toMatchObject({
      work,
      featured: { post: 'Five stars from the Parkers.', link: null },
      linkChanges: [{ from: 'https://oldtiles.example.com', to: null }],
    });
    expect(
      AskInput.safeParse({ kind: 'profile_edit', work: { ...work, since: '2021-13' } }).success,
    ).toBe(false);
    expect(AskInput.safeParse({ kind: 'profile_edit', featured: {} }).success).toBe(false);
    expect(AskInput.safeParse({ kind: 'profile_edit', ideal: {} }).success).toBe(false);
    // What a computer gets: every part, empty where it's not asked.
    expect(AskTask.parse({ kind: 'profile_edit', work })).toMatchObject({
      work,
      featured: null,
      ideal: null,
      services: [],
      linkChanges: [],
    });
  });

  it('refuses a part the network doesn’t have, or one it wouldn’t take, saying what to do', () => {
    expect(profileEditWords('facebook', { work: { ...work, since: null } })).toBeNull();
    expect(profileEditWords('linkedin', { work: { ...work, since: null } })).toContain(
      'LinkedIn asks when you started',
    );
    expect(profileEditWords('linkedin', { work })).toBeNull();
    expect(profileEditWords('alignable', { work })).toContain('can’t be changed from here');
    expect(profileEditWords('instagram', { work })).toContain('can’t be changed from here');
    expect(profileEditWords('facebook', { featured: { link: 'https://cal.com/casey' } })).toContain(
      'features posts, not links',
    );
    expect(profileEditWords('linkedin', { featured: { link: 'cal.com/casey' } })).toContain(
      'isn’t a whole link',
    );
    expect(
      profileEditWords('linkedin', {
        featured: { post: 'Five stars.', link: 'https://cal.com/c' },
      }),
    ).toBeNull();
    expect(profileEditWords('facebook', { ideal: { customer: 'Homeowners' } })).toContain(
      'no ideal customer or services',
    );
    expect(profileEditWords('alignable', { services: [{ name: 'Inspections' }] })).toBeNull();
    expect(
      profileEditWords('linkedin', { linkChanges: [{ from: 'https://old.example.com' }] }),
    ).toContain('Only Facebook’s links');
    expect(
      profileEditWords('facebook', {
        linkChanges: [{ from: 'https://old.example.com', to: 'https://old.example.com' }],
      }),
    ).toContain('is already that link');
    expect(
      profileEditWords('facebook', {
        linkChanges: [{ from: 'https://old.example.com', to: 'summitroofleads.com' }],
      }),
    ).toContain('isn’t a whole link');
    expect(
      profileEditWords('linkedin', { work: { ...work, title: 'Owner of [your business]' } }),
    ).toContain('in your experience first');
    expect(
      profileEditWords('alignable', {
        services: [{ name: 'Inspections', words: 'In [your town]' }],
      }),
    ).toContain('in your services first');
  });

  it('asks an older build to update for them, as it never sees them', () => {
    expect(EVERY_PART_SINCE).toBe('0.98.0');
    expect(hasEveryPart('facebook', { bio: 'Roofers' })).toBe(false);
    expect(hasEveryPart('facebook', { links: ['https://cal.com/c'] })).toBe(false);
    expect(hasEveryPart('facebook', { work })).toBe(true);
    expect(hasEveryPart('facebook', { linkChanges: [{ from: 'https://old.example.com' }] })).toBe(
      true,
    );
    // Alignable's Elevator Pitch was the person's before it.
    expect(hasEveryPart('alignable', { bio: 'We fix roofs.' })).toBe(true);
    expect(hasEveryPart('alignable', { about: 'We fix roofs.' })).toBe(false);
  });

  it('says what went in, by each network’s names', () => {
    expect(profileEditDoneWords('linkedin', { work, featured: { post: 'x' } })).toBe(
      'Your Experience and Featured are in.',
    );
    expect(
      profileEditPartsWords('facebook', {
        work,
        featured: { post: 'x' },
        linkChanges: [{ from: 'https://old.example.com' }],
      }),
    ).toBe('your links, work and featured');
    expect(
      profileEditDoneWords('alignable', {
        bio: 'x',
        ideal: { customer: 'y' },
        services: [{ name: 'z' }],
      }),
    ).toBe('Your Elevator Pitch, ideal customer and partner and services are in.');
  });

  it('puts them in on a build from 0.98.0; an older one leaves them to the person', () => {
    for (const [platform, part, before] of [
      ['facebook', 'work', 'tip'],
      ['facebook', 'featured', 'tip'],
      ['linkedin', 'work', 'tip'],
      ['linkedin', 'featured', 'tip'],
      ['alignable', 'bio', 'tip'],
      ['alignable', 'work', 'tip'],
      ['alignable', 'featured', 'tip'],
      // LinkedIn's address and links were opened for them.
      ['linkedin', 'username', 'steps'],
      ['linkedin', 'links', 'steps'],
    ] as const) {
      expect(partHowFor(platform, part, '0.97.0')).toBe(before);
      expect(partHowFor(platform, part, EVERY_PART_SINCE)).toBe('auto');
      expect(partHowFor(platform, part)).toBe('auto');
    }
    expect(partHowFor('instagram', 'featured', EVERY_PART_SINCE)).toBe('tip');
  });

  it('hands a step it couldn’t find over with where it is and what to put in', () => {
    const line = 'Owner at Summit Roof Leads';
    expect(EVERY_PART_STEPS.work('linkedin', line)).toContain('Add position');
    expect(EVERY_PART_STEPS.work('linkedin', line)).toContain(`“${line}”`);
    expect(EVERY_PART_STEPS.work('facebook', line)).toContain('Add a workplace');
    expect(EVERY_PART_STEPS.featurePost('facebook', 'Five stars')).toContain('Pin post');
    expect(EVERY_PART_STEPS.featurePost('linkedin', 'Five stars')).toContain(
      'Feature on top of profile',
    );
    expect(EVERY_PART_STEPS.featureLink('https://cal.com/casey')).toContain('Add a link');
    expect(EVERY_PART_STEPS.linkOff('https://oldtiles.example.com')).toContain('Delete');
    expect(EVERY_PART_STEPS.pitch('We fix roofs.')).toContain('Elevator Pitch');
    expect(EVERY_PART_STEPS.ideal('partner', 'Plumbers')).toContain('My Ideal Referral Partner');
    expect(EVERY_PART_STEPS.service('Roof inspections')).toContain('Add a service');
    expect(EVERY_PART_STEPS.username('casey-lee')).toBe(
      partStepsWords('linkedin', 'username', 'casey-lee'),
    );
  });
});

describe('what the screen sends, from the AI’s and what’s typed', () => {
  it('reads when they started as a month and year, as typed', () => {
    for (const typed of ['March 2021', 'mar 2021', 'Mar. 2021', '3/2021', '2021-03', '2021-3'])
      expect(parseSince(typed)).toBe('2021-03');
    for (const typed of ['Ma 2021', '13/2021', '1900-01', 'soon', ''])
      expect(parseSince(typed)).toBeNull();
    expect(sinceWords('2021-03')).toBe('March 2021');
  });

  it('sends the work once LinkedIn has when they started; Facebook doesn’t need it', () => {
    const li = fbCheck;
    expect(workEdit('linkedin', li, '')).toEqual({
      edit: null,
      why: EVERY_PART_WORDS.sinceHint('linkedin'),
    });
    expect(workEdit('linkedin', li, 'soon')).toEqual({
      edit: null,
      why: EVERY_PART_WORDS.sinceBad,
    });
    expect(workEdit('linkedin', li, 'March 2021').edit).toMatchObject({
      title: 'Owner',
      company: 'Summit Roof Leads',
      since: '2021-03',
    });
    expect(workEdit('facebook', fbCheck, '').edit).toMatchObject({ title: 'Owner', since: null });
    expect(workEdit('alignable', fbCheck, 'March 2021')).toEqual({ edit: null, why: null });
    expect(workEdit('facebook', null, '')).toEqual({ edit: null, why: null });
  });

  it('features the best post, and on LinkedIn the booking link while Featured isn’t right', () => {
    const booking = { booking: { linkedin: 'https://cal.com/casey' } };
    expect(featuredEdit('facebook', fbCheck, booking)).toEqual({
      post: 'Five stars from the Parkers: fixed in a day.',
      link: null,
    });
    expect(featuredEdit('linkedin', fbCheck, booking)).toEqual({
      post: 'Five stars from the Parkers: fixed in a day.',
      link: 'https://cal.com/casey',
    });
    expect(featuredEdit('instagram', fbCheck, booking)).toBeNull();
    const none = ProfileCheck.parse({ ...fbCheck, featurePost: null });
    expect(featuredEdit('facebook', none, booking)).toBeNull();
  });

  it('offers the link changes only where the person’s computer can make them', () => {
    expect(linkChangesFor('facebook', fbCheck)).toEqual(fbCheck.linkChanges);
    expect(linkChangesFor('facebook', fbCheck, EVERY_PART_SINCE)).toEqual(fbCheck.linkChanges);
    // 0.93.0 to 0.97.0 put Facebook's links in, but never take one off.
    expect(linkChangesFor('facebook', fbCheck, '0.97.0')).toEqual([]);
    expect(linkChangesFor('facebook', fbCheck, null)).toEqual([]);
    expect(linkChangesFor('linkedin', fbCheck)).toEqual([]);
  });

  it('sends only the link changes left ticked', () => {
    expect(linkChangesEdit(fbCheck, new Set())).toEqual([]);
    expect(linkChangesEdit(fbCheck, new Set(['https://www.oldtiles.example.com/']))).toEqual([
      { from: 'https://www.oldtiles.example.com/', to: 'https://summitroofleads.com' },
    ]);
  });

  it('lists each new part with what goes in, by the build of the person’s computer', () => {
    const known = (platform: Platform, check: ProfileCheck): ProfilesKnown => ({
      checks: { [platform]: check },
      booking: { linkedin: 'https://cal.com/casey' },
      website: 'https://summitroofleads.com',
    });
    const rows = (platform: Platform, check: ProfileCheck, version?: string) =>
      Object.fromEntries(
        profileParts(platform, known(platform, check), version).map((r) => [r.part, r]),
      );
    const facebook = rows('facebook', fbCheck);
    expect(facebook.work).toMatchObject({
      ok: false,
      how: 'auto',
      next: ['Owner at Summit Roof Leads'],
    });
    expect(facebook.featured).toMatchObject({
      how: 'auto',
      next: ['“Five stars from the Parkers: fixed in a day.”'],
    });
    // A link to change keeps the links from being right.
    expect(facebook.links!.ok).toBe(false);
    // An older build can't put them in: the AI's words, as before.
    const older = rows('facebook', fbCheck, '0.97.0');
    expect(older.work).toMatchObject({ how: 'tip', next: [] });
    expect(older.featured).toMatchObject({ how: 'tip', next: fbCheck.feature });
    expect(rows('linkedin', fbCheck).featured!.next).toEqual([
      '“Five stars from the Parkers: fixed in a day.”',
      'https://cal.com/casey',
    ]);
    const alignable = rows('alignable', alCheck);
    expect(alignable.work!.next).toEqual([
      `${EVERY_PART_WORDS.customer}: Homeowners in Columbus with older roofs`,
    ]);
    expect(alignable.featured!.next).toEqual([
      'Roof inspections: A free look before storm season.',
      'Gutter guards',
    ]);
    expect(alignable.bio).toMatchObject({ how: 'auto' });
  });
});

describe('the read on its own, on the 1st of each month (answer 17a)', () => {
  it('is due once the latest read is from before this month’s 1st, by the computer’s clock', () => {
    expect(profileReadDue(null, new Date(2026, 10, 1, 9))).toBe(true);
    expect(profileReadDue(new Date(2026, 9, 31, 22).toISOString(), new Date(2026, 10, 1, 9))).toBe(
      true,
    );
    expect(profileReadDue(new Date(2026, 10, 1, 0, 5).toISOString(), new Date(2026, 10, 28))).toBe(
      false,
    );
    // A computer off on the 1st reads it the first day it works that month.
    expect(profileReadDue(new Date(2026, 9, 2).toISOString(), new Date(2026, 10, 3, 9))).toBe(true);
  });

  it('keeps that it was read on its own, and counts what the AI suggests for Today', () => {
    const own = checkedProfileCheck(
      fbAnswer({ bios: ['Booked inspections for Columbus roofers.'] }) as never,
      ProfileRead.parse({ ...fb, own: true }),
      AT,
      1,
      KNOWN,
    );
    expect(own.own).toBe(true);
    expect(fbCheck.own).toBeUndefined();
    // A read they asked for suggests nothing on Today: they're there to see it.
    expect(ownSuggestions(fbCheck)).toBe(0);
    // The bio (none was read, so it isn't right), the work, the post to feature and the link to change.
    expect(ownSuggestions(own)).toBe(4);
    expect(PROFILE_PART_WORDS.ownWaiting('facebook', 1)).toBe(
      'The AI read your Facebook profile on its own, and 1 change waits for your OK.',
    );
    expect(PROFILE_PART_WORDS.ownWaiting('linkedin', 3)).toContain('3 changes wait for your OK');
    expect(PROFILE_PART_WORDS.own('Nov 1')).toContain('Nothing changed on your profile');
    expect(TodayOutput.shape.profileOwn.parse(undefined)).toBeNull();
    expect(TodayOutput.shape.profileOwn.parse({ at: AT, parts: 3 })).toEqual({ at: AT, parts: 3 });
  });
});
