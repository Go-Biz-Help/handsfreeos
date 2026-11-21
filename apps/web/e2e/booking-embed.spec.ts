import { expect, test } from '@playwright/test';
import { makeCalendar, ownerWithSite } from './booking-helpers';
import { APP, CHAT_SITE, OTHER_SITE } from './chat-helpers';

/**
 * A calendar on the business's own website (the owner, 2026-11-18: an embed like forms have). The owner lists the
 * site under the calendar's Booking link → Embed and copies the code; the stand-in site at 127.0.0.1:4191 pastes it,
 * and a customer goes from a time to their details inside it, with no header of ours and the box fitted by
 * /embed/v1/book.js. The booking page names that site in its frame rule only when it asks to be embedded and the
 * request came from a listed site; the site at 127.0.0.1:4192 isn't listed, so the browser refuses to show it there.
 */
test('a calendar shows on the site it lists, books inside it, and nowhere else', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'booking-embed', 'Lone Star Embed HVAC');
  const cal = await makeCalendar(owner, 'AC tune-up');

  // The owner: no site yet says the box would be blank; listing one saves it with the www twin added (none here).
  await page.goto(`/app/w/${owner.workspaceId}/settings/calendars/${cal.id}`);
  // A press before the page has woken up does nothing, so press again until the window opens.
  const embed = page.getByTestId('calendar-embed');
  await expect(async () => {
    if (!(await embed.isVisible()))
      await page.getByTestId('builder-embed-open').click({ timeout: 2_000 });
    await expect(embed).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId('calendar-embed-none')).toBeVisible();
  const sites = page.getByTestId('calendar-embed-sites');
  await sites.fill('127.0.0.1:4191');
  await sites.press('Enter');
  await expect(page.getByTestId('calendar-embed-none')).toBeHidden();
  await expect(sites).toHaveValue(CHAT_SITE);
  const code = await embed.locator('[title^="<iframe"]').getAttribute('title');
  expect(code).toBe(
    `<iframe src="${APP}${cal.path}?embed=1" title="AC tune-up" width="100%" height="760" style="border:0" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>\n<script src="${APP}/embed/v1/book.js" async></script>`,
  );

  // The frame rule: the listed site only when the page asks to be embedded; 'self' alone otherwise.
  const rule = async (path: string, referer: string) =>
    (await request.get(`${APP}${path}`, { headers: { referer: `${referer}/services` } })).headers()[
      'content-security-policy'
    ];
  expect(await rule(`${cal.path}?embed=1`, CHAT_SITE)).toBe(`frame-ancestors 'self' ${CHAT_SITE}`);
  expect(await rule(`${cal.path}?embed=1`, OTHER_SITE)).toBe(`frame-ancestors 'self'`);
  expect(await rule(cal.path, CHAT_SITE)).toBe(`frame-ancestors 'self'`);

  // A customer on the business's site books from inside it.
  const context = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const site = await context.newPage();
  const at = (origin: string) =>
    `${origin}/services/ac-tune-up?snippet=${encodeURIComponent(code!)}`;
  await site.goto(at(CHAT_SITE));
  const box = site.locator('iframe[src*="/book/"]');
  const frame = site.frameLocator('iframe[src*="/book/"]');
  await expect(frame.getByTestId('booking-embed')).toBeVisible();
  await expect(frame.getByRole('heading', { name: 'AC tune-up' })).toBeVisible();
  // No header of ours: the business's own site is around it.
  await expect(frame.getByTestId('business-name')).toHaveCount(0);
  // The script fitted the box to the page.
  await expect.poll(() => box.evaluate((f: HTMLIFrameElement) => f.style.height)).toMatch(/px$/);
  const first = frame.getByTestId('slot').first();
  await expect(first).toBeVisible();
  const picked = (await first.textContent())!.trim();
  await first.click();
  await frame.getByRole('button', { name: `Continue with ${picked}` }).click();
  await expect(frame.getByRole('heading', { name: 'Your details' })).toBeVisible();

  // A site the calendar doesn't list: the browser refuses to show it, so nothing of the booking page loads.
  const refused = await context.newPage();
  await refused.goto(at(OTHER_SITE));
  await expect(refused.locator('iframe[src*="/book/"]')).toHaveCount(1);
  await refused.waitForTimeout(1_500);
  await expect(
    refused.frameLocator('iframe[src*="/book/"]').getByTestId('booking-embed'),
  ).toHaveCount(0);
  await context.close();
});
