/**
 * Lead intake (M14) as every business actually gets it: switched on.
 *
 * The specs next door turn it off, because they are about the conversation and a stranger who stays a
 * stranger is the shorter path to what they check. This one is the other half — the default — and it exists
 * because the two milestones meet here in a way neither one's own tests could see:
 *
 *   M14 makes a stranger who texts a customer with an open lead, and M8 folds that customer's waiting
 *   conversation into the lead's card so nothing shows twice. For the first fifteen minutes, before
 *   "Unanswered lead" takes over, that card is "No next action" — and a card offering to set a next action
 *   to somebody sitting there waiting for an answer is the opposite of what the Action Center is for.
 *
 * So: the card counts the wait, and the one press it offers is the answer they are waiting for.
 */
import { expect, test } from '@playwright/test';
import { actionCenterOwner, attentionList, type AcItem } from './action-center-helpers';
import { api } from './booking-helpers';
import { setUpTexting, textFromCustomer } from './telephony';

/** The chips a card carries; a folded wait arrives as `waiting` (core's attention/folding.ts). */
type Carded = AcItem & { readonly reasons?: readonly { readonly code: string }[] };

test('lead intake: a stranger who texts becomes a lead, and their card answers them', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // actionCenterOwner turns intake off for the specs that want a stranger; this one wants it on.
  const o = await actionCenterOwner(page, 'intake-on');
  for (const kind of ['text', 'call', 'email'] as const)
    await api(o.token, 'commands', 'intake_source.update', {
      workspaceId: o.workspaceId,
      kind,
      active: true,
    });
  const business = await setUpTexting(page, o.workspaceId);
  await api(o.token, 'commands', 'phone.update_settings', {
    workspaceId: o.workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
    unansweredReminderMinutes: 0,
  });

  const from = `+1713555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  await textFromCustomer({ from, to: business, body: 'My furnace is out. Can anyone come today?' });

  // One card, not two: the wait is a chip on the lead's card rather than a "Customer waiting" of its own.
  const carded = async () => {
    const items = (await attentionList(o)).items as Carded[];
    return items.find((i) => i.reasons?.some((r) => r.code === 'waiting')) ?? null;
  };
  await expect.poll(carded, { timeout: 60_000 }).not.toBeNull();
  const item = (await carded())!;
  expect(item.leadId).not.toBeNull();
  expect(item.conversationId).not.toBeNull();
  expect((await attentionList(o)).items).toHaveLength(1);

  // They are a customer and an open lead now, filed under the way they arrived.
  await page.goto(`/app/w/${o.workspaceId}/pipeline?view=list`);
  await expect(page.getByTestId('board-list')).toContainText('(713)');

  // Home: the card says how long they have been waiting, and its one press is the reply.
  await page.goto(`/app/w/${o.workspaceId}`);
  const card = page.locator('[data-testid="attention-card"]').first();
  await expect(card).toContainText(/Just now|Waiting \d+ min/);
  await expect(card.getByTestId('attention-handle')).toHaveText('Reply');
  await card.getByTestId('attention-handle').click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${item.conversationId}`));

  // Answering clears the wait. The lead's card stays — nobody has said what happens next — but it has
  // nothing left to say about the conversation.
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('We can be there this afternoon — what is the address?');
  await page.getByTestId('composer-send').click();
  await expect.poll(carded, { timeout: 60_000 }).toBeNull();
  await page.goto(`/app/w/${o.workspaceId}`);
  await expect(page.locator('[data-testid="attention-card"]').first()).toContainText(
    'No next action',
  );
});
