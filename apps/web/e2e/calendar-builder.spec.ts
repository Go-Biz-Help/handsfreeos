import { expect, test } from '@playwright/test';
import { addTeammate, apptIdOf, weekdayAhead } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * One universal calendar: created from a preset, then turned from Personal into Round Robin, Service and
 * Group/Class. Its id, booking link and appointment stay the same throughout; a conflicting setting is
 * explained and fixed with Fix; History restores an earlier revision.
 */
test('a preset, then Personal → Round Robin → Service → Group on one calendar, and a conflict fixed', async ({
  browser,
  page,
}) => {
  await signUpAndConfirm(page, 'builder-owner');
  const business = 'Lone Star HVAC & Roofing';
  const workspaceId = await createBusiness(page, { name: business });
  const mate = await addTeammate(page, browser, workspaceId, business, 'Priya Natarajan');
  await mate.context.close();

  // A service to offer later, and the booking site so the calendar gets a named link.
  await page.goto(`/app/w/${workspaceId}/settings/calendars/services`);
  await page.getByTestId('service-new').click();
  await page.getByTestId('service-editor').getByLabel('Name', { exact: true }).fill('Tune-up');
  await page.getByTestId('service-save').click();
  await expect(page.getByTestId('service-row-Tune-up')).toBeVisible();
  const site = `lone-star-${Date.now().toString(36)}`;
  await page.goto(`/app/w/${workspaceId}/settings/calendars/booking-site`);
  await page.getByLabel('Link name').fill(site);
  await page.getByTestId('booking-site-save').click();
  await expect(page.getByTestId('booking-site-link')).toContainText(`/book/${site}`);

  // "How do you want this calendar to work?" Presets only prefill: the labels follow the pick.
  await page.goto(`/app/w/${workspaceId}/settings/calendars`);
  await page.getByTestId('calendar-new').click();
  await expect(
    page.getByRole('heading', { name: 'How do you want this calendar to work?' }),
  ).toBeVisible();
  await page.getByTestId('preset-round_robin').click();
  await expect(page.getByTestId('preset-labels')).toHaveText('Round Robin');
  await page.getByTestId('preset-personal').click();
  await expect(page.getByTestId('preset-labels')).toHaveText('Personal');
  await page.getByLabel('Name', { exact: true }).fill('Estimates');
  await page.getByTestId('calendar-create').click();
  await expect(page).toHaveURL(/\/settings\/calendars\/[0-9a-f-]{36}$/);
  const builder = page.url();
  const labels = page.getByTestId('builder-labels').locator('span');
  await expect(labels).toHaveText(['Personal']);
  const link = page.getByTestId('booking-link');
  await expect(link).toContainText(`/book/${site}/estimates`);
  const linkText = (await link.textContent())!;
  await page.getByTestId('calendar-turn-on').click();
  await expect(page.getByTestId('calendar-status')).toHaveText('Active');

  // One appointment on it, next week.
  const day = weekdayAhead(8);
  await page.goto(`/app/w/${workspaceId}/calendar?view=week&date=${day}`);
  await page.getByTestId('calendar-new').click();
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  await dialog.getByLabel('Date').fill(day);
  await dialog.getByLabel('Start').selectOption('600');
  await dialog.getByTestId('appointment-book').click();
  await expect(page.getByText(/^Booked Estimates with /)).toBeVisible();
  const block = page.locator('[data-testid^="appt-"]');
  await expect(block).toHaveCount(1);
  const apptId = await apptIdOf(block);

  // Personal → Round Robin: add Priya, take turns.
  await page.goto(builder);
  await page.getByTestId('team-add').click();
  await page.getByRole('menuitem', { name: 'Priya Natarajan' }).click();
  await page.getByTestId('assignment-round_robin').click();
  await expect(labels).toHaveText(['Round Robin']);
  await expect(page.getByTestId('builder-how')).toContainText('take turns');
  await page.getByTestId('builder-save').click();
  await expect(page.getByText(/^Saved as revision 2\./)).toBeVisible();
  await expect(page.getByTestId('builder-revision')).toContainText('Revision 2');

  // → Service: customers pick from the services.
  await page.getByTestId('module-services').click();
  await page.getByTestId('services-choice').click();
  await page
    .getByTestId('service-picks')
    .getByRole('checkbox', { name: /Tune-up/ })
    .check();
  await expect(labels).toHaveText(['Round Robin', 'Service']);
  await page.getByTestId('builder-save').click();
  await expect(page.getByText(/^Saved as revision 3\./)).toBeVisible();

  // → Group/Class: ten seats.
  await page.getByTestId('module-capacity').click();
  await page.getByTestId('capacity-seats').fill('10');
  await expect(labels).toHaveText(['Group/Class', 'Round Robin', 'Service']);
  await page.getByTestId('builder-save').click();
  await expect(page.getByText(/^Saved as revision 4\./)).toBeVisible();

  // A conflict: groups bigger than the seats. It blocks saving an active calendar until fixed.
  await page.getByTestId('capacity-party').fill('20');
  const issue = page.getByTestId('issue-party_over_seats');
  await expect(issue).toContainText('Blocks saving while active');
  await expect(page.getByTestId('builder-save')).toBeDisabled();
  await expect(page.getByTestId('builder-save-note')).toHaveText('Fix the red item to save');
  await issue.locator('[data-testid^="fix-party_over_seats-"]').first().click();
  await expect(page.getByTestId('issue-party_over_seats')).toHaveCount(0);
  await expect(page.getByTestId('builder-issues')).toContainText('Done:');
  await expect(page.getByTestId('capacity-party')).toHaveValue('10');
  await page.getByTestId('builder-save').click();
  await expect(page.getByText(/^Saved as revision 5\./)).toBeVisible();

  // Same calendar, same link, same appointment.
  expect(page.url()).toBe(builder);
  await expect(link).toHaveText(linkText);
  await page.goto(`/app/w/${workspaceId}/calendar?view=week&date=${day}&appt=${apptId}`);
  await expect(page.getByTestId(`appt-${apptId}`)).toBeVisible();
  await expect(page.getByTestId('appointment-sheet')).toContainText('Estimates');

  // History keeps every save; restoring saves the old settings as a new revision.
  await page.goto(builder);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByTestId('calendar-history').locator('li')).toHaveCount(5);
  await expect(page.getByTestId('revision-1')).toContainText('Created from Personal');
  await page.getByTestId('restore-2').click();
  await expect(page.getByText(/^Restored revision 2 as revision 6\./)).toBeVisible();
  await expect(labels).toHaveText(['Round Robin']);
  expect(page.url()).toBe(builder);

  // The list shows the labels, and the audit log tells the story.
  await page.goto(`/app/w/${workspaceId}/settings/calendars`);
  await expect(page.getByTestId('calendars-list')).toContainText('Round Robin');
  await page.goto(`/app/w/${workspaceId}/audit`);
  await page.getByLabel('Filter by activity').selectOption('calendar');
  const log = page.getByTestId('audit-log');
  await expect(log).toContainText('created the calendar Estimates from the Personal preset');
  await expect(log).toContainText('turned on Estimates');
  await expect(log).toContainText('saved Estimates as revision 2 (Personal → Round Robin)');
  await expect(log).toContainText('restored Estimates to revision 2, saved as revision 6');
});
