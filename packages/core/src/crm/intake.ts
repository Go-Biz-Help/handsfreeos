/**
 * Lead intake (M14): where a customer record and a lead come from when nobody typed them in.
 *
 * Two halves live here. The first is the matching every intake shares — phone, then email, then a new
 * customer through person.create's internals, and their open lead or a new one — which the booking page, the
 * waitlist and the channels below all use, so a customer is never made twice by two different doors.
 *
 * The second is the channels: a stranger texts, calls and doesn't get through, or emails, and becomes a
 * customer and an open lead by themselves. Each way in is a row in app.intake_sources; a business that never
 * touched one has no row and takes the defaults. The gates that keep a robocall out of the pipeline are
 * here too, next to the daily cap they belong with.
 */
import { and, eq, isNull, sql as dsql } from 'drizzle-orm';
import { type Tx } from '@hfos/db/client';
import {
  intakeSources,
  intakeSubmissions,
  leads,
  phoneNumbers,
  pipelineStages,
  pipelines,
  userPhones,
  workspaceAccess,
} from '@hfos/db/schema';
import { optOutPhrase } from '../ai-team/guardrails';
import { localDayOf } from '../calendar/when';
import { HfosError } from '../errors';
import type { CommandContext } from '../kernel/types';
import { matchPersonByEmail } from '../messaging/email';
import { isOptedOut, matchPersonByPhone } from '../messaging/store';
import { LeadCreateInput } from '../schemas/lead';
import { PersonCreateInput } from '../schemas/person';
import { leadCreate } from '../commands/lead.create';
import { personCreate } from '../commands/person.create';
import { logSystemActivity } from './activities';
import { formatPhone, normalizePhone } from './phone';
import { fullName } from './records';

export type IntakeKind = (typeof INTAKE_KINDS)[number];
export const INTAKE_KINDS = [
  'text',
  'call',
  'email',
  'website_form',
  'api',
  'messenger',
  'instagram',
] as const;
/**
 * The ways a stranger reaches a business by themselves: the three of slice A, and a message to its Facebook Page or
 * Instagram account (20261025000200).
 */
export const INTAKE_CHANNELS = ['text', 'call', 'email', 'messenger', 'instagram'] as const;
export type IntakeChannel = (typeof INTAKE_CHANNELS)[number];

/** What a channel is called before a business renames it. It is what its customers and leads are filed under. */
export const INTAKE_NAMES: Record<IntakeKind, string> = {
  text: 'Text message',
  call: 'Phone call',
  email: 'Email',
  website_form: 'Website form',
  api: 'Connected app',
  messenger: 'Facebook Messenger',
  instagram: 'Instagram',
};

/** A channel nobody has set up: on, opening a lead in the default pipeline, 50 a day. */
export const INTAKE_DEFAULT_DAILY_CAP = 50;

export interface IntakeSource {
  readonly id: string | null;
  readonly kind: IntakeKind;
  readonly name: string;
  readonly active: boolean;
  readonly createLead: boolean;
  readonly pipelineId: string | null;
  readonly stageId: string | null;
  readonly dailyCap: number;
}

/** Every column a person may read: the secret hash is the worker's alone (the grants in 0082). */
export const READABLE_SOURCE = {
  id: intakeSources.id,
  workspaceId: intakeSources.workspaceId,
  kind: intakeSources.kind,
  name: intakeSources.name,
  active: intakeSources.active,
  createLead: intakeSources.createLead,
  pipelineId: intakeSources.pipelineId,
  stageId: intakeSources.stageId,
  dailyCap: intakeSources.dailyCap,
  dayCount: intakeSources.dayCount,
  dayOn: intakeSources.dayOn,
  lastIntakeAt: intakeSources.lastIntakeAt,
  publicKey: intakeSources.publicKey,
  secretHint: intakeSources.secretHint,
  allowedOrigins: intakeSources.allowedOrigins,
  redirectUrl: intakeSources.redirectUrl,
  lastUsedAt: intakeSources.lastUsedAt,
  archivedAt: intakeSources.archivedAt,
} as const;

type ReadableSource = {
  [K in keyof typeof READABLE_SOURCE]: (typeof intakeSources.$inferSelect)[K];
};

const sourceOf = (row: ReadableSource): IntakeSource => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  active: row.active && !row.archivedAt,
  createLead: row.createLead,
  pipelineId: row.pipelineId,
  stageId: row.stageId,
  dailyCap: row.dailyCap,
});

/** A form or a connected app, by the row its key found. */
export async function intakeSourceById(
  tx: Tx,
  workspaceId: string,
  sourceId: string,
): Promise<IntakeSource | null> {
  const [row] = await tx
    .select(READABLE_SOURCE)
    .from(intakeSources)
    .where(and(eq(intakeSources.id, sourceId), eq(intakeSources.workspaceId, workspaceId)))
    .limit(1);
  return row ? sourceOf(row) : null;
}

/**
 * The business's row for a channel, or for the forms built here, or the defaults it hasn't changed. Forms
 * posted in from somebody else's website have a key and a row each; this is the keyless one they share.
 */
export async function intakeSourceOf(
  tx: Tx,
  workspaceId: string,
  kind: IntakeChannel | 'website_form',
): Promise<IntakeSource> {
  const [row] = await tx
    .select(READABLE_SOURCE)
    .from(intakeSources)
    .where(
      and(
        eq(intakeSources.workspaceId, workspaceId),
        eq(intakeSources.kind, kind),
        ...(kind === 'website_form' ? [isNull(intakeSources.publicKey)] : []),
      ),
    )
    .limit(1);
  return row
    ? sourceOf(row)
    : {
        id: null,
        kind,
        name: INTAKE_NAMES[kind],
        active: true,
        createLead: true,
        pipelineId: null,
        stageId: null,
        dailyCap: INTAKE_DEFAULT_DAILY_CAP,
      };
}

/**
 * Count one intake against the source's day, and say whether it may go ahead. The row is written the first
 * time a channel takes a lead, so a business that never opened Settings still has its counter. The day is
 * the business's own, so a cap means "today" the way they would say it.
 */
export async function takeIntakeSlot(
  tx: Tx,
  workspaceId: string,
  source: IntakeSource,
  zone: string,
  at: Date,
  /** False counts the day without refusing: a form somebody sat down and filled in always opens its lead. */
  enforceCap = true,
): Promise<boolean> {
  const today = localDayOf(at.getTime(), zone);
  if (!source.id) {
    await tx.insert(intakeSources).values({
      workspaceId,
      kind: source.kind,
      name: source.name,
      dailyCap: source.dailyCap,
      dayCount: 1,
      dayOn: today,
      lastIntakeAt: at,
    });
    return true;
  }
  // One statement, so two texts landing together can't both read the same count and both pass.
  const [row] = await tx
    .update(intakeSources)
    .set({
      dayCount: dsql`case when ${intakeSources.dayOn} = ${today}::date then ${intakeSources.dayCount} + 1 else 1 end`,
      dayOn: dsql`${today}::date`,
      lastIntakeAt: at,
    })
    .where(
      and(
        eq(intakeSources.id, source.id),
        ...(enforceCap
          ? [
              dsql`(${intakeSources.dayOn} is distinct from ${today}::date or ${intakeSources.dayCount} < ${source.dailyCap})`,
            ]
          : []),
      ),
    )
    .returning({ dayCount: intakeSources.dayCount });
  return !!row;
}

/** Phone first, then email; otherwise a new customer through person.create's internals. */
export async function findOrCreateCustomer(
  ctx: CommandContext,
  customer: {
    firstName: string;
    lastName: string;
    phone?: string | null;
    email?: string | null;
    address?: {
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      state?: string | null;
      postalCode?: string | null;
    } | null;
  },
  source: string,
): Promise<{ personId: string; created: boolean }> {
  const ws = ctx.scope.workspaceId!;
  if (customer.phone) {
    const id = await matchPersonByPhone(ctx.tx, ws, customer.phone);
    if (id) return { personId: id, created: false };
  }
  if (customer.email) {
    const id = await matchPersonByEmail(ctx.tx, ws, customer.email);
    if (id) return { personId: id, created: false };
  }
  const out = await personCreate.handler(
    ctx,
    PersonCreateInput.parse({
      workspaceId: ws,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      source,
      ignoreDuplicates: true,
      ...(customer.address
        ? {
            address: {
              line1: customer.address.line1 ?? null,
              line2: customer.address.line2 ?? null,
              city: customer.address.city ?? null,
              state: customer.address.state ?? null,
              postalCode: customer.address.postalCode ?? null,
            },
          }
        : {}),
    }),
  );
  return { personId: out.personId, created: true };
}

/**
 * The customer's open lead, or a new one through lead.create's internals. With a target it is that
 * pipeline's open lead and a new lead there; without one (a channel the business hasn't pointed anywhere)
 * it is any open lead, and a new lead lands where lead.create puts it: the default pipeline's first open
 * stage. Stale settings never cost the customer their lead: a pipeline that was archived gives null.
 */
export async function leadFor(
  ctx: CommandContext,
  personId: string,
  target: { pipelineId: string; stageId: string } | null,
  title: string,
  assigneeUserId: string | null,
  source = 'Booking page',
): Promise<string | null> {
  const ws = ctx.scope.workspaceId!;
  const [open] = await ctx.tx
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, ws),
        eq(leads.personId, personId),
        ...(target ? [eq(leads.pipelineId, target.pipelineId)] : []),
        eq(leads.status, 'open'),
        isNull(leads.archivedAt),
      ),
    )
    .limit(1);
  if (open) return open.id;
  if (target) {
    // Stale CRM settings never cost the customer their booking: no pipeline, no lead.
    const [stage] = await ctx.tx
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
      .where(
        and(
          eq(pipelineStages.id, target.stageId),
          eq(pipelines.id, target.pipelineId),
          eq(pipelines.workspaceId, ws),
          isNull(pipelines.archivedAt),
        ),
      );
    if (!stage) return null;
  }
  const out = await leadCreate.handler(
    ctx,
    LeadCreateInput.parse({
      workspaceId: ws,
      title,
      personId,
      ...(target ? { pipelineId: target.pipelineId, stageId: target.stageId } : {}),
      source,
      assigneeUserId,
    }),
  );
  return out.leadId;
}

/** A number the business texts and calls from, or a teammate's own cell: never a lead. */
export async function isOwnNumber(tx: Tx, workspaceId: string, e164: string): Promise<boolean> {
  const [ours] = await tx
    .select({ id: phoneNumbers.id })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.e164, e164)))
    .limit(1);
  if (ours) return true;
  const [cell] = await tx
    .select({ id: userPhones.id })
    .from(userPhones)
    .innerJoin(workspaceAccess, eq(workspaceAccess.userId, userPhones.userId))
    .where(
      and(
        eq(userPhones.e164, e164),
        eq(workspaceAccess.workspaceId, workspaceId),
        dsql`${userPhones.verifiedAt} is not null`,
      ),
    )
    .limit(1);
  return !!cell;
}

/** Senders that are machines: bounces, out-of-office, newsletters, anything that says not to reply. */
const AUTOMATED_LOCAL_PARTS =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounce[sd]?|notifications?|alerts?|news(letter)?|support[-_.]?bot|automated?|system|root|daemon)(\+.*)?$/i;
const AUTOMATED_SUBJECTS =
  /^\s*(re:\s*)?(out of (the )?office|automatic reply|auto(matic)?[- ]?response|undeliverable|delivery (status notification|has failed)|mail delivery (failed|subsystem)|returned mail|read receipt)/i;

export function looksAutomatedEmail(
  from: { address: string; name?: string | null },
  subject?: string | null,
): boolean {
  const local = from.address.split('@')[0] ?? '';
  if (AUTOMATED_LOCAL_PARTS.test(local)) return true;
  return !!subject && AUTOMATED_SUBJECTS.test(subject);
}

/**
 * A first text that is only a carrier keyword (STOP, HELP, START), or that asks in plain words to be left
 * alone, is an instruction rather than a lead. Nobody who says "please stop texting me" becomes one.
 */
export function notALead(keyword: string | null, body: string): boolean {
  if (keyword && body.trim().length <= 12) return true;
  return optOutPhrase(body) !== null;
}

export interface ChannelIntake {
  readonly kind: IntakeChannel;
  /** E.164, for a text or a call. */
  readonly phone?: string | null;
  readonly email?: string | null;
  /** What they call themselves when the channel knows (an email's display name, a Facebook name). */
  readonly name?: string | null;
  /** How the lead reads on the board: "(texted in)", "(missed call)". */
  readonly how: string;
  readonly at: Date;
}

export interface IntakeResult {
  readonly personId: string;
  readonly leadId: string | null;
  readonly source: string;
}

/**
 * A stranger on a channel becomes a customer and (unless the business turned that off) an open lead. Null
 * when the channel is off, the day's cap is used up, or the customer turns out to already be here — the
 * caller then links the conversation the way it always did.
 *
 * The gates that depend on the channel (a STOP text, our own number, a mailer daemon) are the caller's: they
 * are cheaper there and read next to the message they are about.
 */
export async function intakeFromChannel(
  ctx: CommandContext,
  input: ChannelIntake,
  zone: string,
): Promise<IntakeResult | null> {
  const ws = ctx.scope.workspaceId!;
  const source = await intakeSourceOf(ctx.tx, ws, input.kind);
  if (!source.active) return null;
  if (input.phone && (await isOptedOut(ctx.tx, ws, input.phone))) return null;
  if (!(await takeIntakeSlot(ctx.tx, ws, source, zone, input.at))) return null;

  const [firstName, lastName] = intakeName(input);
  const { personId, created } = await findOrCreateCustomer(
    ctx,
    { firstName, lastName, phone: input.phone ?? null, email: input.email ?? null },
    source.name,
  );
  // Someone already here reached us on a new number or address: that is a linked conversation, not a lead.
  if (!created) return { personId, leadId: null, source: source.name };
  const leadId = source.createLead
    ? await leadFor(
        ctx,
        personId,
        source.pipelineId && source.stageId
          ? { pipelineId: source.pipelineId, stageId: source.stageId }
          : null,
        `${fullName(firstName, lastName)} (${input.how})`.slice(0, 160),
        null,
        source.name,
      )
    : null;
  return { personId, leadId, source: source.name };
}

/**
 * What to call someone who hasn't said. Their number or address stands in, which is what the inbox shows
 * anyway, and the AI teammate writes their real name over it the moment they give it.
 */
export function intakeName(input: {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}): [string, string] {
  const said = (input.name ?? '').trim();
  if (said) {
    const parts = said.split(/\s+/);
    const last = parts.length > 1 ? parts.slice(1).join(' ') : '';
    return [parts[0]!.slice(0, 80), last.slice(0, 80)];
  }
  if (input.phone) return [formatPhone(input.phone).slice(0, 80), ''];
  if (input.email) return [(input.email.split('@')[0] ?? input.email).slice(0, 80), ''];
  throw HfosError.internal(
    'This came in without a name, phone number or email, so there’s no one to save it under. Send it again with one of those.',
  );
}

// ---- Forms and connected apps (slice B) ----

/** What a form or a service sends. Everything is optional: senders vary, and a refusal says what was missing. */
export interface IntakePayload {
  readonly name?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  /** What they wrote: it becomes a note on their timeline. */
  readonly message?: string | null;
  /** What to call the lead; otherwise their name and where it came from. */
  readonly title?: string | null;
  readonly valueCents?: number | null;
  readonly address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  } | null;
  /** Everything else that was posted, kept with the submission and written on the timeline. */
  readonly extra?: Readonly<Record<string, string>>;
}

export type IntakeOutcome = 'opened' | 'matched' | 'refused';
/** Why nothing opened. The sender is told which, so a developer can fix their end. */
export type IntakeRefusal = 'turned_off' | 'no_contact' | 'over_limit';

export interface IntakeSubmitResult {
  readonly outcome: IntakeOutcome;
  readonly personId: string | null;
  readonly leadId: string | null;
  readonly submissionId: string;
  readonly duplicate: boolean;
  readonly refusedReason: IntakeRefusal | null;
}

/** The name a form's sender goes under, and their phone in the shape everything else here keeps it in. */
export function intakeContact(payload: IntakePayload): {
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
} {
  const email = payload.email?.trim().toLowerCase() || null;
  const phone = normalizePhone(payload.phone);
  const first = payload.firstName?.trim() || '';
  const last = payload.lastName?.trim() || '';
  if (first || last)
    return { firstName: first.slice(0, 80), lastName: last.slice(0, 80), phone, email };
  // Nothing to reach them by and no name either: the caller refuses it, and there is nobody to name.
  if (!phone && !email && !payload.name?.trim())
    return { firstName: '', lastName: '', phone: null, email: null };
  const [f, l] = intakeName({ name: payload.name ?? null, phone, email });
  return { firstName: f, lastName: l, phone, email };
}

/** What the timeline shows: what they wrote, then whatever else the form asked them. */
function intakeNote(payload: IntakePayload): string | null {
  const lines: string[] = [];
  if (payload.message?.trim()) lines.push(payload.message.trim());
  for (const [key, value] of Object.entries(payload.extra ?? {})) {
    const said = String(value ?? '').trim();
    if (said) lines.push(`${key}: ${said}`);
  }
  return lines.length ? lines.join('\n').slice(0, 10_000) : null;
}

/**
 * A form on a business's own website, or a service sending one over, becomes a customer and a lead. The
 * worker has already checked the key, the site it was posted from and the rate limits; what is left is the
 * business's own rules, which are the same ones a text goes through.
 *
 * A sender that retries finds the submission it already made, with the same answer: an outage on their side
 * never opens the same lead twice. A customer already here keeps their record and still gets a lead, because
 * somebody filling in a quote form is asking for something whether or not they have bought before.
 */
export async function submitIntake(
  ctx: CommandContext,
  input: {
    source: IntakeSource;
    payload: IntakePayload;
    dedupeKey: string;
    at: Date;
    zone: string;
  },
): Promise<IntakeSubmitResult> {
  const ws = ctx.scope.workspaceId!;
  const { source, payload, at } = input;
  if (!source.id) throw HfosError.internal();

  const [earlier] = await ctx.tx
    .select()
    .from(intakeSubmissions)
    .where(
      and(
        eq(intakeSubmissions.sourceId, source.id),
        eq(intakeSubmissions.dedupeKey, input.dedupeKey),
      ),
    )
    .limit(1);
  if (earlier)
    return {
      outcome: earlier.outcome as IntakeOutcome,
      personId: earlier.personId,
      leadId: earlier.leadId,
      submissionId: earlier.id,
      duplicate: true,
      refusedReason: (earlier.refusedReason as IntakeRefusal | null) ?? null,
    };

  const contact = intakeContact(payload);
  const record = async (
    outcome: IntakeOutcome,
    personId: string | null,
    leadId: string | null,
    refusedReason: IntakeRefusal | null,
  ): Promise<IntakeSubmitResult> => {
    const [row] = await ctx.tx
      .insert(intakeSubmissions)
      .values({
        workspaceId: ws,
        sourceId: source.id!,
        dedupeKey: input.dedupeKey,
        personId,
        leadId,
        outcome,
        refusedReason,
        payload: { ...(payload.extra ?? {}), ...stripped(payload) },
        receivedAt: at,
      })
      .returning({ id: intakeSubmissions.id });
    return {
      outcome,
      personId,
      leadId,
      submissionId: row!.id,
      duplicate: false,
      refusedReason,
    };
  };

  if (!source.active) return record('refused', null, null, 'turned_off');
  // A lead nobody can answer is not a lead: every sender must give a phone number or an email address.
  if (!contact.phone && !contact.email) return record('refused', null, null, 'no_contact');
  if (!(await takeIntakeSlot(ctx.tx, ws, source, input.zone, at)))
    return record('refused', null, null, 'over_limit');

  const { personId, created } = await findOrCreateCustomer(
    ctx,
    {
      firstName: contact.firstName,
      lastName: contact.lastName,
      phone: contact.phone,
      email: contact.email,
      address: payload.address ?? null,
    },
    source.name,
  );
  const who = fullName(contact.firstName, contact.lastName);
  const leadId = source.createLead
    ? await leadFor(
        ctx,
        personId,
        source.pipelineId && source.stageId
          ? { pipelineId: source.pipelineId, stageId: source.stageId }
          : null,
        (payload.title?.trim() || `${who} (${source.name})`).slice(0, 160),
        null,
        source.name,
      )
    : null;
  const note = intakeNote(payload);
  if (note)
    await logSystemActivity(ctx, {
      subtype: 'intake',
      personId,
      leadId,
      body: note,
      occurredAt: at,
      meta: { source: source.name, sourceKind: source.kind },
    });
  if (leadId && payload.valueCents && payload.valueCents > 0)
    await ctx.tx
      .update(leads)
      .set({ valueCents: payload.valueCents })
      .where(and(eq(leads.id, leadId), eq(leads.valueCents, 0)));
  await ctx.tx.update(intakeSources).set({ lastUsedAt: at }).where(eq(intakeSources.id, source.id));
  return record(created ? 'opened' : 'matched', personId, leadId, null);
}

/** The named fields, kept with the submission so a business sees what the sender actually sent. */
function stripped(payload: IntakePayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'name',
    'firstName',
    'lastName',
    'email',
    'phone',
    'message',
    'title',
  ] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 1000);
  }
  return out;
}
