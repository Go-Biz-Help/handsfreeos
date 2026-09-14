import { expect, test, type Page } from '@playwright/test';
import { addPerson } from './calendar';
import { createBusiness, PASSWORD, signIn, signUpAndConfirm } from './helpers';

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

interface WorkflowGet {
  workflow: { revision: number; tested: boolean; definition: Record<string, unknown> };
}

/** The tree items' ids in order, as the step list shows them. */
const treeOrder = (page: Page) =>
  page
    .getByTestId('step-list')
    .locator('[role="treeitem"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-tree-id')));

/** Waits for the draft to save (it saves on its own a moment after each change). */
async function saved(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
}

/** Opens (or reloads) the editor and waits until it answers clicks: the rail renders once it's hydrated. */
async function openEditor(page: Page, url?: string) {
  if (url) await page.goto(url);
  else await page.reload();
  await expect(page.getByTestId('workflow-rail')).toBeVisible();
}

/**
 * The Steps editor end to end: a recipe becomes a draft; opening it without editing saves nothing; a
 * branch, a variable from the {{ picker with its preview, Move to…, a Check fixed and its Undo and Redo all
 * save as you go and survive a reload; and a second tab's save raises "Load their version".
 */
test('workflow builder: recipe, steps, variables, move, fix, undo, reload, conflict', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await signUpAndConfirm(page, 'wf-builder');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await addPerson(page, workspaceId, 'Mike', 'Johnson', '(713) 555-0142');
  const api = apiAs(await signInForApi(owner.email));

  // 1. "Speed to lead" from its recipe; the list shows it.
  await page.goto(`/app/w/${workspaceId}/workflows`);
  await expect(page.getByTestId('workflows-empty')).toBeVisible();
  await page.getByTestId('workflow-new').click();
  await expect(page.getByRole('heading', { name: 'How do you want to start?' })).toBeVisible();
  await page.getByTestId('recipe-speed_to_lead').click();
  await expect(page.getByLabel('Workflow name')).toHaveValue('Speed to lead');
  await page.getByTestId('workflow-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  const editor = page.url();
  const workflowId = /workflows\/([0-9a-f-]{36})$/.exec(editor)![1]!;
  await expect(page.getByTestId('workflow-editor')).toBeVisible();
  await page.getByRole('link', { name: 'Workflows', exact: true }).first().click();
  await expect(page.getByTestId('workflows-list')).toContainText('Speed to lead');
  await expect(page.getByTestId(`workflow-row-${workflowId}`)).toContainText('Recipe');
  await expect(page.getByTestId(`workflow-row-${workflowId}`)).toContainText('Draft');

  // 2. Opening and closing it without an edit saves nothing: the same draft, byte for byte.
  const before = await api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
  await openEditor(page, editor);
  await page.getByTestId('step-trigger').click();
  await expect(page.getByTestId('panel-trigger')).toBeVisible();
  await page.getByTestId('step-s_stltext1').click();
  await expect(page.getByTestId('text-body')).toBeVisible();
  await page.getByTestId('rail-checks').click();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('save-state')).toHaveText('Saved');
  await page.goto(`/app/w/${workspaceId}/workflows`);
  const after = await api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
  expect(after.workflow.revision).toBe(before.workflow.revision);
  expect(JSON.stringify(after.workflow.definition)).toBe(
    JSON.stringify(before.workflow.definition),
  );

  // 3. A branch after the task, then the first text with a detail from the {{ picker and its preview.
  await openEditor(page, editor);
  await page.getByTestId('add-after-s_stltask1').click();
  await page.getByTestId('add-step-if_else').click();
  await expect(page.getByTestId('panel-title')).toHaveText('If / else');
  await expect(page.getByTestId('step-list')).toContainText('If email is not empty');
  await page.getByTestId('step-s_stltext1').click();
  const body = page.getByTestId('text-body');
  await body.fill('Hi ');
  await body.pressSequentially('{{');
  await expect(page.getByTestId('variable-picker')).toBeVisible();
  await page.getByTestId('variable-person.first_name').click();
  await expect(body).toHaveValue('Hi {{person.first_name}}');
  await body.pressSequentially(', thanks for reaching out!');
  await expect(page.getByTestId('preview-for')).toHaveText(
    'Preview for Mike Johnson (test contact)',
  );
  await expect(page.getByTestId('message-preview')).toHaveText('Hi Mike, thanks for reaching out!');
  await expect(page.getByTestId('segment-counter')).toHaveText('33 of 160 · 1 text');
  await saved(page);

  // 4. "Move to…": the last text goes right after the first one.
  await page.getByTestId('step-s_stltext2').click();
  await page.getByTestId('step-menu').click();
  await page.getByTestId('step-move').click();
  const move = page.getByTestId('move-dialog');
  await move.getByRole('button', { name: 'After “Send a text”', exact: true }).click();
  await expect(move).toBeHidden();
  const moved = (await treeOrder(page)).filter((id) => id?.startsWith('s_stl'));
  expect(moved).toEqual(['s_stltext1', 's_stltext2', 's_stlwait1', 's_stltask1', 's_stlwait2']);
  await saved(page);

  // 5. A detail this step can't use shows in Checks; Fix removes it; Undo brings it back; Redo removes it.
  await page.getByTestId('step-s_stltext1').click();
  await body.fill('Hi {{person.first_name}}, about {{appointment.title}}');
  await page.getByTestId('rail-checks').click();
  const issue = page.getByTestId('issue-unknown_variable');
  await expect(issue).toContainText('{{appointment.title}} isn’t available in this step');
  await issue.getByTestId('fix-unknown_variable-remove_variable').click();
  await expect(page.getByTestId('issue-unknown_variable')).toHaveCount(0);
  await expect(page.getByTestId('fix-done')).toContainText('Remove {{appointment.title}}');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('issue-unknown_variable')).toHaveCount(1);
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('issue-unknown_variable')).toHaveCount(0);
  await saved(page);

  // 6. After a reload everything is still there.
  await openEditor(page);
  await expect(page.getByTestId('step-list')).toContainText('If email is not empty');
  expect((await treeOrder(page)).filter((id) => id?.startsWith('s_stl'))).toEqual(moved);
  await page.getByTestId('step-s_stltext1').click();
  await expect(page.getByTestId('text-body')).toHaveValue('Hi {{person.first_name}}, about');

  // 7. Another tab saves while this one has an unsaved change: "Load their version".
  await page.route('**/v1/commands/workflow.save_draft', (route) => route.abort());
  await page.getByTestId('step-s_stlwait1').click();
  await page.getByTestId('wait-amount').fill('10');
  await expect(page.getByTestId('save-state')).toContainText('Couldn’t save, retrying');
  const second = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const other = await second.newPage();
  await signIn(other, owner.email);
  await openEditor(other, editor);
  await other.getByTestId('step-s_stlwait2').click();
  await other.getByTestId('wait-amount').fill('2');
  await expect(other.getByTestId('save-state')).toHaveAttribute('data-state', 'saving');
  await saved(other);
  await second.close();
  await page.unroute('**/v1/commands/workflow.save_draft');
  await page
    .getByTestId('save-state')
    .getByRole('button', { name: 'Try now' })
    .click({ timeout: 3000 })
    .catch(() => {});
  await expect(page.getByTestId('conflict-banner')).toBeVisible();
  await page.getByTestId('load-their-version').click();
  await expect(page.getByTestId('conflict-banner')).toBeHidden();
  await expect(page.getByTestId('step-s_stlwait2')).toContainText('Wait 2 days');
  await expect(page.getByTestId('step-s_stlwait1')).toContainText('Wait 5 minutes');
});

/**
 * History restores a published version into the draft. Publishing needs a passing test run, which the workflow
 * engine carries out, so this runs once the engine is in (M6 step 4).
 */
test('workflow builder: History restores a published version', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'wf-history');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await addPerson(page, workspaceId, 'Mike', 'Johnson', '(713) 555-0142');
  const api = apiAs(await signInForApi(owner.email));
  await page.goto(`/app/w/${workspaceId}/workflows/new`);
  await page.getByTestId('recipe-speed_to_lead').click();
  await page.getByTestId('workflow-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  const workflowId = /workflows\/([0-9a-f-]{36})$/.exec(page.url())![1]!;

  // Publish version 1 (test and publish arrive in the web app with M6 step 8), change it, and restore it.
  await api('commands/workflow.test', { workspaceId, workflowId, mode: 'simulate' });
  let tested: WorkflowGet | null = null;
  await expect
    .poll(
      async () => {
        tested = await api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
        return tested.workflow.tested;
      },
      { timeout: 60_000, message: 'the worker passes a Simulate test of the draft' },
    )
    .toBe(true);
  await api('commands/workflow.publish', {
    workspaceId,
    workflowId,
    baseRevision: tested!.workflow.revision,
  });
  await openEditor(page);
  await expect(page.getByTestId('version-note')).toHaveText('Version 1 is live');
  await page.getByTestId('step-s_stlwait1').click();
  await page.getByTestId('wait-amount').fill('15');
  await expect(page.getByTestId('step-s_stlwait1')).toContainText('Wait 15 minutes');
  await saved(page);
  await page.getByTestId('history-open').click();
  await expect(page.getByTestId('version-1')).toContainText('Live');
  await page.getByTestId('restore-1').click();
  await expect(page.getByTestId('restore-preview')).toContainText(
    'Change the wait from 15 minutes to 5 minutes',
  );
  await page.getByTestId('restore-confirm').click();
  await expect(page.getByText(/^Restored version 1 as revision \d+\./)).toBeVisible();
  await expect(page.getByTestId('step-s_stlwait1')).toContainText('Wait 5 minutes');
  const restored = await api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
  expect(JSON.stringify(restored.workflow.definition)).toContain('"amount":5');
});
