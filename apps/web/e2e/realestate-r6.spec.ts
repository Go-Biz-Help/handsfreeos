import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, signInOwner, WORKER } from './booking-helpers';
import {
  confirmEmail,
  createBusiness,
  linkFrom,
  signUp,
  signUpAndConfirm,
  uniqueEmail,
  waitForMail,
} from './helpers';
import { turnOnRealestate } from './realestate-helpers';

/**
 * Real Estate Agent, round six on the web (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round six: The phone and
 * the finish"; boards 91 and 93), against the local stack and the worker's stand-ins.
 *
 * 1. A deal goes on legal hold from its More menu, with a reason; its page says so. Deal settings → Keeping records
 *    keeps closed deals longer and lists the hold, which is lifted there with a reason.
 * 2. The whole transaction is exported from the deal; Documents lists it making, then ready with Download.
 * 3. Field notes and the walkthrough, made as the phone would make them, show read-only on the deal page.
 * 4. Settings → Safety: the business's times, and what each person sees.
 * 5. A teammate checks in and doesn't check out: their own Safety page shows the check-in, and the owner (told,
 *    since the teammate picked nobody) answers the alert with I reached them.
 * 6. A safety contact's link that doesn't work says so.
 */
test('legal holds, keeping records, the export, field notes and check-ins', async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  const business = 'Hill Country Realty';
  const { email } = await signUpAndConfirm(page, 'realestate-r6');
  const workspaceId = await createBusiness(page, { name: business });
  await turnOnRealestate(page, email, workspaceId);
  const { token } = await signInOwner(email);
  const run = <T = Record<string, string>>(name: string, input: Record<string, unknown>) =>
    api<T>(token, 'commands', name, { workspaceId, ...input });
  const ask = <T = Record<string, unknown>>(name: string, input: Record<string, unknown>) =>
    api<T>(token, 'queries', name, { workspaceId, ...input });
  const base = `/app/w/${workspaceId}/a/realestate`;

  const jamie = await run<{ personId: string }>('person.create', {
    firstName: 'Jamie',
    lastName: 'Smith',
    email: uniqueEmail('jamie'),
  });
  const { dealId } = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'buyer',
    name: 'Smith purchase',
    stage: 'under_contract',
    clientPersonId: jamie.personId,
    newPropertyAddress: '123 Main St, Austin, TX 78723',
  });
  const deal = `${base}/deals/${dealId}`;

  // 1. A legal hold, placed from the deal.
  await page.goto(deal);
  await page.getByTestId('deal-more').click();
  await page.getByTestId('deal-place-hold').click();
  await page.getByTestId('reason-input').fill('Dispute over the earnest money');
  await page.getByTestId('reason-submit').click();
  const banner = page.getByTestId('deal-hold');
  await expect(banner).toContainText('On legal hold since');
  await expect(banner).toContainText('“Dispute over the earnest money.”');
  await expect(banner).toContainText('new ones can be added');

  // Keeping records: the years, and the hold, lifted with a reason.
  await page.goto(`${base}/settings?tab=records`);
  await expect(page.getByTestId('settings-tab-safety')).toBeVisible();
  const years = page.getByTestId('keep-years');
  await expect(years).toHaveValue('7');
  await years.fill('0');
  await expect(page.getByText('Keep closed deals at least 1 year.')).toBeVisible();
  await years.fill('10');
  await page.getByTestId('keep-save').click();
  await expect(page.getByText('Closed deals are kept 10 years after they end.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('keep-years')).toHaveValue('10');
  const holds = page.getByTestId('legal-holds');
  await expect(holds).toContainText('Legal holds · 1');
  await expect(holds.getByTestId(`legal-hold-${dealId}`)).toContainText('Smith purchase');
  await holds.getByTestId(`lift-hold-${dealId}`).click();
  await page.getByTestId('reason-input').fill('Settled with both sides');
  await page.getByTestId('reason-submit').click();
  await expect(holds).toContainText('Legal holds · 0');
  await page.goto(deal);
  await expect(page.getByTestId('deal-hold')).toHaveCount(0);

  // 2. The whole transaction, exported: Documents shows it making, then ready.
  await page.getByTestId('deal-more').click();
  await page.getByTestId('deal-export').click();
  await page.getByTestId('export-go').click();
  await expect(page).toHaveURL(new RegExp(`${deal}/documents`));
  const exports = page.getByTestId('deal-exports');
  await expect(exports.getByTestId('export-state').first()).toHaveText('Ready', {
    timeout: 120_000,
  });
  await expect(exports).toContainText('every file’s fingerprint checked');
  await expect(exports).toContainText('Smith purchase transaction');
  await expect(exports.getByTestId('export-download')).toBeVisible();

  // 3. Field notes and the walkthrough, made as the phone makes them, read on the web.
  await run('realestate.field_note.add', {
    dealId,
    id: randomUUID(),
    aboutKind: 'deal',
    body: 'Buyers loved the kitchen; asked about the roof’s age.',
  });
  await run('realestate.walkthrough.plan', { dealId, id: randomUUID() });
  const { walkthrough } = await ask<{
    walkthrough: { id: string; items: { id: string; title: string }[] };
  }>('realestate.walkthrough', { dealId });
  const garage = walkthrough.items.find((i) => i.title === 'Garage')!;
  await run('realestate.walkthrough.start', { walkthroughId: walkthrough.id });
  await run('realestate.walkthrough.check_item', {
    itemId: garage.id,
    state: 'not_ok',
    note: 'Door stops a foot short.',
  });
  await page.goto(deal);
  await expect(page.getByTestId('deal-field-notes')).toContainText('Buyers loved the kitchen');
  const walk = page.getByTestId('deal-walkthrough');
  await expect(walk).toContainText('Under way');
  await expect(walk.getByTestId(`walkthrough-item-${garage.id}`)).toContainText('Not right');
  await expect(walk).toContainText('Door stops a foot short.');

  // 4. Settings → Safety.
  await page.goto(`/app/w/${workspaceId}/settings/safety`);
  await page.getByTestId('safety-ask').fill('5');
  await expect(page.getByTestId('safety-preview')).toContainText('5 minutes');
  await page.getByTestId('safety-save').click();
  await expect(page.getByText('Check-ins use these times from now on.')).toBeVisible();

  // 5. A teammate joins, checks in and doesn't check out.
  const mate = uniqueEmail('r6-mate');
  const started = Date.now();
  await run('membership.invite', { email: mate, role: 'member' });
  const mail = await waitForMail(mate, `invited you to ${business}`, { after: started });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const priya = await ctx.newPage();
  await signUp(priya, { name: 'Priya Natarajan', email: mate });
  await confirmEmail(priya, mate);
  await priya.goto(link);
  await priya.getByTestId('accept-invite').click();
  await expect(priya).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
  const priyaToken = (await signInOwner(mate)).token;
  const checkInId = randomUUID();
  await api(priyaToken, 'commands', 'safety.check_in', {
    workspaceId,
    id: checkInId,
    place: '2207 Juniper Trail',
    plannedEndAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  await priya.goto(`/app/w/${workspaceId}/safety`);
  await expect(priya.getByTestId('my-check-in')).toContainText('Checked in · 2207 Juniper Trail');
  await expect(priya.getByTestId('my-contacts')).toContainText('Nobody yet');
  await expect(priya.getByTestId('my-times')).toContainText('5 minutes');

  // The ladder, as time would run it: ask Priya, then tell whoever's told (the owner: she picked nobody).
  let told = false;
  for (let i = 0; i < 20 && !told; i++) {
    await page.request.post(`${WORKER}/test/scheduled-jobs/run-due`, {
      data: { workspaceId, dedupeKeys: [`safety:${checkInId}`] },
    });
    const { alert } = await ask<{ alert: unknown }>('safety.alert', { checkInId });
    told = alert !== null;
    if (!told) await page.waitForTimeout(1000);
  }
  expect(told).toBe(true);
  await page.goto(`/app/w/${workspaceId}/safety/${checkInId}`);
  await expect(page.getByTestId('safety-alert-title')).toHaveText('Priya hasn’t checked out');
  await expect(page.getByTestId('safety-alert')).toContainText('2207 Juniper Trail');
  await page.getByTestId('safety-reached').click();
  await expect(page.getByTestId('safety-alert-over')).toContainText('Thanks. Priya is OK');
  await page.reload();
  await expect(page.getByTestId('safety-alert-over')).toContainText('Nothing to answer here');
  await ctx.close();

  // 6. A contact's link that doesn't work.
  await page.goto('/s/abcdefghijklmnopqrstuvwx');
  await expect(page.getByTestId('safety-link-missing')).toContainText('This link doesn’t work');
});
