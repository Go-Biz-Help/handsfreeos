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
