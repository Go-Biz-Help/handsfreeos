import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The Assistant on a phone (the scripted stand-in model): the H in the header opens it over the whole
 * screen, a lead move waits for Confirm, and Close goes back to the lead, already in its new stage.
 */
test('phone: the header button opens the Assistant full screen, a move waits for Confirm, Close returns to the page', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'assistant-mobile');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });

  // A customer with a lead, added from the phone.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Maria');
  await page.getByLabel('Last name').fill('Santos');
  await page.getByLabel('Phone').fill('281-555-0121');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  await page.getByTestId('action-lead').click();
  await page.getByLabel('Title').fill('Water heater');
  await page.getByTestId('lead-save').click();
  await expect(page.getByTestId('open-lead-card')).toContainText('Water heater');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Pipeline' })
    .click();
  const row = page.getByTestId('board-list').locator('[data-testid^="lead-row-"]').first();
  const leadId = (await row.getAttribute('data-testid'))!.replace('lead-row-', '');
  await page.goto(`/app/w/${workspaceId}/leads/${leadId}`);
  await expect(page.getByTestId('lead-title')).toContainText('Water heater');

  // The H in the header opens it over the whole screen, with the box to ask in on screen.
  await page.getByTestId('mobile-ask').click();
  const panel = page.getByTestId('assistant-panel');
  await expect(panel).toBeVisible();
  expect(await panel.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await expect(panel.getByTestId('assistant-composer')).toBeInViewport({ ratio: 1 });
  await expect(panel.getByTestId('assistant-page')).toHaveText('On this page: Water heater');

  // Ask; the move waits for Confirm.
  await panel.getByRole('textbox', { name: 'Message the Assistant' }).fill('Move it to Contacted');
  await panel.getByRole('button', { name: 'Send' }).click();
  const card = panel.getByTestId('assistant-card-confirm');
  await expect(card).toContainText('Move this lead?');
  await expect(card).toContainText('Water heater · Maria Santos');
  await card.getByTestId('assistant-confirm').click();
  await expect(card.getByTestId('assistant-result')).toContainText('Moved to Contacted');

  // Keyboard focus stays inside while it's open.
  for (let i = 0; i < 15; i++) await page.keyboard.press('Tab');
  expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  // Close goes back to the lead, already in its new stage, with focus on the H.
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/leads/${leadId}$`));
  await expect(page.getByTestId('lead-title')).toBeVisible();
  await expect(page.getByTestId('stage-step-open-contacted')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('mobile-ask')).toBeFocused();

  // Escape closes it too.
  await page.getByTestId('mobile-ask').click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('mobile-ask')).toBeFocused();
});
