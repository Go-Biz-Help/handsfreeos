import { deflateSync } from 'node:zlib';
import { expect, type Page } from '@playwright/test';
import { WORKER } from './booking-helpers';

/**
 * HandsFreeOS staff hand Real Estate Agent (still in testing) to a business, and its owner adds it from the Add-ons
 * page. The owner is made staff here to stand in for them.
 */
export async function turnOnRealestate(page: Page, email: string, workspaceId: string) {
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await page.goto(`/admin/businesses/${workspaceId}`);
  const testing = page.getByTestId('admin-addon-testing');
  await testing.getByTestId('admin-addon-testing-realestate').click();
  await expect(testing).toContainText('they can add it');
  await page.goto(`/app/w/${workspaceId}/add-ons`);
  const card = page.getByTestId('addon-realestate');
  await expect(card.getByTestId('addon-testing')).toBeVisible();
  await page.getByTestId('addon-install-realestate').click();
  await expect(card.getByTestId('addon-state')).toHaveText('On', { timeout: 90_000 });
}

/** A plain gradient PNG, for a listing's sample photos: no image files kept in the repo for it. */
export function samplePng(
  w: number,
  h: number,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      for (let i = 0; i < 3; i++)
        raw[y * (w * 3 + 1) + 1 + x * 3 + i] = Math.round(from[i]! + (to[i]! - from[i]!) * t);
    }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
