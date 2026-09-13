/**
 * What a calendar's settings refer to: workspace catalogs and readiness flags. The loader builds this from
 * the database (and the builder from the page's queries); the rules, presets, diff and impact read it.
 */
import type { WeeklyHours } from './config';

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
  /** 5-digit ZIP codes. */
  readonly postalCodes: readonly string[];
  readonly userIds: readonly string[];
}

export interface CatalogPipeline {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly stages: readonly { readonly id: string; readonly name: string; readonly archived: boolean }[];
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
  /** False until Milestone 9. */
  readonly paymentsAvailable: boolean;
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
  };
}

/** Name lookups used by messages; unknown ids read as a generic word. */
export function personName(catalogs: Pick<CalendarCatalogs, 'team'> | undefined, userId: string): string {
  return catalogs?.team.find((p) => p.userId === userId)?.name ?? 'Someone';
}

export function serviceName(catalogs: Pick<CalendarCatalogs, 'services'> | undefined, serviceId: string): string {
  return catalogs?.services.find((s) => s.id === serviceId)?.name ?? 'A service';
}

export function resourceName(catalogs: Pick<CalendarCatalogs, 'resources'> | undefined, resourceId: string): string {
  return catalogs?.resources.find((r) => r.id === resourceId)?.name ?? 'A resource';
}

/** First five digits of a US ZIP ('75201-1234' → '75201'), or null. */
export function zip5(postalCode: string | null | undefined): string | null {
  const digits = (postalCode ?? '').replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}
