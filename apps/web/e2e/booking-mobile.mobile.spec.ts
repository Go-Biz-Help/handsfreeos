import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { makeCalendar, ownerWithSite, randomPhone } from './booking-helpers';

test.use({ colorScheme: 'dark' });

/** The booking page on a 390 px phone in dark mode: the week strip, the bottom bar, and no sideways scroll. */
test('books on a phone in dark mode', async ({ page, browser }) => {
  const owner = await ownerWithSite(page, 'booking-phone', 'Gulf E2E Roofing');
  const cal = await makeCalendar(owner, 'Roof inspection');

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  const c = await phone.newPage();
  await c.goto(cal.path);
  await expect(c.getByTestId('public-page')).toHaveCSS('background-color', 'rgb(15, 19, 26)');
  await expect(c.getByRole('heading', { name: 'Pick a time' })).toBeVisible();
  await expect(c.getByTestId('day').first()).toBeVisible();
  await c.getByTestId('slot').first().click();
  await c.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(c.getByRole('heading', { name: 'Your details' })).toBeVisible();
  await c.getByLabel('Name', { exact: true }).fill('Priya Shah');
  await c.getByLabel('Mobile', { exact: true }).fill(randomPhone());
  await c.getByLabel('Email', { exact: true }).fill(`${randomUUID().slice(0, 8)}@hfos.test`);
  await c.getByRole('checkbox', { name: /Text me about this appointment/ }).click();
  await expect(c.getByText(/You’ll get texts at/)).toBeVisible();
  await c.getByRole('button', { name: 'Book Roof inspection' }).click();
  await expect(c.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  await expect(c.getByTestId('booked-what')).toContainText('Roof inspection · 1 hour');

  // Nothing on the page scrolls sideways at 390 px.
  const overflow = await c.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await phone.close();
});
