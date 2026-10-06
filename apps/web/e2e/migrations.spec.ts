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

  // Connect the old system across the whole agency. Since GoHighLevel's app was retired (2026-10-06) the
  // screens offer its private token only, and a token reaches one sub-account. The sign-in door is still the
  // worker's, and it is what puts two sub-accounts in one migration, so this opens it the way the dialog used
  // to: the stand-in's sign-in page is the worker's own, so this is the real round trip through
  // /migrations/start and back to /migrations/callback.
  await page.goto(`/app/org/${orgId}/migrations`);
  await expect(page.getByRole('heading', { name: 'Migrations' })).toBeVisible();
  const signIn = await api<{ startPath: string }>('commands/migration.connect', {
    organizationId: orgId,
    source: 'gohighlevel',
    installKind: 'agency',
    authKind: 'oauth',
  });
  await page.goto(`${WORKER_URL}${signIn.startPath}`);
  await expect(page).toHaveURL(new RegExp(`/app/org/${orgId}/migrations\\?connected=1`), {
    timeout: 30_000,
  });
  await expect(page.getByTestId('migration-connection-gohighlevel')).toBeVisible();

  // Look at it. Read-only: this must not put a customer anywhere.
  await page.getByTestId('migration-start').click();
  await page.getByTestId('migration-scan-go').click();
  await expect(page).toHaveURL(/\/migrations\/[0-9a-f-]{36}/);
  const migrationId = new URL(page.url()).pathname.split('/').pop()!;
  await eventually(page, page.getByTestId('migration-map'));
  await expect(page.getByTestId('migration-inventory')).toBeVisible();

  // The promise that matters most on this screen: a category nobody let us read is not "0" — and it reads
  // differently from one we can read but have nowhere to put.
  await expect(page.getByTestId('migration-count-companies')).toHaveText('not shared with us');
  await expect(page.getByTestId('migration-count-contacts')).toHaveText('11');
  // Custom fields have a home since M15, so they come across as fields rather than as a note apologising
  // for them. The row is a countable, bringable category like any other.
  await expect(page.getByTestId('migration-row-custom_fields')).not.toContainText(
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

  /**
   * The one the import would not guess about. Chris Doyle's email is Maria's and his phone is Dave's, so he
   * is two different people at once and no rule may pick. He is not here yet, and the screen says so with
   * somewhere to answer: until 0091 the count was a sentence with no buttons under it, so the question was
   * asked and could never be answered.
   */
  expect(people.items.some((p) => p.firstName === 'Chris')).toBe(false);
  const queue = page.getByTestId('migration-review-queue');
  await expect(queue).toContainText('1 customer needs you to say');
  // Both of the people he collides with are offered by name, which is the whole of the evidence.
  await expect(queue.getByRole('button', { name: /^Same as Maria Alvarez/ })).toBeVisible();
  await expect(queue.getByRole('button', { name: /^Same as Dave Smith/ })).toBeVisible();
  await queue.getByTestId('migration-review-separate').click();

  // Answered: he comes across from the copy staged when he was first seen, with the date Dallas had for him,
  // and the migration counts him as brought rather than waiting.
  await expect(async () => {
    const after = await api<{
      items: { firstName: string; lastName: string; createdAt: string }[];
    }>('queries/person.list', { workspaceId: lonestar, limit: 50 });
    const chris = after.items.find((p) => p.firstName === 'Chris' && p.lastName === 'Doyle');
    expect(chris).toBeDefined();
    expect(new Date(chris!.createdAt).getUTCFullYear()).toBe(2022);
    const detail = await api<{ needsReview: number }>('queries/migration.get', {
      organizationId: orgId,
      migrationId,
    });
    expect(detail.needsReview).toBe(0);
  }).toPass({ timeout: 90_000 });

  // And they are in the ordinary customers list, not a separate archive.
  await page.goto(`/app/w/${lonestar}/customers`);
  await expect(page.getByRole('link', { name: 'Maria Alvarez' }).first()).toBeVisible();
});

/**
 * The door the screens offer (0069): a private integration token and the sub-account's id, typed and posted
 * straight to the worker. GoHighLevel's sign-in is no longer offered, now its app is being retired.
 *
 * What this is really checking is that the token leaves the browser for the worker and nowhere else, and that
 * the screen afterwards says which door it came in through — the paste is not a sign-in and should not claim
 * to be one.
 */
test('migrations: connect with a private token and its Location ID', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'migrate-token');
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

  await page.goto(`/app/org/${orgId}/migrations`);
  await page.getByTestId('migration-connect').click();
  // The token is the only way in: no sign-in to choose, and no "whole agency" a token couldn't reach. An
  // agency is told how to move several.
  const dialog = page.getByTestId('migration-connect-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('migration-how-oauth')).toHaveCount(0);
  await expect(dialog.getByTestId('migration-reach-agency')).toHaveCount(0);
  await expect(dialog).toContainText('Connect each one with its own token');
  await page.getByTestId('migration-token').fill('pit-not-a-real-token');
  await page.getByTestId('migration-location').fill('loc_austin');
  await page.getByTestId('migration-connect-go').click();

  // No round trip through anybody's sign-in: the dialog closes and the source is connected in place.
  const connected = page.getByTestId('migration-connection-gohighlevel');
  await expect(connected).toBeVisible({ timeout: 30_000 });
  await expect(connected).toContainText('Lone Star HVAC — Austin');
  await expect(connected).toContainText('A private token · one business');
});

test.beforeAll(() => {
  if (!WORKER_URL) throw new Error('The worker URL is needed for the source sign-in round trip.');
});
