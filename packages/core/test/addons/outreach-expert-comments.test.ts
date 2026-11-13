/**
 * Social Outreach's comments that sound like an expert, on posts that fit the playbook (docs/outreach.md, decisions
 * 141, 143 and 144): the post check calls a post good only when it's about the owner's own field, never the trade of
 * who a playbook is for, the comment takes a clear stand from that field and the offer's angle, offering to show them
 * only when they want the help, a draft's stock praise goes, and Facebook's post search goes with the playbooks' own
 * phrases.
 */
import { describe, expect, it } from 'vitest';
import { blankPlaybook, type PlaybookDetails } from '../../src/addons/outreach/playbooks';
import {
  POST_CHECK_SYSTEM,
  postCheckPrompt,
  postSearchWords,
  SEARCH_PARTS,
} from '../../src/addons/outreach/posts';
import {
  draftOfferOf,
  todayDraftPrompt,
  withoutStockPraise,
} from '../../src/addons/outreach/today';
import { MainOfferParts } from '../../src/main-offer/parts';

describe('posts about the owner’s own field', () => {
  it('calls a post good only when it’s about the owner’s field, never the trade of who a playbook is for', () => {
    expect(POST_CHECK_SYSTEM).toContain(
      'A post is good only when it is about the owner’s own field',
    );
    // The owner's report (1 Nov 2026): comments told a contractor what to do when a breaker trips. A playbook's niche
    // is whose posts to look at, and a post about their trade only fits (decision 143).
    expect(POST_CHECK_SYSTEM).toContain(
      'A playbook’s niche and who it is for say whose posts to look at, never the owner’s field',
    );
    expect(POST_CHECK_SYSTEM).toContain(
      'A post about the writer’s own trade or work, when that isn’t the owner’s field, is not good',
    );
    expect(POST_CHECK_SYSTEM).toContain('Say fits instead.');
    expect(POST_CHECK_SYSTEM).not.toContain('running and growing the kind of business');
    expect(POST_CHECK_SYSTEM).not.toContain('A short, genuine comment there starts a friendship');
  });

  it('tells the check what the business does, from its profile', () => {
    const prompt = (profile?: string | null) =>
      postCheckPrompt({
        business: 'Bright Books',
        profile,
        group: null,
        text: 'Anyone using AI to answer calls?',
        playbooks: [],
      });
    expect(prompt('Bookkeeping and payroll for contractors')).toContain(
      '<business_profile>\nBookkeeping and payroll for contractors\n</business_profile>',
    );
    // With none written, the offers say it alone.
    expect(prompt(null)).toContain('<business_profile>\nNothing written yet.\n</business_profile>');
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

describe('comments that sound like someone who knows the owner’s own field', () => {
  const ask = (
    group: string | null,
    platform: 'facebook' | 'instagram' | 'linkedin',
    more: Partial<Parameters<typeof todayDraftPrompt>[0]> = {},
  ) =>
    todayDraftPrompt({
      kind: 'comment',
      business: 'Bright Books',
      name: 'Sam Lee',
      facts: [],
      recent: [],
      playbook: null,
      post: { text: 'How do you all keep up with calls in storm season?', group },
      platform,
      ...more,
    });

  it('asks for a clear stand from the owner’s field, with no stock praise and nothing made up', () => {
    const facebook = ask('Austin Roofers', 'facebook');
    expect(facebook).toContain(
      'Write the owner’s public comment under it, from the owner’s own field',
    );
    // Never the writer's own trade, and nothing at all when the owner's field has nothing to add (decision 143).
    expect(facebook).toContain('never give advice about the writer’s own trade or work');
    expect(facebook).toContain(
      'When the owner’s field has nothing real to add to this post, write no drafts.',
    );
    expect(facebook).not.toContain('knows this field well');
    expect(facebook).toContain('Never open with praise or thanks');
    expect(facebook).toContain('Never invent experience, numbers or results');
    expect(facebook).not.toContain('friendly local');
    // The owner's own comment (2 Nov 2026): a bold take that challenges the usual way, never the person, and an offer to
    // show them only when the post asks for someone who offers it, with no link (decisions 144 and 163).
    expect(facebook).toContain('Take a clear stand from the owner’s field');
    expect(facebook).toContain(
      'often a bold take on what most people get wrong or do the hard way',
    );
    expect(facebook).toContain('sometimes one specific tip');
    expect(facebook).toContain('Challenge the usual way, never the person');
    expect(facebook).toContain(
      'Only when the post asks for someone who offers what the business offers, or for a recommendation of one (“anyone know a good …?”, “looking for someone to …”, “who do you use for …?”), end with a short, easy offer to show them, such as “I can show you a demo if you’re interested”, with no link, no web address and no price. A post that asks for help or tips with the topic, or complains about it, gets a take or a tip and no offer. Otherwise offer nothing and pitch nothing.',
    );
    // What the post check found (decision 163, 5a): asking for what the business offers, or not.
    const post = (asking: boolean) => ({
      post: { text: 'Anyone know a good CRM?', group: null, asking },
    });
    expect(ask(null, 'facebook', post(true))).toContain(
      'so the comment ends with the short offer to show them',
    );
    expect(ask(null, 'facebook', post(false))).toContain(
      'so the comment offers nothing and pitches nothing',
    );
    expect(facebook).not.toContain('unless they asked for one');
    // Every network's comment carries no link, and keeps to the network's words.
    const instagram = ask(null, 'instagram');
    expect(instagram).toContain('with no link, no web address and no price');
    expect(instagram).toContain('Under 30 words.');
    expect(ask(null, 'linkedin')).toContain('They posted this on LinkedIn.');
  });

  it('tells a comment the offer’s angle, never its price, guarantee or results, and no link (decision 144)', () => {
    const offer = draftOfferOf(
      3,
      MainOfferParts.parse({
        line: 'A CRM that follows up for you',
        outcome: { result: 'Every lead answered in a minute' },
        method: { steps: ['It texts every new lead back', 'It books the call on its own'] },
        guarantee: { promise: 'Or the next month is free' },
        price: { amount: '$297 a month' },
        proof: ['Pine Roofing booked 14 in 30 days'],
      }),
    );
    const playbook = { name: 'CRM demos', ...blankPlaybook(), link: 'https://cal.com/bright' };
    const facebook = ask('Austin Roofers', 'facebook', { offer, playbook });
    expect(facebook).toContain('<offer>');
    expect(facebook).toContain('The offer: A CRM that follows up for you');
    expect(facebook).toContain('The outcome, in a few words: Every lead answered in a minute');
    expect(facebook).toContain('- It texts every new lead back');
    expect(facebook).not.toContain('guarantee, only when');
    expect(facebook).not.toContain('Or the next month is free');
    expect(facebook).not.toContain('$297');
    expect(facebook).not.toContain('Pine Roofing');
    expect(facebook).not.toContain('cal.com/bright');
    // A message in the conversation still gets them all, and the link.
    const opener = todayDraftPrompt({
      kind: 'opener',
      business: 'Bright Books',
      name: 'Sam Lee',
      facts: [],
      recent: [],
      playbook,
      offer,
    });
    expect(opener).toContain('The price, only when they ask: $297 a month');
    expect(opener).toContain('Link: https://cal.com/bright');
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
