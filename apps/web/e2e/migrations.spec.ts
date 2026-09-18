import { expect, test, type Locator, type Page } from '@playwright/test';
import { createBusiness, PASSWORD, signUpAndConfirm } from './helpers';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const WORKER_URL = (process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://127.0.0.1:4100').replace(
  /\/+$/,
  '',
);

async function signInForApi(email: string): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error('The Supabase URL and publishable key come from .env.local (pnpm env:local).');
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Signing in for the API failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const apiAs =
  (token: string) =>
  async <T>(path: `${'commands' | 'queries'}/${string}`, body: Record<string, unknown>) => {
    const res = await fetch(`${API_URL}/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

/** Reloads until it shows: the worker's batches land a moment after the button. */
async function eventually(page: Page, locator: Locator, timeout = 60_000) {
  await expect(async () => {
    await page.reload();
    await expect(locator).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout });
}

/**
 * Moving a business here from another CRM, through the screens an agency owner actually uses (M11).
 *
 * The stand-in source is the awkward two-sub-account agency in the worker, so the wizard is driven over the
 * things that go wrong rather than a happy path: a category the sign-in cannot read, two sub-accounts landing
 * in one business, a customer who is in both, and custom fields HandsFreeOS has nowhere to put.
 */
test('migrations: connect, look, map two sub-accounts into one business, choose, bring it across', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await signUpAndConfirm(page, 'migrate');
  const lonestar = await createBusiness(page, {
    name: 'Lone Star HVAC',
    agencyName: 'Go Biz Help',
  });
  const api = apiAs(await signInForApi(owner.email));
  const me = await api<{ workspaces: { id: string; organizationId: string }[] }>(
    'queries/account.me',
    {},
  );
  const orgId = me.workspaces.find((w) => w.id === lonestar)!.organizationId;

  // Connect the old system. The stand-in's sign-in page is the worker's own, so this is the real round trip
  // through /migrations/start and back to /migrations/callback.
  await page.goto(`/app/org/${orgId}/migrations`);
  await expect(page.getByRole('heading', { name: 'Migrations' })).toBeVisible();
  await page.getByTestId('migration-connect').click();
  await expect(page.getByTestId('migration-connect-dialog')).toBeVisible();
  await page.getByTestId('migration-connect-go').click();
  await expect(page).toHaveURL(new RegExp(`/app/org/${orgId}/migrations\\?connected=1`), {
    timeout: 30_000,
  });
  await expect(page.getByTestId('migration-connection-gohighlevel')).toBeVisible();

  // Look at it. Read-only: this must not put a customer anywhere.
  await page.getByTestId('migration-start').click();
  await page.getByTestId('migration-scan-go').click();
  await expect(page).toHaveURL(/\/migrations\/[0-9a-f-]{36}/);
  await eventually(page, page.getByTestId('migration-map'));
  await expect(page.getByTestId('migration-inventory')).toBeVisible();

  // The promise that matters most on this screen: a category nobody let us read is not "0" — and it reads
  // differently from one we can read but have nowhere to put.
  await expect(page.getByTestId('migration-count-companies')).toHaveText(
    'not visible to this sign-in',
  );
  await expect(page.getByTestId('migration-count-contacts')).toHaveText('9');
  await expect(page.getByTestId('migration-row-custom_fields')).toContainText(
    'Nowhere to put it yet',
  );
  await expect(page.getByTestId('migration-finding-access.scope_missing')).toBeVisible();

  // Both sub-accounts into the one business. The screen says what that mixes before anything moves.
  for (const scope of ['loc_austin', 'loc_dallas'])
    await page.getByTestId(`migration-scope-${scope}`).selectOption(lonestar);
  await expect(
    page.getByText(/Sharing this business with another sub-account/).first(),
  ).toBeVisible();
  await page.getByTestId('migration-map-save').click();

  await eventually(page, page.getByTestId('migration-review'));
  await expect(page.getByTestId('migration-finding-plan.scopes_share_workspace')).toBeVisible();
  // Everything the scan could bring is ticked already; the plan says what will happen either way.
  await expect(page.getByTestId('migration-choose')).toBeVisible();
  await page.getByTestId('migration-start-import').click();

  // It lands, and the customers are in the business with the dates they were really added.
  await eventually(page, page.getByTestId('migration-done'), 120_000);
  const people = await api<{ items: { firstName: string; lastName: string; createdAt: string }[] }>(
    'queries/person.list',
    { workspaceId: lonestar, limit: 50 },
  );
  const dave = people.items.filter((p) => p.lastName === 'Smith');
  expect(dave).toHaveLength(2);
  const tom = people.items.filter((p) => p.firstName === 'Tom');
  expect(tom).toHaveLength(1);
  const austinDave = people.items.find((p) => p.firstName === 'Dave');
  expect(new Date(austinDave!.createdAt).getUTCFullYear()).toBeLessThan(2024);

  // And they are in the ordinary customers list, not a separate archive.
  await page.goto(`/app/w/${lonestar}/customers`);
  await expect(page.getByRole('link', { name: 'Maria Alvarez' }).first()).toBeVisible();
});

test.beforeAll(() => {
  if (!WORKER_URL) throw new Error('The worker URL is needed for the source sign-in round trip.');
});
