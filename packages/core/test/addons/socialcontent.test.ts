/**
 * AI Social Media Content Creator's manifest and operations, held to the add-on rules (docs/addon-architecture.md),
 * and the words for what its reading computer is doing. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonModuleIssues,
  addonSearchIssues,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import { socialcontentAddon } from '../../src/addons/socialcontent/manifest';
import { socialcontentAddonServer } from '../../src/addons/socialcontent/server';
import { hasOwnNiche } from '../../src/addons/socialcontent/niches-ai';
import { momentAgo, progressFacts } from '../../src/addons/socialcontent/words';

describe('AI Social Media Content Creator', () => {
  it('has a valid manifest', () => {
    expect(manifestIssues(socialcontentAddon)).toEqual([]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== 'socialcontent'),
      queries: queries.filter((q) => q.addon?.id !== 'socialcontent'),
    };
    expect(addonModuleIssues(core, [socialcontentAddonServer])).toEqual([]);
  });

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([socialcontentAddonServer])).toEqual([]);
  });

  it('answers searches only as core runs them', () => {
    expect(addonSearchIssues([socialcontentAddonServer])).toEqual([]);
  });
});

describe('what the reading computer is doing, in words', () => {
  const NOW = Date.UTC(2026, 10, 9, 2, 0);

  it('says how long ago it last checked in', () => {
    expect(momentAgo(null, NOW)).toBeNull();
    expect(momentAgo(new Date(NOW - 20_000).toISOString(), NOW)).toBe('just now');
    expect(momentAgo(new Date(NOW - 60_000), NOW)).toBe('1 minute ago');
    expect(momentAgo(new Date(NOW - 7 * 60_000), NOW)).toBe('7 minutes ago');
    expect(momentAgo(new Date(NOW - 3 * 3_600_000), NOW)).toBe('3 hours ago');
  });

  it('says what a piece of work did as short facts', () => {
    expect(progressFacts(null)).toEqual([]);
    expect(progressFacts({})).toEqual([]);
    expect(
      progressFacts({
        searched: ['#crm', 'ai automation'],
        searches: 5,
        accounts: 42,
        profiles: 1,
        posts: 1_200,
        suggested: 3,
        didntFit: 9,
      }),
    ).toEqual([
      'Searched 2 of 5: #crm, ai automation',
      'Looked at 42 accounts',
      'Read 1 profile',
      'Read 1,200 posts',
      '3 suggested, 9 didn’t fit',
    ]);
    // Every search done: no "of".
    expect(progressFacts({ searched: ['#crm'], searches: 1 })).toEqual(['Searched 1: #crm']);
    expect(progressFacts({ accounts: 30, profiles: 0, notOpened: 30 })).toEqual([
      'Looked at 30 accounts',
      'Couldn’t open 30 profiles',
    ]);
  });

  it('counts only an own niche that isn’t skipped, so a new one takes a skipped one’s place', () => {
    expect(hasOwnNiche([])).toBe(false);
    expect(hasOwnNiche([{ own: true, state: 'picked' }])).toBe(true);
    expect(hasOwnNiche([{ own: true, state: 'suggested' }])).toBe(true);
    expect(
      hasOwnNiche([
        { own: true, state: 'skipped' },
        { own: false, state: 'picked' },
      ]),
    ).toBe(false);
  });
});
