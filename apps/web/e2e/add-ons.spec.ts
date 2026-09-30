import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, randomPhone, signInOwner } from './booking-helpers';
import { addTeammate } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The Add-ons page (0108) as it is today, with nothing built yet: an owner finds it at the foot of the menu, and a
 * page that says there's nothing added and nothing to add yet, with Real Estate Agent coming soon and every planned
 * add-on up for a vote (0109); a member never sees the link, and the page isn't there for them; and Home suggests
 * no add-on to anyone, whether it's a brand-new business or its Action Center.
 */

const settingsNav = (page: Page) => page.getByRole('navigation', { name: 'Settings' });

test('an owner finds Add-ons at the foot of the menu with nothing added yet; a member never sees it; Home suggests nothing', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const business = 'Harbor View Rentals';
  const { email } = await signUpAndConfirm(page, 'addons-owner');
  const workspaceId = await createBusiness(page, { name: business });

  // A brand-new business's Home: Getting started, and no add-on suggested.
  await expect(page.getByTestId('getting-started')).toBeVisible();
  await expect(page.getByTestId('addon-suggestion')).toHaveCount(0);

  // Owners manage add-ons: the link is at the foot of the menu, above Get help, and opens a page that reads well
  // with nothing in it. It's no longer a Settings tab.
  await page.goto(`/app/w/${workspaceId}/settings`);
  await expect(settingsNav(page).getByRole('link', { name: 'Add-ons' })).toHaveCount(0);
  const link = page
    .getByRole('navigation', { name: 'HandsFreeOS' })
    .getByRole('link', { name: 'Add-ons' });
  await expect(link).toBeInViewport();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/add-ons$`));
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle(/Add-ons/);
  const settings = page.getByTestId('addons-settings');
  await expect(settings.getByRole('heading', { name: 'In this business' })).toBeVisible();
  await expect(page.getByTestId('addons-installed-empty')).toContainText('Nothing added yet');
  await expect(settings.getByRole('heading', { name: 'Available to add' })).toBeVisible();
  await expect(page.getByTestId('addons-available-empty')).toContainText('None to add yet');
  // The old Settings address still lands here, with the add-on it names.
  await page.goto(`/app/w/${workspaceId}/settings/add-ons?addon=hvac`);
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/add-ons\\?addon=hvac$`));

  // Nothing built, so no add-on card of any kind; Real Estate Agent is coming soon.
  await expect(settings.locator('[data-place]')).toHaveCount(0);
  await expect(page.getByTestId('coming-soon-realestate')).toContainText('Real Estate Agent');

  // Voting on what's next: search, a category, and a vote that counts once for the business and is taken back.
  const vote = page.getByTestId('addons-vote');
  await expect(vote.getByRole('heading', { name: 'Vote on what’s next' })).toBeVisible();
  await expect(page.getByTestId('planned-realestate')).toHaveCount(0);
  await page.getByTestId('planned-search').fill('pet');
  await expect(page.getByTestId('planned-petgrooming')).toBeVisible();
  await expect(page.getByTestId('planned-hvac')).toHaveCount(0);
  await page.getByTestId('planned-search').fill('');
  await page.getByTestId('planned-category-ai').click();
  await expect(page.getByTestId('planned-agentbuilder')).toBeVisible();
  await expect(page.getByTestId('planned-petgrooming')).toHaveCount(0);
  await page.getByTestId('planned-category-all').click();
  const votes = page.getByTestId('planned-votes-petgrooming');
  const before = Number(await votes.textContent());
  await page.getByTestId('planned-vote-petgrooming').click();
  await expect(page.getByTestId('planned-vote-petgrooming')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(votes).toHaveText(String(before + 1));
  await page.reload();
  await expect(page.getByTestId('planned-vote-petgrooming')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByTestId('planned-vote-petgrooming').click();
  await expect(page.getByTestId('planned-vote-petgrooming')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(votes).toHaveText(String(before));

  // With customers, Home is the Action Center: still no suggestion.
  const owner = await signInOwner(email);
  await api(owner.token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Dana',
    lastName: 'Whitfield',
    email: `dana-${randomUUID().slice(0, 6)}@hfos.test`,
    phone: randomPhone(),
    ownerUserId: owner.userId,
  });
  await page.goto(`/app/w/${workspaceId}`);
  await expect(page.getByTestId('action-center')).toBeVisible();
  await expect(page.getByTestId('addon-suggestion')).toHaveCount(0);

  // A member doesn't manage add-ons: no tab, the page isn't there for them, and Home suggests nothing.
  const member = await addTeammate(page, browser, workspaceId, business);
  const mem = member.page;
  await mem.goto(`/app/w/${workspaceId}/settings`);
  await expect(settingsNav(mem).getByRole('link', { name: 'Account' })).toBeVisible();
  await expect(
    mem.getByRole('navigation', { name: 'HandsFreeOS' }).getByRole('link', { name: 'Add-ons' }),
  ).toHaveCount(0);
  await mem.goto(`/app/w/${workspaceId}/add-ons`);
  await expect(mem.getByTestId('missing-page')).toBeVisible();
  await expect(mem.getByTestId('addons-settings')).toHaveCount(0);
  await mem.goto(`/app/w/${workspaceId}`);
  await expect(
    // A running business's Home shows the Action Center with the member's own guide in it.
    mem.getByTestId('action-center').or(mem.getByTestId('getting-started')).first(),
  ).toBeVisible();
  await expect(mem.getByTestId('addon-suggestion')).toHaveCount(0);
  await member.context.close();
});
