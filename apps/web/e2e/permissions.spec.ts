import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, randomPhone, signInOwner } from './booking-helpers';
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
 * What a business lets its people do (0105). An owner turns sending invoices on for members in Settings →
 * Permissions; a member then bills the customer they're on — and only a customer they're on — and takes the cash for
 * it, while refunds stay with whoever manages money; and the owner takes billing back from that one person under
 * Members, leaving the role's setting for everyone else.
 */
test('an owner lets members bill, a member bills their own customer, and the owner takes it back from one person', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const name = 'Go Biz Help Crew';
  const { email } = await signUpAndConfirm(page, 'perm-owner');
  const workspaceId = await createBusiness(page, { name });
  const owner = await signInOwner(email);

  // Marco joins as a member, through the emailed invitation.
  const mate = uniqueEmail('perm-mate');
  const started = Date.now();
  await api(owner.token, 'commands', 'membership.invite', {
    workspaceId,
    email: mate,
    role: 'member',
  });
  const mail = await waitForMail(mate, `invited you to ${name}`, { after: started });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const mem = await ctx.newPage();
  await signUp(mem, { name: 'Marco Tech', email: mate });
  await confirmEmail(mem, mate);
  await mem.goto(link);
  await mem.getByTestId('accept-invite').click();
  await expect(mem).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
  const marco = await signInOwner(mate);

  // Something to bill for, a customer Marco is on, and one he isn't.
  await api(owner.token, 'commands', 'product.create', {
    workspaceId,
    name: 'Tune-up',
    kind: 'service',
    unitPriceCents: 18_000,
    unitLabel: 'visit',
    taxable: false,
  });
  const person = async (firstName: string, lastName: string) =>
    (
      await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
        workspaceId,
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@hfos.test`,
        phone: randomPhone(),
        ownerUserId: owner.userId,
      })
    ).personId;
  const his = await person('Dana', 'Whitfield');
  const notHis = await person('Sam', 'Ortiz');
  await api(owner.token, 'commands', 'record.assign', {
    workspaceId,
    recordType: 'person',
    recordId: his,
    userId: marco.userId,
  });
  const hisUrl = `/app/w/${workspaceId}/customers/people/${his}`;

  // A member doesn't bill until the business says so: no New invoice, even on his own customer.
  await mem.goto(hisUrl);
  await mem.getByTestId('tab-money').click();
  await expect(mem.getByTestId('record-money')).toBeVisible();
  await expect(mem.getByTestId('record-new-invoice')).toHaveCount(0);

  // The owner turns it on for members in Settings → Permissions. Admins already could.
  await page.goto(`/app/w/${workspaceId}/settings/permissions`);
  await expect(page.getByTestId('permission-admin-money.bill')).toHaveValue('inherit');
  const forMembers = page.getByTestId('permission-member-money.bill');
  await expect(forMembers).toHaveValue('inherit');
  await forMembers.selectOption('on');
  await expect(page.getByText('Saved for members.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('permission-member-money.bill')).toHaveValue('on');

  // Marco writes an invoice for his customer, sends it, and takes the cash for it.
  await mem.reload();
  await mem.getByTestId('tab-money').click();
  await mem.getByTestId('record-new-invoice').click();
  await expect(mem).toHaveURL(/\/money\/invoices\/new\?person=/);
  await mem.getByTestId('document-title').fill('Spring tune-up');
  await mem.getByTestId('line-catalogue').click();
  await mem.getByTestId('product-option-Tune-up').click();
  await mem.getByTestId('document-save').click();
  await expect(mem.getByTestId('document-saved')).toContainText('all changes saved');
  await expect(mem).toHaveURL(/\/money\/invoices\/[0-9a-f-]{36}$/);
  await mem.getByTestId('document-send').click();
  await mem.getByTestId('send-confirm').click();
  await expect(mem.getByTestId('document-status')).toHaveText('Sent');
  await mem.getByTestId('invoice-record-payment').click();
  await mem.getByTestId('cash-confirm').click();
  await expect(mem.getByTestId('document-status')).toHaveText('Paid');
  // Giving money back stays with whoever manages money.
  await expect(mem.getByTestId('invoice-payments')).toContainText('$180');
  await expect(mem.getByTestId('payment-refund')).toHaveCount(0);

  // A customer he isn't on isn't his to bill.
  const refused = await api(marco.token, 'commands', 'invoice.create', {
    workspaceId,
    personId: notHis,
    title: 'Tune-up',
    lines: [{ name: 'Tune-up', quantity: 1, unitLabel: 'visit', unitPriceCents: 18_000 }],
  }).then(
    () => null,
    (e: unknown) => String(e),
  );
  expect(refused).toContain('money_not_your_customer');

  // The owner takes billing back from Marco alone, under Members.
  await page.goto(`/app/w/${workspaceId}/members`);
  await page.getByRole('button', { name: 'More for Marco Tech' }).click();
  await page.getByTestId(`member-permissions-${mate}`).click();
  const his$ = page.getByTestId('person-permission-money.bill');
  await expect(his$).toHaveValue('inherit');
  await expect(his$.locator('option[value="inherit"]')).toHaveText('Same as Member (on)');
  await his$.selectOption('off');
  await expect(page.getByText('Saved for Marco Tech.')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId(`member-own-permissions-${mate}`)).toBeVisible();

  // He still sees his customer's bill, and can no longer write one. The role's setting stands for everyone else,
  // and the settings page lists him as having his own.
  await mem.goto(hisUrl);
  await mem.getByTestId('tab-money').click();
  await expect(mem.getByTestId('record-invoice')).toContainText('Spring tune-up');
  await expect(mem.getByTestId('record-new-invoice')).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/settings/permissions`);
  await expect(page.getByTestId('permission-member-money.bill')).toHaveValue('on');
  await expect(page.getByTestId('permission-people')).toContainText('Marco Tech');
  await ctx.close();
});
