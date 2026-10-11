import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm, uniqueEmail } from './helpers';
import { WORKER_URL } from './telephony';

/**
 * Connected mailboxes with the worker's stand-in for Microsoft's sign-in: connect Outlook, a customer's
 * email to it lands in the inbox, and a reply goes out through it. Gmail waits on Google's review.
 */
test('mailboxes: connect Outlook, mail with a customer comes in, and a reply goes out through it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'mailbox-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });

  const mike = uniqueEmail('mike');
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Mike');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Email', { exact: true }).fill(mike);
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);

  await page.goto(`/app/w/${workspaceId}/settings/email`);
  await expect(page.getByTestId('connect-gmail')).toHaveCount(0);
  await page.getByTestId('connect-outlook').click();

  // Microsoft's sign-in (on this development server, the worker's stand-in page).
  await expect(page.getByRole('heading', { name: 'Sign in to Outlook' })).toBeVisible();
  const outlook = uniqueEmail('dale').replace(/@.*$/, '@outlook.fake');
  await page.getByLabel('Email address').fill(outlook);
  await page.getByRole('button', { name: 'Allow' }).click();

  // Back in Settings, connected.
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/email`));
  await expect(
    page.getByText('Connected. Email with customers comes in over the next few minutes.'),
  ).toBeVisible();
  const mailboxes = page.getByTestId('mailboxes');
  await expect(mailboxes).toContainText(outlook);
  await expect(mailboxes).toContainText('Connected');

  // Mike writes to that mailbox; its next sync (every few seconds here) brings the email in.
  const res = await fetch(`${WORKER_URL}/test/mailboxes/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account: outlook,
      from: { address: mike, name: 'Mike Johnson' },
      subject: 'Water heater',
      text: 'Is Tuesday OK for the install?',
    }),
  });
  expect(res.status).toBe(200);
  await page.goto(`/app/w/${workspaceId}/inbox?box=all`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('conversation-list')).toContainText('Water heater', {
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId('conversation-list').getByText('Mike Johnson').click();
  const conversation = page.getByTestId('conversation');
  await expect(conversation.getByTestId('message-log')).toContainText(
    'Is Tuesday OK for the install?',
  );

  // Two ways to answer: the workspace address, or Dale's Outlook.
  const composer = conversation.getByTestId('composer');
  await expect(composer).toHaveAttribute('data-mode', 'email');
  await composer.getByTestId('composer-from').selectOption({ label: `From ${outlook} (Outlook)` });
  await composer.getByRole('textbox', { name: 'Message', exact: true }).fill('Tuesday at 9 works.');
  await composer.getByTestId('composer-send').click();
  const answer = conversation
    .getByTestId('message-log')
    .locator('[data-kind="email"][data-direction="outbound"]')
    .last();
  await expect(answer).toContainText('Tuesday at 9 works.');
  await expect(answer).toHaveAttribute('data-status', 'sent', { timeout: 20_000 });
  await expect(answer).toContainText('sent through Outlook');
});
