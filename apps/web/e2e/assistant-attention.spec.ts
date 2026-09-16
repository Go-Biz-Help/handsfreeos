import { expect, test, type Locator, type Page } from '@playwright/test';
import { cardOnHome } from './action-center-helpers';
import { api, consentToAssistant, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting } from './telephony';

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

/** The attention item ids of a list of rows, in order. */
const itemIds = (rows: Locator) =>
  rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-item')));

/** A customer, and a lead the owner types in for them with a value and no next action: it needs one. */
async function customerWithLead(
  page: Page,
  workspaceId: string,
  lead: { first: string; last: string; phone: string; title: string; value: string },
): Promise<void> {
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill(lead.first);
  await page.getByLabel('Last name').fill(lead.last);
  await page.getByLabel('Phone').fill(lead.phone);
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  await page.getByTestId('action-lead').click();
  await page.getByLabel('Title').fill(lead.title);
  await page.getByLabel('Value', { exact: true }).fill(lead.value);
  await page.getByTestId('lead-save').click();
  await expect(page.getByTestId('open-lead-card')).toContainText(lead.title);
}

/**
 * The Assistant on the Action Center, against the scripted stand-in model (global setup starts the worker with
 * ASSISTANT_PROVIDER=scripted): "What needs my attention?" shows Home's items in Home's order with "$ affected";
 * "Handle the first one" sets the suggested next action on Confirm; a snooze and a dismissal take their items
 * off Home. Quiet hours (off) and open hours (all week, all day) are set explicitly, so the list and its order are
 * the same at any hour.
 */
test('assistant-attention: the same list as Home, and items handled, snoozed and dismissed on Confirm', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await signUpAndConfirm(page, 'assistant-attention');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await consentToAssistant(owner.email);
  const { token } = await signInOwner(owner.email);
  // By default a business is open weekdays 8 to 5, and open-hours clocks would flip at night and on weekends.
  await api(token, 'commands', 'workspace.update', {
    workspaceId,
    settings: {
      openHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
    },
  });
  await setUpTexting(page, workspaceId);
  await page.getByTestId('quiet-hours-switch').click();
  await expect(page.getByText('Quiet hours off')).toBeVisible();

  // Three leads with nothing planned next; their values rank them.
  await customerWithLead(page, workspaceId, {
    first: 'Maria',
    last: 'Lopez',
    phone: '(713) 555-0181',
    title: 'New AC install',
    value: '18500',
  });
  await customerWithLead(page, workspaceId, {
    first: 'Kevin',
    last: 'Brooks',
    phone: '(713) 555-0182',
    title: 'Duct cleaning',
    value: '2400',
  });
  await customerWithLead(page, workspaceId, {
    first: 'Tom',
    last: 'Reyes',
    phone: '(713) 555-0183',
    title: 'Furnace repair',
    value: '900',
  });

  // Home lists all three as the worker files them.
  await page.goto(`/app/w/${workspaceId}`);
  await cardOnHome(page, workspaceId, 'Furnace repair');
  const cards = page.getByTestId('attention-card');
  await expect(cards).toHaveCount(3);
  const homeOrder = await itemIds(cards);
  await expect(cards.first()).toContainText('Maria Lopez');

  // The Assistant reads the same list: the same items in the same order, and the same "$ affected".
  await page.getByTestId('ask-assistant').click();
  let answer = await ask(page, 'What needs my attention?');
  await expect(answer).toContainText(
    '3 things need attention, $21,800 affected. First up: Maria Lopez · New AC install.',
  );
  const card = answer.getByTestId('assistant-card-attention');
  await expect(card.getByTestId('assistant-attention-affected')).toHaveText('$21,800 affected');
  const rows = card.locator('[data-item]');
  await expect(rows).toHaveCount(3);
  expect(await itemIds(rows)).toEqual(homeOrder);
  await expect(rows.first()).toContainText('No next action · $18,500');
  await expect(card.getByRole('link', { name: 'Open Home' })).toHaveAttribute(
    'href',
    `/app/w/${workspaceId}`,
  );

  // "Handle the first one": Maria's lead gets the suggested next action, only once it's confirmed.
  answer = await ask(page, 'Handle the first one');
  const handle = answer.getByTestId('assistant-card-confirm');
  await expect(handle).toContainText('Set a next action for Maria Lopez?');
  await expect(handle).toContainText('Follow up with Maria');
  await handle.getByTestId('assistant-confirm').click();
  await expect(handle.getByTestId('assistant-result')).toContainText(
    'Next action set: Follow up with Maria',
  );

  // Snooze one until tomorrow morning.
  answer = await ask(page, "Snooze Kevin's lead until tomorrow");
  const snooze = answer.getByTestId('assistant-card-confirm');
  await expect(snooze).toContainText(/Snooze Kevin Brooks until .+ at 8:00 AM\?/);
  await snooze.getByTestId('assistant-confirm').click();
  await expect(snooze.getByTestId('assistant-result')).toContainText('Snoozed until');

  // Dismiss the last, with the reason given.
  answer = await ask(page, 'Dismiss the Tom one, already handled');
  const dismiss = answer.getByTestId('assistant-card-confirm');
  await expect(dismiss).toContainText('Already handled');
  await dismiss.getByTestId('assistant-confirm').click();
  await expect(dismiss.getByTestId('assistant-result')).toContainText('Dismissed.');

  // Home agrees: nothing is left on the list.
  await page.goto(`/app/w/${workspaceId}`);
  await expect(page.getByTestId('attention-card')).toHaveCount(0);
  for (const id of homeOrder)
    await expect(page.locator(`[data-testid="attention-card"][data-item="${id}"]`)).toHaveCount(0);
});
