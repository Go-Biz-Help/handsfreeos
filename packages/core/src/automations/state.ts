/**
 * Where each automation stands for one business: on or off, and whether it needs something set up first. Pure
 * and browser-safe; the page renders from it and its switches write back through `automationPatch`.
 */
import { emptyTeammateConfig } from '../ai-team/config';
import type { AttentionSettings } from '../attention/settings';
import type { TeammateStatus } from '../schemas/ai-team';
import {
  AUTOMATIONS,
  type AutomationDef,
  type AutomationId,
  type TeammateSwitchPath,
} from './catalog';
import type { AutomationSettings } from './settings';

/** The AI teammate's side, as the page has it: null when the business has never set one up. */
export interface TeammateView {
  readonly status: TeammateStatus;
  /** Its settings with every default filled (the teammate query's `config`). */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface AutomationContext {
  readonly attention: AttentionSettings;
  readonly automations: AutomationSettings;
  readonly teammate: TeammateView | null;
}

export interface NeedsSetup {
  readonly code: 'teammate_on' | 'intake_form';
  /** One sentence the row shows under its title. */
  readonly text: string;
}

export interface AutomationRow {
  readonly def: AutomationDef;
  /** The switch: what the business chose. */
  readonly on: boolean;
  /** On, and nothing it needs is missing: it is actually doing its job. */
  readonly working: boolean;
  readonly locked: boolean;
  readonly needsSetup: NeedsSetup | null;
  /** Its messages wait for approval right now (the AI teammate is still training). */
  readonly drafts: boolean;
  /** Its wording must be read in Adjust before the switch can go on. */
  readonly awaitingReview: boolean;
  /** What it does instead while there is no AI teammate (the catalog's `withoutTeammate`), or null. */
  readonly fallback: string | null;
}

const readPath = (doc: Readonly<Record<string, unknown>>, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (at, key) =>
        typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[key] : undefined,
      doc,
    );

let teammateDefaults: Readonly<Record<string, unknown>> | null = null;

/** A teammate skill's switch, with the teammate settings' own default when it isn't set. */
export function teammateSwitchOn(
  config: Readonly<Record<string, unknown>>,
  path: TeammateSwitchPath,
): boolean {
  const value = readPath(config, path);
  if (typeof value === 'boolean') return value;
  teammateDefaults ??= emptyTeammateConfig() as unknown as Record<string, unknown>;
  return readPath(teammateDefaults, path) === true;
}

/** Whether a row's switch is on, read from wherever it lives. */
export function automationOnIn(def: AutomationDef, ctx: AutomationContext): boolean {
  if (def.locked) return true;
  const b = def.binding;
  switch (b.store) {
    case 'attention_kind':
      return b.kinds.every((k) => ctx.attention.kinds[k]);
    case 'automations':
      return ctx.automations.switches[b.key];
    case 'teammate':
      // No teammate yet: what one starts with, so the row doesn't change the moment it's set up.
      return teammateSwitchOn(ctx.teammate?.config ?? {}, b.path);
  }
}

function needsSetupOf(def: AutomationDef, ctx: AutomationContext): NeedsSetup | null {
  for (const need of def.needs) {
    if (need === 'teammate_on' && (!ctx.teammate || ctx.teammate.status === 'off'))
      return {
        code: 'teammate_on',
        text: ctx.teammate
          ? 'Turn on your AI teammate to start.'
          : 'Set up your AI teammate to start.',
      };
    if (need === 'intake_form' && ctx.automations.intake.formId === null)
      return { code: 'intake_form', text: 'Pick a form to start.' };
  }
  return null;
}

/** When a review-first row's wording was read, or null. */
function reviewedAtOf(def: AutomationDef, ctx: AutomationContext): string | null {
  return def.id === 'reengage_dead_leads' ? ctx.automations.reengage.reviewedAt : null;
}

/** One row. */
export function automationRow(def: AutomationDef, ctx: AutomationContext): AutomationRow {
  const on = automationOnIn(def, ctx);
  const needsSetup = needsSetupOf(def, ctx);
  return {
    def,
    on,
    working: on && needsSetup === null,
    locked: def.locked === true,
    needsSetup,
    drafts: def.customerFacing === 'ai' && ctx.teammate?.status === 'training',
    fallback:
      def.withoutTeammate && (!ctx.teammate || ctx.teammate.status === 'off')
        ? def.withoutTeammate
        : null,
    awaitingReview: def.reviewFirst === true && reviewedAtOf(def, ctx) === null,
  };
}

/** Every row, in the catalog's order. */
export function automationRows(ctx: AutomationContext): readonly AutomationRow[] {
  return AUTOMATIONS.map((def) => automationRow(def, ctx));
}

/**
 * For the page's header ("14 of 16 are working. 2 need something set up first."): `working` counts only rows that
 * are on and have what they need; `needsSetup` the ones switched on that are still waiting on something.
 */
export function automationCounts(rows: readonly AutomationRow[]): {
  working: number;
  needsSetup: number;
  total: number;
} {
  return {
    working: rows.filter((r) => r.working).length,
    needsSetup: rows.filter((r) => r.on && r.needsSetup !== null).length,
    total: rows.length,
  };
}

/**
 * The change a switch makes, for the store it lives in. The page sends each through that store's own command
 * (attention.save_settings, automations.save_settings, ai_teammate.save_config), so everything that already
 * listens to those still hears it.
 */
export type AutomationPatch =
  | { readonly store: 'attention'; readonly settings: AttentionSettings }
  | { readonly store: 'automations'; readonly settings: AutomationSettings }
  | { readonly store: 'teammate'; readonly config: Record<string, unknown> };

const writePath = (
  doc: Readonly<Record<string, unknown>>,
  path: string,
  value: unknown,
): Record<string, unknown> => {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  if (rest.length === 0) return { ...doc, [head]: value };
  const inner = doc[head];
  return {
    ...doc,
    [head]: writePath(
      typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : {},
      rest.join('.'),
      value,
    ),
  };
};

/** The patch that turns one automation on or off. Null when it can't be (locked, or no teammate to write to). */
export function automationPatch(
  id: AutomationId,
  on: boolean,
  ctx: AutomationContext,
): AutomationPatch | null {
  const def = AUTOMATIONS.find((a) => a.id === id) as AutomationDef | undefined;
  if (!def || def.locked) return null;
  // Turning on waits for the wording to be read; turning off never does.
  if (on && def.reviewFirst && reviewedAtOf(def, ctx) === null) return null;
  const b = def.binding;
  switch (b.store) {
    case 'attention_kind': {
      const kinds = { ...ctx.attention.kinds };
      for (const k of b.kinds) (kinds as Record<string, boolean>)[k] = on;
      return { store: 'attention', settings: { ...ctx.attention, kinds } };
    }
    case 'automations':
      return {
        store: 'automations',
        settings: {
          ...ctx.automations,
          switches: { ...ctx.automations.switches, [b.key]: on },
        },
      };
    case 'teammate':
      if (!ctx.teammate) return null;
      return {
        store: 'teammate',
        config: writePath(ctx.teammate.config, b.path, on),
      };
  }
}
