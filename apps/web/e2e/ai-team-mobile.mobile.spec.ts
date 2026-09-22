import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

test.use({ colorScheme: 'dark' });

/**
 * The AI teammate on a 390 px phone, in the dark theme: it's in the drawer (the bar stays at five), the
 * picker fits, the builder's rail folds into a card at the top, each module opens full screen and saves
 * from there (its fields 16 px, so an iPhone doesn't zoom), History is the list's last row, the status and
 * checks open in a sheet, the test console fills the screen and answers a price question from the knowledge
 * base without sending anything, and a lead's Qualification card fits.
 *
 * Quiet hours are set explicitly (8 PM to 8 AM) so nothing depends on the default.
 */
test('AI teammate at 390 px, dark: drawer, picker, modules full screen, checks and test console', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { email } = await signUpAndConfirm(page, 'ai-team-mobile');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  const { token } = await signInOwner(email);
  await api(token, 'commands', 'phone.update_settings', {
    workspaceId,
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
  });
  // One published answer for the test console to find. No amount in it, so prices can stay off.
  const faq = 'How much does drain cleaning cost?';
  await api(token, 'commands', 'knowledge_item.create', {
    workspaceId,
    content: {
      kind: 'faq',
      question: faq,
      answer: 'Drain cleaning is priced by the job, and we confirm the price before we start.',
    },
    status: 'published',
  });
  const width = () => page.evaluate(() => document.documentElement.scrollWidth);

  // The dark theme's tokens.
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    ),
  ).toBe('#0f131a');

  // The bar stays at five; the AI teammate is in the drawer.
  const bar = page.getByRole('navigation', { name: 'Primary' });
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Inbox', 'Pipeline', 'Calendar']);
  await bar.getByRole('button', { name: 'More' }).click();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'AI teammate' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/ai-team$`));
  const picker = page.getByTestId('teammate-preset-picker');
  await expect(picker).toBeVisible();
  expect((await picker.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await width()).toBeLessThanOrEqual(390);

  await page.getByTestId('teammate-preset-appointment_coordinator').click();
  await page.getByTestId('teammate-name-input').fill('Riley');
  await page.getByTestId('teammate-create').click();

  // The rail folds into the card at the top; the modules are a list.
  const summary = page.getByTestId('teammate-phone-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('Riley');
  await expect(page.getByTestId('teammate-status-phone')).toHaveText('Off');
  // Follow-ups start on for every teammate (Automations): 9 steps, then 6 monthly.
  await expect(page.getByTestId('phone-module-followUp')).toContainText('15 follow-ups');
  expect(await width()).toBeLessThanOrEqual(390);

  // A module opens full screen, and saves from its top bar.
  await page.getByTestId('phone-module-followUp').click();
  const screen = page.getByTestId('teammate-module-screen');
  await expect(screen).toBeVisible();
  const box = (await screen.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeGreaterThan(800);
  await screen.getByTestId('skill-followUp').click();
  await screen.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved as revision 2\./)).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await screen.getByRole('button', { name: 'Back' }).click();
  await expect(screen).toBeHidden();
  await expect(page.getByTestId('phone-module-followUp')).toContainText('Off');

  // Its fields are 16 px on a phone, so an iPhone doesn't zoom in on them.
  await page.getByTestId('phone-module-identity').click();
  await expect(screen.getByRole('textbox').first()).toHaveCSS('font-size', '16px');
  await screen.getByRole('button', { name: 'Back' }).click();
  await expect(screen).toBeHidden();

  // History is the list's last row: the revisions in a sheet that fits the phone.
  await page.getByTestId('phone-history').click();
  const history = page.getByRole('dialog', { name: 'History' });
  await expect(history).toContainText('Riley · 2 revisions');
  await expect(history.getByTestId('teammate-history').getByTestId(/^revision-\d+$/)).toHaveCount(
    2,
  );
  expect((await history.boundingBox())!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(history).toBeHidden();

  // The status, labels and things to check open in a sheet.
  await page.getByTestId('teammate-phone-checks').click();
  const sheet = page.getByTestId('teammate-phone-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('teammate-status-card')).toContainText('Training wheels');
  await expect(sheet).toContainText('Things to check');
  await expect(sheet.getByTestId('teammate-labels')).toContainText('Appointment Coordinator');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // The test console fills the screen. Riley answers the price question from the knowledge base, and
  // what it looked up is a tab of its own on a phone. Nothing is sent.
  await summary.getByRole('button', { name: 'Test console' }).click();
  const testConsole = page.getByTestId('test-console');
  await expect(testConsole).toBeVisible();
  const full = (await testConsole.boundingBox())!;
  expect(full.width).toBeLessThanOrEqual(390);
  expect(full.height).toBeGreaterThan(800);
  await testConsole.getByTestId('test-console-input').fill(faq);
  await testConsole.getByTestId('test-console-send').click();
  await expect(testConsole.getByTestId('test-console-reply')).toContainText(
    'Drain cleaning is priced by the job',
  );
  await testConsole.getByRole('tab', { name: 'What Riley did' }).click();
  const log = testConsole.getByTestId('test-console-log');
  await expect(log).toBeVisible();
  await expect(log).toContainText(`Searched Knowledge for “${faq}”`);
  await expect(log).toContainText('Knowledge used:');
  expect(await width()).toBeLessThanOrEqual(390);
  const inbox = await api<{ items: unknown[] }>(token, 'queries', 'inbox.list', { workspaceId });
  expect(inbox.items).toHaveLength(0);
  await testConsole.getByRole('button', { name: 'Close' }).click();
  await expect(testConsole).toBeHidden();

  // Activity fits the phone too.
  await page.getByTestId('subnav-activity').click();
  await expect(page.getByTestId('teammate-activity')).toBeVisible();
  await expect(page.getByTestId('activity-ai-usage')).toContainText('AI used today');
  expect(await width()).toBeLessThanOrEqual(390);

  // A lead's Qualification card on the phone: Riley's two questions, one answered, the other still to ask.
  const got = await api<{
    teammate: { id: string; revision: number; config: Record<string, Record<string, unknown>> };
  }>(token, 'queries', 'ai_teammate.get', { workspaceId });
  await api(token, 'commands', 'ai_teammate.save_config', {
    workspaceId,
    teammateId: got.teammate.id,
    baseRevision: got.teammate.revision,
    config: {
      ...got.teammate.config,
      qualify: {
        ...got.teammate.config.qualify,
        enabled: true,
        questions: [
          { id: 'system', question: 'What kind of system do you have?', kind: 'text' },
          { id: 'zip', question: 'What ZIP code is it in?', kind: 'text' },
        ],
      },
    },
  });
  const { personId } = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Angela',
    lastName: 'Brooks',
  });
  const { leadId } = await api<{ leadId: string }>(token, 'commands', 'lead.create', {
    workspaceId,
    title: 'Attic insulation',
    personId,
  });
  await api(token, 'commands', 'lead.record_answers', {
    workspaceId,
    leadId,
    answers: [{ questionId: 'system', answer: 'Central AC, about 12 years old' }],
  });
  await page.goto(`/app/w/${workspaceId}/leads/${leadId}`);
  const qualification = page.getByTestId('qualification-card');
  await expect(qualification.getByTestId('qualification-status')).toHaveText('Incomplete');
  await expect(qualification.getByTestId('qualification-answer-system')).toContainText(
    'Central AC, about 12 years old',
  );
  await expect(qualification.getByTestId('qualification-summary')).toHaveText(
    'Still to ask: “What ZIP code is it in?”',
  );
  expect((await qualification.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await width()).toBeLessThanOrEqual(390);
});
