import { expect, test } from '@playwright/test';
import { api } from './booking-helpers';
import { conversationFor, sentIn, teammateBusiness } from './ai-team';
import { textFromCustomer } from './telephony';

const CUSTOMER = '+17135550311';

/**
 * Coaching the AI teammate (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md), with the scripted model:
 * - Review lists what Ava sent on its own; a thumbs down saying why comes back as a rule, and Save rule puts it on
 *   Instructions, where it can be edited, and one added by hand can be deleted;
 * - in the test console, a thumbs down that only says what it should have said gets one quick question back,
 *   "Every customer" makes the rule, Not now drops it, and Retry with the fix runs the turn again.
 */
test('AI teammate feedback: Review, the rule it suggests, Instructions and the test console', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const b = await teammateBusiness(page, 'ai-feedback');
  await api(b.token, 'commands', 'ai_teammate.set_status', {
    workspaceId: b.workspaceId,
    teammateId: b.teammateId,
    status: 'automatic',
  });
  await textFromCustomer({ from: CUSTOMER, to: b.business, body: 'Can you come out Sunday?' });
  const conversationId = await conversationFor(b, CUSTOMER);
  const reply = await sentIn(b, conversationId, /\S/);

  // Review: what it sent on its own, not rated yet.
  await page.goto(`/app/w/${b.workspaceId}/ai-team`);
  await page.getByTestId('subnav-review').click();
  await expect(page).toHaveURL(/\/ai-team\/review$/);
  const item = page.getByTestId('review-item').first();
  await expect(item).toContainText('Can you come out Sunday?');
  await expect(item).toContainText(reply.slice(0, 20));
  await item.getByTestId('feedback-bad').click();
  await item.getByTestId('feedback-note').fill('We don’t work Sundays, offer Monday instead');
  await item.getByTestId('feedback-send').click();
  const suggestion = item.getByTestId('feedback-suggestion');
  await expect(suggestion).toContainText('We don’t work Sundays, offer Monday instead.', {
    timeout: 45_000,
  });
  await suggestion.getByTestId('feedback-save').click();
  await expect(item.getByTestId('feedback-saved')).toBeVisible();

  // Instructions: the saved rule, said to come from feedback; one added by hand, edited, then deleted.
  await page.getByTestId('subnav-instructions').click();
  const list = page.getByTestId('instructions');
  await expect(list).toContainText('We don’t work Sundays, offer Monday instead.');
  await expect(list).toContainText('From feedback');
  await page.getByTestId('instruction-new').fill('Always mention the 90-day warranty.');
  await page.getByTestId('instruction-add').click();
  await expect(list).toContainText('Always mention the 90-day warranty.');
  await expect(list).toContainText('2 of 50');
  await page.getByRole('button', { name: 'Edit instruction 2' }).click();
  await list.getByRole('textbox', { name: 'Instruction 2' }).fill('Mention the 90-day warranty.');
  await list.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(list).toContainText('Mention the 90-day warranty.');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete instruction 2' }).click();
  await expect(list).not.toContainText('90-day warranty');

  // The test console: only a better reply is unclear, so it asks first.
  await page.getByTestId('open-test-console').click();
  const console = page.getByTestId('test-console');
  await console.getByTestId('test-console-input').fill('Do you clean dryer vents?');
  await console.getByTestId('test-console-send').click();
  await console.getByTestId('feedback-bad').click();
  await console
    .getByTestId('feedback-better')
    .fill('Yes! Dryer vent cleaning takes about an hour.');
  await console.getByTestId('feedback-send').click();
  const question = console.getByTestId('feedback-question');
  await expect(question).toContainText('every customer, or just this one?', { timeout: 45_000 });
  await question.getByRole('button', { name: 'Every customer' }).click();
  const rule = console.getByTestId('feedback-suggestion');
  await expect(rule).toContainText('Yes! Dryer vent cleaning takes about an hour.', {
    timeout: 45_000,
  });
  await rule.getByRole('button', { name: 'Not now' }).click();
  await expect(console).toContainText('Not saved.');
  await console.getByTestId('feedback-retry').click();
  await expect(console.getByTestId('test-console-log')).toContainText(
    'Tried again with your feedback',
  );
  await expect(console.getByTestId('test-console-reply')).toHaveCount(1);
});
