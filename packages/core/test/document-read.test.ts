/**
 * What's read off a document's PDF (docs/documents.md), the same for the web's pdf.js and the worker's drawing for
 * the phone: the words a line at a time, the lines and small boxes drawn on a page, and the colours under words.
 */
import { describe, expect, it } from 'vitest';
import {
  coloursOnPage,
  documentFontOf,
  inkOnPage,
  inkScale,
  pdfTextLines,
  pdfTextPieces,
  type PagePixels,
  type PdfTextPage,
} from '../src';

/** A white page of `w`×`h` pixels, with `ink` drawn on it in black. */
function page(w: number, h: number, ink: (x: number, y: number) => boolean): PagePixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = ink(x, y) ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

/** A page of 612 by 792 points with words written at the given baselines, as pdf.js reads it. */
function textPage(items: { str: string; x: number; y: number; size: number; width: number }[]) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
      // pdf.js's: up the page in the PDF is down the screen.
      transform: [scale, 0, 0, -scale, 0, 792 * scale],
    }),
    getTextContent: async () => ({
      items: items.map((i) => ({
        str: i.str,
        transform: [i.size, 0, 0, i.size, i.x, i.y],
        width: i.width,
        fontName: 'f1',
      })),
      styles: { f1: { ascent: 0.9, descent: -0.2, fontFamily: 'serif' } },
    }),
    commonObjs: { has: () => true, get: () => ({ name: 'ABCDEF+TimesNewRoman-Bold' }) },
  } satisfies PdfTextPage;
}

describe('the words on a page', () => {
  it('joins pieces on one line, close together and the same size, into a line to type over', async () => {
    const p = textPage([
      { str: 'Client', x: 72, y: 700, size: 12, width: 34 },
      { str: 'name:', x: 109, y: 700, size: 12, width: 30 },
      { str: 'Far away', x: 400, y: 700, size: 12, width: 45 },
      { str: 'Next line', x: 72, y: 680, size: 12, width: 50 },
    ]);
    const lines = await pdfTextLines(p);
    expect(lines.map((l) => l.text)).toEqual(['Client name:', 'Far away', 'Next line']);
    expect(lines[0]).toMatchObject({ size: 12, font: 'serif', bold: true });
    // From the top left, in fractions of the page.
    expect(lines[0]!.x).toBeCloseTo((72 - 12 * 0.08) / 612, 4);
    expect(lines[0]!.y).toBeCloseTo((92 - 12 * 0.9 - 12 * 0.08) / 792, 4);
    expect((await pdfTextPieces(p)).map((x) => x.text)).toEqual([
      'Client',
      'name:',
      'Far away',
      'Next line',
    ]);
  });

  it('picks the closest of the fonts a word change is written in', () => {
    expect(documentFontOf('', 'Courier-Bold')).toBe('mono');
    expect(documentFontOf('sans-serif', 'ArialMT')).toBe('sans');
    expect(documentFontOf('serif', 'Garamond')).toBe('serif');
    expect(documentFontOf('', 'Wingdings')).toBe('sans');
  });
});

describe('what’s drawn on a page', () => {
  it('finds a line to write on and an empty box to tick, and leaves out a filled one', () => {
    const scale = 2;
    const px = page(400, 200, (x, y) => {
      // A line 60 points long and a pixel thick.
      if (y === 50 && x >= 100 && x < 220) return true;
      // An empty square, 10 points a side.
      const inBox = x >= 40 && x <= 60 && y >= 120 && y <= 140;
      const edge = x === 40 || x === 60 || y === 120 || y === 140;
      if (inBox && edge) return true;
      // A filled one.
      return x >= 300 && x <= 320 && y >= 120 && y <= 140;
    });
    const { rules, boxes } = inkOnPage(px, scale);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ x: 100 / 400, y: 50 / 200, w: 120 / 400 });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.x).toBe(40 / 400);
  });

  it('draws big pages smaller, to keep within the pixels a phone can hold', () => {
    expect(inkScale({ width: 612, height: 792 })).toBe(2);
    expect(inkScale({ width: 2448, height: 3168 })).toBeLessThan(2);
  });

  it('reads the paper behind words and their ink', () => {
    const px = page(100, 40, (x, y) => x > 20 && x < 30 && y > 15 && y < 25);
    for (let i = 0; i < px.data.length; i += 4)
      if (px.data[i] === 255) {
        // Cream paper.
        px.data[i + 2] = 230;
      }
    expect(coloursOnPage(px, { x: 0.15, y: 0.25, w: 0.2, h: 0.5 })).toEqual({
      background: '#ffffe6',
      color: '#000000',
    });
    expect(
      coloursOnPage(
        page(0, 0, () => false),
        { x: 0, y: 0, w: 1, h: 1 },
      ),
    ).toEqual({
      background: '#ffffff',
      color: '#000000',
    });
  });
});
