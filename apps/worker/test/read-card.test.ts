/**
 * Reading a business card scanned on the phone (contacts/read-card.ts), with the scripted stand-in model: a side of
 * the card comes back read and straightened, counted as `business_card` usage for the person scanning; corners
 * placed by hand are only straightened again, with no AI; and nothing is saved.
 */
import { randomInt } from 'node:crypto';
import { cardContactFromAnswer, type ReadCardOut } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser } from '@hfos/db/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCRIPTED_BUSINESS_CARD, scriptedAi } from '../src/ai/scripted';
import { admin, makeWorld, type World } from './booking-world';

let w: World;
let bearer: string;

/** A white card at an angle on a dark table, 1,200 by 900. */
async function photo(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
    <rect width="1200" height="900" fill="#2b2622"/>
    <polygon fill="#f4f1ea" points="260,190 930,250 900,640 230,600"/>
    <polygon fill="#1d2430" points="300,256 654,286 651,329 300,300"/>
  </svg>`;
  return (await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer()).toString('base64');
}

/** The card's corners as the AI gives them: pixels of the picture it was shown, a little off. */
const AI_CORNERS = [
  { x: 282, y: 172 },
  { x: 905, y: 268 },
  { x: 924, y: 615 },
  { x: 212, y: 626 },
];

const read = (body: unknown, auth: string | null = bearer) =>
  w.app.inject({
    method: 'POST',
    url: '/v1/contacts/read-card',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${randomInt(1, 250)}`,
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    payload: JSON.stringify(body),
  });

const usage = () =>
  rows<{ user_id: string }>(
    admin(),
    sql`select user_id from app.ai_usage where workspace_id = ${w.workspaceId} and source = 'business_card'`,
  );

beforeAll(async () => {
  w = await makeWorld('cardread', {
    ai: {
      provider: scriptedAi([
        {
          // The ask says how big the picture is, so the corners come back in its pixels.
          when: /Read this side of the business card\. The picture is 1200 pixels wide and 900 pixels high\.$/,
          json: () => ({ ...SCRIPTED_BUSINESS_CARD, corners: AI_CORNERS }),
        },
      ]),
    },
  });
  bearer = await signInTestUser(w.owner);
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('reading a business card', () => {
  it('reads a side and gives back just the card, straightened', async () => {
    const res = await read({ workspaceId: w.workspaceId, side: 'front', image: await photo() });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as ReadCardOut;
    expect(out.isCard).toBe(true);
    expect(out.cropped).toBe(true);
    expect(out.width / out.height).toBeGreaterThan(1.6);
    expect(out.width / out.height).toBeLessThan(1.9);
    // The card's own corners (260,190 … in a 1,200 by 900 picture), found by its edges, not the AI's rough ones.
    expect(Math.abs(out.corners![0]!.x * 1199 - 260)).toBeLessThan(5);
    expect(Math.abs(out.corners![0]!.y * 899 - 190)).toBeLessThan(5);
    expect(Math.abs(out.corners![2]!.x * 1199 - 900)).toBeLessThan(5);
    expect(Math.abs(out.corners![2]!.y * 899 - 640)).toBeLessThan(5);
    const meta = await sharp(Buffer.from(out.picture, 'base64')).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', out.width, out.height]);
    // Tidied: the name cased, the labels plain, the email lower-cased.
    expect(out.contact).toEqual(
      cardContactFromAnswer({
        ...SCRIPTED_BUSINESS_CARD,
        corners: [],
        phones: [...SCRIPTED_BUSINESS_CARD.phones],
        emails: [...SCRIPTED_BUSINESS_CARD.emails],
      }),
    );
    expect(out.contact).toMatchObject({
      firstName: 'Maria',
      lastName: 'Lopez',
      company: 'Lopez Roofing',
      phones: [
        { number: '(713) 555-0100', label: 'Office' },
        { number: '(713) 555-0142', label: 'Mobile' },
      ],
      emails: [{ email: 'maria@lopezroofing.com', label: '' }],
      website: 'lopezroofing.com',
    });
    expect(await usage()).toEqual([{ user_id: w.owner.id }]);
  });

  it('only straightens again, with no AI, for corners placed by hand', async () => {
    const before = (await usage()).length;
    const res = await read({
      workspaceId: w.workspaceId,
      side: 'back',
      image: await photo(),
      corners: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.25 },
        { x: 0.78, y: 0.7 },
        { x: 0.19, y: 0.66 },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as ReadCardOut;
    expect(out).toMatchObject({ cropped: true, contact: null, isCard: true });
    expect(out.corners![1]).toEqual({ x: 0.8, y: 0.25 });
    expect((await usage()).length).toBe(before);
  });

  it('refuses without a sign-in, and a picture that can’t be opened', async () => {
    expect(
      (await read({ workspaceId: w.workspaceId, side: 'front', image: await photo() }, null))
        .statusCode,
    ).toBe(401);
    const res = await read({
      workspaceId: w.workspaceId,
      side: 'front',
      image: Buffer.from('not a picture at all, just words '.repeat(4)).toString('base64'),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { rule: string } }).error.rule).toBe('card_unreadable');
  });
});
