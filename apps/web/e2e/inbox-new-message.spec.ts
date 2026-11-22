import { expect, test } from '@playwright/test';
import { addPerson } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The Inbox's New message: anyone can be written to, whether or not they've written first. Pick who it's to (or add
 * them on the spot), choose a text or an email, and their conversation opens, started when they had none. What can't
 * reach them says what to add.
 */
test('New message opens a text or an email with someone who has never written', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'inbox-new-message');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  await addPerson(page, workspaceId, 'Mike', 'Johnson', '713-555-0142');

  // Mike has a number and no email: New message starts on a text, and Email says what to add.
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await page.getByTestId('inbox-new').click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByTestId('record-picker').fill('Mike');
  await dialog.getByRole('option', { name: /Mike Johnson/ }).click();
  await expect(dialog.getByTestId('new-message-sms')).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByTestId('new-message-goes-to')).toContainText('(713) 555-0142');
  await dialog.getByTestId('new-message-email').click();
  await expect(dialog.getByTestId('new-message-missing')).toContainText(
    'Mike Johnson has no email address yet.',
  );
  await expect(dialog.getByTestId('new-message-start')).toBeDisabled();

  // Back on Text, his conversation opens, though he has never written.
  await dialog.getByTestId('new-message-sms').click();
  await dialog.getByTestId('new-message-start').click();
  await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('thread-name')).toContainText('Mike Johnson');
  await expect(page.getByTestId('thread-channel')).toContainText('(713) 555-0142');

  // Someone who isn't a contact yet: added from the search with only an email, so New message starts on Email.
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await page.getByTestId('inbox-new').click();
  await dialog.getByTestId('record-picker').fill('Dana Smith');
  await dialog.getByTestId('customer-add-new').click();
  const add = page.getByRole('dialog', { name: 'Add a person' });
  await add.getByLabel('Email', { exact: true }).fill('dana@smith.example');
  await add.getByTestId('person-save').click();
  await expect(add).toHaveCount(0);
  await expect(dialog.getByTestId('record-picker-value')).toContainText('Dana Smith');
  await expect(dialog.getByTestId('new-message-email')).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByTestId('new-message-goes-to')).toContainText('dana@smith.example');
  await dialog.getByTestId('new-message-start').click();
  await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('thread-name')).toContainText('Dana Smith');
  await expect(page.getByTestId('thread-channel')).toContainText('dana@smith.example');
});
