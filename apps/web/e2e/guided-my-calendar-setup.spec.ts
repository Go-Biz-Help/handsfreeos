import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/** A day `days` from now, as the date input takes it. */
const dayFromNow = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The guided My calendar setup from Settings → My calendar (the owner, 24 Nov 2026, picks M1 a to M4 a): until it's
 * set up, the page is a Start card with today's page under All settings. Start asks your calendar, your hours (three
 * choices plus a lunch break) and time off, one at a time, saved as it goes; Save my calendar sets them all at once,
 * and the page then shows the answers, each with Change. Picking Google leaves for Google's sign-in through the
 * worker; Google itself can't sign in here, so its start page is stood in for.
 */
test('Settings → My calendar: three questions saved as they go, then Save, then Change to Google', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { email } = await signUpAndConfirm(page, 'my-calendar-guided');
  const workspaceId = await createBusiness(page, { name: 'Guide Calendar Plumbing' });
  const { token } = await signInOwner(email);

  // One simple card until it's set up: Start, and today's page under All settings.
  await page.goto(`/app/w/${workspaceId}/settings/my-calendar`);
  await expect(page.getByTestId('my-calendar-overview')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('my-calendar-answers')).toHaveCount(0);
  await expect(page.getByTestId('my-calendar-all-settings')).toBeHidden();
  await page.getByTestId('my-calendar-all-settings-toggle').click();
  await expect(page.getByTestId('my-calendar-all-settings')).toBeVisible();
  await page.getByTestId('my-calendar-all-settings-toggle').click();
  await expect(page.getByTestId('my-calendar-all-settings')).toBeHidden();

  // Your calendar: Google.
  await expect(page.getByTestId('my-calendar-set-up')).toHaveText('Start');
  await page.getByTestId('my-calendar-set-up').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/my-calendar$`));
  const card = page.getByTestId('my-calendar-setup');
  await expect(card).toHaveAttribute('data-screen', 'calendar', { timeout: 60_000 });
  await page.getByTestId('my-calendar-setup-google').click();
  const next = page.getByTestId('my-calendar-setup-next');
  await next.click();

  // Your hours start as the business's, with a lunch break from noon to 1 turned on.
  await expect(card).toHaveAttribute('data-screen', 'hours');
  await expect(page.getByTestId('my-calendar-setup-hours-business')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('my-calendar-setup-lunch').click();
  await expect(page.getByTestId('my-calendar-setup-lunch-start')).toBeVisible();
  await next.click();

  // Saved as it goes: Settings offers to pick up where they left off, on the same question.
  await expect(card).toHaveAttribute('data-screen', 'timeOff');
  await expect(page.getByTestId('guided-saved')).toBeVisible();
  await page.goto(`/app/w/${workspaceId}/settings/my-calendar`);
  await expect(page.getByTestId('my-calendar-set-up')).toHaveText('Pick up where you left off', {
    timeout: 60_000,
  });
  await page.getByTestId('my-calendar-set-up').click();
  await expect(card).toHaveAttribute('data-screen', 'timeOff', { timeout: 60_000 });

  // Time off: a whole day next week.
  const off = dayFromNow(7);
  await page.getByTestId('my-calendar-setup-off-from').fill(off);
  await page.getByTestId('my-calendar-setup-off-to').fill(off);
  await page.getByTestId('my-calendar-setup-off-note').fill('Dentist');
  await page.getByTestId('my-calendar-setup-off-add').click();
  await expect(page.getByTestId('my-calendar-setup-time-off').locator('li')).toHaveCount(1);
  await expect(next).toHaveText('Check it over');
  await next.click();

  // Check it over: Change goes to that question and straight back. Something else, or none saves without a sign-in.
  await expect(card).toHaveAttribute('data-screen', 'review');
  await expect(page.getByTestId('my-calendar-review-calendar')).toContainText('Google Calendar');
  await expect(page.getByTestId('my-calendar-review-hours')).toContainText('lunch');
  await expect(next).toHaveText('Save and connect Google Calendar');
  await page.getByTestId('my-calendar-review-change-calendar').click();
  await expect(card).toHaveAttribute('data-screen', 'calendar');
  await page.getByTestId('my-calendar-setup-none').click();
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'review');
  await expect(next).toHaveText('Save my calendar');
  await next.click();

  // Done: what was set.
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/my-calendar\\?step=done`), {
    timeout: 60_000,
  });
  await expect(page.getByTestId('my-calendar-done-chips')).toContainText('1 time off');
  const set = await api<{ weekly: unknown; timeOff: { note: string | null }[] }>(
    token,
    'queries',
    'my_calendar_setup.get',
    { workspaceId },
  );
  expect(set.weekly).not.toBeNull();
  expect(set.timeOff.map((t) => t.note)).toEqual(['Dentist']);

  // Settings now: no calendar connected, the answers each with Change.
  await page.goto(`/app/w/${workspaceId}/settings/my-calendar`);
  await expect(page.getByTestId('my-calendar-answers')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('my-calendar-no-calendar')).toBeVisible();
  await expect(page.getByTestId('my-calendar-answer-timeOff')).toContainText('1 coming up');

  // Connect a calendar opens that question: Google, Check it over, then the browser leaves for the worker's sign-in.
  await page.getByTestId('my-calendar-connect').click();
  await expect(card).toHaveAttribute('data-screen', 'calendar', { timeout: 60_000 });
  await page.getByTestId('my-calendar-setup-google').click();
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'review');
  await page.route('**/oauth/google/start**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Google</p>' }),
  );
  await next.click();
  await expect(page).toHaveURL(/\/oauth\/google\/start\?state=/, { timeout: 60_000 });
});
