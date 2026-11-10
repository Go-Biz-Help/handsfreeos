/**
 * Drawing the AI's designs (apps/worker/src/addons/socialcontent/draw.ts): words the shipped font can draw, and a
 * PNG of the right size for each page, in every layout. No database.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Design } from '@hfos/core/addons/socialcontent/posts-ai';
import {
  drawable,
  drawDesign,
  PICTURE_HEIGHT,
  PICTURE_WIDTH,
} from '../src/addons/socialcontent/draw';

describe('words the font can draw', () => {
  it('turns arrows into ›, and leaves out emoji', () => {
    expect(drawable('Swipe → for more 🚀')).toBe('Swipe › for more');
    expect(drawable('Save it ❤️ and share 👨‍👩‍👧')).toBe('Save it and share');
  });

  it('keeps accents, curly quotes, dashes and money', () => {
    expect(drawable('Café “deals” – €20 ™ ©')).toBe('Café “deals” – €20 ™ ©');
  });

  it('gives an empty line for nothing', () => {
    expect(drawable(null)).toBe('');
    expect(drawable('  \n ')).toBe('');
  });
});

describe('drawing a design', () => {
  const page = (heading: string) => ({
    kicker: 'Tip',
    heading,
    body: 'Answer every lead within five minutes, even after hours, and watch more of them book.',
    footer: 'Example Co',
  });

  for (const style of ['bold', 'clean', 'split'] as const) {
    it(`draws each ${style} page as a 1080 by 1350 PNG`, async () => {
      const d: Design = {
        style,
        background: style === 'clean' ? '#ffffff' : '#2d69d8',
        text: style === 'clean' ? '#111111' : '#ffffff',
        accent: '#f5a524',
        pages: [page('Three ways to never miss a lead'), page('A very long heading '.repeat(8))],
      };
      const pngs = await drawDesign(d);
      expect(pngs).toHaveLength(2);
      for (const png of pngs) {
        const meta = await sharp(png).metadata();
        expect(meta.format).toBe('png');
        expect([meta.width, meta.height]).toEqual([PICTURE_WIDTH, PICTURE_HEIGHT]);
      }
    });
  }
});
