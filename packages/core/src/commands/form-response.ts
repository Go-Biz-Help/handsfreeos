/**
 * Filling a form in, and what happens when it is sent.
 *
 * The worker runs these for people who are not signed in — the public page, the embed, a QR code, the AI
 * teammate asking the questions in a conversation — so they are the system actor's, after the worker's own
 * checks (rate limits, the honeypot, the resume token).
 *
 * The important part is that the server runs the same engine the page ran: the answers are pruned to the
 * questions that were actually showing, so an answer to a hidden question is dropped rather than recorded,
 * however the answers were posted. Then, in one transaction: the customer is matched or made, the fields
 * the business mapped are filled in, a lead and a task open if it asked for them, its workflows are asked
 * to start, and `form.submitted` goes out for everything else that waits on it.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { customFields, formResponses, forms, formVersions, people } from '@hfos/db/schema';
import { HfosError } from '../errors';
import {
  allQuestions,
  type FormDefinition,
  type FormResult,
} from '../forms/definition';
import { loadForm, parseStoredForm } from '../forms/load';
import { runCalculations, scoreAnswers, type AnswerSheet } from '../forms/logic';
import { choiceValues } from '../forms/definition';
import { formState, pickResult, recordAnswers, responseProblems } from '../forms/render';
import {
  contactFromAnswers,
  findOrCreateFormCustomer,
  hasIdentity,
  patchesFromAnswers,
  writeCustomFields,
  writeFormAnswers,
} from '../forms/submit';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { requireHuman } from '../kernel/actor';
import { LeadCreateInput } from '../schemas/lead';
import { PersonUpdateInput } from '../schemas/person';
import { TaskCreateInput } from '../schemas/task';
import { InvoiceCreateInput } from '../schemas/money';
import {
  FormResponseDeleteInput,
  FormResponseDeleteOutput,
  FormSaveAnswersInput,
  FormSaveAnswersOutput,
  FormStartInput,
  FormStartOutput,
  FormSubmitInput,
  FormSubmitOutput,
} from '../schemas/form';
import { invoiceCreate } from './invoice';
import { leadCreate } from './lead.create';
import { personUpdate } from './person.update';
import { taskCreate } from './task';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** A month to come back and finish. */
const RESUME_DAYS = 30;
const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();
const newToken = () => randomBytes(24).toString('base64url');
const hashOf = (value: string): Buffer => createHash('sha256').update(value).digest();

type ResponseRow = typeof formResponses.$inferSelect;

interface OpenResponse {
  readonly response: ResponseRow;
  readonly definition: FormDefinition;
  readonly form: typeof forms.$inferSelect;
}

/** The response with the version it was given on — never the draft, which may have moved on since. */
async function openResponse(
  ctx: CommandContext,
  responseId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<OpenResponse> {
  const ws = ctx.scope.workspaceId!;
  const query = ctx.tx
    .select()
    .from(formResponses)
    .where(and(eq(formResponses.id, responseId), eq(formResponses.workspaceId, ws)));
  const [response] = opts.forUpdate ? await query.for('update') : await query;
  if (!response) throw HfosError.notFound('That answer sheet isn’t there.');
  const [version] = await ctx.tx
    .select()
    .from(formVersions)
    .where(eq(formVersions.id, response.versionId));
  if (!version) throw HfosError.internal('The version this was filled in on is missing.');
  const [form] = await ctx.tx.select().from(forms).where(eq(forms.id, response.formId));
  if (!form) throw HfosError.notFound('Form not found.');
  return { response, definition: parseStoredForm(version.definition), form };
}

/** Whether a form is taking answers at all: live, not archived, not past its own closing rules. */
function assertOpen(form: typeof forms.$inferSelect, definition: FormDefinition): void {
  if (form.status !== 'live')
    throw HfosError.rule('form_closed', 409, definition.settings.closedMessage);
  const { closesAt, closesAfter } = definition.settings;
  if (closesAt && new Date(closesAt).getTime() <= Date.now())
    throw HfosError.rule('form_closed', 409, definition.settings.closedMessage);
  if (closesAfter !== null && form.responseCount >= closesAfter)
    throw HfosError.rule('form_closed', 409, definition.settings.closedMessage);
}

const answersOf = (response: ResponseRow): AnswerSheet =>
  (response.answers ?? {}) as unknown as AnswerSheet;

/**
 * Whoever holds the key may write to this sheet; knowing its id is not enough. The key is what a signed-out
 * page has instead of a sign-in, so it is required of the worker acting for one. The AI teammate is already
 * inside the business, working its own conversation, and carries no key.
 */
function assertHolder(ctx: CommandContext, response: ResponseRow, token: string | undefined): void {
  if (ctx.actor.type !== 'system') return;
  const held = response.resumeTokenHash;
  if (!token || !held || !timingSafeEqual(Buffer.from(held), hashToken(token)))
    throw HfosError.notFound('That answer sheet isn’t there.');
}

// ---- Commands ----

export const formResponseStart = defineCommand({
  name: 'form_response.start',
  description:
    'Begin an answer sheet for somebody opening a form, and hand back the token that lets them come back to it later.',
  risk: 1,
  input: FormStartInput,
  output: FormStartOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['form.started'],
  // The AI teammate asks a form's questions in a conversation, so it starts sheets too (M15).
  actors: ['system', 'ai_employee'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const { row, definition: draft } = await loadForm(ctx.tx, ws, input.formId);
    if (!row.activeVersionId) throw HfosError.notFound('This form isn’t published.');
    const [version] = await ctx.tx
      .select()
      .from(formVersions)
      .where(eq(formVersions.id, row.activeVersionId));
    const definition = version ? parseStoredForm(version.definition) : draft;
    assertOpen(row, definition);
    /**
     * Every sheet gets a key, because the page needs one to write to its own sheet and a response id on its
     * own must not be enough. Whether that key also becomes a "carry on later" link is the form's business:
     * an anonymous survey offers no way back to somebody's own answers.
     */
    const token = newToken();
    const canResume =
      definition.settings.saveAndResume && definition.settings.identity !== 'anonymous';
    const [response] = await ctx.tx
      .insert(formResponses)
      .values({
        workspaceId: ws,
        formId: row.id,
        versionId: row.activeVersionId,
        status: 'in_progress',
        source: input.source,
        visitorHash: input.visitorHash ? hashOf(input.visitorHash) : null,
        resumeTokenHash: hashToken(token),
        resumeExpiresAt: new Date(Date.now() + (canResume ? RESUME_DAYS : 1) * 86_400_000),
      })
      .returning({ id: formResponses.id });
    if (!response) throw HfosError.internal('The answer sheet could not be started.');
    await ctx.tx.execute(
      sql`insert into app.form_days (workspace_id, form_id, day, starts)
          values (${ws}, ${row.id}, current_date, 1)
          on conflict (form_id, day) do update set starts = app.form_days.starts + 1`,
    );
    await ctx.emit({
      type: 'form.started',
      entityType: 'form',
      entityId: row.id,
      payload: { responseId: response.id, source: input.source },
      broadcast: false,
    });
    return { responseId: response.id, versionId: row.activeVersionId, token, canResume };
  },
});

export const formResponseSave = defineCommand({
  name: 'form_response.save',
  description:
    'Keep the answers so far, so a long form survives a closed tab. Nothing happens to the business’s records until it is sent.',
  risk: 1,
  input: FormSaveAnswersInput,
  output: FormSaveAnswersOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system', 'ai_employee'],
  async handler(ctx, input) {
    const { response, definition, form } = await openResponse(ctx, input.responseId, {
      forUpdate: true,
    });
    assertHolder(ctx, response, input.token);
    if (response.status === 'completed')
      throw HfosError.conflict('This one has already been sent.', 'response_sent');
    assertOpen(form, definition);
    const merged = { ...answersOf(response), ...(input.answers as AnswerSheet) };
    const state = formState(definition, merged);
    await ctx.tx
      .update(formResponses)
      .set({ answers: state.answers as never })
      .where(eq(formResponses.id, response.id));
    return {
      responseId: response.id,
      progress: state.progress,
      calculations: state.calculations,
      problems: responseProblems(definition, state.answers).filter(
        (p) => p.message !== 'Answer this one.',
      ),
    };
  },
});

/** The result and the numbers a finished response lands on. */
function outcome(definition: FormDefinition, answers: AnswerSheet) {
  const score = scoreAnswers(allQuestions(definition), answers, definition.scoring);
  const calculations = runCalculations(
    definition.calculations,
    answers,
    choiceValues(definition),
  );
  const result: FormResult = pickResult(definition, answers);
  return { score, calculations, result };
}

/** What the form asks them to pay, in cents, once the answers are in. */
function dueCents(
  definition: FormDefinition,
  answers: AnswerSheet,
  calculations: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const question of allQuestions(definition)) {
    if (question.type !== 'payment') continue;
    const config = question.config as {
      amount:
        | { kind: 'fixed'; cents: number }
        | { kind: 'calculation'; calculationId: string }
        | { kind: 'question'; questionId: string };
      depositPercent: number | null;
    };
    const full =
      config.amount.kind === 'fixed'
        ? config.amount.cents
        : config.amount.kind === 'calculation'
          ? Math.round((calculations[config.amount.calculationId] ?? 0) * 100)
          : Math.round(Number(answers[config.amount.questionId] ?? 0) * 100);
    const share = config.depositPercent ? (full * config.depositPercent) / 100 : full;
    total += Math.max(0, Math.round(share));
  }
  return total;
}

export const formResponseSubmit = defineCommand({
  name: 'form_response.submit',
  description:
    'Send a filled-in form: check the answers, record them, match or make the customer, fill in what they told us, open a lead or a task, and ask its workflows to start.',
  // External, like booking for a customer: it makes records and something the customer sees, and every
  // message it leads to goes through a workflow with its own consent and quiet-hours rules.
  risk: 2,
  input: FormSubmitInput,
  output: FormSubmitOutput,
  permission: null,
  scope: inWorkspace,
  emits: [
    'form.submitted',
    'person.created',
    'lead.created',
    'task.created',
    'invoice.created',
    'workflow.enrol_requested',
  ],
  actors: ['system', 'ai_employee'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const { response, definition, form } = await openResponse(ctx, input.responseId, {
      forUpdate: true,
    });
    assertHolder(ctx, response, input.token);
    if (response.status === 'completed')
      throw HfosError.conflict('This one has already been sent.', 'response_sent');
    assertOpen(form, definition);

    // The page's answers and the ones already saved, pruned to what was actually showing.
    const merged = { ...answersOf(response), ...(input.answers as AnswerSheet) };
    const state = formState(definition, merged);
    const answers = state.answers;
    const problems = responseProblems(definition, answers);
    if (problems.length)
      throw new HfosError(
        'validation',
        400,
        'Some answers still need attention.',
        { problems },
        'form_answers_invalid',
      );

    const { identity } = definition.settings;
    const contact = contactFromAnswers(definition, answers);
    if (identity === 'required' && !hasIdentity(contact))
      throw HfosError.rule(
        'form_needs_identity',
        400,
        'This form needs a phone number or an email address.',
      );

    const { score, calculations, result } = outcome(definition, answers);
    const recorded = recordAnswers(definition, answers);

    // ---- The customer ----
    let personId: string | null = null;
    let leadId: string | null = null;
    const source = definition.onSubmit.person.source || form.name;
    if (identity !== 'anonymous' && hasIdentity(contact) && definition.onSubmit.person.create) {
      const found = await findOrCreateFormCustomer(ctx, contact, source);
      personId = found.personId;
      const { person, lead } = patchesFromAnswers(definition, answers);
      // Only what the business doesn't already know: a form never rubs out what somebody typed.
      if (!found.created && Object.keys(person.fields).length) {
        const [existing] = await ctx.tx.select().from(people).where(eq(people.id, personId));
        const fill: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(person.fields)) {
          const already = (existing as unknown as Record<string, unknown>)[key];
          if (already === null || already === undefined || already === '') fill[key] = value;
        }
        if (Object.keys(fill).length)
          await personUpdate.handler(
            ctx,
            PersonUpdateInput.parse({ workspaceId: ws, personId, ...fill }),
          );
      }
      const mine = await ctx.tx
        .select({ id: customFields.id, entity: customFields.entity })
        .from(customFields)
        .where(and(eq(customFields.workspaceId, ws), dsql`archived_at is null`));
      await writeCustomFields(
        ctx.tx,
        'people',
        personId,
        person.custom,
        new Set(mine.filter((f) => f.entity === 'person').map((f) => f.id)),
      );

      // ---- The lead ----
      const wanted = definition.onSubmit.lead;
      if (wanted && typeof wanted.pipelineId === 'string' && typeof wanted.stageId === 'string') {
        const title =
          (typeof lead.fields.title === 'string' && lead.fields.title) || `${form.name}: ${contact.firstName || 'New enquiry'}`;
        // Money in this system is whole cents; a calculation counts in dollars.
        const quoted = wanted.valueFrom ? (calculations[wanted.valueFrom] ?? null) : null;
        const typedValue = typeof lead.fields.value === 'number' ? lead.fields.value : null;
        const valueCents = Math.round((quoted ?? typedValue ?? 0) * 100);
        const created = await leadCreate.handler(
          ctx,
          LeadCreateInput.parse({
            workspaceId: ws,
            personId,
            pipelineId: wanted.pipelineId,
            stageId: wanted.stageId,
            title: title.slice(0, 160),
            valueCents,
            source,
          }),
        );
        leadId = created.leadId;
        await writeCustomFields(
          ctx.tx,
          'leads',
          leadId,
          lead.custom,
          new Set(mine.filter((f) => f.entity === 'lead').map((f) => f.id)),
        );
      }

      // ---- A task for somebody ----
      const task = definition.onSubmit.task;
      if (task)
        await taskCreate.handler(
          ctx,
          TaskCreateInput.parse({
            workspaceId: ws,
            title: task.title.slice(0, 160),
            personId,
            leadId,
            dueAt: new Date(Date.now() + task.dueInDays * 86_400_000).toISOString(),
            assigneeUserId:
              task.assignTo.kind === 'user' && typeof task.assignTo.userId === 'string'
                ? task.assignTo.userId
                : null,
          }),
        );

      // ---- Its workflows ----
      // The engine starts runs; nobody inserts one. The same request event the Add to workflow button sends.
      for (const workflowRef of definition.onSubmit.workflowIds) {
        if (typeof workflowRef !== 'string') continue;
        const [workflow] = await rows<{ id: string; active_version_id: string | null }>(
          ctx.tx,
          sql`select id, active_version_id from app.workflows
              where id = ${workflowRef} and workspace_id = ${ws} and status = 'active'`,
        );
        if (!workflow?.active_version_id) continue;
        await ctx.emit({
          type: 'workflow.enrol_requested',
          entityType: 'workflow',
          entityId: workflow.id,
          payload: {
            workflowId: workflow.id,
            versionId: workflow.active_version_id,
            personId,
            requestedBy: null,
            via: 'form',
            formId: form.id,
          },
          broadcast: false,
        });
      }
    }

    // ---- What they owe ----
    // A form that asks for money raises an invoice for it, so the payment goes through M9 like every other
    // one the business takes: the same document, the same page to pay on, the same receipt. The card itself
    // is taken on that page — a form never holds one.
    const due = dueCents(definition, answers, calculations);
    let invoiceId: string | null = null;
    if (due > 0 && personId) {
      const paymentQuestion = allQuestions(definition).find((q) => q.type === 'payment');
      const created = await invoiceCreate.handler(
        ctx,
        InvoiceCreateInput.parse({
          workspaceId: ws,
          personId,
          leadId,
          origin: 'form',
          title: form.name,
          lines: [
            {
              name:
                (paymentQuestion?.config as { description?: string } | undefined)?.description ??
                form.name,
              quantity: 1,
              unitPriceCents: due,
            },
          ],
        }),
      );
      invoiceId = created.invoiceId;
    }
    if (personId && definition.settings.oneResponsePerPerson) {
      const [already] = await rows<{ id: string }>(
        ctx.tx,
        sql`select id from app.form_responses
            where form_id = ${form.id} and person_id = ${personId} and status = 'completed'
              and one_per_person limit 1`,
      );
      if (already)
        throw HfosError.rule(
          'already_answered',
          409,
          'You have already answered this form.',
        );
    }
    await ctx.tx
      .update(formResponses)
      .set({
        status: 'completed',
        completedAt: dsql`now()`,
        answers: answers as never,
        calculations: calculations as never,
        score: String(score.points),
        scorePossible: String(score.possible),
        scorePercent: score.percent,
        passed: score.passed,
        resultId: result.id,
        personId,
        leadId,
        invoiceId,
        // What the form asked for at the moment they answered; the unique index reads this, not the setting.
        onePerPerson: definition.settings.oneResponsePerPerson,
      })
      .where(eq(formResponses.id, response.id));
    await writeFormAnswers(
      ctx.tx,
      { workspaceId: ws, responseId: response.id, formId: form.id },
      recorded,
    );
    await ctx.tx.execute(
      sql`insert into app.form_days (workspace_id, form_id, day, completions)
          values (${ws}, ${form.id}, current_date, 1)
          on conflict (form_id, day) do update set completions = app.form_days.completions + 1`,
    );
    if (personId && input.smsConsent)
      await ctx.tx
        .update(people)
        .set({
          smsConsent: 'opted_in',
          smsConsentAt: dsql`now()`,
          smsConsentSource: `Form: ${form.name}`,
        })
        .where(and(eq(people.id, personId), dsql`sms_consent <> 'opted_out'`));

    await ctx.emit({
      type: 'form.submitted',
      entityType: 'form',
      entityId: form.id,
      payload: {
        responseId: response.id,
        formId: form.id,
        versionId: response.versionId,
        personId,
        leadId,
        resultId: result.id,
        mode: definition.mode,
        score: score.points,
        scorePercent: score.percent,
        passed: score.passed,
        dueCents: due,
        invoiceId,
      },
      after: {
        form: form.name,
        answers: recorded.length,
        ...(score.graded ? { score: `${score.correct} of ${score.graded} right` } : {}),
      },
    });

    return {
      responseId: response.id,
      personId,
      leadId,
      resultId: result.id,
      score: score.graded ? score.points : null,
      scorePercent: score.graded ? score.percent : null,
      passed: score.passed,
      calculations,
      dueCents: due,
      invoiceId,
    };
  },
});

export const formResponseDelete = defineCommand({
  name: 'form_response.delete',
  description:
    'Delete one response: a test of your own, or a customer asking to be forgotten. The answers go with it.',
  risk: 2,
  input: FormResponseDeleteInput,
  output: FormResponseDeleteOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.response_deleted'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    requireHuman(ctx);
    // The columns a person may read: the token hashes are the worker's alone (0074's column grants).
    const [response] = await ctx.tx
      .select({
        id: formResponses.id,
        formId: formResponses.formId,
        completedAt: formResponses.completedAt,
      })
      .from(formResponses)
      .where(and(eq(formResponses.id, input.responseId), eq(formResponses.workspaceId, ws)));
    if (!response) throw HfosError.notFound('That answer sheet isn’t there.');
    await ctx.tx.delete(formResponses).where(eq(formResponses.id, response.id));
    await ctx.emit({
      type: 'form.response_deleted',
      entityType: 'form',
      entityId: response.formId,
      payload: { responseId: response.id },
      before: { answered: response.completedAt?.toISOString() ?? null },
    });
    return { responseId: response.id, deleted: true as const };
  },
});

export const formResponseCommands = [
  formResponseStart,
  formResponseSave,
  formResponseSubmit,
  formResponseDelete,
] as const;

/** The response a resume link points at, for the worker serving /f/…?resume=… */
export async function responseByResumeToken(
  ctx: CommandContext,
  token: string,
): Promise<{ responseId: string; formId: string } | null> {
  const [found] = await rows<{ id: string; form_id: string }>(
    ctx.tx,
    sql`select id, form_id from app.form_responses
        where resume_token_hash = ${hashToken(token)} and status = 'in_progress'
          and (resume_expires_at is null or resume_expires_at > now())`,
  );
  return found ? { responseId: found.id, formId: found.form_id } : null;
}
