import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting, textFromCustomer, WORKER_URL } from './telephony';
import {
  apiAs,
  createWorkflow,
  runFor,
  runState,
  signInForApi,
  testAndPublish,
  type WorkflowGet,
} from './workflow-approval-api';

const MIKE = '+17135550142';
const ANN = '+17135550143';
const BO = '+17135550144';
const AI = 's_aiwrite1';
const SEND = 's_aitext01';
const REJECTED_NOTE = 's_airejct1';

/**
 * An AI-written text behind an approval, end to end with the scripted model and the fake carrier. The AI
 * step's panel says it uses the knowledge base (one published item, prices off, a thin profile) and offers an
 * approval step, which one click adds. Mike's run waits for an OK: it shows on Home and on the Approvals page
 * with what Mike said and the knowledge used; the text is edited and approved, and the edited text is what
 * reaches Mike. Ann's approval arrives live and is rejected with a reason, and the rejected path runs. Bo's
 * expires when its job runs as of its expiry. Quiet hours are off, so it passes at any hour.
 */
test('workflow approval: an AI text approved with an edit, one rejected, one expired', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await signUpAndConfirm(page, 'wf-approval');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const business = await setUpTexting(page, workspaceId);
  const api = apiAs(await signInForApi(owner.email));
  // Quiet hours would start at 01:00 UTC for a Chicago business: off, so this passes at any hour.
  await api('commands/phone.update_settings', {
    workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });

  // The knowledge base: a thin profile with prices off, and one published FAQ.
  await api('commands/knowledge.profile_update', {
    workspaceId,
    profile: { description: 'Heating and air conditioning in Houston.', allowPrices: false },
  });
  await api('commands/knowledge_item.create', {
    workspaceId,
    status: 'published',
    content: {
      kind: 'faq',
      question: 'Do you offer financing?',
      answer: 'Yes, new systems can be financed over 60 months with approved credit.',
      tags: [],
    },
  });

  // Customers who agreed to texts. Mike asks a question first.
  const person = async (firstName: string, lastName: string, phone: string) => {
    const { personId } = await api<{ personId: string }>('commands/person.create', {
      workspaceId,
      firstName,
      lastName,
      phone,
    });
    await api('commands/person.set_sms_consent', { workspaceId, personId, consent: 'opted_in' });
    return personId;
  };
  const mike = await person('Mike', 'Johnson', MIKE);
  await textFromCustomer({
    from: MIKE,
    to: business,
    body: 'Do you offer financing for a new AC?',
  });
  await expect
    .poll(
      async () =>
        (await api<{ items: unknown[] }>('queries/inbox.list', { workspaceId, personId: mike }))
          .items.length,
      { timeout: 30_000, message: 'Mike’s text reaches the inbox' },
    )
    .toBeGreaterThan(0);

  // 1. The AI writes a reply and a text sends it.
  const { workflowId } = await createWorkflow(api, workspaceId, 'Answer with AI', [
    {
      id: AI,
      type: 'ai',
      task: 'write',
      prompt: 'Answer their question in one short text.',
      fallback: 'Thanks for your message! Someone will follow up today.',
    },
    {
      id: SEND,
      type: 'action',
      action: 'send_text',
      config: { body: '{{ai.message}}', bookingCalendarId: null },
    },
  ]);

  // 2. The AI step's panel: the knowledge it uses, prices, a thin profile, and the approval it suggests.
  await page.goto(`/app/w/${workspaceId}/workflows/${workflowId}`);
  await expect(page.getByTestId('workflow-rail')).toBeVisible();
  await page.getByTestId(`step-${AI}`).click();
  const line = page.getByTestId('knowledge-line');
  await expect(line).toHaveAttribute('data-ready', 'true');
  await expect(line).toContainText('The profile and 1 published item.');
  await expect(page.getByTestId('knowledge-prices')).toHaveText(
    'Prices stay out, because quoting prices is off.',
  );
  await expect(page.getByTestId('knowledge-thin')).toContainText('1 of 7 parts filled in');
  await expect(line.getByRole('link', { name: 'Open Knowledge' })).toHaveAttribute(
    'href',
    `/app/w/${workspaceId}/knowledge`,
  );
  await expect(page.getByTestId('ai-approval-hint')).toBeVisible();
  await page.getByTestId('ai-add-approval').click();
  await expect(page.getByTestId('panel-approval')).toBeVisible();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.getByTestId(`step-${AI}`).click();
  await expect(page.getByTestId('panel-ai')).toBeVisible();
  await expect(page.getByTestId('ai-approval-hint')).toHaveCount(0);
  const draft = (await api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId }))
    .workflow;
  const steps = draft.definition.steps as { id: string; type: string; previewStepId?: string }[];
  expect(steps.map((s) => s.type)).toEqual(['ai', 'approval', 'action']);
  const approval = steps[1]!;
  expect(approval.previewStepId).toBe(AI);
  // When it's rejected, a note says so (then the run ends).
  await api('commands/workflow.save_draft', {
    workspaceId,
    workflowId,
    baseRevision: draft.revision,
    ops: [
      {
        op: 'add_step',
        parentId: approval.id,
        branchId: 'rejected',
        index: null,
        step: {
          id: REJECTED_NOTE,
          type: 'action',
          action: 'add_note',
          config: { body: 'The AI’s reply was rejected.' },
        },
      },
    ],
  });
  await testAndPublish(api, workspaceId, workflowId);

  // 3. Mike's run writes a reply and waits for an OK: Home shows it.
  await api('commands/workflow.enrol', { workspaceId, workflowId, personId: mike });
  await expect
    .poll(() => runState(api, workspaceId, workflowId, mike), { timeout: 30_000 })
    .toBe('awaiting_approval');
  await page.goto(`/app/w/${workspaceId}`);
  const home = page.getByTestId('home-approvals');
  await expect(home).toContainText('1 approval waiting');
  await expect(home).toContainText('Mike Johnson');
  await expect(home).toContainText('Answer with AI · a text');
  await home.getByTestId('home-approvals-open').click();
  await expect(page).toHaveURL(/\/workflows\/approvals$/);

  // 4. The Approvals page: what will go, what Mike said, the knowledge used. Edit it, then approve.
  await expect(page.getByTestId('approvals-count')).toHaveText('1');
  const card = page.getByTestId('approval-card').filter({ hasText: 'Mike Johnson' });
  await expect(card.getByTestId('approval-title')).toHaveText(
    'An AI-written text for Mike Johnson',
  );
  await expect(card).toContainText('Answer with AI · for owners and admins');
  await expect(card.getByTestId('approval-asked')).toHaveText(
    'Do you offer financing for a new AC?',
  );
  await expect(card.getByTestId('approval-knowledge')).toContainText('Do you offer financing?');
  await expect(card.getByTestId('approval-prices')).toHaveText('Prices are off');
  await expect(card.getByTestId('approval-expires')).toContainText('Expires in');
  const field = card.getByTestId('approval-field-message');
  await expect(field).toHaveValue('Hi Mike, thanks for reaching out! Re: Do you offer financing?');
  const edited =
    'Hi Mike, yes: new systems can be financed over 60 months. Dale will text you the details today.';
  await field.fill(edited);
  await expect(card.getByTestId('approval-edited')).toHaveText(
    'Edited: your version is what goes out.',
  );
  await expect(card.getByTestId('approval-segments')).toHaveText(
    `${edited.length} of 160 · 1 text`,
  );
  await card.getByTestId('approval-approve').click();
  await expect(page.getByText('Approved. It goes out now.')).toBeVisible();
  await expect(page.getByTestId('approvals-empty')).toBeVisible();
  await expect(page.getByTestId('approvals-count')).toHaveCount(0);
  await page.getByTestId('approvals-tab-decided').click();
  await expect(page.getByTestId('decided-row').filter({ hasText: 'Mike Johnson' })).toContainText(
    'Approved by Test with an edit',
  );

  // 5. The edited text is what reached Mike, delivered by the fake carrier.
  await expect
    .poll(() => runState(api, workspaceId, workflowId, mike), { timeout: 30_000 })
    .toBe('completed:finished');
  await page.goto(`/app/w/${workspaceId}/customers/people/${mike}`);
  await page.getByTestId('action-text').click();
  const sheet = page.getByTestId('message-sheet');
  const sent = sheet.locator('[data-direction="outbound"]').last();
  await expect(sent).toContainText(edited);
  await expect(sent).toHaveAttribute('data-status', 'delivered', { timeout: 20_000 });
  await expect(sheet).not.toContainText('thanks for reaching out');
  await page.keyboard.press('Escape');

  // 6. Ann's approval arrives on the open page, live. Rejected with a reason: the rejected path runs.
  await page.goto(`/app/w/${workspaceId}/workflows/approvals`);
  await expect(page.getByTestId('approvals-empty')).toBeVisible();
  const ann = await person('Ann', 'Lee', ANN);
  await api('commands/workflow.enrol', { workspaceId, workflowId, personId: ann });
  const annCard = page.getByTestId('approval-card').filter({ hasText: 'Ann Lee' });
  await expect(annCard).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('approvals-count')).toHaveText('1');
  await expect(annCard.getByTestId('approval-field-message')).toHaveValue(
    'Hi Ann, thanks for reaching out!',
  );
  await annCard.getByTestId('approval-reject').click();
  await page.getByTestId('reject-reason').fill('I’ll call her myself.');
  await page.getByTestId('reject-confirm').click();
  await expect(page.getByText('Rejected. The workflow takes its rejected path.')).toBeVisible();
  await expect
    .poll(() => runState(api, workspaceId, workflowId, ann), { timeout: 30_000 })
    .toBe('completed:rejected');
  const annRun = await api<{ steps: { stepKey: string; status: string }[] }>(
    'queries/workflow.run_get',
    { workspaceId, runId: (await runFor(api, workspaceId, workflowId, ann))!.id },
  );
  expect(annRun.steps.map((s) => `${s.stepKey} ${s.status}`)).toEqual([
    `${AI}#1 done`,
    `${approval.id}#1 done`,
    `${REJECTED_NOTE}#1 done`,
  ]);
  await page.getByTestId('approvals-tab-decided').click();
  await expect(page.getByTestId('decided-row').filter({ hasText: 'Ann Lee' })).toContainText(
    'Rejected by Test: “I’ll call her myself.”',
  );

  // 7. Bo's approval: nobody decides. The run's job, run as of when the approval expires, expires it and
  // takes the rejected path (the step's setting); the page follows.
  await page.getByTestId('approvals-tab-waiting').click();
  const bo = await person('Bo', 'Diaz', BO);
  await api('commands/workflow.enrol', { workspaceId, workflowId, personId: bo });
  await expect
    .poll(() => runState(api, workspaceId, workflowId, bo), { timeout: 30_000 })
    .toBe('awaiting_approval');
  await expect(page.getByTestId('approval-card').filter({ hasText: 'Bo Diaz' })).toBeVisible({
    timeout: 45_000,
  });
  const boRun = (await runFor(api, workspaceId, workflowId, bo))!;
  const due = await fetch(`${WORKER_URL}/test/scheduled-jobs/run-due`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, dedupeKeys: [`wf-run:${boRun.id}`] }),
  });
  expect(due.status).toBe(200);
  expect(((await due.json()) as { moved: unknown[] }).moved).toHaveLength(1);
  await expect
    .poll(() => runState(api, workspaceId, workflowId, bo), { timeout: 30_000 })
    .toBe('completed:rejected');
  await expect(page.getByTestId('approvals-empty')).toBeVisible({ timeout: 45_000 });
  await page.getByTestId('approvals-tab-decided').click();
  await expect(page.getByTestId('decided-row').filter({ hasText: 'Bo Diaz' })).toContainText(
    'Expired: nobody decided in time',
  );
  await expect(page.getByTestId('decided-row')).toHaveCount(3);
});
