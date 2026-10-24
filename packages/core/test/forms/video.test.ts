import { describe, expect, it } from 'vitest';
import {
  answerProblem,
  formProblems,
  pageProblems,
  pageToResume,
  parseVideoUrl,
  playerHello,
  readPlayerMessage,
  watchedPercent,
  watchStart,
  watchTick,
  type Question,
  type WatchState,
} from '../../src/forms/index';
import { def, page, qid, shortText } from './fixtures';

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const video = (
  name: string,
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({ id: qid(name), type: 'video', title: name, config, ...extra }) as never;

describe('parseVideoUrl', () => {
  it('reads the ways a YouTube video is linked', () => {
    for (const url of [
      YT,
      'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      const source = parseVideoUrl(url);
      expect(source, url).toMatchObject({ provider: 'youtube', id: 'dQw4w9WgXcQ', tracked: true });
      expect(
        source!.embedUrl.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?'),
      ).toBe(true);
    }
  });

  it('reads Vimeo, keeping an unlisted video’s hash', () => {
    expect(parseVideoUrl('https://vimeo.com/76979871')).toMatchObject({
      provider: 'vimeo',
      id: '76979871',
      tracked: true,
    });
    expect(parseVideoUrl('https://vimeo.com/76979871/8272103f6e')!.embedUrl).toContain(
      'h=8272103f6e',
    );
    expect(
      parseVideoUrl('https://player.vimeo.com/video/76979871?h=8272103f6e')!.embedUrl,
    ).toContain('h=8272103f6e');
  });

  it('plays Loom but says it can’t be tracked', () => {
    expect(
      parseVideoUrl('https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184'),
    ).toMatchObject({ provider: 'loom', tracked: false });
  });

  it('turns away what isn’t one video', () => {
    for (const url of [
      '',
      'not a link',
      'javascript:alert(1)',
      'https://www.youtube.com/@somechannel',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/watch?v=short',
      'https://vimeo.com/channels/staffpicks',
      'https://example.com/video.mp4',
      'https://evil.com/watch?v=dQw4w9WgXcQ',
    ])
      expect(parseVideoUrl(url), url).toBeNull();
  });
});

/** Plays from `from` to `to` in quarter-second reports, the way a player reports while playing. */
function play(state: WatchState, from: number, to: number, duration = 100): WatchState {
  let s = state;
  for (let t = from; t <= to; t += 0.25) s = watchTick(s, { seconds: t, duration });
  return s;
}

describe('how much they watched', () => {
  it('counts what was played, not where the bar was dragged to', () => {
    let s = play(watchStart(), 0, 30);
    expect(watchedPercent(s)).toBe(30);
    // Drag ahead to 80 and play on: the part skipped doesn't count.
    s = watchTick(s, { seconds: 80, duration: 100 });
    s = play(s, 80, 90);
    expect(watchedPercent(s)).toBe(30);
    // Back to where they were, and on from there.
    s = watchTick(s, { seconds: 29, duration: 100 });
    s = play(s, 29, 60);
    expect(watchedPercent(s)).toBe(60);
  });

  it('calls the last second the end', () => {
    expect(watchedPercent(play(watchStart(), 0, 99.5))).toBe(100);
  });

  it('carries on from what an earlier visit saw', () => {
    let s = watchStart(40);
    expect(watchedPercent(s)).toBe(40);
    s = watchTick(s, { seconds: 0, duration: 200 });
    expect(watchedPercent(s)).toBe(40);
    // Picking up at 40% (80s) moves it on; starting again from the top doesn't take it back.
    s = watchTick(s, { seconds: 80, duration: 200 });
    s = play(s, 80, 120, 200);
    expect(watchedPercent(s)).toBe(60);
  });
});

describe('a video question', () => {
  const gated = video('intro', { url: YT, minPercent: 80 }) as Question;
  const loose = video('teaser', { url: YT }) as Question;

  it('holds them until they’ve watched enough', () => {
    expect(answerProblem(gated, null)).toBe('Watch at least 80% of the video to go on.');
    expect(answerProblem(gated, 79)).toBe('Watch at least 80% of the video to go on.');
    expect(answerProblem(gated, 80)).toBeNull();
    expect(answerProblem(video('all', { url: YT, minPercent: 100 }) as Question, 99)).toBe(
      'Watch the whole video to go on.',
    );
  });

  it('lets them move on any time without a gate', () => {
    expect(answerProblem(loose, null)).toBeNull();
    expect(answerProblem(loose, 12)).toBeNull();
  });

  it('refuses a watched amount that isn’t one', () => {
    expect(answerProblem(loose, 140)).toBe('Watch the video here.');
    expect(answerProblem(loose, 'all of it')).toBe('Watch the video here.');
  });

  it('holds the page it is on, and only that page', () => {
    const definition = def({
      settings: { onePageAtATime: true },
      pages: [page('watch', [gated as never]), page('details', [shortText('name')])],
    });
    expect(pageProblems(definition, {}, definition.pages[0]!.id)).toHaveLength(1);
    expect(pageProblems(definition, { [qid('intro')]: 85 }, definition.pages[0]!.id)).toEqual([]);
  });

  it('asks for a link it can play before publishing', () => {
    const problems = (config: Record<string, unknown>) =>
      formProblems(def({ pages: [page('watch', [video('Our story', config)])] }));
    expect(problems({ url: '' })).toContain('“Our story” needs a video link.');
    expect(problems({ url: 'https://example.com/a.mp4' })).toContain(
      '“Our story” needs a YouTube, Vimeo or Loom link to one video.',
    );
    expect(
      problems({
        url: 'https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184',
        minPercent: 50,
      }).join(' '),
    ).toContain('can’t hold the Next button');
    expect(problems({ url: YT, minPercent: 50 })).toEqual([]);
  });
});

describe('reading the players', () => {
  it('reads YouTube’s reports, as a string or not', () => {
    expect(
      readPlayerMessage(
        'youtube',
        JSON.stringify({ event: 'infoDelivery', info: { currentTime: 12.5, duration: 300 } }),
      ),
    ).toEqual({ ready: true, seconds: 12.5, duration: 300 });
    expect(readPlayerMessage('youtube', { event: 'onReady' })).toEqual({ ready: true });
    expect(readPlayerMessage('youtube', { event: 'somethingElse' })).toBeNull();
    expect(readPlayerMessage('youtube', 'not json')).toBeNull();
  });

  it('reads Vimeo’s', () => {
    expect(
      readPlayerMessage('vimeo', { event: 'timeupdate', data: { seconds: 3, duration: 90 } }),
    ).toEqual({ ready: true, seconds: 3, duration: 90 });
    expect(readPlayerMessage('vimeo', '{"event":"ready"}')).toEqual({ ready: true });
  });

  it('says hello in each player’s own way', () => {
    expect(JSON.parse(String(playerHello('youtube', 'p1')[0]))).toEqual({
      event: 'listening',
      id: 'p1',
      channel: 'widget',
    });
    expect(playerHello('vimeo', 'p1')[0]).toEqual({
      method: 'addEventListener',
      value: 'timeupdate',
    });
    expect(playerHello('loom', 'p1')).toEqual([]);
  });
});

describe('picking up a step-by-step form', () => {
  const definition = def({
    settings: { onePageAtATime: true },
    pages: [
      page('name', [shortText('name', { required: true })]),
      page('watch', [video('intro', { url: YT, minPercent: 80 })]),
      page('more', [shortText('city')]),
    ],
  });

  it('starts on the first page with something left to do', () => {
    expect(pageToResume(definition, {})).toBe(definition.pages[0]!.id);
    expect(pageToResume(definition, { [qid('name')]: 'Dana' })).toBe(definition.pages[1]!.id);
    expect(pageToResume(definition, { [qid('name')]: 'Dana', [qid('intro')]: 90 })).toBe(
      definition.pages[2]!.id,
    );
  });

  it('lands on the last page when everything is done', () => {
    expect(
      pageToResume(definition, {
        [qid('name')]: 'Dana',
        [qid('intro')]: 90,
        [qid('city')]: 'Austin',
      }),
    ).toBe(definition.pages[2]!.id);
  });
});
