import { expect, test } from '@playwright/test';
import { api, makeCalendar, signInOwner } from './booking-helpers';
import { addTeammate, weekdayAhead } from './calendar';
import { createBusiness, signUpAndConfirm, uniqueEmail } from './helpers';
import { turnOnRealestate } from './realestate-helpers';

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));

/**
 * Real Estate Agent, round two (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): a buyer
 * deal's own side. A pasted listing's facts are read by the AI and confirmed by the agent; a tour without a signed
 * buyer agreement is refused, then let through by the owner with a reason; and a member who isn't on the deal sees
 * only that the agent is busy then.
 */
test('a buyer deal: a pasted listing is read and confirmed, a tour is refused then let through, and a member off the deal sees only Busy', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const business = 'Hill Country Realty';
  const { email } = await signUpAndConfirm(page, 'realestate-buyer');
  const workspaceId = await createBusiness(page, { name: business });
  await turnOnRealestate(page, email, workspaceId);

  // The owner works every hour, tours go on Showings, and Linh Nguyen is buying.
  const { token, userId } = await signInOwner(email);
  await api(token, 'commands', 'schedule.set', { workspaceId, ownerId: userId, weekly: ALL_WEEK });
  await makeCalendar({ token, userId, workspaceId, site: '', business }, 'Showings');
  const client = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Linh',
    lastName: 'Nguyen',
    email: uniqueEmail('linh'),
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

  // A home from a listing's pasted words: the AI finds its facts, each with its words, and the agent confirms them.
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

  // A tour needs a signed buyer agreement: the planner says so, and the owner lets this one through with a reason.
  const day = weekdayAhead(3);
  await page.goto(dealUrl);
  await page.getByTestId('deal-plan-tour').click();
  const plan = page.getByTestId('plan-tour');
  await expect(plan.getByTestId('tour-refused')).toContainText('no signed buyer agreement');
  await plan.getByLabel('Day and start').fill(day);
  await plan
    .getByTestId('tour-add-home')
    .selectOption({ label: '418 Maple Ave, Austin, TX 78745' });
  await plan
    .getByTestId('tour-reason')
    .fill('Signed on paper at the office; it’s being scanned today.');
  await plan.getByTestId('tour-submit').click();
  await expect(page.getByText(/Planned, as an exception/)).toBeVisible();
  const tour = page.getByTestId('tour-card');
  await expect(tour).toContainText('418 Maple Ave');
  await expect(tour).toContainText('Let through without a current buyer agreement');

  // On the calendar the owner sees the tour; a member who isn't on the deal sees only that the owner is busy then.
  await page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
  await expect(page.getByText('Home tour: 418 Maple Ave').first()).toBeVisible();
  const member = await addTeammate(page, browser, workspaceId, business);
  await member.page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
  await expect(member.page.getByTestId('busy-block').first()).toHaveText('Busy');
  await expect(member.page.getByText('418 Maple')).toHaveCount(0);
  await member.context.close();
});
