/**
 * What a calendar's settings refer to: workspace catalogs and readiness flags. The loader builds this from
 * the database (and the builder from the page's queries); the rules, presets, diff and impact read it.
 */
import type { WeeklyHours } from './config';
import { NO_DEPOSIT, type DepositTerms } from '../money/totals';

export interface CatalogPerson {
  readonly userId: string;
  readonly name: string;
  /** False once they have left the workspace (kept so messages can still name them). */
  readonly active: boolean;
  /** Their weekly hours; missing means unknown (treated as open). */
  readonly hours?: WeeklyHours | null;
}

export interface CatalogService {
  readonly id: string;
  readonly name: string;
  /** Allowed lengths in minutes, first is the default. */
  readonly durations: readonly number[];
  readonly bufferBefore: number;
  readonly bufferAfter: number;
  /** What it costs, where anyone has said: the product that prices it, else its own "price shown". */
  readonly priceCents?: number | null;
  /** Who can do it; empty means everyone. */
  readonly eligibleUserIds: readonly string[];
  readonly requiredResources: readonly { readonly resourceId: string; readonly quantity: number }[];
  readonly archived: boolean;
  /** Service hours; missing or null means no extra layer. */
  readonly hours?: WeeklyHours | null;
}

export interface CatalogResource {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly archived: boolean;
  readonly hours?: WeeklyHours | null;
}

export interface CatalogTerritory {
  readonly id: string;
  readonly name: string;
  /** M18: ZIP codes, miles from a point, or a shape drawn on the map. */
  readonly kind: 'zip' | 'radius' | 'polygon';
  /** 5-digit ZIP codes (a ZIP area). */
  readonly postalCodes: readonly string[];
  /** A distance area: the address it is measured from, where that is, and how far. */
  readonly centerAddress: string | null;
  readonly center: { readonly lat: number; readonly lng: number } | null;
  readonly radiusMiles: number | null;
  /** A drawn area: its corners, [lat, lng]. */
  readonly polygon: readonly (readonly [number, number])[] | null;
  readonly userIds: readonly string[];
}

export interface CatalogPipeline {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly stages: readonly {
    readonly id: string;
    readonly name: string;
    readonly archived: boolean;
  }[];
}

/** One account a business has connected and can be paid into (Settings → Payments). */
export interface CatalogPaymentAccount {
  readonly id: string;
  /** The business's own label for it, else the provider's name for the account. */
  readonly name: string;
  /** stripe, square. */
  readonly provider: string;
  /** The one everything is paid into unless a document names another. */
  readonly isDefault: boolean;
}

export interface CalendarCatalogs {
  /** The calendar's time zone (the workspace's when the calendar has none). */
  readonly timeZone: string;
  /** Current workspace members, plus anyone a calendar still names (active false). */
  readonly team: readonly CatalogPerson[];
  readonly services: readonly CatalogService[];
  readonly resources: readonly CatalogResource[];
  readonly territories: readonly CatalogTerritory[];
  readonly pipelines: readonly CatalogPipeline[];
  /** Texting is registered and has a number. */
  readonly textingReady: boolean;
  /** The business has at least one connected payment account, so a booking can take money. */
  readonly paymentsAvailable: boolean;
  /**
   * The accounts money could land in. Empty for a member: `payment_connections` needs money.manage, and the
   * builder is owners and admins only, so `paymentsAvailable` reads false for them too.
   */
  readonly paymentAccounts: readonly CatalogPaymentAccount[];
  /** What the business asks for up front (Settings → Payments); a calendar may ask for its own instead. */
  readonly businessDeposit: DepositTerms;
}

export function emptyCatalogs(timeZone = 'America/Chicago'): CalendarCatalogs {
  return {
    timeZone,
    team: [],
    services: [],
    resources: [],
    territories: [],
    pipelines: [],
    textingReady: false,
    paymentsAvailable: false,
    paymentAccounts: [],
    businessDeposit: NO_DEPOSIT,
  };
}

/** Name lookups used by messages; unknown ids read as a generic word. */
export function personName(
  catalogs: Pick<CalendarCatalogs, 'team'> | undefined,
  userId: string,
): string {
  return catalogs?.team.find((p) => p.userId === userId)?.name ?? 'Someone';
}

export function serviceName(
  catalogs: Pick<CalendarCatalogs, 'services'> | undefined,
  serviceId: string,
): string {
  return catalogs?.services.find((s) => s.id === serviceId)?.name ?? 'A service';
}

export function resourceName(
  catalogs: Pick<CalendarCatalogs, 'resources'> | undefined,
  resourceId: string,
): string {
  return catalogs?.resources.find((r) => r.id === resourceId)?.name ?? 'A resource';
}

/** First five digits of a US ZIP ('75201-1234' → '75201'), or null. */
export function zip5(postalCode: string | null | undefined): string | null {
  const digits = (postalCode ?? '').replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}
