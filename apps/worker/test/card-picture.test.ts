/**
 * A business card's picture straightened (contacts/card-picture.ts, with the finder in contacts/card-finder.ts):
 * pictures drawn here of a card lying at an angle come back as the card alone, at its true shape, found by its own
 * edges. The AI's corners only say which outline is the card and which way up it reads. The scenes are drawn after
 * the owner's first two cards (17 November 2026), which were cropped a card's height too low: a dark car seat with
 * other straight edges in the picture, a card with a corner cut off, a card with a band of colour and a white box.
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

interface Scene {
  /** What the card lies on. */
  readonly ground?: 'table' | 'seat' | 'sheet' | 'keys';
  /** A band of colour across the bottom of the card, with a white box on it. */
  readonly band?: boolean;
  /** The card's top-right corner cut off. */
  readonly clipped?: boolean;
  /** No card at all: only the ground. */
  readonly bare?: boolean;
  /** The card's shape, across by down. */
  readonly shape?: readonly [number, number];
}

/** A card drawn where `q` says, words and all. */
async function cardPhoto(q: Quad, scene: Scene = {}): Promise<Buffer> {
  const [fw, fh] = scene.shape ?? [350, 200];
  const flat: Quad = [
    { x: 0, y: 0 },
    { x: fw, y: 0 },
    { x: fw, y: fh },
    { x: 0, y: fh },
  ];
  const hm = homography(flat, q);
  const poly = (pts: readonly Pt[], fill: string) =>
    `<polygon fill="${fill}" points="${pts
      .map((p) => project(hm, p))
      .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(' ')}"/>`;
  const box = (x: number, y: number, w: number, h: number, fill = '#1d2430') =>
    poly(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      fill,
    );
  let ground: string;
  let behind = '#2b2622';
  if (scene.ground === 'seat') {
    // A dark seat, with a grey panel and a pale one cutting across the corners of the picture.
    behind = '#1b1e24';
    ground = `<rect width="${W}" height="${H}" fill="${behind}"/>
      <polygon fill="#8d929c" points="0,0 640,0 0,260"/>
      <polygon fill="#e9e7e2" points="${W},${H} ${W - 420},${H} ${W},${H - 300}"/>
      <rect x="0" y="${H - 90}" width="${W - 500}" height="6" fill="#3a3f49"/>`;
  } else if (scene.ground === 'sheet') {
    // A sheet of paper on a dark table: a bigger outline than the card that lies on it.
    ground = `<rect width="${W}" height="${H}" fill="#2a2420"/>
      <polygon fill="#d9d6ce" points="90,60 1120,40 1140,850 70,860"/>`;
  } else if (scene.ground === 'keys') {
    const keys = Array.from({ length: 13 * 17 }, (_, i) => {
      const x = (i % 17) * 74 - 20;
      const y = Math.floor(i / 17) * 74 - 20;
      return `<rect x="${x}" y="${y}" width="60" height="60" rx="8" fill="#2c2f36"/>`;
    }).join('');
    ground = `<rect width="${W}" height="${H}" fill="#51555e"/>
      <g transform="rotate(4 ${W / 2} ${H / 2})">${keys}</g>`;
  } else {
    const stripes = Array.from(
      { length: 30 },
      (_, i) => `<rect x="0" y="${i * 30}" width="${W}" height="12" fill="#3a3530"/>`,
    ).join('');
    ground = `<rect width="${W}" height="${H}" fill="${behind}"/>${stripes}`;
  }
  const card = scene.bare
    ? ''
    : `${poly(flat, '#f4f1ea')}
    ${box(24, 30, 180, 22)}${box(24, 64, 120, 12)}
    ${
      scene.band
        ? `${box(0, fh * 0.55, fw, fh * 0.45, '#5a2a78')}${box(18, fh * 0.55 + 12, 66, 66, '#ffffff')}`
        : `${box(24, fh - 60, 150, 10)}${box(24, fh - 40, 170, 10)}${box(fw - 100, 30, 70, 70)}`
    }
    ${
      scene.clipped
        ? poly(
            [
              { x: fw - 60, y: -1 },
              { x: fw + 1, y: -1 },
              { x: fw + 1, y: 50 },
            ],
            behind,
          )
        : ''
    }`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${ground}${card}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

const share = (q: Quad) =>
  q.map((p) => ({
    x: Math.min(1, Math.max(0, p.x / (W - 1))),
    y: Math.min(1, Math.max(0, p.y / (H - 1))),
  })) as unknown as [Pt, Pt, Pt, Pt];
const pixels = (corners: readonly Pt[]) =>
  corners.map((p) => ({ x: p.x * (W - 1), y: p.y * (H - 1) }));

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

/**
 * The AI's corners as the owner's first cards got them: right in the picture the AI saw, read on the wrong scale, so
 * a card's height too low and off to the right, and cut off by the picture's edge.
 */
const WRONG_SCALE = TRUE.map((p) => ({ x: p.x * 1.176, y: p.y * 1.568 })) as unknown as Quad;

const far = (a: readonly Pt[], b: readonly Pt[]) =>
  Math.max(...a.map((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y)));

async function pixel(jpeg: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data[y * info.width + x]!;
}

describe('straightening a business card', () => {
  it('finds the card by its own edges, with nothing said about where it is', async () => {
    const photo = await cardPhoto(TRUE);
    const flat = await straightenCard(photo, null, { find: true });
    expect(flat.cropped).toBe(true);
    // Within a few pixels of the real corners.
    expect(far(pixels(flat.corners!), TRUE)).toBeLessThan(5);
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

  it('lands on the card when the AI’s corners are a little off', async () => {
    const flat = await straightenCard(await cardPhoto(TRUE), share(ROUGH), { find: true });
    expect(flat.cropped).toBe(true);
    expect(far(pixels(flat.corners!), TRUE)).toBeLessThan(5);
    expect(far(ROUGH, TRUE)).toBeGreaterThan(20);
  });

  it('isn’t led off the card by corners a card’s height too low', async () => {
    // What went wrong on the owner's first two cards: the crop followed the AI's corners onto the car seat.
    expect(far(WRONG_SCALE, TRUE)).toBeGreaterThan(300);
    for (const scene of [
      { ground: 'seat' },
      { ground: 'seat', band: true },
      { ground: 'seat', clipped: true },
    ] as const) {
      const flat = await straightenCard(await cardPhoto(TRUE, scene), share(WRONG_SCALE), {
        find: true,
      });
      expect(flat.cropped, JSON.stringify(scene)).toBe(true);
      expect(far(pixels(flat.corners!), TRUE), JSON.stringify(scene)).toBeLessThan(6);
    }
  });

  it('takes the whole of a card with a band of colour, not the band or the box on it', async () => {
    const flat = await straightenCard(await cardPhoto(TRUE, { ground: 'seat', band: true }), null, {
      find: true,
    });
    expect(far(pixels(flat.corners!), TRUE)).toBeLessThan(6);
    // White above, the band below.
    expect(await pixel(flat.picture, Math.round(flat.width / 2), 8)).toBeGreaterThan(200);
    expect(await pixel(flat.picture, flat.width - 12, flat.height - 12)).toBeLessThan(120);
  });

  it('finds a card with a corner cut off, out to where the corner would be', async () => {
    const flat = await straightenCard(await cardPhoto(TRUE, { clipped: true }), null, {
      find: true,
    });
    expect(flat.cropped).toBe(true);
    expect(far(pixels(flat.corners!), TRUE)).toBeLessThan(6);
  });

  it('finds a card lying on a keyboard, not a row of keys', async () => {
    const flat = await straightenCard(await cardPhoto(TRUE, { ground: 'keys' }), null, {
      find: true,
    });
    expect(flat.cropped).toBe(true);
    expect(far(pixels(flat.corners!), TRUE)).toBeLessThan(6);
    // And with no card on it, the keys are left alone.
    const bare = await cardPhoto(TRUE, { ground: 'keys', bare: true });
    expect(await straightenCard(bare, null, { find: true })).toMatchObject({ cropped: false });
  });

  it('takes the outline the AI points at when the card lies on something bigger', async () => {
    const photo = await cardPhoto(TRUE, { ground: 'sheet' });
    const flat = await straightenCard(photo, share(ROUGH), { find: true });
    expect(flat.cropped).toBe(true);
    expect(far(pixels(flat.corners!), TRUE)).toBeLessThan(6);
  });

  it('reads a card photographed sideways the right way up, going by the AI’s corners', async () => {
    // The card's top-left (as it reads) is at the bottom-left of the photo: it lies turned a quarter.
    const turned: Quad = [
      { x: 380, y: 820 },
      { x: 400, y: 120 },
      { x: 790, y: 130 },
      { x: 780, y: 830 },
    ];
    const photo = await cardPhoto(turned);
    const flat = await straightenCard(photo, share(turned), { find: true });
    expect(flat.width).toBeGreaterThan(flat.height);
    expect(far(pixels(flat.corners!), turned)).toBeLessThan(6);
    // The AI's corners say which way up even when they're on the wrong scale.
    const off = turned.map((p) => ({ x: p.x * 1.176, y: p.y * 1.568 })) as unknown as Quad;
    const still = await straightenCard(photo, share(off), { find: true });
    expect(far(pixels(still.corners!), turned)).toBeLessThan(6);
    // With nothing to go by, the card reads the way the picture does.
    const alone = await straightenCard(photo, null, { find: true });
    expect(alone.height).toBeGreaterThan(alone.width);
  });

  it('crops where the AI points when the finder takes nothing for a card but the edges are there', async () => {
    // A long thin card, four times as wide as high: not a shape the finder looks for.
    const strip: Quad = [
      { x: 150, y: 360 },
      { x: 1050, y: 380 },
      { x: 1046, y: 600 },
      { x: 146, y: 580 },
    ];
    const rough = strip.map((p, i) => ({
      x: p.x + (i % 2 ? -14 : 12),
      y: p.y + (i < 2 ? 10 : -12),
    }));
    const photo = await cardPhoto(strip, { shape: [800, 200], ground: 'seat' });
    expect(await straightenCard(photo, null, { find: true })).toMatchObject({ cropped: false });
    const flat = await straightenCard(photo, share(rough as unknown as Quad), { find: true });
    expect(flat.cropped).toBe(true);
    expect(far(pixels(flat.corners!), strip)).toBeLessThan(6);
  });

  it('leaves the photo as it is when no card’s edges can be found', async () => {
    const blank = await sharp({
      create: { width: W, height: H, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    // The AI's corners come back as a place to start fixing the edges from, and nothing is cropped.
    const flat = await straightenCard(blank, share(ROUGH), { find: true });
    expect(flat).toMatchObject({ cropped: false, width: W, height: H });
    expect(far(pixels(flat.corners!), ROUGH)).toBeLessThan(1);
    expect(await straightenCard(blank, null, { find: true })).toMatchObject({
      cropped: false,
      corners: null,
    });
  });

  it('keeps corners placed by hand where they are', async () => {
    const photo = await cardPhoto(TRUE);
    const flat = await straightenCard(photo, share(ROUGH), { find: false });
    expect(flat.cropped).toBe(true);
    expect(far(pixels(flat.corners!), ROUGH)).toBeLessThan(1);
  });

  it('gives the photo back as it is with no corners and nothing to look for', async () => {
    const photo = await cardPhoto(TRUE);
    const flat = await straightenCard(photo, null, { find: false });
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
