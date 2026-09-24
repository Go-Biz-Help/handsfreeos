import type { Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { apiAs, signInForApi } from './workflow-approval-api';

/**
 * A new owner's business with a live "Job feedback" form and two answer sheets on it, for the forms specs. The form
 * and its answers are made through the API (`form_response.record`, as the phone fills one in), so a spec is about
 * what it tests and not the editor: Rosa's answer has a comma in it, and Tom's starts with `=`, as a formula would.
 */
export async function formWithAnswers(
  page: Page,
  label: string,
): Promise<{ workspaceId: string; formId: string; slug: string }> {
  const owner = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  const api = apiAs(await signInForApi(owner.email));

  const created = await api<{ formId: string; revision: number; slug: string }>(
    'commands/form.create',
    { workspaceId, name: 'Job feedback', mode: 'survey' },
  );
  const { formId } = created;
  const got = await api<{ definition: { pages: { id: string }[] } }>('queries/form.get', {
    workspaceId,
    formId,
  });
  const pageId = got.definition.pages[0]!.id;
  const add = (question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question,
  });
  const saved = await api<{ revision: number }>('commands/form.save_draft', {
    workspaceId,
    formId,
    baseRevision: created.revision,
    ops: [
      add({
        id: 'q_name0000',
        type: 'short_text',
        title: 'Your name',
        required: true,
        mapTo: 'person.first_name',
        config: {},
      }),
      // The form needs a way to reach them (identity "required", the default).
      add({
        id: 'q_phone000',
        type: 'phone',
        title: 'Your phone',
        mapTo: 'person.phone',
        config: {},
      }),
      add({
        id: 'q_rating00',
        type: 'rating',
        title: 'How did we do?',
        config: { max: 5, icon: 'star' },
      }),
      add({ id: 'q_notes000', type: 'long_text', title: 'Anything else?', config: {} }),
    ],
  });
  await api('commands/form.publish', { workspaceId, formId, baseRevision: saved.revision });

  const answer = (name: string, phone: string, rating: number, notes: string) =>
    api('commands/form_response.record', {
      workspaceId,
      formId,
      answers: { q_name0000: name, q_phone000: phone, q_rating00: rating, q_notes000: notes },
    });
  await answer('Rosa', '(512) 555-0301', 5, 'Late, but fixed it');
  await answer('Tom', '(512) 555-0302', 4, '=1+1');
  return { workspaceId, formId, slug: created.slug };
}

/** The heading row every export of that form starts with. */
export const JOB_FEEDBACK_HEADING =
  'Answered,Name,From,Your name,Your phone,How did we do?,Anything else?';
