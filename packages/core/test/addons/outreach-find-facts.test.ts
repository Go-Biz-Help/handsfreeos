/**
 * People found by topic (src/addons/outreach/finds.ts, decision 92): how each was found, in the line the AI's check
 * and Today's why both read, and which way of being found a find keeps. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  FIND_HOW_KEYS,
  findFact,
  findsWaitingMost,
  strongerHow,
} from '../../src/addons/outreach/finds';

describe('a find’s line', () => {
  it('says where the post was found, in each network’s words', () => {
    expect(findFact({ platform: 'instagram', how: 'commented', words: 'austinroofing' })).toBe(
      'Commented on a post under #austinroofing',
    );
    expect(findFact({ platform: 'instagram', how: 'liked', words: 'austinroofing' })).toBe(
      'Liked a post under #austinroofing',
    );
    expect(findFact({ platform: 'linkedin', how: 'liked', words: 'missed calls' })).toBe(
      'Reacted to a post your search for “missed calls” found',
    );
    expect(findFact({ platform: 'linkedin', how: 'posted', words: 'missed calls' })).toBe(
      'Wrote a post your search for “missed calls” found',
    );
    expect(
      findFact({
        platform: 'alignable',
        how: 'commented',
        words: null,
        group: 'Austin Trades Circle',
      }),
    ).toBe('Commented on a post in the Alignable group Austin Trades Circle');
    expect(findFact({ platform: 'alignable', how: 'posted', words: null })).toBe(
      'Wrote a post on Alignable',
    );
  });

  it('says what a search found, and the group someone is in', () => {
    expect(
      findFact({
        platform: 'alignable',
        how: 'searched',
        words: 'roofing contractor',
        place: 'Austin',
      }),
    ).toBe('Found by your Alignable search for “roofing contractor” in Austin');
    expect(findFact({ platform: 'alignable', how: 'searched', words: 'roofing contractor' })).toBe(
      'Found by your Alignable search for “roofing contractor”',
    );
    expect(
      findFact({
        platform: 'alignable',
        how: 'member',
        words: null,
        group: 'Austin Trades Circle',
      }),
    ).toBe('In the Alignable group Austin Trades Circle');
    expect(findFact({ platform: 'alignable', how: 'member', words: null })).toBe(
      'In a group on Alignable',
    );
  });
});

describe('the way a find keeps', () => {
  it('is the stronger one: posted, commented, liked, member, searched', () => {
    expect(FIND_HOW_KEYS).toEqual(['posted', 'commented', 'liked', 'member', 'searched']);
    expect(strongerHow('liked', 'commented')).toBe('commented');
    expect(strongerHow('posted', 'liked')).toBe('posted');
    expect(strongerHow('searched', 'member')).toBe('member');
    expect(strongerHow('liked', 'liked')).toBe('liked');
  });

  it('waits at 3 days of a network’s found checks', () => {
    expect(findsWaitingMost(30)).toBe(90);
    expect(findsWaitingMost(0)).toBe(0);
  });
});
