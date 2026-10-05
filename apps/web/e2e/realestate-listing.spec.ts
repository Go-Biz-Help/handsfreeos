import { expect, test, type Page } from '@playwright/test';
import { api, makeCalendar, signInOwner } from './booking-helpers';
import { createBusiness, linkFrom, signUpAndConfirm, uniqueEmail, waitForMail } from './helpers';
import { samplePng, turnOnRealestate } from './realestate-helpers';

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));

/**
 * Real Estate Agent, round three (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core"): a
 * listing from the agent's screens to the seller's portal and a signed-out visitor.
 *
 * 1. The seller answers the questions about their home in their portal; the old listing is pasted; where they
 *    disagree the agent picks, then confirms the facts.
 * 2. The description is flagged for fair housing, fixed, and signed off by the seller in their portal.
 * 3. Publishing waits until it's live on the MLS; marked live, the page goes up and a visitor sees it and a photo.
 * 4. A visitor signs in at the open house and agrees to texts; the host sees them.
 * 5. A new price is signed off in the portal and shows on the page.
 * 6. One of our buyers whose search fits gets the listing suggested, and their agent adds it.
 * 7. Two offers side by side with what the seller would take home; the seller picks one in the portal; the agent
 *    records it.
 */
test('a listing from the agent’s screens to the seller’s portal and the public page', async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  const business = 'Hill Country Realty';
  const { email } = await signUpAndConfirm(page, 'realestate-listing');
  const workspaceId = await createBusiness(page, { name: business });
  await turnOnRealestate(page, email, workspaceId);

  // The owner works every hour, open houses go on Showings, and Maria Alvarez is selling.
  const { token, userId } = await signInOwner(email);
  const run = <T = Record<string, string>>(name: string, input: Record<string, unknown>) =>
    api<T>(token, 'commands', name, { workspaceId, ...input });
  await run('schedule.set', { ownerId: userId, weekly: ALL_WEEK });
  await makeCalendar({ token, userId, workspaceId, site: '', business }, 'Showings');
  const mariaEmail = uniqueEmail('maria');
  const maria = await run<{ personId: string }>('person.create', {
    firstName: 'Maria',
    lastName: 'Alvarez',
    email: mariaEmail,
  });
  const { dealId } = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'listing',
    name: 'Alvarez listing',
    stage: 'pre_listing',
    clientPersonId: maria.personId,
    newPropertyAddress: '2207 Juniper Trail, Austin, TX 78745',
  });
  await run('realestate.term.enter', {
    dealId,
    key: 'list_price',
    cents: 54_900_000,
    source: 'agreement',
  });
  const dealUrl = `/app/w/${workspaceId}/a/realestate/deals/${dealId}`;

  // 1. The agent asks Maria about her home and invites her to the portal; she answers on her phone.
  await page.goto(`${dealUrl}/facts`);
  await page.getByTestId('facts-ask-seller').click();
  await expect(page.getByText('Waiting for Maria’s answers in their portal.')).toBeVisible();
  await page.goto(`${dealUrl}/client-tasks`);
  await page.getByTestId('portal-invite').click();
  const invited = Date.now();
  await page.getByTestId('invite-send').click();
  await expect(page.getByText(`Sent to ${mariaEmail}.`)).toBeVisible();
  const invite = await waitForMail(mariaEmail, `Your private portal with ${business}`, {
    after: invited,
  });
  const link = linkFrom(invite.text, /http:\/\/localhost:3000\/c\/[A-Za-z0-9_.~-]+/);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const m = await phone.newPage();
  await m.goto(link);
  const asked = Date.now();
  await m.getByTestId('portal-send-code').click();
  const codeMail = await waitForMail(mariaEmail, `Your ${business} code`, { after: asked });
  await m.getByTestId('portal-digit-0').fill(/\b(\d{6})\b/.exec(codeMail.text)![1]!);
  await expect(m.getByTestId('portal-home')).toContainText('Hi Maria');
  const portal = link.replace(/\/$/, '');
  const mariaDeal = async () => {
    await m.goto(`${portal}/a/realestate/deals/${dealId}`);
    await expect(m.getByTestId('portal-listing')).toContainText('Selling 2207 Juniper Trail');
  };
  await mariaDeal();
  await m.getByTestId('portal-questionnaire-open').click();
  await m.getByTestId('q-beds').fill('4');
  await m.getByTestId('q-sqft').fill('2,400');
  await m.getByTestId('q-updates').fill('New kitchen in 2021. Roof replaced 2019.');
  await m.getByTestId('q-loves').fill('The patio under the oaks in the evening.');
  await m.getByTestId('q-send').click();
  await expect(m.getByText('Sent to Test. Thank you!')).toBeVisible();

  // The old listing is pasted; it says 2,340 sq ft where Maria said 2,400, so the agent picks.
  await page.goto(`${dealUrl}/facts`);
  await expect(page.getByTestId('facts-seller-words')).toContainText('patio under the oaks');
  await page.getByTestId('facts-paste').click();
  await page
    .getByTestId('facts-paste-text')
    .fill(
      'Light-filled 4 bed, 3 bath home in South Austin with 2,340 sq ft of living space. Built in 2004. HOA $45 a month.',
    );
  await page.getByTestId('facts-paste-save').click();
  const conflict = page.getByTestId('facts-conflict-sqft');
  await expect(conflict).toBeVisible({ timeout: 60_000 });
  await conflict.getByRole('button', { name: /2,340/ }).click();
  await page.getByTestId('facts-confirm').click();
  await expect(page.getByText('Confirmed. These are the facts')).toBeVisible();

  // 2. The AI drafts the description; the agent's own words are flagged, fixed, and sent to Maria to sign off.
  await page.goto(`${dealUrl}/description`);
  await page.getByTestId('description-request').click();
  await expect(page.getByTestId('description-working')).toContainText('Welcome to', {
    timeout: 60_000,
  });
  const write = async (words: string) => {
    await page.getByTestId('description-edit').click();
    await page.getByTestId('description-text').fill(words);
    await page.getByTestId('description-save').click();
  };
  await write(
    'Four bedrooms and three baths on a quiet street, perfect for a family. The kitchen was redone in 2021.',
  );
  await expect(page.getByTestId('description-flags')).toContainText('perfect for a family');
  await expect(page.getByTestId('description-send')).toBeDisabled();
  await write(
    'Four bedrooms and three baths on a quiet street. The kitchen was redone in 2021, and the patio sits under live oaks.',
  );
  await expect(page.getByTestId('description-send')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('description-send').click();
  await expect(page.getByText('Sent. It’s on Maria’s to-do')).toBeVisible();
  const signOff = async (words: RegExp) => {
    await mariaDeal();
    await m.getByTestId('portal-sign-off-open').first().click();
    await expect(m.getByTestId('portal-sign-off-words')).toContainText(words);
    await m.getByTestId('portal-sign-off-agree').check();
    await m.getByTestId('portal-sign-off').click();
    await expect(m.getByText('Signed off. Test can see it.')).toBeVisible();
  };
  await signOff(/patio sits under live oaks/);
  await page.goto(`${dealUrl}/description`);
  await expect(page.getByTestId('description-in-use')).toContainText('patio sits under live oaks');

  // 3. Nothing public before it's live on the MLS: the page can't go up.
  await page.goto(`${dealUrl}/photos`);
  await page.getByTestId('photos-upload-input').setInputFiles([
    {
      name: 'front.png',
      mimeType: 'image/png',
      buffer: samplePng(320, 200, [176, 196, 222], [92, 120, 88]),
    },
  ]);
  await expect(page.getByTestId('photo-tile')).toHaveCount(1, { timeout: 30_000 });
  await page.goto(`${dealUrl}/marketing`);
  await expect(page.getByTestId('marketing-hold')).toContainText('isn’t live on the MLS yet');
  await expect(
    run('realestate.listing.page_publish', { dealId }).catch((e: Error) => e.message),
  ).resolves.toContain('realestate_not_on_mls');
  // Marked live, the page goes up.
  await page.getByTestId('marketing-mark-live').click();
  await page.getByTestId('mark-live-number').fill('4821937');
  await page.getByTestId('mark-live-submit').click();
  await expect(page.getByText('It’s live, and the deal moved to Active')).toBeVisible();
  await page.getByTestId('marketing-publish').click();
  const pageLink = page.getByTestId('marketing-page-link');
  await expect(pageLink).toBeVisible();
  const listingPath = new URL((await pageLink.getAttribute('href'))!).pathname;

  // A signed-out visitor sees the page and its photo.
  const outside = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const v = await outside.newPage();
  await v.goto(listingPath);
  await expect(v.getByTestId('public-listing')).toContainText('2207 Juniper Trail');
  await expect(v.getByTestId('public-price')).toHaveText('$549,000');
  await expect(v.locator('[data-testid="public-listing"] img').first()).toHaveAttribute(
    'src',
    /^https?:/,
  );

  // 4. An open house starting soon; a visitor signs in from the page and agrees to texts; the host sees them.
  const soon = new Date(Math.ceil((Date.now() + 10 * 60_000) / (15 * 60_000)) * 15 * 60_000);
  await run('realestate.open_house.plan', {
    dealId,
    startsAt: soon.toISOString(),
    durationMinutes: 120,
    acknowledgeWarnings: true,
  });
  await v.reload();
  await v.getByRole('link', { name: 'Sign in' }).click();
  await expect(v.getByTestId('open-house-form')).toBeVisible();
  await v.getByTestId('oh-first').fill('Kayla');
  await v.getByTestId('oh-phone').fill('(512) 555-0187');
  await v.getByTestId('public-sms-consent').check();
  await v.getByTestId('oh-sign-in').click();
  await expect(v.getByTestId('open-house-signed-in')).toContainText('Thanks, Kayla!');
  await page.goto(`${dealUrl}/open-houses`);
  const visitor = page.getByTestId('open-house-visitor');
  await expect(visitor).toContainText('Kayla');
  await expect(visitor).toContainText('Yes');

  // 5. A lower price goes to Maria; once she signs, it's the price on the page.
  await page.goto(`${dealUrl}/price?change=1`);
  await page.getByTestId('price-new').fill('539,000');
  await page.getByTestId('price-send').click();
  await expect(page.getByTestId('price-waiting')).toBeVisible();
  await signOff(/from \$549,000 to \$539,000/);
  await page.goto(`${dealUrl}/price`);
  await expect(page.getByTestId('price-history')).toContainText('Signed off by Maria');
  await v.goto(listingPath);
  await expect(v.getByTestId('public-price')).toHaveText('$539,000');

  // 6. One of our buyers wants three bedrooms in Austin under $560,000: the listing is suggested on their deal.
  const linh = await run<{ personId: string }>('person.create', {
    firstName: 'Linh',
    lastName: 'Nguyen',
    email: uniqueEmail('linh'),
  });
  const buyer = await run<{ dealId: string }>('realestate.deal.open', {
    side: 'buyer',
    name: 'Nguyen purchase',
    stage: 'representation',
    clientPersonId: linh.personId,
  });
  await run('realestate.buyer_profile.save', {
    dealId: buyer.dealId,
    profile: { budgetMaxCents: 56_000_000, areas: ['Austin'], bedsMin: 3 },
  });
  const buyerUrl = `/app/w/${workspaceId}/a/realestate/deals/${buyer.dealId}`;
  await expect(async () => {
    await page.goto(buyerUrl);
    await expect(page.getByTestId('suggestion')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('suggestion')).toContainText('2207 Juniper Trail');
  await page.getByTestId('suggestion-add').click();
  await expect(page.getByText('Added to their homes.')).toBeVisible();
  await page.goto(`${buyerUrl}/homes`);
  await expect(page.getByText('2207 Juniper Trail')).toBeVisible();

  // 7. Two offers side by side, with what Maria would take home from each.
  const by = new Date(Date.now() + 30 * 3_600_000).toISOString();
  await run('realestate.offer.start', {
    dealId,
    buyerNames: 'Wei Chen',
    theirAgentName: 'Ana Ruiz',
    terms: { priceCents: 53_500_000, loanType: 'cash', buyerAgentFeeBp: 200 },
    respondBy: by,
  });
  await run('realestate.offer.start', {
    dealId,
    buyerNames: 'Jordan & Priya Patel',
    theirAgentName: 'Sam Cole',
    terms: {
      priceCents: 54_100_000,
      sellerCreditCents: 1_500_000,
      loanType: 'conventional',
      financingDays: 21,
      buyerAgentFeeBp: 300,
    },
    respondBy: by,
  });
  await page.goto(`${dealUrl}/net-sheet`);
  await page.getByTestId('net-payoff').fill('212,400');
  await page.getByTestId('net-fee').fill('3');
  await page.getByTestId('net-save').click();
  await expect(page.getByText('Saved. The estimates use these figures now.')).toBeVisible();
  // $535,000 less 3%, their 2% and the payoff is $295,850; $541,000 less 3%, their 3%, a $15,000 credit and the
  // payoff is $281,140.
  await page.goto(`${dealUrl}/offers`);
  await expect(page.getByTestId('offers-best')).toHaveText('about $295,850');
  await expect(page.getByTestId('offers-compare')).toContainText('about $281,140');
  await page.getByTestId('offers-share').click();
  await expect(page.getByText('Shared. Maria sees them side by side')).toBeVisible();

  // Maria picks the cash offer in her portal; the agent sees it and records the acceptance.
  await m.goto(`${portal}/a/realestate/deals/${dealId}/offers`);
  const cash = m.getByTestId('portal-offer').filter({ hasText: 'Wei Chen' });
  await expect(cash).toContainText('$295,850');
  await cash.getByTestId('portal-offer-accept').click();
  await cash.getByTestId('portal-offer-words').fill('The cash one, please. Fewer surprises.');
  await cash.getByTestId('portal-offer-send').click();
  await expect(m.getByText('Sent. Test will be in touch.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('offers-choice')).toContainText('Maria: Accept the Wei Chen offer');
  await answerFirst(page);
  await expect(page.getByText('Accepted. Confirm its dates under Key dates.')).toBeVisible();
  await v.goto(listingPath);
  await expect(v.getByTestId('public-listing')).toContainText('Under contract');

  await phone.close();
  await outside.close();
});

/** Records "Accepted" on the first column's offer, the cash one (the most to take home comes first). */
async function answerFirst(page: Page) {
  await page.getByTestId('offers-answer').first().click();
  await page.getByTestId('offer-answer-save').click();
}
