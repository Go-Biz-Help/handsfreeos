/**
 * A job's note of what it saw (src/jobs/report.ts, decision 74): the network's own section names from the outline,
 * never a masked heading; what the readers found as counts and yes or no, never words; and for the person's own
 * profile, what wasn't read, with the outline kept when what nearly everyone has is missing.
 */
import { describe, expect, it } from 'vitest';
import { ownProfileNote, pageFound, sectionsIn } from '../src/jobs/report';
import type { PageRead } from '../src/networks/kit';

describe('a note of what a job saw', () => {
  it('names the sections from the outline’s headings, in either layout, and never a masked one', () => {
    const outline = [
      'HandsFreeOS Social 0.48.0 · page outline',
      'Page: own-profile /in/{1}/',
      'body',
      '  h1 "[2 words]"',
      '  h2 "About"',
      '  h2 data-testid="toasts-title" "[2 words]"',
      '  h2',
      '    span aria-hidden="true" "Experience"',
      '    span "Experience"',
      '  h2 "About"',
      '  h3',
      '    span "[3 words]"',
    ].join('\n');
    expect(sectionsIn(outline)).toEqual(['About', 'Experience']);
  });

  it('counts each list the readers found, and says which parts of a profile were there, never what they said', () => {
    const read = {
      platform: 'linkedin',
      kind: 'profile',
      url: 'https://www.linkedin.com/in/dana-reyes-4b2a1c/',
      readAt: '2026-10-16T12:00:00Z',
      profile: { name: 'Dana Reyes', headline: 'Owner at Reyes Roofing', about: null, role: null },
      posts: [{}, {}],
      warnings: [],
      notes: ['Found no roles'],
    } as unknown as PageRead;
    const found = pageFound(read);
    expect(found).toEqual({
      posts: 2,
      warnings: 0,
      notes: 1,
      profile: true,
      profileName: true,
      profileHeadline: true,
      profileAbout: false,
      profileRole: false,
    });
    expect(JSON.stringify(found)).not.toMatch(/Dana|Reyes|Owner/);
  });

  it('says what of their own profile wasn’t read, and keeps the outline when Experience or the headline is missing', () => {
    const read = {
      platform: 'linkedin' as const,
      bio: 'I help roofers',
      about: 'About me',
      intro: [],
      featured: [],
      posts: ['A post'],
      picture: 'A profile photo LinkedIn didn’t describe',
      cover: null,
    };
    expect(ownProfileNote(read)).toEqual({
      found: {
        bio: true,
        about: true,
        roles: 0,
        featured: 0,
        posts: 1,
        photo: true,
        banner: false,
      },
      note: 'Not read: Experience, Featured.',
      outline: true,
    });
    expect(ownProfileNote({ ...read, intro: ['Founder at Gee Consulting'] })).toMatchObject({
      note: 'Not read: Featured.',
      outline: false,
    });
  });
});
