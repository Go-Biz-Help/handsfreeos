import { expect, test, type Page } from '@playwright/test';
import { createBusiness, PASSWORD, signUpAndConfirm } from './helpers';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

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

/** Nothing on the page is wider than the phone. */
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

test.use({ colorScheme: 'dark' });

/** The agency area on a 390 px phone, in the dark theme: the drawer, the lists, the editor, push and packs. */
test('agency area at 390 px, dark', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'agency-m');
  const lonestar = await createBusiness(page, {
    name: 'Lone Star HVAC & Roofing',
    agencyName: 'Go Biz Help',
  });
  const api = apiAs(await signInForApi(owner.email));
  const me = await api<{ workspaces: { id: string; organizationId: string }[] }>(
    'queries/account.me',
    {},
  );
  const orgId = me.workspaces.find((w) => w.id === lonestar)!.organizationId;
  await api('commands/workspace.create', {
    organizationId: orgId,
    name: 'Bayou Plumbing Co.',
    timezone: 'America/Chicago',
  });
  const { pipelines } = await api<{ pipelines: { stages: { id: string; name: string }[] }[] }>(
    'queries/pipeline.list',
    { workspaceId: lonestar },
  );
  const { workflowId } = await api<{ workflowId: string }>('commands/workflow.create', {
    workspaceId: lonestar,
    name: 'Estimate follow-up',
    from: 'recipe',
    recipeKey: 'estimate_follow_up',
    mapping: {
      estimate_stage: pipelines[0]!.stages.find((s) => s.name === 'Estimate sent')!.id,
    },
  });
  const { templateId } = await api<{ templateId: string }>(
    'commands/workflow_template.create_from_workflow',
    { organizationId: orgId, workflowId, name: 'Estimate follow-up (home services)' },
  );
  await api('commands/workflow_template.publish', { organizationId: orgId, templateId });

  await page.goto(`/app/org/${orgId}/templates`);
  await expect(page.getByTestId(`template-row-${templateId}`)).toBeVisible();
  await fits(page);

  // New template: a small dialog that fits the phone.
  await page.getByTestId('template-new').click();
  const create = page.getByTestId('template-new-dialog');
  await expect(create.getByTestId('template-new-name')).toBeVisible();
  await expect(create.getByTestId('template-new-create')).toBeInViewport();
  await fits(page);
  await page.keyboard.press('Escape');
  await expect(create).toBeHidden();

  // The drawer holds the agency's sections and its businesses.
  await page.getByTestId('agency-menu').click();
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  await expect(drawer.getByTestId('agency-switcher')).toBeVisible();
  await drawer.getByTestId('agency-nav-businesses').click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId('businesses-list')).toContainText('Bayou Plumbing Co.');
  await fits(page);

  // The template in the editor, and the push stepper over it.
  await page.goto(`/app/org/${orgId}/templates/${templateId}`);
  await expect(page.getByTestId('template-banner')).toContainText('Estimate sent');
  await expect(page.getByTestId('step-list')).toBeVisible();
  await fits(page);
  await page.getByTestId('template-push').click();
  await expect(page.getByTestId('push-stepper')).toBeVisible();
  await page.getByTestId('push-next').click();
  await expect(page.getByTestId(`push-map-${lonestar}`)).toBeVisible();
  await fits(page);
  await page.keyboard.press('Escape');

  // Knowledge packs: the editor opens as a bottom sheet.
  await page.goto(`/app/org/${orgId}/packs`);
  await page.getByTestId('pack-new').click();
  await expect(page.getByTestId('pack-editor')).toBeVisible();
  await page.getByTestId('pack-name').fill('HVAC starter FAQs');
  await page.getByTestId('pack-item-title-0').fill('Do you service heat pumps?');
  await page.getByTestId('pack-item-body-0').fill('Yes, every major brand.');
  await page.getByTestId('pack-save').click();
  await expect(page.getByTestId(/^pack-row-/)).toContainText('HVAC starter FAQs');
  await fits(page);
});
