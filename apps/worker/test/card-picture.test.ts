/**
 * A business card's picture straightened (contacts/card-picture.ts): pictures drawn here of a white card lying at an
 * angle on a dark table, with the AI's rough corners a little off, come back as the card alone, at its true shape.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  cardSize,
  homography,
  project,
  straightenCard,
  trueShape,
  type Pt,
  type Quad,
} from '../src/contacts/card-picture';

const W = 1200;
const H = 900;

/** A card drawn where `q` says, words and all, on a dark, slightly patterned table. */
async function cardPhoto(q: Quad): Promise<Buffer> {
  const flat: Quad = [
    { x: 0, y: 0 },
    { x: 350, y: 0 },
    { x: 350, y: 200 },
    { x: 0, y: 200 },
  ];
  const hm = homography(flat, q);
  const poly = (pts: readonly Pt[], fill: string) =>
    `<polygon fill="${fill}" points="${pts
      .map((p) => project(hm, p))
      .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(' ')}"/>`;
  const bar = (x: number, y: number, w: number, h: number) =>
    poly(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      '#1d2430',
    );
  const stripes = Array.from(
    { length: 30 },
    (_, i) => `<rect x="0" y="${i * 30}" width="${W}" height="12" fill="#3a3530"/>`,
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#2b2622"/>${stripes}
    ${poly(flat, '#f4f1ea')}
    ${bar(24, 30, 180, 22)}${bar(24, 64, 120, 12)}${bar(24, 140, 150, 10)}${bar(24, 160, 170, 10)}
    ${bar(250, 30, 70, 70)}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

const share = (q: Quad) =>
  q.map((p) => ({ x: p.x / (W - 1), y: p.y / (H - 1) })) as unknown as [Pt, Pt, Pt, Pt];

const TRUE: Quad = [
  { x: 260, y: 190 },
  { x: 930, y: 250 },
  { x: 900, y: 640 },
  { x: 230, y: 600 },
];

/** The AI's guess: each corner off by 20 to 30 pixels. */
const ROUGH: Quad = [
  { x: 282, y: 172 },
  { x: 905, y: 268 },
  { x: 924, y: 615 },
  { x: 212, y: 626 },
];

const far = (a: readonly Pt[], b: readonly Pt[]) =>
  Math.max(...a.map((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y)));

async function pixel(jpeg: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data[y * info.width + x]!;
}

describe('straightening a business card', () => {
  it('finds the edges exactly near where the AI put them, and keeps only the card', async () => {
    const photo = await cardPhoto(TRUE);
    const flat = await straightenCard(photo, share(ROUGH), { refine: true });
    expect(flat.cropped).toBe(true);
    const found = flat.corners!.map((p) => ({ x: p.x * (W - 1), y: p.y * (H - 1) }));
    // Within a few pixels of the real corners, where the AI's were 20 to 30 off.
    expect(far(found, TRUE)).toBeLessThan(5);
    expect(far(ROUGH, TRUE)).toBeGreaterThan(20);
    // A business card's shape (3.5 by 2 inches), not the squeezed shape in the photo.
    expect(flat.width / flat.height).toBeGreaterThan(1.65);
    expect(flat.width / flat.height).toBeLessThan(1.85);
    // No table at the corners: the card's own white, just inside each.
    for (const [x, y] of [
      [6, 6],
      [flat.width - 7, 6],
      [flat.width - 7, flat.height - 7],
      [6, flat.height - 7],
    ] as const)
      expect(await pixel(flat.picture, x, y)).toBeGreaterThan(200);
  });

  it('turns a card photographed sideways the right way up', async () => {
    // The card's top-left (as it reads) is at the bottom-left of the photo: it lies turned a quarter.
    const turned: Quad = [
      { x: 380, y: 820 },
      { x: 400, y: 120 },
      { x: 790, y: 130 },
      { x: 780, y: 830 },
    ];
    const photo = await cardPhoto(turned);
    const flat = await straightenCard(photo, share(turned), { refine: true });
    expect(flat.width).toBeGreaterThan(flat.height);
  });

  it('keeps corners placed by hand where they are', async () => {
    const photo = await cardPhoto(TRUE);
    const flat = await straightenCard(photo, share(ROUGH), { refine: false });
    const kept = flat.corners!.map((p) => ({ x: p.x * (W - 1), y: p.y * (H - 1) }));
    expect(far(kept, ROUGH)).toBeLessThan(1);
  });

  it('keeps the AI’s corners when there are no edges to find', async () => {
    const blank = await sharp({
      create: { width: W, height: H, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    const flat = await straightenCard(blank, share(ROUGH), { refine: true });
    const kept = flat.corners!.map((p) => ({ x: p.x * (W - 1), y: p.y * (H - 1) }));
    expect(far(kept, ROUGH)).toBeLessThan(1);
  });

  it('gives the photo back as it is with no corners', async () => {
    const photo = await cardPhoto(TRUE);
    const flat = await straightenCard(photo, null, { refine: true });
    expect(flat).toMatchObject({ cropped: false, corners: null, width: W, height: H });
  });
});

describe('a card’s true shape', () => {
  /** A 3.5 by 2 card tilted away from a camera with a 1,000-pixel lens, as its photo shows it. */
  function photographed(tiltX: number, tiltY: number): Quad {
    const corners = [
      [-1.75, -1],
      [1.75, -1],
      [1.75, 1],
      [-1.75, 1],
    ] as const;
    const [cx, sx] = [Math.cos(tiltX), Math.sin(tiltX)];
    const [cy, sy] = [Math.cos(tiltY), Math.sin(tiltY)];
    return corners.map(([x, y]) => {
      // Tilt about the x axis, then the y axis, then 9 card-heights away, a little off centre.
      const y1 = y * cx;
      const z1 = y * sx;
      const x2 = x * cy + z1 * sy;
      const z2 = -x * sy + z1 * cy + 9;
      return { x: 600 + (1000 * (x2 + 0.6)) / z2, y: 450 + (1000 * (y1 - 0.3)) / z2 };
    }) as unknown as Quad;
  }

  it('undoes the perspective', () => {
    for (const [tx, ty] of [
      [0.6, 0.2],
      [0.3, -0.5],
      [-0.45, 0.35],
    ] as const) {
      const q = photographed(tx, ty);
      expect(trueShape(q, W, H)).toBeCloseTo(1.75, 1);
      const size = cardSize(q, W, H);
      expect(size.width / size.height).toBeCloseTo(1.75, 1);
    }
  });

  it('is the measured shape when seen straight on', () => {
    const q: Quad = [
      { x: 100, y: 100 },
      { x: 450, y: 100 },
      { x: 450, y: 300 },
      { x: 100, y: 300 },
    ];
    expect(trueShape(q, W, H)).toBeCloseTo(1.75, 3);
  });
});
