import { expect, test } from '@playwright/test';
import { api, makeCalendar, ownerWithSite } from './booking-helpers';
import { chatFrame } from './chat-helpers';

/**
 * The simple page (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4): the booking page grown into a
 * one-page site, turned on in Settings → Workspace. Its address shows what the business does with Book, Chat and
 * the calendar to book; its services, with prices because it tells customers its prices; its hours, Monday first and
 * grouped; where it works; and its privacy policy and terms. Chat shows because its website chat is set up for that
 * address, and opens the chat. A calendar's own page keeps the booking byline. Turned off, the switch says so.
 *
 * Everything is in place before the page is first opened: a production build keeps the public pages for 30 seconds.
 */
test('Settings: the simple page turned on, what it shows, its chat, and turned off', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'page-owner', 'Lone Star HVAC');
  const { workspaceId, site, token } = owner;
  const calendar = await makeCalendar(owner, 'AC tune-up');
  await api(token, 'commands', 'knowledge.profile_update', {
    workspaceId,
    profile: {
      description: 'Heating and cooling for homes around Austin.',
      services: [
        { name: 'AC tune-up', description: 'A full check before summer.', price: 'From $89' },
      ],
      serviceArea: 'Austin and 20 miles around it',
      allowPrices: true,
    },
  });
  await api(token, 'commands', 'workspace.update', {
    workspaceId,
    settings: {
      openHours: [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '17:00' })),
    },
  });
  // The chat for the page's own address, as quick setup adds it for a business with no website.
  await api(token, 'commands', 'chat_widget.create', {
    workspaceId,
    allowedOrigins: ['http://localhost:3000'],
  });

  await page.goto(`/app/w/${workspaceId}/settings/workspace`);
  const card = page.getByTestId('page-card');
  await expect(card).toContainText('Your page');
  await expect(card.getByRole('switch', { name: 'Show your page' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(card.getByTestId('page-card-link')).toHaveCount(0);
  await card.getByRole('switch', { name: 'Show your page' }).click();
  await expect(page.getByText('Your page is live.')).toBeVisible();
  const open = card.getByTestId('page-card-link').getByRole('link', { name: 'Open it' });
  await expect(open).toHaveAttribute('href', `http://localhost:3000/book/${site}`);

  const pub = await page.context().newPage();
  await pub.goto(`/book/${site}`);
  const biz = pub.getByTestId('business-page');
  await expect(biz.getByRole('heading', { level: 1 })).toHaveText('Lone Star HVAC');
  await expect(pub).toHaveTitle('Lone Star HVAC');
  await expect(biz).toContainText('Heating and cooling for homes around Austin.');
  // One calendar: Book goes straight to it.
  await expect(pub.getByTestId('business-page-book')).toHaveAttribute(
    'href',
    `/book/${site}/${calendar.slug}`,
  );
  await expect(pub.getByTestId('business-page-services')).toContainText('AC tune-up');
  await expect(pub.getByTestId('business-page-services')).toContainText('From $89');
  await expect(pub.getByTestId('business-page-hours')).toContainText('Mon–Fri');
  await expect(pub.getByTestId('business-page-hours')).toContainText('8:00 AM–5:00 PM');
  await expect(pub.getByTestId('business-page-hours')).toContainText('Sat–Sun');
  await expect(pub.getByTestId('business-page-area')).toContainText(
    'Austin and 20 miles around it',
  );
  await expect(pub.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
    'href',
    `/legal/${site}/privacy`,
  );
  await expect(pub.getByText('Made with HandsFreeOS')).toBeVisible();
  // Texting isn't approved yet, so there's no Text button.
  await expect(pub.getByTestId('business-page-text')).toHaveCount(0);

  // Chat opens the business's chat, on this page's address.
  await expect(pub.locator('hfos-chat')).toHaveCount(1);
  await pub.getByTestId('business-page-chat').click();
  await expect(pub.locator('hfos-chat[open]')).toHaveCount(1);
  const chat = await chatFrame(pub);
  expect(new URL(chat.url()).searchParams.get('o')).toBe('http://localhost:3000');
  await expect(chat.getByRole('heading', { name: 'Lone Star HVAC' })).toBeVisible();

  // A calendar's own page is still the booking page, with its own byline.
  await pub.getByTestId('business-page-book').click();
  await expect(pub).toHaveURL(new RegExp(`/book/${site}/${calendar.slug}$`));
  await expect(pub.getByText('Booking by HandsFreeOS')).toBeVisible();
  await pub.close();

  // Turned off: the switch says so, and so does the booking site.
  await card.getByRole('switch', { name: 'Show your page' }).click();
  await expect(
    page.getByText('Your page is off. Its address shows your booking page again.'),
  ).toBeVisible();
  await expect(card.getByTestId('page-card-link')).toHaveCount(0);
  const got = await api<{ site: { page: boolean } }>(token, 'queries', 'booking_site.get', {
    workspaceId,
  });
  expect(got.site.page).toBe(false);
});
