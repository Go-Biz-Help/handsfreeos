import { expect, test } from '@playwright/test';
import { createBusiness, signIn, signUpAndConfirm } from './helpers';
import { setUpTexting, textFromCustomer, TINY_PNG } from './telephony';

const MIKE = '+17135550142';

/**
 * The texting drop end to end with the fake carrier: set up a number, text a customer from their page,
 * a reply with a photo lights up a teammate's inbox live, then assign, snooze, close, and STOP.
 */
test('texting: set up, send, receive live, assign, snooze, close and STOP', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await signUpAndConfirm(page, 'inbox-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const business = await setUpTexting(page, workspaceId);
  // Tests text at any hour.
  await page.getByTestId('quiet-hours-switch').click();
  await expect(page.getByText('Quiet hours off')).toBeVisible();
  await expect(page.getByTestId('business-number')).toBeVisible();

  // A customer, texted from their page without leaving it.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Mike');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Phone').fill('(713) 555-0142');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  const customerUrl = page.url();
  await page.getByTestId('action-text').click();
  const sheet = page.getByTestId('message-sheet');
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Hi Mike, Marco is on the way.');
  await sheet.getByTestId('composer-send').click();
  const sent = sheet.locator('[data-direction="outbound"]').last();
  await expect(sent).toContainText('Hi Mike, Marco is on the way.');
  await expect(sent).toHaveAttribute('data-status', 'delivered', { timeout: 20_000 });
  await expect(sheet).toContainText('Delivered');
  await page.keyboard.press('Escape');

  // A teammate (the same owner on another device) watches the inbox.
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const watcher = await other.newPage();
  await signIn(watcher, owner.email);
  await watcher.goto(`/app/w/${workspaceId}/inbox`);
  await expect(watcher.getByTestId('conversation-list')).toContainText('Mike Johnson');
  const badge = watcher.getByRole('navigation', { name: 'Workspace' }).getByTestId('unread-badge');
  await expect(badge).toHaveCount(0);
  await watcher.waitForTimeout(1500);

  const started = Date.now();
  await textFromCustomer({
    from: MIKE,
    to: business,
    body: 'Is Marco still coming? Here is the unit.',
    mediaUrls: [TINY_PNG],
  });
  await expect(badge).toContainText('1', { timeout: 10_000 });
  // The worker polls every half second in tests; the badge follows within a couple of seconds.
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(watcher.getByTestId('conversation-list')).toContainText('Is Marco still coming?');

  // The badge goes straight to what is unread; the filter turns off again from the list.
  await badge.click();
  await expect(watcher).toHaveURL(/[?&]unread=1/);
  await expect(watcher.getByTestId('filter-unread')).toHaveAttribute('aria-pressed', 'true');
  await expect(watcher.getByTestId('conversation-list')).toContainText('Mike Johnson');
  await watcher.getByTestId('filter-unread').click();
  await expect(watcher).not.toHaveURL(/unread=1/);

  // Opening it reads it: the photo is there and the badge clears.
  await watcher.getByTestId('conversation-list').getByText('Mike Johnson').click();
  await expect(watcher.getByTestId('message-log')).toContainText('Is Marco still coming?');
  await expect(watcher.getByTestId('media-thumb')).toBeVisible();
  await expect(badge).toHaveCount(0);

  // The photo opens full size over the thread, not in a new tab, and Escape puts it away.
  await watcher.getByTestId('media-thumb').click();
  await expect(watcher.getByTestId('photo-viewer').getByRole('img')).toBeVisible();
  expect(watcher.context().pages()).toHaveLength(1);
  await watcher.keyboard.press('Escape');
  await expect(watcher.getByTestId('photo-viewer')).toHaveCount(0);

  // Assign, snooze, unsnooze and close.
  await watcher.getByTestId('assign-menu').click();
  await watcher.getByRole('menuitem', { name: /\(you\)/ }).click();
  await expect(watcher.getByText('Assigned to you')).toBeVisible();
  await expect(watcher.getByTestId('assign-menu')).toContainText('You');
  await watcher.getByTestId('snooze-menu').click();
  await watcher.getByTestId('snooze-tomorrow').click();
  await expect(watcher.getByTestId('snoozed-banner')).toBeVisible();
  await watcher.getByRole('button', { name: 'Unsnooze' }).click();
  await expect(watcher.getByTestId('snoozed-banner')).toHaveCount(0);
  await watcher.getByTestId('close-conversation').click();
  await expect(watcher.getByTestId('closed-banner')).toBeVisible();

  // STOP opens it again and turns texting off for Mike.
  await textFromCustomer({ from: MIKE, to: business, body: 'STOP' });
  await expect(watcher.getByTestId('composer-note')).toContainText('Texting is off for Mike', {
    timeout: 15_000,
  });
  await expect(watcher.getByTestId('message-log')).toContainText('Mike opted out of texts');
  await expect(watcher.getByTestId('composer-send')).toBeDisabled();
  await other.close();

  // The customer's timeline shows both directions; the audit log tells the story.
  await page.goto(customerUrl);
  await expect(page.getByTestId('timeline-sms-outbound').first()).toContainText('sent a text');
  await expect(page.getByTestId('timeline-sms-inbound').first()).toBeVisible();
  await page.goto(`/app/w/${workspaceId}/audit`);
  await page.getByLabel('Filter by activity').selectOption('inbox');
  await expect(page.getByText(/sent a text to/).first()).toBeVisible();
  await expect(
    page.getByText(/assigned the conversation with Mike Johnson to/).first(),
  ).toBeVisible();
  await expect(page.getByText(/received a text from/).first()).toBeVisible();
});
