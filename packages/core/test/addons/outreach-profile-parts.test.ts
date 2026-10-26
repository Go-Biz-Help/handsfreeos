/**
 * The whole profile, part by part (decision 84): the AI's look at it, the names and usernames it writes held to each
 * network's rules, the links to add from what's known (never guessed), side by side, and Show me more with a note kept
 * for the next check. Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  AskInput,
  AskTask,
  askNameOn,
  askTarget,
  hasNewProfileParts,
  profileEditPartsWords,
  profileEditWords,
  tooOldFor,
  type AskAsked,
} from '../../src/addons/outreach/asks';
import {
  checkedProfileCheck,
  cleanUsername,
  nameProblem,
  PROFILE_ITEMS_ON,
  profileCheckAsk,
  profileCheckPrompt,
  profileCheckSystem,
  ProfileCheck,
  ProfileRead,
  shownUsername,
  splitName,
  usernameProblem,
  withHandles,
  withoutTracking,
} from '../../src/addons/outreach/profile-check';
import {
  carriedOver,
  checkedMore,
  linksToAdd,
  noteOf,
  partHowFor,
  partStepsWords,
  partHowOn,
  profileMatch,
  profileMorePrompt,
  profileParts,
  withMore,
  withUsernames,
  type ProfilesKnown,
} from '../../src/addons/outreach/profile-parts';

const ig = ProfileRead.parse({
  platform: 'instagram',
  url: 'https://www.instagram.com/caseyskates22/',
  name: 'Case',
  username: 'caseyskates22',
  picture: 'A profile photo Instagram didn’t describe',
  bio: 'Skating, tacos, my dog Juno',
  links: [],
  featured: ['Trips'],
  posts: ['Beach day.'],
});

const items = (platform: 'instagram' | 'facebook', ok = true) =>
  Object.fromEntries(PROFILE_ITEMS_ON[platform].map((i) => [i, { ok, why: 'x', fix: 'y' }]));

const igAnswer = {
  items: items('instagram', false),
  bios: ['Casey | Booked inspections for Columbus roofers. Book a call below.'],
  nameDraft: 'Casey | Booked jobs for Columbus roofers',
  feature: [],
  look: {
    reads: 'personal' as const,
    ok: true,
    title: 'This looks like a personal account with nothing about your work — yet.',
    clashes: ['Your bio is about skating and tacos.', '', 'Your name here is “Case”.'],
    unlike: ['name' as const, 'username' as const, 'name' as const],
  },
  names: ['“Casey | Booked jobs for Columbus roofers”', 'Case', 'n'.repeat(65)],
  usernames: ['@Casey.Roofs', 'caseyskates22', '.bad', 'casey_lee', 'casey.lee.roofing'],
};

const check = checkedProfileCheck(igAnswer as never, ig, '2026-10-22T10:00:00.000Z', 1);

describe('the whole profile, as the AI judges it', () => {
  it('asks every network for its look, and names no other network in its words', () => {
    for (const platform of ['facebook', 'linkedin', 'instagram', 'alignable'] as const) {
      expect(profileCheckSystem(platform)).toContain('never as a company or a brand page');
      expect(profileCheckSystem(platform)).toContain('<other_profiles>');
      const schema = profileCheckAsk(platform).schema as { required: string[] };
      expect(schema.required).toContain('look');
    }
    // Alignable is a business's profile: it writes no names or usernames.
    expect((profileCheckAsk('alignable').schema as { required: string[] }).required).not.toContain(
      'usernames',
    );
  });

  it('goes with the person’s other profiles, the business’s name and their notes, as data', () => {
    const prompt = profileCheckPrompt(ig, null, {
      business: 'Summit Roof Leads',
      others: [
        {
          platform: 'facebook',
          seen: {
            url: 'https://www.facebook.com/casey.lee',
            name: 'Casey Lee',
            username: 'casey.lee',
            line: 'I help roofers fill their calendars.',
            links: [],
          },
        },
      ],
      notes: { username: ['Just my name.'] },
    });
    expect(prompt).toContain('<business>Summit Roof Leads</business>');
    expect(prompt).toContain('name: Casey Lee');
    expect(prompt).toContain('- username: Just my name.');
    expect(prompt).toContain('username: caseyskates22');
    expect(prompt.endsWith('Score this Instagram profile.')).toBe(true);
    // Not known: said so, never left for the AI to fill in.
    expect(prompt).toContain('<you>(not known)</you>');
  });

  it('weighs the work against the network’s playbooks, and writes names from the person’s own', () => {
    const prompt = profileCheckPrompt(ig, null, {
      business: 'Summit Roof Leads',
      you: 'Casey Lee',
      playbooks: [
        {
          name: 'Roofers in Columbus',
          offer: 'A free 15-minute call',
          audience: 'Owners of roofing companies',
          niche: 'Roofers with 2 to 10 crew',
        },
      ],
      others: [],
      notes: {},
    });
    expect(prompt).toContain('<you>Casey Lee</you>');
    expect(prompt).toContain('- Roofers in Columbus: A free 15-minute call');
    expect(prompt).toContain('niche: Roofers with 2 to 10 crew');
    for (const platform of ['facebook', 'linkedin', 'instagram', 'alignable'] as const) {
      expect(profileCheckSystem(platform)).toContain('a different business, brand or line of work');
      expect(profileCheckSystem(platform)).toContain('never a word in square brackets');
      // Every name the business goes by is its own (the main offer's names, decision 84).
      expect(profileCheckSystem(platform)).toContain(
        'The business goes by every name under <business>',
      );
      expect(
        (profileCheckAsk(platform).schema as { properties: { look: { required: string[] } } })
          .properties.look.required,
      ).toContain('work');
    }
  });

  it('is never right when it’s about another business, even as a person', () => {
    const other = checkedProfileCheck(
      {
        ...igAnswer,
        look: {
          reads: 'person',
          work: 'other',
          ok: true,
          title: 'This reads as a person, but for a different business.',
          clashes: ['This account is about Smith Bakery, not the roofing leads you’re offering.'],
          unlike: [],
        },
      } as never,
      ig,
      '2026-10-23T10:00:00.000Z',
      1,
    );
    expect(other.look).toMatchObject({ reads: 'person', work: 'other', ok: false });
    expect(other.look?.clashes[0]).toContain('Smith Bakery');
    const same = checkedProfileCheck(
      { ...igAnswer, look: { ...igAnswer.look, reads: 'person', work: 'same', ok: true } } as never,
      ig,
      '2026-10-23T10:00:00.000Z',
      1,
    );
    expect(same.look).toMatchObject({ work: 'same', ok: true });
  });

  it('never keeps a name or username with a blank to fill in', () => {
    const blanks = checkedProfileCheck(
      {
        ...igAnswer,
        nameDraft: '[First name] | Helps [who] get [result]',
        names: ['[First name] | Roofing in Columbus', 'Casey Lee | Roofing leads'],
        usernames: ['[first.name].roofs', 'casey.lee.roofs'],
      } as never,
      ig,
      '2026-10-23T10:00:00.000Z',
      1,
    );
    expect(blanks.nameDraft).toBeNull();
    expect(blanks.names).toEqual(['Casey Lee | Roofing leads']);
    expect(blanks.usernames).toEqual([{ value: 'casey.lee.roofs', free: null }]);
    expect(checkedMore('instagram', 'name', ['[First name] | Roofs', 'Casey | Roofs'], [])).toEqual(
      ['Casey | Roofs'],
    );
    expect(checkedMore('instagram', 'username', ['[casey].roofs', 'casey.roofs'], [])).toEqual([
      'casey.roofs',
    ]);
  });

  it('is right only as a person who does this work, and keeps what it read of the parts compared', () => {
    expect(check.look).toEqual({
      reads: 'personal',
      // Not asked of this answer: a check from before it was.
      work: null,
      // Only `person` is right, whatever the AI said.
      ok: false,
      title: 'This looks like a personal account with nothing about your work, yet.',
      clashes: ['Your bio is about skating and tacos.', 'Your name here is “Case”.'],
      unlike: ['name', 'username'],
    });
    expect(check.seen).toEqual({
      url: 'https://www.instagram.com/caseyskates22/',
      name: 'Case',
      username: 'caseyskates22',
      line: 'Skating, tacos, my dog Juno',
      links: [],
    });
    expect(ProfileCheck.parse(check)).toEqual(check);
  });

  it('keeps names that fit, never the one there, and usernames that keep the network’s rules', () => {
    expect(check.names).toEqual(['Casey | Booked jobs for Columbus roofers']);
    expect(check.nameDraft).toBe('Casey | Booked jobs for Columbus roofers');
    // Cleaned, each once, never the one there or one Instagram wouldn't take; free not known yet.
    expect(check.usernames).toEqual([
      { value: 'casey.roofs', free: null },
      { value: 'casey_lee', free: null },
      { value: 'casey.lee.roofing', free: null },
    ]);
  });

  it('reads a check from before it as it was: no look, names or usernames', () => {
    const old = ProfileCheck.parse({
      items: {},
      bios: [],
      coverLine: null,
      feature: [],
      at: '2026-10-14T10:00:00.000Z',
      version: 1,
    });
    expect(old.look).toBeUndefined();
    expect(
      profileParts('facebook', { checks: { facebook: old }, booking: {}, website: null }),
    ).toHaveLength(9);
  });
});

describe('the username and links, from what was read', () => {
  it('works them out from the address and the lines that are addresses, for builds that don’t say them', () => {
    const fb = withHandles(
      ProfileRead.parse({
        platform: 'facebook',
        url: 'https://www.facebook.com/Casey.Lee.77',
        intro: ['Owner at Summit Roof Leads', 'summitroofleads.com', 'instagram.com/casey'],
      }),
    );
    expect(fb.username).toBe('casey.lee.77');
    expect(fb.links).toEqual(['https://summitroofleads.com', 'https://instagram.com/casey']);
    const li = withHandles(
      ProfileRead.parse({ platform: 'linkedin', url: 'https://www.linkedin.com/in/casey-lee/' }),
    );
    expect(li.username).toBe('casey-lee');
    const me = withHandles(
      ProfileRead.parse({ platform: 'facebook', url: 'https://www.facebook.com/profile.php?id=1' }),
    );
    expect(me.username).toBeNull();
    const ig = withHandles(
      ProfileRead.parse({
        platform: 'instagram',
        url: 'https://www.instagram.com/caseyskates22/',
        intro: ['Link: cal.com/casey'],
      }),
    );
    expect(ig).toMatchObject({ username: 'caseyskates22', links: ['https://cal.com/casey'] });
    // What the extension said stands.
    expect(
      withHandles(
        ProfileRead.parse({ platform: 'instagram', username: 'case', links: ['https://x.co'] }),
      ),
    ).toMatchObject({
      username: 'case',
      links: ['https://x.co'],
    });
  });

  it('takes the network’s tracking tag off each link, and keeps the person’s own', () => {
    const fb = withHandles(
      ProfileRead.parse({
        platform: 'facebook',
        links: [
          'http://start.summitroofleads.com/trial?fbclid=IwZXh0bgNhZW0CMTAAAR',
          'https://summitroofleads.com/book?utm_source=fb&fbclid=IwAR2x',
          'http://start.summitroofleads.com/trial',
        ],
      }),
    );
    expect(fb.links).toEqual([
      'http://start.summitroofleads.com/trial',
      'https://summitroofleads.com/book?utm_source=fb',
    ]);
    expect(withoutTracking('https://cal.com/casey')).toBe('https://cal.com/casey');
    expect(withoutTracking('not a link')).toBe('not a link');
  });
});

describe('usernames, on each network’s rules', () => {
  it('cleans what’s typed and holds each network to its own', () => {
    expect(cleanUsername(' @Casey.Roofs ')).toBe('casey.roofs');
    expect(cleanUsername('https://www.linkedin.com/in/casey-lee/')).toBe('casey-lee');
    expect(usernameProblem('instagram', 'casey.roofs')).toBeNull();
    expect(usernameProblem('instagram', 'casey..roofs')).toContain('Instagram usernames');
    expect(usernameProblem('facebook', 'abc')).toContain('5 to 50');
    expect(usernameProblem('linkedin', 'casey_lee')).toContain('hyphens');
    expect(usernameProblem('alignable', 'casey')).toContain('no username');
    expect(shownUsername('linkedin', 'casey-lee')).toBe('linkedin.com/in/casey-lee');
    expect(shownUsername('instagram', 'casey')).toBe('@casey');
  });

  it('checks them on the person’s computer, from 0.87.0, one check of the same ones at a time', () => {
    const ask = AskInput.parse({
      kind: 'username_check',
      usernames: ['@Casey.Roofs', 'casey_lee'],
    });
    expect(ask).toEqual({ kind: 'username_check', usernames: ['casey.roofs', 'casey_lee'] });
    expect(askTarget(ask as AskAsked)).toBe('usernames:casey.roofs,casey_lee');
    expect(AskInput.safeParse({ kind: 'username_check', usernames: [] }).success).toBe(false);
    expect(tooOldFor('0.86.0', 'username_check', 'instagram')).toBe(true);
    expect(tooOldFor('0.87.0', 'username_check', 'instagram')).toBe(false);
  });
});

describe('a profile’s name, username and links, put in or opened (decision 84)', () => {
  it('takes them in one edit, each held to the network’s rules', () => {
    const edit = AskInput.parse({
      kind: 'profile_edit',
      username: '@Casey.Roofs',
      links: ['https://cal.com/casey'],
    });
    expect(edit).toMatchObject({ username: 'casey.roofs', links: ['https://cal.com/casey'] });
    expect(AskTask.parse({ kind: 'profile_edit', name: 'Casey Lee' })).toMatchObject({
      name: 'Casey Lee',
      bio: null,
      links: [],
    });
    expect(hasNewProfileParts({ name: 'Casey Lee' })).toBe(true);
    expect(hasNewProfileParts({})).toBe(false);
    expect(profileEditWords('instagram', { username: 'casey..roofs' })).toContain(
      'Instagram usernames',
    );
    expect(profileEditWords('instagram', { links: ['cal.com/casey'] })).toContain(
      'isn’t a whole link',
    );
    expect(profileEditWords('alignable', { name: 'Casey' })).toContain(
      'can’t be changed from here',
    );
    expect(profileEditWords('facebook', { name: '[Your name]' })).toContain('in your name first');
    expect(
      profileEditWords('linkedin', { name: 'Casey Lee', links: ['https://cal.com/c'] }),
    ).toBeNull();
    expect(profileEditPartsWords('instagram', { bio: 'x', username: 'y', links: ['z'] })).toBe(
      'your bio, username and links',
    );
  });

  it('says who does each part: the computer, the page it opens, the app, or the person', () => {
    expect(partHowOn('linkedin', 'name')).toBe('auto');
    expect(partHowOn('linkedin', 'username')).toBe('steps');
    expect(partHowOn('instagram', 'links')).toBe('app');
    expect(partHowOn('facebook', 'picture')).toBe('tip');
    expect(partStepsWords('instagram', 'username', 'casey.roofs')).toContain(
      'Put in “casey.roofs”',
    );
    expect(partStepsWords('instagram', 'links', ['https://cal.com/c'])).toContain('Instagram app');
    // Pictures stay the person's: the steps say where, never that the extension does it.
    expect(partStepsWords('facebook', 'picture')).toContain('Upload photo');
  });

  it('puts Facebook’s bio, name, username and links in, and Instagram’s username and name (decision 89)', () => {
    expect(partHowOn('facebook', 'bio')).toBe('auto');
    expect(partHowOn('facebook', 'username')).toBe('auto');
    expect(partHowOn('facebook', 'links')).toBe('auto');
    expect(partHowOn('facebook', 'name')).toBe('auto');
    // The owner, 26 Oct 2026: "1a 2a 3a". Instagram's links stay in its app, and pictures stay the person's.
    expect(partHowOn('instagram', 'bio')).toBe('auto');
    expect(partHowOn('instagram', 'username')).toBe('auto');
    expect(partHowOn('instagram', 'name')).toBe('auto');
    expect(partHowOn('instagram', 'links')).toBe('app');
    expect(partHowOn('instagram', 'picture')).toBe('tip');
    expect(
      profileEditWords('facebook', {
        name: 'Casey Lee',
        username: 'casey.roofs',
        links: ['https://cal.com/c'],
      }),
    ).toBeNull();
    expect(
      profileEditWords('instagram', { name: 'Casey | Roofs', username: 'casey.roofs' }),
    ).toBeNull();
    // The words an older build hands them over with stay, for its computer's step, and the newest build's own.
    expect(partStepsWords('facebook', 'username', 'casey.roofs')).toContain('Put in “casey.roofs”');
    expect(partStepsWords('facebook', 'links', ['https://cal.com/c'])).toContain(
      'Edit links on the Links card',
    );
    const name = partStepsWords('facebook', 'name', 'Casey Lee');
    expect(name).toContain('Put “Casey” in First name and “Lee” in Last name');
    expect(name).toContain('Review change, then Done');
    expect(partStepsWords('facebook', 'name')).toContain('then Name. Change it, then press');
    expect(partStepsWords('instagram', 'name', 'Casey | Roofs')).toContain(
      'Put in “Casey | Roofs”',
    );
    expect(askNameOn('profile_edit', 'facebook')).toBe('Update your profile');
  });

  it('says an older build hands what it didn’t put in over, as its own copy does', () => {
    // 0.93.0 put Facebook's username and links in, and 0.94.0 its name and Instagram's username and name too.
    for (const [platform, part, since, before] of [
      ['facebook', 'username', '0.93.0', '0.92.0'],
      ['facebook', 'links', '0.93.0', '0.92.0'],
      ['facebook', 'name', '0.94.0', '0.93.0'],
      ['instagram', 'username', '0.94.0', '0.93.0'],
      ['instagram', 'name', '0.94.0', '0.93.0'],
    ] as const) {
      expect(partHowFor(platform, part, before)).toBe('steps');
      expect(partHowFor(platform, part, since)).toBe('auto');
      expect(partHowFor(platform, part, '1.0.0')).toBe('auto');
      // No computer known: the newest build's. One that didn't say its build is taken as older.
      expect(partHowFor(platform, part)).toBe('auto');
      expect(partHowFor(platform, part, null)).toBe('steps');
    }
    // A part that went in by itself before is the same on any build.
    expect(partHowFor('facebook', 'bio', '0.87.0')).toBe('auto');
    expect(partHowFor('instagram', 'bio', '0.80.0')).toBe('auto');
    expect(partHowFor('linkedin', 'name', '0.87.0')).toBe('auto');
    // One that doesn't go in by itself is the same on any build too.
    expect(partHowFor('instagram', 'links', '0.93.0')).toBe('app');
    expect(partHowFor('linkedin', 'username', '0.93.0')).toBe('steps');
    expect(partHowFor('facebook', 'picture', '0.92.0')).toBe('tip');
  });
});

describe('a name, on Facebook’s name standards (decision 89)', () => {
  it('takes a real first and last name in letters only, and says what to take out', () => {
    expect(nameProblem('facebook', 'Casey Lee')).toBeNull();
    expect(nameProblem('facebook', 'Zoë O’Brien-Núñez')).toBeNull();
    expect(nameProblem('facebook', 'J. R. Lee')).toBeNull();
    expect(nameProblem('facebook', 'Casey Owner | Roofs')).toBe(
      'Facebook names use letters only, so take out “|” from “Casey Owner | Roofs”. Pick another under Name with Show me more on the web, then put it in.',
    );
    expect(nameProblem('facebook', 'Casey Lee 2')).toContain('take out “2”');
    expect(nameProblem('facebook', 'Casey')).toContain('a first and last name');
    expect(nameProblem('facebook', ' ')).toBe('Type a name first.');
    // Instagram's name says what they do, and is held only to its length.
    expect(nameProblem('instagram', 'Casey | Roofs in Columbus')).toBeNull();
    expect(nameProblem('linkedin', 'Casey')).toBeNull();
  });

  it('is split as the boxes take it: the first word, then the rest', () => {
    expect(splitName(' Casey  Lee ')).toEqual({ first: 'Casey', last: 'Lee' });
    expect(splitName('Mary Ann Smith')).toEqual({ first: 'Mary', last: 'Ann Smith' });
    expect(splitName('Casey')).toEqual({ first: 'Casey', last: '' });
    expect(splitName('')).toEqual({ first: '', last: '' });
  });

  it('refuses one Facebook won’t take before it’s asked, and keeps none the AI writes', () => {
    expect(profileEditWords('facebook', { name: 'Casey Owner | Roofs' })).toContain(
      'Facebook names use letters only',
    );
    expect(profileEditWords('facebook', { name: 'Casey' })).toContain('a first and last name');
    // One with a blank says to fill it in first, as before.
    expect(profileEditWords('facebook', { name: '[First name] Lee' })).toContain(
      'in your name first',
    );
    const fb = checkedProfileCheck(
      {
        ...igAnswer,
        items: items('facebook', false),
        names: ['Casey | Roofs', 'Casey Lee', 'Casey'],
      } as never,
      ProfileRead.parse({ platform: 'facebook', url: 'https://www.facebook.com/casey.lee' }),
      '2026-10-26T10:00:00.000Z',
      1,
    );
    expect(fb.names).toEqual(['Casey Lee']);
    expect(checkedMore('facebook', 'name', ['Casey | Roofs', 'Casey Lee'], [])).toEqual([
      'Casey Lee',
    ]);
  });
});

const known = (more: Partial<ProfilesKnown> = {}): ProfilesKnown => ({
  checks: {
    instagram: check,
    facebook: ProfileCheck.parse({
      ...check,
      look: { reads: 'person', ok: true, title: 'Reads as you.', clashes: [], unlike: [] },
      seen: {
        url: 'https://www.facebook.com/casey.lee',
        name: 'Casey Lee',
        username: 'casey.lee',
        line: 'I help roofers fill their calendars.',
        links: ['https://cal.com/casey'],
      },
      names: [],
      usernames: [],
    }),
  },
  booking: { instagram: 'https://cal.com/casey', facebook: 'https://cal.com/casey' },
  website: 'https://summitroofleads.com',
  ...more,
});

describe('the links to add', () => {
  it('come from the playbook, the website and the person’s own other profiles, never guessed', () => {
    expect(linksToAdd('instagram', known())).toEqual([
      { kind: 'booking', platform: null, url: 'https://cal.com/casey', held: false },
      { kind: 'website', platform: null, url: 'https://summitroofleads.com', held: false },
      {
        kind: 'profile',
        platform: 'facebook',
        url: 'https://www.facebook.com/casey.lee',
        held: false,
      },
    ]);
  });

  it('leave out what’s there, and hold back a profile that doesn’t read as them yet', () => {
    const fb = linksToAdd('facebook', known());
    // The booking link is there already (without its https, the same).
    expect(fb.map((l) => l.kind)).toEqual(['website', 'profile']);
    expect(fb[1]).toMatchObject({ platform: 'instagram', held: true });
  });
});

describe('the parts, as the screen lists them', () => {
  it('lists a network’s parts in order, each as it is, as written, and who does it', () => {
    const rows = profileParts('instagram', known());
    expect(rows.map((r) => r.part)).toEqual([
      'bio',
      'links',
      'username',
      'name',
      'picture',
      'featured',
      'posts',
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.part, r]));
    expect(by.bio).toMatchObject({ ok: false, now: 'Skating, tacos, my dog Juno', how: 'auto' });
    expect(by.username).toMatchObject({
      name: 'Username',
      ok: false,
      now: 'caseyskates22',
      next: ['casey.roofs', 'casey_lee', 'casey.lee.roofing'],
      how: 'auto',
    });
    expect(by.links).toMatchObject({ ok: false, how: 'app' });
    expect(by.links!.next).toHaveLength(3);
    expect(by.name).toMatchObject({
      now: 'Case',
      next: ['Casey | Booked jobs for Columbus roofers'],
      how: 'auto',
    });
    expect(by.picture!.how).toBe('tip');
    // A computer before 0.94.0 hands its username and name over (decision 89).
    const older = Object.fromEntries(
      profileParts('instagram', known(), '0.93.0').map((r) => [r.part, r.how]),
    );
    expect(older).toMatchObject({ bio: 'auto', links: 'app', username: 'steps', name: 'steps' });
  });

  it('says who does each by the build of the person’s computer, when it’s known', () => {
    const how = (version?: string | null) =>
      Object.fromEntries(profileParts('facebook', known(), version).map((r) => [r.part, r.how]));
    expect(how()).toMatchObject({ bio: 'auto', links: 'auto', username: 'auto', name: 'auto' });
    expect(how('0.94.0')).toMatchObject({ links: 'auto', username: 'auto', name: 'auto' });
    // 0.93.0 put the username and links in, and still hands the name over.
    expect(how('0.93.0')).toMatchObject({ links: 'auto', username: 'auto', name: 'steps' });
    expect(how('0.92.0')).toMatchObject({
      bio: 'auto',
      links: 'steps',
      username: 'steps',
      name: 'steps',
    });
  });

  it('calls a username and a name right when nothing’s unlike the other profiles and none is written', () => {
    const fb = Object.fromEntries(profileParts('facebook', known()).map((r) => [r.part, r]));
    expect(fb.username!.ok).toBe(true);
    expect(fb.name!.ok).toBe(true);
    expect(profileParts('linkedin', known()).map((r) => r.name)).toContain('Profile address');
  });
});

describe('side by side', () => {
  it('shows each checked network, its parts unlike the others marked, with no way to book a link off', () => {
    const cols = profileMatch(known());
    expect(cols.map((c) => c.platform)).toEqual(['facebook', 'instagram']);
    expect(cols[0]).toMatchObject({ ok: true, off: [] });
    expect(cols[1]).toMatchObject({
      ok: false,
      values: { name: 'Case', username: 'caseyskates22', link: null },
      off: ['name', 'username', 'link'],
    });
  });

  it('shows Alignable beside the rest, and a network that’s on but not read yet', () => {
    const alignable = ProfileCheck.parse({
      ...check,
      seen: {
        url: 'https://www.alignable.com/columbus-oh/summit-roof-leads',
        name: 'Casey Lee',
        username: null,
        line: null,
        links: [],
      },
    });
    const cols = profileMatch(known({ checks: { ...known().checks, alignable } }), [
      'facebook',
      'linkedin',
    ]);
    expect(cols.map((c) => c.platform)).toEqual(['facebook', 'linkedin', 'instagram', 'alignable']);
    expect(cols[1]).toMatchObject({ platform: 'linkedin', checked: false, ok: null });
    expect(cols[3]).toMatchObject({
      checked: true,
      values: { name: 'Casey Lee', username: null },
    });
  });
});

describe('show me more, with a note', () => {
  it('keeps the chips and words as one note', () => {
    expect(noteOf(['Shorter', 'Just my name'], ' people know me as Danny. ')).toBe(
      'Shorter. Just my name. people know me as Danny.',
    );
    expect(noteOf([], '  ')).toBeNull();
  });

  it('tells the AI what came before and what they want', () => {
    const prompt = profileMorePrompt({
      platform: 'instagram',
      part: 'username',
      offer: null,
      business: null,
      seen: check.seen!,
      before: ['casey.roofs'],
      notes: ['Shorter.'],
    });
    expect(prompt).toContain('- casey.roofs');
    expect(prompt).toContain('- Shorter.');
    expect(prompt).toContain('What to write: 3 new username: Instagram usernames');
    expect(prompt.endsWith('Write the options.')).toBe(true);
  });

  it('keeps only new options that fit the part', () => {
    expect(
      checkedMore(
        'instagram',
        'username',
        ['@CaseyL', 'casey.roofs', 'bad..one', 'caseyl', 'c.lee', 'x_y'],
        ['casey.roofs'],
      ),
    ).toEqual(['caseyl', 'c.lee', 'x_y']);
    expect(
      checkedMore('facebook', 'bio', ['“A short bio — that fits.”', 'b'.repeat(102)], []),
    ).toEqual(['A short bio, that fits.']);
    expect(checkedMore('linkedin', 'about', ['One.', 'Two.'], [])).toEqual(['One.']);
  });

  it('puts the new ones first, keeps the ones before, and the note for next time', () => {
    const more = withMore(check, 'bio', ['New one.', 'Another.'], 'Warmer.');
    expect(more.bios).toEqual(['New one.', 'Another.']);
    expect(more.earlier?.bio).toEqual(check.bios);
    expect(more.notes).toEqual({ bio: ['Warmer.'] });
    const names = withMore(check, 'name', ['Casey Lee'], null);
    expect(names).toMatchObject({ names: ['Casey Lee'], nameDraft: 'Casey Lee' });
    const users = withMore(check, 'username', ['caseyl'], 'Shorter.');
    expect(users.usernames!.map((u) => u.value)).toEqual([
      'caseyl',
      'casey.roofs',
      'casey_lee',
      'casey.lee.roofing',
    ]);
    expect(ProfileCheck.parse(users)).toEqual(users);
  });

  it('keeps what the computer found of usernames, and a new check keeps the notes and what it found', () => {
    const found = withUsernames(check, [
      { value: 'casey.roofs', free: false },
      { value: 'caseyl', free: true },
    ]);
    expect(found.usernames!.slice(0, 2)).toEqual([
      { value: 'caseyl', free: true },
      { value: 'casey.roofs', free: false },
    ]);
    const noted = withMore(found, 'username', [], 'Just my name.');
    const next = carriedOver(check, noted);
    expect(next.notes).toEqual({ username: ['Just my name.'] });
    expect(next.usernames![0]).toEqual({ value: 'casey.roofs', free: false });
    expect(carriedOver(check, null)).toBe(check);
  });
});
