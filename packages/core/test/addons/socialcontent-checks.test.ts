/**
 * AI Social Media Content Creator's picture check and OpenAI's whole graphics (docs/socialcontent.md, "Variety";
 * decision 40): what the check is told and how its answer is read, when a graphic is tried, and what OpenAI is asked.
 * No database.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  checkedPictureCheck,
  designProblems,
  fitsGraphic,
  fixAsk,
  graphicDue,
  graphicPromptFor,
  pageToCheck,
  photoFixAsk,
  PICTURE_CHECK_SCHEMA,
  PICTURE_CHECK_SYSTEM,
  pictureCheckPrompt,
  withCutWords,
  wordsOfPage,
  type GraphicTry,
} from '../../src/addons/socialcontent/check-ai';
import { withoutSideLabel, type DesignPage } from '../../src/addons/socialcontent/posts-ai';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const page = (over: Partial<DesignPage> = {}): DesignPage => ({
  layout: 'photo',
  kicker: 'Winter tip',
  heading: 'Your pipes can freeze tonight',
  body: null,
  items: [],
  mark: null,
  footer: 'Example Plumbing',
  ...over,
});

describe('checking each picture before it’s kept', () => {
  it('tells the check every word each page should say, and to be strict about them', () => {
    expect(
      wordsOfPage(page({ layout: 'number', items: ['One', 'Two'], mark: '78%', body: 'Most do.' })),
    ).toEqual([
      'Winter tip',
      'Your pipes can freeze tonight',
      '78%',
      'Most do.',
      'Example Plumbing',
    ]);
    expect(wordsOfPage(page({ layout: 'list', items: ['One', 'Two'], body: 'Do these.' }))).toEqual(
      [
        'Winter tip',
        'Your pipes can freeze tonight',
        'One',
        'Two',
        'Do these.',
        'Example Plumbing',
      ],
    );
    const prompt = pictureCheckPrompt([{ words: ['Hello'] }, { words: ['There', 'Friend'] }]);
    expect(prompt).toContain('are 2 pages');
    expect(prompt).toContain('<words page="2">');
    expect(prompt).toContain('- There');
    expect(PICTURE_CHECK_SYSTEM).toMatch(/misspelt/);
    expect(PICTURE_CHECK_SYSTEM).toMatch(/Canva/);
  });

  // 13 Nov: 9 of the first 39 designs failed only for a mark or items their layout never draws.
  it('never tells the check words a layout leaves out', () => {
    expect(
      wordsOfPage(page({ layout: 'bold', items: ['One', 'Two'], mark: 'no upgrade tax' })),
    ).toEqual(['Winter tip', 'Your pipes can freeze tonight', 'Example Plumbing']);
    // A highlight's mark is words of its heading, already there.
    expect(
      wordsOfPage(
        page({ layout: 'highlight', mark: 'freeze tonight', kicker: null, footer: null }),
      ),
    ).toEqual(['Your pipes can freeze tonight']);
    // A before and after side's own "Before:" goes, since its card says it.
    expect(
      wordsOfPage(
        page({
          layout: 'beforeAfter',
          items: ['Before: pay per seat', 'After: one price', 'Extra'],
        }),
      ),
    ).toEqual([
      'Winter tip',
      'Your pipes can freeze tonight',
      'Pay per seat',
      'One price',
      'Example Plumbing',
    ]);
  });

  it('tells the check what a layout draws on purpose, such as a crossed-out myth', () => {
    const myth = pageToCheck(page({ layout: 'myth', body: 'They don’t.' }));
    expect(myth.drawn).toMatch(/crossed out/);
    const prompt = pictureCheckPrompt([pageToCheck(page({ layout: 'bold' })), myth]);
    expect(prompt).toMatch(/Page 2’s layout: The heading is a common myth, crossed out/);
    expect(prompt).not.toContain('Page 1’s layout');
    expect(PICTURE_CHECK_SYSTEM).toMatch(/never fail a page for that/);
  });

  it('fails a page whose words didn’t fit when drawn, even when the check couldn’t be asked', () => {
    const passed = { passes: true, problems: [] };
    expect(withCutWords(passed, [false, false])).toBe(passed);
    expect(withCutWords(null, [false])).toBeNull();
    expect(withCutWords(passed, [false, true])).toEqual({
      passes: false,
      problems: ['Page 2: too many words to fit, so some were left out; use fewer'],
    });
    expect(withCutWords(null, [true])).toEqual({
      passes: false,
      problems: ['too many words to fit, so some were left out; use fewer'],
    });
    expect(
      withCutWords({ passes: false, problems: ['Page 1: blurry'] }, [true, false])?.problems,
    ).toEqual([
      'Page 1: too many words to fit, so some were left out; use fewer',
      'Page 1: blurry',
    ]);
  });

  it('drops a before and after side’s own label, and keeps words that only start like one', () => {
    expect(withoutSideLabel('Before: capped contacts')).toBe('Capped contacts');
    expect(withoutSideLabel('after – one price')).toBe('One price');
    expect(withoutSideLabel('Afterwards it books itself')).toBe('Afterwards it books itself');
    expect(withoutSideLabel('Before:')).toBe('Before:');
  });

  it('passes only when every page was looked at and passed', () => {
    expect(
      checkedPictureCheck(
        {
          pages: [
            { page: 1, passes: true, problems: [] },
            { page: 2, passes: true, problems: [] },
          ],
        },
        2,
      ),
    ).toEqual({ passes: true, problems: [] });
    // A page it never answered for fails.
    expect(
      checkedPictureCheck({ pages: [{ page: 1, passes: true, problems: [] }] }, 2).passes,
    ).toBe(false);
    const failed = checkedPictureCheck(
      {
        pages: [
          { page: 1, passes: true, problems: [] },
          { page: 2, passes: false, problems: ['  “Frezze” is misspelt ', ''] },
        ],
      },
      2,
    );
    expect(failed).toEqual({ passes: false, problems: ['Page 2: “Frezze” is misspelt'] });
    // A pass that still names a problem isn't a pass.
    expect(
      checkedPictureCheck({ pages: [{ page: 1, passes: true, problems: ['Words cut off'] }] }, 1),
    ).toEqual({ passes: false, problems: ['Words cut off'] });
  });

  it('designs it again with the problems to fix', () => {
    const ask = fixAsk({ passes: false, problems: ['Words cut off', 'Too small'] }, 'brighter');
    expect(ask).toContain('brighter');
    expect(ask).toContain('Words cut off; Too small');
  });

  it('looks for the mistakes image AIs make in a photo, like a blank screen in her hand', () => {
    // The owner, 15 Nov: "the phone in her hand is just a blank white screen".
    expect(PICTURE_CHECK_SYSTEM).toMatch(
      /phone, laptop, TV or other screen someone is using that is blank, plain white, grey or black/,
    );
    expect(PICTURE_CHECK_SYSTEM).toMatch(/too many, too few or joined fingers/);
    expect(PICTURE_CHECK_SYSTEM).toMatch(/under photoProblems/);
    const item = (PICTURE_CHECK_SCHEMA as Any).properties.pages.items;
    expect(item.required).toContain('photoProblems');
  });

  it('keeps a photo’s mistakes apart, since only a new photo fixes them', () => {
    const one = checkedPictureCheck(
      {
        pages: [
          {
            page: 1,
            passes: false,
            problems: ['Heading cut off'],
            photoProblems: [' The phone screen is blank '],
          },
        ],
      },
      1,
    );
    expect(one).toEqual({
      passes: false,
      problems: ['Heading cut off', 'The phone screen is blank'],
      photo: ['The phone screen is blank'],
    });
    expect(designProblems(one)).toEqual(['Heading cut off']);
    // A design asked again is told only what a design can fix.
    expect(fixAsk(one, null)).toContain('Heading cut off');
    expect(fixAsk(one, null)).not.toContain('phone');
    expect(fixAsk({ ...one, problems: one.photo! }, 'brighter')).toBe('brighter');
    // The photo asked again is told what to avoid, without page numbers.
    const again = photoFixAsk(['Page 1: The phone screen is blank', 'Six fingers'], 'warmer');
    expect(again).toContain('warmer');
    expect(again).toContain(
      'make sure the new one has none of them: The phone screen is blank; Six fingers',
    );
    // A passing page that names only a photo problem isn't a pass.
    expect(
      checkedPictureCheck(
        { pages: [{ page: 1, passes: true, problems: [], photoProblems: ['Melted cup'] }] },
        1,
      ),
    ).toEqual({ passes: false, problems: ['Melted cup'], photo: ['Melted cup'] });
    // Many words problems still leave room for the photo's.
    const many = checkedPictureCheck(
      {
        pages: [
          {
            page: 1,
            passes: false,
            problems: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
            photoProblems: ['Blank screen'],
          },
        ],
      },
      1,
    );
    expect(many.problems).toHaveLength(CHECKS.problems);
    expect(many.problems.at(-1)).toBe('Blank screen');
    // Words that didn't fit keep the photo's problems.
    expect(withCutWords(one, [true])?.photo).toEqual(['The phone screen is blank']);
  });
});

describe('OpenAI’s whole graphics, depending on how they do', () => {
  const tried = (passed: boolean): GraphicTry => ({ tried: true, passed });
  const not: GraphicTry = { tried: false, passed: false };

  it('tries one every other photo post while they pass', () => {
    expect(graphicDue([])).toBe(true);
    expect(graphicDue([tried(true)])).toBe(false);
    expect(graphicDue([not, tried(true)])).toBe(true);
    expect(graphicDue([not, tried(false), not, tried(true)])).toBe(true);
  });

  it('waits after 2 of the last 4 failed, then tries again 4 photo posts on', () => {
    const failing = [tried(false), not, tried(false)];
    expect(graphicDue([not, ...failing])).toBe(false);
    expect(graphicDue([not, not, not, ...failing])).toBe(false);
    expect(graphicDue([not, not, not, not, ...failing])).toBe(true);
    expect(CHECKS.failuresToPause).toBe(2);
  });

  it('only puts a few words on a graphic', () => {
    expect(fitsGraphic(page())).toBe(true);
    expect(fitsGraphic(page({ heading: 'one two three four five six seven eight nine ten' }))).toBe(
      false,
    );
    expect(fitsGraphic(page({ kicker: 'a much too long small line' }))).toBe(false);
  });

  it('asks OpenAI for the exact words, the business’s colours, and nothing else written', () => {
    const prompt = graphicPromptFor({
      shows: 'A frosty window at dawn.',
      page: page(),
      colors: { background: '#ffffff', accent: '#2d69d8' },
      ask: null,
    });
    expect(prompt).toContain('"Your pipes can freeze tonight"');
    expect(prompt).toContain('"Winter tip"');
    expect(prompt).toMatch(/spelled exactly/);
    expect(prompt).toContain('#2d69d8');
    expect(prompt).toMatch(/No logos, watermarks/);
    expect(prompt).toMatch(/never a blank white, grey or black screen/);
  });
});
