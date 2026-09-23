import { expect, test, type Locator, type Page } from '@playwright/test';
import { cardOnHome } from './action-center-helpers';
import { consentToAssistant } from './booking-helpers';
import { createBusiness, signIn, signUpAndConfirm } from './helpers';
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

/**
 * The Assistant against the scripted stand-in model (global setup starts the worker with
 * ASSISTANT_PROVIDER=scripted): the shortcut and the sidebar button, what needs attention, a task done at
 * once and taken back, a text to Mike that waits for Confirm and is delivered, a lead moved on Confirm (a
 * teammate's board follows) and left alone on Cancel, "via Assistant" in the audit log, and a past chat
 * reopened with its cards.
 */
test('assistant: ask, act at once, confirm before contacting or changing, audit and history', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await signUpAndConfirm(page, 'assistant-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await consentToAssistant(owner.email);
  await setUpTexting(page, workspaceId);
  // Tests text at any hour.
  await page.getByTestId('quiet-hours-switch').click();
  await expect(page.getByText('Quiet hours off')).toBeVisible();
  // The deal is moved by hand below, so the text sent to Mike mustn't move it first.
  await page.goto(`/app/w/${workspaceId}/settings/automations`);
  await page.getByTestId('automation-switch-pipeline_moves').click();
  await expect(page.getByText('Move deals along for you is off.')).toBeVisible();

  // Mike Johnson, with an open lead that has nothing planned next.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Mike');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Phone').fill('(713) 555-0142');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  const mikeUrl = page.url();
  await page.getByTestId('action-lead').click();
  await page.getByLabel('Title').fill('Roof replacement');
  await page.getByTestId('lead-save').click();
  await expect(page.getByTestId('open-lead-card')).toContainText('Roof replacement');

  // The shortcut (⌘J on a Mac, Ctrl+J elsewhere) opens and closes it; so does the sidebar button. Home lists
  // Mike's lead first (the worker files it as it comes in, with no next action).
  await page.goto(`/app/w/${workspaceId}`);
  await cardOnHome(page, workspaceId, 'Roof replacement');
  const button = page.getByTestId('ask-assistant');
  await expect(button).toHaveAttribute('aria-keyshortcuts', /^(Meta|Control)\+J$/);
  const keys = (await button.getAttribute('aria-keyshortcuts'))!.replace(/J$/, 'j');
  await page.keyboard.press(keys);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('assistant-empty')).toContainText('What can I help with?');
  await page.keyboard.press(keys);
  await expect(panel(page)).toHaveCount(0);
  await button.click();
  await expect(panel(page)).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'true');

  // What needs attention: the Action Center's list, with Mike's lead that has nothing planned next.
  let answer = await ask(page, 'What needs attention?');
  const attention = answer.getByTestId('assistant-card-attention');
  await expect(attention).toContainText('Mike Johnson · Roof replacement');
  await expect(attention).toContainText('No next action');

  // On Mike’s page it knows who he is. A task happens at once, shows in Tasks, and Undo takes it back.
  await page.goto(mikeUrl);
  await page.getByTestId('ask-assistant').click();
  await expect(panel(page).getByTestId('assistant-page')).toHaveText('On this page: Mike Johnson');
  answer = await ask(page, 'Create a task to call Mike back tomorrow');
  const done = answer.getByTestId('assistant-card-done');
  await expect(done).toContainText('Call Mike back');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Tasks' })
    .click();
  // Nobody was named, so it's on the asker's own list.
  await expect(
    page.getByTestId('tasks-page').locator('li', { hasText: 'Call Mike back' }),
  ).toContainText(owner.name);
  await done.getByRole('button', { name: 'Undo' }).click();
  await expect(done.getByTestId('assistant-result')).toHaveText('Undone. The task is gone.');
  await expect(page.getByTestId('tasks-page')).not.toContainText('Call Mike back');

  // "Text him" drafts a text to Mike that waits for Confirm; Confirm sends it and it arrives in his thread.
  await page.goto(mikeUrl);
  await page.getByTestId('ask-assistant').click();
  answer = await ask(page, 'Text him that we’re on the way');
  const text = answer.getByTestId('assistant-card-confirm');
  await expect(text).toContainText('Send this text to Mike?');
  await expect(text).toContainText('Mike Johnson');
  await expect(text).toContainText('We’re on the way');
  // Edit opens Mike’s message sheet with the draft in it; closing the sheet leaves the card waiting.
  await text.getByTestId('assistant-edit').click();
  const sheet = page.getByTestId('message-sheet');
  await expect(sheet.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'We’re on the way',
  );
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(text).toHaveAttribute('data-status', 'awaiting_confirmation');
  await text.getByTestId('assistant-confirm').click();
  await expect(text.getByTestId('assistant-result')).toContainText('Sent to Mike Johnson');
  // At 1280 px it would cover the conversation, so following its link closes it.
  await text.getByRole('link', { name: 'Open conversation' }).click();
  await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
  await expect(panel(page)).toHaveCount(0);
  const sent = page.getByTestId('message-log').locator('[data-direction="outbound"]').last();
  await expect(sent).toContainText('We’re on the way');
  await expect(sent).toHaveAttribute('data-status', 'delivered', { timeout: 20_000 });

  // On the inbox it lies over the page below 1600 px; from 1600 px it docks and the customer pane folds
  // away (Customer details still opens it).
  const customerPane = page.getByRole('complementary', { name: 'Customer', exact: true });
  await page.getByTestId('ask-assistant').click();
  await expect(panel(page)).toHaveAttribute('role', 'dialog');
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(panel(page)).toHaveAttribute('role', 'complementary');
  await expect(customerPane).toBeHidden();
  await expect(page.getByRole('button', { name: 'Customer details' })).toBeVisible();
  await page.getByTestId('ask-assistant').click();
  await expect(panel(page)).toHaveCount(0);
  await expect(customerPane).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 832 });

  // A teammate (the same owner on another device) watches the board.
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const watcher = await other.newPage();
  await signIn(watcher, owner.email);
  await watcher.goto(`/app/w/${workspaceId}/pipeline`);
  const card = watcher
    .getByTestId('stage-column-new')
    .locator('[data-testid^="lead-card-"]')
    .first();
  await expect(card).toContainText('Roof replacement');
  const leadId = (await card.getAttribute('data-testid'))!.replace('lead-card-', '');

  // On the lead’s page, "Move it to Contacted" waits for Confirm; then the lead and the board move.
  await page.goto(`/app/w/${workspaceId}/leads/${leadId}`);
  await page.getByTestId('ask-assistant').click();
  await expect(panel(page).getByTestId('assistant-page')).toHaveText(
    'On this page: Roof replacement',
  );
  answer = await ask(page, 'Move it to Contacted');
  const move = answer.getByTestId('assistant-card-confirm');
  await expect(move).toContainText('Move this lead?');
  await expect(move).toContainText('Roof replacement · Mike Johnson');
  await move.getByTestId('assistant-confirm').click();
  await expect(move.getByTestId('assistant-result')).toContainText('Moved to Contacted');
  await expect(page.getByTestId('stage-step-open-contacted')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(watcher.getByTestId('stage-column-contacted')).toContainText('Roof replacement');

  // Cancel changes nothing.
  answer = await ask(page, 'Move it to Estimate sent');
  const stay = answer.getByTestId('assistant-card-confirm');
  await expect(stay).toContainText('Estimate sent');
  await stay.getByTestId('assistant-cancel').click();
  await expect(stay.getByTestId('assistant-result')).toHaveText(
    'Not moved. It stays in Contacted.',
  );
  await expect(page.getByTestId('stage-step-open-contacted')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(watcher.getByTestId('stage-column-contacted')).toContainText('Roof replacement');
  await expect(watcher.getByTestId('stage-column-estimate-sent')).not.toContainText(
    'Roof replacement',
  );
  await other.close();

  // The audit log says what was done through the Assistant, and can show just that.
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(
    page.getByText('moved Roof replacement from New to Contacted via Assistant'),
  ).toBeVisible();
  await page.getByLabel('Filter by activity').selectOption('assistant');
  const audit = page.getByTestId('audit-log');
  await expect(audit.getByText('created the task Call Mike back via Assistant')).toBeVisible();
  await expect(audit.getByText('deleted the task Call Mike back via Assistant')).toBeVisible();
  await expect(audit.getByText(/sent a text to .+ via Assistant/).first()).toBeVisible();
  await expect(audit).not.toContainText('added Mike Johnson');

  // History: a new chat starts empty; the earlier one, renamed, reopens with its cards and where each stands.
  await page.getByTestId('ask-assistant').click();
  await expect(panel(page).getByTestId('assistant-question').first()).toHaveText(
    'What needs attention?',
  );
  await panel(page).getByRole('button', { name: 'New chat' }).click();
  await expect(panel(page).getByTestId('assistant-empty')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Your chats' }).click();
  const history = panel(page).getByTestId('assistant-history');
  await history.getByRole('button', { name: 'More for What needs attention?' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename chat' });
  await rename.getByLabel('Name').fill('Mike and the roof');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(rename).toHaveCount(0);
  await history.getByRole('button', { name: /^Mike and the roof/ }).click();
  await expect(panel(page).getByTestId('assistant-card-attention')).toBeVisible();
  const results = panel(page).getByTestId('assistant-result');
  await expect(results.filter({ hasText: 'Undone. The task is gone.' })).toHaveCount(1);
  await expect(results.filter({ hasText: 'Sent to Mike Johnson' })).toHaveCount(1);
  await expect(results.filter({ hasText: 'Moved to Contacted' })).toHaveCount(1);
  await expect(results.filter({ hasText: 'Not moved. It stays in Contacted.' })).toHaveCount(1);
});
