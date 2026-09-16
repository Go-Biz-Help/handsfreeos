import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { hh, hourIn, setUpTexting, textFromCustomer } from './telephony';

const MARIA = '+12815550133';

/**
 * Texts held for quiet hours (M10): in quiet hours the composer asks "Send now, or when quiet hours end?"; the later
 * choice keeps the text in the thread with when it goes, Cancel keeps it from ever going, and Send now still sends at
 * once.
 */
test('a text in quiet hours waits for them to end, says when it goes, and Cancel keeps it from going', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'held-texts');
  const workspaceId = await createBusiness(page, { name: 'Held Texts HVAC' });
  const business = await setUpTexting(page, workspaceId);

  // Quiet hours around now, in the business's time zone.
  const now = hourIn();
  await page.getByLabel('Quiet hours start').selectOption(hh(now - 1));
  await expect(page.getByText('Quiet hours saved').first()).toBeVisible();
  await page.getByLabel('Quiet hours end').selectOption(hh(now + 2));
  await expect(page.getByText('Quiet hours saved').first()).toBeVisible();

  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Maria');
  await page.getByLabel('Last name').fill('Lopez');
  await page.getByLabel('Phone').fill('281-555-0133');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  await textFromCustomer({ from: MARIA, to: business, body: 'Can someone come Friday?' });

  await page.goto(`/app/w/${workspaceId}/inbox`);
  await page.getByTestId('conversation-list').getByText('Maria Lopez').click();
  const log = page.getByTestId('message-log');
  await expect(log).toContainText('Can someone come Friday?');

  // Held until quiet hours end.
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('Yes, Friday at 9 works.');
  await page.getByTestId('composer-send').click();
  const confirm = page.getByTestId('quiet-confirm');
  await expect(confirm).toContainText('inside quiet hours');
  await confirm.getByTestId('quiet-send-later').click();
  const held = log.locator('[data-status="scheduled"]');
  await expect(held).toContainText('Yes, Friday at 9 works.');
  await expect(held).toContainText(
    /Sends (at|tomorrow at) \d{1,2}:\d\d\s[AP]M, when quiet hours end/,
  );
  await page.reload();
  await expect(log.locator('[data-status="scheduled"]')).toContainText('Yes, Friday at 9 works.');

  // Cancel: it leaves the thread and never goes.
  await log.locator('[data-status="scheduled"]').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Cancelled. That text won’t go.')).toBeVisible();
  await expect(log.locator('[data-status="scheduled"]')).toHaveCount(0);
  await page.reload();
  await expect(log).toContainText('Can someone come Friday?');
  await expect(log).not.toContainText('Yes, Friday at 9 works.');

  // Send now still sends at once.
  await box.fill('On my way now.');
  await page.getByTestId('composer-send').click();
  await confirm.getByTestId('quiet-send-now').click();
  await expect(log.locator('[data-direction="outbound"]').last()).toContainText('On my way now.');
  await expect(log.locator('[data-status="scheduled"]')).toHaveCount(0);
});
