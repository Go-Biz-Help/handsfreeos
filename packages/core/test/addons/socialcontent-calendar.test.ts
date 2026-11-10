/**
 * AI Social Media Content Creator's own posts (docs/socialcontent.md, "Making posts"; decisions 13 to 20): the
 * posting plan, the open days it leaves, what a post still needs before it can be OK'd, and checking what the AI
 * writes and designs. No database.
 */
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_BYTES, FileBeginUploadInput } from '../../src/schemas/file';
import {
  CALENDAR,
  DEFAULT_PLAN,
  emptySlots,
  formatFor,
  placesFor,
  placesLeft,
  planOf,
  POSTING,
  postText,
  slotsAhead,
  stillNeeds,
  type ReadyCheck,
} from '../../src/addons/socialcontent/calendar';
import { postingLines } from '../../src/addons/socialcontent/words';
import {
  checkedDesign,
  checkedPost,
  designOf,
  photoPromptFor,
  tidyHashtags,
  type DesignAnswer,
  type WriteAnswer,
} from '../../src/addons/socialcontent/posts-ai';

const TZ = 'America/Chicago';
/** Tuesday 10 November 2026, noon in Chicago. */
const NOW = Date.parse('2026-11-10T18:00:00Z');

describe('the posting plan', () => {
  it('fills in the default for anything missing or wrong', () => {
    expect(planOf(null)).toEqual(DEFAULT_PLAN);
    expect(planOf('junk')).toEqual(DEFAULT_PLAN);
    const plan = planOf({
      instagram: { perWeek: 9, time: '25:00' },
      facebook: { perWeek: -2, time: '24:00' },
      linkedin: { perWeek: 2.6, time: '07:30' },
    });
    expect(plan.instagram).toEqual({
      perWeek: CALENDAR.perWeekMost,
      time: DEFAULT_PLAN.instagram.time,
    });
    expect(plan.facebook).toEqual({ perWeek: 0, time: DEFAULT_PLAN.facebook.time });
    expect(plan.linkedin).toEqual({ perWeek: 3, time: '07:30' });
  });

  it('spreads 3 a week over Monday, Wednesday and Friday, from tomorrow, at the plan’s time in the business’s zone', () => {
    const plan = planOf({
      instagram: { perWeek: 3, time: '09:00' },
      facebook: { perWeek: 0 },
      linkedin: { perWeek: 0 },
    });
    const slots = slotsAhead(plan, TZ, NOW);
    expect(slots.map((s) => s.date)).toEqual([
      '2026-11-11',
      '2026-11-13',
      '2026-11-16',
      '2026-11-18',
      '2026-11-20',
      '2026-11-23',
    ]);
    expect(slots.every((s) => s.network === 'instagram')).toBe(true);
    // 9 AM in Chicago in November is 15:00 UTC.
    expect(new Date(slots[0]!.at).toISOString()).toBe('2026-11-11T15:00:00.000Z');
  });

  it('leaves today out, and puts every network’s slots in time order', () => {
    const slots = slotsAhead(DEFAULT_PLAN, TZ, NOW, 7);
    expect(slots.some((s) => s.date === '2026-11-10')).toBe(false);
    const times = slots.map((s) => s.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(slots.filter((s) => s.network === 'instagram')).toHaveLength(3);
    expect(slots.filter((s) => s.network === 'linkedin')).toHaveLength(2);
  });

  it('counts a day as open again once its post is skipped, and ignores posts with no day', () => {
    const plan = planOf({
      instagram: { perWeek: 3, time: '09:00' },
      facebook: { perWeek: 0 },
      linkedin: { perWeek: 0 },
    });
    const slots = slotsAhead(plan, TZ, NOW);
    const open = emptySlots(
      slots,
      [
        { network: 'instagram', postAt: Date.parse('2026-11-13T15:00:00Z'), state: 'draft' },
        { network: 'instagram', postAt: new Date('2026-11-16T20:00:00Z'), state: 'skipped' },
        { network: 'facebook', postAt: Date.parse('2026-11-18T15:00:00Z'), state: 'ready' },
        { network: 'instagram', postAt: null, state: 'draft' },
      ],
      TZ,
    );
    expect(open.map((s) => s.date)).toEqual([
      '2026-11-11',
      '2026-11-16',
      '2026-11-18',
      '2026-11-20',
      '2026-11-23',
    ]);
  });
});

describe('what a post still needs', () => {
  const ready: ReadyCheck = {
    network: 'instagram',
    format: 'photo',
    words: 'Three ways to save time this week.',
    slides: [],
    fileIds: ['f1'],
    videos: 0,
    postAt: '2026-11-11T15:00:00Z',
    facebookWhere: [],
  };

  it('needs nothing when it has words, a picture and a day', () => {
    expect(stillNeeds(ready)).toBeNull();
  });

  it('says the one thing missing, in words', () => {
    expect(stillNeeds({ ...ready, fileIds: [] })).toMatch(/no picture/);
    expect(stillNeeds({ ...ready, postAt: null })).toMatch(/no day/);
    expect(stillNeeds({ ...ready, format: 'text', words: '  ' })).toMatch(/no words/);
    expect(stillNeeds({ ...ready, format: 'carousel', slides: [{}], fileIds: ['f1'] })).toMatch(
      /at least 2/,
    );
    expect(
      stillNeeds({ ...ready, format: 'carousel', slides: [{}, {}], fileIds: ['f1', 'f2'] }),
    ).toBeNull();
  });

  it('needs the person’s own video for a video post (part 10)', () => {
    expect(stillNeeds({ ...ready, format: 'video', fileIds: [] })).toMatch(/no video yet/);
    expect(stillNeeds({ ...ready, format: 'video', fileIds: ['v1'], videos: 1 })).toBeNull();
    // The video is kept as a file on the post, as phones record it, up to 25 MB.
    for (const mimeType of ['video/mp4', 'video/quicktime', 'video/webm'])
      expect(
        FileBeginUploadInput.safeParse({
          workspaceId: '00000000-0000-4000-8000-000000000001',
          recordType: 'custom_record',
          recordId: '00000000-0000-4000-8000-000000000002',
          name: 'tip.mov',
          mimeType,
          sizeBytes: ATTACHMENT_MAX_BYTES,
        }).success,
      ).toBe(true);
  });

  it('asks where on Facebook, and for the Page’s link before posting to the Page', () => {
    const fb: ReadyCheck = { ...ready, network: 'facebook', facebookWhere: [] };
    expect(stillNeeds(fb)).toMatch(/where on Facebook/);
    expect(stillNeeds({ ...fb, facebookWhere: ['profile'] })).toBeNull();
    expect(stillNeeds({ ...fb, facebookWhere: ['profile', 'page'] })).toMatch(/Settings → Posting/);
    expect(
      stillNeeds({
        ...fb,
        facebookWhere: ['page'],
        facebookPage: 'https://www.facebook.com/example',
      }),
    ).toBeNull();
  });

  it('never posts words alone on Instagram', () => {
    expect(formatFor('instagram', 'text')).toBe('photo');
    expect(formatFor('linkedin', 'text')).toBe('text');
  });
});

const answer = (over: Partial<WriteAnswer> = {}): WriteAnswer => ({
  title: 'Save an hour a day',
  format: 'photo',
  hook: 'You’re losing an hour a day to texts.',
  words: 'Here’s how to get it back.\n\nSave this for later. #crm #automation',
  hashtags: ['#CRM', 'crm', 'small business', 'automation'],
  slides: [],
  script: null,
  picture: 'A phone full of unread texts on a desk.',
  pictureWay: 'photo',
  photoPrompt: 'A phone full of unread texts on a wooden desk, morning light.',
  ...over,
});

describe('checking what the AI writes', () => {
  it('keeps hashtags apart from the words, tidied and once each', () => {
    const post = checkedPost(answer(), 'instagram')!;
    expect(post.words).toBe('Here’s how to get it back.\n\nSave this for later.');
    expect(post.hashtags).toEqual(['CRM', 'smallbusiness', 'automation']);
    expect(tidyHashtags(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('turns words alone into a picture post on Instagram', () => {
    expect(checkedPost(answer({ format: 'text' }), 'instagram')!.format).toBe('photo');
    const onLinkedIn = checkedPost(answer({ format: 'text' }), 'linkedin')!;
    expect(onLinkedIn.format).toBe('text');
    expect(onLinkedIn.pictureWay).toBe('own');
  });

  it('designs a carousel’s slides, and makes one of fewer than 2 slides a picture post', () => {
    const two = checkedPost(
      answer({
        format: 'carousel',
        slides: [
          { heading: 'One', body: 'a' },
          { heading: 'Two', body: 'b' },
        ],
      }),
      'instagram',
    )!;
    expect(two.format).toBe('carousel');
    expect(two.slides).toHaveLength(2);
    expect(two.pictureWay).toBe('design');
    const one = checkedPost(
      answer({ format: 'carousel', slides: [{ heading: 'One', body: 'a' }] }),
      'instagram',
    )!;
    expect(one.format).toBe('photo');
    expect(one.slides).toEqual([]);
  });

  it('designs the picture when a photo-style one has nothing to ask for', () => {
    expect(checkedPost(answer({ photoPrompt: null }), 'instagram')!.pictureWay).toBe('design');
    expect(checkedPost(answer(), 'instagram')!.pictureWay).toBe('photo');
  });

  it('leaves a video to the person, with its script', () => {
    const video = checkedPost(
      answer({ format: 'video', script: { lines: ['Hi', ''], shots: ['Me at my desk'] } }),
      'instagram',
    )!;
    expect(video.pictureWay).toBe('own');
    expect(video.script).toEqual({ lines: ['Hi'], shots: ['Me at my desk'] });
  });

  it('keeps nothing when the AI wrote nothing', () => {
    expect(checkedPost(answer({ words: '   ', slides: [] }), 'facebook')).toBeNull();
  });
});

const design = (over: Partial<DesignAnswer> = {}): DesignAnswer => ({
  style: 'split',
  background: '#ffffff',
  text: '#111111',
  accent: '#2d69d8',
  pages: [
    {
      kicker: 'Tip 1',
      heading: 'Answer in five minutes',
      body: 'Leads go cold fast.',
      footer: null,
    },
    { kicker: 'Tip 2', heading: 'Follow up twice', body: null, footer: null },
  ],
  ...over,
});

describe('checking what the AI designs', () => {
  it('keeps a style it knows, colours that read, and only the pages wanted', () => {
    const d = checkedDesign(design({ style: 'wavy', text: '#fefefe' }), '#2d69d8', 1)!;
    expect(d.style).toBe('bold');
    // Near-white words on white don't read, so they become near black.
    expect(d.text).not.toBe('#fefefe');
    expect(d.pages).toHaveLength(1);
  });

  it('falls back to the business’s colour, and keeps nothing without a heading', () => {
    const d = checkedDesign(
      design({ style: 'bold', background: 'blue', accent: '' }),
      '#AA3300',
      2,
    )!;
    expect(d.background).toBe('#aa3300');
    expect(d.accent).toBe('#aa3300');
    expect(
      checkedDesign(
        design({ pages: [{ kicker: null, heading: ' ', body: 'x', footer: null }] }),
        '#2d69d8',
        1,
      ),
    ).toBeNull();
  });

  it('reads a kept design back the same', () => {
    const d = checkedDesign(design(), '#2d69d8', 2)!;
    expect(designOf(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(designOf(null)).toBeNull();
    expect(designOf({ pages: 'no' })).toBeNull();
  });

  it('asks the image AI for a lifelike picture with no words in it', () => {
    const prompt = photoPromptFor('A plumber fixing a sink.', 'make it brighter');
    expect(prompt).toContain('A plumber fixing a sink.');
    expect(prompt).toContain('Also: make it brighter');
    expect(prompt).toMatch(/No words, letters, logos/);
  });
});

describe('putting posts up (part 9)', () => {
  it('goes to the profile, the Page or both on Facebook, and the feed elsewhere', () => {
    expect(placesFor('facebook', ['page', 'profile'])).toEqual(['profile', 'page']);
    expect(placesFor('facebook', [])).toEqual(['profile']);
    expect(placesFor('linkedin', ['profile'])).toEqual(['feed']);
    expect(placesFor('instagram', [])).toEqual(['feed']);
  });

  it('never puts it up again where it went up already', () => {
    expect(placesLeft('facebook', ['profile', 'page'], [{ place: 'profile' }])).toEqual(['page']);
    expect(placesLeft('linkedin', [], [{ place: 'feed' }])).toEqual([]);
  });

  it('adds the hashtags after a blank line, and keeps within what the network takes', () => {
    expect(postText('facebook', '  Three ways to save time. ', ['crm', '#automation'])).toBe(
      'Three ways to save time.\n\n#crm #automation',
    );
    expect(postText('linkedin', 'Words only', [])).toBe('Words only');
    const long = postText('linkedin', 'x'.repeat(3_500), ['tag']);
    expect(long.length).toBeLessThanOrEqual(POSTING.textMost.linkedin);
    expect(long.endsWith('…\n\n#tag')).toBe(true);
  });

  it('posts on Facebook and LinkedIn (part 9), and Instagram (part 10)', () => {
    expect(POSTING.networks).toEqual(['facebook', 'linkedin', 'instagram']);
  });

  it('says whose computer puts the OK’d posts up, and warns when it’s quiet or there’s none', () => {
    const name = (n: string) => n.toUpperCase();
    const base = { ready: 2, postsOn: ['facebook', 'linkedin'], posts: [] };
    expect(postingLines({ ...base, poster: null }, name).map((l) => l.warn)).toEqual([false, true]);
    const fresh = postingLines(
      {
        ...base,
        poster: { name: 'Sam', mine: false, seenAt: new Date(NOW - 60_000).toISOString() },
      },
      name,
      NOW,
    );
    expect(fresh).toHaveLength(2);
    expect(fresh[1]!.text).toMatch(/Sam’s computer/);
    const quiet = postingLines(
      {
        ...base,
        poster: { name: null, mine: true, seenAt: new Date(NOW - 3_600_000).toISOString() },
      },
      name,
      NOW,
    );
    expect(quiet.at(-1)!.warn).toBe(true);
    expect(quiet.at(-1)!.text).toMatch(/1 hour ago/);
    const later = postingLines(
      {
        ready: 0,
        poster: null,
        postsOn: ['facebook'],
        posts: [{ network: 'instagram', state: 'draft' }],
      },
      name,
      NOW,
    );
    expect(later).toEqual([
      { text: expect.stringMatching(/INSTAGRAM comes in a later update/), warn: false },
    ]);
  });
});
