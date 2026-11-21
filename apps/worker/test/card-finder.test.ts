/**
 * Finding a business card by its own edges (contacts/card-finder.ts): the parts card-picture.test.ts doesn't reach
 * through `straightenCard`. What a hint chooses and what it can't, what counts as lying on edges, and the order the
 * corners come back in.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  edgeMap,
  findCard,
  inReadingOrder,
  liesOnEdges,
  overlap,
  straightLines,
} from '../src/contacts/card-finder';
import type { Pt, Quad } from '../src/contacts/card-picture';

const W = 640;
const H = 480;

const rect = (x: number, y: number, w: number, h: number): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const points = (q: Quad) => q.map((p) => `${p.x},${p.y}`).join(' ');
const far = (a: readonly Pt[], b: readonly Pt[]) =>
  Math.max(...a.map((p) => Math.min(...b.map((o) => Math.hypot(p.x - o.x, p.y - o.y)))));

/** The edges of a picture drawn from SVG shapes on a dark ground. */
async function edgesOf(shapes: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#22252b"/>${shapes}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return edgeMap({ data, width: info.width, height: info.height });
}

const CARD = rect(150, 140, 300, 170);
/** A sheet of paper the card lies on. */
const SHEET = rect(40, 40, 560, 400);
/** A white box printed on the card. */
const BOX = rect(170, 220, 70, 70);

describe('the straight lines in a picture', () => {
  it('are the card’s four edges, each once, longest first', async () => {
    const lines = straightLines(
      await edgesOf(`<polygon fill="#f2f0ea" points="${points(CARD)}"/>`),
    );
    expect(lines).toHaveLength(4);
    const lengths = lines.map((l) => l.unbroken);
    for (const [k, length] of [300, 300, 170, 170].entries())
      expect(Math.abs(lengths[k]! - length)).toBeLessThan(14);
  });

  it('put a card’s edge ahead of a row of keys, which keeps breaking off', async () => {
    const keys = Array.from(
      { length: 11 },
      (_, i) => `<rect x="${20 + i * 52}" y="20" width="40" height="40" fill="#6a6f7a"/>`,
    ).join('');
    const lines = straightLines(
      await edgesOf(`${keys}<polygon fill="#f2f0ea" points="${points(CARD)}"/>`),
    );
    // The card's four, then nothing as long: a key's edge is 40 pixels, however many lie in a row.
    expect(lines.slice(0, 4).every((l) => l.unbroken > 150)).toBe(true);
    expect(lines.slice(4).every((l) => l.unbroken <= 44)).toBe(true);
  });
});

describe('finding the card', () => {
  const scene = `<polygon fill="#d9d6ce" points="${points(SHEET)}"/>
    <polygon fill="#fbfaf7" points="${points(CARD)}" stroke="#8a8780" stroke-width="3"/>
    <polygon fill="#3a5fcd" points="${points(BOX)}"/>`;

  it('takes the biggest clear outline with nothing pointing at one', async () => {
    const found = findCard(await edgesOf(scene), null)!;
    expect(found.agrees).toBe(false);
    expect(far(found.corners, SHEET)).toBeLessThan(3);
  });

  it('takes the outline a hint points at, however rough the hint', async () => {
    const hint = CARD.map((p, k) => ({
      x: p.x + (k % 2 ? 14 : -12),
      y: p.y + 10,
    })) as unknown as Quad;
    const found = findCard(await edgesOf(scene), hint)!;
    expect(found.agrees).toBe(true);
    expect(far(found.corners, CARD)).toBeLessThan(3);
  });

  it('isn’t moved by a hint that points at nothing', async () => {
    const found = findCard(await edgesOf(scene), rect(400, 330, 230, 140))!;
    expect(found.agrees).toBe(false);
    expect(far(found.corners, SHEET)).toBeLessThan(3);
  });

  it('finds nothing in a picture with no outline, or one too small to be the card', async () => {
    expect(findCard(await edgesOf(''), null)).toBeNull();
    const small = `<polygon fill="#f2f0ea" points="${points(rect(300, 200, 90, 52))}"/>`;
    expect(findCard(await edgesOf(small), null)).toBeNull();
  });
});

describe('lying on edges', () => {
  it('is true of the card’s outline, and not of one beside it', async () => {
    const edges = await edgesOf(`<polygon fill="#f2f0ea" points="${points(CARD)}"/>`);
    expect(liesOnEdges(edges, CARD)).toBe(true);
    // Shifted down by half a card: its top runs through the card's middle, its bottom through the table.
    expect(liesOnEdges(edges, rect(150, 225, 300, 170))).toBe(false);
  });

  it('lets one corner be cut off, and not a side that runs on past the card', async () => {
    const cut = `<polygon fill="#f2f0ea" points="150,140 400,140 450,180 450,310 150,310"/>`;
    expect(liesOnEdges(await edgesOf(cut), CARD)).toBe(true);
    // The card's top, left and right, carried on down to a line far below it.
    const edges = await edgesOf(
      `<polygon fill="#f2f0ea" points="${points(CARD)}"/>
       <rect x="0" y="440" width="${W}" height="40" fill="#8d929c"/>`,
    );
    expect(liesOnEdges(edges, rect(150, 140, 300, 300))).toBe(false);
  });
});

describe('two outlines', () => {
  it('overlap by the share of the two together that both cover', () => {
    expect(overlap(CARD, CARD)).toBeCloseTo(1, 5);
    expect(overlap(CARD, rect(300, 140, 300, 170))).toBeCloseTo(1 / 3, 5);
    expect(overlap(CARD, rect(460, 320, 100, 100))).toBe(0);
    // Going round the other way changes nothing.
    const back = [CARD[0], CARD[3], CARD[2], CARD[1]] as unknown as Quad;
    expect(overlap(back, CARD)).toBeCloseTo(1, 5);
  });
});

describe('the order the corners come back in', () => {
  const picture = { width: W, height: H };

  it('is the picture’s own with nothing to go by', () => {
    const mixed = [CARD[2], CARD[3], CARD[0], CARD[1]] as unknown as Quad;
    expect(inReadingOrder(mixed, null, picture)).toEqual(CARD);
    const back = [CARD[1], CARD[0], CARD[3], CARD[2]] as unknown as Quad;
    expect(inReadingOrder(back, null, picture)).toEqual(CARD);
  });

  it('follows a guide’s, even one that lies somewhere else in the picture', () => {
    // A card lying on its side, read from the bottom of the picture up: its top-left is at the bottom-left.
    const tall = rect(220, 60, 170, 300);
    const read: Quad = [tall[3], tall[0], tall[1], tall[2]];
    const guide = read.map((p) => ({ x: p.x * 1.2 + 90, y: p.y * 1.3 + 70 })) as unknown as Quad;
    expect(inReadingOrder(tall, guide, picture)).toEqual(read);
  });
});
