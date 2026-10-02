/**
 * The vendors directory (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, round five, step 9): the business's own
 * list of the people its deals use, and the one picked on a duty.
 *
 * - **A vendor is a company** in Contacts (`company.create` when it's new), with what the add-on knows about it here:
 *   its services, areas, approval and any disclosure. Anyone working deals may add one; only someone who runs the
 *   deal settings approves or archives it.
 * - **On a duty**, the agent sees every approved vendor that does what it needs (those working where the home is
 *   first), picks one or more, and keeps their quote (an amount, and the quote as a deal document) and appointment
 *   with it. The report still comes back as the duty's proof through Documents.
 * - **Disclosures** go with the vendor wherever it's shown, in words.
 */
import { and, desc, eq, inArray, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { appointments, companies } from '@hfos/db/schema';
import { companyCreate } from '../../../commands/company.create';
import { HfosError } from '../../../errors';
import { executeCommandWithin, scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { money } from '../../../money/format';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import {
  DutyPickVendorInput,
  DutyUnpickVendorInput,
  DutyVendorAppointmentInput,
  DutyVendorOutput,
  DutyVendorQuoteInput,
  DutyVendorsInput,
  DutyVendorsOutput,
  VendorApproveInput,
  VendorArchiveInput,
  VendorListInput,
  VendorListOutput,
  VendorOutput,
  VendorSaveInput,
} from '../schemas';
import { isDoneDuty, type DutyStatus } from '../states';
import { documents, dutyVendors, vendors } from '../tables';
import {
  disclosureWords,
  inArea,
  serviceForDuty,
  servicesWords,
  VENDOR_SERVICES,
  type VendorService,
} from '../vendors';
import {
  actorUserId,
  dealLine,
  inWorkspace,
  requireNotArchived,
  userNames,
  type Ctx,
} from './common';
import { loadDuty, logLine } from './duties';
import { listingAddress } from './listing';

type Vendor = typeof vendors.$inferSelect;
type Pick = typeof dutyVendors.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const runsSettings = (ctx: CommandContext) =>
  ctx.actor.type !== 'human' || scopeCan(ctx.scope, 'realestate.manage' as Permission);
const notYoursToApprove = () =>
  HfosError.forbidden(
    'Only someone who runs the deal settings can approve or archive a vendor. Ask an owner or admin of this business.',
  );

async function loadVendor(ctx: CommandContext, vendorId: string): Promise<Vendor> {
  const [v] = await ctx.tx
    .select()
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.workspaceId, ctx.scope.workspaceId!)))
    .for('update');
  if (!v) throw HfosError.notFound('That vendor isn’t there anymore. Refresh to see the vendors.');
  return v;
}

/** The directory's rows, with each company's name and how to reach them, and how often deals used them. */
async function vendorRows(
  ctx: Ctx,
  where: {
    readonly ids?: readonly string[];
    readonly service?: VendorService;
    readonly archived?: boolean;
  },
) {
  const list = await ctx.tx
    .select({
      v: vendors,
      name: companies.name,
      email: companies.email,
      phone: companies.phone,
    })
    .from(vendors)
    .innerJoin(companies, eq(companies.id, vendors.companyId))
    .where(
      and(
        eq(vendors.workspaceId, ctx.scope.workspaceId!),
        ...(where.ids ? [inArray(vendors.id, [...where.ids])] : []),
        ...(where.service ? [dsql`${where.service} = any(${vendors.services})`] : []),
        ...(where.archived ? [] : [isNull(vendors.archivedAt)]),
      ),
    )
    .orderBy(companies.name);
  const used = list.length
    ? await rows<{ vendor_id: string; uses: number; last: string | null }>(
        ctx.tx,
        sql`select vendor_id, count(*)::int as uses, max(picked_at)::text as last
            from addon_realestate.duty_vendors
            where workspace_id = ${ctx.scope.workspaceId!}
              and vendor_id = any(${`{${list.map((l) => l.v.id).join(',')}}`}::uuid[])
            group by vendor_id`,
      )
    : [];
  const byVendor = new Map(used.map((u) => [u.vendor_id, u]));
  return list.map(({ v, name, email, phone }) => {
    const u = byVendor.get(v.id);
    return {
      id: v.id,
      companyId: v.companyId,
      name,
      email: email ? String(email) : null,
      phone: phone ?? null,
      services: v.services,
      servicesWords: servicesWords(v.services),
      areas: v.areas,
      approved: v.approved,
      approvedAt: iso(v.approvedAt),
      disclosure: v.disclosure,
      disclosureWords: disclosureWords(v.disclosure),
      note: v.note,
      archived: !!v.archivedAt,
      uses: u?.uses ?? 0,
      lastUsedAt: u?.last ? new Date(u.last).toISOString() : null,
    };
  });
}

const vendorOut = (v: Vendor) => ({ vendorId: v.id, companyId: v.companyId, approved: v.approved });

// ---------- the directory ----------

export const vendorSave = defineAddonCommand(realestateAddon, {
  name: 'realestate.vendor.save',
  description:
    'Add a vendor to the business’s directory, or change one: the company (one in Contacts, or a new one), what they do, where, and any disclosure the client must be told of (an affiliation, a referral fee). A new vendor waits for approval.',
  risk: 1,
  input: VendorSaveInput,
  output: VendorOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.vendor.saved', 'company.created'],
  async handler(ctx, input) {
    const at = changeMoment(ctx.meta);
    const facts = {
      services: [...new Set(input.services)],
      areas: [...new Set(input.areas.map((a) => a.trim()))].filter(Boolean),
      ...(input.disclosure !== undefined ? { disclosure: input.disclosure } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    let v: Vendor;
    if (input.vendorId) {
      const was = await loadVendor(ctx, input.vendorId);
      // A new disclosure is something the approver should see again.
      const disclosureChanged =
        input.disclosure !== undefined && (input.disclosure ?? null) !== was.disclosure;
      const unapprove = disclosureChanged && was.approved && !runsSettings(ctx);
      [v] = (await ctx.tx
        .update(vendors)
        .set({
          ...facts,
          ...(unapprove ? { approved: false, approvedAt: null, approvedBy: null } : {}),
          updatedAt: at,
        })
        .where(eq(vendors.id, was.id))
        .returning()) as [Vendor];
    } else {
      let companyId = input.companyId ?? null;
      if (companyId) {
        const [c] = await ctx.tx
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(eq(companies.id, companyId), eq(companies.workspaceId, ctx.scope.workspaceId!)),
          );
        if (!c)
          throw HfosError.notFound(
            'That company isn’t in Contacts anymore. Pick it again, or add the vendor by name.',
          );
      } else {
        const [same] = await ctx.tx
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(
              eq(companies.workspaceId, ctx.scope.workspaceId!),
              dsql`lower(${companies.name}) = lower(${input.name!})`,
            ),
          )
          .limit(1);
        companyId =
          same?.id ??
          (
            await executeCommandWithin(ctx, companyCreate, {
              workspaceId: ctx.scope.workspaceId!,
              name: input.name!,
              ...(input.email ? { email: input.email } : {}),
              ...(input.phone ? { phone: input.phone } : {}),
              source: 'Vendors',
              ignoreDuplicates: true,
            })
          ).output.companyId;
      }
      const [already] = await ctx.tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(
          and(eq(vendors.workspaceId, ctx.scope.workspaceId!), eq(vendors.companyId, companyId)),
        );
      if (already)
        throw HfosError.rule(
          'realestate_vendor_exists',
          409,
          'That company is in the directory already. Change it there instead.',
        );
      [v] = (await ctx.tx
        .insert(vendors)
        .values({
          workspaceId: ctx.scope.workspaceId!,
          companyId,
          services: facts.services,
          areas: facts.areas,
          disclosure: input.disclosure ?? null,
          note: input.note ?? null,
          createdBy: actorUserId(ctx),
        })
        .returning()) as [Vendor];
    }
    await ctx.emit({
      type: 'realestate.vendor.saved',
      entityType: 'company',
      entityId: v.companyId,
      payload: { vendorId: v.id, services: v.services, approved: v.approved },
      after: { services: servicesWords(v.services), areas: v.areas.join(', ') || null },
    });
    return vendorOut(v);
  },
});

export const vendorApprove = defineAddonCommand(realestateAddon, {
  name: 'realestate.vendor.approve',
  description:
    'Approve a vendor for the business’s deals, or take the approval back. Only approved vendors are offered on a duty.',
  risk: 2,
  input: VendorApproveInput,
  output: VendorOutput,
  permission: 'realestate.manage',
  scope: inWorkspace,
  emits: ['realestate.vendor.saved'],
  async handler(ctx, input) {
    if (!runsSettings(ctx)) throw notYoursToApprove();
    const was = await loadVendor(ctx, input.vendorId);
    if (was.archivedAt && input.approved)
      throw HfosError.rule(
        'realestate_vendor_archived',
        409,
        'That vendor is archived. Bring it back before approving it.',
      );
    if (was.approved === input.approved) return vendorOut(was);
    const at = changeMoment(ctx.meta);
    const [v] = (await ctx.tx
      .update(vendors)
      .set(
        input.approved
          ? { approved: true, approvedAt: at, approvedBy: actorUserId(ctx), updatedAt: at }
          : { approved: false, approvedAt: null, approvedBy: null, updatedAt: at },
      )
      .where(eq(vendors.id, was.id))
      .returning()) as [Vendor];
    await ctx.emit({
      type: 'realestate.vendor.saved',
      entityType: 'company',
      entityId: v.companyId,
      payload: { vendorId: v.id, services: v.services, approved: v.approved },
      before: { approved: was.approved },
      after: { approved: v.approved },
    });
    return vendorOut(v);
  },
});

export const vendorArchive = defineAddonCommand(realestateAddon, {
  name: 'realestate.vendor.archive',
  description:
    'Take a vendor out of the directory: they’re no longer offered on a duty. The duties they were picked on keep them, as they were.',
  risk: 2,
  input: VendorArchiveInput,
  output: VendorOutput,
  permission: 'realestate.manage',
  scope: inWorkspace,
  emits: ['realestate.vendor.saved'],
  async handler(ctx, input) {
    if (!runsSettings(ctx)) throw notYoursToApprove();
    const was = await loadVendor(ctx, input.vendorId);
    if (was.archivedAt) return vendorOut(was);
    const at = changeMoment(ctx.meta);
    const [v] = (await ctx.tx
      .update(vendors)
      .set({
        archivedAt: at,
        archivedBy: actorUserId(ctx),
        approved: false,
        approvedAt: null,
        approvedBy: null,
        updatedAt: at,
        ...(input.reason ? { note: input.reason } : {}),
      })
      .where(eq(vendors.id, was.id))
      .returning()) as [Vendor];
    await ctx.emit({
      type: 'realestate.vendor.saved',
      entityType: 'company',
      entityId: v.companyId,
      payload: { vendorId: v.id, services: v.services, approved: false, archived: true },
      after: { archived: true },
    });
    return vendorOut(v);
  },
});

export const vendorList = defineAddonQuery(realestateAddon, {
  name: 'realestate.vendor.list',
  description:
    'The business’s vendors: what each does and where, whether it’s approved, any disclosure, and how often deals used them.',
  input: VendorListInput,
  output: VendorListOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_vendors',
    description:
      'The business’s vendors directory: who does what, where, approval and disclosures.',
  },
  async handler(ctx, input) {
    return {
      vendors: await vendorRows(ctx, {
        ...(input.service ? { service: input.service } : {}),
        archived: input.includeArchived,
      }),
    };
  },
});

// ---------- on a duty ----------

export const dutyVendorsGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.duty.vendors',
  description:
    'Vendors on a duty: what it needs, every approved vendor that does it (those working where the home is first, each with any disclosure), and the ones picked with their quotes and appointments.',
  input: DutyVendorsInput,
  output: DutyVendorsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId);
    const service = input.service ?? serviceForDuty(duty.title);
    const address = await listingAddress(ctx, deal);
    const fits = service
      ? (await vendorRows(ctx, { service }))
          .filter((v) => v.approved)
          .map((v) => ({ ...v, inArea: inArea(v.areas, address) }))
          .sort((a, b) => Number(b.inArea === true) - Number(a.inArea === true))
      : [];
    const picks = await ctx.tx
      .select()
      .from(dutyVendors)
      .where(eq(dutyVendors.dutyId, duty.id))
      .orderBy(desc(dutyVendors.pickedAt));
    const picked = new Map(
      (
        await vendorRows(ctx, { ids: [...new Set(picks.map((p) => p.vendorId))], archived: true })
      ).map((v) => [v.id, v]),
    );
    const docs = picks.some((p) => p.quoteDocumentId)
      ? await ctx.tx
          .select({ id: documents.id, title: documents.title })
          .from(documents)
          .where(
            inArray(
              documents.id,
              picks.flatMap((p) => (p.quoteDocumentId ? [p.quoteDocumentId] : [])),
            ),
          )
      : [];
    const appts = picks.some((p) => p.appointmentId)
      ? await ctx.tx
          .select({
            id: appointments.id,
            title: appointments.title,
            startsAt: appointments.startsAt,
          })
          .from(appointments)
          .where(
            inArray(
              appointments.id,
              picks.flatMap((p) => (p.appointmentId ? [p.appointmentId] : [])),
            ),
          )
      : [];
    const names = await userNames(
      ctx,
      picks.map((p) => p.pickedBy),
    );
    return {
      dutyId: duty.id,
      dealId: deal.recordId,
      service,
      serviceLabel: service ? VENDOR_SERVICES[service] : null,
      address,
      fits,
      picks: picks.flatMap((p) => {
        const vendor = picked.get(p.vendorId);
        if (!vendor) return [];
        const doc = docs.find((d) => d.id === p.quoteDocumentId);
        const appt = appts.find((a) => a.id === p.appointmentId);
        return [
          {
            pickId: p.id,
            vendor,
            service: p.service,
            serviceLabel: VENDOR_SERVICES[p.service],
            quoteCents: p.quoteCents,
            quoteWords: p.quoteCents !== null ? money(p.quoteCents) : null,
            quoteDocument: doc ? { id: doc.id, title: doc.title } : null,
            appointment: appt
              ? {
                  id: appt.id,
                  title: appt.title ?? null,
                  startsAt: new Date(appt.startsAt).toISOString(),
                }
              : null,
            note: p.note,
            pickedAt: p.pickedAt.toISOString(),
            pickedByName: p.pickedBy ? (names.get(p.pickedBy) ?? null) : null,
            removedAt: iso(p.removedAt),
            removedReason: p.removedReason,
          },
        ];
      }),
    };
  },
});

async function loadPick(ctx: CommandContext, pickId: string) {
  const [p] = await ctx.tx
    .select()
    .from(dutyVendors)
    .where(and(eq(dutyVendors.id, pickId), eq(dutyVendors.workspaceId, ctx.scope.workspaceId!)))
    .for('update');
  if (!p)
    throw HfosError.notFound('That vendor isn’t on the duty anymore. Refresh to see its vendors.');
  const { duty, deal } = await loadDuty(ctx, p.dutyId, { lock: true });
  requireNotArchived(deal);
  if (p.removedAt)
    throw HfosError.rule(
      'realestate_vendor_let_go',
      409,
      'That vendor was taken off the duty. Pick them again to change it.',
    );
  return { p, duty, deal };
}

const pickOut = (p: Pick) => ({ pickId: p.id, dutyId: p.dutyId, vendorId: p.vendorId });

export const dutyPickVendor = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.pick_vendor',
  description:
    'Pick an approved vendor on a duty (the inspector on “Schedule inspections”, say). Their disclosure is said on the deal; their quote and appointment can be added after.',
  risk: 1,
  input: DutyPickVendorInput,
  output: DutyVendorOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_pick_vendor',
    description: 'Pick one of the business’s approved vendors on a deal’s duty.',
  },
  emits: ['realestate.duty.vendor_picked'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    if (isDoneDuty(duty.status as DutyStatus))
      throw HfosError.rule(
        'realestate_duty_finished',
        409,
        `“${duty.title}” is finished. Reopen it first to pick a vendor.`,
      );
    const v = await loadVendor(ctx, input.vendorId);
    const [row] = await vendorRows(ctx, { ids: [v.id], archived: true });
    if (v.archivedAt || !v.approved)
      throw HfosError.rule(
        'realestate_vendor_not_approved',
        409,
        `${row!.name} isn’t approved for your deals${v.archivedAt ? ' any more' : ' yet'}. Ask someone who runs the deal settings to approve them under Vendors.`,
      );
    const service = input.service ?? serviceForDuty(duty.title) ?? v.services[0]!;
    if (!v.services.includes(service))
      throw HfosError.validation([
        {
          path: 'service',
          message: `${row!.name} doesn’t do ${VENDOR_SERVICES[service].toLowerCase()}. Pick another vendor, or what they do.`,
        },
      ]);
    const [p] = await ctx.tx
      .insert(dutyVendors)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        dutyId: duty.id,
        vendorId: v.id,
        service,
        note: input.note ?? null,
        pickedBy: actorUserId(ctx),
        pickedAt: changeMoment(ctx.meta),
      })
      .onConflictDoNothing()
      .returning();
    if (!p)
      throw HfosError.rule(
        'realestate_vendor_picked',
        409,
        `${row!.name} is already on “${duty.title}”.`,
      );
    await logLine(ctx, duty, 'vendor_picked', {
      after: { vendor: row!.name, service, disclosure: v.disclosure },
    });
    const eventId = await ctx.emit({
      type: 'realestate.duty.vendor_picked',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { dutyId: duty.id, vendorId: v.id, pickId: p.id, service, name: row!.name },
      after: { vendor: row!.name, duty: duty.title },
    });
    await dealLine(ctx, deal, `picked ${row!.name} for “${duty.title}”`.slice(0, 300), {
      eventId,
      ...(v.disclosure ? { body: disclosureWords(v.disclosure) } : {}),
    });
    return pickOut(p);
  },
});

export const dutyVendorQuote = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.vendor_quote',
  description:
    'Keep a picked vendor’s quote on the duty: the amount, and the quote itself as one of the deal’s documents.',
  risk: 1,
  input: DutyVendorQuoteInput,
  output: DutyVendorOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const { p, duty, deal } = await loadPick(ctx, input.pickId);
    if (input.documentId) {
      const [d] = await ctx.tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.dealRecordId, deal.recordId)));
      if (!d)
        throw HfosError.notFound(
          `That document isn’t on ${deal.name}. Add the quote to the deal’s documents first.`,
        );
    }
    const [now] = await ctx.tx
      .update(dutyVendors)
      .set({
        quoteCents: input.cents,
        ...(input.documentId !== undefined ? { quoteDocumentId: input.documentId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(dutyVendors.id, p.id))
      .returning();
    await logLine(ctx, duty, 'vendor_quote', {
      before: { cents: p.quoteCents },
      after: { cents: input.cents, documentId: input.documentId ?? p.quoteDocumentId },
    });
    return pickOut(now!);
  },
});

export const dutyVendorAppointment = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.vendor_appointment',
  description: 'Say which appointment on the calendar is a picked vendor’s for the duty, or none.',
  risk: 1,
  input: DutyVendorAppointmentInput,
  output: DutyVendorOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const { p, duty } = await loadPick(ctx, input.pickId);
    if (input.appointmentId) {
      const [a] = await ctx.tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.id, input.appointmentId),
            eq(appointments.workspaceId, ctx.scope.workspaceId!),
          ),
        );
      if (!a)
        throw HfosError.notFound(
          'That appointment isn’t on the calendar anymore. Book it again, then pick it.',
        );
    }
    const [now] = await ctx.tx
      .update(dutyVendors)
      .set({ appointmentId: input.appointmentId, updatedAt: new Date() })
      .where(eq(dutyVendors.id, p.id))
      .returning();
    await logLine(ctx, duty, 'vendor_appointment', {
      before: { appointmentId: p.appointmentId },
      after: { appointmentId: input.appointmentId },
    });
    return pickOut(now!);
  },
});

export const dutyUnpickVendor = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.unpick_vendor',
  description: 'Take a vendor off a duty, with the reason. What was kept on it stays, marked.',
  risk: 1,
  input: DutyUnpickVendorInput,
  output: DutyVendorOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const { p, duty } = await loadPick(ctx, input.pickId);
    const at = changeMoment(ctx.meta);
    const [now] = await ctx.tx
      .update(dutyVendors)
      .set({
        removedAt: at,
        removedBy: actorUserId(ctx),
        removedReason: input.reason,
        updatedAt: at,
      })
      .where(eq(dutyVendors.id, p.id))
      .returning();
    await logLine(ctx, duty, 'vendor_unpicked', {
      before: { vendorId: p.vendorId },
      note: input.reason,
    });
    return pickOut(now!);
  },
});

export const vendorCommands = [
  vendorSave,
  vendorApprove,
  vendorArchive,
  dutyPickVendor,
  dutyVendorQuote,
  dutyVendorAppointment,
  dutyUnpickVendor,
];
export const vendorQueries = [vendorList, dutyVendorsGet];
