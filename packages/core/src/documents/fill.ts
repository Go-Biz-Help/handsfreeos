/**
 * Fill-ins (answer 6a): what HandsFreeOS knows about the customer, their company, the lead, the record, the business
 * and an estimate, written into a document's fields when it's sent. The team sees them on the Send screen and can
 * change any of them before it goes. Server-only.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  companies,
  customRecords,
  estimates,
  leads,
  people,
  users,
  workspaces,
} from '@hfos/db/schema';
import { zonedParts } from '../calendar/engine/zoned';
import { businessPostalAddress } from '../campaigns/postal-address';
import { formatPhone } from '../crm/phone';
import { HfosError } from '../errors';
import { money } from '../money/format';
import {
  SENDER_ROLE,
  valueKindOf,
  type DocumentDefinition,
  type DocumentField,
  type DocumentValue,
  type FillSource,
} from './definition';

/** The one record a document is about. */
export interface DocumentAbout {
  readonly personId?: string | null;
  readonly companyId?: string | null;
  readonly leadId?: string | null;
  readonly customRecordId?: string | null;
}

/** What a document's fill-ins read from. Every part is optional: a company has no customer, say. */
export interface DocumentFillContext {
  readonly customer: {
    readonly id: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly address: string | null;
  } | null;
  readonly company: {
    readonly id: string;
    readonly name: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly website: string | null;
  } | null;
  readonly lead: {
    readonly id: string;
    readonly title: string;
    readonly valueCents: number | null;
  } | null;
  readonly record: { readonly id: string; readonly name: string } | null;
  readonly business: {
    readonly name: string;
    readonly phone: string | null;
    readonly address: string | null;
  };
  readonly estimate: {
    readonly number: string | null;
    readonly title: string | null;
    readonly totalCents: number;
  } | null;
  readonly sender: { readonly name: string } | null;
  /** Today where the business is, YYYY-MM-DD. */
  readonly today: string;
  readonly timeZone: string;
}

/** YYYY-MM-DD in a time zone. */
export function dayIn(timeZone: string, at: Date = new Date()): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const oneLine = (parts: readonly (string | null | undefined)[]) =>
  parts
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ') || null;

/**
 * Reads what a document's fill-ins need, and checks the record it's about is there. The customer is the person it's
 * about, or the lead's; the company is the one it's about, or theirs.
 */
export async function loadFillContext(
  tx: Tx,
  workspaceId: string,
  about: DocumentAbout,
  opts: { estimateId?: string | null; senderUserId?: string | null } = {},
): Promise<DocumentFillContext> {
  const [ws] = await tx
    .select({ name: workspaces.name, timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const timeZone = ws?.timezone || 'America/Chicago';

  let lead: DocumentFillContext['lead'] = null;
  let personId = about.personId ?? null;
  let companyId = about.companyId ?? null;
  if (about.leadId) {
    const [l] = await tx
      .select({
        id: leads.id,
        title: leads.title,
        valueCents: leads.valueCents,
        personId: leads.personId,
        companyId: leads.companyId,
      })
      .from(leads)
      .where(and(eq(leads.id, about.leadId), eq(leads.workspaceId, workspaceId)));
    if (!l) throw aboutGone('lead');
    lead = { id: l.id, title: l.title, valueCents: Number(l.valueCents) };
    personId = l.personId;
    companyId = l.companyId;
  }
  let record: DocumentFillContext['record'] = null;
  if (about.customRecordId) {
    const [r] = await tx
      .select({ id: customRecords.id, name: customRecords.name })
      .from(customRecords)
      .where(
        and(eq(customRecords.id, about.customRecordId), eq(customRecords.workspaceId, workspaceId)),
      );
    if (!r) throw aboutGone('record');
    record = r;
  }
  let customer: DocumentFillContext['customer'] = null;
  if (personId) {
    const [p] = await tx
      .select({
        id: people.id,
        firstName: people.firstName,
        lastName: people.lastName,
        email: people.email,
        phone: people.phoneE164,
        line1: people.addressLine1,
        line2: people.addressLine2,
        city: people.city,
        state: people.state,
        postalCode: people.postalCode,
        companyId: people.companyId,
      })
      .from(people)
      .where(and(eq(people.id, personId), eq(people.workspaceId, workspaceId)));
    if (!p && about.personId) throw aboutGone('person');
    if (p) {
      customer = {
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        phone: p.phone,
        address: oneLine([
          p.line1,
          p.line2,
          p.city,
          oneLine([p.state, p.postalCode])?.replace(', ', ' '),
        ]),
      };
      companyId ??= p.companyId;
    }
  }
  let company: DocumentFillContext['company'] = null;
  if (companyId) {
    const [c] = await tx
      .select({
        id: companies.id,
        name: companies.name,
        email: companies.email,
        phone: companies.phoneE164,
        website: companies.website,
      })
      .from(companies)
      .where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId)));
    if (!c && about.companyId) throw aboutGone('company');
    company = c ?? null;
  }
  let estimate: DocumentFillContext['estimate'] = null;
  if (opts.estimateId) {
    const [e] = await tx
      .select({
        number: estimates.number,
        title: estimates.title,
        totalCents: estimates.totalCents,
      })
      .from(estimates)
      .where(and(eq(estimates.id, opts.estimateId), eq(estimates.workspaceId, workspaceId)));
    if (!e)
      throw HfosError.notFound(
        'That estimate isn’t there anymore, or you can’t see it. Pick another, or send it without one.',
      );
    estimate = { number: e.number, title: e.title, totalCents: Number(e.totalCents) };
  }
  const [phone] = await rows<{ e164: string }>(
    tx,
    sql`select e164 from app.phone_numbers where workspace_id = ${workspaceId} and status = 'active'
        order by created_at limit 1`,
  );
  let sender: DocumentFillContext['sender'] = null;
  if (opts.senderUserId) {
    const [u] = await tx
      .select({ name: users.fullName, email: users.email })
      .from(users)
      .where(eq(users.id, opts.senderUserId));
    if (u) sender = { name: u.name || u.email };
  }
  return {
    customer,
    company,
    lead,
    record,
    business: {
      name: ws?.name ?? '',
      phone: phone?.e164 ?? null,
      address: await businessPostalAddress(tx, workspaceId),
    },
    estimate,
    sender,
    today: dayIn(timeZone),
    timeZone,
  };
}

function aboutGone(kind: 'person' | 'company' | 'lead' | 'record'): HfosError {
  const word = { person: 'customer', company: 'company', lead: 'lead', record: 'record' }[kind];
  return HfosError.notFound(
    `That ${word} isn’t there anymore, or you can’t see them. Refresh and pick who it’s for again.`,
  );
}

/** One fill-in's words, or null when HandsFreeOS doesn't know it. */
export function fillText(source: FillSource, c: DocumentFillContext): string | null {
  const name = (p: { firstName: string; lastName: string }) =>
    [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || null;
  switch (source) {
    case 'customer.name':
      return c.customer ? name(c.customer) : null;
    case 'customer.first_name':
      return c.customer?.firstName || null;
    case 'customer.last_name':
      return c.customer?.lastName || null;
    case 'customer.email':
      return c.customer?.email ?? null;
    case 'customer.phone':
      return c.customer?.phone ? formatPhone(c.customer.phone) : null;
    case 'customer.address':
      return c.customer?.address ?? null;
    case 'company.name':
      return c.company?.name || null;
    case 'company.email':
      return c.company?.email ?? null;
    case 'company.phone':
      return c.company?.phone ? formatPhone(c.company.phone) : null;
    case 'company.website':
      return c.company?.website ?? null;
    case 'lead.title':
      return c.lead?.title || null;
    case 'lead.value':
      return c.lead?.valueCents != null ? money(c.lead.valueCents) : null;
    case 'record.name':
      return c.record?.name || null;
    case 'business.name':
      return c.business.name || null;
    case 'business.phone':
      return c.business.phone ? formatPhone(c.business.phone) : null;
    case 'business.address':
      return c.business.address?.replace(/\n/g, ', ') ?? null;
    case 'estimate.number':
      return c.estimate?.number ?? null;
    case 'estimate.title':
      return c.estimate?.title ?? null;
    case 'estimate.total':
      return c.estimate ? money(c.estimate.totalCents) : null;
    case 'sender.name':
      return c.sender?.name ?? null;
    case 'today':
      return c.today;
  }
}

/** A field's fill-in as the value it takes, or null. */
export function fillValue(field: DocumentField, c: DocumentFillContext): DocumentValue | null {
  if (!field.fillFrom) return null;
  const text = fillText(field.fillFrom, c);
  if (!text) return null;
  switch (valueKindOf(field.type)) {
    case 'text':
      return {
        kind: 'text',
        text:
          field.type === 'long_text'
            ? text
            : text
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .join(', '),
      };
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { kind: 'date', date: text } : null;
    default:
      return null;
  }
}

/**
 * Every fill-in on a document: the business's fields and the signers' starting values. What the team typed on the
 * Send screen (`given`) wins, field by field.
 */
export function presetsFor(
  definition: DocumentDefinition,
  c: DocumentFillContext,
  given: Readonly<Record<string, DocumentValue>> = {},
): Record<string, DocumentValue> {
  const out: Record<string, DocumentValue> = {};
  for (const f of definition.fields) {
    if (f.type === 'date_signed' || f.type === 'signature' || f.type === 'initials') continue;
    const value = given[f.id] ?? fillValue(f, c);
    if (value) out[f.id] = value;
  }
  return out;
}

/** The fields the business fills in (`sender`), with what's preset for them. */
export const senderPresets = (
  definition: DocumentDefinition,
  presets: Readonly<Record<string, DocumentValue>>,
): Record<string, DocumentValue> =>
  Object.fromEntries(
    definition.fields
      .filter((f) => f.role === SENDER_ROLE && presets[f.id])
      .map((f) => [f.id, presets[f.id]!]),
  );
