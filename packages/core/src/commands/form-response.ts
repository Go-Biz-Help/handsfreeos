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
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  customFields,
  files,
  formLinks,
  formResponses,
  forms,
  formVersions,
  people,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { bookingLabel, bookingPicked, type BookingAnswer } from '../forms/booking';
import {
  allQuestions,
  findQuestion,
  type FormDefinition,
  type FormResult,
  type Question,
} from '../forms/definition';
import type { AnswerFile } from '../forms/questions';
import {
  FORM_UPLOADS_PER_SHEET,
  formUploadFolder,
  isAnswerFiles,
  uploadMaxFiles,
  uploadRefusal,
} from '../forms/uploads';
import { loadForm, parseStoredForm } from '../forms/load';
import { runCalculations, scoreAnswers, type AnswerSheet } from '../forms/logic';
import { choiceValues } from '../forms/definition';
import { FORM_LINK_DAYS, knownTargetsOf, type FillContext } from '../forms/personal';
import {
  formState,
  isUnansweredProblem,
  pageProblems,
  pickResult,
  recordAnswers,
  responseProblems,
} from '../forms/render';
import {
  contactFromAnswers,
  hasIdentity,
  patchesFromAnswers,
  PERSON_LIMITS,
  fit,
  type FormContact,
  writeCustomFields,
  writeFormAnswers,
} from '../forms/submit';
import { insertWithId } from '../crm/client-ids';
import { isStandInName, safeFileName } from '../crm/records';
import { otherPhonesOf } from '../crm/contact-points';
import { normalizePhone } from '../crm/phone';
import { findOrCreateCustomer, intakeSourceOf, takeIntakeSlot } from '../crm/intake';
import { recordSmsConsent } from '../crm/signup';
import { loadCalendar, workspaceZone, type LoadedCalendar } from '../calendar/load';
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
  FormMarkStoppedInput,
  FormMarkStoppedOutput,
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
  FormUploadBeginInput,
  FormUploadBeginOutput,
  FormUploadConfirmInput,
  FormUploadConfirmOutput,
} from '../schemas/form';
import { AppointmentBookOnlineInput } from '../schemas/calendar';
import { appointmentBookOnline } from './appointment-online';
import { invoiceCreate } from './invoice';
import { leadCreate } from './lead.create';
import { personUpdate } from './person.update';
import { taskCreate } from './task';
import { recordCallConsent } from '../messaging/call-consent';
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
  linkRef: formResponses.linkRef,
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

/**
 * Whether a form is taking answers at all: live, not archived, not past its own closing rules. A live poll never is
 * here: its questions pop up in a video call, and its answers come from there (`video_call.poll_answer`).
 */
function assertOpen(form: typeof forms.$inferSelect, definition: FormDefinition): void {
  if (definition.mode === 'poll')
    throw HfosError.rule(
      'form_is_poll',
      409,
      'This is a live poll. Its questions pop up during a HandsFreeOS video call, so it can’t be filled in here.',
    );
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
      // The sheet keeps the first `ref` it was opened with.
      if (open && input.linkRef)
        await ctx.tx
          .update(formResponses)
          .set({ linkRef: dsql`coalesce(${formResponses.linkRef}, ${input.linkRef})` })
          .where(eq(formResponses.id, open.id));
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
        linkRef: input.linkRef ?? null,
        lastActiveAt: new Date(),
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
      .set({
        answers: state.answers as never,
        lastActiveAt: new Date(),
        ...(input.pageId ? { atPageId: input.pageId } : {}),
      })
      .where(eq(formResponses.id, response.id));
    return {
      responseId: response.id,
      progress: state.progress,
      calculations: state.calculations,
      problems: responseProblems(definition, state.answers, fill).filter(
        (p) => !isUnansweredProblem(p),
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
  // A customer's source holds 80 characters and a form's name 200: a long name is cut, not refused.
  const source = fit(definition.onSubmit.person.source || form.name, PERSON_LIMITS.source);
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
  const { person, lead } = patchesFromAnswers(definition, answers);
  const asNumber = (value: unknown) => (typeof value === 'string' ? normalizePhone(value) : null);
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
          // What else the answers say goes on a customer this makes, the way it fills blanks on one it finds.
          phoneAlt: asNumber(person.fields.phoneAlt),
          notes: typeof person.fields.notes === 'string' ? person.fields.notes : null,
        },
        typeof person.fields.source === 'string' ? person.fields.source : source,
      );
  personId = found.personId;
  // Only what the business doesn't already know: a form never rubs out what somebody typed.
  if (!found.created && Object.keys(person.fields).length) {
    const [existing] = await ctx.tx.select().from(people).where(eq(people.id, personId));
    const onFile = [
      existing?.phoneE164,
      ...otherPhonesOf(existing?.otherPhones).map((p) => p.phone),
    ];
    const blank = (value: unknown) => value === null || value === undefined || value === '';
    // Saved under their number or email before they said their name: the name on the form replaces that stand-in.
    const standIn = !!existing && isStandInName(existing);
    const fill: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(person.fields)) {
      if (standIn && (key === 'firstName' || key === 'lastName') && !blank(value)) {
        fill[key] = value;
        continue;
      }
      const e164 = asNumber(value);
      if (key === 'phoneAlt') {
        // Another number joins the others (0103) when it reads as one and isn't on file already: a form
        // never relabels a number the business has, and a stray answer never sinks the submission.
        if (e164 && !onFile.includes(e164)) fill[key] = value;
        continue;
      }
      if (key === 'address') {
        // Each part of the address on its own: a town fills a blank town, and a street on file stays put.
        const answer = value as Record<string, string>;
        const columns = {
          line1: existing?.addressLine1,
          line2: existing?.addressLine2,
          city: existing?.city,
          state: existing?.state,
          postalCode: existing?.postalCode,
        } as Record<string, unknown>;
        const parts = Object.fromEntries(
          Object.entries(columns)
            .filter(([part, onRecord]) => blank(onRecord) && !blank(answer[part]))
            .map(([part]) => [part, answer[part]]),
        );
        if (Object.keys(parts).length) fill.address = parts;
        continue;
      }
      // Words that aren't a number never go in as their phone.
      if (key === 'phone' && !e164) continue;
      const already = (existing as unknown as Record<string, unknown>)[key];
      if (blank(already)) {
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
    // A lead is worth nothing to a billion dollars: a calculation that comes out below zero (or no number at
    // all) is worth nothing, rather than a lead that can't be opened.
    const valueCents = Math.min(
      Math.max(Math.round((quoted ?? typedValue ?? 0) * 100) || 0, 0),
      100_000_000_000,
    );
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
      .set({ answers: answers as never, personId, leadId, lastActiveAt: new Date() })
      .where(eq(formResponses.id, response.id));
    if (personId && input.smsConsent)
      await recordSmsConsent(ctx.tx, personId, `Form: ${form.name}`);
    if (personId && input.offersConsent)
      await recordOffersConsent(ctx.tx, personId, `Form: ${form.name}`.slice(0, 80));
    if (personId && input.callConsent)
      await recordCallConsent(ctx.tx, ctx.scope.workspaceId!, personId, `Form: ${form.name}`);
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

/** How long a sheet waits, quiet, before its page counts as where they stopped. */
export const FORM_STOPPED_MINUTES = 30;

export const formResponseMarkStopped = defineCommand({
  name: 'form_response.mark_stopped',
  description:
    'The worker’s sweep (funnels): somebody we know went quiet on a page of a form they started. Marks that page stopped, once, and tells the workflows that start on it.',
  risk: 1,
  input: FormMarkStoppedInput,
  output: FormMarkStoppedOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['form.stopped'],
  actors: ['system'],
  async handler(ctx, input) {
    const [sheet] = await ctx.tx
      .select({
        id: formResponses.id,
        formId: formResponses.formId,
        versionId: formResponses.versionId,
        status: formResponses.status,
        personId: formResponses.personId,
        leadId: formResponses.leadId,
        answers: formResponses.answers,
        atPageId: formResponses.atPageId,
        stoppedPages: formResponses.stoppedPages,
        lastActiveAt: formResponses.lastActiveAt,
      })
      .from(formResponses)
      .where(
        and(
          eq(formResponses.id, input.responseId),
          eq(formResponses.workspaceId, ctx.scope.workspaceId!),
        ),
      )
      .for('update');
    // Checked again here, holding the row: they may have carried on, or sent it, since the sweep looked.
    const quietSince = Date.now() - FORM_STOPPED_MINUTES * 60_000;
    if (
      !sheet ||
      sheet.status !== 'in_progress' ||
      !sheet.personId ||
      sheet.atPageId !== input.pageId ||
      sheet.stoppedPages.includes(input.pageId) ||
      !sheet.lastActiveAt ||
      sheet.lastActiveAt.getTime() > quietSince
    )
      return { stopped: false };
    await ctx.tx
      .update(formResponses)
      .set({ stoppedPages: [...sheet.stoppedPages, input.pageId] })
      .where(eq(formResponses.id, sheet.id));
    const [version] = await ctx.tx
      .select({ definition: formVersions.definition })
      .from(formVersions)
      .where(eq(formVersions.id, sheet.versionId));
    const definition = version ? parseStoredForm(version.definition) : null;
    const page = definition?.pages.find((p) => p.id === input.pageId) ?? null;
    const answers = (sheet.answers ?? {}) as Record<string, unknown>;
    // How much of each video they'd watched, so a follow-up can say "you were halfway through the overview".
    const watched = Object.fromEntries(
      (definition ? allQuestions(definition) : [])
        .filter((q) => q.type === 'video' && typeof answers[q.id] === 'number')
        .map((q) => [q.id, answers[q.id] as number]),
    );
    await ctx.emit({
      type: 'form.stopped',
      entityType: 'form',
      entityId: sheet.formId,
      payload: {
        responseId: sheet.id,
        formId: sheet.formId,
        personId: sheet.personId,
        leadId: sheet.leadId,
        pageId: input.pageId,
        pageTitle: page?.title ?? '',
        watched,
      },
      after: { page: page?.title || 'a page' },
    });
    return { stopped: true };
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

/** The calendar a "Book a time" question books on, as it stands now: there, taking bookings, and free to book. */
async function bookableCalendar(ctx: CommandContext, question: Question): Promise<LoadedCalendar> {
  const ws = ctx.scope.workspaceId!;
  const { calendarId } = question.config as { calendarId: string };
  const unavailable = () =>
    HfosError.rule(
      'form_booking_unavailable',
      409,
      'Times can’t be booked on this form just now. Send it without one, or contact the business to book.',
    );
  if (!calendarId) throw unavailable();
  const calendar = await loadCalendar(ctx.tx, ws, calendarId).catch(() => null);
  if (!calendar || calendar.status !== 'active' || calendar.config.payments.mode !== 'none')
    throw unavailable();
  return calendar;
}

/**
 * Books the time they picked, with the calendar's own online booking: its confirmation, video link and reminders
 * are the calendar's, and a retried send books once (the sheet is the booking's key). A session that filled up
 * since they picked it refuses the whole send, naming the time, so they can pick another.
 */
async function bookTheTime(
  ctx: CommandContext,
  args: {
    readonly calendar: LoadedCalendar;
    readonly question: Question;
    readonly answer: BookingAnswer;
    readonly personId: string | null;
    readonly leadId: string | null;
    readonly responseId: string;
    readonly smsConsent: boolean;
    /** The `ref` the sheet was opened with: the booking keeps it, as a booking page's does. */
    readonly linkRef: string | null;
  },
): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  const needsContact = () =>
    HfosError.rule(
      'form_booking_needs_contact',
      400,
      'Add a phone number or an email address, so we can send you the booking.',
    );
  if (!args.personId) throw needsContact();
  const [person] = await ctx.tx
    .select({
      firstName: people.firstName,
      lastName: people.lastName,
      phone: people.phoneE164,
      email: people.email,
    })
    .from(people)
    .where(eq(people.id, args.personId));
  if (!person || (!person.phone && !person.email)) throw needsContact();
  const { serviceId } = args.question.config as { serviceId: string | null };
  try {
    await appointmentBookOnline.handler(
      ctx,
      AppointmentBookOnlineInput.parse({
        workspaceId: ws,
        calendarId: args.calendar.id,
        startsAt: args.answer.startsAt,
        sessionId: args.answer.sessionId,
        serviceId,
        partySize: 1,
        customer: {
          firstName: person.firstName || 'Customer',
          lastName: person.lastName ?? '',
          phone: person.phone,
          email: person.email,
        },
        smsConsent: args.smsConsent,
        linkRef: args.linkRef,
        clientId: `form:${args.responseId}`,
        leadId: args.leadId,
        throughForm: true,
        hold: false,
      }),
    );
  } catch (e) {
    if (e instanceof HfosError && (e.rule === 'slot_taken' || e.rule === 'session_full'))
      throw new HfosError(
        'conflict',
        409,
        `${args.answer.label} just filled up. Pick another time.`,
        { questionId: args.question.id },
        'form_booking_taken',
      );
    throw e;
  }
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
    // Filling in a blank on a customer we already had (personUpdate).
    'person.updated',
    // A "Book a time" question books its time with the calendar's own appointment.book_online (funnels).
    'appointment.booked',
    'lead.created',
    'task.created',
    'invoice.created',
    'workflow.enrol_requested',
    // The files they added, copied onto the customer; and any they added then took back, removed.
    'file.received',
    'file.deleted',
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
    let answers = state.answers;
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

    // Files they added: each must be one this sheet uploaded to that question, and the answer keeps Storage's size.
    const sent = await sentFiles(ctx, {
      formId: form.id,
      responseId: response.id,
      definition,
      answers,
    });
    answers = sent.answers;

    // A time to book (funnels): the calendar it's on, and the time in the calendar's own words, whatever the page
    // sent for them.
    const picked = bookingPicked(definition, answers);
    const bookOn = picked ? await bookableCalendar(ctx, picked.question) : null;
    if (picked && bookOn)
      answers = {
        ...answers,
        [picked.question.id]: {
          ...picked.answer,
          label: bookingLabel(picked.answer.startsAt, bookOn.timeZone),
        } as never,
      };

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

    // ---- The time they picked ----
    if (picked && bookOn)
      await bookTheTime(ctx, {
        calendar: bookOn,
        question: picked.question,
        answer: answers[picked.question.id] as unknown as BookingAnswer,
        personId,
        leadId,
        responseId: response.id,
        smsConsent: input.smsConsent,
        linkRef: response.linkRef,
      });

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
    // ---- The files they sent ----
    // Copied onto the customer, where their Files and timeline show them; any they took back are removed.
    await placeSentFiles(ctx, {
      formId: form.id,
      formName: form.name,
      responseId: response.id,
      kept: sent.files,
      personId,
      leadId,
    });

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
    if (personId && input.callConsent)
      await recordCallConsent(ctx.tx, ctx.scope.workspaceId!, personId, `Form: ${form.name}`);

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
  emits: ['form.response_deleted', 'file.deleted'],
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
    // The sheet's own copies of the files it sent go with it (taking a file off needs files.delete, which everyone
    // who looks after forms has unless a custom role says otherwise; then they stay, unseen). The customer's copies
    // are theirs, and stay.
    const [mayDeleteFiles] = await rows<{ ok: boolean }>(
      ctx.tx,
      sql`select private.has_permission(${ws}::uuid, 'files.delete') as ok`,
    );
    if (mayDeleteFiles?.ok)
      await removeSheetFiles(ctx, formUploadFolder(ws, response.formId, response.id), []);
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
      callConsent: input.callConsent,
    });
  },
});

/** Declared last because `form_response.record` is, and an array cannot name a const it precedes. */
// ---- Files on a public form (product sellers, 5a) ----

interface SheetFile extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly size_bytes: number | string | null;
  readonly mime_type: string | null;
  readonly status: 'pending' | 'ready';
  readonly bucket: string;
  readonly object_path: string;
  readonly record_id: string;
}

/** The files a sheet has uploaded, on the form still, in its own folder. */
async function sheetFiles(ctx: CommandContext, folder: string): Promise<SheetFile[]> {
  return rows<SheetFile>(
    ctx.tx,
    sql`select id, name, size_bytes, mime_type, status, bucket, object_path, record_id
        from app.files
        where workspace_id = ${ctx.scope.workspaceId} and record_type = 'form'
          and deleted_at is null and starts_with(object_path, ${folder})`,
  );
}

/** Takes a sheet's files off, all but those kept, and has the worker remove what was stored (file.deleted). */
async function removeSheetFiles(
  ctx: CommandContext,
  folder: string,
  keep: readonly string[],
): Promise<void> {
  for (const file of await sheetFiles(ctx, folder)) {
    if (keep.includes(file.id)) continue;
    await ctx.tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, file.id));
    await ctx.emit({
      type: 'file.deleted',
      entityType: 'form',
      entityId: file.record_id,
      payload: {
        fileId: file.id,
        name: file.name,
        bucket: file.bucket,
        objectPath: file.object_path,
      },
      before: { name: file.name },
      after: null,
    });
  }
}

/**
 * The files a sheet is sending, checked against what it uploaded: each one on its own question's folder, and
 * finished. The answer then keeps the stored name and size, whatever the page said.
 */
async function sentFiles(
  ctx: CommandContext,
  input: {
    readonly formId: string;
    readonly responseId: string;
    readonly definition: FormDefinition;
    readonly answers: AnswerSheet;
  },
): Promise<{ answers: AnswerSheet; files: readonly SheetFile[] }> {
  const asked = allQuestions(input.definition).filter(
    (q) => q.type === 'file' && isAnswerFiles(input.answers[q.id]),
  );
  if (!asked.length) return { answers: input.answers, files: [] };
  const folder = formUploadFolder(ctx.scope.workspaceId!, input.formId, input.responseId);
  const uploaded = await sheetFiles(ctx, folder);
  const problems: { questionId: string; message: string }[] = [];
  const kept: SheetFile[] = [];
  const answers: Record<string, unknown> = { ...input.answers };
  for (const question of asked) {
    const given = input.answers[question.id] as unknown as readonly AnswerFile[];
    const checked: AnswerFile[] = [];
    for (const file of given) {
      const row = uploaded.find(
        (f) => f.id === file.fileId && f.object_path.startsWith(`${folder}${question.id}/`),
      );
      if (!row || row.status !== 'ready') {
        problems.push({
          questionId: question.id,
          message: `${file.name} didn’t finish uploading. Remove it and add it again.`,
        });
        continue;
      }
      if (kept.some((k) => k.id === row.id)) continue;
      kept.push(row);
      checked.push({ fileId: row.id, name: row.name, bytes: Number(row.size_bytes ?? 0) });
    }
    answers[question.id] = checked;
  }
  if (problems.length) throw answersInvalid(problems);
  return { answers: answers as AnswerSheet, files: kept };
}

/**
 * On sending: each file is copied onto the customer, where their Files tab and timeline show it (the worker copies it
 * on `file.received`, as it does a file a customer texts in, and `file.finish_copy` marks it ready). The answer sheet
 * keeps its own copy on the form, so deleting one never takes the other, and with nobody to put them on that copy is
 * all there is. Files the sheet uploaded and didn't send (taken back, or on a question that ended up hidden) are
 * removed.
 */
async function placeSentFiles(
  ctx: CommandContext,
  input: {
    readonly formId: string;
    readonly formName: string;
    readonly responseId: string;
    readonly kept: readonly SheetFile[];
    readonly personId: string | null;
    readonly leadId: string | null;
  },
): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  await removeSheetFiles(
    ctx,
    formUploadFolder(ws, input.formId, input.responseId),
    input.kept.map((f) => f.id),
  );
  if (!input.personId || !input.kept.length) return;
  const copies: {
    fileId: string;
    name: string;
    from: { bucket: string; objectPath: string };
    contentType: string;
    sizeBytes: number;
  }[] = [];
  for (const file of input.kept) {
    const fileId = randomUUID();
    const contentType = file.mime_type ?? 'application/octet-stream';
    const sizeBytes = Number(file.size_bytes ?? 0);
    await ctx.tx.insert(files).values({
      id: fileId,
      workspaceId: ws,
      recordType: 'person',
      recordId: input.personId,
      bucket: 'attachments',
      objectPath: `${ws}/person/${input.personId}/${fileId}/${safeFileName(file.name)}`,
      name: file.name,
      mimeType: contentType,
      sizeBytes,
    });
    copies.push({
      fileId,
      name: file.name,
      from: { bucket: file.bucket, objectPath: file.object_path },
      contentType,
      sizeBytes,
    });
  }
  await ctx.emit({
    type: 'file.received',
    entityType: 'person',
    entityId: input.personId,
    payload: {
      leadId: input.leadId,
      personId: input.personId,
      conversationId: null,
      formId: input.formId,
      responseId: input.responseId,
      question: input.formName,
      // The form's own alerts say it was sent; nobody is told about the files on their own.
      notify: null,
      via: 'form',
      files: copies,
    },
    broadcast: false,
    after: { form: input.formName, files: copies.map((f) => f.name) },
  });
}

/** The file question a sheet is adding to, on the version it's answering. */
function fileQuestionOf(definition: FormDefinition, questionId: string): Question {
  const found = findQuestion(definition, questionId)?.question;
  if (!found || found.type !== 'file')
    throw HfosError.notFound(
      'That question isn’t on this form anymore. Refresh the page and try again.',
    );
  return found;
}

export const formResponseUploadBegin = defineCommand({
  name: 'form_response.upload_begin',
  description:
    'Someone filling in a form starts adding a file to one of its file questions: its place is kept on their answer sheet, and the worker gives their browser a one-time link to upload it.',
  risk: 1,
  input: FormUploadBeginInput,
  output: FormUploadBeginOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const { response, definition, form } = await openResponse(ctx, input.responseId, {
      forUpdate: true,
    });
    await assertHolder(ctx, response, input.token);
    if (response.status === 'completed')
      throw HfosError.conflict(
        'These answers were already sent, so files can’t be added to them now.',
        'response_sent',
      );
    assertOpen(form, definition);
    const question = fileQuestionOf(definition, input.questionId);
    const refusal = uploadRefusal(question, input);
    if (refusal) throw HfosError.rule(refusal.rule, 422, refusal.message);

    const folder = formUploadFolder(ws, form.id, response.id);
    const [count] = await rows<{ all: number; here: number }>(
      ctx.tx,
      sql`select count(*)::int as all,
            (count(*) filter (where starts_with(object_path, ${`${folder}${question.id}/`})
              and deleted_at is null))::int as here
          from app.files
          where workspace_id = ${ws} and record_type = 'form' and starts_with(object_path, ${folder})`,
    );
    const most = uploadMaxFiles(question);
    if ((count?.here ?? 0) >= most)
      throw HfosError.rule(
        'form_too_many_files',
        409,
        most === 1
          ? 'This question takes one file. Remove the one you added to add another.'
          : `This question takes up to ${most} files. Remove one to add another.`,
      );
    if ((count?.all ?? 0) >= FORM_UPLOADS_PER_SHEET)
      throw HfosError.rule(
        'too_many_uploads',
        429,
        'That’s as many files as one form can take. Send it with the ones you have, and the business can ask for the rest.',
      );

    const fileId = randomUUID();
    const objectPath = `${folder}${question.id}/${fileId}/${safeFileName(input.name)}`;
    await ctx.tx.insert(files).values({
      id: fileId,
      workspaceId: ws,
      recordType: 'form',
      recordId: form.id,
      bucket: 'attachments',
      objectPath,
      name: input.name,
      mimeType: input.mimeType.toLowerCase(),
      sizeBytes: input.sizeBytes,
    });
    return { fileId, bucket: 'attachments', objectPath };
  },
});

export const formResponseUploadConfirm = defineCommand({
  name: 'form_response.upload_confirm',
  description:
    'Someone filling in a form finishes adding a file: what arrived is checked against what the question takes, and kept on their answer sheet until they send it.',
  risk: 1,
  input: FormUploadConfirmInput,
  output: FormUploadConfirmOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['file.deleted'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const { response, definition, form } = await openResponse(ctx, input.responseId);
    await assertHolder(ctx, response, input.token);
    const folder = formUploadFolder(ws, form.id, response.id);
    const file = (await sheetFiles(ctx, folder)).find((f) => f.id === input.fileId);
    if (!file) throw HfosError.notFound('That file isn’t there anymore. Add it again.');
    const questionId = file.object_path.slice(folder.length).split('/')[0] ?? '';
    const question = fileQuestionOf(definition, questionId);
    const done = (sizeBytes: number, mimeType: string) => ({
      fileId: file.id,
      name: file.name,
      bytes: sizeBytes,
      mimeType: mimeType || 'application/octet-stream',
    });
    if (file.status === 'ready')
      return {
        ...done(Number(file.size_bytes ?? 0), file.mime_type ?? ''),
        accepted: true,
        refusal: null,
      };
    const [info] = await rows<{ size_bytes: number | null; mime_type: string | null }>(
      ctx.tx,
      sql`select size_bytes, mime_type from private.storage_object_info(${file.bucket}, ${file.object_path})`,
    );
    if (!info)
      throw HfosError.rule(
        'file_not_uploaded',
        409,
        `${file.name} didn’t finish uploading. Check your connection and add it again.`,
      );
    const sizeBytes = Number(info.size_bytes ?? 0);
    const mimeType = (info.mime_type ?? '').toLowerCase();
    // What arrived is what counts: the browser said what it was sending, Storage says what came.
    const refusal = uploadRefusal(question, { name: file.name, mimeType, sizeBytes });
    if (refusal) {
      await removeSheetFiles(ctx, `${folder}${questionId}/${file.id}/`, []);
      return { ...done(sizeBytes, mimeType), accepted: false, refusal };
    }
    await ctx.tx
      .update(files)
      .set({ status: 'ready', sizeBytes, mimeType })
      .where(eq(files.id, file.id));
    return { ...done(sizeBytes, mimeType), accepted: true, refusal: null };
  },
});

export const formResponseCommands = [
  formResponseStart,
  formResponseSave,
  formResponseSaveContact,
  formResponseMarkStopped,
  formLinkCreate,
  formResponseSubmit,
  formResponseRecord,
  formResponseDelete,
  formResponseUploadBegin,
  formResponseUploadConfirm,
] as const;
