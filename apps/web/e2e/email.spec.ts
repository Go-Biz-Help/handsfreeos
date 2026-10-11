import { expect, test, type Page } from '@playwright/test';
import { emailFromCustomer, mailDetail, pdfAttachment, pdfFile } from './email';
import { leadIntakeOff, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm, uniqueEmail, waitForMail } from './helpers';

const BUSINESS = 'Lone Star HVAC & Roofing';

async function addCustomer(
  page: Page,
  workspaceId: string,
  person: { first: string; last: string; email: string },
): Promise<string> {
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill(person.first);
  await page.getByLabel('Last name').fill(person.last);
  await page.getByLabel('Email', { exact: true }).fill(person.email);
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  return page.url();
}

/** The workspace's address on the shared subdomain, as Settings → Email shows it. */
async function sharedAddress(page: Page, workspaceId: string): Promise<string> {
  await page.goto(`/app/w/${workspaceId}/settings/email`);
  const addresses = page.getByTestId('email-addresses');
  await expect(addresses).toContainText('@mail.handsfreeos.com');
  return (await addresses.locator('.font-mono').first().textContent())!.trim();
}

/** Composes and sends an email in the record page's sheet. */
async function emailFromSheet(page: Page, subject: string, body: string, file?: string) {
  await page.getByTestId('action-email').click();
  const sheet = page.getByTestId('message-sheet');
  await expect(sheet).toHaveAttribute('data-channel', 'email');
  await sheet.getByTestId('composer-subject').fill(subject);
  if (file) {
    await sheet.getByTestId('composer-file').setInputFiles(pdfFile(file));
    await expect(sheet.getByTestId('email-attachments')).toContainText(file);
  }
  await sheet.getByRole('textbox', { name: 'Message', exact: true }).fill(body);
  await sheet.getByTestId('composer-send').click();
  return sheet;
}

/**
 * Email end to end with the local transport (Mailpit) and Postmark-shaped webhooks: send from the
 * workspace address, the customer's reply comes back by its Reply-To token with a file, and the thread
 * answers from the inbox.
 */
test('email: send from the workspace address, the reply lands in the thread, answer from the inbox', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'email-owner');
  const workspaceId = await createBusiness(page, { name: BUSINESS });

  // Every workspace starts with an address on the shared subdomain. Gmail is coming soon.
  const shared = await sharedAddress(page, workspaceId);
  await expect(page.getByTestId('email-addresses')).toContainText('Default');
  await expect(page.getByTestId('connect-gmail')).toBeDisabled();
  await expect(page.getByText('Coming soon', { exact: true })).toBeVisible();
  await expect(page.getByTestId('blocked-addresses')).toContainText('Nothing blocked.');
  // Mail from people not in Contacts goes to Other mail in the inbox now (M19), so the old list isn't here.
  await expect(page.getByTestId('unmatched-mail')).toHaveCount(0);

  const mike = uniqueEmail('mike');
  const customerUrl = await addCustomer(page, workspaceId, {
    first: 'Mike',
    last: 'Johnson',
    email: mike,
  });

  // An email from the customer's page, with a file.
  const started = Date.now();
  const sheet = await emailFromSheet(
    page,
    'Your roof estimate',
    'Hi Mike, the estimate is attached.',
    'estimate-0912.pdf',
  );
  // The sheet's visible heading (its dialog title is also there, for screen readers only).
  await expect(page.getByRole('heading', { name: 'Email Mike Johnson' }).last()).toBeVisible();
  const sent = sheet.locator('[data-kind="email"][data-direction="outbound"]').last();
  await expect(sent).toContainText('Your roof estimate');
  await expect(sent).toHaveAttribute('data-status', 'delivered', { timeout: 20_000 });

  // It left from the workspace address under the business name; replies come back by token.
  const mail = await waitForMail(mike, 'Your roof estimate', { after: started });
  const detail = await mailDetail(mail.id);
  expect(detail.from).toEqual({ Name: BUSINESS, Address: shared });
  expect(detail.attachments).toContain('estimate-0912.pdf');
  const replyTo = detail.replyTo[0]!.Address;
  expect(replyTo).toMatch(/\+[a-z2-7]{10}@mail\.handsfreeos\.com$/i);

  // Mike answers with a signed copy; it lands in the same thread.
  await emailFromCustomer({
    from: mike,
    fromName: 'Mike Johnson',
    to: replyTo,
    subject: 'Re: Your roof estimate',
    text: 'Sounds good. The signed copy is attached.',
    attachments: [pdfAttachment('estimate-signed.pdf')],
  });
  const reply = sheet.locator('[data-kind="email"][data-direction="inbound"]').last();
  await expect(reply).toContainText('Sounds good', { timeout: 15_000 });
  await expect(reply).toContainText('estimate-signed.pdf');

  // The whole conversation in the inbox: an email thread, answered from the desktop composer.
  await sheet.getByRole('link', { name: 'Open the whole conversation in the inbox' }).click();
  const conversation = page.getByTestId('conversation');
  await expect(page.getByTestId('thread-name')).toHaveText('Mike Johnson');
  await expect(conversation).toContainText(`${mike} · Email`);
  const composer = conversation.getByTestId('composer');
  await expect(composer).toHaveAttribute('data-mode', 'email');
  await expect(composer.getByTestId('composer-from')).toHaveText(`From ${shared}`);
  await expect(composer.getByTestId('composer-to')).toHaveText(mike);
  await expect(composer.getByTestId('composer-subject')).toHaveValue('Re: Your roof estimate');

  // Texting needs a number Mike doesn't have.
  await composer.getByTestId('composer-mode-text').click();
  await expect(page.getByText('There’s no mobile number for Mike yet')).toBeVisible();
  await expect(composer).toHaveAttribute('data-mode', 'email');

  const again = Date.now();
  await composer
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Great, see you Thursday.');
  await composer.getByTestId('composer-send').click();
  const answer = conversation
    .getByTestId('message-log')
    .locator('[data-kind="email"][data-direction="outbound"]')
    .last();
  await expect(answer).toContainText('Great, see you Thursday.');
  await expect(answer).toHaveAttribute('data-status', 'delivered', { timeout: 20_000 });
  await expect(answer).toContainText('Delivered');
  await waitForMail(mike, 'Re: Your roof estimate', { after: again });

  // The More menu copies the address, not a number.
  await conversation.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Copy email address' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The customer's timeline and the audit log.
  await page.goto(customerUrl);
  await expect(page.getByTestId('timeline-email-outbound').first()).toContainText('sent an email');
  await expect(page.getByTestId('timeline-email-inbound').first()).toContainText('emailed');
  await page.goto(`/app/w/${workspaceId}/audit`);
  await page.getByLabel('Filter by activity').selectOption('inbox');
  await expect(page.getByText(/sent an email to/).first()).toBeVisible();
  await expect(page.getByText(/received an email/).first()).toBeVisible();
});

test('email: a bounce blocks the address, and mail from a stranger waits in Other mail', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email: ownerEmail } = await signUpAndConfirm(page, 'email-bounce');
  const workspaceId = await createBusiness(page, { name: BUSINESS });
  // Mail from a stranger waits in Other mail only while lead intake leaves it there (M14, M19).
  const { token: ownerToken } = await signInOwner(ownerEmail);
  await leadIntakeOff(ownerToken, workspaceId, ['email']);

  // The local transport bounces any address at bounce.example.com, the way a mail server would.
  const bad = `linda-${Date.now()}@bounce.example.com`;
  await addCustomer(page, workspaceId, { first: 'Linda', last: 'Park', email: bad });
  const sheet = await emailFromSheet(page, 'Your warranty', 'Hi Linda, your warranty papers.');
  const sent = sheet.locator('[data-kind="email"][data-direction="outbound"]').last();
  await expect(sent).toHaveAttribute('data-status', 'bounced', { timeout: 20_000 });
  await expect(sheet.getByTestId('composer-note')).toContainText(
    'bounced, so we stopped sending to it',
    { timeout: 10_000 },
  );
  await expect(sheet.getByTestId('composer-send')).toBeDisabled();
  await page.keyboard.press('Escape');

  // Settings lists the blocked address and can unblock it.
  const shared = await sharedAddress(page, workspaceId);
  const blocked = page.getByTestId('blocked-addresses');
  await expect(blocked).toContainText(bad);
  await expect(blocked).toContainText('Bounced, the address doesn’t exist');
  await blocked.getByRole('button', { name: 'Unblock' }).click();
  await expect(blocked).toContainText('Nothing blocked.');

  // Someone who isn't a customer writes to the workspace address: it waits in Other mail (M19).
  const karen = uniqueEmail('karen');
  await emailFromCustomer({
    from: karen,
    fromName: 'Karen Liu',
    to: shared,
    subject: 'Do you service heat pumps?',
    text: 'We have a Trane unit that is ten years old.',
  });
  await page.goto(`/app/w/${workspaceId}/inbox?box=other`);
  const list = page.getByTestId('conversation-list');
  // The worker files it a moment later (reload in case it landed before the page was listening).
  await expect(async () => {
    await page.reload();
    await expect(list).toContainText(karen, { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(list).toContainText('Do you service heat pumps?');
  await expect(page.getByTestId('box-other')).toHaveAttribute('aria-pressed', 'true');
  // Not in the team's Inbox.
  await page.getByTestId('box-other').click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(list).not.toContainText(karen);

  // Adding her as a customer puts the email in the Inbox, under her.
  await page.goto(`/app/w/${workspaceId}/inbox?box=other`);
  await list.getByText(karen).click();
  await page.getByTestId('banner-add-person').click();
  // In the dialog: the inbox beside it labels its email rows too.
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Email', { exact: true })).toHaveValue(karen);
  await dialog.getByLabel('First name').fill('Karen');
  await dialog.getByLabel('Last name').fill('Liu');
  await dialog.getByTestId('person-save').click();
  await expect(page.getByTestId('thread-name')).toHaveText('Karen Liu');
  await page.goto(`/app/w/${workspaceId}/inbox?box=all`);
  await expect(page.getByTestId('conversation-list')).toContainText('Karen Liu');
});

test('email: an own domain shows its DNS records, verifies, and becomes the sending address', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'email-domain');
  const workspaceId = await createBusiness(page, { name: BUSINESS });
  const shared = await sharedAddress(page, workspaceId);
  const domain = `lonestarhvac-${Date.now().toString(36)}.com`;

  await page.getByTestId('domain-input').fill(domain);
  await page.getByRole('button', { name: 'Add domain' }).click();
  await expect(page.getByText('Domain added. Now add the records it shows.')).toBeVisible();
  await expect(page.getByTestId('domain-name')).toHaveText(domain);
  await expect(page.getByText('Waiting for DNS')).toBeVisible();
  // The worker asks the mail service for the records; they show a moment later.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('dns-TXT')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByTestId('dns-TXT')).toContainText('pm._domainkey');
  await expect(page.getByTestId('dns-CNAME')).toContainText('pm-bounces');
  // And the one that says this business set the domain up (M19).
  await expect(page.getByTestId('dns-TXT-ownership')).toContainText('_hfos-verify');

  // The (local) mail service finds both records.
  await page.getByTestId('domain-check').click();
  await expect(async () => {
    await expect(page.getByLabel('Address name')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await page.getByLabel('Address name').fill('office');
  await page.getByRole('button', { name: 'Add address' }).click();
  await expect(page.getByText(`office@${domain} is now the default address`)).toBeVisible();
  await expect(page.getByTestId('email-address-office')).toContainText('Default');
  await expect(page.getByTestId(`email-address-${shared.split('@')[0]}`)).toContainText('Backup');

  // The next email goes out from the new address; replies still come back through the shared subdomain.
  const sarah = uniqueEmail('sarah');
  await addCustomer(page, workspaceId, { first: 'Sarah', last: 'Alvarez', email: sarah });
  const started = Date.now();
  const sheet = await emailFromSheet(
    page,
    'Maintenance plan renewal',
    'Hi Sarah, your plan renews soon.',
  );
  await expect(
    sheet.locator('[data-kind="email"][data-direction="outbound"]').last(),
  ).toHaveAttribute('data-status', 'delivered', { timeout: 20_000 });
  const detail = await mailDetail(
    (await waitForMail(sarah, 'Maintenance plan renewal', { after: started })).id,
  );
  expect(detail.from.Address).toBe(`office@${domain}`);
  expect(detail.replyTo[0]!.Address).toMatch(/@mail\.handsfreeos\.com$/);
});
