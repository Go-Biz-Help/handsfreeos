/**
 * The runners' once-a-day jobs that need the screen (src/auto/on-screen.ts; docs/outreach.md, decision 120): one
 * whose read met the screen while the person was at their computer is passed over for 10 minutes, or till they're
 * away, and the day's last line says what still waits.
 */
import { describe, expect, it } from 'vitest';
import {
  AWAY_AGAIN_MS,
  awayEnd,
  isNotAway,
  PutOff,
  waitingFor,
  waitingWords,
} from '../src/auto/on-screen';
import { AWAY_WAIT_LINE, NotAway } from '../src/away';

describe('a job put off till the person is away', () => {
  it('is passed over for 10 minutes while they’re at their computer, and never once they’re away', () => {
    const putOff = new PutOff<'requests' | 'posts' | 'chats'>();
    const now = 1_000_000;
    putOff.off('requests', now);
    putOff.off('posts', now + 60_000);
    expect(putOff.passOver(false, now + 1)).toEqual(['requests', 'posts']);
    expect(putOff.passOver(true, now + 1)).toEqual([]);
    // Looked at again 10 minutes on: tried again then, and put off again if they're still there.
    expect(putOff.passOver(false, now + AWAY_AGAIN_MS)).toEqual(['posts']);
    expect(putOff.passOver(false, now + AWAY_AGAIN_MS + 60_000)).toEqual([]);
  });

  it('ends as put off, not done or failed, with the words an ask shows while it waits', () => {
    expect(awayEnd()).toEqual({ line: AWAY_WAIT_LINE, warned: false, away: true });
    expect(isNotAway(new NotAway())).toBe(true);
    expect(isNotAway(new Error(AWAY_WAIT_LINE))).toBe(false);
  });

  it('says on the day’s last line what still waits, by its name, leaving out what got done', () => {
    const names = { requests: 'Your newest followers', posts: 'Your hashtags and places' };
    expect(waitingFor(['requests', 'posts'], { posts: 'Done.' }, names)).toEqual([
      'Your newest followers',
    ]);
    expect(waitingFor(['requests'], undefined, names)).toEqual(['Your newest followers']);
    expect(waitingWords([])).toBeNull();
    expect(waitingWords(['Your newest followers'])).toBe(
      'One part waits till you’ve been away from your computer for 2 minutes, as it needs its window on screen: Your newest followers.',
    );
    expect(waitingWords(['Your newest followers', 'Accounts like yours', 'Read my profile'])).toBe(
      '3 parts wait till you’ve been away from your computer for 2 minutes, as they need its window on screen: Your newest followers, Accounts like yours and Read my profile.',
    );
  });
});
