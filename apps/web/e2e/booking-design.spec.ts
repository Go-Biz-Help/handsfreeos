import { expect, test, type Page } from '@playwright/test';
import { makeCalendar, ownerWithSite } from './booking-helpers';
import { APP } from './chat-helpers';

/**
 * A calendar's own look (the owner, 2026-11-19: "a design feature similar to the form design"). The owner picks
 * round corners, outlined buttons and no name at the top in the calendar's Design section, sees the preview follow,
 * and saves. The booking page then wears it on its own and embedded: see-through on a website once there's a
 * design, where it was a painted box before.
 */
test('a calendar’s design shows in its preview, then on its booking page and embedded', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'booking-design', 'Lone Star Design HVAC');
  const cal = await makeCalendar(owner, 'Duct cleaning');
  // Another, never designed. (A booking page's details are kept 30 seconds, so the designed one isn't opened
  // before its design is saved.)
  const plain = await makeCalendar(owner, 'AC tune-up');

  const context = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const customer = await context.newPage();
  const box = (p: Page) => p.getByTestId('booking-embed');
  const background = (p: Page) => box(p).evaluate((el) => getComputedStyle(el).backgroundColor);
  // Never designed: embedded, it's the painted box it always was.
  await customer.goto(`${APP}${plain.path}?embed=1`);
  await expect(box(customer)).toBeVisible();
  expect(await background(customer)).not.toBe('rgba(0, 0, 0, 0)');
  await expect(customer.getByTestId('form-look')).toHaveCount(0);

  await page.goto(`/app/w/${owner.workspaceId}/settings/calendars/${cal.id}/all`);
  // A press before the page has woken up does nothing, so press again until the section opens.
  const design = page.getByTestId('calendar-design');
  await expect(async () => {
    if (!(await design.isVisible()))
      await page.getByTestId('module-design').click({ timeout: 2_000 });
    await expect(design).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const name = page.getByTestId('design-preview-name');
  await expect(name).toHaveText('Duct cleaning');
  await expect(name).not.toHaveClass(/sr-only/);

  await page.getByTestId('design-corners-round').click();
  await page.getByTestId('design-button-outline').click();
  await page.getByTestId('design-title').click();
  // The preview follows straight away.
  await expect(name).toHaveClass(/sr-only/);
  const preview = page.getByTestId('design-preview');
  // A picture only (hidden from screen readers), so found by what it is rather than its name.
  await expect(preview.locator('[data-form-action]')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect(page.getByTestId('module-design')).toContainText('Your own look');
  await page.getByTestId('builder-save').click();
  await expect(page.getByTestId('builder-save-note')).toHaveText(/All changes saved/);

  // Its own page wears it: round times, an outlined button, and the name kept for screen readers only.
  await customer.goto(`${APP}${cal.path}`);
  await expect(customer.getByTestId('form-look')).toBeVisible();
  const slot = customer.getByTestId('slot').first();
  await expect(slot).toBeVisible();
  await expect(slot).toHaveCSS('border-top-left-radius', '22px');
  await expect(customer.getByRole('heading', { name: 'Duct cleaning' }).first()).toHaveClass(
    /sr-only/,
  );
  await slot.click();
  const go = customer.getByRole('button', { name: /^Continue with / }).first();
  await expect(go).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  // Embedded, it's see-through now, so it sits on the website's own background.
  await customer.goto(`${APP}${cal.path}?embed=1`);
  await expect(box(customer)).toBeVisible();
  await expect.poll(() => background(customer)).toBe('rgba(0, 0, 0, 0)');
  await expect(customer.getByTestId('slot').first()).toHaveCSS('border-top-left-radius', '22px');
  await context.close();
});
