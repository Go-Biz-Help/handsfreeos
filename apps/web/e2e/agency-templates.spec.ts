import { expect, test, type Locator, type Page } from '@playwright/test';
import { createBusiness, PASSWORD, signUpAndConfirm } from './helpers';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

/** A bearer token from Supabase's password sign-in, with the publishable key the web app holds. */
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

/** Runs a command or query through the API as that person, as the web app does. */
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

interface WorkflowList {
  items: { id: string; name: string; source: { kind: string } }[];
}

/** Reloads until `locator` shows: work the worker does (installs, suggestions) lands a moment later. */
async function eventually(page: Page, locator: Locator, timeout = 45_000) {
  await expect(async () => {
    await page.reload();
    await expect(locator).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout });
}

/**
 * The agency area end to end, with one agency owner and two client businesses in the same organization:
 * 1. A workflow saved as a template, published, and pushed to both businesses with its details matched
 *    (Bayou's stage left for Bayou to pick).
 * 2. The drafts arrive; Bayou's unmatched stage shows as an issue in Checks.
 * 3. The template changes and version 2 is published: Lone Star sees "Update available".
 * 4. Lone Star applies it (a draft revision), tests it and publishes it.
 * 5. A knowledge pack pushed to the businesses arrives as suggestions from Go Biz Help; Lone Star accepts
 *    one, and the packs page shows how each business is getting on.
 * 6. A template made from scratch opens in the editor; renamed there, the list shows its new name.
 */
test('agency templates: save, push with mapping, update available, apply, test, publish; a knowledge pack; a blank template, renamed', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await signUpAndConfirm(page, 'agency');
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
  const bayou = (
    await api<{ workspaceId: string }>('commands/workspace.create', {
      organizationId: orgId,
      name: 'Bayou Plumbing Co.',
      timezone: 'America/Chicago',
    })
  ).workspaceId;
  // Any hour of the day: no quiet hours in the business that tests and publishes.
  await api('commands/phone.update_settings', {
    workspaceId: lonestar,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
  await api('commands/person.create', {
    workspaceId: lonestar,
    firstName: 'Mike',
    lastName: 'Johnson',
    email: 'mike.johnson@example.com',
    ignoreDuplicates: true,
  });
  const { pipelines } = await api<{ pipelines: { stages: { id: string; name: string }[] }[] }>(
    'queries/pipeline.list',
    { workspaceId: lonestar },
  );
  const estimateStage = pipelines[0]!.stages.find((s) => s.name === 'Estimate sent')!.id;
  const { workflowId: sourceId } = await api<{ workflowId: string }>('commands/workflow.create', {
    workspaceId: lonestar,
    name: 'Estimate follow-up',
    from: 'recipe',
    recipeKey: 'estimate_follow_up',
    mapping: { estimate_stage: estimateStage },
  });

  // The agency area opens from the workspace switcher's group header.
  await page.goto(`/app/w/${lonestar}/workflows`);
  await page.getByTestId('workspace-switcher').click();
  await page.getByTestId(`agency-link-${orgId}`).click();
  await expect(page).toHaveURL(new RegExp(`/app/org/${orgId}/templates$`));
  await expect(page.getByTestId('templates-empty')).toBeVisible();

  // 1. Save the workflow as a template; publish it; push it to both businesses.
  await page.goto(`/app/w/${lonestar}/workflows/${sourceId}`);
  await expect(page.getByTestId('workflow-rail')).toBeVisible();
  await page.getByTestId('save-as-template').click();
  await page.getByTestId('template-name').fill('Estimate follow-up (home services)');
  await page.getByTestId('template-save').click();
  await expect(page).toHaveURL(new RegExp(`/app/org/${orgId}/templates/[0-9a-f-]{36}$`));
  const templateId = /templates\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.getByTestId('template-editor')).toBeVisible();
  // Its stage became a detail each business matches.
  await expect(page.getByTestId('placeholder-stage_estimate_sent')).toContainText('Estimate sent');
  await page.getByTestId('template-publish').click();
  await expect(page.getByTestId('template-banner')).toContainText('version 1 published');

  await page.getByTestId('template-push').click();
  const stepper = page.getByTestId('push-stepper');
  await expect(stepper.getByTestId(`push-business-${lonestar}`)).toBeChecked();
  await expect(stepper.getByTestId(`push-business-${bayou}`)).toBeChecked();
  await stepper.getByTestId('push-next').click();
  // Matched by name where it can be; Bayou's is left for Bayou.
  const lonestarStage = stepper.getByTestId(`push-map-${lonestar}-stage_estimate_sent`);
  await expect(lonestarStage).toHaveValue(estimateStage);
  await stepper.getByTestId(`push-map-${bayou}-stage_estimate_sent`).selectOption('');
  await stepper.getByTestId('push-next').click();
  await expect(stepper.getByTestId('push-review')).toContainText(
    'Bayou Plumbing Co.’s draft can’t publish until estimate sent is picked',
  );
  await stepper.getByTestId('push-submit').click();
  await expect(stepper.getByTestId(`push-status-${lonestar}`)).toHaveAttribute(
    'data-status',
    'installed',
    { timeout: 45_000 },
  );
  await expect(stepper.getByTestId(`push-status-${bayou}`)).toHaveAttribute(
    'data-status',
    'installed',
    { timeout: 45_000 },
  );
  await stepper.getByTestId('push-done').click();
  await expect(page.getByTestId('template-installs')).toContainText('Bayou Plumbing Co.');

  // 2. The drafts arrive; Bayou's unmatched stage is an issue with a Fix.
  const copyIn = async (workspaceId: string) =>
    (await api<WorkflowList>('queries/workflow.list', { workspaceId })).items.find(
      (w) => w.source.kind === 'template',
    )!.id;
  const copyA = await copyIn(lonestar);
  const copyB = await copyIn(bayou);
  await page.goto(`/app/w/${bayou}/workflows`);
  await expect(page.getByTestId(`workflow-row-${copyB}`)).toContainText('Go Biz Help v1');
  await page.goto(`/app/w/${bayou}/workflows/${copyB}`);
  await expect(page.getByTestId('workflow-rail')).toBeVisible();
  await page.getByTestId('rail-checks').click();
  await expect(page.getByTestId('workflow-rail')).toContainText(
    'Pick estimate sent for this business',
  );

  // 3. The agency lengthens the first wait and publishes version 2: Lone Star sees the update.
  await page.goto(`/app/org/${orgId}/templates/${templateId}`);
  await expect(page.getByTestId('workflow-rail')).toBeVisible();
  await page.getByTestId('step-s_efuwait1').click();
  await expect(page.getByTestId('panel-wait')).toBeVisible();
  await page.getByTestId('wait-amount').fill('4');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.getByTestId('template-publish').click();
  await expect(page.getByTestId('template-banner')).toContainText('version 2 published');
  await page.goto(`/app/org/${orgId}/templates`);
  await expect(page.getByTestId(`template-row-${templateId}`)).toContainText(
    '2 businesses are behind',
  );

  await page.goto(`/app/w/${lonestar}/workflows`);
  const row = page.getByTestId(`workflow-row-${copyA}`);
  await expect(row.getByTestId('update-available')).toBeVisible();

  // 4. Apply it (a draft revision), test it, publish it.
  await row.getByTestId(`update-review-${copyA}`).click();
  const update = page.getByTestId('template-update');
  await expect(update.getByTestId('update-changes')).toContainText('4 days');
  await update.getByTestId('update-apply').click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${copyA}`));
  await expect(page.getByTestId('workflow-rail')).toBeVisible();
  await expect(page.getByTestId('version-note')).toHaveText('Not published yet');
  await page.getByTestId('rail-test').click();
  await page.getByTestId('test-run').click();
  await expect(page.getByTestId('test-result')).toHaveAttribute('data-outcome', 'passed', {
    timeout: 90_000,
  });
  const publish = page.getByTestId('workflow-publish');
  await expect(publish).toBeEnabled();
  await publish.click();
  await page
    .getByRole('dialog', { name: 'Publish version 1?' })
    .getByTestId('publish-confirm')
    .click();
  await expect(page.getByTestId('version-note')).toHaveText('Version 1 is live');
  await page.goto(`/app/w/${lonestar}/workflows`);
  await expect(page.getByTestId(`workflow-row-${copyA}`)).toContainText('Go Biz Help v2');
  await expect(
    page.getByTestId(`workflow-row-${copyA}`).getByTestId('update-available'),
  ).toHaveCount(0);

  // 5. A knowledge pack, pushed to both businesses, arrives as suggestions from Go Biz Help.
  await page.goto(`/app/org/${orgId}/packs`);
  await page.getByTestId('pack-new').click();
  await page.getByTestId('pack-name').fill('HVAC starter FAQs');
  await page.getByTestId('pack-item-title-0').fill('Do you service heat pumps?');
  await page.getByTestId('pack-item-body-0').fill('Yes, every major brand, all year.');
  await page.getByTestId('pack-save').click();
  const packRow = page.getByTestId(/^pack-row-/);
  await expect(packRow).toContainText('HVAC starter FAQs');
  await packRow.getByRole('button', { name: 'Push' }).click();
  const push = page.getByTestId('pack-push');
  await expect(push.getByTestId(`pack-push-business-${bayou}`)).toBeChecked();
  await push.getByTestId('pack-push-submit').click();
  await expect(push).toBeHidden();

  await page.goto(`/app/w/${lonestar}/knowledge/suggestions`);
  const board = page.getByTestId('suggestions-board');
  await eventually(page, board.getByText('Do you service heat pumps?'));
  await expect(board).toContainText('Go Biz Help');

  // Lone Star accepts it; the packs page shows how each business is getting on.
  const suggestion = board
    .getByTestId('suggestion')
    .filter({ hasText: 'Do you service heat pumps?' });
  await suggestion.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(suggestion).toBeHidden();
  await page.goto(`/app/org/${orgId}/packs`);
  await expect(packRow.getByTestId(`pack-business-${lonestar}`)).toContainText(
    'Lone Star HVAC & Roofing: 1 accepted',
  );
  await eventually(page, packRow.getByTestId(`pack-business-${bayou}`));
  await expect(packRow.getByTestId(`pack-business-${bayou}`)).toContainText(
    'Bayou Plumbing Co.: 1 waiting',
  );

  // 6. A template from scratch opens in the editor; renamed there, the list shows its new name.
  await page.goto(`/app/org/${orgId}/templates`);
  await page.getByTestId('template-new').click();
  const create = page.getByTestId('template-new-dialog');
  await create.getByTestId('template-new-name').fill('Seasonal tune-up reminder');
  await create.getByTestId('template-new-description').fill('A reminder text each spring and fall');
  await create.getByTestId('template-new-create').click();
  await expect(page).toHaveURL(new RegExp(`/app/org/${orgId}/templates/[0-9a-f-]{36}$`));
  const blankId = /templates\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  expect(blankId).not.toBe(templateId);
  const editor = page.getByTestId('template-editor');
  await expect(editor).toHaveAttribute('data-template-id', blankId);
  await expect(page.getByTestId('workflow-rail')).toBeVisible();
  await expect(page.getByTestId('template-banner')).toContainText('not published yet');
  await expect(editor.getByTestId('workflow-name')).toHaveText('Seasonal tune-up reminder');

  const renamed = page.waitForResponse(
    (r) =>
      r.url().endsWith('/v1/commands/workflow_template.rename') &&
      r.request().method() === 'POST' &&
      r.ok(),
  );
  await editor.getByTestId('workflow-name').click();
  await editor.getByTestId('workflow-name-input').fill('Seasonal tune-up (HVAC)');
  await editor.getByTestId('workflow-name-input').press('Enter');
  await renamed;
  await expect(editor.getByTestId('workflow-name')).toHaveText('Seasonal tune-up (HVAC)');
  // Back through the breadcrumb: the list has the new name.
  await editor.getByRole('link', { name: 'Templates', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/org/${orgId}/templates$`));
  const blankRow = page.getByTestId(`template-row-${blankId}`);
  await expect(blankRow).toContainText('Seasonal tune-up (HVAC)');
  await expect(blankRow).toContainText('Not published');
  await expect(page.getByTestId('templates-list')).not.toContainText('Seasonal tune-up reminder');
});
