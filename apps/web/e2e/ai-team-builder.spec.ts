import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The AI teammate area: "AI teammate" in the drawer after Knowledge, a preset (labels follow the pick), the
 * builder's modules with their one-line summaries, a red item fixed with Fix (and undone), Undo, Save,
 * turning it on, "Switch to automatic now" and "Back to training" (each confirmed), History with Restore
 * (training progress stays), the test console (a price question answered from the knowledge base, held as
 * a draft while in training wheels, and nothing sent; then a test call that picks up and hangs up on a goodbye)
 * and the Activity tab.
 *
 * Quiet hours are set explicitly (8 PM to 8 AM) so the Hours module's note never depends on the default.
 */
test('AI teammate: a preset, the modules, Fix, the status override, history and the test console', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'ai-team-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const { token } = await signInOwner(email);
  await api(token, 'commands', 'phone.update_settings', {
    workspaceId,
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
  });
  // One published answer for the test console to find. No amount in it, so prices can stay off.
  const faq = 'How much does a tune-up cost?';
  await api(token, 'commands', 'knowledge_item.create', {
    workspaceId,
    content: {
      kind: 'faq',
      question: faq,
      answer:
        'Tune-ups are priced by the size of your system, and we confirm the price before any work starts.',
    },
    status: 'published',
  });

  // In the drawer after Knowledge. With no teammate yet: "How should your AI teammate work?"
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  const links = await nav.getByRole('link').allTextContents();
  expect(links.indexOf('AI teammate')).toBe(links.indexOf('Knowledge') + 1);
  await nav.getByRole('link', { name: 'AI teammate' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/ai-team$`));
  await expect(
    page.getByRole('heading', { name: 'How should your AI teammate work?' }),
  ).toBeVisible();

  // Blank means blank: nothing turned on, so no labels yet.
  const blank = page.getByTestId('teammate-preset-blank');
  await blank.click();
  await expect(blank).toContainText('Nothing turned on.');
  await expect(blank).toContainText('Turns on: nothing yet');
  await expect(page.getByText('No labels until a skill is on')).toBeVisible();

  // Presets only turn skills on: the labels follow the pick.
  const presetLabels = page.getByTestId('teammate-preset-labels').locator('span');
  await page.getByTestId('teammate-preset-appointment_coordinator').click();
  await expect(presetLabels).toHaveText(['Appointment Coordinator', 'Follows up']);
  await page.getByTestId('teammate-preset-lead_qualifier').click();
  await expect(presetLabels).toHaveText(['Lead Qualifier', 'Follows up']);
  // "Only when asked" explains the California rule; either way it never claims to be a person.
  await page.getByTestId('teammate-disclosure-when_asked').click();
  await expect(page.getByText('California law.')).toBeVisible();
  await page.getByTestId('teammate-disclosure-first_message').click();
  await page.getByTestId('teammate-name-input').fill('Ava');
  await page.getByTestId('teammate-create').click();

  // The builder: off until someone turns it on, labelled from its skills.
  await expect(page.getByTestId('teammate-builder')).toBeVisible();
  await expect(page.getByTestId('teammate-name')).toHaveText('Ava');
  await expect(page.getByTestId('teammate-status')).toHaveText('Off');
  await expect(page.getByTestId('teammate-revision')).toContainText('Revision 1');
  const labels = page.getByTestId('teammate-labels').locator('span');
  await expect(labels).toHaveText(['Lead Qualifier', 'Follows up']);
  await expect(page.getByTestId('module-summary-qualify')).toContainText('questions');

  // Identity: the name follows as it's typed, and Undo takes it back.
  await page.getByTestId('identity-name').fill('Max');
  await expect(page.getByTestId('teammate-name')).toHaveText('Max');
  await expect(page.getByTestId('module-summary-identity')).toHaveText('Max · says it’s AI first');
  await expect(page.getByTestId('teammate-save-note')).toHaveText('Unsaved changes');
  await page.getByTestId('teammate-undo').click();
  await expect(page.getByTestId('teammate-name')).toHaveText('Ava');

  // Qualify: with no questions left it can't be turned on, and Fix brings suggested ones back.
  await page.getByTestId('module-qualify').click();
  const questions = page.getByTestId('qualify-questions').locator('li');
  const count = await questions.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await page.getByTestId('question-1-remove').click();
  await expect(questions).toHaveCount(0);
  const noQuestions = page.getByTestId('issue-no_qualifying_questions');
  await expect(noQuestions).toContainText('Qualifying needs questions');
  await expect(noQuestions).toContainText('Blocks turning it on');
  await expect(page.getByTestId('status-training')).toBeDisabled();
  await page.getByTestId('fix-no_qualifying_questions-add_suggested').click();
  await expect(noQuestions).toHaveCount(0);
  await expect(page.getByTestId('teammate-last-fix')).toContainText('Add suggested questions');
  await expect(questions).toHaveCount(count);
  await page.getByTestId('teammate-undo-fix').click();
  await expect(noQuestions).toBeVisible();
  await page.getByTestId('fix-no_qualifying_questions-add_suggested').click();
  await expect(questions).toHaveCount(count);

  // A choice added to a question, one that rules a lead out, and who hears about qualified leads.
  const choice = page.locator('[data-testid^="question-"][data-testid$="-kind"]');
  const choiceIndex = (await choice.evaluateAll((els) =>
    els.findIndex((el) => (el as HTMLSelectElement).value === 'choice'),
  )) as number;
  expect(choiceIndex).toBeGreaterThanOrEqual(0);
  const n = choiceIndex + 1;
  await page.getByTestId(`question-${n}-add-choice`).click();
  await page.getByTestId(`question-${n}-add-choice-input`).fill('Next spring');
  await page.getByTestId(`question-${n}-add-choice-input`).press('Enter');
  await page.getByTestId(`question-${n}-add-choice-input`).press('Escape');
  await expect(page.getByTestId(`question-${n}`)).toContainText('Next spring');
  await page.getByTestId(`question-${n}-not-a-fit`).click();
  await page.getByRole('menuitem', { name: 'Next spring' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`question-${n}`)).toContainText('When an answer rules them out');
  await page.getByTestId('qualify-notify').selectOption('admins');
  const how = page.getByTestId('teammate-how');
  await expect(how).toContainText('tells owners and admins');
  // Then it offers times (once Book is on), and tells the team about a lead that isn't a fit.
  await expect(page.getByTestId('qualify-offer-times')).toBeChecked();
  await expect(page.getByTestId('qualify-when-qualified')).toContainText('Only while Book is on.');
  await expect(how).toContainText('Tells the team when a lead isn’t a fit');
  await page.getByTestId('qualify-tell-team').click();
  await expect(how).not.toContainText('Tells the team when a lead isn’t a fit');
  await page.getByTestId('qualify-tell-team').click();
  await expect(page.getByTestId('qualify-tell-team')).toBeChecked();
  await page.getByTestId('teammate-save').click();
  await expect(page.getByText(/^Saved as revision 2\./)).toBeVisible();
  await expect(page.getByTestId('teammate-save-note')).toHaveText('All changes saved · revision 2');
  await expect(page.getByTestId('teammate-revision')).toContainText('Revision 2');

  // Hours: its own hours sit beside quiet hours, which apply to texts.
  await page.getByTestId('module-hours').click();
  await page.getByTestId('hours-custom').click();
  await expect(page.getByTestId('teammate-hours-editor')).toBeVisible();
  await expect(page.getByText('Quiet hours, 8:00 PM to 8:00 AM.')).toBeVisible();
  await page.getByTestId('hours-always').click();

  // Autonomy: one approval fewer before it works on its own.
  await page.getByTestId('module-autonomy').click();
  await page.getByRole('button', { name: 'Less (Approvals needed)' }).click();
  await expect(page.getByTestId('module-summary-autonomy')).toHaveText('19 approvals · 2 h drafts');
  await page.getByTestId('teammate-save').click();
  await expect(page.getByTestId('teammate-save-note')).toHaveText('All changes saved · revision 3');

  // Limits: its part of today's AI use under its share, and prices as Knowledge sets them.
  await page.getByTestId('module-limits').click();
  await expect(page.getByTestId('limits-usage')).toContainText('Today so far: Ava');
  await expect(page.getByTestId('limits-prices')).toHaveText('Off');

  // On, with training wheels; then automatic now, and back to training (both confirmed).
  await page.getByTestId('status-training').click();
  await expect(page.getByTestId('teammate-status')).toHaveText('Training wheels');
  await expect(page.getByTestId('teammate-status-card')).toContainText(
    '0 of 19 approved · 0 edited',
  );
  await page.getByTestId('switch-automatic').click();
  await expect(page.getByRole('dialog')).toContainText('before it reaches 19 approvals');
  await page.getByTestId('status-confirm').click();
  await expect(page.getByTestId('teammate-status')).toHaveText('Automatic');
  await page.getByTestId('back-to-training').click();
  await expect(page.getByRole('dialog')).toContainText('starts again at 0 of 19');
  await page.getByTestId('status-confirm').click();
  await expect(page.getByTestId('teammate-status')).toHaveText('Training wheels');

  // History: every save is kept; restoring revision 2 saves it again as revision 4, status untouched.
  await page.getByTestId('open-history').click();
  const history = page.getByTestId('teammate-history');
  await expect(history.locator('li')).toHaveCount(3);
  await expect(history.getByTestId('revision-3')).toContainText('Current');
  await history.getByTestId('restore-2').click();
  await expect(page.getByText(/^Restored revision 2 as revision 4\./)).toBeVisible();
  await expect(page.getByTestId('teammate-revision')).toContainText('Revision 4');
  await expect(page.getByTestId('module-summary-autonomy')).toHaveText('20 approvals · 2 h drafts');
  await expect(page.getByTestId('teammate-status')).toHaveText('Training wheels');

  // The test console: Ava answers the price question from the knowledge base, streamed in, and shows
  // what she looked up and the check the reply passed. In training wheels a real reply would wait for an
  // OK; here nothing is sent at all.
  await page.getByTestId('open-test-console').click();
  const testConsole = page.getByTestId('test-console');
  await expect(testConsole).toBeVisible();
  await testConsole.getByTestId('test-console-input').fill(faq);
  await testConsole.getByTestId('test-console-send').click();
  await expect(testConsole.getByTestId('test-console-reply')).toContainText(
    'Tune-ups are priced by the size of your system',
  );
  const log = testConsole.getByTestId('test-console-log');
  await expect(log).toContainText(`Searched Knowledge for “${faq}”`);
  await expect(log).toContainText('Knowledge used:');
  await expect(log).toContainText('Safety check passed');
  await expect(testConsole.getByText('Draft (training wheels)').first()).toBeVisible();
  const inbox = await api<{ items: unknown[] }>(token, 'queries', 'inbox.list', { workspaceId });
  expect(inbox.items).toHaveLength(0);

  // A test call: an incoming one picks up with the greeting, and a goodbye hangs up. An outgoing one needs
  // someone to call first.
  await testConsole.getByTestId('test-channel-phone').click();
  await expect(testConsole.getByTestId('test-console-input')).toBeHidden();
  await testConsole.getByTestId('test-console-start-call').click();
  await expect(testConsole.getByTestId('test-console-reply').first()).toContainText(
    'Thanks for calling',
  );
  await testConsole.getByTestId('test-console-input').fill('That’s all, bye!');
  await testConsole.getByTestId('test-console-send').click();
  await expect(testConsole.getByTestId('test-console-reply').last()).toHaveText(
    'Thanks for calling. Bye now!',
  );
  await expect(testConsole.getByTestId('test-console-call-over')).toBeVisible();
  await expect(testConsole.getByTestId('test-console-input')).toBeHidden();
  await expect(log).toContainText('Said goodbye and hung up');
  await testConsole.getByTestId('test-call-outbound').click();
  await expect(testConsole.getByText('Pick a customer for Ava to call.')).toBeVisible();
  await expect(testConsole.getByTestId('test-console-start-call')).toBeDisabled();
  await testConsole.getByRole('button', { name: 'Close' }).click();
  await expect(testConsole).toBeHidden();

  // Activity: nothing has run yet (test console chats aren't counted).
  await page.getByTestId('subnav-activity').click();
  await expect(page).toHaveURL(/\/ai-team\/activity$/);
  await expect(page.getByTestId('teammate-activity')).toBeVisible();
  await expect(page.getByTestId('activity-replies')).toContainText('0');
  await expect(page.getByTestId('activity-booked')).toContainText('0');
  await expect(page.getByTestId('teammate-runs')).toContainText('No runs yet');
  await expect(page.getByTestId('activity-ai-usage')).toContainText('of the daily limit · Ava');
  // The server picks the period's runs; it stays in the address.
  await page.getByTestId('activity-period-7d').click();
  await expect(page).toHaveURL(/\/ai-team\/activity\?period=7d$/);
  await expect(page.getByTestId('teammate-runs')).toContainText('No runs in the last 7 days');
  await page.getByTestId('subnav-teammate').click();
  await expect(page.getByTestId('teammate-builder')).toBeVisible();
});
