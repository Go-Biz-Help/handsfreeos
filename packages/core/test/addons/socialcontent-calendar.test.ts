/**
 * AI Social Media Content Creator's own posts (docs/socialcontent.md, "Making posts"; decisions 13 to 20): the
 * posting plan, the open days it leaves, what a post still needs before it can be OK'd, and checking what the AI
 * writes and designs. No database.
 */
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_BYTES, FileBeginUploadInput } from '../../src/schemas/file';
import {
  AI_FORMATS,
  CALENDAR,
  DEFAULT_PLAN,
  formatFor,
  placesFor,
  placesLeft,
  planOf,
  POSTING,
  postsAWeek,
  postText,
  stillNeeds,
  weekOf,
  type ReadyCheck,
} from '../../src/addons/socialcontent/calendar';
import {
  clockOf,
  clockShown,
  dayShown,
  daysUntil,
  filledLine,
  planShown,
  postingLines,
  timeShown,
} from '../../src/addons/socialcontent/words';
import {
  checkedDesign,
  checkedPost,
  designOf,
  photoPromptFor,
  tidyHashtags,
  WRITE_SCHEMA,
  WRITE_SYSTEM,
  type DesignAnswer,
  type WriteAnswer,
} from '../../src/addons/socialcontent/posts-ai';

/** Tuesday 10 November 2026, noon in Chicago. */
const NOW = Date.parse('2026-11-10T18:00:00Z');

describe('the posting plan', () => {
  it('fills in the default for anything missing or wrong', () => {
    expect(planOf(null)).toEqual(DEFAULT_PLAN);
    expect(planOf('junk')).toEqual(DEFAULT_PLAN);
    const plan = planOf({
      instagram: { mode: 'ai', perWeek: 99, perDay: 9, from: '25:00', to: '07:30' },
      facebook: {
        mode: 'mine',
        perWeek: -2,
        week: [['09:00', 'nope', '09:00'], [], [], [], [], [], []],
      },
      linkedin: { mode: 'ai', perWeek: 9, perDay: 1, from: '10:00', to: '10:30' },
    });
    expect(plan.instagram).toMatchObject({
      mode: 'ai',
      perWeek: CALENDAR.perWeekMost,
      perDay: CALENDAR.perDayMost,
      from: DEFAULT_PLAN.instagram.from,
      to: DEFAULT_PLAN.instagram.to,
    });
    expect(plan.facebook.mode).toBe('mine');
    expect(plan.facebook.perWeek).toBe(0);
    expect(plan.facebook.week[0]).toEqual(['09:00']);
    expect(postsAWeek(plan.facebook)).toBe(1);
    // 9 a week don't fit in 1 a day; hours under an hour apart go back to the default.
    expect(plan.linkedin).toMatchObject({ perWeek: 7, perDay: 1, from: '07:00', to: '20:00' });
  });

  it('turns a plan kept before 12 Nov into AI picks with its number, near its time, with its days for I pick', () => {
    const plan = planOf({
      instagram: { perWeek: 3, time: '09:00' },
      facebook: { perWeek: 2, time: '12:30' },
      linkedin: { perWeek: 0, time: '08:00' },
    });
    expect(plan.instagram).toEqual({
      mode: 'ai',
      perWeek: 3,
      perDay: null,
      from: '07:00',
      to: '20:00',
      time: '09:00',
      week: [[], ['09:00'], [], ['09:00'], [], ['09:00'], []],
    });
    expect(plan.facebook.week).toEqual(weekOf(2, '12:30'));
    expect(postsAWeek(plan.linkedin)).toBe(0);
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
  picture: 'A phone full of unread texts on a desk.',
  pictureWay: 'photo',
  photoPrompt: 'A phone full of unread texts on a wooden desk, morning light.',
  angle: null,
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

  it('designs a carousel’s slides, a photo under the first when asked, and makes one of fewer than 2 slides a picture post', () => {
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
    expect(two.pictureWay).toBe('photo');
    const slides = [
      { heading: 'One', body: 'a' },
      { heading: 'Two', body: 'b' },
    ];
    expect(
      checkedPost(answer({ format: 'carousel', slides, pictureWay: 'own' }), 'instagram')!
        .pictureWay,
    ).toBe('design');
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

  it('never keeps a video: one the AI still answers with is a picture post (the owner, 11 Nov)', () => {
    expect(AI_FORMATS).not.toContain('video');
    expect((WRITE_SCHEMA['properties'] as { format: { enum: string[] } }).format.enum).toEqual([
      ...AI_FORMATS,
    ]);
    expect(WRITE_SYSTEM).toMatch(/Never a video/);
    const video = checkedPost(answer({ format: 'video' }), 'facebook')!;
    expect(video.format).toBe('photo');
    expect(video.pictureWay).toBe('photo');
    expect(video.script).toBeNull();
  });

  it('keeps nothing when the AI wrote nothing', () => {
    expect(checkedPost(answer({ words: '   ', slides: [] }), 'facebook')).toBeNull();
  });
});

const designPage = (over: Partial<DesignAnswer['pages'][number]> = {}) => ({
  layout: null,
  kicker: 'Tip 1',
  heading: 'Answer in five minutes',
  body: 'Leads go cold fast.',
  items: [],
  mark: null,
  footer: null,
  ...over,
});
const design = (over: Partial<DesignAnswer> = {}): DesignAnswer => ({
  style: 'split',
  font: null,
  background: '#ffffff',
  text: '#111111',
  accent: '#2d69d8',
  photo: false,
  pages: [designPage(), designPage({ kicker: 'Tip 2', heading: 'Follow up twice', body: null })],
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
        design({ pages: [designPage({ kicker: null, heading: ' ', body: 'x' })] }),
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
    expect(prompt).toMatch(/bottom third calm/);
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

describe('the Calendar’s days and times, as the web and the phone both show them', () => {
  const now = Date.parse('2026-11-10T15:00:00.000Z');

  it('shows a clock, a time in the business’s zone, and picks the time back out', () => {
    expect(clockShown('09:00')).toBe('9:00 AM');
    expect(clockShown('00:30')).toBe('12:30 AM');
    expect(clockShown('17:45')).toBe('5:45 PM');
    expect(timeShown('2026-11-12T15:00:00.000Z', 'America/Chicago')).toBe('9:00 AM');
    expect(timeShown('2026-11-12T15:00:00.000Z', 'America/Chicago', true)).toBe(
      'Thu, Nov 12, 9:00 AM',
    );
    expect(clockOf('2026-11-12T15:00:00.000Z', 'America/Chicago')).toBe('09:00');
    expect(clockOf('2026-11-12T05:30:00.000Z', 'America/Chicago')).toBe('23:30');
  });

  it('names today and tomorrow, and other days by their weekday', () => {
    expect(dayShown('2026-11-10', '2026-11-10')).toBe('Today');
    expect(dayShown('2026-11-11', '2026-11-10')).toBe('Tomorrow');
    expect(dayShown('2026-11-13', '2026-11-10')).toBe('Friday, November 13');
  });

  it('says when it filled and fills again, or how to start', () => {
    expect(daysUntil('2026-11-16T15:00:00.000Z', now)).toBe('in 6 days');
    expect(daysUntil('2026-11-11T09:00:00.000Z', now)).toBe('tomorrow');
    expect(daysUntil('2026-11-10T09:00:00.000Z', now)).toBe('today');
    expect(filledLine({ filledAt: null, nextFillAt: null }, now)).toMatch(/Fill the calendar/);
    expect(
      filledLine(
        { filledAt: '2026-11-10T13:00:00.000Z', nextFillAt: '2026-11-16T15:00:00.000Z' },
        now,
      ),
    ).toMatch(/in 6 days/);
    // Filling on its own turned off (the owner, 11 Nov).
    expect(
      filledLine({ filledAt: '2026-11-10T13:00:00.000Z', nextFillAt: null, autoFill: false }, now),
    ).toMatch(/^Filled .* filling on its own is off/);
    expect(filledLine({ filledAt: null, nextFillAt: null, autoFill: false }, now)).toMatch(
      /^Filling on its own is off/,
    );
  });

  it('puts the plan in one line', () => {
    const name = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);
    // An older API's plan, with one time.
    expect(
      planShown(
        { instagram: { perWeek: 3, time: '09:00' }, linkedin: { perWeek: 2, time: '08:00' } },
        ['instagram', 'facebook', 'linkedin'],
        name,
      ),
    ).toMatch(/^Your plan: Instagram.*3.*9:00 AM · Linkedin.*2.*8:00 AM\. /);
    const plan = planOf({
      instagram: { mode: 'ai', perWeek: 10, perDay: 2 },
      facebook: { mode: 'mine', week: [[], ['09:00', '17:00'], [], ['09:00'], [], [], []] },
      linkedin: { mode: 'ai', perWeek: 0 },
    });
    expect(planShown(plan, ['instagram', 'facebook', 'linkedin'], name)).toBe(
      'Your plan: Instagram: 10 posts a week, up to 2 a day, at the times the AI picks · Facebook: 3 posts a week at your times · Linkedin: off. Change the plan in Settings.',
    );
  });
});
