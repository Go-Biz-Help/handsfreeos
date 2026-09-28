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

/** Fake call ids, like the message ids. */
export const fakeCallSid = (): string =>
  `CAfake${randomBytes(12)
    .toString('base64url')
    .replace(/[^A-Za-z]/g, '')}`;

/**
 * Posts a call webhook to the worker as Twilio would, signed with the fake carrier's token. Pass the
 * workspace's subaccount (the voice token's `sub`), so status reports land in the right workspace.
 * Returns the TwiML (or nothing, for status reports).
 */
export async function postVoice(path: string, params: Record<string, string>): Promise<string> {
  const url = `${WORKER_URL}/webhooks/twilio/voice/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': sign(url, params),
    },
    body: new URLSearchParams(params),
  });
  if (res.status >= 300) throw new Error(`the worker refused the ${path} webhook (${res.status})`);
  return res.text();
}

const unescapeXml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The <Parameter> values our TwiML hands the browsers (who is calling, what else rings). */
export function twimlParameters(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g))
    out[m[1]!] = unescapeXml(m[2]!);
  return out;
}

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
 * A customer taps a reply button on an RCS message (0103): posted to the worker the way Twilio would, signed. An
 * RCS message arrives at the business's sender, not at one of its numbers, so it names the business's Twilio
 * account (Settings → Texting & calls shows it) — the fake's stand-in senders have the same id in every account.
 */
export async function tapFromCustomer(opts: {
  accountSid: string;
  from: string;
  sender: string;
  title: string;
  payload: string;
}): Promise<string> {
  const sid = fakeMessageSid();
  const params: Record<string, string> = {
    AccountSid: opts.accountSid,
    MessageSid: sid,
    From: `rcs:${opts.from}`,
    To: `rcs:${opts.sender}`,
    Body: opts.title,
    ButtonPayload: opts.payload,
    ButtonText: opts.title,
    ButtonType: 'QUICK_REPLY',
    NumMedia: '0',
  };
  const url = `${WORKER_URL}/webhooks/twilio/messaging/inbound`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': sign(url, params),
    },
    body: new URLSearchParams(params),
  });
  if (res.status !== 200) throw new Error(`the worker refused the button tap (${res.status})`);
  return sid;
}

/**
 * Settings → Texting & calls with the fake carrier: buys the first toll-free number offered, sends the
 * business details, and waits for the (fake) carriers to approve. Returns the number in E.164.
 */
/** The stand-in website playwright.config.ts serves, which the worker may open (FETCH_TEST_ORIGINS). */
const KNOWLEDGE_SITE = 'http://127.0.0.1:4190';

export async function setUpTexting(page: Page, workspaceId: string): Promise<string> {
  await page.goto(`/app/w/${workspaceId}/settings/texting`);
  await expect(page.getByTestId('number-step')).toBeVisible();
  const picked = page.getByTestId('number-results').getByRole('radio', { checked: true });
  // On a cold dev server the page can show before its script runs, and a click then submits the search the
  // browser's own way (a reload) instead: search again until numbers show.
  await expect(async () => {
    await page.getByTestId('show-numbers').click();
    await expect(picked).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 90_000 });
  const display = (await picked.locator('.font-mono').textContent())!.trim();
  await page.getByTestId('buy-number').click();
  // The purchase is taken at once, then the worker sets the number up with the (fake) carrier while the page
  // checks back every few seconds. On a busy runner the worker is still working through what earlier tests left
  // it, so that part gets room; a purchase that wasn't taken at all fails the first check, not the second.
  await expect(page.getByTestId('texting-setup')).not.toHaveAttribute('data-step', 'buy_number');
  await expect(page.getByTestId('business-step')).toBeVisible({ timeout: 90_000 });
  // The registration is a wizard now: one question at a time, and a step with a blocker on it will not
  // advance. So this walks it the way a business does, and a check that starts failing here is the wizard
  // refusing details a carrier would have refused later.
  const next = page.getByTestId('a2p-next');

  // 1. Who the carriers look up.
  await page.getByLabel('Your EIN').fill('12-3456789');
  await next.click();

  // 2. Where to find them. The stand-in website playwright.config.ts serves, because the wizard's
  //    pre-flight really opens this address before it lets anything be submitted (FETCH_TEST_ORIGINS).
  await page.getByLabel('Your website').fill(KNOWLEDGE_SITE);
  await page.getByLabel('Street address').fill('4410 Westpark Dr');
  await page.getByLabel('City', { exact: true }).fill('Houston');
  await page.getByLabel('State', { exact: true }).fill('TX');
  await page.getByLabel('ZIP code').fill('77027');
  await next.click();

  // 3. Who to write to. The name and email come from the signed-in user.
  await page.getByLabel('Phone', { exact: true }).fill('(713) 555-0161');
  await next.click();

  // 4. What they text about: appointments and customer care is already chosen.
  await next.click();

  // 5. Two texts they would really send. Taken from the wizard's own suggestions rather than typed: the
  //    wizard blocks a sample that does not name the business, and this helper is called for workspaces
  //    with a different name in every spec. Filling them this way also checks the suggestions are usable.
  await page.getByTestId('a2p-suggestion-0').click();
  await page.getByTestId('a2p-suggestion-1').click();
  await expect(page.locator('#a2p-sample-0')).not.toHaveValue('');
  await expect(page.locator('#a2p-sample-1')).not.toHaveValue('');
  await next.click();

  // 6. How customers agree. In person, so the test does not stand up a chat widget and a public form.
  await page.getByTestId('optin-in_person').click();
  await next.click();

  // 7. The privacy policy. The fixture site has one written properly, so this takes the "I already have
  //    my own" branch — which is also the branch pre-flight has to fetch and read.
  await page.getByTestId('policy-own').click();
  await page.getByLabel('Where your privacy policy is').fill(`${KNOWLEDGE_SITE}/privacy`);
  await next.click();

  // The review opens the website, the policy and (for in-person consent, nothing else) before it will let
  // the registration go. Nothing is submitted until all three have been looked at.
  await expect(page.getByText('Your privacy policy mentions texting')).toBeVisible({
    timeout: 30_000,
  });

  await page.getByTestId('business-agree').check();
  await page.getByTestId('submit-registration').click();
  // The details go to the (fake) carriers. On a cold server that can take a while, and they may approve before the
  // review step has shown, so either will do; then the page turns into the configured settings.
  await expect(
    page.getByTestId('review-step').or(page.getByTestId('texting-configured')).first(),
  ).toBeVisible({ timeout: 60_000 });
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
