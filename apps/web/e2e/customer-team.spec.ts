import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, randomPhone, signInOwner, WORKER } from './booking-helpers';
import {
  confirmEmail,
  createBusiness,
  linkFrom,
  signUp,
  signUpAndConfirm,
  uniqueEmail,
  waitForMail,
} from './helpers';

/**
 * A customer with more than one of everything (0103), more than one person on them (0104), and payment accounts
 * kept to the people who bill into them (0105): one person installing a client's automations and another running
 * their SEO, each paid into their own Stripe account, and both able to reach the client and see their bills.
 */

interface Business {
  readonly token: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly name: string;
}

async function business(
  page: Parameters<typeof signUpAndConfirm>[0],
  label: string,
  name: string,
): Promise<Business> {
  const { email } = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name });
  const { token, userId } = await signInOwner(email);
  return { token, userId, workspaceId, name };
}

/** A customer the owner is the main person on. */
async function customer(owner: Business, firstName: string, lastName: string): Promise<string> {
  const { personId } = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
    workspaceId: owner.workspaceId,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@hfos.test`,
    phone: randomPhone(),
    ownerUserId: owner.userId,
  });
  return personId;
}

/** A sent invoice, paid into the account named (or the one the person may use when none is). */
async function sentInvoice(
  owner: Business,
  personId: string,
  title: string,
  connectionId?: string,
): Promise<string> {
  const { invoiceId } = await api<{ invoiceId: string }>(
    owner.token,
    'commands',
    'invoice.create',
    {
      workspaceId: owner.workspaceId,
      personId,
      title,
      ...(connectionId ? { connectionId } : {}),
      lines: [
        { name: title, quantity: 1, unitLabel: 'each', unitPriceCents: 50_000, taxable: false },
      ],
    },
  );
  await api(owner.token, 'commands', 'invoice.send', {
    workspaceId: owner.workspaceId,
    invoiceId,
    channels: [],
  });
  return invoiceId;
}

/** Signs a stand-in Stripe account in, as the money specs do, and names it. */
async function connectAccount(owner: Business, accountId: string, label: string): Promise<string> {
  const { state, connectionId } = await api<{ connectionId: string; state: string }>(
    owner.token,
    'commands',
    'payment_connection.connect',
    { workspaceId: owner.workspaceId, provider: 'stripe', environment: 'test' },
  );
  const start = await fetch(`${WORKER}/oauth/stripe/start?state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
  });
  const authorize = start.headers.get('location');
  if (!authorize) throw new Error(`no provider sign-in to follow (${start.status})`);
  const approve = new URL(authorize.replace('/authorize', '/approve'));
  approve.searchParams.set('account', accountId);
  approve.searchParams.set('decision', 'allow');
  const approved = await fetch(approve, { redirect: 'manual' });
  const callback = approved.headers.get('location');
  if (!callback) throw new Error(`the stand-in refused the sign-in (${approved.status})`);
  await fetch(callback, { redirect: 'manual' });
  await expect
    .poll(
      async () =>
        (
          await api<{ connections: { id: string; status: string }[] }>(
            owner.token,
            'queries',
            'payment_connection.list',
            { workspaceId: owner.workspaceId },
          )
        ).connections.find((c) => c.id === connectionId)?.status,
    )
    .toBe('active');
  await api(owner.token, 'commands', 'payment_connection.set_label', {
    workspaceId: owner.workspaceId,
    connectionId,
    label,
  });
  return connectionId;
}

test('a customer keeps a work number, a second email and a rental address, and is found by any of them', async ({
  page,
}) => {
  const owner = await business(page, 'contacts-owner', 'Johnson Roofing Clients');

  await page.goto(`/app/w/${owner.workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Mike');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Phone').fill('(713) 555-0142');
  await page.getByLabel('Email').fill('mike@example.com');
  await page.getByTestId('add-other-phone').click();
  await page.getByTestId('other-phone-0').fill('(713) 555-0197');
  await page.getByLabel('Other number 1 label').fill('Work');
  await page.getByTestId('add-other-email').click();
  await page.getByTestId('other-email-0').fill('Mike@JohnsonRoofing.example');
  await page.getByTestId('add-other-address').click();
  await page.getByTestId('other-address-0').fill('2210 Taft St');
  await page.getByLabel('Other address 1 city').fill('Houston');
  await page.getByLabel('Other address 1 label').fill('Rental');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);
  const personUrl = page.url();

  // The main ones in the header, and the rest a press away.
  await expect(page.getByRole('link', { name: '(713) 555-0142' })).toHaveAttribute(
    'href',
    'tel:+17135550142',
  );
  await expect(page.getByTestId('header-more-contacts')).toHaveText('+3 more');
  await page.getByTestId('header-more-contacts').click();
  const details = page.getByTestId('record-details');
  await expect(details).toContainText('Work');
  await expect(details.getByRole('link', { name: '(713) 555-0197' })).toHaveAttribute(
    'href',
    'tel:+17135550197',
  );
  // Emails are kept the way the database compares them: lower case.
  await expect(details).toContainText('mike@johnsonroofing.example');
  await expect(details).toContainText('Rental');
  await expect(details).toContainText('2210 Taft St, Houston');

  // Search finds them by the other number and the other email too.
  await page.goto(`/app/w/${owner.workspaceId}/customers?q=0197`);
  await expect(page.getByTestId('people-table')).toContainText('Mike Johnson');
  await page.goto(`/app/w/${owner.workspaceId}/customers?q=johnsonroofing`);
  await expect(page.getByTestId('people-table')).toContainText('Mike Johnson');

  // Somebody new on their work number is the same person, so it warns before saving a second one.
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Michael');
  await page.getByLabel('Phone').fill('713 555 0197');
  await expect(page.getByTestId('duplicate-warning')).toContainText('Mike Johnson already exists');
  await page.keyboard.press('Escape');

  // Making the work number the main one swaps the two, and nothing is lost.
  await page.goto(personUrl);
  await page.getByTestId('record-menu').click();
  await page.getByTestId('record-edit').click();
  await page.getByRole('button', { name: 'Make this the main number' }).click();
  await page.getByTestId('person-save').click();
  await expect(page.getByRole('link', { name: '(713) 555-0197' }).first()).toHaveAttribute(
    'href',
    'tel:+17135550197',
  );
  await expect(page.getByTestId('header-more-contacts')).toHaveText('+3 more');
  await page.getByTestId('header-more-contacts').click();
  await expect(
    page.getByTestId('record-details').getByRole('link', { name: '(713) 555-0142' }),
  ).toHaveAttribute('href', 'tel:+17135550142');
});

test('two people on one customer both see their bills, and the list finds them by either', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const owner = await business(page, 'team-owner', 'Go Biz Help Team');

  // Priya joins through the emailed invitation, as anyone would.
  const mate = uniqueEmail('team-mate');
  const started = Date.now();
  await api(owner.token, 'commands', 'membership.invite', {
    workspaceId: owner.workspaceId,
    email: mate,
    role: 'member',
  });
  const mail = await waitForMail(mate, `invited you to ${owner.name}`, { after: started });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const mem = await ctx.newPage();
  await signUp(mem, { name: 'Priya Natarajan', email: mate });
  await confirmEmail(mem, mate);
  await mem.goto(link);
  await mem.getByTestId('accept-invite').click();
  await expect(mem).toHaveURL(new RegExp(`/app/w/${owner.workspaceId}`));

  // The owner does the client's automations; the SEO bill is on the same client.
  const client = await customer(owner, 'Dana', 'Whitfield');
  await sentInvoice(owner, client, 'SEO retainer');
  const clientUrl = `/app/w/${owner.workspaceId}/customers/people/${client}`;

  // Before Priya is on the client, their bills aren't hers to see — and she can't put herself on it: who is on a
  // customer is the owner's and admins' call.
  await mem.goto(clientUrl);
  await expect(mem.getByTestId('assigned-card')).toContainText('Main');
  await expect(mem.getByTestId('assign-add')).toHaveCount(0);
  await mem.getByTestId('tab-money').click();
  await expect(mem.getByTestId('record-invoice')).toHaveCount(0);

  // The owner puts her on the client; the owner stays the main person.
  await page.goto(clientUrl);
  const card = page.getByTestId('assigned-card');
  await expect(card.getByTestId('assigned-list')).toContainText('Main');
  await card.getByTestId('assign-add').selectOption({ label: 'Priya Natarajan' });
  await expect(card.getByTestId('assigned-list')).toContainText('Priya Natarajan');
  await expect(card).toContainText('2 people');

  // Now she sees the bill, and can reach the client.
  await mem.reload();
  await mem.getByTestId('tab-money').click();
  await expect(mem.getByTestId('record-invoice')).toContainText('SEO retainer');

  // The customer list finds the client under either person.
  await page.goto(`/app/w/${owner.workspaceId}/customers`);
  await page.getByTestId('customers-assigned').selectOption({ label: 'Priya Natarajan' });
  await expect(page).toHaveURL(/assigned=/);
  await expect(page.getByTestId('people-table')).toContainText('Dana Whitfield');

  // Taking her off takes the bill away again.
  await page.goto(clientUrl);
  const priya = card.getByRole('listitem').filter({ hasText: 'Priya Natarajan' });
  await priya.getByRole('button', { name: 'Change Priya Natarajan' }).click();
  await page.getByRole('menuitem', { name: 'Take off this customer' }).click();
  await expect(card.getByTestId('assigned-list')).not.toContainText('Priya Natarajan');
  await mem.reload();
  await mem.getByTestId('tab-money').click();
  await expect(mem.getByTestId('record-invoice')).toHaveCount(0);
  await ctx.close();
});

test('an account kept to one person is the only one they bill into, and Money splits by account', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await business(page, 'accounts-owner', 'Two Accounts Agency');
  const automations = await connectAccount(owner, 'acct_automations', 'Automations');
  const seo = await connectAccount(owner, 'acct_seo', 'SEO');
  const client = await customer(owner, 'Dana', 'Whitfield');
  await sentInvoice(owner, client, 'Automations setup', automations);
  await sentInvoice(owner, client, 'SEO retainer', seo);

  // Keep the SEO account to the owner, and the owner to it.
  await page.goto(`/app/w/${owner.workspaceId}/settings/payments`);
  await expect(page.getByTestId(`pay-used-by-${seo}`)).toContainText('Everyone who bills');
  await page.getByTestId(`pay-access-${seo}`).click();
  await page.getByTestId('pay-access-only-theirs').click();
  await page.getByTestId('pay-access-people').getByRole('checkbox').first().check();
  await page.getByTestId('pay-access-save').click();
  await expect(page.getByTestId(`pay-used-by-${seo}`)).toContainText(
    'and only this account for them',
  );

  // A new invoice offers only that account.
  await page.goto(`/app/w/${owner.workspaceId}/money/invoices/new`);
  const paidInto = page.getByTestId('document-connection');
  await expect(paidInto.locator('option')).toHaveCount(1);
  await expect(paidInto).toContainText('SEO');
  await expect(paidInto).not.toContainText('Automations');

  // Money splits the invoices by the account they are paid into.
  await page.goto(`/app/w/${owner.workspaceId}/money`);
  const table = page.getByTestId('invoices-table');
  await expect(table).toContainText('Paid into');
  await expect(table).toContainText('Automations setup');
  await expect(table).toContainText('SEO retainer');
  await page
    .getByTestId('money-account-filter')
    .selectOption({ label: 'Stripe · Automations (test)' });
  await expect(page).toHaveURL(new RegExp(`account=${automations}`));
  await expect(table).toContainText('Automations setup');
  await expect(table).not.toContainText('SEO retainer');
  await page.getByTestId('money-account-filter').selectOption({ label: 'No account' });
  await expect(page.getByText('No invoices match')).toBeVisible();
});
