import { expect, test, type Page } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, linkFrom, signUpAndConfirm, uniqueEmail, waitForMail } from './helpers';
import { textPdf, turnOnRealestate } from './realestate-helpers';

/** Loads the page again until the test id shows: what the worker brings comes a moment later. */
async function reloadUntil(page: Page, testId: string, timeout = 60_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const shown = await page
      .getByTestId(testId)
      .first()
      .waitFor({ state: 'visible', timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (shown) return;
    if (Date.now() > end) throw new Error(`${testId} never showed`);
    await page.goto(page.url());
  }
}

/**
 * Real Estate Agent, round five (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round five: Ecosystem"), against
 * the worker's stand-ins (`ADDON_CONNECTORS=fake`): the stand-in MLS, DocuSign and their sign-in pages.
 *
 * 1. Connections: HandsFreeOS's Repliers account, turned on by staff; the business's own AnyProp key, tried before
 *    it's kept (a wrong one is turned down), then let go; DocuSign signed in to.
 * 2. A home from the MLS, found while typing, comes with what the MLS says; a buyer's saved search brings new matches
 *    at once, and one is sent to the client; a CMA finds comps from the MLS.
 * 3. A document goes for signing through DocuSign: the agent sends it there, the signers sign, and the signed copy
 *    comes back to Documents, signed and locked.
 * 4. A buyer's agent asks for a showing on the listing's page; the seller says yes in their portal, and the agent's
 *    Showings says it's confirmed.
 * 5. A vendor is added and approved, and picked on the duty that needs one.
 */
test('connections, the MLS, e-sign, showings and vendors', async ({ page, browser }) => {
  test.setTimeout(900_000);
  const business = 'Hill Country Realty';
  const { email } = await signUpAndConfirm(page, 'realestate-ecosystem');
  const workspaceId = await createBusiness(page, { name: business });
  await turnOnRealestate(page, email, workspaceId);
  const { token } = await signInOwner(email);
  const run = <T = Record<string, string>>(name: string, input: Record<string, unknown>) =>
    api<T>(token, 'commands', name, { workspaceId, ...input });
  const ask = <T = Record<string, unknown>>(name: string, input: Record<string, unknown>) =>
    api<T>(token, 'queries', name, { workspaceId, ...input });
  const base = `/app/w/${workspaceId}/a/realestate`;
  page.on('dialog', (d) => void d.accept());

  // 1. Connections. HandsFreeOS staff turn on its own Repliers account here (the owner is staff, from handing the
  // add-on over).
  await run('addon_connection.platform', {
    addonId: 'realestate',
    connector: 'listing_data',
    provider: 'repliers',
    on: true,
  });
  await page.goto(`${base}/settings?tab=connections`);
  const listing = page.getByTestId('connector-listing_data');
  await expect(listing.getByTestId('connection-repliers')).toContainText(
    'HandsFreeOS’s Repliers account',
  );
  await listing.getByTestId('own-account-listing_data').click();
  await page.getByTestId('key-provider-anyprop').click();
  await page.getByTestId('key-field-username').fill('data@hillcountryrealty.com');
  await page.getByTestId('key-field-password').fill('a wrong password');
  await page.getByTestId('key-save').click();
  await expect(page.getByText(/turned that down/)).toBeVisible();
  await page.getByTestId('key-field-password').fill('the right password');
  await page.getByTestId('key-save').click();
  await expect(listing.getByTestId('connection-anyprop')).toContainText('Connected');
  await listing.getByTestId('disconnect-anyprop').click();
  await expect(page.getByText('AnyProp is disconnected.')).toBeVisible();
  await expect(listing.getByTestId('connection-anyprop')).toHaveCount(0);
  // DocuSign, signed in to on the stand-in's page.
  await page.getByTestId('signin-docusign').click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByTestId('signin-back')).toContainText('DocuSign is connected');
  await expect(page.getByTestId('connection-docusign')).toContainText('Connected');

  // 2. The MLS on a buyer deal.
  const linh = await run<{ personId: string }>('person.create', {
    firstName: 'Linh',
    lastName: 'Nguyen',
    email: uniqueEmail('linh'),
  });
  const buyer = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'buyer',
    name: 'Nguyen purchase',
    clientPersonId: linh.personId,
  });
  await run('realestate.buyer_profile.save', {
    dealId: buyer.dealId,
    profile: { budgetMaxCents: 90_000_000, areas: ['78704', '78745'], bedsMin: 2 },
  });
  const deal = `${base}/deals/${buyer.dealId}`;
  await page.goto(`${deal}/homes?add=1`);
  await page.getByTestId('mls-search').fill('1000 Elm');
  await expect(page.getByTestId('mls-hit').first()).toContainText('1000 Elm St');
  await expect(page.getByTestId('mls-pick')).toContainText('Found on the MLS');
  await expect(page.getByTestId('mls-pick').getByTestId('mls-notice')).toContainText(
    'Stand-in MLS',
  );
  await page.getByTestId('mls-add').click();
  await reloadUntil(page, 'home-mls');
  await expect(page.getByTestId('home-mls')).toContainText('Found on the MLS');
  // The saved search asked at once: new matches wait for the agent; one goes to the client.
  await page.goto(`${deal}/homes`);
  await reloadUntil(page, 'homes-matches');
  await page.goto(`${deal}/matches`);
  await expect(page.getByTestId('buyer-search')).toContainText('The search is on');
  await page.getByTestId('match-send').first().click();
  await expect(page.getByText('Sent to Linh.')).toBeVisible();
  await expect(page.getByTestId('matches-tab-sent')).toHaveText('Sent · 1');
  // Comps from the MLS on a CMA of the home.
  const homes = await ask<{ homes: { id: string }[] }>('realestate.homes', {
    dealId: buyer.dealId,
  });
  const { cmaId } = await run<{ cmaId: string }>('realestate.cma.start', {
    dealId: buyer.dealId,
    homeId: homes.homes[0]!.id,
  });
  await page.goto(`${deal}/cma/${cmaId}`);
  await page.getByTestId('cma-find-comps').click();
  await page.getByTestId('cma-find-go').click();
  await expect(page.getByTestId('cma-comps')).toContainText('From the MLS', { timeout: 60_000 });

  // 3. E-sign through DocuSign.
  const jamie = await run<{ personId: string }>('person.create', {
    firstName: 'Jamie',
    lastName: 'Smith',
    email: uniqueEmail('jamie'),
  });
  const smith = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'buyer',
    name: 'Smith purchase',
    stage: 'under_contract',
    clientPersonId: jamie.personId,
    newPropertyAddress: '123 Main St, Austin, TX 78723',
  });
  await page.goto(`${base}/deals/${smith.dealId}/documents`);
  await page.getByTestId('add-document').click();
  await page.getByTestId('document-file-input').setInputFiles({
    name: 'amendment-2.pdf',
    mimeType: 'application/pdf',
    buffer: textPdf([['AMENDMENT 2', 'Seller repairs the HVAC before closing.']]),
  });
  await page.getByTestId('document-kind').selectOption('other');
  await page.getByLabel('Title (optional)').fill('Amendment 2');
  await page.getByTestId('document-save').click();
  const row = page.getByRole('row', { name: /Amendment 2/ });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: /More for/ }).click();
  await page.getByRole('menuitem', { name: 'Send for signing…' }).click();
  await expect(page.getByTestId('esign-signer')).toHaveCount(1);
  await page.getByTestId('esign-send').click();
  await expect(page.getByTestId('esign-open')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('esign-open').click();
  // At the stand-in DocuSign: the agent sends it, and back on Documents it's out for signing.
  await page.getByTestId('standin-esign-send').click();
  await expect(page.getByTestId('esign-remind')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('esign-remind').click();
  await expect(page.getByText('DocuSign emailed whoever hasn’t signed yet.')).toBeVisible();
  // The signers sign; the signed copy comes back as the document's newer version, signed and locked.
  await page.getByTestId('esign-open').click();
  await page.getByTestId('standin-esign-sign').click();
  await page.getByTestId('standin-esign-back').click();
  await reloadUntil(page, 'documents-table');
  await expect(page.getByTestId('documents-table')).toContainText('Signed · kept', {
    timeout: 60_000,
  });

  // 4. A showing asked for on the listing's page, and the seller's yes.
  await run('booking_site.update', { slug: `e2e-${Date.now().toString(36)}`, name: business });
  const mariaEmail = uniqueEmail('maria');
  const maria = await run<{ personId: string }>('person.create', {
    firstName: 'Maria',
    lastName: 'Alvarez',
    email: mariaEmail,
  });
  const alvarez = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'listing',
    name: 'Alvarez listing',
    stage: 'pre_listing',
    clientPersonId: maria.personId,
    newPropertyAddress: '2207 Juniper Trail, Austin, TX 78745',
  });
  const listingId = alvarez.dealId;
  await run('realestate.listing.confirm_facts', {
    dealId: listingId,
    facts: { beds: 4, baths: 3, sqft: 2340 },
  });
  await run('realestate.listing.description.save', {
    dealId: listingId,
    words:
      'Four bedrooms and three baths on a quiet street. The kitchen was redone in 2021, and the patio sits under live oaks.',
  });
  const got = await ask<{ listing: { description: { working: { id: string } } } }>(
    'realestate.listing',
    { dealId: listingId },
  );
  await expect
    .poll(
      () =>
        run('realestate.listing.description.let_through', {
          descriptionId: got.listing.description.working.id,
          reason: 'Maria signed the description on paper at the listing appointment.',
        }).then(
          () => true,
          () => false,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  await run('realestate.listing.mark_live', {
    dealId: listingId,
    mlsNumber: '4821937',
    liveOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  });
  await run('realestate.listing.page_publish', { dealId: listingId });
  await page.goto(`${base}/deals/${listingId}/showings`);
  await page.getByTestId('showings-settings').click();
  // Taking requests on the listing's page is on unless the agent turns it off.
  await expect(page.getByTestId('showings-open')).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Access instructions').fill('Lockbox on the back door, code 4417.');
  await page.getByTestId('showings-save').click();
  await expect(page.getByTestId('showings-how')).toContainText('Sent 1 hour before');
  const { requestPath } = await ask<{ requestPath: string }>('realestate.showing.list', {
    dealId: listingId,
  });
  const outside = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const v = await outside.newPage();
  await v.goto(requestPath);
  await v.getByTestId('showing-day').nth(1).click();
  await v.getByTestId('showing-time').first().click();
  await v.getByTestId('showing-name').fill('Ana Ruiz');
  await v.getByTestId('showing-brokerage').fill('Compass');
  await v.getByTestId('showing-license').fill('0712345');
  await v.getByTestId('showing-email').fill(uniqueEmail('ana'));
  await v.getByTestId('showing-ask').click();
  await expect(v.getByTestId('showing-requested')).toContainText('once the seller answers');
  await outside.close();
  await page.goto(`${base}/deals/${listingId}/showings`);
  await expect(page.getByTestId('showings-table')).toContainText('Waiting on Maria');
  // Maria says yes in her portal.
  await page.goto(`${base}/deals/${listingId}/client-tasks`);
  await page.getByTestId('portal-invite').click();
  const invited = Date.now();
  await page.getByTestId('invite-send').click();
  const invite = await waitForMail(mariaEmail, `Your private portal with ${business}`, {
    after: invited,
  });
  const link = linkFrom(invite.text, /http:\/\/localhost:3000\/c\/[A-Za-z0-9_.~-]+/);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const m = await phone.newPage();
  await m.goto(link);
  const asked = Date.now();
  await m.getByTestId('portal-send-code').click();
  const code = await waitForMail(mariaEmail, `Your ${business} code`, { after: asked });
  await m.getByTestId('portal-digit-0').fill(/\b(\d{6})\b/.exec(code.text)![1]!);
  await expect(m.getByTestId('portal-home')).toBeVisible();
  await m.goto(`${link.replace(/\/$/, '')}/a/realestate/deals/${listingId}`);
  await m.getByTestId('portal-showings-answer').click();
  await m.getByTestId('portal-showing-yes').click();
  await expect(m.getByTestId('portal-showing-request')).toHaveCount(0);
  await phone.close();
  await page.goto(`${base}/deals/${listingId}/showings`);
  await expect(page.getByTestId('showings-table')).toContainText('Confirmed');

  // 5. A vendor added, approved, and picked on the duty that needs one.
  await page.goto(`${base}/vendors`);
  await page.getByTestId('vendor-add').click();
  await page.getByTestId('vendor-name').fill('Lone Star Inspections');
  await page.getByTestId('vendor-service-inspection').click();
  await page.getByTestId('vendor-save').click();
  const vendor = page.getByTestId('vendor-Lone Star Inspections');
  await vendor.getByTestId('vendor-approve').click();
  await expect(vendor).toContainText('Approved');
  const duties = await ask<{ duties: { dutyId: string; title: string }[] }>(
    'realestate.duty.list',
    { dealId: smith.dealId, mine: false, status: 'open', limit: 500 },
  );
  const duty = duties.duties.find((d) => d.title === 'Recommend inspectors and vendors')!;
  await page.goto(`${base}/deals/${smith.dealId}?duty=${duty.dutyId}`);
  await expect(page.getByTestId('duty-vendor-fit')).toContainText('Lone Star Inspections');
  await page.getByTestId('duty-vendor-pick').click();
  await expect(page.getByTestId('duty-vendor-picked')).toContainText('Lone Star Inspections');
});
