import { expect, test } from '@playwright/test';
import { api, makeCalendar, signInOwner } from './booking-helpers';
import { addTeammate, CHICAGO, chicagoDate } from './calendar';
import { createBusiness, linkFrom, signUpAndConfirm, uniqueEmail, waitForMail } from './helpers';
import { turnOnRealestate } from './realestate-helpers';

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));
const QUARTER = 15 * 60_000;

/** Minutes past midnight in Chicago. */
function chicagoMinutes(at: number): number {
  const [h, m] = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(at)
    .split(':')
    .map(Number);
  return h! * 60 + m!;
}

/**
 * Real Estate Agent, round two (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): a buyer
 * deal's own side, from the agent's screens to the client's portal.
 *
 * 1. A pasted listing's facts are read by the AI and confirmed by the agent.
 * 2. A tour without a signed buyer agreement is refused, then let through by the owner with a reason.
 * 3. A member who isn't on the deal sees only that the agent is busy then.
 * 4. The client is invited to the portal, signs in on their phone with the code emailed to them, passes on a home,
 *    says what they thought of one they saw, and messages the agent.
 * 5. The agent has the feedback on the tour and the message in the Inbox.
 */
test('a buyer deal from the agent’s screens to the client’s portal', async ({ page, browser }) => {
  test.setTimeout(420_000);
  const business = 'Hill Country Realty';
  const { email } = await signUpAndConfirm(page, 'realestate-buyer');
  const workspaceId = await createBusiness(page, { name: business });
  await turnOnRealestate(page, email, workspaceId);

  // The owner works every hour, tours go on Showings, and Linh Nguyen is buying.
  const { token, userId } = await signInOwner(email);
  await api(token, 'commands', 'schedule.set', { workspaceId, ownerId: userId, weekly: ALL_WEEK });
  await makeCalendar({ token, userId, workspaceId, site: '', business }, 'Showings');
  const linhEmail = uniqueEmail('linh');
  const client = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Linh',
    lastName: 'Nguyen',
    email: linhEmail,
  });
  const { dealId } = await api<{ dealId: string }>(token, 'commands', 'realestate.deal.open', {
    workspaceId,
    side: 'buyer',
    name: 'Nguyen purchase',
    clientPersonId: client.personId,
    stage: 'touring',
  });
  const dealUrl = `/app/w/${workspaceId}/a/realestate/deals/${dealId}`;

  // The deal page has the buyer's side, and says there's no signed buyer agreement yet.
  await page.goto(dealUrl);
  await expect(page.getByTestId('buyer-wants')).toBeVisible();
  await expect(page.getByTestId('buyer-agreement')).toContainText('no signed buyer agreement');
  await expect(page.getByTestId('buyer-homes')).toContainText('No homes yet');

  // 1. A home from a listing's pasted words: the AI finds its facts, each with its words, and the agent confirms.
  await page.getByTestId('buyer-homes').getByRole('link', { name: 'Add a home' }).click();
  await page.getByTestId('home-address').fill('418 Maple Ave, Austin, TX 78745');
  await page
    .getByTestId('home-text')
    .fill(
      'Charming single-family home in Crestview: 3 bed, 2 bath, 1,780 sq ft, built in 1998. Listed at $409,000. HOA $35/mo.',
    );
  await page.getByTestId('home-add').click();
  const price = page.getByTestId('fact-card-price_cents');
  await expect(price).toContainText('$409,000', { timeout: 60_000 });
  await expect(price).toContainText('“$409,000”');
  await expect(page.getByTestId('fact-card-beds')).toContainText('3 beds · 2 baths');
  await page.getByTestId('facts-confirm').click();
  await expect(page.getByText('Added, with its facts.')).toBeVisible();
  const row = page.getByTestId('home-row-418 Maple Ave');
  await expect(row).toContainText('$409,000');
  await expect(row).toContainText('3 · 2 · 1,780');
  await page.getByTestId('homes-add').click();
  await page.getByTestId('home-address').fill('12 Birch Ln, Austin, TX');
  await page.getByTestId('home-add').click();
  await expect(page.getByTestId('home-row-12 Birch Ln')).toBeVisible();

  // 2. A tour within the hour needs a signed buyer agreement: the planner says so, and the owner lets this one
  // through with a reason.
  const at = Math.ceil((Date.now() + 30 * 60_000) / QUARTER) * QUARTER;
  const day = chicagoDate(at);
  await page.goto(dealUrl);
  await page.getByTestId('deal-plan-tour').click();
  const plan = page.getByTestId('plan-tour');
  await expect(plan.getByTestId('tour-refused')).toContainText('no signed buyer agreement');
  await plan.getByLabel('Day and start').fill(day);
  await plan.getByLabel('Start time').selectOption(String(chicagoMinutes(at)));
  await plan
    .getByTestId('tour-add-home')
    .selectOption({ label: '418 Maple Ave, Austin, TX 78745' });
  await plan.getByTestId('tour-add-home').selectOption({ label: '12 Birch Ln, Austin, TX' });
  await plan
    .getByTestId('tour-reason')
    .fill('Signed on paper at the office; it’s being scanned today.');
  await plan.getByTestId('tour-submit').click();
  await expect(page.getByText(/Planned, as an exception/)).toBeVisible();
  const tour = page.getByTestId('tour-card');
  await expect(tour).toContainText('418 Maple Ave');
  await expect(tour).toContainText('Let through without a current buyer agreement');

  // 3. On the calendar the owner sees the tour; a member who isn't on the deal sees only that the owner is busy.
  await page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
  await expect(page.getByText('Home tour: 418 Maple Ave').first()).toBeVisible();
  const member = await addTeammate(page, browser, workspaceId, business);
  await member.page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
  await expect(member.page.getByTestId('busy-block').first()).toHaveText('Busy');
  await expect(member.page.getByText('418 Maple')).toHaveCount(0);
  await member.context.close();

  // 4. The owner invites Linh to the portal; the link comes by email.
  await page.goto(`${dealUrl}/client-tasks`);
  await page.getByTestId('portal-invite').click();
  const invited = Date.now();
  await page.getByTestId('invite-send').click();
  await expect(page.getByText(`Sent to ${linhEmail}.`)).toBeVisible();
  const invite = await waitForMail(linhEmail, `Your private portal with ${business}`, {
    after: invited,
  });
  const link = linkFrom(invite.text, /http:\/\/localhost:3000\/c\/[A-Za-z0-9_.~-]+/);

  // On her phone she asks for a code and types it in.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const linh = await phone.newPage();
  await linh.goto(link);
  await expect(linh.getByTestId('portal-sign-in')).toContainText('Hi Linh');
  const asked = Date.now();
  await linh.getByTestId('portal-send-code').click();
  const codeMail = await waitForMail(linhEmail, `Your ${business} code`, { after: asked });
  const code = /\b(\d{6})\b/.exec(codeMail.text)![1]!;
  await linh.getByTestId('portal-digit-0').fill(code);
  await expect(linh.getByTestId('portal-home')).toContainText('Hi Linh');
  await expect(linh.getByTestId('portal-deal-home')).toContainText('Buying a home');

  // She passes on 12 Birch Ln.
  await linh
    .getByRole('navigation', { name: 'Your portal' })
    .getByRole('link', { name: 'Homes' })
    .click();
  const birch = linh.getByTestId('portal-home-12 Birch Ln');
  await birch.getByTestId('portal-home-pass').click();
  await expect(birch.getByTestId('portal-home-pass')).toHaveText('Passed');

  // The owner marks 418 Maple seen, and she says what she thought of it.
  await page.goto(`${dealUrl}/tours`);
  await page.getByTestId('tour-card').getByRole('button', { name: 'Seen' }).first().click();
  await expect(page.getByText('Marked seen.')).toBeVisible();
  await linh
    .getByRole('navigation', { name: 'Your portal' })
    .getByRole('link', { name: 'To do' })
    .click();
  await linh.getByTestId('portal-feedback-open').first().click();
  const form = linh.getByTestId('portal-feedback');
  await form.getByRole('radio', { name: '4 stars' }).click();
  await form.getByLabel('What you liked').fill('The kitchen and the big garage');
  await form.getByTestId('portal-interest-love').click();
  await form.getByTestId('portal-feedback-send').click();
  await expect(linh.getByText(/^Sent to /)).toBeVisible();

  // She writes to her agent.
  await linh
    .getByRole('navigation', { name: 'Your portal' })
    .getByRole('link', { name: 'Messages' })
    .click();
  await linh.getByTestId('portal-message-input').fill('Can we see 418 Maple again on Sunday?');
  await linh.getByTestId('portal-message-send').click();
  await expect(linh.getByTestId('portal-messages')).toContainText(
    'Can we see 418 Maple again on Sunday?',
  );

  // 5. The owner has her feedback on the tour, her pass on the homes, and her message in the Inbox.
  await page.goto(`${dealUrl}/tours`);
  await expect(page.getByTestId('tour-card')).toContainText('Linh: Loved it · 4 of 5');
  await page.goto(`${dealUrl}/homes`);
  await expect(page.getByTestId('home-row-12 Birch Ln')).toContainText('Passed');
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByText('Can we see 418 Maple again on Sunday?').first()).toBeVisible({
    timeout: 30_000,
  });
  await phone.close();
});
