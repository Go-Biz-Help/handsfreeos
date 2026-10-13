import { describe, expect, it } from 'vitest';
import { ownsPage, pageHeading } from '../src/facebook/lookup';
import type { Named, ReadResult } from '../src/facebook/types';

const page: Named = {
  name: 'Consultmyapp',
  profile: { id: null, username: 'consultmyapp', url: 'https://www.facebook.com/consultmyapp' },
};

const reading = (intro: string[]): ReadResult => ({
  kind: 'profile',
  url: 'https://www.facebook.com/ophelia',
  readAt: '2026-10-13T00:00:00.000Z',
  warnings: [],
  notes: [],
  profile: { name: 'Ophelia', profile: null, intro, friendship: 'friends', mutualFriends: null },
});

describe('the page a profile links to', () => {
  it('is their business only when the line naming it says they own it', () => {
    expect(ownsPage(reading(['Owner at Consultmyapp']), page)).toBe(true);
    expect(ownsPage(reading(['Founder of Consultmyapp']), page)).toBe(true);
    expect(pageHeading(reading(['CEO at Consultmyapp']), page)).toBe(
      'Their business page: Consultmyapp',
    );
  });

  it('is where they work when the line is a job, or just the name', () => {
    expect(ownsPage(reading(['Data Analyst at Consultmyapp']), page)).toBe(false);
    expect(ownsPage(reading(['Works at Consultmyapp']), page)).toBe(false);
    expect(ownsPage(reading(['Consultmyapp']), page)).toBe(false);
    // An owner line about some other business says nothing about this one.
    expect(ownsPage(reading(['Owner at Smith Plumbing', 'Works at Consultmyapp']), page)).toBe(
      false,
    );
    expect(pageHeading(reading(['Data Analyst at Consultmyapp']), page)).toMatch(
      /^Where they work.*: Consultmyapp$/,
    );
  });
});
