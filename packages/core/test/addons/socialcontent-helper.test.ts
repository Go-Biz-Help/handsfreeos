/**
 * AI Social Media Content Creator's read helper (docs/socialcontent.md, "When a read goes wrong"): the checks every
 * answer goes through before the reading tab takes a move.
 */
import { describe, expect, it } from 'vitest';
import {
  checkedReadLook,
  ReadLookInput,
  readLookPrompt,
  readLookSystem,
  type ReadLookAnswer,
} from '../../src/addons/socialcontent/helper';
import { HELPER_MOVES_MOST, viewLine } from '../../src/schemas/problem-report';

const VIEW = [
  'Page: profile /{1}',
  'On top:',
  viewLine(1, 1, 'dialog', 'Turn on notifications?'),
  viewLine(2, 2, 'button', 'Not now'),
  viewLine(2, 3, 'button', 'Log in'),
  'The page:',
  viewLine(1, 4, 'h1', '[1 word]'),
  viewLine(1, 5, 'button', 'Follow'),
  viewLine(1, 6, 'link', 'Posts', '/{1}/'),
].join('\n');

const input = (over: Partial<ReadLookInput> = {}) =>
  ReadLookInput.parse({
    network: 'instagram',
    read: 'profile',
    why: 'couldn’t find the follower count',
    view: VIEW,
    ...over,
  });

const answer = (
  move: ReadLookAnswer['move'],
  verdict: ReadLookAnswer['verdict'] = 'in_the_way',
): ReadLookAnswer => ({ verdict, said: 'A box about notifications — covers the page.', move });

describe('the read helper’s checks', () => {
  it('clicks a line that clears the way', () => {
    const out = checkedReadLook(answer({ do: 'click', ref: 2, dir: null }), input());
    expect(out.move).toEqual({ do: 'click', ref: 2, dir: null });
    expect(out.said).not.toContain('—');
  });

  it('never clicks a sign-in, a follow, or a line that isn’t there', () => {
    for (const ref of [3, 5, 99])
      expect(checkedReadLook(answer({ do: 'click', ref, dir: null }), input()).move.do).toBe(
        'none',
      );
  });

  it('scrolls down when no way is given, and stops once its moves are used', () => {
    expect(checkedReadLook(answer({ do: 'scroll', ref: null, dir: null }), input()).move).toEqual({
      do: 'scroll',
      ref: null,
      dir: 'down',
    });
    const used = Array.from({ length: HELPER_MOVES_MOST }, () => ({
      do: 'wait' as const,
      on: '',
      went: true,
    }));
    const out = checkedReadLook(
      answer({ do: 'escape', ref: null, dir: null }, 'moved'),
      input({ moves: used }),
    );
    expect(out).toMatchObject({ verdict: 'moved', move: { do: 'none' } });
    expect(readLookPrompt(input({ moves: used }))).toContain('taken all your moves');
  });

  it('names the network and the read, and keeps the page as data', () => {
    expect(readLookSystem('instagram')).toContain('Instagram');
    expect(readLookSystem('instagram')).not.toContain('NETWORK');
    const prompt = readLookPrompt(input());
    expect(prompt).toContain('<read>');
    expect(prompt).toContain('profile');
    expect(prompt).toContain('<page>');
  });
});
