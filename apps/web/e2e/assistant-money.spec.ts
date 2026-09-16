import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, consentToAssistant, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

const panel = (page: Page): Locator => page.getByTestId('assistant-panel');

/** Sends a question with Return and waits until its answer has finished streaming in. */
async function ask(page: Page, question: string): Promise<Locator> {
  const box = panel(page).getByRole('textbox', { name: 'Message the Assistant' });
  await box.fill(question);
  await box.press('Enter');
  await expect(panel(page).getByTestId('assistant-question').last()).toHaveText(question);
  const answer = panel(page).getByTestId('assistant-message').last();
  await expect(answer).toHaveAttribute('data-state', 'done');
  return answer;
}

const line = (name: string, cents: number) => ({
  productId: null,
  name,
  description: null,
  quantity: 1,
  unitLabel: 'each',
  unitPriceCents: cents,
  taxable: false,
  discountCents: 0,
});

/**
 * The Assistant's money answers, against the scripted stand-in model (global setup starts the worker with
 * ASSISTANT_PROVIDER=scripted): what the business is owed, drawn as a card built from real invoices, and a
 * cash payment that is written down only once the person says yes.
 *
 * Every figure on the card comes back from the person's own queries, so this checks the money that was
 * actually written rather than anything the model said.
 */
test('assistant-money: what we are owed, and a cash payment written down only on Confirm', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await signUpAndConfirm(page, 'assistant-money');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await consentToAssistant(owner.email);
  const { token } = await signInOwner(owner.email);
  await api(token, 'commands', 'money.save_settings', {
    workspaceId,
    settings: {
      tax: { rateBp: 0, name: 'No tax' },
      numbering: {
        estimate: { prefix: 'EST-', next: 1001 },
        invoice: { prefix: 'INV-', next: 1001 },
      },
    },
  });
  const { personId } = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Maria',
    lastName: 'Lopez',
    email: 'maria.lopez@example.test',
  });
  const { invoiceId } = await api<{ invoiceId: string }>(token, 'commands', 'invoice.create', {
    workspaceId,
    personId,
    title: 'AC replacement',
    lines: [line('3-ton AC system', 640_000)],
  });
  await api(token, 'commands', 'invoice.send', { workspaceId, invoiceId, channels: [] });

  // ---- what the business is owed, as a card built from the invoice itself ----
  await page.goto(`/app/w/${workspaceId}`);
  await page.getByTestId('ask-assistant').click();
  await expect(panel(page)).toBeVisible();
  let answer = await ask(page, 'What are we owed?');
  const card = answer.getByTestId('assistant-card-money');
  await expect(card.getByTestId('assistant-money-value')).toHaveText('$6,400');
  await expect(card).toContainText('INV-1001 · Maria Lopez');
  await expect(answer).toContainText('You are owed $6,400 across one invoice');

  // ---- money moved only on Confirm ----
  answer = await ask(page, `Record $6,400 cash on ${invoiceId}`);
  const confirm = answer.getByTestId('assistant-card-confirm');
  await expect(confirm).toContainText('Record $6,400');
  await expect(confirm).toContainText('This writes down money you have already taken');
  // Nothing yet: the invoice is still owed in full.
  let payments = await api<{ payments: unknown[] }>(token, 'queries', 'payment.list', {
    workspaceId,
    invoiceId,
  });
  expect(payments.payments).toHaveLength(0);

  await confirm.getByRole('button', { name: 'Record it' }).click();
  await expect(confirm.getByTestId('assistant-result')).toContainText('Recorded $6,400');
  payments = await api<{ payments: { amountCents: number; method: string }[] }>(
    token,
    'queries',
    'payment.list',
    { workspaceId, invoiceId },
  );
  expect(payments.payments[0]).toMatchObject({ amountCents: 640_000, method: 'cash' });

  // And it says so the next time it is asked, from the ledger rather than from the chat.
  answer = await ask(page, 'What are we owed?');
  await expect(answer).toContainText('Nothing is outstanding');
});
