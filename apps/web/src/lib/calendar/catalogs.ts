/**
 * The builder's view of what a calendar's settings refer to, made from the page's queries, so the same
 * rules the server saves with (validateCalendar, labels, diff, impact) run live in the browser.
 */
import type {
  CalendarCatalogs,
  CatalogPaymentAccount,
  DepositTerms,
  CatalogPipeline,
  CatalogService,
  WeeklyHours,
} from '@hfos/core';
import type { Pipeline, ResourceItem, ServiceItem, TerritoryItem } from '@/lib/api/types';

export interface CatalogInput {
  readonly timeZone: string;
  /** Everyone in the workspace, with their weekly hours when known. */
  readonly people: readonly { userId: string; fullName: string; weekly?: WeeklyHours | null }[];
  /** People a calendar still names who have left (kept so messages can name them). */
  readonly departed?: readonly string[];
  readonly services: readonly ServiceItem[];
  readonly resources: readonly ResourceItem[];
  readonly territories: readonly TerritoryItem[];
  readonly pipelines: readonly Pipeline[];
  readonly textingReady: boolean;
  /** The accounts money could land in; one is enough for a calendar to ask for a deposit or the full price. */
  readonly paymentAccounts?: readonly CatalogPaymentAccount[];
  /** What the business asks for up front (Settings → Payments), which a calendar may override. */
  readonly businessDeposit?: DepositTerms;
}

export function serviceCatalog(s: ServiceItem): CatalogService {
  return {
    id: s.id,
    name: s.name,
    durations: s.durations,
    bufferBefore: s.bufferBefore,
    bufferAfter: s.bufferAfter,
    eligibleUserIds: s.staffUserIds,
    requiredResources: s.resources,
    archived: !!s.archivedAt,
    priceCents: s.priceCents ?? null,
    hours: (s.hours as WeeklyHours | null) ?? null,
  };
}

export function buildCatalogs(input: CatalogInput): CalendarCatalogs {
  const known = new Set(input.people.map((p) => p.userId));
  return {
    timeZone: input.timeZone,
    team: [
      ...input.people.map((p) => ({
        userId: p.userId,
        name: p.fullName,
        active: true,
        hours: p.weekly ?? null,
      })),
      ...(input.departed ?? [])
        .filter((u) => !known.has(u))
        .map((userId) => ({ userId, name: 'A former teammate', active: false })),
    ],
    services: input.services.map(serviceCatalog),
    resources: input.resources.map((r) => ({
      id: r.id,
      name: r.name,
      quantity: r.quantity,
      archived: !!r.archivedAt,
      hours: (r.hours as WeeklyHours | null) ?? null,
    })),
    territories: input.territories.map((t) => ({
      id: t.id,
      name: t.name,
      postalCodes: t.postalCodes,
      userIds: t.userIds,
    })),
    pipelines: input.pipelines.map((p): CatalogPipeline => ({
      id: p.id,
      name: p.name,
      archived: !!p.archivedAt,
      stages: p.stages.map((s) => ({ id: s.id, name: s.name, archived: false })),
    })),
    textingReady: input.textingReady,
    paymentsAvailable: (input.paymentAccounts ?? []).length > 0,
    paymentAccounts: input.paymentAccounts ?? [],
    businessDeposit: input.businessDeposit ?? { kind: 'none' },
  };
}
