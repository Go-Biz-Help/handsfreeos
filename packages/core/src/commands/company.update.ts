import { and, eq } from 'drizzle-orm';
import { companies } from '@hfos/db/schema';
import {
  addressKey,
  emailKey,
  listEdit,
  otherAddressesOf,
  otherEmailsOf,
  otherPhonesOf,
  phoneKey,
  tidyOtherAddresses,
  tidyOtherEmails,
  tidyOtherPhones,
} from '../crm/contact-points';
import { formatPhone } from '../crm/phone';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import {
  logNotApplied,
  mergeColumns,
  mergeFields,
  type MergeField,
  type MergeKind,
} from '../kernel/field-merge';
import { CompanyUpdateInput, CompanyUpdateOutput } from '../schemas/company';
import { requireAssigner } from './record.assign';

export const companyUpdate = defineCommand({
  name: 'company.update',
  description:
    'Change a company’s details: only the ones edited, each with what the editor saw, and the newest change to each wins.',
  risk: 1,
  input: CompanyUpdateInput,
  output: CompanyUpdateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['company.updated'],
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(companies)
      .where(
        and(eq(companies.id, input.companyId), eq(companies.workspaceId, ctx.scope.workspaceId!)),
      )
      .for('update');
    if (!current) throw HfosError.notFound('Company not found.');
    const seen: NonNullable<typeof input.base> = input.base ?? {};
    const address: NonNullable<typeof input.address> = input.address ?? {};
    const seenAddress: NonNullable<typeof seen.address> = seen.address ?? {};
    const field = (
      key: string,
      column: string,
      value: unknown,
      base: unknown,
      kind: MergeKind,
      label: string,
    ): MergeField => ({ key, column, value, base, kind, label });
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
    // Each list merges entry by entry with the row (0102), so two people adding a number at once both keep theirs.
    const emails = listEdit(
      input.otherEmails && tidyOtherEmails(input.otherEmails, main.email),
      seen.otherEmails === undefined ? undefined : otherEmailsOf(seen.otherEmails ?? []),
      otherEmailsOf(current.otherEmails),
      emailKey,
      (l) => tidyOtherEmails(l, main.email),
    );
    const phones = listEdit(
      input.otherPhones && tidyOtherPhones(input.otherPhones, main.phone),
      seen.otherPhones === undefined ? undefined : otherPhonesOf(seen.otherPhones ?? []),
      otherPhonesOf(current.otherPhones),
      phoneKey,
      (l) => tidyOtherPhones(l, main.phone),
    );
    const addresses = listEdit(
      input.otherAddresses && tidyOtherAddresses(input.otherAddresses, main.address),
      seen.otherAddresses === undefined ? undefined : otherAddressesOf(seen.otherAddresses ?? []),
      otherAddressesOf(current.otherAddresses),
      addressKey,
      (l) => tidyOtherAddresses(l, main.address),
    );
    const fields: MergeField[] = [
      field('name', 'name', input.name, seen.name, 'text', 'name'),
      field('email', 'email', input.email, seen.email, 'email', 'email'),
      {
        ...field('phone', 'phoneE164', input.phone, seen.phone, 'phone', 'phone number'),
        also: { phone: input.phone ? formatPhone(input.phone) : null },
      },
      field('website', 'website', input.website, seen.website, 'text', 'website'),
      field('address.line1', 'addressLine1', address.line1, seenAddress.line1, 'text', 'address'),
      field(
        'address.line2',
        'addressLine2',
        address.line2,
        seenAddress.line2,
        'text',
        'address line 2',
      ),
      field('address.city', 'city', address.city, seenAddress.city, 'text', 'city'),
      field('address.state', 'state', address.state, seenAddress.state, 'text', 'state'),
      field(
        'address.postalCode',
        'postalCode',
        address.postalCode,
        seenAddress.postalCode,
        'text',
        'ZIP code',
      ),
      field('address.country', 'country', address.country, seenAddress.country, 'text', 'country'),
      field('otherEmails', 'otherEmails', emails.value, emails.base, 'json', 'other emails'),
      field('otherPhones', 'otherPhones', phones.value, phones.base, 'json', 'other numbers'),
      field(
        'otherAddresses',
        'otherAddresses',
        addresses.value,
        addresses.base,
        'json',
        'other addresses',
      ),
      field('notes', 'notes', input.notes, seen.notes, 'text', 'notes'),
      field('source', 'source', input.source, seen.source, 'text', 'source'),
      field('ownerUserId', 'ownerUserId', input.ownerUserId, seen.ownerUserId, 'id', 'owner'),
    ];
    const merged = mergeFields(current, fields, mergeColumns(companies), ctx.meta);
    const { patch } = merged;
    // Who a customer is assigned to shows members its bills and threads, so it is the managers' call (0103).
    if ('ownerUserId' in patch && patch.ownerUserId !== current.ownerUserId) requireAssigner(ctx);
    const notApplied = merged.notApplied.map((n) => n.key);
    await logNotApplied(
      ctx,
      merged.notApplied,
      { type: 'company', id: current.id },
      { companyId: current.id },
    );
    const updated = [...merged.applied];
    if (updated.length === 0) return { companyId: current.id, updated: [], notApplied };
    const [row] = await ctx.tx
      .update(companies)
      .set(patch)
      .where(eq(companies.id, current.id))
      .returning({ id: companies.id });
    if (!row) throw HfosError.forbidden();
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      before[k] = (current as Record<string, unknown>)[k];
      after[k] = patch[k];
    }
    await ctx.emit({
      type: 'company.updated',
      entityType: 'company',
      entityId: current.id,
      payload: { name: (patch.name as string | undefined) ?? current.name, fields: updated },
      before: { name: current.name, ...before },
      after: { name: (patch.name as string | undefined) ?? current.name, ...after },
      broadcast: ctx.actor.type === 'human',
    });
    return { companyId: current.id, updated, notApplied };
  },
});
