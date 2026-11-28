import { expect, test } from '@playwright/test';
import { api, ownerWithSite, WORKER } from './booking-helpers';

/**
 * The customer's pages in the brand kit (design tools, part 7; docs/forms.md, "The customer's pages"): the owner types
 * the license number under Brand kit in Settings → Workspace, and the estimate their customer opens, signed out, ends
 * with it, the address from Settings → Payments and the social links, in the kit's font and corners.
 */

const LICENSE = 'TX HVAC Lic. TACLA12345C';
const ADDRESS = '7200 Harwin Dr, Suite 210\nHouston, TX 77036';

test('The license number, the address and the social links at the bottom of an estimate, in the brand kit', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = await ownerWithSite(page, 'kit-pages', 'Lone Star HVAC & Roofing');
  const { workspaceId, token } = owner;

  // The owner types the license number in the brand kit.
  await page.goto(`/app/w/${workspaceId}/settings/workspace`);
  const license = page.getByTestId('brand-kit-license-input');
  await expect(license).toBeVisible();
  await expect(page.getByTestId('brand-kit-license-save')).toBeDisabled();
  await license.fill(LICENSE);
  await page.getByTestId('brand-kit-license-save').click();
  await expect(page.getByText('License number saved')).toBeVisible();
  await expect(page.getByTestId('brand-kit-license-save')).toBeDisabled();

  // The rest of the kit, and the address estimates carry.
  await api(token, 'commands', 'look.set', {
    workspaceId,
    font: 'Playfair Display',
    corners: 'round',
    socials: ['facebook.com/lonestarhvac'],
  });
  await api(token, 'commands', 'money.save_settings', {
    workspaceId,
    settings: { businessAddress: ADDRESS },
  });

  const { personId } = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Maria',
    lastName: 'Lopez',
    email: `maria-kit-pages-${Date.now()}@hfos.test`,
  });
  const { estimateId } = await api<{ estimateId: string }>(token, 'commands', 'estimate.create', {
    workspaceId,
    personId,
    title: 'Furnace tune-up',
    lines: [
      {
        name: 'Tune-up',
        quantity: 1,
        unitLabel: 'each',
        unitPriceCents: 12_900,
        taxable: false,
      },
    ],
  });
  await api(token, 'commands', 'estimate.send', { workspaceId, estimateId, channels: ['email'] });
  const link = await fetch(`${WORKER}/test/money/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, estimateId }),
  });
  expect(link.ok).toBe(true);
  const { token: estimateToken } = (await link.json()) as { token: string };

  // The customer opens it, signed out.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(`/e/${estimateToken}`);
  await expect(customer.getByTestId('estimate-page')).toBeVisible();
  const footer = customer.getByTestId('business-footer');
  await expect(footer).toBeVisible();
  await expect(customer.getByTestId('business-footer-license')).toHaveText(LICENSE);
  await expect(customer.getByTestId('business-footer-address')).toHaveText(
    '7200 Harwin Dr, Suite 210, Houston, TX 77036',
  );
  await expect(footer.getByRole('link', { name: 'Facebook' })).toHaveAttribute(
    'href',
    'https://facebook.com/lonestarhvac',
  );

  // In the kit's font, from Google, and its round corners.
  await expect(
    customer.locator('link[rel="stylesheet"][href*="family=Playfair+Display"]'),
  ).toHaveCount(1);
  const look = await customer
    .locator('.kit-look')
    .first()
    .evaluate((el) => {
      const css = getComputedStyle(el);
      return { font: css.fontFamily, radius: css.getPropertyValue('--radius-control').trim() };
    });
  expect(look.font).toContain('Playfair Display');
  expect(look.radius).toBe('22px');
});
