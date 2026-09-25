import { expect, test } from '@playwright/test';
import { api } from './booking-helpers';
import { conversationFor, draftsWaiting, pendingDrafts, sentIn, teammateBusiness } from './ai-team';
import { textFromCustomer } from './telephony';

const CUSTOMERS = ['+17135550201', '+17135550202', '+17135550203', '+17135550204', '+17135550205'];
const NEXT = '+17135550299';

/**
 * Training wheels on the Approvals page: with approvals needed set to 5 (the fewest the settings allow), five
 * customers' drafts wait on the AI teammate's own Approvals tab, and beside workflow approvals under the "Ava"
 * filter; approving all five turns the teammate automatic (by the threshold), and the next customer's reply
 * goes straight out with no draft. Quiet hours are off, so it passes at any hour.
 */
test('AI teammate approvals: five approvals turn it automatic, then it replies on its own', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const b = await teammateBusiness(page, 'ai-approvals', {
    patch: { autonomy: { approvalsNeeded: 5 } },
  });
  for (const from of CUSTOMERS)
    await textFromCustomer({ from, to: b.business, body: 'Hi, do you service Katy?' });
  await draftsWaiting(b, CUSTOMERS.length);

  // The AI teammate area's own Approvals tab: only Ava's drafts, under Ava's header.
  await page.goto(`/app/w/${b.workspaceId}/ai-team`);
  await page.getByTestId('subnav-approvals').click();
  await expect(page).toHaveURL(/\/ai-team\/approvals$/);
  await expect(page.getByTestId('teammate-approvals-tab')).toBeVisible();
  await expect(page.getByTestId('teammate-name')).toHaveText('Ava');
  await expect(page.getByTestId('subnav-approvals')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('teammate-draft')).toHaveCount(CUSTOMERS.length);
  await expect(page.getByTestId('approvals-filter-all')).toHaveCount(0);

  await page.goto(`/app/w/${b.workspaceId}/workflows/approvals`);
  await expect(page.getByTestId('approvals-count')).toHaveText('5');

  // On a phone (390 px, dark) each draft is a card that fits, with Approve and send in reach.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const firstCard = page.getByTestId('teammate-draft').first();
  const firstReview = firstCard.getByTestId('teammate-draft-review');
  if (await firstReview.isVisible()) await firstReview.click();
  await expect(firstCard.getByTestId('teammate-draft-approve')).toBeVisible();
  expect((await firstCard.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.emulateMedia({ colorScheme: 'light' });

  await expect(page.getByTestId('approvals-filter-all')).toHaveText('All · 5');
  await expect(page.getByTestId('approvals-filter-workflows')).toHaveText('Workflows · 0');
  await page.getByTestId('approvals-filter-ai').click();
  await expect(page.getByTestId('approvals-filter-ai')).toHaveText('Ava · 5');
  await expect(page.getByTestId('approvals-training')).toContainText('0 of 5 approved');

  for (let n = 1; n <= CUSTOMERS.length; n++) {
    const card = page.getByTestId('teammate-draft').first();
    const review = card.getByTestId('teammate-draft-review');
    if (await review.isVisible()) await review.click();
    await expect(card.getByTestId('teammate-draft-conversation')).toContainText(
      'Hi, do you service Katy?',
    );
    await card.getByTestId('teammate-draft-approve').click();
    await expect(
      page.getByText(
        n < CUSTOMERS.length
          ? `Approved. Ava texts them now. ${n} of 5 approved.`
          : 'Approved. That’s 5: Ava replies on its own from now on.',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('teammate-draft')).toHaveCount(CUSTOMERS.length - n);
  }
  await expect(page.getByTestId('approvals-empty')).toBeVisible();

  const got = await api<{
    teammate: { status: string };
    progress: { approvedCount: number; automaticVia: string | null };
  }>(b.token, 'queries', 'ai_teammate.get', { workspaceId: b.workspaceId });
  expect(got.teammate.status).toBe('automatic');
  expect(got.progress).toMatchObject({ approvedCount: 5, automaticVia: 'threshold' });

  // Automatic now: the next customer's reply goes straight out, and no draft waits.
  await textFromCustomer({ from: NEXT, to: b.business, body: 'Hi, do you service Katy?' });
  const conversationId = await conversationFor(b, NEXT);
  const reply = await sentIn(b, conversationId, /will follow up soon/);
  expect(await pendingDrafts(b)).toHaveLength(0);
  await page.goto(`/app/w/${b.workspaceId}/inbox/${conversationId}`);
  await expect(
    page.getByTestId('message-log').locator('[data-direction="outbound"]').last(),
  ).toContainText(reply);
  await expect(page.getByTestId('draft-card')).toHaveCount(0);
  await page.goto(`/app/w/${b.workspaceId}/ai-team`);
  await expect(page.getByTestId('teammate-status')).toHaveText('Automatic');
});
