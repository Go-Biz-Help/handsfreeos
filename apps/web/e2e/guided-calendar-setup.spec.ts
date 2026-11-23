import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The guided calendar setup (the owner, 22 Nov 2026, picks C1 a to C4 b): New calendar in Settings → Calendars opens
 * it, five kinds come first, it saves as it goes, paying is always asked (a deposit with no account sends them to
 * connect one), Make this calendar makes it, and its page is then one simple card with All settings behind it.
 */
test('guided calendar setup: New calendar, seven questions, Make this calendar, then its card', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'calendar-setup');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });

  await page.goto(`/app/w/${workspaceId}/settings/calendars`);
  await page.getByTestId('calendar-new').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/calendar$`));
  const card = page.getByTestId('calendar-setup');
  await expect(card).toHaveAttribute('data-screen', 'kind', { timeout: 60_000 });

  // Five plain kinds first, the rest under More kinds.
  await expect(page.locator('[data-testid^="calendar-kind-"][role="radio"]')).toHaveCount(5);
  await page.getByTestId('calendar-kind-more').click();
  await expect(page.getByTestId('calendar-kind-webinar')).toBeVisible();
  await expect(page.getByTestId('calendar-kind-scratch')).toBeVisible();

  // 1. What customers book, and its name.
  await page.getByTestId('calendar-kind-appointment').click();
  await expect(page.getByTestId('calendar-name')).toHaveValue('Appointments');
  await page.getByTestId('calendar-name').fill('Tune-ups');
  const next = page.getByTestId('calendar-setup-next');
  await next.click();

  // 2. Who does the work: the owner, already ticked.
  await expect(card).toHaveAttribute('data-screen', 'who');
  await expect(page.getByTestId('calendar-who').locator('input:checked')).toHaveCount(1);
  await next.click();

  // 3. The services: a new one, made only at the end.
  await expect(card).toHaveAttribute('data-screen', 'what');
  await page.getByTestId('calendar-service-add').click();
  const added = page.locator('[data-testid^="calendar-service-name-"]').last();
  await next.click();
  await expect(card).toContainText('Give this service a name.');
  await added.fill('Tune-up');
  await page.locator('[data-testid^="calendar-service-price-"]').last().fill('89');
  await next.click();

  // Saved as it goes: coming back opens on the same question with the same answers.
  await expect(card).toHaveAttribute('data-screen', 'when');
  await expect(page.getByTestId('guided-saved')).toBeVisible();
  await page.reload();
  await expect(card).toHaveAttribute('data-screen', 'when', { timeout: 60_000 });
  await expect(page.getByTestId('guided-step-kind')).toContainText('An appointment for a service');
  await expect(page.getByTestId('guided-step-what')).toContainText('Tune-up');

  // 4. When, 5. where (the business's own address, filled in) and 6. what customers hear.
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'where');
  await expect(page.getByTestId('calendar-place-business')).toBeChecked();
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'remind');
  await next.click();

  // 7. Paying, always asked: a deposit with no account says to connect one first, and No goes on.
  await expect(card).toHaveAttribute('data-screen', 'pay');
  await page.getByTestId('calendar-pay-deposit').click();
  await next.click();
  await expect(page.getByTestId('calendar-pay-connect')).toBeVisible();
  await page.getByTestId('calendar-pay-none').click();
  await next.click();

  // Check it over: the seven answers, each with Change.
  await expect(card).toHaveAttribute('data-screen', 'review');
  await expect(page.getByTestId('calendar-review-kind')).toContainText('Tune-ups');
  await expect(page.getByTestId('calendar-review-what')).toContainText('Tune-up');
  await expect(page.getByTestId('calendar-review-pay')).toContainText('They pay later');
  await page.getByTestId('calendar-review-change-what').click();
  await expect(card).toHaveAttribute('data-screen', 'what');
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'review');
  await next.click();

  // Done: its link and what to do next.
  const done = page.getByTestId('calendar-setup-done');
  await expect(done).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('calendar-setup-link')).toContainText('/book/');
  await page.getByTestId('calendar-setup-open-card').click();

  // Its page is one simple card; Change opens that part of All settings.
  const calendar = page.getByTestId('calendar-card');
  await expect(calendar).toBeVisible();
  await expect(page.getByTestId('calendar-card-name')).toHaveText('Tune-ups');
  await expect(page.getByTestId('calendar-card-line-kind')).toContainText(
    'An appointment for a service',
  );
  await expect(page.getByTestId('calendar-card-line-what')).toContainText('Tune-up');
  await expect(page.getByTestId('calendar-card-line-pay')).toContainText('No payment to book');
  await page.getByTestId('calendar-card-change-what').click();
  await expect(page).toHaveURL(/\/settings\/calendars\/[0-9a-f-]{36}\/all\?part=services$/);
  await expect(page.getByTestId('module-panel-services')).toBeVisible();
  await page.getByTestId('builder-card-link').click();
  await expect(calendar).toBeVisible();

  // The answers are spent: New calendar starts fresh.
  await page.goto(`/onboarding/${workspaceId}/calendar`);
  await expect(card).toHaveAttribute('data-screen', 'kind', { timeout: 60_000 });
  await expect(page.getByTestId('calendar-name')).toHaveCount(0);
});
