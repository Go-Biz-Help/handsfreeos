/**
 * Forms (M15, M17): Lone Star's "Job feedback" survey, live, with three answer sheets on it, so its Results tab, its
 * Share tab and the phone's form page open on something, and the phone's flows can read one answer sheet and delete it
 * (apps/mobile/maestro/forms.yaml).
 *
 * Anonymous on purpose: the answers match and make no customer, so nothing else the seed counts — customers, leads,
 * the Action Center — moves because of them. Every change goes through the commands: Dale builds and publishes the
 * form, and the answers arrive the way a customer's do on its link — started, then sent, by HandsFreeOS itself, as the
 * worker's /public/form routes run them.
 */
import {
  executeCommand,
  executeQuery,
  formCreate,
  formGet,
  formPublish,
  formResponseStart,
  formResponseSubmit,
  formSaveDraft,
  type CommandDef,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { systemActor, workerMeta } from '../src/services';

export interface SeedFormsDeps {
  readonly api: Db;
  /** The worker's connection, for what a customer's own link does. */
  readonly worker: Db;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
}

export interface SeededForms {
  readonly name: string;
  readonly slug: string;
  readonly answers: number;
}

/** What the three customers said, oldest first: the newest is the one the phone's flow opens first and deletes. */
export const JOB_FEEDBACK_ANSWERS = [
  { rating: 5, again: 'c_yes00000', notes: 'On time and tidy. Priya explained everything.' },
  { rating: 4, again: 'c_yes00000', notes: 'Good work, a little late.' },
  { rating: 2, again: 'c_maybe000', notes: 'Took two visits to fix the upstairs unit.' },
] as const;

export async function seedForms(
  deps: SeedFormsDeps,
  lonestar: {
    readonly workspaceId: string;
    readonly organizationId: string;
    readonly dale: TestUser;
  },
): Promise<SeededForms> {
  const { workspaceId, organizationId, dale } = lonestar;
  const run = async <I extends z.ZodType, O extends z.ZodType>(
    cmd: CommandDef<I, O>,
    input: unknown,
  ): Promise<z.output<O>> =>
    (await executeCommand(deps.api, cmd, input, deps.actor(dale), deps.meta())).output;

  deps.step('Forms: Lone Star’s "Job feedback" survey, live, with three answers');
  const created = await run(formCreate, { workspaceId, name: 'Job feedback', mode: 'survey' });
  const got = await executeQuery(
    deps.api,
    formGet,
    { workspaceId, formId: created.formId },
    deps.actor(dale),
    deps.meta(),
  );
  const pageId = (got.definition as { pages: { id: string }[] }).pages[0]!.id;
  const add = (question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question,
  });
  const saved = await run(formSaveDraft, {
    workspaceId,
    formId: created.formId,
    baseRevision: created.revision,
    ops: [
      { op: 'set_settings', patch: { identity: 'anonymous' } },
      add({
        id: 'q_rating00',
        type: 'rating',
        title: 'How did we do?',
        required: true,
        config: { max: 5, icon: 'star' },
      }),
      add({
        id: 'q_again000',
        type: 'choice',
        title: 'Would you use us again?',
        config: {
          choices: [
            { id: 'c_yes00000', label: 'Yes' },
            { id: 'c_maybe000', label: 'Maybe' },
          ],
        },
      }),
      add({ id: 'q_notes000', type: 'long_text', title: 'Anything else?', config: {} }),
    ],
  });
  await run(formPublish, {
    workspaceId,
    formId: created.formId,
    baseRevision: saved.revision,
  });
  // As the customer's link does it (apps/worker/src/http/forms.ts): a sheet started, then sent with its key.
  const customer = async <I extends z.ZodType, O extends z.ZodType>(
    cmd: CommandDef<I, O>,
    input: unknown,
  ): Promise<z.output<O>> =>
    (
      await executeCommand(
        deps.worker,
        cmd,
        input,
        systemActor({ workspaceId, organizationId }),
        workerMeta(),
      )
    ).output;
  for (const a of JOB_FEEDBACK_ANSWERS) {
    const sheet = await customer(formResponseStart, {
      workspaceId,
      formId: created.formId,
      source: 'link',
      visitorHash: null,
    });
    await customer(formResponseSubmit, {
      workspaceId,
      responseId: sheet.responseId,
      token: sheet.token,
      answers: { q_rating00: a.rating, q_again000: a.again, q_notes000: a.notes },
      smsConsent: false,
    });
  }
  return { name: 'Job feedback', slug: created.slug, answers: JOB_FEEDBACK_ANSWERS.length };
}
