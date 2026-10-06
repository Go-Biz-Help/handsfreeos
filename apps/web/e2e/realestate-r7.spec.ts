import { expect, test, type Page } from '@playwright/test';
import { api } from './booking-helpers';
import { conversationFor, draftIn, sentIn, teammateBusiness } from './ai-team';
import { emailFromCustomer } from './email';
import { uniqueEmail } from './helpers';
import { turnOnRealestate } from './realestate-helpers';
import { textFromCustomer } from './telephony';

const DANA = '+15125550173';

/** The business's shared email address, from Settings → Email. */
async function sharedAddress(page: Page, workspaceId: string): Promise<string> {
  await page.goto(`/app/w/${workspaceId}/settings/email`);
  const addresses = page.getByTestId('email-addresses');
  await expect(addresses).toContainText('@mail.handsfreeos.com');
  return (await addresses.locator('.font-mono').first().textContent())!.trim();
}

/**
 * Real Estate Agent, round seven on the web (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round seven: What round
 * six left out"; boards 94-97), against the local stack, the worker's stand-ins and its scripted model.
 *
 * 1. A listing's lockbox is added with its code, which is locked as it's saved: the page only says it's kept, and
 *    Show code asks the worker for it again. Changing it keeps the code; removing it says the code won't go out.
 * 2. Lockbox emails turn off and on again under Deal settings → Connections; on, SentriLock's "opened" email is
 *    read into the listing by its serial: Who opened them lists it, with no showing booked, and Home says so.
 * 3. The teammate's Add-ons module turns on Real Estate Agent.
 * 4. A buyer texts to add a home: the teammate (answering on its own) looks up their deal as they'd see it, tells them
 *    it has asked, and the ask waits in the thread. Approving adds the home as the person who approved it, and the
 *    buyer is told.
 * 5. The buyer asks what an area is like: the reply the fair housing checks flag waits for a person, with why, even
 *    though the teammate answers on its own; rejecting it sends nothing.
 */
test('lockboxes, their emails, and the teammate using Real Estate', async ({ page }) => {
  test.setTimeout(600_000);
  const b = await teammateBusiness(page, 'realestate-r7');
  await turnOnRealestate(page, b.email, b.workspaceId);
  const run = <T = Record<string, string>>(name: string, input: Record<string, unknown>) =>
    api<T>(b.token, 'commands', name, { workspaceId: b.workspaceId, ...input });
  const ask = <T = Record<string, unknown>>(name: string, input: Record<string, unknown>) =>
    api<T>(b.token, 'queries', name, { workspaceId: b.workspaceId, ...input });
  const base = `/app/w/${b.workspaceId}/a/realestate`;

  // ---------- 1. a listing's lockboxes ----------
  const maria = await run<{ personId: string }>('person.create', {
    firstName: 'Maria',
    lastName: 'Alvarez',
    email: uniqueEmail('maria'),
  });
  const { dealId: listingId } = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'listing',
    name: 'Alvarez listing',
    stage: 'pre_listing',
    clientPersonId: maria.personId,
    newPropertyAddress: '2207 Juniper Trail, Austin, TX 78745',
  });
  await page.goto(`${base}/deals/${listingId}/showings`);
  const card = page.getByTestId('lockboxes');
  await expect(card).toContainText('None yet.');
  await card.getByTestId('lockbox-add').click();
  await page.getByTestId('lockbox-kind-sentrilock').click();
  await page.getByTestId('lockbox-place').fill('Front door');
  await page.getByTestId('lockbox-serial').fill('31118204');
  await page.getByTestId('lockbox-code-input').fill('4417');
  await page.getByTestId('lockbox-save').click();
  await expect(page.getByText('Saved. The code is locked.')).toBeVisible();
  const row = card.locator('tbody tr').first();
  await expect(row).toContainText('SentriLock');
  await expect(row).toContainText('Front door');
  await expect(row).toContainText('Kept locked');
  await expect(row).not.toContainText('4417');
  // The list never carries the code; Show code asks the worker for it.
  const listed = await ask<{ lockboxes: Record<string, unknown>[] }>('realestate.lockbox.list', {
    dealId: listingId,
  });
  expect(JSON.stringify(listed)).not.toContain('4417');
  expect(listed.lockboxes[0]).toMatchObject({ hasCode: true, serial: '31118204' });
  await row.getByTestId('lockbox-show').click();
  await expect(row.getByTestId('lockbox-code')).toHaveText('4417');
  await expect(row).toContainText('It’s in the deal’s history.');
  // Changed without a new code, it keeps the one it has.
  await row.getByTestId('lockbox-edit').click();
  await expect(page.getByText('Leave empty to keep the code it has.')).toBeVisible();
  await page.getByTestId('lockbox-place').fill('Side gate');
  await page.getByTestId('lockbox-save').click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(row).toContainText('Side gate');
  await expect(row).toContainText('Kept locked');

  // ---------- 2. its emails ----------
  // On unless someone turns it off: off, they stay in the Inbox; on again, they're read.
  await page.goto(`${base}/settings?tab=connections`);
  const reading = page.getByTestId('connector-lockboxes');
  await expect(reading).toContainText('On');
  await reading.getByTestId('lockbox-emails-switch').click();
  await expect(page.getByText('Their emails stay in the Inbox now.')).toBeVisible();
  await expect(reading).toContainText(
    'Their emails stay in the Inbox, and nothing is read from them.',
  );
  await reading.getByTestId('lockbox-emails-switch').click();
  await expect(page.getByText('Their emails are read into your listings now.')).toBeVisible();
  await expect(reading).toContainText('read from the Inbox into the listing they’re about');
  const shared = await sharedAddress(page, b.workspaceId);
  await emailFromCustomer({
    from: 'notifications@sentrilock.com',
    fromName: 'SentriLock',
    to: shared,
    subject: 'Lockbox Access Notification',
    text: [
      'Lockbox Access Notification',
      'Your lockbox has been accessed.',
      'Property Address: 2207 Juniper Trail, Austin, TX 78745',
      'Lockbox Serial Number: 31118204',
      'Accessed By: Jo Kim',
      'Company: Keller Williams',
      'Phone: (512) 555-0144',
      `Date/Time: ${new Date().toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}`,
    ].join('\n'),
  });
  await expect(async () => {
    await page.goto(`${base}/deals/${listingId}/showings`);
    await expect(page.getByTestId('lockbox-openings')).toContainText('Jo Kim · Keller Williams', {
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });
  const openings = page.getByTestId('lockbox-openings');
  await expect(openings).toContainText('SentriLock’s email');
  await expect(openings).toContainText('No showing booked');
  await expect(async () => {
    await page.goto(`/app/w/${b.workspaceId}`);
    await expect(page.getByText(/was opened with no showing booked/)).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });

  // Removed, its code won't go out again.
  await page.goto(`${base}/deals/${listingId}/showings`);
  await page
    .getByTestId('lockboxes')
    .locator('tbody tr')
    .first()
    .getByTestId('lockbox-remove')
    .click();
  await expect(page.getByText('Removed. Its code won’t go out again.')).toBeVisible();
  await expect(page.getByTestId('lockboxes')).toContainText('None yet.');

  // ---------- 3. the teammate uses Real Estate ----------
  await page.goto(`/app/w/${b.workspaceId}/ai-team`);
  await expect(page.getByTestId('teammate-builder')).toBeVisible();
  await expect(page.getByTestId('module-summary-addons')).toHaveText('None on');
  await page.getByTestId('module-addons').click();
  const panel = page.getByTestId('module-panel-addons');
  await expect(panel).toContainText('Looks things up as the customer');
  await panel.getByTestId('addon-realestate').click();
  await expect(page.getByTestId('teammate-save-state')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('module-summary-addons')).toHaveText('Uses Real Estate Agent');
  // It answers on its own: what Real Estate's checks flag still waits.
  await run('ai_teammate.set_status', { teammateId: b.teammateId, status: 'automatic' });

  // ---------- 4. an ask ----------
  const dana = await run<{ personId: string }>('person.create', {
    firstName: 'Dana',
    lastName: 'Reyes',
    phone: DANA,
  });
  const { dealId: buyerId } = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'buyer',
    name: 'Reyes home search',
    stage: 'touring',
    clientPersonId: dana.personId,
  });
  await textFromCustomer({
    from: DANA,
    to: b.business,
    body: 'Can you add 412 Oak St to my list?',
  });
  const conversationId = await conversationFor(b, DANA);
  await sentIn(b, conversationId, /asked your agent to add it/);
  const asked = await draftIn(b, conversationId);
  expect(asked.kind).toBe('ask');
  await page.goto(`/app/w/${b.workspaceId}/inbox/${conversationId}`);
  const draft = page.getByTestId('draft-card');
  await expect(draft).toContainText('Ava asks');
  await expect(draft.getByTestId('draft-ask')).toContainText('Add 412 Oak St to Dana’s homes');
  await expect(draft.getByTestId('draft-ask')).toContainText(
    'Approving does it as you, then Dana gets: “412 Oak St is on your list now.”',
  );
  await expect(draft.getByTestId('draft-approve')).toHaveText('Approve');
  await draft.getByTestId('draft-approve').click();
  await expect(page.getByText('Done, as you. Ava lets Dana know now.')).toBeVisible();
  await expect(page.getByTestId('draft-card')).toHaveCount(0);
  await sentIn(b, conversationId, /412 Oak St is on your list now/);
  const { homes } = await ask<{ homes: { address: string | null }[] }>('realestate.homes', {
    dealId: buyerId,
  });
  expect(homes.map((h) => h.address)).toEqual([expect.stringContaining('412 Oak St')]);

  // ---------- 5. a reply the checks held ----------
  await textFromCustomer({
    from: DANA,
    to: b.business,
    body: 'What’s the area like around Oak St?',
  });
  const held = await draftIn(b, conversationId);
  expect(held.kind).toBe('reply');
  await page.reload();
  const heldCard = page.getByTestId('draft-card');
  await expect(heldCard.getByTestId('draft-text')).toContainText('good schools');
  const flags = heldCard.getByTestId('draft-flags');
  await expect(flags).toContainText('Ava answers on its own, but this reply waits for you');
  await expect(flags).toContainText('Fair housing: “good schools”.');
  await expect(heldCard.getByTestId('draft-approve')).toHaveText('Send as it is');
  await heldCard.getByTestId('draft-reject').click();
  await heldCard.getByTestId('draft-reject-reason').fill('I’ll send her the district’s reports.');
  await heldCard.getByTestId('draft-reject-confirm').click();
  await expect(page.getByTestId('draft-card')).toHaveCount(0);
  const thread = await api<{ items: { direction: string; body: string | null }[] }>(
    b.token,
    'queries',
    'conversation.thread',
    { workspaceId: b.workspaceId, conversationId, limit: 20 },
  );
  expect(
    thread.items.some((i) => i.direction === 'outbound' && /good schools/.test(i.body ?? '')),
  ).toBe(false);
});
