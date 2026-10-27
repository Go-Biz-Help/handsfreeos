/**
 * The AI's words for finding people by topic (src/addons/outreach/topics.ts, decision 92): which lists it writes for
 * a playbook, what it's asked, and what of its answer is kept. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import { blankPlaybook, type PlaybookDetails } from '../../src/addons/outreach/playbooks';
import {
  checkedFindWords,
  cleanFindWords,
  FIND_WORDS_ASK,
  findWordsPrompt,
  wordsDue,
} from '../../src/addons/outreach/topics';

const playbook = (over: Partial<PlaybookDetails> = {}): PlaybookDetails => ({
  ...blankPlaybook(),
  niche: 'Roofers in Austin',
  ...over,
});

describe('the lists the AI writes', () => {
  it('are a customers’ playbook’s empty lists on its networks, with works online while nobody has said', () => {
    expect(wordsDue(playbook())).toEqual({
      networks: ['instagram', 'linkedin', 'alignable'],
      askOnline: true,
    });
    expect(wordsDue(playbook({ platforms: ['facebook', 'linkedin'] }))).toEqual({
      networks: ['linkedin'],
      askOnline: true,
    });
    // Facebook has no list of its own.
    expect(wordsDue(playbook({ platforms: ['facebook'] }))).toEqual({
      networks: [],
      askOnline: false,
    });
    expect(wordsDue(playbook({ worksOnline: false })).askOnline).toBe(false);
  });

  it('leave out the person’s own words, a list the AI wrote and the person emptied, partner playbooks, and a playbook that doesn’t say who it’s for', () => {
    expect(
      wordsDue(playbook({ hashtags: ['austinroofing'], wordsWritten: ['linkedin'] })).networks,
    ).toEqual(['alignable']);
    expect(wordsDue(playbook({ goal: 'partner' }))).toEqual({ networks: [], askOnline: false });
    // Nothing to write from yet: it waits for who it's for.
    expect(wordsDue(playbook({ niche: null }))).toEqual({ networks: [], askOnline: false });
    expect(wordsDue(playbook({ niche: null, problem: 'Missed calls' })).networks).toHaveLength(3);
  });
});

describe('the ask', () => {
  it('names only the lists due, and ends with the ask', () => {
    const prompt = findWordsPrompt({
      business: 'Harbor <Lane> Answering',
      offer: null,
      playbook: {
        name: 'Austin roofers',
        niche: 'Roofers in Austin',
        audience: 'Roofing companies with 2 to 3 crews',
        problem: 'Missed calls while on a roof',
        offer: null,
        area: 'Austin, TX',
        worksOnline: null,
        signs: ['Posts about storm season'],
        groupWords: ['roofing'],
      },
      due: { networks: ['instagram', 'alignable'], askOnline: true },
    });
    expect(prompt.endsWith(FIND_WORDS_ASK)).toBe(true);
    expect(prompt).toContain('<business>Harbor &lt;Lane&gt; Answering</business>');
    expect(prompt).toContain('Where they are: Austin, TX');
    expect(prompt).toContain('Works online: (not said yet)');
    expect(prompt).toContain('- hashtags: hashtags to look at on Instagram');
    expect(prompt).toContain('- businessKinds: kinds of business to search for on Alignable');
    expect(prompt).toContain('- worksOnline:');
    expect(prompt).not.toContain('- postSearches:');
    expect(prompt).not.toContain('<main_offer>');
  });
});

describe('what the AI wrote', () => {
  it('keeps hashtags as people tag them, never the business’s name or one everyone uses', () => {
    expect(
      cleanFindWords(
        'instagram',
        ['#Austin Roofing', 'roofleak', 'instagood', 'Harbor Lane', 'AustinRoofing', '!!'],
        'Harbor Lane',
      ),
    ).toEqual(['austinroofing', 'roofleak']);
  });

  it('keeps short phrases for LinkedIn and kinds of business for Alignable, each once', () => {
    expect(
      cleanFindWords('linkedin', [
        '“missed calls”',
        'Missed  calls',
        '#hiring a dispatcher',
        'looking for a really good roofer near me',
      ]),
    ).toEqual(['missed calls', 'hiring a dispatcher']);
    expect(
      cleanFindWords('alignable', ['Roofing Contractor', 'roofing contractor', 'x'.repeat(81)]),
    ).toEqual(['Roofing Contractor']);
  });

  it('keeps only the lists asked for, and works online only when asked', () => {
    const answer = {
      hashtags: ['austinroofing'],
      postSearches: ['missed calls'],
      businessKinds: ['instagood'],
      worksOnline: true,
    };
    expect(
      checkedFindWords(answer, { networks: ['instagram', 'linkedin'], askOnline: false }, 'Acme'),
    ).toEqual({ hashtags: ['austinroofing'], postSearches: ['missed calls'] });
    expect(
      checkedFindWords(
        { ...answer, hashtags: ['instagood', 'acme'] },
        { networks: ['instagram'], askOnline: true },
        'Acme',
      ),
    ).toEqual({ worksOnline: true });
    expect(
      checkedFindWords({ ...answer, worksOnline: null }, { networks: [], askOnline: true }, 'Acme'),
    ).toEqual({});
  });
});
