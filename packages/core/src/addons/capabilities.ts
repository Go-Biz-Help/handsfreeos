/**
 * What a business can do, worked out in code rather than left to the AI's prompt. Three sets that never mix:
 *
 * - **current**: what this person can do here now (core, and add-ons that are on, where they hold the permission);
 * - **installable**: what the business could do with an add-on that is `available` and not installed;
 * - **planned**: what is on the roadmap. Never installable, never recommended.
 *
 * Plus two that make honest answers possible: **restricted** (on here, but this person lacks the permission: "ask an
 * admin") and **turnedOff** (installed, but off: "an admin can turn it back on"). The screens, `find_capabilities`
 * and the recommendation rules all read these sets, so what the AI may suggest is decided here, not by its wording.
 */
import type { Catalog } from './graph';
import { findAddon, requirementClosure } from './graph';
import type { InstallationState } from './lifecycle';
import { isActiveState, isInstalledState } from './lifecycle';
import type {
  AddonId,
  AddonManifest,
  CapabilityId,
  CatalogStatus,
  CoreFeature,
  OverrideStatus,
} from './manifest';

/** Something HandsFreeOS itself does, always there, described for discovery. */
export interface CoreCapability {
  readonly id: CapabilityId;
  readonly label: string;
  readonly description: string;
  readonly permission?: string;
  /** A part of core only some add-ons use: there only while one of them is on (`coreFeatureOn`). */
  readonly feature?: CoreFeature;
}

/**
 * What core does, in the words the AI matches requests against. Core's features are always on; this list only
 * describes them, so "what can this business do?" has one answer that covers core and add-ons alike. Its first
 * segments are reserved: no add-on may take `crm`, `inbox`, … as its id.
 */
export const CORE_CAPABILITIES: readonly CoreCapability[] = [
  {
    id: 'crm.contacts',
    label: 'Customers and companies',
    description:
      'Keep customers and the companies they work for, with their details, tags, notes, files and timeline.',
    permission: 'records.read',
  },
  {
    id: 'crm.leads',
    label: 'Leads and pipelines',
    description:
      'Track deals through your own pipeline stages, with next steps and who is on each one.',
    permission: 'records.read',
  },
  {
    id: 'crm.tasks',
    label: 'Tasks',
    description: 'Tasks with due dates and owners, on a customer, a lead or any record.',
    permission: 'records.read',
  },
  {
    id: 'crm.records',
    label: 'Your own kinds of records',
    description:
      'Keep pets, vehicles, properties, equipment or anything else you name, and connect any two records.',
    permission: 'records.read',
  },
  {
    id: 'crm.import',
    label: 'Imports',
    description: 'Bring customers in from a spreadsheet or from another CRM.',
    permission: 'records.import',
  },
  {
    id: 'inbox.messaging',
    label: 'Texting, email and website chat',
    description:
      'One shared inbox for texts, email and website chat, on the business’s own number.',
    permission: 'inbox.use',
  },
  {
    id: 'inbox.calls',
    label: 'Calls',
    description: 'Calls to and from the business number, recorded on the customer’s timeline.',
    permission: 'inbox.use',
  },
  {
    id: 'calendar.appointments',
    label: 'Calendar and appointments',
    description: 'Book, move and cancel visits on personal, team, service and resource calendars.',
    permission: 'appointments.write',
  },
  {
    id: 'calendar.booking',
    label: 'Online booking',
    description: 'Booking pages customers book themselves on, with deposits when asked.',
    permission: 'calendars.manage',
  },
  {
    id: 'money.invoices',
    label: 'Estimates, invoices and payments',
    description:
      'Quote, bill and take payment through the business’s own Stripe or Square account, with reminders.',
    permission: 'money.read',
  },
  {
    id: 'money.plans',
    label: 'Maintenance plans',
    description: 'Plans that bill customers on a schedule.',
    permission: 'money.read',
  },
  {
    id: 'marketing.campaigns',
    label: 'Campaigns',
    description: 'Email, text and call campaigns to a list of customers.',
    permission: 'workflows.manage',
  },
  {
    id: 'marketing.reviews',
    label: 'Reviews',
    description: 'Ask customers for reviews and answer the reviews they leave.',
    permission: 'reviews.manage',
  },
  {
    id: 'forms.forms',
    label: 'Forms and surveys',
    description: 'Forms, surveys and quizzes customers fill in, on the business’s site or by link.',
    permission: 'forms.manage',
  },
  {
    id: 'automation.workflows',
    label: 'Workflows',
    description: 'Automatic follow-ups and steps that run on their own when something happens.',
    permission: 'workflows.manage',
  },
  {
    id: 'automation.action_center',
    label: 'Action Center',
    description:
      'One ranked list of what needs attention, with the safe items handled automatically.',
  },
  {
    id: 'ai.assistant',
    label: 'The Assistant',
    description: 'Ask questions about the business and get work done in plain words.',
    permission: 'assistant.use',
  },
  {
    id: 'ai.teammate',
    label: 'AI teammate',
    description:
      'An AI that answers customers by text, email and chat, qualifies them and books them.',
    permission: 'ai_team.manage',
  },
  {
    id: 'knowledge.base',
    label: 'Knowledge base',
    description: 'What the AI answers from: services, prices, policies and documents.',
    permission: 'knowledge.manage',
  },
  {
    id: 'sales.main_offer',
    label: 'Main offer',
    description:
      'The business’s main offer: who it helps, the result, how fast, how, the guarantee and the price, built and scored with the AI.',
    permission: 'workspace.read',
    feature: 'main_offer',
  },
];

/** The first segments of core's capability ids. No add-on may use one as its id. */
export const CORE_CAPABILITY_DOMAINS: ReadonlySet<string> = new Set(
  CORE_CAPABILITIES.map((c) => c.id.split('.')[0] ?? ''),
);

/** One capability as the sets list it: what it is and who provides it. */
export interface CapabilityView {
  readonly id: CapabilityId;
  readonly label: string;
  readonly description: string;
  readonly provider: 'core' | AddonId;
  /** "HandsFreeOS" for core, else the add-on's name. */
  readonly providerName: string;
}

export interface CapabilitySets {
  readonly current: readonly CapabilityView[];
  readonly restricted: readonly CapabilityView[];
  readonly turnedOff: readonly CapabilityView[];
  readonly installable: readonly CapabilityView[];
  readonly planned: readonly CapabilityView[];
}

/** What the sets are worked out from. All of it is at hand wherever they're needed (a query, the Assistant). */
export interface CapabilityContext {
  readonly catalog: Catalog;
  /** Each add-on's state in this business; absent means never installed. */
  readonly installations: Readonly<Record<AddonId, InstallationState>>;
  /** Staff overrides from `platform.addon_overrides`, which only ever take an add-on down. */
  readonly overrides?: Readonly<Record<AddonId, OverrideStatus>>;
  /**
   * Add-ons still being built that HandsFreeOS handed this business to try (`platform.addon_grants`): installable
   * here as if they were available.
   */
  readonly grants?: readonly AddonId[];
  /**
   * The person's permissions here, which hold an add-on's permissions only while it is on. Null for the system,
   * a workflow or the AI teammate, which act within the business without a person's permissions.
   */
  readonly permissions: readonly string[] | null;
}

/** An add-on's status once any staff override is applied: an override can only take it down. */
export function effectiveStatus(
  m: AddonManifest,
  overrides?: Readonly<Record<AddonId, OverrideStatus>>,
): CatalogStatus {
  return overrides?.[m.id] ?? m.catalog.status;
}

/** Whether an add-on in this state runs here, with the kill switch applied. */
export function addonRuns(ctx: CapabilityContext, id: AddonId): boolean {
  const m = findAddon(ctx.catalog, id);
  if (!m) return false;
  return (
    isActiveState(ctx.installations[id]) && effectiveStatus(m, ctx.overrides) !== 'unavailable'
  );
}

/** Statuses a staff grant can hand out: still being built, or available (a paid one, before billing exists). */
const GRANTABLE: ReadonlySet<CatalogStatus> = new Set([
  'development',
  'beta',
  'built',
  'available',
]);

/**
 * Whether HandsFreeOS offers this add-on to this business: available and free (paid ones need billing, which doesn't
 * exist yet), or handed to it by staff to try (a grant), whatever it costs.
 */
function offeredHere(ctx: CapabilityContext, m: AddonManifest): boolean {
  const status = effectiveStatus(m, ctx.overrides);
  if (ctx.grants?.includes(m.id) && GRANTABLE.has(status)) return true;
  return status === 'available' && m.billing.model === 'free';
}

/** Whether staff handed this add-on to this business to try (and it isn't switched off or deprecated since). */
export function grantedHere(ctx: CapabilityContext, id: AddonId): boolean {
  const m = findAddon(ctx.catalog, id);
  return !!m && !!ctx.grants?.includes(id) && GRANTABLE.has(effectiveStatus(m, ctx.overrides));
}

/**
 * Whether a business could install this add-on on its own now: offered here (available and free, or handed to it by
 * staff), not already installed, and every add-on it requires is on here or could be installed with it.
 */
export function installableHere(ctx: CapabilityContext, id: AddonId): boolean {
  const m = findAddon(ctx.catalog, id);
  if (!m || !offeredHere(ctx, m)) return false;
  if (isInstalledState(ctx.installations[id])) return false;
  return requirementClosure(ctx.catalog, id).every((r) => {
    if (addonRuns(ctx, r)) return true;
    const req = findAddon(ctx.catalog, r);
    if (!req) return false;
    const status = effectiveStatus(req, ctx.overrides);
    const state = ctx.installations[r];
    // Installed but off: it can be turned back on with this one, unless HandsFreeOS switched it off.
    if (state === 'disabled') return status !== 'unavailable';
    if (state === 'installing') return true;
    // On its way out: it has to finish going before anything can rely on it again.
    if (isInstalledState(state)) return false;
    return offeredHere(ctx, req);
  });
}

const holds = (ctx: CapabilityContext, permission: string | undefined): boolean =>
  !permission || ctx.permissions === null || ctx.permissions.includes(permission);

/** Whether a part of core only some add-ons use is here: one that uses it runs in this business. */
export function coreFeatureOn(ctx: CapabilityContext, feature: CoreFeature): boolean {
  return ctx.catalog.some((m) => m.uses?.includes(feature) && addonRuns(ctx, m.id));
}

/**
 * The same from the add-ons running (`loadActiveAddons`, `workspace.addons`), which already has HandsFreeOS's switches
 * applied: for the kernel's refusal and the screens.
 */
export function coreFeatureRunning(
  catalog: Catalog,
  running: readonly AddonId[],
  feature: CoreFeature,
): boolean {
  return catalog.some((m) => m.uses?.includes(feature) && running.includes(m.id));
}

/**
 * The same from a person's own permissions, for the phone with no signal: an add-on that uses the part of core runs
 * here, and they hold one of its permissions. An add-on's permissions are only in the list while it runs
 * (`private.permissions_for`), so the list answers both.
 */
export function coreFeatureHeld(
  catalog: Catalog,
  permissions: readonly string[],
  feature: CoreFeature,
): boolean {
  return catalog.some(
    (m) => m.uses?.includes(feature) && m.permissions.some((p) => permissions.includes(p.key)),
  );
}

/** The add-ons that bring a part of core, by name, for the words when it isn't here ("Social Outreach"). */
export function addonsUsing(catalog: Catalog, feature: CoreFeature): string[] {
  return catalog
    .filter((m) => m.uses?.includes(feature) && m.catalog.status !== 'planned')
    .map((m) => m.name);
}

/** Every capability, sorted into the five sets. Deterministic: core first, then the catalogue's order. */
export function capabilitySets(ctx: CapabilityContext): CapabilitySets {
  const current: CapabilityView[] = [];
  const restricted: CapabilityView[] = [];
  const turnedOff: CapabilityView[] = [];
  const installable: CapabilityView[] = [];
  const planned: CapabilityView[] = [];
  for (const c of CORE_CAPABILITIES) {
    // A part of core only some add-ons use isn't this business's to see without one of them.
    if (c.feature && !coreFeatureOn(ctx, c.feature)) continue;
    const view: CapabilityView = {
      id: c.id,
      label: c.label,
      description: c.description,
      provider: 'core',
      providerName: 'HandsFreeOS',
    };
    (holds(ctx, c.permission) ? current : restricted).push(view);
  }
  for (const m of ctx.catalog) {
    const status = effectiveStatus(m, ctx.overrides);
    const state = ctx.installations[m.id];
    const views = m.capabilities.map((c): CapabilityView => ({
      id: c.id,
      label: c.label,
      description: c.description,
      provider: m.id,
      providerName: m.name,
    }));
    if (addonRuns(ctx, m.id)) {
      m.capabilities.forEach((c, i) =>
        (holds(ctx, c.permission) ? current : restricted).push(views[i]!),
      );
    } else if (isInstalledState(state)) {
      // Installed, but off, still arriving, on its way out, or switched off by HandsFreeOS.
      turnedOff.push(...views);
    } else if (status === 'planned') {
      planned.push(...views);
    } else if (installableHere(ctx, m.id)) {
      installable.push(...views);
    }
    // Anything else (in development, beta, built, deprecated, unavailable and not installed here) is not for this
    // business to see at all.
  }
  return { current, restricted, turnedOff, installable, planned };
}

export type CanUse =
  | { readonly ok: true; readonly provider: 'core' | AddonId }
  | {
      readonly ok: false;
      readonly reason: 'no_permission' | 'turned_off' | 'not_installed' | 'planned' | 'unknown';
      readonly provider?: AddonId;
    };

/**
 * `workspace.can('social.publish')`: whether this person can use a capability here now, and if not, why. The kernel
 * enforces the same thing on every operation; this is for deciding what to show and what to say.
 */
export function canUse(ctx: CapabilityContext, id: CapabilityId): CanUse {
  const core = CORE_CAPABILITIES.find((c) => c.id === id);
  if (core?.feature && !coreFeatureOn(ctx, core.feature))
    return { ok: false, reason: 'not_installed' };
  if (core)
    return holds(ctx, core.permission)
      ? { ok: true, provider: 'core' }
      : { ok: false, reason: 'no_permission' };
  const m = ctx.catalog.find((a) => a.capabilities.some((c) => c.id === id));
  const cap = m?.capabilities.find((c) => c.id === id);
  if (!m || !cap) return { ok: false, reason: 'unknown' };
  if (addonRuns(ctx, m.id))
    return holds(ctx, cap.permission)
      ? { ok: true, provider: m.id }
      : { ok: false, reason: 'no_permission', provider: m.id };
  if (isInstalledState(ctx.installations[m.id]))
    return { ok: false, reason: 'turned_off', provider: m.id };
  if (effectiveStatus(m, ctx.overrides) === 'planned')
    return { ok: false, reason: 'planned', provider: m.id };
  return { ok: false, reason: 'not_installed', provider: m.id };
}

/** The ids of what this person can use now: what `account.me` and `workspace.get` hand the screens. */
export const currentCapabilityIds = (ctx: CapabilityContext): CapabilityId[] =>
  capabilitySets(ctx).current.map((c) => c.id);
