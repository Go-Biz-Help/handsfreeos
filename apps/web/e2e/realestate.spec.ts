import { expect, test } from '@playwright/test';
import { addTeammate } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';
import { turnOnRealestate } from './realestate-helpers';

/**
 * Real Estate Agent (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, step 11): HandsFreeOS staff hand the add-on in
 * testing to a business, its owner adds it from the Add-ons page, and it is one row in the menu that Deals and its
 * other pages open from, beside the sidebar and in place in a phone's drawer. A buyer deal started at
 * Touring has its duties; one that needs a note or a message won't be marked done without one, and is once a note
 * is added. A member who isn't on the deal doesn't see it.
 */
test('staff hand Real Estate Agent to a business; a duty won’t finish without its proof, then does; a member off the deal never sees it', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const business = 'Hill Country Realty';
  const { email } = await signUpAndConfirm(page, 'realestate-owner');
  const workspaceId = await createBusiness(page, { name: business });

  // HandsFreeOS staff let this business try it, and the owner adds it from the Add-ons page.
  await turnOnRealestate(page, email, workspaceId);

  // The add-on is one row in the menu (the owner's decision, 2026-10-09), and its pages open from it.
  await page.goto(`/app/w/${workspaceId}`);
  const menu = page.getByRole('navigation', { name: 'Workspace' });
  const realestate = menu.getByTestId('menu-addon-realestate');
  await expect(realestate).toHaveText('Real Estate Agent');
  await expect(menu.getByRole('link', { name: 'My duties' })).toHaveCount(0);
  /** Opens one of the add-on's pages from its row. */
  const openPage = async (name: string) => {
    await realestate.click();
    await page.getByTestId('menu-addon-panel-realestate').getByRole('link', { name }).click();
  };
  await realestate.click();
  await expect(page.getByTestId('menu-addon-panel-realestate').getByRole('link')).toHaveText([
    'Deals',
    'My duties',
    'Coordinate',
    'Vendors',
    'Deal settings',
  ]);
  await page.keyboard.press('Escape');
  await openPage('Deals');
  await expect(page.getByTestId('realestate-deals')).toBeVisible();
  // Lit while one of its pages is open.
  await expect(realestate).toHaveClass(/bg-accent-soft/);
  await expect(page.getByText('You’re not on any open deals yet.')).toBeVisible();

  // A buyer deal started at Touring gets the duties of every stage up to it.
  await page.getByTestId('start-buyer-deal').click();
  const form = page.getByTestId('start-deal');
  await form.getByTestId('start-deal-name').fill('Nguyen purchase');
  await form.getByLabel('Starting stage').selectOption('touring');
  await form.getByTestId('start-deal-submit').click();
  await expect(page).toHaveURL(
    new RegExp(`/app/w/${workspaceId}/a/realestate/deals/[0-9a-f-]{36}$`),
  );
  const dealUrl = page.url();
  await expect(page.getByRole('heading', { name: 'Nguyen purchase' })).toBeVisible();
  await expect(page.getByTestId('deal-stages').locator('[aria-current="step"]')).toHaveText(
    'Touring',
  );

  // "Obtain listing-agent property rundown" needs a note or a message: marking it done is refused, saying so.
  await page.getByTestId('duty-row-B-06').click();
  const drawer = page.getByTestId('duty-drawer');
  await expect(
    drawer.getByRole('heading', { name: 'Obtain listing-agent property rundown' }),
  ).toBeVisible();
  await expect(drawer.getByTestId('duty-proof-missing')).toContainText('a note of what was done');
  await drawer.getByTestId('duty-complete').click();
  await expect(
    page.getByText(/can be marked done once it has a note of what was done/),
  ).toBeVisible();

  // With a note, it's done, and its history says so.
  await drawer.getByTestId('duty-add-note').click();
  await drawer
    .getByTestId('duty-note')
    .getByRole('textbox')
    .fill('Called Kim Ortiz: the roof is four years old.');
  await drawer.getByTestId('duty-note').getByRole('button', { name: 'Add the note' }).click();
  await expect(drawer.getByText('All its proof is in.')).toBeVisible();
  await drawer.getByTestId('duty-complete').click();
  await expect(drawer.getByTestId('duty-history')).toContainText('Marked done');
  await page.keyboard.press('Escape');
  await page.getByTestId('duties-tab-done').click();
  await expect(page.getByTestId('duty-row-B-06')).toBeVisible();

  // The deal is on the owner's list, and My duties has what's still open.
  await openPage('Deals');
  await expect(page.getByTestId('deals-table')).toContainText('Nguyen purchase');
  await openPage('My duties');
  await expect(page.getByTestId('realestate-my-duties')).toBeVisible();

  // On a phone the row opens in place in the drawer, already open on the page showing.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('mobile-menu').click();
  const phoneMenu = page.getByTestId('drawer-menu');
  await expect(phoneMenu.getByTestId('menu-addon-panel-realestate')).toBeVisible();
  await phoneMenu.getByRole('link', { name: 'Vendors' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/a/realestate/vendors$`));
  await page.setViewportSize({ width: 1280, height: 832 });

  // A member who isn't on the deal sees Deals, but not this deal, and not its page.
  const member = await addTeammate(page, browser, workspaceId, business);
  await member.page.goto(`/app/w/${workspaceId}/a/realestate?view=all`);
  await expect(member.page.getByTestId('realestate-deals')).toBeVisible();
  await expect(member.page.getByText('Nguyen purchase')).toHaveCount(0);
  await member.page.goto(dealUrl);
  await expect(member.page.getByTestId('realestate-deal')).toHaveCount(0);
  await member.context.close();
});
