import { expect, test } from '@playwright/test';
import {
  actionCenterOwner,
  addLead,
  attentionList,
  BUSINESS,
  cardOf,
  itemsFor,
} from './action-center-helpers';
import { conversationFor } from './ai-team';
import { api } from './booking-helpers';
import { addTeammate } from './calendar';
import { setUpTexting, textFromCustomer } from './telephony';

const KENDRA = '+17135550166';

/**
 * Home as the Action Center: leads a person typed in with no next action open "No next action" items, ranked
 * with the $40,000 lead first and "$X affected" counting real values once (a lead with no value stands in the
 * typical job value, "About $500", and isn't counted). An owner starts on Everyone; a teammate's lead leaves
 * when they switch to Mine, and the teammate, a member, starts on Mine. A new lead's card arrives live.
 */
test('the Action Center: ranking and the header, Mine and Everyone, a new lead live', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const o = await actionCenterOwner(page, 'ac-rank');
  const priya = await addTeammate(page, browser, o.workspaceId, BUSINESS);
  const { members } = await api<{ members: { userId: string; email: string }[] }>(
    o.token,
    'queries',
    'workspace.members',
    { workspaceId: o.workspaceId },
  );
  const priyaId = members.find((m) => m.email === priya.email)!.userId;

  await addLead(o, 'Maria', 'Lopez', 'New AC install', 4_000_000);
  await addLead(o, 'Tom', 'Reyes', 'Rooftop unit repair', 50_000);
  await addLead(o, 'Carlos', 'Mendoza', 'Roof leak repair', 0);
  await addLead(o, 'Kendra', 'Lee', 'Furnace check', 120_000, { assigneeUserId: priyaId });
  await itemsFor(o, ['New AC install', 'Rooftop unit repair', 'Roof leak repair', 'Furnace check']);

  await page.goto(`/app/w/${o.workspaceId}`);
  const center = page.getByTestId('action-center');
  await expect(center).toHaveAttribute('data-scope', 'everyone');
  await expect(page.getByTestId('attention-affected')).toHaveText('$41,700 affected');
  await expect(page.getByTestId('attention-counts')).toHaveText(
    '4 need attention · 0 handled today',
  );
  const cards = page.getByTestId('attention-card');
  await expect(cards).toHaveCount(4);
  // The $40,000 lead ranks first, its chips say why, and nobody has it yet.
  const maria = cards.first();
  await expect(maria.getByTestId('attention-title')).toHaveText('Maria Lopez · New AC install');
  await expect(maria).toContainText('No next action');
  await expect(maria.getByTestId('attention-chip').first()).toHaveText('$40,000');
  await expect(maria.getByRole('img', { name: 'Unassigned' })).toBeVisible();
  await expect(maria.getByTestId('attention-handle')).toHaveText('Set next action');
  // A lead with no value shows the typical job value, and it isn't in "$ affected".
  await expect(cardOf(page, 'Carlos Mendoza').getByTestId('attention-chip').first()).toHaveText(
    'About $500',
  );
  const kendra = cardOf(page, 'Kendra Lee');
  await expect(kendra.getByRole('img', { name: 'Assigned to Priya Natarajan' })).toBeVisible();
  // Nothing is urgent: no Urgent section, and no badge on Home.
  await expect(page.getByTestId('attention-urgent')).toHaveCount(0);
  await expect(page.getByTestId('urgent-badge')).toHaveCount(0);
  // Today sits beside the list on a desk.
  await expect(page.getByTestId('today-card')).toBeVisible();
  await expect(page.getByTestId('coming-up')).toContainText('Nothing planned right now.');

  // Mine: the owner's own and the unassigned ones. Priya's lead leaves, and so do its dollars.
  await page.getByTestId('scope-mine').click();
  await expect(center).toHaveAttribute('data-scope', 'mine');
  await expect(kendra).toHaveCount(0);
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId('attention-affected')).toHaveText('$40,500 affected');
  const mine = await attentionList(o, 'mine');
  expect(mine.items.map((i) => i.title).sort()).toEqual([
    'Carlos Mendoza · Roof leak repair',
    'Maria Lopez · New AC install',
    'Tom Reyes · Rooftop unit repair',
  ]);

  // Priya is a member: she starts on Mine, which has her lead and the unassigned ones.
  await priya.page.goto(`/app/w/${o.workspaceId}`);
  await expect(priya.page.getByTestId('action-center')).toHaveAttribute('data-scope', 'mine');
  await expect(priya.page.getByTestId('attention-card')).toHaveCount(4);
  await priya.context.close();

  // A new lead: the worker opens its item and Home follows, without a reload.
  await page.getByTestId('scope-everyone').click();
  await expect(cards).toHaveCount(4);
  // Give the private channel a moment to join before the lead arrives.
  await page.waitForTimeout(1500);
  await addLead(o, 'Angela', 'Brooks', 'Attic insulation', 240_000);
  // Once the worker has opened the item, the open page shows it well inside its own 30-second re-read: what
  // arrives here is the live change, not a refresh.
  await itemsFor(o, ['Attic insulation']);
  await expect(cardOf(page, 'Angela Brooks')).toBeVisible({ timeout: 12_000 });
  await expect(page.getByTestId('attention-affected')).toHaveText('$44,100 affected');
});

/**
 * The card's ⋯: Snooze for an hour and Undo; Dismiss with a reason and Undo; Assign to a teammate, who becomes the
 * lead's owner too, and Undo. Then Let HandsFreeOS Handle on a lead with no next action asks first: it suggests
 * one ("Follow up with Sarah"), adds it on Confirm, and the card goes.
 */
test('the Action Center: snooze, dismiss and assign with Undo, and an ask-first handle', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const o = await actionCenterOwner(page, 'ac-actions');
  const priya = await addTeammate(page, browser, o.workspaceId, BUSINESS);
  await priya.context.close();
  const { members } = await api<{ members: { userId: string; email: string }[] }>(
    o.token,
    'queries',
    'workspace.members',
    { workspaceId: o.workspaceId },
  );
  const priyaId = members.find((m) => m.email === priya.email)!.userId;
  const tomLead = await addLead(o, 'Tom', 'Reyes', 'Rooftop unit replacement', 1_240_000);
  const sarahLead = await addLead(o, 'Sarah', 'Alvarez', 'Water heater replacement', 340_000);
  await itemsFor(o, ['Rooftop unit replacement', 'Water heater replacement']);

  await page.goto(`/app/w/${o.workspaceId}`);
  const tom = cardOf(page, 'Tom Reyes');
  const undo = page.getByRole('button', { name: 'Undo' });

  // Snooze for an hour: it leaves the list; Undo brings it back.
  await tom.getByTestId('attention-more').click();
  await expect(page.getByTestId('attention-menu')).toContainText('Tomorrow morning');
  await page.getByTestId('snooze-hour').click();
  await expect(tom).toHaveCount(0);
  await expect(page.getByText(/^Snoozed until \d{1,2}:\d{2} [AP]M$/)).toBeVisible();
  await undo.click();
  await expect(tom).toBeVisible();
  await expect
    .poll(async () => (await attentionList(o)).items.some((i) => i.title.includes('Tom Reyes')))
    .toBe(true);

  // Dismiss asks why (it's optional), then it's gone until something changes; Undo brings it back.
  await tom.getByTestId('attention-more').click();
  await page.getByTestId('attention-dismiss').click();
  const dialog = page.getByTestId('dismiss-dialog');
  await expect(dialog).toContainText('It stays off the list until something changes');
  await dialog.getByRole('radio', { name: 'Not a real lead' }).click();
  await page.getByTestId('dismiss-confirm').click();
  await expect(tom).toHaveCount(0);
  await expect(page.getByText('Dismissed. It comes back if something changes.')).toBeVisible();
  await expect
    .poll(async () => (await attentionList(o)).items.some((i) => i.title.includes('Tom Reyes')))
    .toBe(false);
  await undo.click();
  await expect(tom).toBeVisible();

  // Assign to Priya: the lead is hers too. Undo gives it back to nobody.
  await tom.getByTestId('attention-more').click();
  await page.getByTestId('attention-assign').click();
  await expect(page.getByTestId('assign-menu')).toContainText(
    'This makes them the lead’s owner too.',
  );
  await page.getByTestId(`assign-${priyaId}`).click();
  await expect(page.getByText('Assigned to Priya. Priya is now the lead’s owner.')).toBeVisible();
  await expect(tom.getByRole('img', { name: 'Assigned to Priya Natarajan' })).toBeVisible();
  const assigned = await api<{ lead: { assignee: { id: string } | null } }>(
    o.token,
    'queries',
    'lead.get',
    { workspaceId: o.workspaceId, leadId: tomLead.leadId },
  );
  expect(assigned.lead.assignee?.id).toBe(priyaId);
  await undo.click();
  await expect(tom.getByRole('img', { name: 'Unassigned' })).toBeVisible();

  // Let HandsFreeOS Handle asks first here: it suggests a next action and adds it once you say yes.
  const sarah = cardOf(page, 'Sarah Alvarez');
  await sarah.getByTestId('attention-let-handle').click();
  const sheet = page.getByTestId('let-handle-sheet');
  await expect(sheet).toHaveAttribute('data-mode', 'ask');
  await expect(sheet).toContainText('Asks first');
  await expect(sheet.getByTestId('let-handle-title')).toHaveText(
    'Set a next action for Sarah Alvarez',
  );
  await expect(sheet.getByLabel('Next action')).toHaveValue('Follow up with Sarah');
  await sheet.getByTestId('let-handle-confirm').click();
  await expect(page.getByText('Next action set.')).toBeVisible();
  await expect(sarah).toHaveCount(0);
  const planned = await api<{ lead: { nextAction: string | null } }>(
    o.token,
    'queries',
    'lead.get',
    { workspaceId: o.workspaceId, leadId: sarahLead.leadId },
  );
  expect(planned.lead.nextAction).toBe('Follow up with Sarah');
  await expect
    .poll(async () => (await attentionList(o)).items.some((i) => i.title.includes('Sarah Alvarez')))
    .toBe(false);
});

/**
 * A customer who texts in: with the reply threshold at zero they are waiting the moment their text lands, so the
 * "Customer waiting" card opens at once, with the channel it would answer on. Reply opens their conversation.
 */
test('the Action Center: a customer waiting, and Reply opens their conversation', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const o = await actionCenterOwner(page, 'ac-waiting');
  const business = await setUpTexting(page, o.workspaceId);
  await api(o.token, 'commands', 'phone.update_settings', {
    workspaceId: o.workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
    unansweredReminderMinutes: 0,
  });
  await textFromCustomer({
    from: KENDRA,
    to: business,
    body: 'The furnace is clicking again. Can someone come out today?',
  });
  const conversationId = await conversationFor(o, KENDRA);
  await expect
    .poll(async () => (await attentionList(o)).items.some((i) => i.kind === 'customer_waiting'), {
      timeout: 30_000,
    })
    .toBe(true);

  await page.goto(`/app/w/${o.workspaceId}`);
  const waiting = page.locator('[data-testid="attention-card"][data-kind="customer_waiting"]');
  await expect(waiting).toContainText('Customer waiting');
  await expect(waiting.getByTestId('attention-handle')).toHaveText('Reply');
  await waiting.getByTestId('attention-handle').click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${conversationId}`));
});
