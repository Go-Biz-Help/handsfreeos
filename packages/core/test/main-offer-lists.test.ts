/**
 * The main offer's lists for content, without the model (docs/main-offer.md, "For your content"): how lines are kept,
 * what the model is told for each kind of help, how its answers are checked, and how the Content Creator reads them.
 */
import { describe, expect, it } from 'vitest';
import { offerForContent, OFFER_FOR_CONTENT } from '../src/addons/socialcontent/offer-ai';
import { WRITE_SYSTEM } from '../src/addons/socialcontent/posts-ai';
import { IDEAS_SYSTEM } from '../src/addons/socialcontent/notes-ai';
import {
  checkedOfferLists,
  cleanListLines,
  listsFilled,
  listsOf,
  listsText,
  OFFER_LIST_INFO,
  OFFER_LISTS,
  OFFER_LISTS_ASK,
  OFFER_LISTS_SCHEMA,
  OfferListsAssistInput,
  offerListsPrompt,
  type OfferListsBusiness,
} from '../src/main-offer/lists';
import { MainOfferParts } from '../src/main-offer/parts';

const business: OfferListsBusiness = {
  name: 'Summit Roofing',
  lineOfWork: 'Roofing',
  brief: 'Roof repair and replacement around Denver.',
  knowledge:
    '<knowledge>\n<item id="1" kind="faq">\nQ: Do you do gutters?\nA: Yes.\n</item>\n</knowledge>',
};

const parts = MainOfferParts.parse({
  who: { work: 'Homeowners', slice: 'with storm damage', problem: 'Leaks they can’t find' },
  outcome: { result: 'A dry roof in a week' },
  method: {
    steps: ['Drone check', 'Insurance help', 'New roof'],
    different: 'Photos the same day',
  },
  guarantee: { promise: 'No leak for 10 years, or we fix it free' },
  price: { amount: '$9,000' },
  line: 'We get storm-hit homes a dry roof in a week.',
});

const input = (i: unknown) => OfferListsAssistInput.parse(i);

describe('the lists for content', () => {
  it('keep each line once, tidied, up to 12 a list', () => {
    expect(
      cleanListLines(['  Same  day photos ', 'same day photos', '', 'Free drone check']),
    ).toEqual(['Same day photos', 'Free drone check']);
    expect(cleanListLines(Array.from({ length: 20 }, (_, i) => `Line ${i}`))).toHaveLength(12);
    expect(cleanListLines(['x'.repeat(400)])[0]).toHaveLength(300);
  });

  it('read safely from what’s kept: unknown lists, non-strings and empty lists are left out', () => {
    expect(listsOf(null)).toEqual({});
    expect(listsOf(['different'])).toEqual({});
    expect(
      listsOf({ different: ['A', 3, 'a', 'B'], nope: ['x'], never: [], voice: 'Friendly' }),
    ).toEqual({ different: ['A', 'B'] });
    expect(listsFilled({ different: ['A'], topics: ['Storms'] })).toBe(2);
  });

  it('read to the model each under its name, the empty ones left out', () => {
    expect(listsText({})).toBe('');
    expect(listsText({ never: ['No prices.'], different: ['Same-day photos'] })).toBe(
      'What makes you different:\n- Same-day photos\nNever say:\n- No prices.',
    );
    // Every list has its words for the page and the model.
    for (const k of OFFER_LISTS) {
      expect(OFFER_LIST_INFO[k].label).toBeTruthy();
      expect(OFFER_LIST_INFO[k].forAi).toBeTruthy();
    }
  });

  it('ask for a list, and a line to improve', () => {
    expect(() => input({ mode: 'write' })).toThrow('Say which list.');
    expect(() => input({ mode: 'improve', list: 'different' })).toThrow(
      'Say which line to improve.',
    );
    expect(input({ mode: 'gaps' })).toEqual({ mode: 'gaps' });
  });
});

describe('what the model is told', () => {
  it('quotes the business, the offer without its price, the lists and the line, and ends with the ask', () => {
    const prompt = offerListsPrompt(
      business,
      parts,
      'Only storm work',
      { different: ['Photos <b>same</b> day'] },
      input({ mode: 'improve', list: 'different', line: 'Photos <b>same</b> day' }),
    );
    expect(prompt).toContain('Name: Summit Roofing');
    expect(prompt).toContain('Line of work: Roofing');
    expect(prompt).toContain('A dry roof in a week');
    expect(prompt).toContain('No leak for 10 years');
    expect(prompt).not.toContain('$9,000');
    expect(prompt).toContain('<direction>\nOnly storm work\n</direction>');
    expect(prompt).toContain('Q: Do you do gutters?');
    expect(prompt).toContain('Photos &lt;b&gt;same&lt;/b&gt; day');
    expect(prompt).not.toContain('<b>');
    expect(prompt).toContain('Rewrite the line under <line> 3 ways');
    expect(prompt.endsWith(OFFER_LISTS_ASK)).toBe(true);
  });

  it('asks for as many new lines as the list has room for, examples to model, or what’s missing', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `Line ${i}`);
    expect(
      offerListsPrompt(
        business,
        null,
        null,
        { topics: eleven },
        input({ mode: 'write', list: 'topics' }),
      ),
    ).toContain('Write up to 1 new lines');
    expect(
      offerListsPrompt(business, null, null, {}, input({ mode: 'examples', list: 'myths' })),
    ).toContain('same line of work as the one under <business>');
    const gaps = offerListsPrompt(business, null, null, {}, input({ mode: 'gaps' }));
    expect(gaps).toContain('(no offer yet)');
    expect(gaps).toContain('(none written yet)');
    expect(gaps).toContain('Put them in "gaps"');
    expect(OFFER_LISTS_SCHEMA.required).toEqual(['options', 'gaps']);
  });
});

describe('what the model answers, checked', () => {
  it('keeps new lines only: none the list has, none twice, no long dashes, within room', () => {
    const out = checkedOfferLists(
      {
        options: [
          'Same-day photos',
          'Free drone check — no ladder',
          'free drone check — no ladder',
          'x'.repeat(301),
          '  ',
        ],
        gaps: [{ list: 'story', note: 'ignored here' }],
      },
      input({ mode: 'write', list: 'different' }),
      { different: ['Same-day photos'] },
    );
    expect(out.gaps).toEqual([]);
    expect(out.options).toHaveLength(1);
    expect(out.options[0]).toMatch(/^Free drone check/);
    expect(out.options[0]).not.toContain('—');
  });

  it('gives three rewrites at most, never the line itself, and five examples at most', () => {
    const improve = checkedOfferLists(
      { options: ['Mine', 'A', 'B', 'C', 'D'], gaps: [] },
      input({ mode: 'improve', list: 'voice', line: 'Mine' }),
      {},
    );
    expect(improve.options).toEqual(['A', 'B', 'C']);
    const examples = checkedOfferLists(
      { options: ['1', '2', '3', '4', '5', '6'], gaps: [] },
      input({ mode: 'examples', list: 'voice' }),
      {},
    );
    expect(examples.options).toHaveLength(5);
  });

  it('keeps what’s missing only about real lists, once each, up to five', () => {
    const out = checkedOfferLists(
      {
        options: ['ignored'],
        gaps: [
          { list: 'story', note: 'Say why you started.' },
          { list: 'story', note: 'Again' },
          { list: 'nope', note: 'Not a list' },
          { list: 'voice', note: '' },
          { list: 'asks', note: 'Add how to book.' },
        ],
      },
      input({ mode: 'gaps' }),
      {},
    );
    expect(out).toEqual({
      options: [],
      gaps: [
        { list: 'story', note: 'Say why you started.' },
        { list: 'asks', note: 'Add how to book.' },
      ],
    });
  });
});

describe('how the Content Creator reads them', () => {
  it('quotes the live offer without its price, and the lists, in their own blocks', () => {
    const text = offerForContent(parts, { voice: ['Friendly & plain'], asks: ['Book a check'] });
    expect(text).toContain('<main_offer>');
    expect(text).toContain('A dry roof in a week');
    expect(text).not.toContain('$9,000');
    expect(text).toContain('<content_lists>\nYour voice:\n- Friendly &amp; plain');
    expect(offerForContent(null, {})).toBe('');
    expect(offerForContent(null, { never: ['No prices.'] })).not.toContain('<main_offer>');
  });

  it('is told to build every post and idea on them, with the never-say list as hard rules', () => {
    expect(OFFER_FOR_CONTENT).toContain('Never say');
    expect(WRITE_SYSTEM).toContain(OFFER_FOR_CONTENT);
    expect(IDEAS_SYSTEM).toContain(OFFER_FOR_CONTENT);
    expect(WRITE_SYSTEM).toContain('<content_lists>');
  });
});
