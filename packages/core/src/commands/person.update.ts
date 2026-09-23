import { and, eq, isNull } from 'drizzle-orm';
import { leads, people } from '@hfos/db/schema';
import { assertAiReach, refuseInChat } from '../ai-team/reach';
import {
  otherAddressesOf,
  otherEmailsOf,
  otherPhonesOf,
  tidyOtherAddresses,
  tidyOtherEmails,
  tidyOtherPhones,
} from '../crm/contact-points';
import { formatPhone } from '../crm/phone';
import { fullName, requireCompany } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import {
  logNotApplied,
  mergeColumns,
  mergeFields,
  stampSql,
  type MergeField,
} from '../kernel/field-merge';
import { changeMoment } from '../kernel/moment';
import { PersonUpdateInput, PersonUpdateOutput } from '../schemas/person';

export const personUpdate = defineCommand({
  name: 'person.update',
  description:
    'Change a person’s details: only the ones edited, each with what the editor saw, and the newest change to each wins. Changing the company also moves their open leads to it.',
  risk: 1,
  input: PersonUpdateInput,
  output: PersonUpdateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['person.updated'],
  actors: ['human', 'system', 'workflow', 'ai_employee'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(people)
      .where(and(eq(people.id, input.personId), eq(people.workspaceId, workspaceId)))
      .for('update');
    if (!current) throw HfosError.notFound('Person not found.');
    // The AI teammate fills in its own customer's blank names and contact details; what's on file stays.
    const blankOnly = ctx.actor.type === 'ai_employee';
    if (blankOnly) {
      const other = (
        [
          'phoneAlt',
          'otherEmails',
          'otherPhones',
          'otherAddresses',
          'companyId',
          'notes',
          'source',
          'ownerUserId',
        ] as const
      ).filter((k) => input[k] !== undefined);
      if (other.length)
        throw HfosError.validation(
          other.map((path) => ({
            path,
            message: 'The AI teammate only fills in names and contact details.',
          })),
        );
      await assertAiReach(ctx, { personId: current.id });
      // Anyone can type someone else's number into a website chat, so a chat never changes the customer.
      await refuseInChat(ctx);
    }
    if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
    const isBlank = (v: unknown) => v === null || v === undefined || v === '';
    const edit = <T>(column: keyof typeof current, value: T): T | undefined =>
      !blankOnly || isBlank(current[column]) ? value : undefined;
    const seen: NonNullable<typeof input.base> = input.base ?? {};
    const address: NonNullable<typeof input.address> = input.address ?? {};
    const seenAddress: NonNullable<typeof seen.address> = seen.address ?? {};
    // The main ones as they will stand, which the other lists never repeat.
    const then = <T>(value: T | undefined, now: T): T => (value === undefined ? now : value);
    const main = {
      email: then(input.email, current.email),
      phone: then(input.phone, current.phoneE164),
      address: {
        line1: then(address.line1, current.addressLine1),
        line2: then(address.line2, current.addressLine2),
        city: then(address.city, current.city),
        state: then(address.state, current.state),
        postalCode: then(address.postalCode, current.postalCode),
      },
    };
    // An older phone's "other phone" joins the other numbers, first, unless the whole list came with it.
    const wantedPhones =
      input.otherPhones ??
      (input.phoneAlt
        ? [{ phone: input.phoneAlt, label: 'Other' }, ...otherPhonesOf(current.otherPhones)]
        : undefined);
    const fields: MergeField[] = [
      {
        key: 'firstName',
        column: 'firstName',
        value: edit('firstName', input.firstName),
        base: seen.firstName,
        kind: 'text',
        label: 'first name',
      },
      {
        key: 'lastName',
        column: 'lastName',
        value: edit('lastName', input.lastName),
        base: seen.lastName,
        kind: 'text',
        label: 'last name',
      },
      {
        key: 'email',
        column: 'email',
        value: edit('email', input.email),
        base: seen.email,
        kind: 'email',
        label: 'email',
      },
      {
        key: 'phone',
        column: 'phoneE164',
        value: edit('phoneE164', input.phone),
        base: seen.phone,
        kind: 'phone',
        label: 'phone number',
        also: { phone: input.phone ? formatPhone(input.phone) : null },
      },

      {
        key: 'companyId',
        column: 'companyId',
        value: edit('companyId', input.companyId),
        base: seen.companyId,
        kind: 'id',
        label: 'company',
      },
      {
        key: 'address.line1',
        column: 'addressLine1',
        value: edit('addressLine1', address.line1),
        base: seenAddress.line1,
        kind: 'text',
        label: 'address',
      },
      {
        key: 'address.line2',
        column: 'addressLine2',
        value: edit('addressLine2', address.line2),
        base: seenAddress.line2,
        kind: 'text',
        label: 'address line 2',
      },
      {
        key: 'address.city',
        column: 'city',
        value: edit('city', address.city),
        base: seenAddress.city,
        kind: 'text',
        label: 'city',
      },
      {
        key: 'address.state',
        column: 'state',
        value: edit('state', address.state),
        base: seenAddress.state,
        kind: 'text',
        label: 'state',
      },
      {
        key: 'address.postalCode',
        column: 'postalCode',
        value: edit('postalCode', address.postalCode),
        base: seenAddress.postalCode,
        kind: 'text',
        label: 'ZIP code',
      },
      {
        key: 'address.country',
        column: 'country',
        value: edit('country', address.country),
        base: seenAddress.country,
        kind: 'text',
        label: 'country',
      },
      {
        key: 'otherEmails',
        column: 'otherEmails',
        value: input.otherEmails && tidyOtherEmails(input.otherEmails, main.email),
        base: seen.otherEmails === undefined ? undefined : otherEmailsOf(seen.otherEmails ?? []),
        kind: 'json',
        label: 'other emails',
      },
      {
        key: 'otherPhones',
        column: 'otherPhones',
        value: wantedPhones && tidyOtherPhones(wantedPhones, main.phone),
        base: seen.otherPhones === undefined ? undefined : otherPhonesOf(seen.otherPhones ?? []),
        kind: 'json',
        label: 'other numbers',
      },
      {
        key: 'otherAddresses',
        column: 'otherAddresses',
        value: input.otherAddresses && tidyOtherAddresses(input.otherAddresses, main.address),
        base:
          seen.otherAddresses === undefined
            ? undefined
            : otherAddressesOf(seen.otherAddresses ?? []),
        kind: 'json',
        label: 'other addresses',
      },
      {
        key: 'notes',
        column: 'notes',
        value: edit('notes', input.notes),
        base: seen.notes,
        kind: 'text',
        label: 'notes',
      },
      {
        key: 'source',
        column: 'source',
        value: edit('source', input.source),
        base: seen.source,
        kind: 'text',
        label: 'source',
      },
      {
        key: 'ownerUserId',
        column: 'ownerUserId',
        value: edit('ownerUserId', input.ownerUserId),
        base: seen.ownerUserId,
        kind: 'id',
        label: 'owner',
      },
    ];
    const merged = mergeFields(current, fields, mergeColumns(people), ctx.meta);
    const { patch } = merged;
    const nextFirst = (patch.firstName as string | undefined) ?? current.firstName;
    const nextLast = (patch.lastName as string | undefined) ?? current.lastName;
    if (!(nextFirst + nextLast).trim())
      throw HfosError.validation([{ path: 'firstName', message: 'Enter a first or last name.' }]);
    const notApplied = merged.notApplied.map((n) => n.key);
    await logNotApplied(
      ctx,
      merged.notApplied,
      { type: 'person', id: current.id },
      { personId: current.id },
    );
    const updated = [...merged.applied];
    if (updated.length === 0) return { personId: current.id, updated: [], notApplied };
    const [row] = await ctx.tx
      .update(people)
      .set(patch)
      .where(eq(people.id, current.id))
      .returning({ id: people.id });
    if (!row) throw HfosError.forbidden();
    if ('companyId' in patch) {
      await ctx.tx
        .update(leads)
        .set({
          companyId: (patch.companyId as string | null) ?? null,
          fieldTimes: stampSql(['company_id'], changeMoment(ctx.meta)),
        })
        .where(
          and(eq(leads.personId, current.id), eq(leads.status, 'open'), isNull(leads.archivedAt)),
        );
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      before[k] = (current as Record<string, unknown>)[k];
      after[k] = patch[k];
    }
    const name = fullName(nextFirst, nextLast);
    await ctx.emit({
      type: 'person.updated',
      entityType: 'person',
      entityId: current.id,
      payload: { name, fields: updated },
      before: { name: fullName(current.firstName, current.lastName), ...before },
      after: { name, ...after },
      // Imports announce one progress event instead; people's and workflows' changes refresh open screens.
      broadcast: ctx.actor.type !== 'system',
    });
    return { personId: current.id, updated, notApplied };
  },
});
