/**
 * The business's video library (decision 154; the owner's picks 1a 2a 3a): one library in Settings → Videos, the AI
 * picking by each video's words for a follow-up after the demo ask, another time after a missed demo or a reply, at
 * most one at a time and never twice to one person; and the playbooks' short videos moving into it.
 */
import { describe, expect, it } from 'vitest';
import { outreachSettings, settingsToSave } from '../../src/addons/outreach/chat-read';
import { todayDraftPrompt } from '../../src/addons/outreach/today';
import {
  FROM_PLAYBOOK_ABOUT,
  fitsVideos,
  fromPlaybooks,
  LIBRARY_LIMITS,
  libraryOf,
  libraryVideoProblem,
  LibraryVideo,
  sentLinks,
  VIDEO_ASK,
  VideoLibrary,
  videoFits,
  videoLines,
} from '../../src/addons/outreach/video-library';

const tour = {
  name: '2-minute tour',
  link: 'https://www.loom.com/share/tour',
  about: 'A quick tour of the CRM, for someone who hasn’t booked and wants to see it first.',
};
const results = {
  name: 'How Peak Roofing booked 22 inspections',
  link: 'https://youtu.be/peak',
  about: 'A customer’s results, for someone who asks whether it works for roofers.',
};

describe('a video in the library', () => {
  it('takes a name, an https link with a real host, and what it shows and when it helps', () => {
    expect(LibraryVideo.parse(tour)).toEqual(tour);
    expect(
      LibraryVideo.safeParse({ ...tour, link: 'http://www.loom.com/share/tour' }).success,
    ).toBe(false);
    expect(LibraryVideo.safeParse({ ...tour, link: 'https://loom' }).success).toBe(false);
    expect(LibraryVideo.safeParse({ ...tour, name: '  ' }).success).toBe(false);
    expect(LibraryVideo.safeParse({ ...tour, about: '' }).success).toBe(false);
    expect(
      LibraryVideo.safeParse({ ...tour, about: 'x'.repeat(LIBRARY_LIMITS.about + 1) }).success,
    ).toBe(false);
  });

  it('says what’s wrong in the save’s own words before it goes', () => {
    expect(libraryVideoProblem(tour, [])).toBeNull();
    expect(libraryVideoProblem({ ...tour, about: '' }, [])).toMatch(/so the AI knows when/);
    expect(libraryVideoProblem({ ...tour, link: 'loom' }, [])).toMatch(/starting https/);
    expect(libraryVideoProblem(tour, [results, tour])).toMatch(/in your library already/);
  });

  it('holds up to 20, each link once', () => {
    expect(VideoLibrary.safeParse([tour, results]).success).toBe(true);
    expect(VideoLibrary.safeParse([tour, { ...results, link: tour.link }]).success).toBe(false);
    const many = Array.from({ length: LIBRARY_LIMITS.videos + 1 }, (_, i) => ({
      ...tour,
      link: `https://www.loom.com/share/${i}`,
    }));
    expect(VideoLibrary.safeParse(many.slice(0, LIBRARY_LIMITS.videos)).success).toBe(true);
    expect(VideoLibrary.safeParse(many).success).toBe(false);
  });
});

describe('kept with the business’s Social Outreach settings', () => {
  it('starts as never saved, and keeps what’s saved', () => {
    expect(outreachSettings({}).videos).toBeNull();
    expect(outreachSettings({ videos: [tour] }).videos).toEqual([tour]);
    expect(settingsToSave({ noVideo: true }, { videos: [] })).toMatchObject({
      noVideo: true,
      videos: [],
    });
  });

  it('reads a library that stopped passing as never saved, and keeps the business’s other settings', () => {
    const kept = outreachSettings({
      weeklyReport: false,
      videos: [{ ...tour, link: 'not a link' }],
    });
    expect(kept.videos).toBeNull();
    expect(kept.weeklyReport).toBe(false);
  });
});

describe('the playbooks’ short videos move into the library (3a)', () => {
  const playbooks = [
    { name: 'Roofers', details: { videoLink: 'https://www.loom.com/share/roof' } },
    { name: 'Bakers', details: { videoLink: 'https://www.loom.com/share/bake' } },
    { name: 'Plumbers', details: { videoLink: null } },
    { name: 'Again', details: { videoLink: 'https://www.loom.com/share/roof' } },
    { name: 'Broken', details: { videoLink: 'not a link' } },
  ];

  it('reads as the playbooks’ videos until it’s first saved, by playbook name, each link once', () => {
    expect(libraryOf(null, playbooks)).toEqual([
      {
        name: 'Again: short video',
        link: 'https://www.loom.com/share/roof',
        about: FROM_PLAYBOOK_ABOUT,
      },
      {
        name: 'Bakers: short video',
        link: 'https://www.loom.com/share/bake',
        about: FROM_PLAYBOOK_ABOUT,
      },
    ]);
    expect(fromPlaybooks(null)).toBe(true);
  });

  it('is its own once saved, even emptied', () => {
    expect(libraryOf([tour], playbooks)).toEqual([tour]);
    expect(libraryOf([], playbooks)).toEqual([]);
    expect(fromPlaybooks([])).toBe(false);
  });
});

describe('where the AI may send one (2a)', () => {
  const open = { declined: false, requests: false };

  it('a follow-up after the demo ask, another time after a missed demo, and a reply', () => {
    expect(videoFits('follow_up', 'link', open)).toBe(true);
    expect(videoFits('follow_up', 'first', open)).toBe(false);
    expect(videoFits('follow_up', 'video', open)).toBe(false);
    expect(videoFits('rebook', null, open)).toBe(true);
    expect(videoFits('reply', 'first', open)).toBe(true);
    for (const kind of ['opener', 'reconnect', 'pitch', 'check_in', 'comment', 'demo_reminder'])
      expect(videoFits(kind, 'link', open)).toBe(false);
  });

  it('never to someone who turned the offer down, nor in their Requests', () => {
    expect(videoFits('reply', null, { declined: true, requests: false })).toBe(false);
    expect(videoFits('rebook', null, { declined: false, requests: true })).toBe(false);
  });
});

describe('never the same video twice, at most one at a time', () => {
  it('finds the videos they’ve had in what was sent them', () => {
    expect(
      sentLinks([tour, results], ['Here you go: https://youtu.be/peak', null, 'Thanks!']),
    ).toEqual([results.link]);
    expect(sentLinks([tour], [])).toEqual([]);
  });

  it('lists only the videos they haven’t had, with what each shows, and none when they’ve had them all', () => {
    const lines = videoLines({ videos: [tour, results], sent: [results.link] }).join('\n');
    expect(lines).toContain('<videos>');
    expect(lines).toContain(tour.name);
    expect(lines).toContain(tour.about);
    expect(lines).toContain(tour.link);
    expect(lines).not.toContain(results.link);
    expect(lines).toContain(VIDEO_ASK);
    expect(VIDEO_ASK).toMatch(/At most one video in a draft, and none when nothing fits/);
    expect(videoLines({ videos: [tour], sent: [tour.link] })).toEqual([]);
    expect(videoLines(null)).toEqual([]);
  });

  it('drops a draft with two videos, or one they’ve had', () => {
    const library = { videos: [tour, results], sent: [results.link] };
    expect(fitsVideos(`Worth a look: ${tour.link}`, library)).toBe(true);
    expect(fitsVideos('No video this time. Does Thursday work?', library)).toBe(true);
    expect(fitsVideos(`Here: ${results.link}`, library)).toBe(false);
    expect(fitsVideos(`${tour.link} and ${results.link}`, { ...library, sent: [] })).toBe(false);
    expect(fitsVideos(`Here: ${results.link}`, null)).toBe(true);
  });
});

describe('what a draft is told', () => {
  const prompt = { business: 'Acme', name: 'Jane Doe', facts: [], recent: [], playbook: null };
  const videos = { videos: [tour, results], sent: [] };

  it('a follow-up after the demo ask gets the videos, and one after the first message doesn’t', () => {
    const after = (step: 'link' | 'first') =>
      todayDraftPrompt({
        ...prompt,
        kind: 'follow_up',
        videos,
        conversation: { step, sent: 1, followUps: 5 },
      });
    expect(after('link')).toContain('<videos>');
    expect(after('link')).toContain(tour.about);
    expect(after('first')).not.toContain('<videos>');
  });

  it('another time after a missed demo and a reply get them, never to someone who said no', () => {
    expect(todayDraftPrompt({ ...prompt, kind: 'rebook', videos })).toContain('<videos>');
    expect(todayDraftPrompt({ ...prompt, kind: 'reply', videos })).toContain('<videos>');
    expect(
      todayDraftPrompt({ ...prompt, kind: 'reply', videos, declined: { why: null } }),
    ).not.toContain('<videos>');
    expect(todayDraftPrompt({ ...prompt, kind: 'pitch', videos })).not.toContain('<videos>');
    expect(todayDraftPrompt({ ...prompt, kind: 'rebook', videos: null })).not.toContain('<videos>');
  });
});
