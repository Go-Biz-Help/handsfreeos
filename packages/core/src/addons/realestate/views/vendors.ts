/**
 * Vendors from a phone's copy (Real Estate round six, step 13): the business's directory, as `realestate.vendor.list`
 * answers it, and a duty's vendors, as `realestate.duty.vendors` does (ops/vendors.ts). The directory is the
 * business's own (every phone with the add-on keeps it); how often deals used each counts the picks on the deals the
 * phone holds whole, so for someone who sees every deal it's `partial` until signal.
 * `packages/core/test/addons/realestate-phone-views.test.ts` holds both to the server's answer.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import { money } from '../../../money/format';
import type { DutyVendorsOutput, VendorListOutput } from '../schemas';
import {
  disclosureWords,
  inArea,
  serviceForDuty,
  servicesWords,
  VENDOR_SERVICES,
  type VendorService,
} from '../vendors';
import { holdsWhole, isoOr } from './deal-facts';
import { byName, byText, ms, text, type RealestateCopy } from './synced';

export type VendorRow = z.infer<typeof VendorListOutput>['vendors'][number];
export type DutyVendorsView = z.infer<typeof DutyVendorsOutput>;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Every pick of a vendor on the deals the phone holds whole. */
function picksOf(copy: RealestateCopy, userId: string | null) {
  return [...copy.deals.keys()]
    .filter((id) => holdsWhole(copy, id, userId))
    .flatMap((id) => copy.rows('duty_vendors', id));
}

function vendorRows(
  copy: RealestateCopy,
  userId: string | null,
  where: {
    readonly ids?: ReadonlySet<string>;
    readonly service?: VendorService;
    readonly archived?: boolean;
  },
): VendorRow[] {
  const used = new Map<string, { uses: number; last: number | null }>();
  for (const { data: p } of picksOf(copy, userId)) {
    const v = text(p.vendor_id) ?? '';
    const was = used.get(v) ?? { uses: 0, last: null };
    const at = ms(p.picked_at);
    used.set(v, {
      uses: was.uses + 1,
      last: at === null ? was.last : Math.max(was.last ?? at, at),
    });
  }
  return copy
    .businessRows('vendors')
    .flatMap(({ id, data: v }) => {
      const companyId = text(v.company_id) ?? '';
      const name = copy.company(companyId);
      if (name === null) return [];
      const services = strings(v.services) as VendorService[];
      const archived = text(v.archived_at) !== null;
      if (where.ids && !where.ids.has(id)) return [];
      if (where.service && !services.includes(where.service)) return [];
      if (!where.archived && archived) return [];
      const u = used.get(id);
      const contact = copy.companyContact(companyId);
      const disclosure = text(v.disclosure);
      return [
        {
          id,
          companyId,
          name,
          email: contact.email,
          phone: contact.phone,
          services,
          servicesWords: servicesWords(services),
          areas: strings(v.areas),
          approved: v.approved === true,
          approvedAt: isoOr(v.approved_at),
          disclosure,
          disclosureWords: disclosureWords(disclosure),
          note: text(v.note),
          archived,
          uses: u?.uses ?? 0,
          lastUsedAt:
            u?.last !== null && u?.last !== undefined ? new Date(u.last).toISOString() : null,
        },
      ];
    })
    .sort((a, b) => byName(a.name, b.name) || byText(a.id, b.id));
}

export function vendorListOfCopy(
  copy: RealestateCopy,
  filter: { readonly service?: VendorService; readonly includeArchived?: boolean },
  ctx: { readonly userId: string | null },
): { vendors: VendorRow[]; partial: boolean } {
  return {
    vendors: vendorRows(copy, ctx.userId, {
      ...(filter.service ? { service: filter.service } : {}),
      archived: filter.includeArchived ?? false,
    }),
    partial: [...copy.deals.keys()].some((id) => !holdsWhole(copy, id, ctx.userId)),
  };
}

/** A duty's vendors, or null when the phone doesn't hold the duty whole. */
export function dutyVendorsOfCopy(
  copy: RealestateCopy,
  dutyId: string,
  opts: { readonly service?: VendorService; readonly userId: string | null },
): DutyVendorsView | null {
  let found: { dealId: string; title: string } | null = null;
  for (const [dealId, list] of copy.duties) {
    const t = list.find((d) => d.id === dutyId);
    if (t) found = { dealId, title: t.title };
  }
  if (!found || !holdsWhole(copy, found.dealId, opts.userId)) return null;
  const { dealId } = found;
  const service = opts.service ?? serviceForDuty(found.title);
  const home = copy.homes.get(dealId);
  const address = home ? copy.record(home) : null;
  const fits = service
    ? vendorRows(copy, opts.userId, { service })
        .filter((v) => v.approved)
        .map((v) => ({ ...v, inArea: inArea(v.areas, address) }))
        .sort((a, b) => Number(b.inArea === true) - Number(a.inArea === true))
    : [];
  const picks = copy
    .rows('duty_vendors', dealId)
    .filter((p) => text(p.data.duty_id) === dutyId)
    .sort(
      (a, b) => (ms(b.data.picked_at) ?? 0) - (ms(a.data.picked_at) ?? 0) || byText(b.id, a.id),
    );
  const picked = new Map(
    vendorRows(copy, opts.userId, {
      ids: new Set(picks.map((p) => text(p.data.vendor_id) ?? '')),
      archived: true,
    }).map((v) => [v.id, v]),
  );
  const docs = new Map(copy.rows('documents', dealId).map((r) => [r.id, r.data]));
  return {
    dutyId,
    dealId,
    service,
    serviceLabel: service ? VENDOR_SERVICES[service] : null,
    address,
    fits,
    picks: picks.flatMap(({ id, data: p }) => {
      const vendor = picked.get(text(p.vendor_id) ?? '');
      if (!vendor) return [];
      const docId = text(p.quote_document_id);
      const doc = docId ? docs.get(docId) : undefined;
      const apptId = text(p.appointment_id);
      const startsAt = apptId ? copy.appointmentStart(apptId) : null;
      const cents =
        p.quote_cents === null || p.quote_cents === undefined ? null : Number(p.quote_cents);
      const by = text(p.picked_by);
      const svc = (text(p.service) ?? '') as VendorService;
      return [
        {
          pickId: id,
          vendor,
          service: svc,
          serviceLabel: VENDOR_SERVICES[svc],
          quoteCents: cents,
          quoteWords: cents !== null ? money(cents) : null,
          quoteDocument: doc && docId ? { id: docId, title: text(doc.title) ?? '' } : null,
          appointment:
            apptId && startsAt ? { id: apptId, title: copy.appointment(apptId), startsAt } : null,
          note: text(p.note),
          pickedAt: isoOr(p.picked_at) ?? new Date(0).toISOString(),
          pickedByName: by ? copy.user(by) : null,
          removedAt: isoOr(p.removed_at),
          removedReason: text(p.removed_reason),
        },
      ];
    }),
  };
}
