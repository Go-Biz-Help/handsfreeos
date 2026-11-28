/**
 * How the Content Creator's pictures look (design tools, part 6; docs/socialcontent.md, "How your pictures look"): the
 * look as kept and changed, the brand kit's font drawn as the nearest of the four the worker ships, the fonts and
 * layouts the design AI is held to, which pages carry the logo, and the words a person can change on a drawn picture.
 * No database.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedFont,
  allowedLayout,
  designAllowedOf,
  designFontForKit,
  fontsFor,
  layoutsFor,
  logoOnPage,
  NO_PICTURE_LOOK,
  ownPhotoOf,
  pageFields,
  photoFileOf,
  pictureLookChanged,
  pictureLookOf,
  PictureLookInput,
  pictureWordsOf,
} from '../../src/addons/socialcontent/picture-look';
import {
  checkedDesign,
  DESIGN_SCHEMA,
  DESIGN_SYSTEM,
  designChoices,
  designSchemaFor,
  designSystemFor,
  type DesignAnswer,
} from '../../src/addons/socialcontent/posts-ai';
import { DESIGN_FONTS, DESIGN_STYLES } from '../../src/addons/socialcontent/design-names';

const PHOTO_ID = '7b0c9a52-6f0e-4b8e-9f61-1d2c3b4a5e6f';

describe('the look as kept', () => {
  it('reads forgivingly, leaving unset what doesn’t make sense', () => {
    expect(pictureLookOf(undefined)).toEqual(NO_PICTURE_LOOK);
    expect(pictureLookOf({ logo: 'sideways', fonts: 'loud', layouts: ['nope'] })).toEqual(
      NO_PICTURE_LOOK,
    );
    expect(
      pictureLookOf({
        logo: 'last',
        fonts: ['friendly', 'x', 'loud'],
        layouts: ['clean', 'photo'],
      }),
    ).toEqual({ logo: 'last', fonts: ['loud', 'friendly'], layouts: ['clean', 'photo'] });
    // Layouts it couldn't design with (no photo layout) are every layout again.
    expect(pictureLookOf({ layouts: ['clean', 'list'] }).layouts).toBeNull();
  });

  it('changes only what’s given, and keeps every layout as unset', () => {
    const was = pictureLookOf({ logo: 'never', fonts: ['classic'], layouts: ['bold', 'framed'] });
    expect(pictureLookChanged(was, { logo: 'corner' })).toEqual({ ...was, logo: 'corner' });
    expect(pictureLookChanged(was, { fonts: null }).fonts).toBeNull();
    expect(pictureLookChanged(was, { layouts: [...DESIGN_STYLES] }).layouts).toBeNull();
    expect(pictureLookChanged(was, { fonts: ['loud', 'modern'] }).fonts).toEqual([
      'modern',
      'loud',
    ]);
  });

  it('refuses a change it couldn’t design with, saying what to keep', () => {
    const no = (v: unknown) => {
      const r = PictureLookInput.safeParse(v);
      return r.success ? null : r.error.issues.map((i) => i.message);
    };
    expect(no({ fonts: [] })).toEqual(['Keep at least one font, or pick Like my brand kit.']);
    expect(no({ layouts: ['list', 'photo'] })![0]).toMatch(/Bold, Clean, Split or Sticky note/);
    expect(no({ layouts: ['clean', 'list'] })![0]).toMatch(/Keep Photo or Framed/);
    expect(no({ layouts: ['note', 'framed'], fonts: ['classic'], logo: 'last' })).toBeNull();
    expect(no({ logo: 'top' })).not.toBeNull();
  });
});

describe('the brand kit’s font', () => {
  it('draws as the nearest of the four the worker ships', () => {
    expect(designFontForKit(null)).toBeNull();
    expect(designFontForKit('  ')).toBeNull();
    expect(designFontForKit('Inter')).toBe('modern');
    expect(designFontForKit('Playfair Display')).toBe('classic');
    expect(designFontForKit('Lora')).toBe('classic');
    expect(designFontForKit('Merriweather')).toBe('classic');
    expect(designFontForKit('Bebas Neue')).toBe('loud');
    expect(designFontForKit('Nunito')).toBe('friendly');
    expect(designFontForKit('Some Sans')).toBe('modern');
  });

  it('is the only font until the business picks its own; all four when the kit has none', () => {
    expect(fontsFor(NO_PICTURE_LOOK, 'Lora')).toEqual(['classic']);
    expect(fontsFor(NO_PICTURE_LOOK, null)).toEqual([...DESIGN_FONTS]);
    expect(fontsFor({ ...NO_PICTURE_LOOK, fonts: ['loud', 'friendly'] }, 'Lora')).toEqual([
      'loud',
      'friendly',
    ]);
    expect(layoutsFor(NO_PICTURE_LOOK)).toEqual([...DESIGN_STYLES]);
    expect(designAllowedOf({ ...NO_PICTURE_LOOK, layouts: ['split', 'photo'] }, null)).toEqual({
      fonts: [...DESIGN_FONTS],
      layouts: ['split', 'photo'],
    });
  });
});

describe('what the design AI is held to', () => {
  const allowed = { fonts: ['friendly'] as const, layouts: ['clean', 'list', 'framed'] as const };

  it('is told, and answers in, only the fonts and layouts allowed', () => {
    // Everything allowed is what it was told before part 6.
    expect(designSystemFor()).toBe(DESIGN_SYSTEM);
    expect(designSchemaFor()).toEqual(DESIGN_SCHEMA);
    const told = designSystemFor(allowed);
    expect(told).toContain('Use the "friendly" font');
    expect(told).not.toContain('"loud"');
    expect(told).toContain('"list"');
    expect(told).not.toContain('"bold"');
    const schema = JSON.stringify(designSchemaFor(allowed));
    expect(schema).toContain('["friendly"]');
    expect(schema).toContain('["clean","list","framed"]');
  });

  it('steers to the allowed layouts, repeating one when it can’t avoid it', () => {
    const first = () => 0;
    expect(designChoices([], false, first, allowed)).toMatchObject({
      tryFirst: expect.arrayContaining(['clean', 'list']),
      fonts: ['friendly'],
    });
    // Framed is the only photo layout: it was last time, and still is.
    expect(
      designChoices([{ style: 'framed', font: 'friendly' }], true, first, allowed),
    ).toMatchObject({ avoid: [], tryFirst: ['framed'] });
  });

  it('swaps a layout or font it isn’t allowed for one it is', () => {
    const answer: DesignAnswer = {
      style: null,
      font: 'loud',
      background: '#ffffff',
      text: '#111111',
      accent: '#2d69d8',
      photo: true,
      pages: [
        {
          layout: 'photo',
          kicker: null,
          heading: 'Pipes',
          body: null,
          items: [],
          mark: null,
          footer: null,
        },
        {
          layout: 'bold',
          kicker: null,
          heading: 'Drip',
          body: null,
          items: [],
          mark: null,
          footer: null,
        },
      ],
    };
    const d = checkedDesign(answer, '#2d69d8', 2, { photo: true, allowed })!;
    expect(d.font).toBe('friendly');
    expect(d.pages.map((p) => p.layout)).toEqual(['framed', 'clean']);
    expect(allowedFont('classic', ['loud'])).toBe('loud');
    expect(allowedLayout('quote', ['note', 'photo'], false)).toBe('note');
    expect(allowedLayout('photo', ['note', 'framed'], true)).toBe('framed');
  });
});

describe('the logo', () => {
  it('goes on every page, the last one only, or none', () => {
    expect([0, 1, 2].map((i) => logoOnPage('corner', i, 3))).toEqual([true, true, true]);
    expect([0, 1, 2].map((i) => logoOnPage('last', i, 3))).toEqual([false, false, true]);
    expect([0, 1, 2].map((i) => logoOnPage('never', i, 3))).toEqual([false, false, false]);
  });
});

describe('a picture’s words, to change by hand', () => {
  const page = (over: Record<string, unknown> = {}) => ({
    layout: 'list',
    kicker: '',
    heading: 'Three signs',
    body: null,
    items: ['Drips', 7, 'Stains'],
    mark: null,
    footer: 'Pipes Co',
    ...over,
  });

  it('shows the parts each layout draws', () => {
    expect(pageFields('bold')).toEqual(['kicker', 'heading', 'body', 'footer']);
    expect(pageFields('number')).toEqual(['kicker', 'heading', 'mark', 'body', 'footer']);
    expect(pageFields('beforeAfter')).toEqual(['kicker', 'heading', 'items', 'body', 'footer']);
  });

  it('reads them from the design, or not when they can’t be drawn again', () => {
    expect(pictureWordsOf({ pages: [page()] })).toEqual([
      {
        layout: 'list',
        kicker: null,
        heading: 'Three signs',
        body: null,
        items: ['Drips', 'Stains'],
        mark: null,
        footer: 'Pipes Co',
      },
    ]);
    expect(pictureWordsOf(null)).toBeNull();
    expect(pictureWordsOf({ pages: [] })).toBeNull();
    // OpenAI made the words with its graphic.
    expect(pictureWordsOf({ pages: [page()], graphic: { tried: true, passed: true } })).toBeNull();
    // A photo page made before part 6, its photo not kept.
    expect(pictureWordsOf({ photo: true, pages: [page({ layout: 'photo' })] })).toBeNull();
    expect(
      pictureWordsOf({ photo: true, photoFile: PHOTO_ID, pages: [page({ layout: 'photo' })] }),
    ).not.toBeNull();
  });

  it('finds the photo the words are over: the business’s own, else OpenAI’s', () => {
    expect(photoFileOf({ photoFile: PHOTO_ID })).toBe(PHOTO_ID);
    expect(photoFileOf({ own: PHOTO_ID, photoFile: 'x' })).toBe(PHOTO_ID);
    expect(photoFileOf({ photoFile: 'not-an-id' })).toBeNull();
    expect(ownPhotoOf({ photoFile: PHOTO_ID })).toBeNull();
    expect(ownPhotoOf({ own: PHOTO_ID })).toBe(PHOTO_ID);
  });
});
