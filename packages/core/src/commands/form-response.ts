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
import {
  customFields,
  formLinks,
  formResponses,
  forms,
  formVersions,
  people,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { allQuestions, type FormDefinition, type FormResult } from '../forms/definition';
import { loadForm, parseStoredForm } from '../forms/load';
import { runCalculations, scoreAnswers, type AnswerSheet } from '../forms/logic';
import { choiceValues } from '../forms/definition';
import { FORM_LINK_DAYS, knownTargetsOf, type FillContext } from '../forms/personal';
import {
  formState,
  pageProblems,
  pickResult,
  recordAnswers,
  responseProblems,
} from '../forms/render';
import {
  contactFromAnswers,
  hasIdentity,
  patchesFromAnswers,
  type FormContact,
  writeCustomFields,
  writeFormAnswers,
} from '../forms/submit';
import { insertWithId } from '../crm/client-ids';
import { otherPhonesOf } from '../crm/contact-points';
import { normalizePhone } from '../crm/phone';
import { findOrCreateCustomer, intakeSourceOf, takeIntakeSlot } from '../crm/intake';
import { recordSmsConsent } from '../crm/signup';
import { workspaceZone } from '../calendar/load';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { requireHuman } from '../kernel/actor';
import { LeadCreateInput } from '../schemas/lead';
import { PersonUpdateInput } from '../schemas/person';
import { TaskCreateInput } from '../schemas/task';
import { InvoiceCreateInput } from '../schemas/money';
import {
  FormLinkCreateInput,
  FormLinkCreateOutput,
  FormRecordInput,
  FormResponseDeleteInput,
  FormResponseDeleteOutput,
  FormSaveAnswersInput,
  FormSaveAnswersOutput,
  FormSaveContactInput,
  FormSaveContactOutput,
  FormStartInput,
  FormStartOutput,
  FormSubmitInput,
  FormSubmitOutput,
} from '../schemas/form';
import { invoiceCreate } from './invoice';
import { leadCreate } from './lead.create';
import { personUpdate } from './person.update';
import { taskCreate } from './task';
import { recordOffersConsent } from '../messaging/offers';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** A month to come back and finish. */
const RESUME_DAYS = 30;
const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();
const newToken = () => randomBytes(24).toString('base64url');
const hashOf = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Every column a person may read (the grants in 0074 and 0109): the resume key's hash, when it runs out and the
 * visitor's hash are the worker's alone. `form_response.record` runs as the teammate holding the phone, so a sheet
 * is always read this way, and the one check that needs the key's hash asks for it itself (`assertHolder`).
 */
const READABLE_SHEET = {
  id: formResponses.id,
  workspaceId: formResponses.workspaceId,
  formId: formResponses.formId,
  versionId: formResponses.versionId,
  status: formResponses.status,
  source: formResponses.source,
  personId: formResponses.personId,
  leadId: formResponses.leadId,
  invoiceId: formResponses.invoiceId,
  answers: formResponses.answers,
  calculations: formResponses.calculations,
  score: formResponses.score,
  scorePossible: formResponses.scorePossible,
  scorePercent: formResponses.scorePercent,
  passed: formResponses.passed,
  resultId: formResponses.resultId,
  onePerPerson: formResponses.onePerPerson,
  formLinkId: formResponses.formLinkId,
  startedAt: formResponses.startedAt,
  completedAt: formResponses.completedAt,
} as const;

type ResponseRow = {
  [K in keyof typeof READABLE_SHEET]: (typeof formResponses.$inferSelect)[K];
};

interface OpenResponse {
  readonly response: ResponseRow;
  readonly definition: FormDefinition;
  readonly form: typeof forms.$inferSelect;
}

/** A sheet somebody filling in the form can't reach: gone, or a link that has run out. */
const SHEET_GONE =
  'We couldn’t find these answers. The link may have run out. Open the form again to start over.';

/** The response with the version it was given on — never the draft, which may have moved on since. */
async function openResponse(
  ctx: CommandContext,
  responseId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<OpenResponse> {
  const ws = ctx.scope.workspaceId!;
  const query = ctx.tx
    .select(READABLE_SHEET)
    .from(formResponses)
    .where(and(eq(formResponses.id, responseId), eq(formResponses.workspaceId, ws)));
  const [response] = opts.forUpdate ? await query.for('update') : await query;
  if (!response) throw HfosError.notFound(SHEET_GONE);
  const [version] = await ctx.tx
    .select()
    .from(formVersions)
    .where(eq(formVersions.id, response.versionId));
  if (!version)
    throw HfosError.internal(
      'This form changed while it was being filled in. Refresh the page and try again.',
    );
  const [form] = await ctx.tx.select().from(forms).where(eq(forms.id, response.formId));
  if (!form)
    throw HfosError.notFound(
      'This form isn’t available anymore. Contact the business if you still need it.',
    );
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
async function assertHolder(
  ctx: CommandContext,
  response: ResponseRow,
  token: string | undefined,
): Promise<void> {
  if (ctx.actor.type !== 'system') return;
  const [row] = await ctx.tx
    .select({ held: formResponses.resumeTokenHash })
    .from(formResponses)
    .where(eq(formResponses.id, response.id));
  const held = row?.held;
  if (token && held && timingSafeEqual(Buffer.from(held), hashToken(token))) return;
  // A personal link's key writes to the sheet it started, from any text it came in (funnels).
  if (token && response.formLinkId && response.personId) {
    const [link] = await ctx.tx
      .select({ id: formLinks.id })
      .from(formLinks)
      .where(
        and(
          eq(formLinks.keyHash, hashToken(token)),
          eq(formLinks.formId, response.formId),
          eq(formLinks.personId, response.personId),
          dsql`${formLinks.expiresAt} > now()`,
        ),
      );
    if (link) return;
  }
  throw HfosError.notFound(SHEET_GONE);
}

/** What a personal link's page has to start over with: a link that ran out, or one for another form. */
const LINK_GONE =
  'This link has run out. Open the form from the business’s website, or ask them to send it again.';

/** The live personal link a key is for, on this form, and whose it is. */
async function linkByKey(
  ctx: CommandContext,
  formId: string,
  key: string,
): Promise<{ id: string; personId: string; expiresAt: Date }> {
  const [link] = await ctx.tx
    .select({ id: formLinks.id, personId: formLinks.personId, expiresAt: formLinks.expiresAt })
    .from(formLinks)
    .innerJoin(people, eq(people.id, formLinks.personId))
    .where(
      and(
        eq(formLinks.keyHash, hashToken(key)),
        eq(formLinks.formId, formId),
        dsql`${formLinks.expiresAt} > now()`,
      ),
    );
  if (!link) throw HfosError.rule('form_link_gone', 404, LINK_GONE);
  return link;
}

/**
 * Who is filling a sheet in, for the engine: on a sheet from a personal link, the contact details we already
 * have, so the questions that fill them are skipped — unless they asked to give them again.
 */
async function fillFor(
  ctx: CommandContext,
  response: ResponseRow,
  askAgain: boolean,
): Promise<FillContext> {
  if (!response.formLinkId || !response.personId || askAgain) return {};
  const [person] = await ctx.tx
    .select({
      firstName: people.firstName,
      lastName: people.lastName,
      email: people.email,
      phone: people.phoneE164,
    })
    .from(people)
    .where(eq(people.id, response.personId));
  return person ? { known: knownTargetsOf(person) } : {};
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
    if (!row.activeVersionId)
      throw HfosError.notFound(
        'This form isn’t taking answers yet. Try again later, or contact the business.',
      );
    const [version] = await ctx.tx
      .select()
      .from(formVersions)
      .where(eq(formVersions.id, row.activeVersionId));
    const definition = version ? parseStoredForm(version.definition) : draft;
    assertOpen(row, definition);

    // A personal link (funnels): their own unfinished sheet from a link to this form, or a new one that's theirs.
    const link = input.personalKey ? await linkByKey(ctx, row.id, input.personalKey) : null;
    if (link) {
      await ctx.tx
        .update(formLinks)
        .set({ openedAt: dsql`coalesce(${formLinks.openedAt}, now())` })
        .where(eq(formLinks.id, link.id));
      const [open] = await rows<{ id: string; version_id: string }>(
        ctx.tx,
        sql`select id, version_id from app.form_responses
            where form_id = ${row.id} and person_id = ${link.personId} and status = 'in_progress'
              and form_link_id is not null
            order by started_at desc limit 1`,
      );
      if (open)
        return {
          responseId: open.id,
          versionId: open.version_id,
          token: input.personalKey!,
          canResume: true,
        };
    }

    /**
     * Every sheet gets a key, because the page needs one to write to its own sheet and a response id on its
     * own must not be enough. Whether that key also becomes a "carry on later" link is the form's business:
     * an anonymous survey offers no way back to somebody's own answers. A personal link's sheet takes the
     * link's own key, since the link already carries on where they left off.
     */
    const token = link ? input.personalKey! : newToken();
    const canResume =
      link !== null ||
      (definition.settings.saveAndResume && definition.settings.identity !== 'anonymous');
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
        resumeExpiresAt: link
          ? link.expiresAt
          : new Date(Date.now() + (canResume ? RESUME_DAYS : 1) * 86_400_000),
        personId: link?.personId ?? null,
        formLinkId: link?.id ?? null,
      })
      .returning({ id: formResponses.id });
    if (!response)
      throw HfosError.internal(
        'The form couldn’t be started just now. Refresh the page and try again.',
      );
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
    await assertHolder(ctx, response, input.token);
    if (response.status === 'completed')
      throw HfosError.conflict(
        'These answers were already sent, so there’s nothing more to do.',
        'response_sent',
      );
    assertOpen(form, definition);
    const fill = await fillFor(ctx, response, input.askAgain);
    const merged = { ...answersOf(response), ...(input.answers as AnswerSheet) };
    const state = formState(definition, merged, fill);
    await ctx.tx
      .update(formResponses)
      .set({ answers: state.answers as never })
      .where(eq(formResponses.id, response.id));
    return {
      responseId: response.id,
      progress: state.progress,
      calculations: state.calculations,
      problems: responseProblems(definition, state.answers, fill).filter(
        (p) => p.message !== 'Answer this one.',
      ),
    };
  },
});

/** The result and the numbers a finished response lands on. */
function outcome(definition: FormDefinition, answers: AnswerSheet) {
  const score = scoreAnswers(allQuestions(definition), answers, definition.scoring);
  const calculations = runCalculations(definition.calculations, answers, choiceValues(definition));
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

interface Settled {
  readonly personId: string | null;
  readonly leadId: string | null;
}

/**
 * Who the answers are from, made real: the customer matched or made, the blanks the answers fill written in,
 * the invented fields, and the lead the form or Lead intake asks for. Sending a form does it, and so does leaving
 * the page that saves their details part way (funnels), which is why it's one function.
 *
 * A sheet that already knows who it's for (a personal link, or details saved on an earlier page) keeps that
 * customer, and a lead it already opened stays the lead. Either way an answer only fills what's blank: a
 * different phone joins their other numbers, and nothing on file is written over, so a forwarded link can't
 * change somebody's details.
 */
async function settleCustomer(
  ctx: CommandContext,
  args: {
    readonly definition: FormDefinition;
    readonly form: typeof forms.$inferSelect;
    readonly response: ResponseRow;
    readonly answers: AnswerSheet;
    readonly contact: FormContact;
    readonly calculations: Readonly<Record<string, number>>;
  },
): Promise<Settled> {
  const { definition, form, response, answers, contact, calculations } = args;
  const ws = ctx.scope.workspaceId!;
  const { identity } = definition.settings;
  let personId: string | null = null;
  let leadId: string | null = response.leadId;
  const source = definition.onSubmit.person.source || form.name;
  /**
   * Where this form's leads belong (M14): the business's one row for the forms built here, which is what
   * Settings → Lead intake shows and turns off. The form's own choice of pipeline still wins when it has
   * one; the row is what a form that names none falls back to. The day is counted but never refused — a
   * form somebody sat down and filled in is not a robocall.
   */
  const intake = await intakeSourceOf(ctx.tx, ws, 'website_form');
  const known = response.personId !== null;
  if (identity === 'anonymous') return { personId: null, leadId: null };
  if (!known && !(hasIdentity(contact) && definition.onSubmit.person.create))
    return { personId: null, leadId };
  const found = known
    ? { personId: response.personId!, created: false }
    : await findOrCreateCustomer(
        ctx,
        {
          firstName: contact.firstName,
          lastName: contact.lastName,
          phone: contact.phone,
          email: contact.email,
          address: contact.address,
        },
        source,
      );
  personId = found.personId;
  const { person, lead } = patchesFromAnswers(definition, answers);
  // Only what the business doesn't already know: a form never rubs out what somebody typed.
  if (!found.created && Object.keys(person.fields).length) {
    const [existing] = await ctx.tx.select().from(people).where(eq(people.id, personId));
    const onFile = [
      existing?.phoneE164,
      ...otherPhonesOf(existing?.otherPhones).map((p) => p.phone),
    ];
    const fill: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(person.fields)) {
      const e164 = typeof value === 'string' ? normalizePhone(value) : null;
      if (key === 'phoneAlt') {
        // Another number joins the others (0103) when it reads as one and isn't on file already: a form
        // never relabels a number the business has, and a stray answer never sinks the submission.
        if (e164 && !onFile.includes(e164)) fill[key] = value;
        continue;
      }
      const already = (existing as unknown as Record<string, unknown>)[key];
      if (already === null || already === undefined || already === '') {
        fill[key] = value;
        continue;
      }
      // A phone that isn't the one on file joins their other numbers rather than replacing it.
      if (key === 'phone' && e164 && !onFile.includes(e164) && fill.phoneAlt === undefined)
        fill.phoneAlt = value;
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
  /**
   * A form the business asked for a lead from always opens one where it says. A plain form that says
   * nothing opens one anyway (M14): Lead intake is the switch, the way it is for a text, and its row
   * says where those leads land. A survey or a quiz never opens one by itself — somebody rating their
   * visit is not an enquiry — so those still have to ask.
   */
  const wanted = definition.onSubmit.lead;
  const named =
    wanted && typeof wanted.pipelineId === 'string' && typeof wanted.stageId === 'string'
      ? { pipelineId: wanted.pipelineId, stageId: wanted.stageId }
      : null;
  const byIntake = form.mode === 'form' && intake.createLead;
  // A lead this sheet already opened (on the page that saved their details) stays the one lead.
  if (leadId === null && intake.active && (named || byIntake)) {
    const title =
      (typeof lead.fields.title === 'string' && lead.fields.title) ||
      `${form.name}: ${contact.firstName || 'New enquiry'}`;
    // Money in this system is whole cents; a calculation counts in dollars.
    const quoted = wanted?.valueFrom ? (calculations[wanted.valueFrom] ?? null) : null;
    const typedValue = typeof lead.fields.value === 'number' ? lead.fields.value : null;
    const valueCents = Math.round((quoted ?? typedValue ?? 0) * 100);
    const created = await leadCreate.handler(
      ctx,
      LeadCreateInput.parse({
        workspaceId: ws,
        personId,
        // Neither the form nor Lead intake names one: lead.create puts it in the first open stage of
        // the business's first pipeline, which is where a lead starts everywhere else too.
        ...(named ??
          (intake.pipelineId && intake.stageId
            ? { pipelineId: intake.pipelineId, stageId: intake.stageId }
            : {})),
        title: title.slice(0, 160),
        valueCents,
        source,
      }),
    );
    leadId = created.leadId;
    // The day's count is the worker's (0072): it measures what arrives on its own, and a teammate typing a
    // customer's answers in on the phone is not that.
    if (ctx.actor.type !== 'human')
      await takeIntakeSlot(ctx.tx, ws, intake, await workspaceZone(ctx.tx, ws), new Date(), false);
    await writeCustomFields(
      ctx.tx,
      'leads',
      leadId,
      lead.custom,
      new Set(mine.filter((f) => f.entity === 'lead').map((f) => f.id)),
    );
  }
  return { personId, leadId };
}

/** A sheet whose answers don't stand up yet: the problems, by question, for the page to mark. */
function answersInvalid(problems: readonly { questionId: string; message: string }[]): HfosError {
  return new HfosError(
    'validation',
    400,
    problems.length === 1
      ? 'One answer still needs attention. Fix the one marked and try again.'
      : `${problems.length} answers still need attention. Fix the ones marked and try again.`,
    { problems },
    'form_answers_invalid',
  );
}

export const formResponseSaveContact = defineCommand({
  name: 'form_response.save_contact',
  description:
    'Leaving the page of a form that saves their details (funnels): match or make the customer, fill in what that page said, open the lead, and keep the answers so far. The rest happens when the form is sent.',
  // External, as sending is: it makes a customer and a lead, and whatever texts them goes through its own rules.
  risk: 2,
  input: FormSaveContactInput,
  output: FormSaveContactOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['form.contact_saved', 'person.created', 'person.updated', 'lead.created'],
  actors: ['system'],
  async handler(ctx, input) {
    const { response, definition, form } = await openResponse(ctx, input.responseId, {
      forUpdate: true,
    });
    await assertHolder(ctx, response, input.token);
    if (response.status === 'completed')
      throw HfosError.conflict(
        'These answers were already sent, so there’s nothing more to do.',
        'response_sent',
      );
    assertOpen(form, definition);
    const page = definition.pages.find((p) => p.savesContact);
    if (!page || definition.settings.identity === 'anonymous')
      throw HfosError.rule(
        'form_saves_no_contact',
        400,
        'This form keeps your details when you send it at the end. Carry on to the last page.',
      );

    const fill = await fillFor(ctx, response, input.askAgain);
    const merged = { ...answersOf(response), ...(input.answers as AnswerSheet) };
    const state = formState(definition, merged, fill);
    const answers = state.answers;
    const problems = pageProblems(definition, answers, page.id, fill);
    if (problems.length) throw answersInvalid(problems);
    const contact = contactFromAnswers(definition, answers);
    if (!response.personId && !hasIdentity(contact))
      throw HfosError.rule(
        'form_needs_identity',
        400,
        'Add a phone number or an email address, so the business can reach you.',
      );

    const { calculations } = outcome(definition, answers);
    const { personId, leadId } = await settleCustomer(ctx, {
      definition,
      form,
      response,
      answers,
      contact,
      calculations,
    });
    await ctx.tx
      .update(formResponses)
      .set({ answers: answers as never, personId, leadId })
      .where(eq(formResponses.id, response.id));
    if (personId && input.smsConsent)
      await recordSmsConsent(ctx.tx, personId, `Form: ${form.name}`);
    if (personId && input.offersConsent)
      await recordOffersConsent(ctx.tx, personId, `Form: ${form.name}`.slice(0, 80));
    if (personId)
      await ctx.emit({
        type: 'form.contact_saved',
        entityType: 'form',
        entityId: form.id,
        payload: { responseId: response.id, formId: form.id, personId, leadId },
        after: { form: form.name },
      });
    return { responseId: response.id, personId, leadId };
  },
});

export const formLinkCreate = defineCommand({
  name: 'form_link.create',
  description:
    'Make a personal link to a form for one customer (funnels): it knows who it’s for, so their details aren’t asked again. Hands back the key for the link once; only its hash is kept.',
  risk: 1,
  input: FormLinkCreateInput,
  output: FormLinkCreateOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['form_link.created'],
  // A workflow's "Send a form" makes these; nobody signed in reads or writes them.
  actors: ['system', 'workflow'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [form] = await ctx.tx
      .select({ id: forms.id })
      .from(forms)
      .where(and(eq(forms.id, input.formId), eq(forms.workspaceId, ws)));
    if (!form) throw HfosError.notFound('That form isn’t in this business.');
    const [person] = await ctx.tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, input.personId), eq(people.workspaceId, ws)));
    if (!person) throw HfosError.notFound('That customer isn’t in this business.');
    const key = newToken();
    const expiresAt = new Date(Date.now() + FORM_LINK_DAYS * 86_400_000);
    const [link] = await ctx.tx
      .insert(formLinks)
      .values({
        workspaceId: ws,
        formId: form.id,
        personId: person.id,
        keyHash: hashToken(key),
        expiresAt,
      })
      .returning({ id: formLinks.id });
    // The audit line says who it's for and which form; never the key.
    await ctx.emit({
      type: 'form_link.created',
      entityType: 'form',
      entityId: form.id,
      payload: { formLinkId: link!.id, formId: form.id, personId: person.id },
      broadcast: false,
    });
    return { formLinkId: link!.id, key, expiresAt: expiresAt.toISOString() };
  },
});

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
    // Filling in a blank on a customer we already had (personUpdate).
    'person.updated',
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
    await assertHolder(ctx, response, input.token);
    if (response.status === 'completed')
      throw HfosError.conflict(
        'These answers were already sent, so there’s nothing more to do.',
        'response_sent',
      );
    assertOpen(form, definition);

    // The page's answers and the ones already saved, pruned to what was actually showing.
    const fill = await fillFor(ctx, response, input.askAgain);
    const merged = { ...answersOf(response), ...(input.answers as AnswerSheet) };
    const state = formState(definition, merged, fill);
    const answers = state.answers;
    const problems = responseProblems(definition, answers, fill);
    if (problems.length)
      throw new HfosError(
        'validation',
        400,
        problems.length === 1
          ? 'One answer still needs attention. Fix the one marked and send again.'
          : `${problems.length} answers still need attention. Fix the ones marked and send again.`,
        { problems },
        'form_answers_invalid',
      );

    const { identity } = definition.settings;
    const contact = contactFromAnswers(definition, answers);
    if (identity === 'required' && !response.personId && !hasIdentity(contact))
      throw HfosError.rule(
        'form_needs_identity',
        400,
        'This form needs a phone number or an email address, so the business can reach you. Add one and send again.',
      );

    const { score, calculations, result } = outcome(definition, answers);
    const recorded = recordAnswers(definition, answers, fill);

    // ---- The customer and the lead ----
    const settled = await settleCustomer(ctx, {
      definition,
      form,
      response,
      answers,
      contact,
      calculations,
    });
    const { personId, leadId } = settled;

    if (personId) {
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
          'You’ve already answered this form, and it takes one answer per person. Contact the business if something needs to change.',
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
      await recordSmsConsent(ctx.tx, personId, `Form: ${form.name}`);
    if (personId && input.offersConsent)
      await recordOffersConsent(ctx.tx, personId, `Form: ${form.name}`.slice(0, 80));

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
    if (!response)
      throw HfosError.notFound(
        'That response isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
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

/**
 * A person filling a form in themselves (M17) — on a job, on a phone, quite possibly with no signal.
 *
 * **Its own command rather than actors added to the public pair.** A visitor's path is two round trips: start
 * a sheet, get a key back, send the answers. A phone in a basement has neither. So this makes the sheet and
 * sends it in one go, with an id the phone made, which is what turns a retry into the same answer sheet
 * rather than a second one.
 *
 * **It then hands over to `form_response.submit`**, deliberately, rather than repeating what that does. Every
 * consequence a customer's own submission has — matching or making the customer, filling in what they told
 * us, opening the lead or the task the form asks for, asking its workflows to start — is the form's
 * behaviour, not the public page's, and a form that did half of that when a person filled it in would be a
 * second set of rules to keep in step. `assertHolder` lets a person through without a key, because the key
 * exists to stop one visitor writing to another's sheet.
 */
export const formResponseRecord = defineCommand({
  name: 'form_response.record',
  description:
    'Fill in a form for a customer yourself and send it, in one go. Works with no signal; the phone keeps it until there is some.',
  risk: 2,
  input: FormRecordInput,
  output: FormSubmitOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: formResponseSubmit.emits,
  offline: 'anytime',
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    requireHuman(ctx);
    // Sent twice — the queue retried, or two phones were handed the same job. The first one stands.
    const [earlier] = input.id
      ? await ctx.tx
          .select(READABLE_SHEET)
          .from(formResponses)
          .where(and(eq(formResponses.id, input.id), eq(formResponses.workspaceId, ws)))
      : [];
    if (earlier?.status === 'completed') {
      // The same answer the first send gave, worked out again from what it kept.
      const [version] = await ctx.tx
        .select()
        .from(formVersions)
        .where(eq(formVersions.id, earlier.versionId));
      if (!version)
        throw HfosError.internal(
          'This form changed while it was being filled in. Refresh the page and try again.',
        );
      const definition = parseStoredForm(version.definition);
      const answers = answersOf(earlier);
      const { score, calculations } = outcome(definition, answers);
      return {
        responseId: earlier.id,
        personId: earlier.personId,
        leadId: earlier.leadId,
        resultId: earlier.resultId,
        score: score.graded ? score.points : null,
        scorePercent: score.graded ? score.percent : null,
        passed: earlier.passed,
        calculations,
        dueCents: dueCents(definition, answers, calculations),
        invoiceId: earlier.invoiceId,
      };
    }

    let responseId = earlier?.id ?? null;
    if (!responseId) {
      const { row, definition: draft } = await loadForm(ctx.tx, ws, input.formId);
      if (!row.activeVersionId)
        throw HfosError.notFound(
          `“${row.name}” hasn’t been published yet, so it can’t take answers. Publish it in Forms first.`,
        );
      const [version] = await ctx.tx
        .select()
        .from(formVersions)
        .where(eq(formVersions.id, row.activeVersionId));
      assertOpen(row, version ? parseStoredForm(version.definition) : draft);
      const [made] = await insertWithId('formResponses', input.id, () =>
        ctx.tx
          .insert(formResponses)
          .values({
            ...(input.id ? { id: input.id } : {}),
            workspaceId: ws,
            formId: row.id,
            versionId: row.activeVersionId!,
            status: 'in_progress',
            // The enum has had a value for this since M15; nothing had ever written it.
            source: 'app',
            // No resume key: nobody is coming back to this on a link, and a hash we never check is a
            // secret kept for no reason.
            resumeTokenHash: null,
            resumeExpiresAt: null,
          })
          .returning({ id: formResponses.id }),
      );
      if (!made)
        throw HfosError.internal(
          'The form couldn’t be started just now. Refresh the page and try again.',
        );
      responseId = made.id;
    }
    return formResponseSubmit.handler(ctx, {
      workspaceId: ws,
      responseId,
      answers: input.answers,
      askAgain: false,
      smsConsent: input.smsConsent,
      // The phone's own form has no offers box: a person asks in person, and offers are asked separately.
      offersConsent: false,
    });
  },
});

/** Declared last because `form_response.record` is, and an array cannot name a const it precedes. */
export const formResponseCommands = [
  formResponseStart,
  formResponseSave,
  formResponseSaveContact,
  formLinkCreate,
  formResponseSubmit,
  formResponseRecord,
  formResponseDelete,
] as const;
