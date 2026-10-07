import { describe, expect, it } from 'vitest';
import { isFacebookText, isWhen, parseCount, sectionTitleOf } from '../src/facebook/vocabulary';

describe('isWhen', () => {
  it.each([
    '3h',
    '2 d',
    'Just now',
    'Yesterday',
    'Today at 10:12 AM',
    'Yesterday at 4:05 PM',
    'Mon 3:15 PM',
    'Oct 3, 2026, 3:15 PM',
    'October 1 at 9:12 AM',
    '3 October 2026',
    '10/3/26',
    '2 days ago',
    'about an hour ago',
    '10:12',
  ])('%s is a time', (text) => {
    expect(isWhen(text)).toBe(true);
  });

  it.each(['Jane Doe', 'Owner at Smith Plumbing', 'Sounds good', '12 members'])(
    '%s is not a time',
    (text) => {
      expect(isWhen(text)).toBe(false);
    },
  );
});

describe('parseCount', () => {
  it('reads counts as Facebook shows them', () => {
    expect(parseCount('12K')).toBe(12_000);
    expect(parseCount('12.3K')).toBe(12_300);
    expect(parseCount('2.5M')).toBe(2_500_000);
    expect(parseCount('1,234')).toBe(1_234);
    expect(parseCount('34')).toBe(34);
    expect(parseCount('lots')).toBeNull();
  });
});

describe('Facebook’s own words', () => {
  it('knows its buttons, counts and section titles from what people wrote', () => {
    expect(isFacebookText('Add friend')).toBe(true);
    expect(isFacebookText('12 mutual friends')).toBe(true);
    expect(isFacebookText('Public group · 1.2K members')).toBe(true);
    expect(isFacebookText('Jane Doe')).toBe(false);
    // On the friend requests page.
    expect(isFacebookText('36 Friend requests')).toBe(true);
    expect(isFacebookText('View sent requests')).toBe(true);
    expect(isFacebookText('Followed by 1.1K')).toBe(true);
    expect(isFacebookText('Request accepted')).toBe(true);
    // On a chat in a small window, and the menu a profile's Respond opens.
    expect(isFacebookText('Minimize chat')).toBe(true);
    expect(isFacebookText('Press Enter to send')).toBe(true);
    expect(isFacebookText('Delete request')).toBe(true);
    expect(sectionTitleOf('Admins and moderators · 4')).toBe('Admins and moderators');
    expect(sectionTitleOf('New to the group')).toBe('New to the group');
    expect(sectionTitleOf('Jane Doe')).toBeNull();
  });
});
