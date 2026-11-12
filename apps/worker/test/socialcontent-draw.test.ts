/**
 * Drawing the AI's designs (apps/worker/src/addons/socialcontent/draw.ts): words the shipped fonts can draw, and a
 * picture of the right size for each page, in every layout and font, over a photo or not (decision 39). No database.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_FONTS,
  DESIGN_STYLES,
  type Design,
  type DesignFont,
  type DesignPage,
  type DesignStyle,
} from '@hfos/core/addons/socialcontent/posts-ai';
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
  const page = (layout: DesignStyle, heading: string): DesignPage => ({
    layout,
    kicker: 'Tip',
    heading,
    body: 'Answer every lead within five minutes, even after hours, and watch more of them book.',
    items: ['Text back in seconds', 'Book them online', 'Remind them the day before'],
    mark: layout === 'number' ? '78%' : 'every lead',
    footer: 'Example Co',
  });
  const design = (layout: DesignStyle, font: DesignFont, photo = false): Design => ({
    style: layout,
    font,
    background: layout === 'clean' ? '#ffffff' : '#2d69d8',
    text: layout === 'clean' ? '#111111' : '#ffffff',
    accent: '#f5a524',
    photo,
    pages: [
      page(layout, 'Three ways to never miss every lead'),
      page(
        layout === 'photo' || layout === 'framed' ? 'list' : layout,
        'A very long heading '.repeat(8),
      ),
    ],
  });
  const sizeOf = async (bytes: Buffer) => {
    const meta = await sharp(bytes).metadata();
    return { format: meta.format, size: [meta.width, meta.height] };
  };

  const plain = DESIGN_STYLES.filter((s) => s !== 'photo' && s !== 'framed');
  for (const [i, layout] of plain.entries()) {
    const font = DESIGN_FONTS[i % DESIGN_FONTS.length]!;
    it(`draws each ${layout} page in the ${font} font as a 1080 by 1350 PNG`, async () => {
      const pics = await drawDesign(design(layout, font));
      expect(pics).toHaveLength(2);
      for (const pic of pics) {
        expect(pic.mimeType).toBe('image/png');
        expect(await sizeOf(pic.bytes)).toEqual({
          format: 'png',
          size: [PICTURE_WIDTH, PICTURE_HEIGHT],
        });
      }
    });
  }

  for (const layout of ['photo', 'framed'] as const)
    it(`draws a ${layout} first page over the photo as a JPEG, and the rest as PNGs`, async () => {
      const photo = await sharp({
        create: { width: 1024, height: 1536, channels: 3, background: '#88aa66' },
      })
        .jpeg()
        .toBuffer();
      const pics = await drawDesign(design(layout, 'classic', true), photo);
      expect(pics.map((p) => p.mimeType)).toEqual(['image/jpeg', 'image/png']);
      expect(await sizeOf(pics[0]!.bytes)).toEqual({
        format: 'jpeg',
        size: [PICTURE_WIDTH, PICTURE_HEIGHT],
      });
    });

  it('draws a photo layout without its photo as a bold page', async () => {
    const pics = await drawDesign(design('photo', 'loud', true), null);
    expect(pics.map((p) => p.mimeType)).toEqual(['image/png', 'image/png']);
  });
});
