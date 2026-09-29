/**
 * What has to move with an add-on, before anything moves. Turning one on needs everything it requires on first;
 * turning one off or uninstalling it needs everything that requires it off first. The owner decided (2026-09-28)
 * that HandsFreeOS never breaks a required dependency behind anyone's back: it shows what depends on it and offers
 * to move both. So a plan either lists the moves in order, or says which other add-ons the person has to agree to
 * move too, and the lifecycle commands refuse until they have (`include`).
 */
import type { CapabilityContext } from './capabilities';
import { addonRuns, effectiveStatus, installableHere } from './capabilities';
import type { Catalog } from './graph';
import {
  dependencyOrder,
  dependentClosure,
  findAddon,
  optionallyUsedBy,
  requirementClosure,
} from './graph';
import type { InstallationState, LifecycleAction } from './lifecycle';
import { isInstalledState, moveFor } from './lifecycle';
import type { AddonId } from './manifest';

/** One add-on's move within a plan. */
export interface PlannedMove {
  readonly addonId: AddonId;
  readonly action: LifecycleAction;
  readonly from: InstallationState | null;
  readonly to: InstallationState;
}

export type TransitionPlan =
  | {
      readonly kind: 'plan';
      readonly moves: readonly PlannedMove[];
      readonly optionalFor: AddonId[];
    }
  /** Nothing to do: it's already where it was asked to be. */
  | { readonly kind: 'already' }
  /** Other add-ons must move too; the person hasn't agreed to them yet. */
  | {
      readonly kind: 'needs';
      readonly rule: 'addon_needs' | 'addon_required_by';
      readonly addons: readonly AddonId[];
      readonly message: string;
    }
  | { readonly kind: 'refused'; readonly rule: string; readonly message: string };

const names = (catalog: Catalog, ids: readonly AddonId[]) =>
  ids.map((id) => findAddon(catalog, id)?.name ?? id).join(', ');

/**
 * Works out the moves for `action` on `addonId`, with the other add-ons the person agreed to move too (`include`).
 * Pure: the catalogue, the business's installations and any overrides are all it reads.
 */
export function planTransition(
  ctx: CapabilityContext,
  addonId: AddonId,
  action: LifecycleAction,
  include: readonly AddonId[] = [],
): TransitionPlan {
  const { catalog, installations } = ctx;
  const m = findAddon(catalog, addonId);
  const stateOf = (id: AddonId): InstallationState | null => installations[id] ?? null;
  const unknown: TransitionPlan = {
    kind: 'refused',
    rule: 'addon_unknown',
    message: 'HandsFreeOS has no add-on by that name. Pick one from Settings → Add-ons.',
  };
  // One this version of HandsFreeOS no longer has the code for (retired) can still leave a business that has it:
  // uninstalled, and its data deleted. Nothing turns it on or off again, and it goes by its id.
  const leaving = action === 'uninstall' || action === 'purge';
  if (!m && !(leaving && stateOf(addonId) !== null)) return unknown;
  const name = m?.name ?? addonId;
  const first = moveFor(stateOf(addonId), action);
  if (first.kind === 'refused') return first;
  if (first.kind === 'already') return { kind: 'already' };
  const agreed = new Set(include);

  if (action === 'install' || action === 'enable') {
    if (!m) return unknown;
    if (action === 'install' && !installableHere(ctx, addonId)) {
      const status = effectiveStatus(m, ctx.overrides);
      return {
        kind: 'refused',
        rule:
          m.billing.model === 'paid' && status === 'available'
            ? 'addon_needs_billing'
            : 'addon_not_available',
        message:
          status === 'planned'
            ? `${m.name} isn’t available yet.`
            : m.billing.model === 'paid' && status === 'available'
              ? `${m.name} is a paid add-on; HandsFreeOS support can turn it on for you.`
              : `${m.name} can’t be installed here.`,
      };
    }
    // Everything it needs that isn't running here yet: installed (and off) ones are turned on, the rest installed.
    // One already arriving is on its way, so nobody is asked about it; the worker brings this one on after it.
    const missing = requirementClosure(catalog, addonId).filter(
      (r) => !addonRuns(ctx, r) && stateOf(r) !== 'installing',
    );
    const unagreed = missing.filter((r) => !agreed.has(r));
    if (unagreed.length > 0)
      return {
        kind: 'needs',
        rule: 'addon_needs',
        addons: unagreed,
        message: `${m.name} needs ${names(catalog, unagreed)}. Turn ${unagreed.length > 1 ? 'them' : 'it'} on too?`,
      };
    const moves: PlannedMove[] = [];
    for (const r of dependencyOrder(catalog, missing)) {
      const from = stateOf(r);
      const how: LifecycleAction = isInstalledState(from) ? 'enable' : 'install';
      const mv = moveFor(from, how);
      if (mv.kind === 'refused') return mv;
      if (mv.kind === 'already') continue;
      if (how === 'install' && !installableHere(ctx, r))
        return {
          kind: 'refused',
          rule: 'addon_not_available',
          message: `${m.name} needs ${names(catalog, [r])}, which can’t be installed here.`,
        };
      moves.push({ addonId: r, action: how, from, to: mv.to });
    }
    moves.push({ addonId, action, from: stateOf(addonId), to: first.to });
    return { kind: 'plan', moves, optionalFor: [] };
  }

  if (action === 'disable' || action === 'uninstall') {
    // Whatever requires it and is running (or still arriving) stops too: turned off, never uninstalled.
    const dependents = dependentClosure(catalog, addonId).filter((d) => {
      const s = stateOf(d);
      return s === 'enabled' || s === 'installing';
    });
    const unagreed = dependents.filter((d) => !agreed.has(d));
    if (unagreed.length > 0)
      return {
        kind: 'needs',
        rule: 'addon_required_by',
        addons: unagreed,
        message: `${names(catalog, unagreed)} ${unagreed.length > 1 ? 'need' : 'needs'} ${name}. Turn ${unagreed.length > 1 ? 'them' : 'it'} off too?`,
      };
    // Dependents first, the ones that need the most last-in first-out: reverse of the order things were needed.
    const moves: PlannedMove[] = dependencyOrder(catalog, dependents)
      .reverse()
      .map((d) => ({
        addonId: d,
        action: 'disable' as const,
        from: stateOf(d),
        to: 'disabled' as const,
      }));
    moves.push({ addonId, action, from: stateOf(addonId), to: first.to });
    const optionalFor = optionallyUsedBy(catalog, addonId).filter((o) => addonRuns(ctx, o));
    return { kind: 'plan', moves, optionalFor };
  }

  // purge: it's uninstalled already, so nothing running can need it.
  return {
    kind: 'plan',
    moves: [{ addonId, action, from: stateOf(addonId), to: first.to }],
    optionalFor: [],
  };
}
