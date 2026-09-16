import { expect, test, type Locator, type Page } from '@playwright/test';
import { consentToAssistant } from './booking-helpers';
import { addPerson } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';
import {
  apiAs,
  createWorkflow,
  runState,
  signInForApi,
  testAndPublish,
} from './workflow-approval-api';

const panel = (page: Page): Locator => page.getByTestId('assistant-panel');

/** Opens the Assistant if it isn't open, asks, and waits until the answer has finished streaming in. */
async function ask(page: Page, question: string): Promise<Locator> {
  if (!(await panel(page).isVisible())) await page.getByTestId('ask-assistant').click();
  const box = panel(page).getByRole('textbox', { name: 'Message the Assistant' });
  await box.fill(question);
  await box.press('Enter');
  await expect(panel(page).getByTestId('assistant-question').last()).toHaveText(question);
  const answer = panel(page).getByTestId('assistant-message').last();
  await expect(answer).toHaveAttribute('data-state', 'done');
  return answer;
}

interface Definition {
  steps: { id: string; type: string; until?: { duration?: { amount: number; unit: string } } }[];
}
interface WorkflowOut {
  workflow: { status: string; revision: number; definition: Definition };
}

/**
 * The Assistant's workflow and knowledge tools against the scripted model (global setup starts the worker
 * with ASSISTANT_PROVIDER=scripted, which the AI builder answers from too):
 * 1. A workflow drafted from a sentence is a proposal only: Open shows it on "Describe it", and Create workflow
 *    makes the draft. On that workflow's page a change opens as the Describe diff, and Apply is one edit.
 * 2. A customer starts on a workflow after the confirm card.
 * 3. Pause and Resume, each after its card.
 * 4. An approval answered from the Assistant, and the run carries on.
 * 5. A question answered from the knowledge base, with the items it used.
 * No texts go out (the workflows make tasks and notes), so it passes at any hour.
 */
test('workflow assistant: draft and apply, start, pause and resume, an approval, the knowledge base', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await signUpAndConfirm(page, 'wf-assistant');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await consentToAssistant(owner.email);
  const mike = await addPerson(page, workspaceId, 'Mike', 'Johnson', '(713) 555-0142');
  const api = apiAs(await signInForApi(owner.email));
  const workflows = `/app/w/${workspaceId}/workflows`;
  const statusOf = async (workflowId: string) =>
    (await api<WorkflowOut>('queries/workflow.get', { workspaceId, workflowId })).workflow;

  // 1. "Build a workflow…": a proposal with its steps, and nothing made yet.
  await page.goto(workflows);
  let answer = await ask(page, 'Build a workflow that texts new leads within a minute');
  await expect(answer.getByTestId('assistant-steps')).toContainText('Drafting the workflow');
  await expect(answer).toContainText('Nothing runs until you open it, test it and publish it.');
  const draftCard = answer.getByTestId('assistant-card-workflow');
  await expect(draftCard.getByTestId('workflow-card-name')).toHaveText('New lead text-back');
  await expect(draftCard).toContainText('Draft · starts when a new lead comes in');
  await expect(draftCard.getByTestId('workflow-card-lines').locator('li')).toHaveCount(5);
  await expect(draftCard.getByTestId('workflow-card-checks')).toContainText('nothing to fix');
  expect(
    (await api<{ items: unknown[] }>('queries/workflow.list', { workspaceId })).items,
  ).toHaveLength(0);
  // Open shows the proposal on "Describe it"; Create workflow applies it as a new draft.
  await draftCard.getByTestId('workflow-card-open').click();
  await expect(page).toHaveURL(/\/workflows\/new\?proposal=[0-9a-f-]{36}&name=New_lead_text-back$/);
  const describeNew = page.getByTestId('describe-new');
  await expect(describeNew.getByTestId('describe-new-trigger')).toHaveText(
    'When a new lead comes in',
  );
  await expect(describeNew.getByTestId('describe-new-steps').locator('li')).toHaveCount(5);
  await expect(describeNew.getByLabel('Workflow name')).toHaveValue('New lead text-back');
  await describeNew.getByTestId('describe-new-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  const leadFlow = /workflows\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.getByTestId('workflow-editor')).toBeVisible();
  await expect(page.getByTestId('workflow-name')).toHaveText('New lead text-back');
  const created = await statusOf(leadFlow);
  expect(created.status).toBe('draft');
  const dayWait = created.definition.steps.find(
    (s) => s.type === 'wait' && s.until?.duration?.unit === 'days',
  )!.id;

  // On the workflow's page, a change: the card lists it, Open shows the Describe diff, Apply makes it.
  await expect(page.getByTestId(`step-${dayWait}`)).toContainText('Wait 1 day');
  answer = await ask(page, 'Change this workflow to wait two days instead');
  await expect(panel(page).getByTestId('assistant-page')).toHaveText(
    'On this page: New lead text-back',
  );
  const changeCard = answer.getByTestId('assistant-card-workflow');
  await expect(changeCard).toContainText('Proposed change · 1 change');
  await expect(changeCard).toContainText('Change the wait from 1 day to 2 days');
  expect((await statusOf(leadFlow)).revision).toBe(created.revision);
  await changeCard.getByTestId('workflow-card-open').click();
  await expect(page).toHaveURL(/mode=describe&proposal=[0-9a-f-]{36}/);
  const pane = page.getByTestId('describe-pane');
  const proposal = pane.getByTestId('proposal-card');
  await expect(proposal.getByTestId('proposal-change')).toHaveCount(1);
  await expect(proposal.getByTestId('proposal-change')).toContainText(
    'Change the wait from 1 day to 2 days',
  );
  await expect(pane.getByTestId(`step-${dayWait}`)).toContainText('Wait 2 days');
  await expect(pane.getByTestId(`step-${dayWait}`)).toContainText('Changed');
  await proposal.getByTestId('proposal-apply').click();
  await expect(proposal.getByTestId('proposal-result')).toContainText(
    'Applied the change to the draft. One Undo takes it back.',
  );
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  const applied = await statusOf(leadFlow);
  expect(applied.definition.steps.find((s) => s.id === dayWait)?.until?.duration).toEqual({
    amount: 2,
    unit: 'days',
  });
  await page.getByTestId('mode-steps').click();
  await expect(page.getByTestId(`step-${dayWait}`)).toContainText('Wait 2 days');

  // 2. A workflow started by hand, for Mike, after the card.
  const { workflowId: followUp } = await createWorkflow(api, workspaceId, 'Follow-up call', [
    {
      id: 's_fuptask1',
      type: 'action',
      action: 'create_task',
      config: { title: 'Call them back' },
    },
  ]);
  await testAndPublish(api, workspaceId, followUp);
  await page.goto(`/app/w/${workspaceId}/customers/people/${mike}`);
  answer = await ask(page, 'Put him in Follow-up call');
  const start = answer.getByTestId('assistant-card-confirm');
  await expect(start).toContainText('Start “Follow-up call” for Mike Johnson?');
  await expect(start).toContainText('Step 1, create a task “Call them back”');
  expect(await runState(api, workspaceId, followUp, mike)).toBeNull();
  await start.getByTestId('assistant-confirm').click();
  await expect(start.getByTestId('assistant-result')).toContainText(
    'Started “Follow-up call” for Mike Johnson.',
  );
  await expect
    .poll(() => runState(api, workspaceId, followUp, mike), {
      timeout: 60_000,
      message: 'the engine starts Mike’s run and it finishes',
    })
    .toMatch(/^completed/);

  // 3. Pause and Resume, each after its card.
  answer = await ask(page, 'Pause Follow-up call');
  const pause = answer.getByTestId('assistant-card-confirm');
  await expect(pause).toContainText('Pause “Follow-up call”?');
  await expect(pause).toContainText('Ignored while it’s paused, not saved for later');
  expect((await statusOf(followUp)).status).toBe('active');
  await pause.getByTestId('assistant-confirm').click();
  await expect(pause.getByTestId('assistant-result')).toContainText('Paused “Follow-up call”.');
  expect((await statusOf(followUp)).status).toBe('paused');
  answer = await ask(page, 'Resume Follow-up call');
  const resume = answer.getByTestId('assistant-card-confirm');
  await expect(resume).toContainText('Resume “Follow-up call”?');
  await resume.getByTestId('assistant-confirm').click();
  await expect(resume.getByTestId('assistant-result')).toContainText(
    'Resumed “Follow-up call”. It starts again for anything new.',
  );
  expect((await statusOf(followUp)).status).toBe('active');

  // 4. An approval waiting on the owner, answered in the Assistant; the run carries on.
  const { workflowId: check } = await createWorkflow(api, workspaceId, 'Check first', [
    { id: 's_chkaprv1', type: 'approval', message: 'Check before we call them' },
    {
      id: 's_chknote1',
      type: 'action',
      action: 'add_note',
      config: { body: 'Approved in the Assistant' },
    },
  ]);
  await testAndPublish(api, workspaceId, check);
  await api('commands/workflow.enrol', { workspaceId, workflowId: check, personId: mike });
  await expect
    .poll(() => runState(api, workspaceId, check, mike), {
      timeout: 60_000,
      message: 'Mike’s run waits on the approval',
    })
    .toBe('awaiting_approval');
  answer = await ask(page, 'Approve it');
  const approve = answer.getByTestId('assistant-card-confirm');
  await expect(approve).toContainText('Approve the next step of “Check first” for Mike Johnson?');
  await expect(approve).toContainText('Check before we call them');
  await approve.getByTestId('assistant-confirm').click();
  await expect(approve.getByTestId('assistant-result')).toContainText(
    'Approved. “Check first” carries on for Mike Johnson.',
  );
  await expect
    .poll(() => runState(api, workspaceId, check, mike), {
      timeout: 60_000,
      message: 'the approved run finishes',
    })
    .toMatch(/^completed/);

  // 5. The knowledge base: answered from a published FAQ, with the item it used.
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
  answer = await ask(page, 'Do we offer financing?');
  await expect(answer.getByTestId('assistant-steps')).toContainText(
    'Searching your knowledge base',
  );
  await expect(answer).toContainText(
    'From your knowledge base: Yes, new systems can be financed over 60 months with approved credit.',
  );
  const kb = answer.getByTestId('assistant-card-knowledge');
  await expect(kb).toContainText('Do you offer financing?');
  await expect(kb.getByRole('link', { name: /Open Knowledge/ })).toHaveAttribute(
    'href',
    `/app/w/${workspaceId}/knowledge`,
  );
});
