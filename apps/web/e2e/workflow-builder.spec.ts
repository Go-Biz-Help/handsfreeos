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

// ---- The Canvas: the second editor on the same draft ----

/** Waits until the canvas has drawn its nodes. */
async function canvasReady(page: Page) {
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-ready', 'true');
}

/** Every drawn node's id and position. Positions are worked out from the tree and never stored. */
const nodePositions = (page: Page) =>
  page
    .getByTestId('workflow-canvas')
    .locator('.react-flow__node')
    .evaluateAll((els) =>
      els.map((e) => `${e.getAttribute('data-id')} ${(e as HTMLElement).style.transform}`).sort(),
    );

/** The step the editor has selected (a step is selected as it's added). */
const selectedStep = (page: Page) => new URL(page.url()).searchParams.get('step');

/** A step anywhere in a definition, by id. */
function stepIn(def: unknown, id: string): Record<string, unknown> | undefined {
  if (Array.isArray(def)) {
    for (const x of def) {
      const found = stepIn(x, id);
      if (found) return found;
    }
  } else if (def && typeof def === 'object') {
    const o = def as Record<string, unknown>;
    if (o.id === id) return o;
    for (const v of Object.values(o)) {
      const found = stepIn(v, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Presses on one element and lets go over another, moving in small steps as a hand would. */
async function dragBetween(
  page: Page,
  from: ReturnType<Page['locator']>,
  to: ReturnType<Page['locator']>,
) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 8, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 });
  await page.mouse.up();
}

/**
 * `treeToGraph` and the layout are pure, and the web app has no unit runner, so their checks live here:
 * the nodes (the trigger, one per step, a split and a join for each branch block), edges labelled with their
 * paths, a dashed go-to edge and the rejected path's own edge, "+" handles that are exactly core's insertion
 * points, paths laid out in tree order, and a layout that text edits never move.
 */
test('canvas: the tree as a graph, and a layout that text edits never move', async () => {
  const core = await import('@hfos/core');
  const { structureKey, treeToGraph } = await import('../src/components/workflows/canvas/graph');
  const { layoutGraph } = await import('../src/components/workflows/canvas/layout');
  const text = (id: string, body: string) => ({
    id,
    type: 'action',
    action: 'send_text',
    config: { body, bookingCalendarId: null },
  });
  const def = core.parseDefinition({
    version: 1,
    trigger: { kind: 'event', event: 'lead.created' },
    steps: [
      text('s_aaaaaaa1', 'Hi {{person.first_name}}'),
      {
        id: 's_aaaaaaa2',
        type: 'branch',
        mode: 'if_else',
        branches: [
          {
            id: 'b_aaaaaaa1',
            name: 'Yes',
            condition: {
              match: 'all',
              conditions: [{ field: 'person.email', op: 'is_not_empty', value: null }],
            },
            steps: [
              {
                id: 's_aaaaaaa3',
                type: 'wait',
                until: { kind: 'duration', duration: { amount: 1, unit: 'days' } },
              },
              { id: 's_aaaaaaa4', type: 'goto', target: 's_aaaaaaa1', maxVisits: 2 },
            ],
          },
          { id: 'b_aaaaaaa2', name: 'Otherwise', condition: null, steps: [] },
        ],
      },
      {
        id: 's_aaaaaaa5',
        type: 'approval',
        approvers: { kind: 'admins' },
        rejected: {
          steps: [{ id: 's_aaaaaaa6', type: 'action', action: 'add_note', config: { body: 'No' } }],
        },
      },
      { id: 's_aaaaaaa7', type: 'action', action: 'add_note', config: { body: 'Yes' } },
    ],
  });
  const graph = treeToGraph(def);
  expect(graph.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual([
    'trigger:trigger',
    's_aaaaaaa1:step',
    's_aaaaaaa2:split',
    's_aaaaaaa3:step',
    's_aaaaaaa4:step',
    'empty:s_aaaaaaa2:b_aaaaaaa2:empty',
    'join:s_aaaaaaa2:join',
    's_aaaaaaa5:step',
    's_aaaaaaa7:step',
    'end:terminal',
    's_aaaaaaa6:step',
    'rejected-end:s_aaaaaaa5:terminal',
  ]);
  const flow = graph.edges.flatMap((e) => (e.kind === 'flow' ? [e] : []));
  expect(flow.filter((e) => e.label).map((e) => [e.source, e.target, e.label!.text])).toEqual([
    ['s_aaaaaaa2', 's_aaaaaaa3', 'Yes'],
    ['s_aaaaaaa2', 'empty:s_aaaaaaa2:b_aaaaaaa2', 'Otherwise'],
    ['s_aaaaaaa5', 's_aaaaaaa6', 'If it’s rejected'],
  ]);
  expect(flow.find((e) => e.label?.text === 'Yes')!.label!.title).toMatch(/is not empty/);
  expect(
    graph.edges.flatMap((e) => (e.kind === 'goto' ? [[e.source, e.target, e.maxVisits]] : [])),
  ).toEqual([['s_aaaaaaa4', 's_aaaaaaa1', 2]]);
  // Every "+" is one of core's insertion points, and every insertion point has exactly one "+".
  const key = (p: { parentId: string | null; branchId: string | null; index: number }) =>
    `${p.parentId}|${p.branchId}|${p.index}`;
  expect(flow.flatMap((e) => (e.point ? [key(e.point)] : [])).sort()).toEqual(
    core.insertionPoints(def).map(key).sort(),
  );

  // Paths sit left to right in tree order; an approval's rejected path sits beside its next step.
  const layout = layoutGraph(graph);
  const x = (id: string) => layout.positions.get(id)!.x;
  expect(x('s_aaaaaaa3')).toBeLessThan(x('empty:s_aaaaaaa2:b_aaaaaaa2'));
  expect(x('s_aaaaaaa7')).toBeLessThan(x('s_aaaaaaa6'));
  // The main path runs straight down, through the branch block and the approval: the step after the approval
  // sits right under it, in the same column as the first step (all three are steps, the same width).
  expect(x('s_aaaaaaa7')).toBe(x('s_aaaaaaa5'));
  expect(x('s_aaaaaaa5')).toBe(x('s_aaaaaaa1'));
  // Text and go-to targets don't change the structure, so nothing moves; moving a step does.
  const edited = core.applyWorkflowOps(def, [
    {
      op: 'update_step',
      stepId: 's_aaaaaaa1',
      patch: {
        config: { body: 'A much longer first message, which changes nothing about where it sits' },
      },
    },
    { op: 'set_goto', stepId: 's_aaaaaaa4', target: 's_aaaaaaa3', maxVisits: 5 },
  ]).definition;
  expect(structureKey(edited)).toBe(structureKey(def));
  expect([...layoutGraph(treeToGraph(edited)).positions]).toEqual([...layout.positions]);
  const moved = core.applyWorkflowOps(def, [
    { op: 'move_step', stepId: 's_aaaaaaa7', parentId: null, branchId: null, index: 0 },
  ]).definition;
  expect(structureKey(moved)).not.toBe(structureKey(def));
});

/**
 * One workflow, two editors: switching between Steps and Canvas changes nothing; a branch added in Steps
 * shows on the canvas; Move to… and a "+" on the canvas show in Steps, in the same order; a go-to's target
 * is set by dragging its handle; Undo on the canvas undoes that in both; and after a reload the canvas lays
 * out exactly the same.
 */
test('workflow builder: the same workflow in Steps and Canvas', async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await signUpAndConfirm(page, 'wf-canvas');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const api = apiAs(await signInForApi(owner.email));

  // 1. "Speed to lead" from its recipe.
  await page.goto(`/app/w/${workspaceId}/workflows/new`);
  await page.getByTestId('recipe-speed_to_lead').click();
  await expect(page.getByLabel('Workflow name')).toHaveValue('Speed to lead');
  await page.getByTestId('workflow-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  const workflowId = /workflows\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  const get = () => api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
  await expect(page.getByTestId('workflow-rail')).toBeVisible();

  // 2. Steps, Canvas, Steps, Canvas with no edits: the same draft, byte for byte, at the same revision. The
  // selection carries across.
  const before = await get();
  await page.getByTestId('step-s_stlwait1').click();
  await page.getByTestId('mode-canvas').click();
  await canvasReady(page);
  await expect(page).toHaveURL(/mode=canvas/);
  await expect(page).toHaveURL(/step=s_stlwait1/);
  await expect(page.getByTestId('canvas-node-s_stlwait1')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('panel-title')).toHaveText('Wait');
  await page.getByTestId('mode-steps').click();
  await expect(page.getByTestId('step-s_stlwait1')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('mode-canvas').click();
  await canvasReady(page);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  const after = await get();
  expect(after.workflow.revision).toBe(before.workflow.revision);
  expect(JSON.stringify(after.workflow.definition)).toBe(
    JSON.stringify(before.workflow.definition),
  );

  // 3. A branch added in Steps shows on the canvas, with its two paths.
  await page.getByTestId('mode-steps').click();
  await page.getByTestId('add-after-s_stltask1').click();
  await page.getByTestId('add-step-if_else').click();
  await expect(page.getByTestId('panel-title')).toHaveText('If / else');
  const branchId = selectedStep(page)!;
  await saved(page);
  await page.getByTestId('mode-canvas').click();
  await canvasReady(page);
  await page.getByTestId('canvas-fit').click();
  await expect(page.getByTestId(`canvas-node-${branchId}`)).toContainText('If email is not empty');
  await expect(page.getByTestId('canvas-edge-label')).toHaveText(['Yes', 'Otherwise']);

  // 4. On the canvas: Move to… from a node's menu, then a new step from an edge's "+". Steps shows both, in
  // the same order.
  await page.getByTestId('canvas-node-s_stltext2').click();
  await page.getByTestId('node-menu-s_stltext2').click();
  await page.getByTestId('node-move').click();
  const move = page.getByTestId('move-dialog');
  await move.getByRole('button', { name: 'After “Send a text”', exact: true }).click();
  await expect(move).toBeHidden();
  await page.getByTestId('canvas-fit').click();
  await page.getByTestId('add-after-s_stlwait1').click();
  await page.getByTestId('add-step-add_note').click();
  await expect(page.getByTestId('panel-title')).toHaveText('Add a note');
  const noteId = selectedStep(page)!;
  await expect(page.getByTestId(`canvas-node-${noteId}`)).toContainText('Add a note');
  await saved(page);
  await page.getByTestId('mode-steps').click();
  expect(await treeOrder(page)).toEqual([
    'trigger',
    's_stltext1',
    's_stltext2',
    's_stlwait1',
    noteId,
    's_stltask1',
    branchId,
    's_stlwait2',
  ]);

  // 5. A go-to at the end of the "Yes" path, added on the canvas, then pointed at the first text by
  // dragging its handle onto that step.
  const yesId = (
    stepIn((await get()).workflow.definition, branchId)!.branches as { id: string }[]
  )[0]!.id;
  await page.getByTestId('mode-canvas').click();
  await canvasReady(page);
  await page.getByTestId('canvas-fit').click();
  await page.getByTestId(`add-start-${branchId}-${yesId}`).click();
  await page.getByTestId('add-step-goto').click();
  await expect(page.getByTestId('panel-title')).toHaveText('Go to another step');
  const gotoId = selectedStep(page)!;
  const back = page.getByTestId(`canvas-goto-${gotoId}`);
  await expect(back).toHaveAttribute('data-target', 's_stltask1');
  await page.getByTestId('canvas-fit').click();
  await dragBetween(
    page,
    page.getByTestId(`goto-handle-${gotoId}`),
    page.getByTestId('canvas-node-s_stltext1'),
  );
  await expect(back).toHaveAttribute('data-target', 's_stltext1');
  await expect(page.locator(`#goto-${gotoId}`)).toHaveValue('s_stltext1');
  await saved(page);
  expect(stepIn((await get()).workflow.definition, gotoId)?.target).toBe('s_stltext1');

  // 6. Undo on the canvas undoes that last edit, in both views.
  await page.getByTestId('undo').click();
  await expect(back).toHaveAttribute('data-target', 's_stltask1');
  await expect(page.locator(`#goto-${gotoId}`)).toHaveValue('s_stltask1');
  await saved(page);
  expect(stepIn((await get()).workflow.definition, gotoId)?.target).toBe('s_stltask1');
  await page.getByTestId('mode-steps').click();
  await expect(page.getByTestId(`step-${gotoId}`)).toContainText('Go back to “Create a task');
  await page.getByTestId('mode-canvas').click();
  await canvasReady(page);

  // 7. After a reload the canvas is laid out exactly the same.
  await page.getByTestId('canvas-fit').click();
  const layout = await page.getByTestId('workflow-canvas').getAttribute('data-layout');
  const positions = await nodePositions(page);
  // Fitted, every node is drawn: the trigger, seven steps on the main path, the go-to, the empty path's
  // placeholder, the join and the end.
  expect(positions).toHaveLength(12);
  await openEditor(page);
  await canvasReady(page);
  await page.getByTestId('canvas-fit').click();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-layout', layout!);
  expect(await nodePositions(page)).toEqual(positions);
});

/** The canvas's budget for drawing 150 steps, from its first render to its first frame with the nodes. */
const CANVAS_BUDGET_MS = 1500;

/** 150 steps: ten blocks of a text, a wait, an if/else with five steps on each path, a text and a wait. */
function bigWorkflowOps(): Record<string, unknown>[] {
  let n = 0;
  const id = (prefix: 's' | 'b') => `${prefix}_bg${String(++n).padStart(6, '0')}`;
  const text = () => ({
    id: id('s'),
    type: 'action',
    action: 'send_text',
    config: { body: `Hi {{person.first_name}}, message ${n}`, bookingCalendarId: null },
  });
  const wait = () => ({
    id: id('s'),
    type: 'wait',
    until: { kind: 'duration', duration: { amount: 1, unit: 'days' } },
  });
  const ops: Record<string, unknown>[] = [];
  const add = (step: Record<string, unknown>) =>
    ops.push({ op: 'add_step', parentId: null, branchId: null, index: null, step });
  for (let block = 0; block < 10; block++) {
    add(text());
    add(wait());
    add({
      id: id('s'),
      type: 'branch',
      mode: 'if_else',
      branches: [
        {
          id: id('b'),
          name: 'Yes',
          condition: {
            match: 'all',
            conditions: [{ field: 'person.email', op: 'is_not_empty', value: null }],
          },
          steps: [text(), wait(), text(), wait(), text()],
        },
        {
          id: id('b'),
          name: 'Otherwise',
          condition: null,
          steps: [wait(), text(), wait(), text(), wait()],
        },
      ],
    });
    add(text());
    add(wait());
  }
  return ops;
}

const countSteps = (steps: unknown): number =>
  Array.isArray(steps)
    ? steps.reduce((total: number, s: Record<string, unknown>) => {
        const branches = (s.branches as { steps: unknown }[] | undefined) ?? [];
        const rejected = (s.rejected as { steps: unknown } | undefined)?.steps;
        return (
          total +
          1 +
          branches.reduce((m, b) => m + countSteps(b.steps), 0) +
          (rejected ? countSteps(rejected) : 0)
        );
      }, 0)
    : 0;

/**
 * A 150-step workflow, built through the API, opens on the canvas within the budget (measured in the page:
 * from the canvas's first render to its first frame with the nodes drawn), and a text edit moves nothing.
 */
test('workflow builder: a 150-step workflow on the canvas', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'wf-canvas-big');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const api = apiAs(await signInForApi(owner.email));
  const created = await api<{ workflowId: string; revision: number }>('commands/workflow.create', {
    workspaceId,
    name: 'A long follow-up',
    from: 'blank',
    trigger: { kind: 'event', event: 'lead.created' },
  });
  const { workflowId } = created;
  await api('commands/workflow.save_draft', {
    workspaceId,
    workflowId,
    baseRevision: created.revision,
    ops: bigWorkflowOps(),
  });
  const got = await api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
  expect(countSteps(got.workflow.definition.steps)).toBe(150);

  await openEditor(page, `/app/w/${workspaceId}/workflows/${workflowId}`);
  const canvas = page.getByTestId('workflow-canvas');
  const measure = async () => {
    await page.getByTestId('mode-canvas').click();
    await canvasReady(page);
    return Number(await canvas.getAttribute('data-render-ms'));
  };
  const first = await measure();
  await page.getByTestId('mode-steps').click();
  const second = await measure();
  console.log(`The canvas drew 150 steps in ${first} ms (first open) and ${second} ms (second).`);
  expect(first).toBeLessThan(CANVAS_BUDGET_MS);
  expect(second).toBeLessThan(CANVAS_BUDGET_MS);

  // A text edit changes no position.
  const layout = await canvas.getAttribute('data-layout');
  const positions = await nodePositions(page);
  expect(positions.length).toBeGreaterThan(5);
  await page.getByTestId('canvas-node-s_bg000001').click();
  await page
    .getByTestId('text-body')
    .fill('Hi {{person.first_name}}, a much longer first message, to show that nothing moves.');
  await saved(page);
  await expect(canvas).toHaveAttribute('data-layout', layout!);
  expect(await nodePositions(page)).toEqual(positions);
});

// ---- Describe: the third editor on the same draft ----

/** The tree items' ids in order in Describe's preview. */
const previewOrder = (page: Page) =>
  page
    .getByTestId('describe-step-list')
    .locator('[role="treeitem"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-tree-id')));

/**
 * One workflow, three editors: switching between Steps, Canvas and Describe changes nothing; a branch added
 * in Steps, a step moved on the Canvas and "wait two days instead" asked in Describe each show in the other
 * two; Describe's Apply is one Undo; and after a reload all three agree with what was saved.
 */
test('workflow builder: the same workflow in Steps, Canvas and Describe', async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await signUpAndConfirm(page, 'wf-describe');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const api = apiAs(await signInForApi(owner.email));
  await page.goto(`/app/w/${workspaceId}/workflows/new`);
  await page.getByTestId('recipe-speed_to_lead').click();
  await page.getByTestId('workflow-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  const workflowId = /workflows\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  const get = () => api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
  await expect(page.getByTestId('workflow-rail')).toBeVisible();

  // 1. Steps, Canvas, Describe and back to Steps with no edits: the same draft, byte for byte.
  const before = await get();
  await page.getByTestId('mode-canvas').click();
  await canvasReady(page);
  await page.getByTestId('mode-describe').click();
  await expect(page).toHaveURL(/mode=describe/);
  await expect(page.getByTestId('describe-pane')).toBeVisible();
  await expect(page.getByTestId('describe-preview')).toContainText('Shown in Canvas');
  await page.getByTestId('mode-steps').click();
  await expect(page.getByTestId('step-list')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  const after = await get();
  expect(after.workflow.revision).toBe(before.workflow.revision);
  expect(JSON.stringify(after.workflow.definition)).toBe(
    JSON.stringify(before.workflow.definition),
  );

  // 2. Steps: a branch after the task. The Canvas and Describe's preview both show it.
  await page.getByTestId('add-after-s_stltask1').click();
  await page.getByTestId('add-step-if_else').click();
  await expect(page.getByTestId('panel-title')).toHaveText('If / else');
  const branchId = selectedStep(page)!;
  await saved(page);
  await page.getByTestId('mode-canvas').click();
  await canvasReady(page);
  await page.getByTestId('canvas-fit').click();
  await expect(page.getByTestId(`canvas-node-${branchId}`)).toContainText('If email is not empty');
  await page.getByTestId('mode-describe').click();
  await expect(page.getByTestId('describe-preview')).toContainText('Shown in Canvas');
  await canvasReady(page);
  await page.getByTestId('canvas-fit').click();
  await expect(page.getByTestId(`canvas-node-${branchId}`)).toContainText('If email is not empty');
  await page.getByTestId('describe-preview-mode').click();
  await expect(page.getByTestId('describe-step-list')).toContainText('If email is not empty');

  // 3. The Canvas: Move to… puts the last text right after the first. Steps and Describe show that order.
  await page.getByTestId('mode-canvas').click();
  await canvasReady(page);
  await page.getByTestId('canvas-fit').click();
  await page.getByTestId('canvas-node-s_stltext2').click();
  await page.getByTestId('node-menu-s_stltext2').click();
  await page.getByTestId('node-move').click();
  const move = page.getByTestId('move-dialog');
  await move.getByRole('button', { name: 'After “Send a text”', exact: true }).click();
  await expect(move).toBeHidden();
  await saved(page);
  const order = [
    'trigger',
    's_stltext1',
    's_stltext2',
    's_stlwait1',
    's_stltask1',
    branchId,
    's_stlwait2',
  ];
  await page.getByTestId('mode-steps').click();
  expect(await treeOrder(page)).toEqual(order);
  await page.getByTestId('mode-describe').click();
  await expect(page.getByTestId('describe-preview')).toContainText('Shown in Steps');
  expect(await previewOrder(page)).toEqual(order);

  // 4. Describe: "Wait two days instead". The proposal marks the wait; the draft waits until Apply.
  const pane = page.getByTestId('describe-pane');
  await pane.getByTestId('describe-example').filter({ hasText: 'Wait two days instead' }).click();
  await expect(pane.getByTestId('describe-input')).toHaveValue('Wait two days instead');
  await pane.getByTestId('describe-send').click();
  const proposal = pane.getByTestId('proposal-card');
  await expect(proposal.getByTestId('proposal-change')).toHaveCount(1);
  await expect(proposal.getByTestId('proposal-change')).toContainText(
    'Change the wait from 1 day to 2 days',
  );
  await expect(proposal.getByTestId('proposal-checks')).toContainText('nothing to fix');
  await expect(pane.getByTestId('step-s_stlwait2')).toContainText('Wait 2 days');
  await expect(pane.getByTestId('step-s_stlwait2')).toContainText('Changed');
  expect(stepIn((await get()).workflow.definition, 's_stlwait2')?.until).toMatchObject({
    duration: { amount: 1, unit: 'days' },
  });
  const proposalId = new URL(page.url()).searchParams.get('proposal')!;
  await proposal.getByTestId('proposal-apply').click();
  await expect(proposal.getByTestId('proposal-result')).toContainText(
    'Applied the change to the draft.',
  );
  await saved(page);
  expect(stepIn((await get()).workflow.definition, 's_stlwait2')?.until).toMatchObject({
    duration: { amount: 2, unit: 'days' },
  });
  // Once the change is saved the proposal counts as applied, so the Assistant's card stops offering it.
  await expect
    .poll(
      async () =>
        (
          await api<{ proposal: { appliedAt: string | null } }>('queries/workflow.proposal_get', {
            workspaceId,
            proposalId,
          })
        ).proposal.appliedAt,
      { message: 'the applied proposal is marked applied' },
    )
    .not.toBeNull();
  await page.getByTestId('mode-steps').click();
  await expect(page.getByTestId('step-s_stlwait2')).toContainText('Wait 2 days');
  await page.getByTestId('mode-canvas').click();
  await canvasReady(page);
  await page.getByTestId('canvas-fit').click();
  await expect(page.getByTestId('canvas-node-s_stlwait2')).toContainText('Wait 2 days');
  // One Undo takes Describe's change back, and Redo puts it back.
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('canvas-node-s_stlwait2')).toContainText('Wait 1 day');
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('canvas-node-s_stlwait2')).toContainText('Wait 2 days');
  await saved(page);

  // 5. After a reload, Steps and Canvas agree with what was saved.
  await openEditor(page);
  await canvasReady(page);
  await page.getByTestId('canvas-fit').click();
  await expect(page.getByTestId(`canvas-node-${branchId}`)).toBeVisible();
  await expect(page.getByTestId('canvas-node-s_stlwait2')).toContainText('Wait 2 days');
  await page.getByTestId('mode-steps').click();
  expect(await treeOrder(page)).toEqual(order);
  await expect(page.getByTestId('step-s_stlwait2')).toContainText('Wait 2 days');
});

/**
 * The AI teammate in workflows: New workflow offers the two teammate recipes; "Hand to the AI teammate" comes
 * from the add-step menu with its panel (the teammate's status, and that nothing happens while there's none or
 * it's off; what it works toward; the first message; the conversation); Checks warns about double texting
 * once a workflow texts new leads while the teammate's Respond skill does too; and "AI teammate calls them"
 * keeps its call playbook, with the speed-to-lead-by-phone recipe beside the others.
 */
test('workflow builder: hand to the AI teammate, its recipes and the double-texting warning', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'wf-teammate');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const api = apiAs(await signInForApi(owner.email));
  // Quiet hours set explicitly (nothing here sends, so it passes at any hour).
  await api('commands/phone.update_settings', {
    workspaceId,
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
  });

  // New workflow offers the teammate's recipe variants beside the originals.
  await page.goto(`/app/w/${workspaceId}/workflows/new`);
  await expect(page.getByRole('heading', { name: 'How do you want to start?' })).toBeVisible();
  await expect(page.getByTestId('recipe-speed_to_lead_ai')).toContainText(
    'Speed to lead with your AI teammate',
  );
  await expect(page.getByTestId('recipe-missed_call_text_back_ai')).toContainText(
    'Missed-call text back with your AI teammate',
  );
  await expect(page.getByTestId('recipe-speed_to_lead_phone')).toContainText(
    'Speed to lead by phone',
  );

  // "Speed to lead" texts new leads; with no teammate there's nothing to warn about.
  await page.getByTestId('recipe-speed_to_lead').click();
  await page.getByTestId('workflow-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  const editor = page.url();
  const workflowId = /workflows\/([0-9a-f-]{36})$/.exec(editor)![1]!;
  await expect(page.getByTestId('workflow-rail')).toBeVisible();
  await page.getByTestId('rail-checks').click();
  await expect(page.getByTestId('workflow-checks')).toBeVisible();
  await expect(page.getByTestId('issue-double_texting')).toHaveCount(0);

  // Hand to the AI teammate, from the add-step menu: with no teammate yet, the step does nothing.
  await page.getByTestId('add-after-s_stltask1').click();
  await page.getByTestId('add-step-hand_to_ai_teammate').click();
  await expect(page.getByTestId('panel-title')).toHaveText('Hand to the AI teammate');
  const handId = selectedStep(page)!;
  await expect(page.getByTestId('hand-to-ai-status')).toContainText('no AI teammate yet');
  await saved(page);

  // Ava arrives, off, with her Respond skill texting new leads: the panel names her and Checks warns.
  await api('commands/ai_teammate.create', {
    workspaceId,
    preset: 'lead_responder',
    name: 'Ava',
    disclosure: 'first_message',
  });
  await openEditor(page, `${editor}?mode=steps&step=${handId}`);
  await expect(page.getByTestId('hand-to-ai-status')).toContainText(
    'Ava is off, so nothing happens at this step until someone turns it on.',
  );
  await page.getByTestId('hand-to-ai-goal-qualify').click();
  await page.getByTestId('hand-to-ai-first-none').click();
  await page.getByTestId('hand-to-ai-channel').selectOption('sms');
  await saved(page);
  await expect(page.getByTestId(`step-${handId}`)).toContainText(
    'ask the qualifying questions; it waits for them',
  );
  const got = await api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
  expect(stepIn(got.workflow.definition, handId)?.config).toMatchObject({
    goal: 'qualify',
    firstMessage: 'none',
    channel: 'sms',
  });
  await page.getByTestId('rail-checks').click();
  await expect(page.getByTestId('issue-double_texting')).toContainText(
    'Ava (AI) also texts new leads',
  );

  // "AI teammate calls them", from the same menu: its own playbook, and only people who agreed to calls.
  await page.getByTestId(`add-after-${handId}`).click();
  await page.getByTestId('add-step-call_with_ai').click();
  await expect(page.getByTestId('panel-title')).toHaveText('AI teammate calls them');
  const callId = selectedStep(page)!;
  await expect(page.getByTestId('call-with-ai-rules')).toContainText(
    'Ava calls only people who agreed to calls in writing',
  );
  await page.getByTestId('call-with-ai-opening').fill('about the quote you asked for');
  await page.getByTestId('call-with-ai-find-out').fill('Which rooms, and how soon.');
  await page.getByTestId('call-with-ai-book-never').click();
  await saved(page);
  await expect(page.getByTestId(`step-${callId}`)).toContainText(
    '“about the quote you asked for”; leaves booking to the team',
  );
  const after = await api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
  expect(stepIn(after.workflow.definition, callId)?.config).toMatchObject({
    opening: 'about the quote you asked for',
    findOut: 'Which rooms, and how soon.',
    book: 'never',
  });
});
