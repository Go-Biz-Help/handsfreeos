/** The business's logo and colour (look/): the colour maths, what's kept, read forgivingly, and the words. */
import { describe, expect, it } from 'vitest';
import {
  buttonColorFor,
  colorOfPixels,
  contrastRatio,
  isColorful,
  isLookColor,
  LOOK_ASK_AGAIN_MS,
  LOOK_DEFAULT_COLOR,
  LOOK_LOGO_PATH,
  LOOK_UPLOAD_PATH,
  LOOK_WAIT_MS,
  LOOK_WORDS,
  logoUrlFor,
  lookOf,
  lookProgressOf,
  lookSearchDue,
  mixColors,
  NO_LOOK,
  siteNameOf,
  type BusinessLook,
} from '../src';

const WS = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-000000000002';
const SITE = 'https://lonestarhvac.com';
const NOW = new Date('2026-10-07T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/** Pixels of one colour, n of them, as a logo's RGBA bytes. */
const pixels = (hex: string, n: number, alpha = 255): number[] => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Array.from({ length: n }, () => [r!, g!, b!, alpha]).flat();
};

describe('the colour', () => {
  it('keeps colours as #rrggbb', () => {
    expect(isLookColor('#2d69d8')).toBe(true);
    expect(isLookColor('#2D69D8')).toBe(true);
    expect(isLookColor('2d69d8')).toBe(false);
    expect(isLookColor('#fff')).toBe(false);
    expect(isLookColor(null)).toBe(false);
  });

  it('mixes two colours', () => {
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixColors('#2d69d8', '#2d69d8', 0.7)).toBe('#2d69d8');
  });

  it('darkens a button just enough for white words to read, and keeps one that already does', () => {
    expect(buttonColorFor('#2d69d8')).toBe('#2d69d8');
    expect(buttonColorFor('#191d25')).toBe('#191d25');
    for (const pale of ['#f5c518', '#7dd3fc', '#ffffff', '#00ff00']) {
      const out = buttonColorFor(pale);
      expect(contrastRatio(out, '#ffffff')).toBeGreaterThanOrEqual(4.5);
      expect(out).not.toBe(pale);
    }
    expect(buttonColorFor(null)).toBe(LOOK_DEFAULT_COLOR);
    expect(buttonColorFor('not a colour')).toBe(LOOK_DEFAULT_COLOR);
  });

  it('counts only colours with colour in them', () => {
    expect(isColorful('#2d69d8')).toBe(true);
    expect(isColorful('#b42318')).toBe(true);
    expect(isColorful('#ffffff')).toBe(false);
    expect(isColorful('#000000')).toBe(false);
    expect(isColorful('#808080')).toBe(false);
  });
});

describe('the colour a logo stands for', () => {
  it('is its most common strong colour, whatever white and see-through is round it', () => {
    const logo = [
      ...pixels('#ffffff', 400),
      ...pixels('#000000', 50, 0),
      ...pixels('#b42318', 120),
      ...pixels('#2d69d8', 40),
    ];
    expect(colorOfPixels(logo)).toBe('#b42318');
  });

  it('counts a gradient as one colour', () => {
    const blues = ['#1e40af', '#2563eb', '#3b82f6', '#60a5fa'].flatMap((c) => pixels(c, 30));
    const out = colorOfPixels([...blues, ...pixels('#b42318', 50)])!;
    expect(out).not.toBe('#b42318');
    expect(isColorful(out)).toBe(true);
  });

  it('is near-black for a black logo, and nothing for one with no colour', () => {
    expect(colorOfPixels([...pixels('#111111', 300), ...pixels('#ffffff', 300)])).toBe('#191d25');
    // A few coloured pixels at a black logo's edges don't make it colourful.
    expect(colorOfPixels([...pixels('#111111', 900), ...pixels('#2d69d8', 3)])).toBe('#191d25');
    expect(colorOfPixels(pixels('#ffffff', 100))).toBeNull();
    expect(colorOfPixels(pixels('#2d69d8', 100, 0))).toBeNull();
    expect(colorOfPixels([])).toBeNull();
  });
});

describe('what’s kept', () => {
  const look: BusinessLook = {
    ...NO_LOOK,
    logo: { path: `${WS}/logo/${ID}.png`, width: 400, height: 120, from: 'website', at: ago(0) },
    color: { hex: '#b42318', from: 'logo', at: ago(0) },
  };

  it('reads each part forgivingly: one that doesn’t parse counts as never set', () => {
    expect(lookOf({ look })).toEqual(look);
    expect(lookOf(null)).toEqual(NO_LOOK);
    expect(lookOf({ look: 'oops' })).toEqual(NO_LOOK);
    expect(
      lookOf({ look: { ...look, logo: { ...look.logo, path: '../../etc/passwd' }, color: 7 } }),
    ).toEqual({ ...NO_LOOK, logo: null, color: null });
    expect(
      lookOf({ look: { color: { hex: '#B42318', from: 'person', at: ago(0) } } }).color,
    ).toEqual({ hex: '#b42318', from: 'person', at: ago(0) });
  });

  it('keeps logos and uploads only at their own places', () => {
    expect(LOOK_LOGO_PATH.test(`${WS}/logo/${ID}.png`)).toBe(true);
    expect(LOOK_LOGO_PATH.test(`${WS}/logo/${ID}.svg`)).toBe(false);
    expect(LOOK_UPLOAD_PATH.test(`${WS}/${ID}.svg`)).toBe(true);
    expect(LOOK_UPLOAD_PATH.test(`${WS}/${ID}.exe`)).toBe(false);
    expect(LOOK_UPLOAD_PATH.test(`${WS}/../${ID}.png`)).toBe(false);
  });

  it('shows a logo at Storage’s public address', () => {
    expect(logoUrlFor('https://abc.supabase.co/', `${WS}/logo/${ID}.png`)).toBe(
      `https://abc.supabase.co/storage/v1/object/public/brand/${WS}/logo/${ID}.png`,
    );
  });
});

describe('looking for the logo', () => {
  it('looks on the website once for each address, again only after a while when nothing came of it', () => {
    expect(lookSearchDue(NO_LOOK, SITE, NOW)).toBe(true);
    expect(lookSearchDue(NO_LOOK, null, NOW)).toBe(false);
    const asked = { ...NO_LOOK, asked: { url: SITE, at: ago(60_000) } };
    expect(lookSearchDue(asked, SITE, NOW)).toBe(false);
    expect(
      lookSearchDue({ ...asked, asked: { url: SITE, at: ago(LOOK_ASK_AGAIN_MS) } }, SITE, NOW),
    ).toBe(true);
    expect(lookSearchDue(asked, 'https://new.example', NOW)).toBe(true);
    const searched = { ...asked, searched: { url: SITE, at: ago(30_000), found: false } };
    expect(lookSearchDue(searched, SITE, NOW)).toBe(false);
    const kept = {
      ...NO_LOOK,
      logo: {
        path: `${WS}/logo/${ID}.png`,
        width: 1,
        height: 1,
        from: 'upload' as const,
        at: ago(0),
      },
    };
    expect(lookSearchDue(kept, SITE, NOW)).toBe(false);
  });

  it('says what’s happening, until it stops waiting', () => {
    expect(lookProgressOf(NO_LOOK, NOW)).toBe('idle');
    const asked = { ...NO_LOOK, asked: { url: SITE, at: ago(5_000) } };
    expect(lookProgressOf(asked, NOW)).toBe('searching');
    expect(lookProgressOf({ ...asked, asked: { url: SITE, at: ago(LOOK_WAIT_MS) } }, NOW)).toBe(
      'idle',
    );
    expect(
      lookProgressOf({ ...asked, searched: { url: SITE, at: ago(1_000), found: false } }, NOW),
    ).toBe('idle');
    // A look at the website before this one doesn't answer it, nor one at another address.
    expect(
      lookProgressOf({ ...asked, searched: { url: SITE, at: ago(60_000), found: false } }, NOW),
    ).toBe('searching');
    expect(
      lookProgressOf(
        { ...asked, searched: { url: 'https://old.example', at: ago(1_000), found: false } },
        NOW,
      ),
    ).toBe('searching');
    const upload = {
      path: `${WS}/${ID}.png`,
      name: 'logo.png',
      by: ID,
      at: ago(2_000),
      sent: true,
    };
    expect(lookProgressOf({ ...NO_LOOK, upload }, NOW)).toBe('making');
    expect(lookProgressOf({ ...NO_LOOK, upload: { ...upload, sent: false } }, NOW)).toBe('idle');
  });
});

describe('the words', () => {
  it('names a website the way people say it', () => {
    expect(siteNameOf('https://www.lonestarhvac.com/about')).toBe('lonestarhvac.com');
    expect(siteNameOf('lonestarhvac.com/x')).toBe('lonestarhvac.com');
    expect(LOOK_WORDS.notFound(SITE)).toBe(
      'We didn’t find a logo on lonestarhvac.com. Upload one if you have it.',
    );
  });

  it('sums up what’s kept', () => {
    expect(LOOK_WORDS.summary(true)).toBe(
      'Your logo and colour are on your booking page, website chat, invoices and emails.',
    );
    expect(LOOK_WORDS.summary(false)).toBe(
      'Your colour is on your booking page, website chat, invoices and emails.',
    );
  });
});
