import { expect, test } from '@playwright/test';
import { api, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, linkFrom, signUpAndConfirm, uniqueEmail, waitForMail } from './helpers';
import { textPdf, turnOnRealestate } from './realestate-helpers';

// A contract's text, as the scripted reader finds its values: one labelled line each, with its clause.
const CONTRACT = [
  [
    'ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)',
    '§1 Buyer: Jamie Smith and Chris Smith',
    '§1 Seller: Robert Okafor and Elaine Okafor',
    '§3 Sales Price: $412,000',
    '§5 Earnest Money: $5,000 delivered within 3 days after the Effective Date',
  ],
  [
    '§5B Option Period: within 9 days after the Effective Date',
    '§TPF2 Financing: within 14 days after the Effective Date',
    '§6C Survey: within a reasonable time',
    '§9 Closing Date: October 30, 2026',
    '§10 Possession: at closing and funding',
    'Effective Date: September 24, 2026',
  ],
];
const AMENDMENT = [
  [
    'AMENDMENT 1 TO CONTRACT CONCERNING 123 MAIN ST',
    '§2 Closing Date is changed to November 4, 2026',
  ],
];

/**
 * Real Estate Agent, round four (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four: Coordinator and
 * risk"): exceptions replace checking duties by hand.
 *
 * 1. A contract added on Documents is read; each value waits beside its words until the agent confirms, and the
 *    duties on its dates start then.
 * 2. An amendment moves the closing: its page shows what it changes and which duties move, and confirming applies it.
 * 3. A contingency is recorded as satisfied with the signed form, and the client sees it in their portal.
 * 4. A duty shows the duty it waits on, built in, and the agent adds one of their own.
 * 5. The client's sale is linked; when its closing slips past the purchase's, both deals say so.
 * 6. Coordinate's Today, Exceptions and Waiting room list what needs someone, and Chased moves the chase on.
 * 7. An overdue duty nobody acknowledges for a business day is marked escalated on Today.
 */
test('a contract read, its contingencies, linked deals and the coordinator’s views', async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  const business = 'Hill Country Realty';
  const { email } = await signUpAndConfirm(page, 'realestate-coordinator');
  const workspaceId = await createBusiness(page, { name: business });
  await turnOnRealestate(page, email, workspaceId);
  const { token } = await signInOwner(email);
  const run = <T = Record<string, string>>(name: string, input: Record<string, unknown>) =>
    api<T>(token, 'commands', name, { workspaceId, ...input });
  const ask = <T = Record<string, unknown>>(name: string, input: Record<string, unknown>) =>
    api<T>(token, 'queries', name, { workspaceId, ...input });
  const sweep = async () => {
    const res = await fetch(`${WORKER}/test/scheduled-jobs/run-due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, dedupeKeys: [`realestate.sweep:${workspaceId}`] }),
    });
    expect(res.status).toBe(200);
    const ran = (await res.json()) as { ran: { failed: number } };
    expect(ran.ran.failed).toBe(0);
  };

  const jamieEmail = uniqueEmail('jamie');
  const jamie = await run<{ personId: string }>('person.create', {
    firstName: 'Jamie',
    lastName: 'Smith',
    email: jamieEmail,
  });
  const { dealId } = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'buyer',
    name: 'Smith purchase',
    stage: 'under_contract',
    clientPersonId: jamie.personId,
    newPropertyAddress: '123 Main St, Austin, TX 78723',
  });
  const dealUrl = `/app/w/${workspaceId}/a/realestate/deals/${dealId}`;
  const coordinate = `/app/w/${workspaceId}/a/realestate/coordinate`;
  const addDocument = async (name: string, kind: string, title: string, pdf: Buffer) => {
    await page.goto(`${dealUrl}/documents`);
    await page.getByTestId('add-document').click();
    await page
      .getByTestId('document-file-input')
      .setInputFiles({ name, mimeType: 'application/pdf', buffer: pdf });
    await page.getByTestId('document-kind').selectOption(kind);
    await page.getByLabel('Title (optional)').fill(title);
    await page.getByTestId('document-save').click();
  };

  // 1. The contract is read on its own once it's added; its values wait for the agent.
  await addDocument('smith-contract.pdf', 'contract', 'Purchase contract', textPdf(CONTRACT));
  const read = page.getByTestId('document-read');
  await expect(read).toContainText('values to confirm', { timeout: 90_000 });
  // Nothing counts yet: Coordinate's Exceptions lists it to check.
  await page.goto(`${coordinate}?tab=exceptions`);
  await expect(page.getByTestId('exceptions-reads')).toContainText(
    'Smith purchase · Purchase contract',
  );
  await page.getByTestId('exceptions-reads').getByRole('link', { name: 'Check them' }).click();
  await expect(
    page.getByRole('heading', { name: /The contract: \d+ values to confirm/ }),
  ).toBeVisible();
  const value = (key: string) => page.locator(`[data-testid="contract-value"][data-key="${key}"]`);
  await expect(value('closing')).toContainText('Oct 30, 2026');
  await expect(value('closing')).toContainText('§9');
  await expect(value('closing')).toContainText('“§9 Closing Date: October 30, 2026”');
  await expect(value('inspection_end')).toContainText('9 days after');
  await expect(value('price')).toContainText('$412,000');
  // "Within a reasonable time" isn't a date: it's left for the agent, not guessed.
  await expect(page.getByTestId('contract-unclear')).toContainText('reasonable time');
  // One is set aside as not right; the rest are confirmed together, and the duties on them start.
  await value('buyer_names').getByTestId('contract-reject').click();
  await page.getByTestId('reason-input').fill('Chris goes by Christopher on the loan.');
  await page.getByTestId('reason-submit').click();
  await expect(value('buyer_names')).toHaveAttribute('data-state', 'rejected');
  await page.getByTestId('contract-confirm-all').click();
  await expect(page.getByText('Confirmed. The duties on these dates start now.')).toBeVisible();
  await expect(value('closing')).toHaveAttribute('data-state', 'confirmed');
  await page.goto(dealUrl);
  const keyDates = page.getByTestId('deal-key-dates');
  await expect(keyDates).toContainText('Oct 30');
  await expect(keyDates.getByText('Confirm', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('deal-duties')).toContainText(/walkthrough/i);

  // 2. The amendment moves the closing: what it changes, then applied.
  await addDocument('amendment-1.pdf', 'amendment', 'Amendment 1', textPdf(AMENDMENT));
  await expect(page.getByTestId('document-read').last()).toContainText('1 value to confirm', {
    timeout: 90_000,
  });
  await page.getByTestId('document-read').last().click();
  await expect(page.getByRole('heading', { name: 'Amendment 1: what it changes' })).toBeVisible();
  await expect(value('closing')).toContainText('Nov 4, 2026');
  await expect(value('closing')).toContainText('Was: Oct 30, 2026');
  const moves = page.getByTestId('contract-moves');
  await expect(moves).toContainText('→');
  await page.getByTestId('contract-confirm-all').click();
  await expect(page.getByText('Confirmed. The duties on these dates moved.')).toBeVisible();
  await page.goto(dealUrl);
  await expect(keyDates).toContainText('Nov 4');
  await expect(keyDates).toContainText('Amended');

  // 3. The option period (inspection) ends with the signed form, and the client sees it.
  await page.goto(`${dealUrl}/contingencies`);
  const inspection = page.locator('[data-testid="contingency-row"][data-kind="inspection"]');
  await expect(inspection).toContainText('From the contract');
  await inspection.getByTestId('contingency-record').click();
  await page.getByTestId('contingency-form-file').setInputFiles({
    name: 'option-removal-signed.pdf',
    mimeType: 'application/pdf',
    buffer: textPdf([['Buyer will proceed. Option period ended.']]),
  });
  await expect(page.getByText('Added to Documents, signed and kept.')).toBeVisible();
  await page.getByTestId('contingency-record-save').click();
  await expect(page.getByText('Recorded.')).toBeVisible();
  await expect(inspection).toHaveAttribute('data-state', 'satisfied');
  await expect(inspection).toContainText('Inspection: signed form');
  await page.goto(dealUrl);
  await page.getByTestId('portal-invite').click();
  const invited = Date.now();
  await page.getByTestId('invite-send').click();
  const invite = await waitForMail(jamieEmail, `Your private portal with ${business}`, {
    after: invited,
  });
  const link = linkFrom(invite.text, /http:\/\/localhost:3000\/c\/[A-Za-z0-9_.~-]+/);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const m = await phone.newPage();
  await m.goto(link);
  const asked = Date.now();
  await m.getByTestId('portal-send-code').click();
  const codeMail = await waitForMail(jamieEmail, `Your ${business} code`, { after: asked });
  await m.getByTestId('portal-digit-0').fill(/\b(\d{6})\b/.exec(codeMail.text)![1]!);
  await expect(m.getByTestId('portal-home')).toContainText('Hi Jamie');
  await m.goto(`${link.replace(/\/$/, '')}/a/realestate/deals/${dealId}`);
  const theirs = m.getByTestId('portal-contingencies');
  await expect(theirs).toContainText('Your contingencies');
  await expect(
    theirs.getByTestId('portal-contingency').filter({ hasText: 'Inspection' }),
  ).toContainText('Satisfied');
  await expect(
    theirs.getByTestId('portal-contingency').filter({ hasText: 'Financing' }),
  ).toContainText('Open');
  await phone.close();

  // 4. A duty that waits on another shows it, built in; the agent adds one of their own, then takes it back.
  const got = await ask<{ duties: { dutyId: string; title: string; status: string }[] }>(
    'realestate.deal.get',
    { dealId },
  );
  let waits: string | null = null;
  for (const d of got.duties.filter((x) => x.status === 'not_started')) {
    const one = await ask<{ waitsOn: unknown[] }>('realestate.duty.get', { dutyId: d.dutyId });
    if (one.waitsOn.length) {
      waits = d.dutyId;
      break;
    }
  }
  expect(waits).not.toBeNull();
  await page.goto(`${dealUrl}?duty=${waits}`);
  const drawer = page.getByTestId('duty-drawer');
  await expect(drawer.getByTestId('duty-waits-on').first()).toContainText('Built in');
  const before = await drawer.getByTestId('duty-waits-on').count();
  await drawer.getByTestId('duty-waits-add').click();
  await drawer.getByTestId('duty-waits-pick').selectOption({ index: 1 });
  await drawer.getByTestId('duty-waits-save').click();
  await expect(drawer.getByTestId('duty-waits-on')).toHaveCount(before + 1);
  const mine = drawer.getByTestId('duty-waits-on').filter({ hasText: 'added' });
  await expect(mine).toHaveCount(1);
  await mine.getByRole('button', { name: 'Remove' }).click();
  await expect(drawer.getByTestId('duty-waits-on')).toHaveCount(before);
  await page.keyboard.press('Escape');

  // 5. The client's sale, linked from the purchase. When its closing slips past the purchase's, both say so.
  const { dealId: saleId } = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'listing',
    name: 'Smith sale',
    stage: 'under_contract',
    clientPersonId: jamie.personId,
    newPropertyAddress: '88 Elm Dr, Austin, TX 78702',
  });
  const saleClosing = await run<{ entryId: string }>('realestate.term.enter', {
    dealId: saleId,
    key: 'closing',
    date: '2026-11-02',
  });
  await page.goto(dealUrl);
  await page.getByTestId('deal-link-open').click();
  await page.getByTestId('deal-link-search').fill('Smith sale');
  await page.getByTestId('deal-link-pick').first().click();
  await page.getByTestId('deal-link-save').click();
  const linked = page.getByTestId('deal-linked');
  await expect(linked).toContainText('Linked: their sale');
  await expect(linked).toContainText('Nov 2');
  await expect(page.getByTestId('deal-linked-problems')).toHaveCount(0);
  await run('realestate.term.enter', {
    dealId: saleId,
    key: 'closing',
    date: '2026-11-06',
    replaces: saleClosing.entryId,
  });
  await page.goto(`/app/w/${workspaceId}/a/realestate/deals/${saleId}`);
  await expect(page.getByTestId('deal-linked-problems')).toContainText(
    /Their purchase, Smith purchase, closes \w{3}, Nov 4, before this sale closes \(\w{3}, Nov 6\)\./,
  );
  await page.goto(dealUrl);
  await expect(page.getByTestId('deal-linked')).toContainText('Nov 6');
  await expect(page.getByTestId('deal-key-dates')).toContainText('sale closes Nov 6');

  // 6. Coordinate: the purchase's lender is waited on; the Waiting room lists it, and Chased moves the chase on.
  const lender = got.duties.find((d) => d.status === 'not_started' && d.dutyId !== waits)!;
  await page.goto(`${dealUrl}?duty=${lender.dutyId}`);
  await drawer.getByRole('button', { name: 'Waiting on…' }).click();
  await drawer.getByLabel('Waiting on').fill('First Texas Mortgage');
  await drawer.getByTestId('duty-waiting-form').getByRole('button', { name: 'Save' }).click();
  await expect(drawer.getByTestId('duty-waiting')).toContainText('Waiting on First Texas Mortgage');
  await page.goto(`${coordinate}?tab=waiting`);
  const item = page.getByTestId('waiting-item').filter({ hasText: lender.title });
  await expect(item).toContainText('Waiting on First Texas Mortgage');
  await item.getByTestId('waiting-chased').click();
  await expect(page.getByText('Noted. Chase them again in two business days.')).toBeVisible();
  await item.getByTestId('waiting-came-in').click();
  await expect(page.getByTestId('waiting-item').filter({ hasText: lender.title })).toHaveCount(0);

  // 7. A duty two days overdue is at risk; a business day on with nobody acknowledging it, it's escalated.
  const late = got.duties.find(
    (d) => d.status === 'not_started' && d.dutyId !== waits && d.dutyId !== lender.dutyId,
  )!;
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  await run('realestate.duty.set_due', {
    dutyId: late.dutyId,
    date: twoDaysAgo,
    reason: 'The lender wanted it sooner.',
    clear: false,
  });
  await sweep();
  await page.goto(coordinate);
  await expect(page.getByTestId('coordinate-overdue')).toContainText(late.title);
  const aged = await fetch(`${WORKER}/test/realestate/at-risk-since`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, dutyId: late.dutyId, hours: 120 }),
  });
  expect(aged.status).toBe(200);
  await sweep();
  await page.goto(coordinate);
  const risk = page.getByTestId('coordinate-risk').filter({ hasText: late.title });
  await expect(risk).toContainText('Escalated');
  await expect(risk).toContainText('nobody acknowledged it');
  await risk.getByTestId('coordinate-ack').click();
  await expect(page.getByText('Acknowledged. Its alerts stop climbing.')).toBeVisible();
  await expect(page.getByTestId('coordinate-risk').filter({ hasText: late.title })).toHaveCount(0);
});
