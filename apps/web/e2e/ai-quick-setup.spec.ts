import { expect, test } from '@playwright/test';
import { api, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/** The knowledge base's stand-in website, which playwright.config.ts serves. */
const KNOWLEDGE_SITE = 'http://127.0.0.1:4190';

/**
 * Quick setup for the AI teammate (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7). With no teammate yet, the
 * AI teammate page opens it. The first screen saves the business and its website. The address must stay https, so
 * the worker reads the stand-in site in its place, and the next screens fill in from it as it arrives: what the
 * business does, its services, its hours, and quick facts marked "From your website". The summary beside the
 * questions follows the answers. On "What Ava learned" the scan's findings are kept or turned down, and Save makes
 * the teammate, which stays off. The test chat asks it questions made from the business, an answer it didn't know is
 * added, and it's turned on with training wheels. Run again with nothing changed, it says nothing changes.
 */
test('AI teammate quick setup: the questions, what Ava read, Save, the test chat and turning it on', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { email } = await signUpAndConfirm(page, 'ai-quick-owner');
  const workspaceId = await createBusiness(page, { name: 'Quick Setup HVAC' });
  const { token } = await signInOwner(email);

  await page.goto(`/app/w/${workspaceId}/ai-team`);
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/ai-team/setup$`));
  const setup = page.getByTestId('ai-setup');
  const summary = page.getByTestId('ai-setup-summary');
  const next = page.getByTestId('ai-setup-next');
  const at = (step: string) => expect(setup).toHaveAttribute('data-step', step);
  await at('business');
  await expect(setup).toContainText('Quick setup · 1 of');
  await expect(page.getByTestId('ai-setup-business-name')).toHaveValue('Quick Setup HVAC');

  // 1. The business: it needs a name; every business starts as general home services, so the kind is checked and
  // changed here; and saving the website starts Ava reading it.
  await page.getByTestId('ai-setup-business-name').fill('');
  await next.click();
  await expect(setup).toContainText('Name your business.');
  await at('business');
  await page.getByTestId('ai-setup-business-name').fill('Quick Setup HVAC');
  await expect(page.getByTestId('industry-picker')).toHaveValue('General home services');
  await page.getByTestId('industry-picker').fill('HVAC');
  await page.getByTestId('industry-option-hvac').click();
  await page.getByTestId('ai-setup-website-input').fill('quick-setup-hvac.example');
  await next.click();
  await at('jobs');

  // The saved address can't be reached from here: once the scan has said so, the worker reads and scans the
  // stand-in site in its place.
  await expect
    .poll(
      async () =>
        (
          await api<{ scan: { status: string } | null }>(token, 'queries', 'knowledge_scan.get', {
            workspaceId,
          })
        ).scan?.status,
      { timeout: 60_000 },
    )
    .toBe('failed');
  for (const path of ['/test/ai-setup/read-at', '/test/knowledge/scan-at']) {
    const res = await page.request.post(`${WORKER}${path}`, {
      data: { workspaceId, url: KNOWLEDGE_SITE },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  // 2. What Ava helps with: picked from the kind of business.
  await expect(page.getByTestId('ai-setup-job-reply')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ai-setup-job-book')).toHaveAttribute('aria-checked', 'false');
  await expect(summary).toContainText('Ava replies to new leads within a minute.');
  await next.click();

  // 3. About the business, filled in from the website as it's read.
  await at('about');
  await expect(page.getByTestId('ai-setup-description')).toHaveValue(
    'We repair, replace and maintain heating and air conditioning for homes across Austin, Texas.',
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('ai-setup-service-0-name')).toHaveValue('AC repair');
  await expect(page.getByTestId('ai-setup-reading')).toHaveCount(0);
  await expect(page.getByTestId('ai-setup-area')).not.toHaveValue('');
  await next.click();

  // 4. Open hours from the website: weekdays 7 to 6, Saturdays 8 to 2.
  await at('hours');
  await expect(page.getByLabel('Monday start')).toHaveValue(String(7 * 60));
  await expect(page.getByLabel('Saturday end')).toHaveValue(String(14 * 60));
  await next.click();

  // 5. Quick facts: what the website says is answered and marked; a No is kept too.
  await at('facts');
  const emergency = page.getByTestId('ai-setup-fact-emergency');
  await expect(emergency).toHaveAttribute('data-answer', 'yes');
  await expect(page.getByTestId('ai-setup-fact-emergency-note')).toHaveText(
    'From your website. Check it’s right.',
  );
  await expect(page.getByTestId('ai-setup-fact-warranty')).toHaveAttribute('data-answer', 'yes');
  await expect(page.getByTestId('ai-setup-fact-financing')).toHaveAttribute(
    'data-answer',
    'skipped',
  );
  await page.getByTestId('ai-setup-fact-financing-no').click();
  await expect(page.getByTestId('ai-setup-fact-financing')).toHaveAttribute('data-answer', 'no');
  await next.click();

  // 6. Its name: the summary follows.
  await at('meet');
  await page.getByTestId('ai-setup-name').fill('Max');
  await expect(summary).toContainText('Max replies to new leads within a minute.');
  await next.click();

  // 7. How it sounds, and prices: No is picked.
  await at('voice');
  await expect(summary).toContainText('never quotes prices');
  await next.click();

  // 8. What Max learned: the scan's findings as they arrive, one turned down, which stays where it is as more come
  // in; and a top question with its answer. It waits for the scan to finish, since what it finds after Next waits in
  // Knowledge, and a second run would offer it again.
  await at('learned');
  const findings = page
    .getByTestId('ai-setup-findings')
    .locator('[data-testid^="ai-setup-finding-"]');
  await expect(findings.first()).toBeVisible({ timeout: 120_000 });
  const firstId = (await findings.first().getAttribute('data-testid'))!;
  const first = page.getByTestId(firstId);
  await first.click();
  await expect(first).toHaveAttribute('aria-checked', 'false');
  await expect
    .poll(
      async () =>
        (
          await api<{ scan: { status: string } | null }>(token, 'queries', 'knowledge_scan.get', {
            workspaceId,
          })
        ).scan?.status,
      { timeout: 120_000 },
    )
    .toBe('done');
  await expect(setup).not.toContainText('Max is still reading your website.', { timeout: 30_000 });
  await expect(findings.first()).toHaveAttribute('data-testid', firstId);
  await expect(first).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('ai-setup-add-top-question').click();
  await page.getByTestId('ai-setup-top-0-question').fill('Do you service heat pumps?');
  await page
    .getByTestId('ai-setup-top-0-answer')
    .fill('Yes. We repair and maintain heat pumps of every brand.');
  await next.click();

  // 10. Staying in the loop: no business number yet, so no cell to confirm; then 11, the website chat.
  await at('loop');
  await next.click();
  await at('chat');
  await expect(page.getByTestId('ai-setup-chat-yes')).toHaveAttribute('aria-checked', 'true');
  await expect(next).toHaveText('Save');
  await next.click();

  // 12. Saved: the chat's code, and the test chat, which stays on screen when the page is loaded again.
  await at('try');
  await expect(page).toHaveURL(new RegExp(`/ai-team/setup\\?at=try$`));
  await expect(page.getByTestId('ai-setup-chat-code')).toContainText('/embed/v1/');
  await page.reload();
  await at('try');
  await page.getByTestId('ai-setup-ask-all').click();
  const rows = page.getByTestId('ai-setup-test').locator('li[data-state]');
  await expect(rows.first()).toBeVisible();
  const asked = await rows.count();
  expect(asked).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < asked; i++)
    await expect(rows.nth(i)).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(page.getByTestId('ai-setup-report')).toBeVisible();

  // A question it can't answer goes to a person; adding the answer teaches it. (Its words are on none of the
  // stand-in site's pages: the teammate looks up any of them.)
  await page.getByTestId('ai-setup-ask-own').fill('How much is a ductless mini split?');
  await page.getByTestId('ai-setup-ask-own').press('Enter');
  const own = page.getByTestId(`ai-setup-test-${asked}`);
  await expect(own).toHaveAttribute('data-outcome', 'handed_off', { timeout: 60_000 });
  await page.getByTestId(`ai-setup-test-${asked}-add`).click();
  await page
    .getByTestId(`ai-setup-test-${asked}-answer`)
    .fill(
      'Ductless mini splits are priced after a quick look, and we confirm the price before any work starts.',
    );
  await page.getByTestId(`ai-setup-test-${asked}-save`).click();
  await expect(own).toHaveAttribute('data-outcome', 'replied', { timeout: 60_000 });
  await expect(own).toContainText('Ductless mini splits are priced after a quick look');

  // Turned on with training wheels, it's the AI teammate page's builder.
  await page.getByTestId('ai-setup-turn-on').click();
  await expect(
    page.getByText('Turned on. Max starts with training wheels: every message waits for your OK.'),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/ai-team$`));
  await expect(page.getByTestId('teammate-status')).toHaveText('Training wheels');
  await expect(page.getByTestId('teammate-name')).toHaveText('Max');

  // Run again with nothing changed: it shows what will change first, and nothing does.
  await page.goto(`/app/w/${workspaceId}/ai-team/setup`);
  await at('business');
  await expect(page.getByTestId('ai-setup-myself')).toHaveText('More settings');
  for (let i = 0; i < 12 && (await setup.getAttribute('data-step')) !== 'confirm'; i++) {
    const step = await setup.getAttribute('data-step');
    await next.click();
    await expect(setup).not.toHaveAttribute('data-step', step!);
  }
  await at('confirm');
  await expect(page.getByTestId('ai-setup-changes')).toHaveText(
    'Nothing changes. Your answers match what’s saved.',
  );
});
