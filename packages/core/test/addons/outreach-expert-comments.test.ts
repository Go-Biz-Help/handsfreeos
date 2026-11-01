/**
 * Social Outreach's comments that sound like an expert, on posts that fit the playbook (docs/outreach.md, decision
 * 141): the post check calls a post good only when it's about a playbook's topic, the comment ask is a peer's who
 * knows the field, a draft's stock praise goes, and Facebook's post search goes with the playbooks' own phrases.
 */
import { describe, expect, it } from 'vitest';
import { blankPlaybook, type PlaybookDetails } from '../../src/addons/outreach/playbooks';
import {
  POST_CHECK_SYSTEM,
  postCheckPrompt,
  postSearchWords,
  SEARCH_PARTS,
} from '../../src/addons/outreach/posts';
import { todayDraftPrompt, withoutStockPraise } from '../../src/addons/outreach/today';

describe('posts about the playbook’s topic', () => {
  it('calls a post good only when it’s about the topic, never one that only shows the writer’s work', () => {
    expect(POST_CHECK_SYSTEM).toContain('good only when it is about a playbook’s topic');
    expect(POST_CHECK_SYSTEM).toContain(
      'however well its writer fits a playbook: say fits instead',
    );
    expect(POST_CHECK_SYSTEM).not.toContain('A short, genuine comment there starts a friendship');
  });

  it('tells the check the playbook’s niche and problem', () => {
    const prompt = postCheckPrompt({
      business: 'Bright Books',
      group: null,
      text: 'How do you all handle calls while you’re up on a roof?',
      playbooks: [
        {
          name: 'Roofers',
          ...blankPlaybook(),
          niche: 'Roofing companies in Austin',
          problem: 'Missed calls while they’re up on a roof',
        },
      ],
    });
    expect(prompt).toContain('Niche: Roofing companies in Austin');
    expect(prompt).toContain('Their problem: Missed calls while they’re up on a roof');
  });
});

describe('Facebook’s post search (decision 141)', () => {
  const on = (details: Partial<PlaybookDetails>, id = 'p1') => ({
    id,
    name: 'Roofers',
    details: {
      ...blankPlaybook(),
      platforms: ['facebook' as const, 'linkedin' as const],
      signs: ['Says “missed calls”'],
      groupWords: ['roofers'],
      ...details,
    },
  });
  const phrases = ['missed calls', 'anyone use a CRM', 'slow season', 'speed to lead', 'no shows'];

  it('searches with the playbooks’ own Facebook phrases, 5 a day in turn', () => {
    expect(SEARCH_PARTS.facebook).toBe('facebookSearches');
    const own = on({
      facebookSearches: [...phrases, 'answering service'],
      wordsWritten: ['facebook'],
    });
    expect(postSearchWords([own], 'facebook', 0)).toEqual(phrases);
    expect(postSearchWords([own], 'facebook', 1)[0]).toBe('answering service');
    // LinkedIn's phrases are LinkedIn's alone.
    expect(postSearchWords([own], 'linkedin', 0)).not.toContain('anyone use a CRM');
  });

  it('searches nothing on Facebook until the AI writes the phrases, or once the person empties them', () => {
    // LinkedIn falls back on the signs and words for groups; Facebook waits for phrases on the topic.
    expect(postSearchWords([on({})], 'facebook', 0)).toEqual([]);
    expect(postSearchWords([on({})], 'linkedin', 0)).toEqual(['missed calls', 'roofers']);
    expect(
      postSearchWords([on({ facebookSearches: [], wordsWritten: ['facebook'] })], 'facebook', 0),
    ).toEqual([]);
  });
});

describe('comments that sound like someone who knows the field', () => {
  const ask = (group: string | null, platform: 'facebook' | 'instagram' | 'linkedin') =>
    todayDraftPrompt({
      kind: 'comment',
      business: 'Bright Books',
      name: 'Sam Lee',
      facts: [],
      recent: [],
      playbook: null,
      post: { text: 'How do you all keep up with calls in storm season?', group },
      platform,
    });

  it('asks for a peer’s useful point, with no stock praise and nothing made up', () => {
    const facebook = ask('Austin Roofers', 'facebook');
    expect(facebook).toContain('as someone who knows this field well talking to a peer');
    expect(facebook).toContain('Never open with praise or thanks');
    expect(facebook).toContain('Never invent experience, numbers or results');
    expect(facebook).toContain('no hard pitch and no link unless they asked for one');
    expect(facebook).not.toContain('friendly local');
    // A comment that waits to be posted never carries a link, and keeps to the network's words.
    const instagram = ask(null, 'instagram');
    expect(instagram).toContain('no pitch beyond that and no link or web address');
    expect(ask(null, 'linkedin')).toContain('They posted this on LinkedIn.');
  });

  it('drops the stock praise a draft opens with, and keeps its point', () => {
    expect(
      withoutStockPraise('Great post! Text back within a minute and most jobs stay yours.'),
    ).toBe('Text back within a minute and most jobs stay yours.');
    expect(withoutStockPraise('Love this, Sam! 🙌 A text back beats a callback every time.')).toBe(
      'A text back beats a callback every time.',
    );
    expect(withoutStockPraise('So true. the first five minutes decide most jobs.')).toBe(
      'The first five minutes decide most jobs.',
    );
    expect(withoutStockPraise('Thanks for sharing!\nWrap the truck and it works for you.')).toBe(
      'Wrap the truck and it works for you.',
    );
    // A first sentence that says something stays, even one that starts like praise.
    for (const kept of [
      'Good gutters save roofs. Clean them twice a year.',
      'Great point about speed to lead. Text back fast.',
      'Absolutely, the first five minutes matter most.',
    ])
      expect(withoutStockPraise(kept)).toBe(kept);
    // Nothing worth saying after it: no draft.
    expect(withoutStockPraise('Agreed. So true!')).toBeNull();
    expect(withoutStockPraise('Great post!')).toBeNull();
  });
});
