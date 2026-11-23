import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';
import { getNumber, nextTo } from './telephony';

/**
 * The guided phone number setup (the owner, 22 Nov 2026): one question at a time, saved as it is answered, so
 * leaving and coming back loses nothing. "If the phone number is no longer available when they come back let them
 * know and have them choose a new phone number."
 */
test('guided phone setup: answers are kept, and a number taken while away is picked again', async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);
  await signUpAndConfirm(page, 'phone-setup');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });

  // Settings → Texting & calls starts it.
  await page.goto(`/app/w/${workspaceId}/settings/texting`);
  const start = page.getByTestId('phone-start-go');
  await expect(start).toHaveText('Start');
  await expect(page.getByTestId('phone-start-saved')).toHaveCount(0);
  const card = page.getByTestId('phone-setup');
  await expect(async () => {
    if (!/\/onboarding\//.test(page.url())) await start.click();
    await expect(card).toHaveAttribute('data-screen', 'have', { timeout: 10_000 });
  }).toPass({ timeout: 90_000 });

  // A new number, to text from, with no EIN: a toll-free one.
  await nextTo(page, 'texting');
  await nextTo(page, 'ein');
  await page.getByTestId('ein-no').click();
  await nextTo(page, 'number');
  const first = page.getByTestId('number-results').getByRole('radio').first();
  await expect(first).toBeVisible({ timeout: 60_000 });
  // Next without a number says to pick one.
  await page.getByTestId('phone-setup-next').click();
  await expect(card.getByRole('alert')).toBeVisible();
  await expect(card).toHaveAttribute('data-screen', 'number');
  await first.click();
  const picked = (await first.locator('.font-mono').textContent())!.trim();
  const pickedE164 = `+1${picked.replace(/[^0-9]/g, '')}`;

  // What rings: Dale's cell too.
  await nextTo(page, 'ring');
  await page.getByTestId('phone-more').check();
  await page.getByTestId('phone-label-0').fill('Dale’s cell');
  await page.getByTestId('phone-number-0').fill('(713) 555-0161');
  await nextTo(page, 'missed');
  await expect(page.getByTestId('guided-saved')).toContainText('Saved', { timeout: 30_000 });

  // Leaving keeps every answer, and Settings says so.
  await page.getByTestId('guided-leave').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/texting`), {
    timeout: 60_000,
  });
  await expect(start).toHaveText('Carry on where you left off');
  await expect(page.getByTestId('phone-start-saved')).toContainText('are saved');

  // While they are away, another business buys the number they picked.
  const rival = await browser.newContext();
  const theirs = await rival.newPage();
  const other = await signUpAndConfirm(theirs, 'phone-setup-rival');
  const otherWorkspace = await createBusiness(theirs, { name: 'Bayou Plumbing' });
  await rival.close();
  const { token } = await signInOwner(other.email);
  await api(token, 'commands', 'phone_number.buy', {
    workspaceId: otherWorkspace,
    e164: pickedE164,
    numberType: 'toll_free',
  });
  await expect
    .poll(
      async () =>
        (
          await api<{ number: { status: string } | null }>(token, 'queries', 'phone.setup_status', {
            workspaceId: otherWorkspace,
          })
        ).number?.status,
      { timeout: 90_000 },
    )
    .toBe('active');

  // Back: told the number is gone, and asked for another. Nothing else is asked again.
  await expect(async () => {
    if (!/\/onboarding\//.test(page.url())) await start.click();
    await expect(card).toHaveAttribute('data-screen', 'number', { timeout: 15_000 });
  }).toPass({ timeout: 90_000 });
  const gone = page.getByTestId('number-gone');
  await expect(gone).toContainText(`${picked} was taken while you were away`);
  await expect(page.getByTestId('number-results')).not.toContainText(picked);
  await first.click();
  const second = (await first.locator('.font-mono').textContent())!.trim();
  expect(second).not.toBe(picked);
  // Next goes back to where they were, with what rings as they left it.
  await nextTo(page, 'missed');
  await page.getByTestId('phone-setup-back').click();
  await expect(card).toHaveAttribute('data-screen', 'ring');
  await expect(page.getByTestId('phone-label-0')).toHaveValue('Dale’s cell');
  await expect(page.getByTestId('phone-number-0')).toHaveValue('(713) 555-0161');
  await nextTo(page, 'missed');
  await page.getByTestId('missed-voicemail').click();
  await nextTo(page, 'quiet');
  await nextTo(page, 'review');

  // Check it over: every answer, and Change comes straight back.
  await expect(page.getByTestId('review-number')).toContainText(second);
  await expect(page.getByTestId('review-ring')).toContainText('HandsFreeOS and Dale’s cell');
  await expect(page.getByTestId('review-missed')).toContainText('Voicemail after 20 seconds');
  await page.getByTestId('review-change-missed').click();
  await expect(card).toHaveAttribute('data-screen', 'missed');
  await page.getByTestId('ring-seconds-25').click();
  await nextTo(page, 'review');
  await expect(page.getByTestId('review-missed')).toContainText('Voicemail after 25 seconds');

  // Only now is the number bought.
  await page.getByTestId('phone-setup-next').click();
  await expect(page.getByTestId('phone-setup-done')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('phone-setup-done-number')).toHaveText(second);
  await expect(page.getByTestId('phone-setup-approval')).toBeVisible();

  // Settings shows what they said, on the number's card, and the saved answers are spent.
  await page.goto(`/app/w/${workspaceId}/settings/texting`);
  const phone = page.getByTestId('phone-card');
  await expect(phone.getByTestId('business-number')).toContainText(second);
  await expect(phone.getByTestId('row-ring')).toContainText('HandsFreeOS and Dale’s cell');
  await expect(phone.getByTestId('row-missed')).toContainText('Voicemail after 25 seconds');
  await expect(page.getByTestId('phone-start')).toHaveCount(0);
  // Texting was wanted: its approval is the next thing on the page, and Start opens its own guided page.
  await expect(page.getByTestId('texting-setup')).toBeVisible();
  await expect(page.getByTestId('approval-start')).toBeVisible();
});

test('guided phone setup: calls only, and texting turned on later from Settings', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'phone-calls-only');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await getNumber(page, workspaceId, { texting: false });

  // No approval to start: the number takes calls, and that is all that was asked for.
  const done = page.getByTestId('phone-setup-done');
  await expect(done).toContainText('Calls only');
  await expect(page.getByTestId('phone-setup-approval')).toHaveCount(0);
  await page.getByTestId('phone-setup-to-settings').click();

  const phone = page.getByTestId('phone-card');
  await expect(phone).toBeVisible({ timeout: 60_000 });
  const approval = phone.getByTestId('row-approval');
  await expect(approval).toContainText('Texting is off. Calls only.');
  await expect(page.getByTestId('texting-setup')).toHaveCount(0);
  await expect(phone.getByTestId('row-quiet')).toHaveCount(0);

  // Changing their mind is one button, and then the approval steps are there.
  await expect(async () => {
    if (await page.getByTestId('turn-on-texting').isVisible())
      await page.getByTestId('turn-on-texting').click();
    await expect(page.getByTestId('texting-setup')).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('approval-start')).toBeVisible();
  await expect(approval).not.toContainText('Texting is off');
  await expect(phone.getByTestId('row-quiet')).toBeVisible();
});
