import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { hh, hourIn, setUpTexting, textFromCustomer, TINY_PNG_BYTES } from './telephony';

const MARIA = '+12815550121';

/**
 * The phone inbox: Inbox in the bottom bar with its badge, the list, a conversation that fills the screen,
 * the quiet-hours check before a text goes out at night, and a photo sent from the phone.
 */
test('the phone inbox: bar badge, full-screen thread, quiet hours and a photo', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'inbox-mobile');
  const workspaceId = await createBusiness(page, { name: 'Summit Roofing' });
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
  await page.getByLabel('Last name').fill('Santos');
  await page.getByLabel('Phone').fill('281-555-0121');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);

  await textFromCustomer({ from: MARIA, to: business, body: 'Is the roof crew coming tomorrow?' });

  // The bar: Home, Inbox, Customers, Pipeline, More; the Inbox badge shows the unread conversation.
  const bar = page.getByRole('navigation', { name: 'Primary' });
  await expect(bar.getByRole('link', { name: /Inbox/ })).toBeVisible();
  await expect(bar.getByRole('link', { name: /Tasks/ })).toHaveCount(0);
  await expect(bar.getByTestId('unread-badge')).toContainText('1', { timeout: 15_000 });
  await bar.getByRole('link', { name: /Inbox/ }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByTestId('conversation-list')).toContainText(
    'Is the roof crew coming tomorrow?',
  );

  // A conversation fills the screen: no bars, its own top bar.
  await page.getByTestId('conversation-list').getByText('Maria Santos').click();
  await expect(page.getByTestId('message-log')).toContainText('Is the roof crew coming tomorrow?');
  await expect(bar).toBeHidden();
  await expect(page.getByRole('link', { name: 'Back to the inbox' })).toBeVisible();
  await expect(page.getByTestId('quiet-strip')).toContainText('Quiet hours');

  // A text at night asks first.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Yes, they start at 8.');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('Keep it as a draft')).toBeVisible();
  await page.getByTestId('quiet-send-now').click();
  await expect(page.getByTestId('message-log')).toContainText('Yes, they start at 8.');

  // A photo from the phone rides along with the next text.
  await page.getByTestId('composer-file').setInputFiles({
    name: 'roof.png',
    mimeType: 'image/png',
    buffer: TINY_PNG_BYTES,
  });
  await expect(page.getByTestId('attachment-tray')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Here is the plan.');
  await page.getByTestId('composer-send').click();
  await page.getByTestId('quiet-send-now').click();
  await expect(page.getByTestId('media-thumb').last()).toBeVisible({ timeout: 15_000 });

  // Back goes to the list; the details sheet holds snooze and close.
  await page.getByRole('link', { name: 'Back to the inbox' }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(bar).toBeVisible();
  await page.getByTestId('conversation-list').getByText('Maria Santos').click();
  await page.getByTestId('thread-details').click();
  await page.getByTestId('sheet-close').click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByText('Closed. A new message opens it again.')).toBeVisible();
});
