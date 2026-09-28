import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * M10: newest wins, one detail at a time. The web's edit dialogs send only what was edited, each with the value
 * the dialog opened with (`base`), so a dialog left open while a teammate changed something else never writes the
 * old value back; and tags go on and come off one at a time (record.add_tag, record.remove_tag), never as a whole
 * set.
 */

/** The JSON a command was sent with, from the request `act` makes. */
async function sentBody(page: Page, command: string, act: () => Promise<unknown>) {
  const request = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/v1/commands/${command}`),
  );
  await act();
  return (await request).postDataJSON() as Record<string, unknown>;
}

test('dialogs send only what was edited, a dialog left open keeps a teammate’s change, and tags go one at a time', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'edits-owner');
  const workspaceId = await createBusiness(page, { name: 'Newest Wins HVAC' });
  const wholeSets: string[] = [];
  page.context().on('request', (r) => {
    if (r.url().endsWith('/v1/commands/record.set_tags')) wholeSets.push(r.url());
  });

  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Maria');
  await page.getByLabel('Last name').fill('Lopez');
  await page.getByLabel('Phone').fill('(713) 555-0188');
  await page.getByLabel('Email').fill('maria@old.example');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);
  const personUrl = page.url();
  const personId = /people\/([0-9a-f-]{36})$/.exec(personUrl)![1]!;

  // The edit dialog opens here, and her last name is changed in it while a teammate changes her email in
  // another tab.
  await page.getByTestId('record-menu').click();
  await page.getByTestId('record-edit').click();
  await expect(page.getByTestId('person-form')).toBeVisible();
  await page.getByLabel('Last name').fill('Lopez-Garcia');

  const teammate = await page.context().newPage();
  await teammate.goto(personUrl);
  await teammate.getByTestId('record-menu').click();
  await teammate.getByTestId('record-edit').click();
  await teammate.getByLabel('Email').fill('maria@new.example');
  const emailOnly = await sentBody(teammate, 'person.update', () =>
    teammate.getByTestId('person-save').click(),
  );
  expect(emailOnly).toEqual({
    workspaceId,
    personId,
    email: 'maria@new.example',
    base: { email: 'maria@old.example' },
  });
  await expect(teammate.getByRole('button', { name: 'maria@new.example' })).toBeVisible();
  await teammate.close();

  // The page under the first dialog refreshes with the teammate's email, and the dialog keeps what was typed.
  await expect(
    page.getByRole('button', { name: 'maria@new.example', includeHidden: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Last name')).toHaveValue('Lopez-Garcia');

  // Only her last name is sent: the old email in the form isn't sent back.
  const lastNameOnly = await sentBody(page, 'person.update', () =>
    page.getByTestId('person-save').click(),
  );
  expect(lastNameOnly).toEqual({
    workspaceId,
    personId,
    lastName: 'Lopez-Garcia',
    base: { lastName: 'Lopez' },
  });
  await expect(page.getByTestId('record-name')).toHaveText('Maria Lopez-Garcia');
  await page.reload();
  await expect(page.getByRole('button', { name: 'maria@new.example' })).toBeVisible();

  // A new number is sent with the one she had, as stored.
  await page.getByTestId('record-menu').click();
  await page.getByTestId('record-edit').click();
  await page.getByLabel('Phone').fill('(713) 555-0199');
  const phoneOnly = await sentBody(page, 'person.update', () =>
    page.getByTestId('person-save').click(),
  );
  expect(phoneOnly).toEqual({
    workspaceId,
    personId,
    phone: '(713) 555-0199',
    base: { phone: '+17135550188' },
  });
  await expect(page.getByRole('link', { name: '(713) 555-0199' })).toBeVisible();

  // Tags on her page: one on, then off again.
  await page.getByTestId('tag-picker').getByRole('button').first().click();
  await page.getByTestId('tag-new').click();
  await page.getByLabel('Tag name').fill('VIP');
  const on = await sentBody(page, 'record.add_tag', () => page.getByTestId('tag-create').click());
  expect(on).toEqual({
    workspaceId,
    recordType: 'person',
    recordId: personId,
    tagId: expect.any(String),
  });
  await expect(page.getByTestId('tag-picker')).toContainText('VIP');
  await page.getByTestId('tag-picker').getByRole('button').first().click();
  const off = await sentBody(page, 'record.remove_tag', () =>
    page.getByRole('menuitemcheckbox', { name: 'VIP' }).click(),
  );
  expect(off).toEqual(on);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tag-picker')).not.toContainText('VIP');

  // A lead's value from its own page: only the value, with what it was.
  await page.getByTestId('action-lead').click();
  await page.getByLabel('Title').fill('Roof replacement');
  await page.getByLabel('Value').fill('12,500');
  await page.getByTestId('lead-save').click();
  await expect(page.getByTestId('open-lead-card')).toContainText('Roof replacement');
  await page.getByTestId('open-lead-card').getByRole('link', { name: 'Open lead' }).click();
  await expect(page.getByTestId('lead-detail')).toBeVisible();
  const leadId = /leads\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await page.getByTestId('lead-menu').click();
  await page.getByRole('menuitem', { name: 'Edit details' }).click();
  await page.getByLabel('Value').fill('14,000');
  const valueOnly = await sentBody(page, 'lead.update', () =>
    page.getByTestId('lead-edit-save').click(),
  );
  expect(valueOnly).toEqual({
    workspaceId,
    leadId,
    valueCents: 1_400_000,
    base: { valueCents: 1_250_000 },
  });
  await expect(page.getByTestId('lead-detail')).toContainText('$14,000');

  // The lead's tags go one at a time too.
  await page
    .getByTestId('lead-detail')
    .getByTestId('tag-picker')
    .getByRole('button')
    .first()
    .click();
  const leadTag = await sentBody(page, 'record.add_tag', () =>
    page.getByRole('menuitemcheckbox', { name: 'VIP' }).click(),
  );
  expect(leadTag).toMatchObject({ recordType: 'lead', recordId: leadId });
  await page.keyboard.press('Escape');

  // A task's title: only the title.
  await page.goto(personUrl);
  await page.getByTestId('tab-tasks').click();
  await page.getByTestId('task-new').click();
  await page.getByTestId('task-form').getByLabel('Task', { exact: true }).fill('Order filter');
  await page.getByTestId('task-form').getByLabel('Notes').fill('16x25');
  await page.getByTestId('task-save').click();
  await expect(page.getByTestId('task-list')).toContainText('Order filter');
  await page.getByTestId('task-list').getByRole('button', { name: 'Task actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByTestId('task-form').getByLabel('Task', { exact: true }).fill('Order two filters');
  const titleOnly = await sentBody(page, 'task.update', () =>
    page.getByTestId('task-save').click(),
  );
  expect(titleOnly).toEqual({
    workspaceId,
    taskId: expect.any(String),
    title: 'Order two filters',
    base: { title: 'Order filter' },
  });
  await expect(page.getByTestId('task-list')).toContainText('Order two filters');

  // The audit log says what each tag change was.
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(page.getByText('added the tag VIP').first()).toBeVisible();
  await expect(page.getByText('removed the tag VIP')).toBeVisible();
  expect(wholeSets).toEqual([]);
});
