import { createHmac, randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/**
 * The fake carrier's master account and token (not secrets: apps/worker/src/telephony/fake.ts). Webhooks
 * signed with them reach the worker like Twilio's; the worker routes an inbound text by the number texted.
 */
const FAKE_MASTER_SID = 'ACfakemasteraccount';
const FAKE_AUTH_TOKEN = 'fake-twilio-auth-token';
export const WORKER_URL = (process.env.WORKER_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');

function sign(url: string, params: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac('sha1', FAKE_AUTH_TOKEN).update(data, 'utf8').digest('base64');
}

/** Fake message ids read like Twilio's but never look like secrets. */
export const fakeMessageSid = (): string =>
  `SMfake${randomBytes(12)
    .toString('base64url')
    .replace(/[^A-Za-z]/g, '')}`;

/** A 1x1 PNG, for picture messages. */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const TINY_PNG_BYTES = Buffer.from(TINY_PNG.split(',')[1]!, 'base64');

/** A customer texts the business number: posted to the worker the way Twilio would, signed. */
export async function textFromCustomer(opts: {
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
}): Promise<string> {
  const sid = fakeMessageSid();
  const params: Record<string, string> = {
    AccountSid: FAKE_MASTER_SID,
    MessageSid: sid,
    From: opts.from,
    To: opts.to,
    Body: opts.body,
    NumMedia: String(opts.mediaUrls?.length ?? 0),
  };
  opts.mediaUrls?.forEach((url, i) => {
    params[`MediaUrl${i}`] = url;
    params[`MediaContentType${i}`] = 'image/png';
  });
  const url = `${WORKER_URL}/webhooks/twilio/messaging/inbound`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': sign(url, params),
    },
    body: new URLSearchParams(params),
  });
  if (res.status !== 200) throw new Error(`the worker refused the inbound text (${res.status})`);
  return sid;
}

/**
 * Settings → Texting & calls with the fake carrier: buys the first toll-free number offered, sends the
 * business details, and waits for the (fake) carriers to approve. Returns the number in E.164.
 */
export async function setUpTexting(page: Page, workspaceId: string): Promise<string> {
  await page.goto(`/app/w/${workspaceId}/settings/texting`);
  await expect(page.getByTestId('number-step')).toBeVisible();
  await page.getByTestId('show-numbers').click();
  const picked = page.getByTestId('number-results').getByRole('radio', { checked: true });
  await expect(picked).toBeVisible();
  const display = (await picked.locator('.font-mono').textContent())!.trim();
  await page.getByTestId('buy-number').click();
  await expect(page.getByTestId('business-step')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('EIN (tax ID)').fill('12-3456789');
  await page.getByLabel('Website').fill('https://lonestarhvac.test');
  await page.locator('#biz-line1').fill('4410 Westpark Dr');
  await page.getByLabel('City', { exact: true }).fill('Houston');
  await page.getByLabel('State', { exact: true }).fill('TX');
  await page.getByLabel('ZIP code').fill('77027');
  await page.locator('#biz-contactPhone').fill('(713) 555-0161');
  await page
    .getByLabel('How customers agree to get texts')
    .fill(
      'Customers give us their cell number when they book a visit and agree to texts about it.',
    );
  await page
    .locator('#biz-sample1')
    .fill('Hi Mike, this is Lone Star HVAC. Marco is on the way. Reply STOP to opt out.');
  await page.getByTestId('business-agree').check();
  await page.getByTestId('submit-registration').click();
  await expect(page.getByTestId('review-step')).toBeVisible({ timeout: 15_000 });
  // The fake carrier approves in a few seconds; the page turns into the configured settings.
  await expect(page.getByTestId('texting-configured')).toBeVisible({ timeout: 60_000 });
  return `+1${display.replace(/[^0-9]/g, '')}`;
}

/** The hour now in the business's time zone (workspaces default to Chicago). */
export function hourIn(timeZone = 'America/Chicago'): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(
      new Date(),
    ),
  );
}
export const hh = (h: number): string => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
