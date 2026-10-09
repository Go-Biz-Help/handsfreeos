import { expect, test } from '@playwright/test';
import { addPerson, createCalendar, weekdayAhead } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting, textFromCustomer } from './telephony';

/**
 * Deleting for good, through the Deleted bin (20261027000400; the owner's decisions of 2026-10-08): an owner
 * deletes a customer from their page, finds them in Settings → Deleted bin from their old link, brings them back,
 * deletes two at once from Contacts and empties the bin; deletes conversations from the inbox, picked or open;
 * deletes a booking still to come, which is cancelled first with the customer told; and (20261027000700) deletes a
 * lead and a company from their pages and brings them back.
 */
test('a customer deleted, found in the bin, brought back; two at once; the bin emptied', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'bin-owner');
  const workspaceId = await createBusiness(page, { name: 'Clean Slate Plumbing' });

  const add = async (first: string, last: string) => {
    await page.goto(`/app/w/${workspaceId}/customers`);
    await page.getByTestId('customers-add').click();
    await page.getByLabel('First name').fill(first);
    await page.getByLabel('Last name').fill(last);
    await page.getByTestId('person-save').click();
    await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);
    return page.url();
  };
  const ana = await add('Ana', 'Reyes');
  await add('Ben', 'Ortiz');
  await add('Cal', 'Price');

  // From her page: the box says where she goes, and she leaves Contacts.
  await page.goto(ana);
  await page.getByTestId('record-menu').click();
  await page.getByTestId('record-delete').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete Ana Reyes for good?');
  await expect(dialog).toContainText('They wait 30 days in Settings → Deleted bin');
  await page.getByTestId('delete-confirm').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/customers$`));
  const table = page.getByTestId('people-table');
  await expect(table).toContainText('Ben Ortiz');
  await expect(table).not.toContainText('Ana Reyes');

  // Her old link says where she went, and the way to the bin.
  await page.goto(ana);
  await expect(page.getByTestId('record-gone')).toContainText(
    'Ana Reyes was deleted. An owner can bring them back from Settings → Deleted bin.',
  );
  await page.getByRole('link', { name: 'Open the Deleted bin' }).click();
  await expect(page).toHaveURL(/\/settings\/deleted-bin$/);
  const bin = page.getByTestId('deleted-bin');
  const item = bin.locator('li', { hasText: 'Ana Reyes' });
  await expect(item).toContainText('Customer');
  await expect(item).toContainText(/Deleted by .+ · Gone for good on /);
  await item.getByTestId('bin-restore').click();
  await expect(page.getByText('Ana Reyes is back in Contacts.')).toBeVisible();
  await expect(bin).toContainText('The bin is empty');
  await page.goto(`/app/w/${workspaceId}/customers`);
  await expect(table).toContainText('Ana Reyes');

  // Two at once, ticked in the list.
  await page.getByRole('checkbox', { name: 'Select Ben Ortiz' }).check();
  await page.getByRole('checkbox', { name: 'Select Cal Price' }).check();
  await expect(page.getByTestId('people-picked')).toContainText('2 selected');
  await page.getByTestId('people-delete').click();
  await expect(dialog).toContainText('Delete 2 customers for good?');
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByText('2 customers deleted.')).toBeVisible();
  await expect(table).not.toContainText('Ben Ortiz');
  await expect(table).not.toContainText('Cal Price');
  await expect(table).toContainText('Ana Reyes');

  // Emptied, nothing in it can come back.
  await page.goto(`/app/w/${workspaceId}/settings/deleted-bin`);
  await expect(bin.locator('li')).toHaveCount(2);
  await page.getByTestId('bin-empty-all').click();
  await expect(dialog).toContainText('Empty the Deleted bin?');
  await page.getByTestId('bin-empty-confirm').click();
  await expect(page.getByText('Deleting 2 things for good now.')).toBeVisible();
  await expect(bin.getByText('Being deleted now')).toHaveCount(2);
  await expect(page.getByTestId('bin-restore')).toHaveCount(0);
});

test('conversations deleted from the inbox, picked or open', async ({ page }) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'bin-inbox');
  const workspaceId = await createBusiness(page, { name: 'Clean Slate Drains' });
  const business = await setUpTexting(page, workspaceId);
  for (const [from, body] of [
    ['+17135550161', 'First leak under the sink'],
    ['+17135550162', 'Second leak in the attic'],
    ['+17135550163', 'Third leak by the heater'],
  ] as const)
    await textFromCustomer({ from, to: business, body });

  const list = page.getByTestId('conversation-list');
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(list).toContainText('Third leak by the heater');

  // Two picked from the list.
  await page.getByTestId('inbox-pick').click();
  await list.locator('label', { hasText: 'First leak' }).getByRole('checkbox').check();
  await list.locator('label', { hasText: 'Second leak' }).getByRole('checkbox').check();
  await expect(page.getByTestId('inbox-picked')).toContainText('2 selected');
  await page.getByTestId('inbox-delete').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete 2 conversations for good?');
  await expect(dialog).toContainText('This also deletes 2 messages.');
  await expect(dialog).toContainText('They don’t delete anyone from Contacts.');
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByText('2 conversations deleted.')).toBeVisible();
  await expect(list).not.toContainText('First leak');
  await expect(list).not.toContainText('Second leak');
  await expect(page.getByTestId('inbox-pick')).toHaveText('Select');

  // The one left, opened and deleted from its menu.
  await list.getByText('Third leak by the heater').click();
  await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
  await page.getByTestId('thread-menu').click();
  await page.getByTestId('thread-delete').click();
  // A number that texted in first is a customer named by it.
  await expect(dialog).toContainText('Delete the conversation with (713) 555-0163 for good?');
  await page.getByTestId('delete-confirm').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/inbox$`));
  await expect(list).not.toContainText('Third leak');

  // All three wait in the bin.
  await page.goto(`/app/w/${workspaceId}/settings/deleted-bin`);
  const bin = page.getByTestId('deleted-bin');
  await expect(bin.locator('li')).toHaveCount(3);
  const first = bin.locator('li', { hasText: '(713) 555-0161' });
  await expect(first).toContainText('Conversation');
  await expect(first).toContainText('Text · 1 message');
});

test('a booking still to come, cancelled with the customer told and deleted', async ({ page }) => {
  await signUpAndConfirm(page, 'bin-booking');
  const workspaceId = await createBusiness(page, { name: 'Clean Slate Heating' });
  await createCalendar(page, workspaceId, { name: 'Estimates' });
  await addPerson(page, workspaceId, 'Mike', 'Johnson', '713-555-0142');

  // Booked from his page, at 10 AM a few weekdays ahead.
  const day = weekdayAhead(3);
  await page.getByTestId('action-book').click();
  const book = page.getByRole('dialog', { name: 'New appointment' });
  await book.getByLabel('Date').fill(day);
  await book.getByLabel('Start').selectOption('600');
  await book.getByTestId('appointment-book').click();
  await expect(page.getByText(/^Booked Estimates with .* at 10:00 AM\.$/)).toBeVisible();

  // From its sheet on the calendar: cancelled first, telling Mike unless that's unticked.
  await page.goto(`/app/w/${workspaceId}/calendar?view=week&date=${day}`);
  const block = page.locator('[data-testid^="appt-"]');
  await expect(block).toHaveCount(1);
  await block.click();
  await page.getByTestId('appointment-sheet').getByTestId('sheet-delete').click();
  const dialog = page.getByRole('dialog', { name: 'Delete this booking for good?' });
  await expect(dialog).toContainText('It’s still to come, so it’s cancelled first.');
  await expect(dialog).toContainText('Text Mike that it’s cancelled');
  await expect(page.getByTestId('delete-tell')).toBeChecked();
  await page.getByTestId('delete-confirm').click();
  await expect(
    page.getByText(/^Cancelled and deleted\. The customer is being told\./),
  ).toBeVisible();
  await expect(block).toHaveCount(0);

  // It waits in the bin with when it was and who it was for.
  await page.goto(`/app/w/${workspaceId}/settings/deleted-bin`);
  const item = page.getByTestId('deleted-bin').locator('li', { hasText: 'Estimates' });
  await expect(item).toContainText('Booking');
  await expect(item).toContainText(/at 10:00 AM · Mike Johnson/);
});

test('a lead and a company deleted from their pages, and brought back', async ({ page }) => {
  await signUpAndConfirm(page, 'bin-more');
  const workspaceId = await createBusiness(page, { name: 'Clean Slate Roofing' });

  // A company, and a customer at it with a lead.
  await page.goto(`/app/w/${workspaceId}/customers?tab=companies`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('Company name').fill('ABC Dental');
  await page.getByTestId('company-save').click();
  await expect(page).toHaveURL(/\/customers\/companies\/[0-9a-f-]{36}$/);
  const company = page.url();
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Mike');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Company').selectOption({ label: 'ABC Dental' });
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);
  await page.getByTestId('action-lead').click();
  await page.getByLabel('Title').fill('Roof replacement');
  await page.getByTestId('lead-save').click();
  await page.getByTestId('open-lead-card').getByRole('link', { name: 'Open lead' }).click();
  await expect(page.getByTestId('lead-detail')).toBeVisible();

  // The lead, from its own page: its customer stays.
  await page.getByTestId('lead-menu').click();
  await page.getByTestId('lead-delete').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete this lead for good?');
  await expect(dialog).toContainText('It doesn’t delete Mike Johnson from Contacts.');
  await page.getByTestId('delete-confirm').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/pipeline`));

  // The company, from its page: the person who works there stays.
  await page.goto(company);
  await page.getByTestId('record-menu').click();
  await page.getByTestId('record-delete').click();
  await expect(dialog).toContainText('Delete ABC Dental for good?');
  await expect(dialog).toContainText('The person who works there stays in Contacts.');
  await page.getByTestId('delete-confirm').click();
  await expect(page).toHaveURL(/\/customers\?tab=companies$/);

  // Both wait in the bin, and come back.
  await page.goto(`/app/w/${workspaceId}/settings/deleted-bin`);
  const bin = page.getByTestId('deleted-bin');
  const lead = bin.locator('li', { hasText: 'Roof replacement' });
  await expect(lead).toContainText('Lead');
  await expect(lead).toContainText('Mike Johnson');
  const abc = bin.locator('li', { hasText: 'ABC Dental' });
  await expect(abc).toContainText('Company');
  await lead.getByTestId('bin-restore').click();
  await expect(page.getByText('Roof replacement is back in the Pipeline.')).toBeVisible();
  await abc.getByTestId('bin-restore').click();
  await expect(page.getByText('ABC Dental is back in Contacts.')).toBeVisible();
  await expect(bin).toContainText('The bin is empty');
});
