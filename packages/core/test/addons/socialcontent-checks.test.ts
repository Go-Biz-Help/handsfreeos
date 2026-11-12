/**
 * AI Social Media Content Creator's picture check and OpenAI's whole graphics (docs/socialcontent.md, "Variety";
 * decision 40): what the check is told and how its answer is read, when a graphic is tried, and what OpenAI is asked.
 * No database.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  checkedPictureCheck,
  fitsGraphic,
  fixAsk,
  graphicDue,
  graphicPromptFor,
  PICTURE_CHECK_SYSTEM,
  pictureCheckPrompt,
  wordsOfPage,
  type GraphicTry,
} from '../../src/addons/socialcontent/check-ai';
import type { DesignPage } from '../../src/addons/socialcontent/posts-ai';

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
    expect(wordsOfPage(page({ items: ['One', 'Two'], mark: '78%' }))).toEqual([
      'Winter tip',
      'Your pipes can freeze tonight',
      '78%',
      'One',
      'Two',
      'Example Plumbing',
    ]);
    const prompt = pictureCheckPrompt([['Hello'], ['There', 'Friend']]);
    expect(prompt).toContain('are 2 pages');
    expect(prompt).toContain('<words page="2">');
    expect(prompt).toContain('- There');
    expect(PICTURE_CHECK_SYSTEM).toMatch(/misspelt/);
    expect(PICTURE_CHECK_SYSTEM).toMatch(/Canva/);
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
  });
});
