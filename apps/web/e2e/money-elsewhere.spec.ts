import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  api,
  finishSignIn,
  makeCalendar,
  ownerWithSite,
  randomPhone,
  signInOwner,
  WORKER,
  type Owner,
} from './booking-helpers';
import { confirmEmail, linkFrom, signUp, uniqueEmail, waitForMail } from './helpers';

/**
 * Money on the pages people already work on: the customer's record, the lead, the visit and the inbox.
 *
 * The one this spec is really about is the **held** visit. A time held while a customer pays its deposit is a
 * real appointment on a real slot for up to fifteen minutes, and until this step it read to staff exactly
 * like a confirmed booking — somebody would ring to confirm a visit nobody had paid for, or work around a
 * slot about to free itself. So the calendar row and the sheet have to say what it is, plainly, and then say
 * what was paid once the deposit lands.
 */

const CARD_OK = '4242 4242 4242 4242';
const PRICE = 45_000;
const DEPOSIT = '$112.50';
const AFTER = '$337.50';

/** The business's own money settings: 8.25% tax, a quarter up front, numbered invoices. */
const moneySettings = (owner: Owner) =>
  api(owner.token, 'commands', 'money.save_settings', {
    workspaceId: owner.workspaceId,
    settings: {
      tax: { rateBp: 825, name: 'TX sales tax' },
      numbering: {
        estimate: { prefix: 'EST-', next: 1001, pad: 4 },
        invoice: { prefix: 'INV-', next: 1001, pad: 4 },
      },
      deposit: { kind: 'percent', percentBp: 2500 },
      bankTransfer: false,
    },
  });

/** Signs a stand-in payment account in, the same way the deposit spec does. */
async function connectAccount(owner: Owner, accountId: string): Promise<string> {
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
  await finishSignIn(owner.token, callback);
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
  return connectionId;
}

async function person(owner: Owner, firstName: string, lastName: string): Promise<string> {
  const { personId } = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
    workspaceId: owner.workspaceId,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@hfos.test`,
    phone: randomPhone(),
  });
  return personId;
}

/** A sent invoice for one customer, optionally due in the past (so it reads as overdue) and paid in cash. */
async function invoiceFor(
  owner: Owner,
  opts: {
    personId: string;
    title: string;
    amountCents: number;
    dueOn?: string;
    paid?: boolean;
    attendeeId?: string;
  },
): Promise<string> {
  const { invoiceId } = await api<{ invoiceId: string }>(
    owner.token,
    'commands',
    'invoice.create',
    {
      workspaceId: owner.workspaceId,
      personId: opts.personId,
      attendeeId: opts.attendeeId ?? null,
      title: opts.title,
      dueOn: opts.dueOn ?? null,
      lines: [
        {
          name: opts.title,
          quantity: 1,
          unitLabel: 'each',
          unitPriceCents: opts.amountCents,
          taxable: false,
        },
      ],
    },
  );
  await api(owner.token, 'commands', 'invoice.send', {
    workspaceId: owner.workspaceId,
    invoiceId,
    channels: [],
  });
  if (opts.paid)
    await api(owner.token, 'commands', 'invoice.record_cash_payment', {
      workspaceId: owner.workspaceId,
      invoiceId,
      amountCents: opts.amountCents,
      method: 'cash',
    });
  return invoiceId;
}

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

test('the customer’s record gains a Money tab: what they owe, their invoices and their payments', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'money-record', 'Lone Star Record HVAC');
  await moneySettings(owner);
  const personId = await person(owner, 'Robert', 'Chen');

  await invoiceFor(owner, {
    personId,
    title: 'Ductwork repair',
    amountCents: 255_188,
    dueOn: daysAgo(18),
  });
  await invoiceFor(owner, { personId, title: 'Spring tune-up', amountCents: 18_500, paid: true });

  await page.goto(`/app/w/${owner.workspaceId}/customers/people/${personId}`);
  // What they owe is said beside their name, before anyone opens a tab.
  await expect(page.getByTestId('record-owes')).toHaveText('Owes $2,551.88');

  await page.getByTestId('tab-money').click();
  const tab = page.getByTestId('record-money');
  await expect(tab.getByTestId('record-owed')).toHaveText('$2,551.88');
  await expect(tab).toContainText('Ductwork repair');
  await expect(tab).toContainText('Spring tune-up');
  await expect(tab).toContainText('$2,551.88 still owed');
  // The one that is late says so, in the same words the Money section uses.
  await expect(tab).toContainText('Overdue');
  // The cash that came in is on the same tab, not somewhere else.
  await expect(tab.getByTestId('record-payment')).toHaveCount(1);
  await expect(tab.getByTestId('record-payment')).toContainText('$185');

  // And the two ways to start something, both landing on this customer.
  await expect(tab.getByTestId('record-new-estimate')).toHaveAttribute(
    'href',
    new RegExp(`/money/estimates/new\\?person=${personId}$`),
  );
});

test('a lead’s Money card starts an estimate that arrives with the customer and the lead on it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'money-lead', 'Lone Star Lead HVAC');
  await moneySettings(owner);
  const personId = await person(owner, 'Maria', 'Lopez');
  const { leadId } = await api<{ leadId: string }>(owner.token, 'commands', 'lead.create', {
    workspaceId: owner.workspaceId,
    personId,
    title: 'New AC install',
    valueCents: 1_850_000,
  });

  await page.goto(`/app/w/${owner.workspaceId}/leads/${leadId}`);
  const card = page.getByTestId('lead-money');
  await expect(card).toContainText('Nothing quoted for this job yet');
  await card.getByTestId('lead-new-estimate').click();

  // The editor opens already knowing who it is for and which job it is.
  await expect(page).toHaveURL(new RegExp(`/money/estimates/new\\?lead=${leadId}`));
  await expect(page.getByText('Maria Lopez').first()).toBeVisible();
  await expect(page.getByTestId('document-title')).toHaveValue('New AC install');
  await expect(page.getByRole('link', { name: 'Open the lead' })).toBeVisible();

  // Once there is an estimate on the job, the card lists it instead of the empty words.
  const { estimateId } = await api<{ estimateId: string }>(
    owner.token,
    'commands',
    'estimate.create',
    {
      workspaceId: owner.workspaceId,
      personId,
      leadId,
      title: 'Building C rooftop units',
      lines: [
        {
          name: 'Rooftop unit',
          quantity: 1,
          unitLabel: 'each',
          unitPriceCents: 1_292_850,
          taxable: false,
        },
      ],
    },
  );
  expect(estimateId).toBeTruthy();
  await page.goto(`/app/w/${owner.workspaceId}/leads/${leadId}`);
  await expect(page.getByTestId('lead-estimate')).toContainText('Building C rooftop units');
  await expect(page.getByTestId('lead-estimate')).toContainText('$12,928.50');
});

test('a time held for a deposit says so on the calendar and in the sheet, then says what was paid', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const owner = await ownerWithSite(page, 'money-hold', 'Lone Star Hold HVAC');
  await moneySettings(owner);
  await connectAccount(owner, `acct_hold_${randomUUID().slice(0, 8)}`);
  const { serviceId } = await api<{ serviceId: string }>(
    owner.token,
    'commands',
    'service.create',
    {
      workspaceId: owner.workspaceId,
      name: 'Duct cleaning',
      durations: [180],
      priceCents: PRICE,
    },
  );
  const cal = await makeCalendar(owner, 'Duct cleaning', {
    services: { mode: 'one', items: [{ serviceId }] },
    payments: { mode: 'deposit' },
  });

  // A customer takes a time and stops on the payment page. The slot is theirs — for fifteen minutes.
  const customer = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const c = await customer.newPage();
  await c.goto(cal.path);
  const first = c.getByTestId('slot').first();
  await expect(first).toBeVisible();
  const picked = (await first.textContent())!.trim();
  await first.click();
  await c.getByRole('button', { name: `Continue with ${picked}` }).click();
  await expect(c.getByRole('heading', { name: 'Your details' })).toBeVisible();
  await c.getByLabel('Name', { exact: true }).fill('David Kim');
  await c.getByLabel('Mobile', { exact: true }).fill(randomPhone());
  await c.getByLabel('Email', { exact: true }).fill(`david-${randomUUID().slice(0, 6)}@hfos.test`);
  await c.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(c.getByTestId('deposit-step')).toBeVisible();

  // The business's calendar: the row is not a booking, and it says which and until when.
  const { items, timezone } = await api<{
    timezone: string;
    items: { id: string; startsAt: string; heldUntil: string | null }[];
  }>(owner.token, 'queries', 'appointment.list', {
    workspaceId: owner.workspaceId,
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  });
  expect(items).toHaveLength(1);
  const appointmentId = items[0]!.id;
  // The hold is in the answer the calendar reads, so every screen can tell a held time from a booked one.
  expect(items[0]!.heldUntil).toBeTruthy();
  // The day the visit is on, where the business is: the grid shows a week, not a fortnight.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(
    new Date(items[0]!.startsAt),
  );
  const onTheDay = `/app/w/${owner.workspaceId}/calendar?view=day&date=${day}&appt=${appointmentId}`;

  await page.goto(onTheDay);
  const block = page.getByTestId(`appt-${appointmentId}`);
  await expect(block).toHaveAttribute('data-held', 'true');
  await expect(block.getByTestId('appt-held')).toContainText('Not booked');

  // The sheet says it in words nobody has to decode, with the moment the hold runs out.
  const sheet = page.getByTestId('appointment-sheet');
  await expect(sheet.getByTestId('sheet-status')).toHaveText('Not booked yet');
  const held = sheet.getByTestId('visit-held');
  await expect(held).toContainText('Waiting on a deposit');
  await expect(held).toContainText('Held until');
  await expect(held).toContainText(`paying ${DEPOSIT} to book this time`);
  await expect(held).toContainText('Don’t call to confirm it');
  // Nothing on the sheet invites anyone to treat it as booked.
  await expect(sheet.getByTestId('sheet-mark-confirmed')).toHaveCount(0);
  await expect(sheet.getByTestId('sheet-invoice-visit')).toHaveCount(0);

  // The customer pays. The stand-in stands where Stripe's own fields would.
  await c.getByTestId('pay-deposit').click();
  await expect(c.getByTestId('fake-pay')).toBeVisible();
  await c.locator('#instrument').fill(CARD_OK.replace(/\s/g, ''));
  await c.getByTestId('fake-pay').click();
  await expect(c.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  await customer.close();

  // The same sheet now says the deposit was paid, and what is left for after the visit.
  await page.goto(onTheDay);
  await expect(sheet.getByTestId('sheet-status')).not.toHaveText('Not booked yet');
  const deposit = sheet.getByTestId('visit-deposit');
  await expect(deposit).toContainText('Deposit paid');
  await expect(deposit.getByTestId('visit-deposit-paid')).toHaveText(DEPOSIT);
  await expect(deposit.getByTestId('visit-deposit-after')).toHaveText(AFTER);
  await expect(page.getByTestId(`appt-${appointmentId}`)).not.toHaveAttribute('data-held', 'true');

  // "Invoice this visit" bills the balance, with the deposit already taken off.
  await sheet.getByTestId('sheet-invoice-visit').click();
  await expect(page).toHaveURL(/\/money\/invoices\//);
  await expect(page.getByTestId('document-title')).toHaveValue('Duct cleaning');
  await expect(page.getByTestId('document-lines')).toContainText('deposit already paid');
  await expect(page.getByTestId('document-lines')).toContainText(AFTER);
});

test('the inbox’s side panel says what this customer owes, and nothing when they owe nothing', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // The side panel is the widest column the inbox has: it shows from 1440 px.
  await page.setViewportSize({ width: 1600, height: 900 });
  const owner = await ownerWithSite(page, 'money-inbox', 'Lone Star Inbox HVAC');
  await moneySettings(owner);
  const owing = await person(owner, 'Kendra', 'Lee');
  const settled = await person(owner, 'Angela', 'Brooks');
  await invoiceFor(owner, {
    personId: owing,
    title: 'Furnace repair',
    amountCents: 131_383,
    dueOn: daysAgo(3),
  });
  await invoiceFor(owner, {
    personId: settled,
    title: 'AC tune-up',
    amountCents: 12_900,
    paid: true,
  });

  const conversationFor = async (personId: string) => {
    const { conversationId } = await api<{ conversationId: string }>(
      owner.token,
      'commands',
      'conversation.open',
      // Email, not text: a workspace with no live number can't open a text conversation.
      { workspaceId: owner.workspaceId, personId, channel: 'email' },
    );
    return conversationId;
  };

  await page.goto(`/app/w/${owner.workspaceId}/inbox/${await conversationFor(owing)}`);
  const owed = page.getByTestId('context-owed');
  await expect(owed).toContainText('$1,313.83');
  await expect(owed).toContainText('One invoice still to pay');
  await expect(owed).toContainText('past due');

  // Somebody who owes nothing gets no block at all — not an empty one.
  await page.goto(`/app/w/${owner.workspaceId}/inbox/${await conversationFor(settled)}`);
  await expect(page.getByTestId('context-panel')).toBeVisible();
  await expect(page.getByTestId('context-owed')).toHaveCount(0);
});

test('a member sees the money on the job they work, and no card at all on the one they don’t', async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const owner = await ownerWithSite(page, 'money-member', 'Lone Star Member HVAC');
  await moneySettings(owner);
  const cal = await makeCalendar(owner, 'Service calls');

  // A member joins the business through the emailed invitation, as anyone would.
  const mate = uniqueEmail('money-mate');
  const started = Date.now();
  await api(owner.token, 'commands', 'membership.invite', {
    workspaceId: owner.workspaceId,
    email: mate,
    role: 'member',
  });
  const mail = await waitForMail(mate, `invited you to ${owner.business}`, { after: started });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const mem = await ctx.newPage();
  await signUp(mem, { name: 'Priya Natarajan', email: mate });
  await confirmEmail(mem, mate);
  await mem.goto(link);
  await mem.getByTestId('accept-invite').click();
  await expect(mem).toHaveURL(new RegExp(`/app/w/${owner.workspaceId}`));
  const member = await signInOwner(mate);

  // Two visits: the member works the first, nobody but the owner works the second.
  const mine = await person(owner, 'Tom', 'Reyes');
  const theirs = await person(owner, 'Linda', 'Okafor');
  const book = async (personId: string, userId: string, title: string, hours: number) => {
    const { appointmentId } = await api<{ appointmentId: string }>(
      owner.token,
      'commands',
      'appointment.create',
      {
        workspaceId: owner.workspaceId,
        calendarId: cal.id,
        startsAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
        personId,
        userIds: [userId],
        title,
        acknowledgeWarnings: true,
        notify: false,
      },
    );
    const got = await api<{ appointment: { attendees: { id: string }[] } }>(
      owner.token,
      'queries',
      'appointment.get',
      { workspaceId: owner.workspaceId, appointmentId },
    );
    return got.appointment.attendees[0]!.id;
  };
  const myAttendee = await book(mine, member.userId, 'Rooftop check', 24);
  const otherAttendee = await book(theirs, owner.userId, 'Boiler service', 48);
  await invoiceFor(owner, {
    personId: mine,
    attendeeId: myAttendee,
    title: 'Rooftop check',
    amountCents: 42_000,
    dueOn: daysAgo(2),
  });
  await invoiceFor(owner, {
    personId: theirs,
    attendeeId: otherAttendee,
    title: 'Boiler service',
    amountCents: 98_000,
    dueOn: daysAgo(2),
  });

  // Their own job: the invoice is there, and so is what the customer owes.
  await mem.goto(`/app/w/${owner.workspaceId}/customers/people/${mine}`);
  await expect(mem.getByTestId('record-owes')).toHaveText('Owes $420');
  await mem.getByTestId('tab-money').click();
  await expect(mem.getByTestId('record-invoice')).toContainText('Rooftop check');
  // Billing is the owner's: a member is not offered it.
  await expect(mem.getByTestId('record-new-invoice')).toHaveCount(0);

  // The job they are not on: nothing, and no error where something would be.
  await mem.goto(`/app/w/${owner.workspaceId}/customers/people/${theirs}`);
  await expect(mem.getByTestId('record-name')).toHaveText('Linda Okafor');
  await expect(mem.getByTestId('record-owes')).toHaveCount(0);
  await mem.getByTestId('tab-money').click();
  await expect(mem.getByTestId('record-money')).toContainText('Nothing billed to Linda yet');
  await expect(mem.getByTestId('record-invoice')).toHaveCount(0);

  // The owner sees both, from the same page.
  await page.goto(`/app/w/${owner.workspaceId}/customers/people/${theirs}`);
  await page.getByTestId('tab-money').click();
  await expect(page.getByTestId('record-invoice')).toContainText('Boiler service');
  await ctx.close();
});
