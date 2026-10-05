/**
 * What a business has and could have, what changing an add-on would touch, and an add-on's settings (0108,
 * docs/addon-architecture.md). Made by a factory over a catalogue, like the lifecycle commands.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  addonSuggestionDismissals,
  addonUserSettings,
  customRecordTypes,
  workspaces,
} from '@hfos/db/schema';
import { addonRuns, capabilitySets, grantedHere } from '../addons/capabilities';
import { findAddon, type Catalog } from '../addons/graph';
import {
  capabilityContextOf,
  loadGrants,
  loadInstallations,
  loadKept,
  loadOverrides,
} from '../addons/load';
import { planTransition } from '../addons/plan';
import { suggestAddon, type SuggestionChoice } from '../addons/suggest';
import { addonDataHeldMessage } from '../addons/words';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import {
  AddonImpactInput,
  AddonImpactOutput,
  AddonListInput,
  AddonListOutput,
  AddonSettingsInput,
  AddonSettingsOutput,
  AddonSuggestionInput,
  AddonSuggestionOutput,
} from '../schemas/addon';

/** The checks that failed when the worker last looked, from what it stored on the installation. */
function failedChecks(verification: Record<string, unknown> | null): string[] {
  const checks = (verification?.['checks'] ?? []) as { name?: unknown; ok?: unknown }[];
  return Array.isArray(checks)
    ? checks
        .filter((c) => c.ok === false && typeof c.name === 'string')
        .map((c) => c.name as string)
    : [];
}

/** The add-on queries, over a catalogue. */
export function addonQueries(catalog: Catalog) {
  const scope = (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  });

  const list = defineQuery({
    name: 'addon.list',
    description:
      'The add-ons this business has and where each stands, and what you can do here now; for people who manage add-ons, what could be added. What is planned and coming soon is addon.roadmap.',
    input: AddonListInput,
    output: AddonListOutput,
    permission: 'workspace.read',
    scope,
    async handler(ctx, input) {
      const [installations, overrides, grants] = await Promise.all([
        loadInstallations(ctx.tx, input.workspaceId),
        loadOverrides(ctx.tx),
        loadGrants(ctx.tx, input.workspaceId),
      ]);
      const permissions = ctx.scope.workspacePermissions ?? [];
      const cctx = capabilityContextOf(catalog, installations, overrides, permissions, grants);
      const sets = capabilitySets(cctx);
      // Suggestions only ever reach people who could act on them (the owner's decision, 2026-09-28).
      const manages = permissions.includes('addons.manage');
      return {
        installed: installations.map((i) => {
          const m = findAddon(catalog, i.addonId);
          return {
            addonId: i.addonId,
            name: m?.name ?? i.addonId,
            summary: m?.summary ?? '',
            state: i.state,
            installedVersion: i.installedVersion,
            latestVersion: m?.version ?? null,
            generation: i.generation,
            changedAt: i.changedAt.toISOString(),
            lastError: i.lastError,
            // Only while there's trouble: a person's move clears it at once, while the checks stored for the move
            // before stay until the worker looks again.
            failedChecks: i.lastError ? failedChecks(i.verification) : [],
            retired: !m,
            status: m ? (overrides[m.id] ?? m.catalog.status) : null,
            running: addonRuns(cctx, i.addonId),
          };
        }),
        capabilities: {
          current: [...sets.current],
          restricted: [...sets.restricted],
          turnedOff: [...sets.turnedOff],
          installable: manages ? [...sets.installable] : [],
          planned: manages ? [...sets.planned] : [],
        },
        catalog: manages
          ? catalog
              .filter(
                (m) =>
                  (overrides[m.id] ?? m.catalog.status) === 'available' || grantedHere(cctx, m.id),
              )
              .map((m) => ({
                addonId: m.id,
                name: m.name,
                summary: m.summary,
                category: m.category,
                status: overrides[m.id] ?? m.catalog.status,
                testing: grantedHere(cctx, m.id),
              }))
          : [],
      };
    },
  });

  const impact = defineQuery({
    name: 'addon.impact',
    description:
      'Before changing an add-on: every add-on that would move with it (and the one question to ask), who loses features, and what it holds here.',
    input: AddonImpactInput,
    output: AddonImpactOutput,
    permission: 'addons.manage',
    scope,
    async handler(ctx, input) {
      const [installations, overrides, grants, kept, counts] = await Promise.all([
        loadInstallations(ctx.tx, input.workspaceId),
        loadOverrides(ctx.tx),
        loadGrants(ctx.tx, input.workspaceId),
        loadKept(ctx.tx, input.workspaceId, input.addonId),
        rows<{
          records: string;
          relationships: string;
          pending_jobs: string;
          held_resources: string;
          owned_rows: string;
          usage_events: string;
        }>(
          ctx.tx,
          sql`select * from private.addon_impact_counts(${input.workspaceId}::uuid, ${input.addonId})`,
        ),
      ]);
      // One this version of HandsFreeOS has, or a retired one this business still has (it can only leave).
      if (
        !findAddon(catalog, input.addonId) &&
        !installations.some((i) => i.addonId === input.addonId)
      )
        throw HfosError.notFound(
          'That add-on isn’t offered anymore. See the ones you can use in Settings → Add-ons.',
        );
      const cctx = capabilityContextOf(
        catalog,
        installations,
        overrides,
        ctx.scope.workspacePermissions ?? [],
        grants,
      );
      const first = planTransition(cctx, input.addonId, input.action);
      const name = (id: string) => findAddon(catalog, id)?.name ?? id;
      // Records the business holds keep its data (round six): said before anyone types the name.
      const held =
        input.action === 'purge' ? addonDataHeldMessage(name(input.addonId), kept) : null;
      // With every add-on it asks about agreed to, so the plan shown is the one that would run after "yes".
      const planned =
        first.kind === 'needs'
          ? planTransition(cctx, input.addonId, input.action, first.addons)
          : first;
      const plan =
        held && planned.kind === 'plan'
          ? { kind: 'refused' as const, rule: 'addon_data_held', message: held }
          : planned;
      const moving = plan.kind === 'plan' ? plan.moves : [];
      const stopping = new Set(
        moving
          .filter((mv) => mv.action === 'disable' || mv.action === 'uninstall')
          .map((mv) => mv.addonId),
      );
      const c = counts[0];
      return {
        addonId: input.addonId,
        action: input.action,
        outcome: (plan.kind === 'already'
          ? 'already'
          : plan.kind === 'plan'
            ? 'plan'
            : 'refused') as 'already' | 'plan' | 'refused',
        moves: moving.map((mv) => ({
          addonId: mv.addonId,
          action: mv.action,
          name: name(mv.addonId),
        })),
        needsAgreement: first.kind === 'needs' ? [...first.addons] : [],
        question: first.kind === 'needs' ? first.message : null,
        refusal:
          plan.kind === 'refused'
            ? { rule: plan.rule, message: plan.message }
            : plan.kind === 'needs'
              ? { rule: plan.rule, message: plan.message }
              : null,
        optionalFor: (plan.kind === 'plan' ? plan.optionalFor : []).map((id) => ({
          addonId: id,
          name: name(id),
        })),
        // Only what works now: one already off, or switched off by HandsFreeOS, stops nothing more.
        capabilitiesLost: catalog
          .filter((a) => stopping.has(a.id) && addonRuns(cctx, a.id))
          .flatMap((a) => a.capabilities.map((cap) => ({ id: cap.id, label: cap.label }))),
        kept: kept.records > 0 ? kept : null,
        holds: {
          records: Number(c?.records ?? 0),
          relationships: Number(c?.relationships ?? 0),
          pendingJobs: Number(c?.pending_jobs ?? 0),
          heldResources: Number(c?.held_resources ?? 0),
          ownRows: Number(c?.owned_rows ?? 0),
          usageEvents: Number(c?.usage_events ?? 0),
        },
      };
    },
  });

  const settings = defineQuery({
    name: 'addon.settings',
    description: 'An add-on’s settings here, and your own settings for it.',
    input: AddonSettingsInput,
    output: AddonSettingsOutput,
    permission: 'workspace.read',
    scope,
    async handler(ctx, input) {
      const m = findAddon(catalog, input.addonId);
      if (!m)
        throw HfosError.notFound(
          'That add-on isn’t offered anymore. See the ones you can use in Settings → Add-ons.',
        );
      const installations = await loadInstallations(ctx.tx, input.workspaceId);
      const mine = installations.find((i) => i.addonId === m.id);
      // Hidden until it's back on (the owner's decision, 2026-09-28).
      if (mine?.state !== 'enabled') throw HfosError.addonInactive(m);
      const permission = m.settings?.permission ?? 'addons.manage';
      const sees = (ctx.scope.workspacePermissions ?? []).includes(permission);
      const [own] = await ctx.tx
        .select({ settings: addonUserSettings.settings })
        .from(addonUserSettings)
        .where(
          and(
            eq(addonUserSettings.workspaceId, input.workspaceId),
            eq(addonUserSettings.userId, requireHuman(ctx).userId),
            eq(addonUserSettings.addonId, m.id),
          ),
        );
      return {
        addonId: m.id,
        settings: sees ? mine.settings : null,
        flags: sees
          ? Object.fromEntries(
              Object.entries(m.settings?.flags ?? {}).map(([k, f]) => [
                k,
                mine.flags[k] ?? f.default,
              ]),
            )
          : null,
        mySettings: own?.settings ?? {},
      };
    },
  });

  const suggestion = defineQuery({
    name: 'addon.suggestion',
    description:
      'The one add-on Home may suggest to you now, if any: only to people who may add add-ons, only one that fits what the business does, and never soon after one was set aside.',
    input: AddonSuggestionInput,
    output: AddonSuggestionOutput,
    permission: 'workspace.read',
    scope,
    async handler(ctx, input) {
      const permissions = ctx.scope.workspacePermissions ?? [];
      // Nobody else ever hears of one, and it costs them nothing to ask.
      if (!permissions.includes('addons.manage')) return { suggestion: null };
      const me = requireHuman(ctx).userId;
      const [installations, overrides, [business], kinds, dismissed] = await Promise.all([
        loadInstallations(ctx.tx, input.workspaceId),
        loadOverrides(ctx.tx),
        ctx.tx
          .select({ name: workspaces.name, industry: workspaces.industry })
          .from(workspaces)
          .where(eq(workspaces.id, input.workspaceId)),
        // The kinds of records it made for itself, not an add-on's.
        ctx.tx
          .select({ singular: customRecordTypes.singular, plural: customRecordTypes.plural })
          .from(customRecordTypes)
          .where(
            and(
              eq(customRecordTypes.workspaceId, input.workspaceId),
              isNull(customRecordTypes.addonId),
              isNull(customRecordTypes.archivedAt),
            ),
          ),
        ctx.tx
          .select({
            addonId: addonSuggestionDismissals.addonId,
            choice: addonSuggestionDismissals.choice,
            decidedAt: addonSuggestionDismissals.decidedAt,
          })
          .from(addonSuggestionDismissals)
          .where(
            and(
              eq(addonSuggestionDismissals.workspaceId, input.workspaceId),
              eq(addonSuggestionDismissals.userId, me),
            ),
          ),
      ]);
      if (!business)
        throw HfosError.notFound(
          'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
        );
      const found = suggestAddon(
        capabilityContextOf(catalog, installations, overrides, permissions),
        {
          name: business.name,
          industry: business.industry,
          recordKinds: kinds.flatMap((k) => [k.singular, k.plural]),
        },
        dismissed.map((d) => ({ ...d, choice: d.choice as SuggestionChoice })),
        Date.now(),
      );
      return { suggestion: found ? { ...found, does: [...found.does] } : null };
    },
  });

  return { list, impact, settings, suggestion };
}
