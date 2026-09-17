import { expect, test, type Page } from '@playwright/test';
import {
  actionCenterOwner,
  attentionList,
  cardOnHome,
  itemsFor,
  sweep,
  type AcItem,
  type AcOwner,
} from './action-center-helpers';
import { api } from './booking-helpers';

/**
 * The two money cards on Home (M9 step 12): an invoice nobody paid and an estimate nobody answered.
 *
 * What is under test is Chris's rule as much as the cards — **money never chases itself**. Both ask a person:
 * Handle opens the document, where the words are theirs, and Let HandsFreeOS Handle is refused in a sentence
 * anyone can read. The rest is the ordinary card: it is counted in "$ affected" (each job once, never twice),
 * it snoozes, it dismisses, and it clears itself the moment the money lands.
 *
 * The worker is nudged through the test routes rather than waited on, and open hours and quiet hours are pinned
 * by `actionCenterOwner`, so the spec reads the same at any hour of any day.
 */

const DAY = 86_400_000;
/** A local day `n` days from today, as the invoice's due day. */
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

const LINE = (name: string, cents: number) => ({
  productId: null,
  name,
  description: null,
  quantity: 1,
  unitLabel: 'each',
  unitPriceCents: cents,
  taxable: false,
  discountCents: 0,
});

/** The business's money settings: no tax, EST-/INV- from 1001, and no reminders to the customer at all. */
async function moneySettings(o: AcOwner): Promise<void> {
  await api(o.token, 'commands', 'money.save_settings', {
    workspaceId: o.workspaceId,
    settings: {
      tax: { rateBp: 0, name: 'Sales tax', newProductsTaxable: false },
      terms: 'net_14',
      estimateGoodForDays: 30,
      numbering: {
        estimate: { prefix: 'EST-', next: 1001, pad: 4 },
        invoice: { prefix: 'INV-', next: 1001, pad: 4 },
      },
      // The ladder a business agrees to when it sends an invoice is the only money message that goes out on
      // its own. Nothing in this spec is about those, so nobody is written to at all.
      reminders: { beforeDueDays: [], onDue: false, afterDueDays: [], estimateAfterDays: null },
    },
  });
}

const person = async (o: AcOwner, first: string, last: string): Promise<string> =>
  (
    await api<{ personId: string }>(o.token, 'commands', 'person.create', {
      workspaceId: o.workspaceId,
      firstName: first,
      lastName: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}.${Date.now()}@example.test`,
    })
  ).personId;

const lead = async (o: AcOwner, personId: string, title: string, valueCents: number) =>
  (
    await api<{ leadId: string }>(o.token, 'commands', 'lead.create', {
      workspaceId: o.workspaceId,
      personId,
      title,
      valueCents,
    })
  ).leadId;

/** An invoice written, given a due day and sent, so it is out there with money owed. */
async function sentInvoice(
  o: AcOwner,
  input: { personId: string; leadId?: string; title: string; cents: number; dueOn: string },
): Promise<{ invoiceId: string; number: string }> {
  const { invoiceId } = await api<{ invoiceId: string }>(o.token, 'commands', 'invoice.create', {
    workspaceId: o.workspaceId,
    personId: input.personId,
    ...(input.leadId ? { leadId: input.leadId } : {}),
    title: input.title,
    dueOn: input.dueOn,
    lines: [LINE(input.title, input.cents)],
  });
  const { number } = await api<{ number: string }>(o.token, 'commands', 'invoice.send', {
    workspaceId: o.workspaceId,
    invoiceId,
    // Issued without a message of its own: this business hands its invoices over in person, and the follow-up
    // on Home is the first thing anyone sends about it.
    channels: [],
  });
  return { invoiceId, number };
}

/** An estimate written and sent, waiting on the customer. */
async function sentEstimate(
  o: AcOwner,
  input: { personId: string; leadId: string; title: string; cents: number },
): Promise<{ estimateId: string; number: string }> {
  const { estimateId } = await api<{ estimateId: string }>(o.token, 'commands', 'estimate.create', {
    workspaceId: o.workspaceId,
    personId: input.personId,
    leadId: input.leadId,
    title: input.title,
    lines: [LINE(input.title, input.cents)],
  });
  const { number } = await api<{ number: string }>(o.token, 'commands', 'estimate.send', {
    workspaceId: o.workspaceId,
    estimateId,
    channels: [],
  });
  return { estimateId, number };
}

/** The list as Home reads it, with the counts under the headline (a snoozed item leaves `items`). */
const listOf = (o: AcOwner) =>
  api<{ items: AcItem[]; affectedCents: number; counts: { total: number; snoozed: number } }>(
    o.token,
    'queries',
    'attention.list',
    { workspaceId: o.workspaceId, scope: 'everyone' },
  );

/** Whether the list still has an open card about this document. */
const openFor = async (o: AcOwner, subjectId: string): Promise<boolean> =>
  (await listOf(o)).items.some((i) => i.subject.id === subjectId);

const kindCard = (page: Page, kind: string, text: string) =>
  page.locator(`[data-testid="attention-card"][data-kind="${kind}"]`).filter({ hasText: text });

test('Money on Home: an overdue invoice and a waiting estimate, and what each card does', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const o = await actionCenterOwner(page, 'money-attn');
  await moneySettings(o);

  // Maria: a $18,500 job with a $900 invoice on it, six days past due. Her lead is already on the list, so her
  // invoice must not count twice.
  const mariaId = await person(o, 'Maria', 'Lopez');
  const mariaLead = await lead(o, mariaId, 'New AC install', 1_850_000);
  const mariaInvoice = await sentInvoice(o, {
    personId: mariaId,
    leadId: mariaLead,
    title: 'Deposit · New AC install',
    cents: 90_000,
    dueOn: day(-6),
  });
  // Linda: an invoice with no lead behind it. It is the only money on the list that is its own.
  const lindaId = await person(o, 'Linda', 'Okafor');
  const lindaInvoice = await sentInvoice(o, {
    personId: lindaId,
    title: 'Ductwork repair',
    cents: 124_000,
    dueOn: day(-4),
  });
  // Tom: a quote out and unanswered. His lead was on the list as "No next action" first.
  const tomId = await person(o, 'Tom', 'Reyes');
  const tomLead = await lead(o, tomId, 'Building C rooftop units', 1_240_000);
  await itemsFor(o, ['Building C rooftop units']);
  const tomEstimate = await sentEstimate(o, {
    personId: tomId,
    leadId: tomLead,
    title: 'Rooftop unit replacement',
    cents: 1_292_850,
  });

  // The invoices are late already, so the worker opens their cards from the documents' own events.
  await itemsFor(o, [mariaInvoice.number, lindaInvoice.number]);
  // And while a quote of Tom's is out, his lead stands down: the estimate is the more exact thing to say, so he
  // has one card, not two. Waiting for that also proves the worker has finished with the estimate's own events.
  await expect
    .poll(async () => (await attentionList(o)).items.some((i) => i.leadId === tomLead))
    .toBe(false);

  // An estimate waits five days before it asks anyone, so the sweep runs as of next week to open Tom's card.
  await sweep(o.workspaceId, new Date(Date.now() + 6 * DAY).toISOString());
  await expect
    .poll(async () => (await attentionList(o)).items.filter((i) => i.kind === 'estimate_waiting'))
    .toHaveLength(1);

  await page.goto(`/app/w/${o.workspaceId}`);
  // "$ affected": Maria's job once at its own value, plus Linda's invoice, which is its own money. Counting
  // Maria's $900 invoice on top of her job would read $20,640, and the quote stays out until it's approved.
  await expect(page.getByTestId('attention-affected')).toHaveText('$19,740 affected');
  await expect(page.getByTestId('attention-card')).toHaveCount(4);

  // The overdue invoice: what is owed, how late it is, and that they never opened it.
  const linda = kindCard(page, 'invoice_overdue', 'Linda Okafor');
  await expect(linda.getByTestId('attention-title')).toHaveText(
    `Linda Okafor · Ductwork repair · ${lindaInvoice.number}`,
  );
  await expect(linda).toContainText('Invoice overdue');
  await expect(linda.getByTestId('attention-chip').first()).toHaveText('$1,240 owed');
  // Lateness counts from the end of the due day, wherever the reader is: a due day ends in Houston, not in UTC.
  await expect(linda.getByTestId('attention-chip').nth(1)).toHaveText(/^\d+ days? overdue$/);
  await expect(linda).toContainText('due');

  // Handled in one press, like every other kind: it reaches the customer the way that suits them, with the
  // follow-up already written. Nobody here can be rung, so it is an email.
  await expect(linda.getByTestId('attention-handle')).toHaveText('Email Linda');
  await linda.getByTestId('attention-handle').click();
  const composer = page.getByTestId('message-sheet');
  await expect(composer).toBeVisible();
  const draft = composer.getByRole('textbox', { name: 'Message' });
  // The document read back in the business's own words, for a person to send, change or throw away.
  await expect(composer.getByTestId('composer-subject')).toHaveValue(
    `Following up on invoice ${lindaInvoice.number}`,
  );
  await expect(draft).toHaveValue(new RegExp(`invoice ${lindaInvoice.number}`));
  await expect(draft).toHaveValue(/\$1,240/);
  await expect(draft).toHaveValue(/The payment link we sent still works/);
  await page.keyboard.press('Escape');

  // Let HandsFreeOS Handle is the same follow-up, with what the customer has already had said plainly. It is
  // never sent for them: the sheet asks first, as it does for a hot lead.
  await linda.getByTestId('attention-let-handle').click();
  const sheet = page.getByTestId('let-handle-sheet');
  await expect(sheet).toHaveAttribute('data-mode', 'ask');
  await expect(sheet).toContainText('Asks first');
  await expect(sheet.getByTestId('let-handle-title')).toHaveText('Follow up with Linda Okafor');
  await expect(sheet.getByLabel('Message')).toHaveValue(
    new RegExp(`invoice ${lindaInvoice.number}`),
  );
  // Never the AI teammate: a bill is not a conversation to hand over.
  await expect(sheet).not.toContainText('Hand to');
  await expect(sheet.getByTestId('let-handle-confirm')).toHaveText('Send');
  await page.keyboard.press('Escape');

  // The document is one press away, where the canvas puts it: in the card's ⋯ menu.
  await linda.getByTestId('attention-more').click();
  await expect(page.getByTestId('attention-open')).toHaveText('Open the invoice');
  await page.getByTestId('attention-open').click();
  await expect(page).toHaveURL(new RegExp(`/money/invoices/${lindaInvoice.invoiceId}$`));
  await expect(page.getByRole('heading', { name: lindaInvoice.number })).toBeVisible();

  // The estimate: what was quoted, how long it is good for, and its own follow-up.
  await page.goto(`/app/w/${o.workspaceId}`);
  const tom = kindCard(page, 'estimate_waiting', 'Tom Reyes');
  await expect(tom.getByTestId('attention-title')).toHaveText(
    `Tom Reyes · Rooftop unit replacement · ${tomEstimate.number}`,
  );
  await expect(tom.getByTestId('attention-chip').first()).toHaveText('$12,928.50 quoted');
  await expect(tom).toContainText('good until');
  await expect(tom.getByTestId('attention-handle')).toHaveText('Email Tom');
  await tom.getByTestId('attention-handle').click();
  await expect(page.getByTestId('message-sheet')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
    new RegExp(`estimate ${tomEstimate.number}`),
  );
  await page.keyboard.press('Escape');

  // Back on Home: money cards snooze and dismiss like every other kind.
  await page.goto(`/app/w/${o.workspaceId}`);
  await kindCard(page, 'estimate_waiting', 'Tom Reyes').getByTestId('attention-more').click();
  await page.getByTestId('snooze-hour').click();
  await expect(kindCard(page, 'estimate_waiting', 'Tom Reyes')).toHaveCount(0);
  // An hour from late evening is tomorrow: "Snoozed until tomorrow at 12:47 AM".
  await expect(page.getByText(/^Snoozed until (tomorrow at )?\d{1,2}:\d{2} [AP]M$/)).toBeVisible();
  const snoozed = await listOf(o);
  expect(snoozed.items.some((i) => i.subject.id === tomEstimate.estimateId)).toBe(false);
  expect(snoozed.counts.snoozed).toBe(1);

  const maria = kindCard(page, 'invoice_overdue', 'Maria Lopez');
  await maria.getByTestId('attention-more').click();
  await page.getByTestId('attention-dismiss').click();
  await page.getByTestId('dismiss-confirm').click();
  await expect(maria).toHaveCount(0);
  await expect(page.getByText('Dismissed. It comes back if something changes.')).toBeVisible();
  expect(await openFor(o, mariaInvoice.invoiceId)).toBe(false);

  // And the money itself clears the card: Linda pays in full, and hers goes.
  await api(o.token, 'commands', 'invoice.record_cash_payment', {
    workspaceId: o.workspaceId,
    invoiceId: lindaInvoice.invoiceId,
    amountCents: 124_000,
    method: 'check',
  });
  await cardOnHome(page, o.workspaceId, 'Linda Okafor', { gone: true });
  await expect(page.getByTestId('attention-affected')).toHaveText('$18,500 affected');
  expect(await openFor(o, lindaInvoice.invoiceId)).toBe(false);
});
