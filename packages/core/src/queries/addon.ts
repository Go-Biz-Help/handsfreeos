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
import { capabilitySets } from '../addons/capabilities';
import { findAddon, type Catalog } from '../addons/graph';
import { capabilityContextOf, loadInstallations, loadOverrides } from '../addons/load';
import { planTransition } from '../addons/plan';
import { suggestAddon, type SuggestionChoice } from '../addons/suggest';
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
      'The add-ons this business has and where each stands, and what you can do here now; for people who manage add-ons, what could be added and what is planned.',
    input: AddonListInput,
    output: AddonListOutput,
    permission: 'workspace.read',
    scope,
    async handler(ctx, input) {
      const [installations, overrides] = await Promise.all([
        loadInstallations(ctx.tx, input.workspaceId),
        loadOverrides(ctx.tx),
      ]);
      const permissions = ctx.scope.workspacePermissions ?? [];
      const sets = capabilitySets(
        capabilityContextOf(catalog, installations, overrides, permissions),
      );
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
            failedChecks: failedChecks(i.verification),
            retired: !m,
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
              .filter((m) => ['available', 'planned'].includes(overrides[m.id] ?? m.catalog.status))
              .map((m) => ({
                addonId: m.id,
                name: m.name,
                summary: m.summary,
                category: m.category,
                status: overrides[m.id] ?? m.catalog.status,
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
      const m = findAddon(catalog, input.addonId);
      if (!m) throw HfosError.notFound('There is no such add-on.');
      const [installations, overrides, counts] = await Promise.all([
        loadInstallations(ctx.tx, input.workspaceId),
        loadOverrides(ctx.tx),
        rows<{
          records: string;
          relationships: string;
          pending_jobs: string;
          held_resources: string;
          owned_rows: string;
          usage_events: string;
        }>(
          ctx.tx,
          sql`select * from private.addon_impact_counts(${input.workspaceId}::uuid, ${m.id})`,
        ),
      ]);
      const cctx = capabilityContextOf(
        catalog,
        installations,
        overrides,
        ctx.scope.workspacePermissions ?? [],
      );
      const first = planTransition(cctx, m.id, input.action);
      // With every add-on it asks about agreed to, so the plan shown is the one that would run after "yes".
      const plan =
        first.kind === 'needs' ? planTransition(cctx, m.id, input.action, first.addons) : first;
      const name = (id: string) => findAddon(catalog, id)?.name ?? id;
      const moving = plan.kind === 'plan' ? plan.moves : [];
      const stopping = new Set(
        moving
          .filter((mv) => mv.action === 'disable' || mv.action === 'uninstall')
          .map((mv) => mv.addonId),
      );
      const c = counts[0];
      return {
        addonId: m.id,
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
        capabilitiesLost: catalog
          .filter((a) => stopping.has(a.id))
          .flatMap((a) => a.capabilities.map((cap) => ({ id: cap.id, label: cap.label }))),
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
      if (!m) throw HfosError.notFound('There is no such add-on.');
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
      if (!business) throw HfosError.notFound();
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
