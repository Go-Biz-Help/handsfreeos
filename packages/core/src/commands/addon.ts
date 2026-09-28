/**
 * Installing, turning on and off, uninstalling and permanently deleting an add-on's data, and saving its settings
 * (0108, docs/addon-architecture.md).
 *
 * Each move is planned first from the catalogue (`planTransition`): an add-on can't be installed unless it is
 * available here, and a move that would break a required dependency is refused with the other add-ons to ask about
 * (`addon_needs`, `addon_required_by`) until the person agrees to move them too (`include`) — the owner's decision
 * (2026-09-28): offer to turn off both, never remove silently. Then each move goes through private.addon_move, which
 * checks it again in the database, and emits its event. The slow part (seeding its kinds of records, releasing what
 * it holds outside, deleting data) is the worker's, which answers the event (apps/worker/src/addons).
 *
 * Made by a factory over a catalogue, so the tests can run the real commands over a made-up catalogue; the registry's
 * are made over the real one (`ADDON_CATALOG`).
 */
import { rows, sql } from '@hfos/db/client';
import { addonUserSettings } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { findAddon, type Catalog } from '../addons/graph';
import type { LifecycleAction } from '../addons/lifecycle';
import { capabilityContextOf, loadInstallations, loadOverrides } from '../addons/load';
import type { AddonManifest } from '../addons/manifest';
import { planTransition } from '../addons/plan';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  AddonMoveInput,
  AddonMoveOutput,
  AddonPurgeInput,
  AddonSaveMySettingsInput,
  AddonSaveSettingsInput,
  AddonSettingsSaved,
} from '../schemas/addon';
import type { z } from 'zod';

/** The event each move emits. The worker finishes installing, uninstalling and purging, and says so itself. */
export const ADDON_MOVE_EVENTS: Readonly<Record<LifecycleAction, string>> = {
  install: 'addon.install_started',
  enable: 'addon.enabled',
  disable: 'addon.disabled',
  uninstall: 'addon.uninstall_started',
  purge: 'addon.purge_started',
};

type Moved = z.input<typeof AddonMoveOutput>['moved'][number];

/** Plans a move and makes it, with every other move it needs that the person agreed to, in order. */
async function makeMoves(
  ctx: CommandContext,
  catalog: Catalog,
  addonId: string,
  action: LifecycleAction,
  include: readonly string[],
): Promise<{ moved: Moved[] }> {
  const workspaceId = ctx.scope.workspaceId!;
  const [installations, overrides] = await Promise.all([
    loadInstallations(ctx.tx, workspaceId),
    loadOverrides(ctx.tx),
  ]);
  const plan = planTransition(
    capabilityContextOf(catalog, installations, overrides, ctx.scope.workspacePermissions ?? []),
    addonId,
    action,
    include,
  );
  if (plan.kind === 'already') return { moved: [] };
  if (plan.kind === 'refused')
    throw HfosError.rule(plan.rule, plan.rule === 'addon_unknown' ? 404 : 409, plan.message);
  if (plan.kind === 'needs')
    throw new HfosError('rule_violation', 409, plan.message, { addons: plan.addons }, plan.rule);
  const moved: Moved[] = [];
  for (const mv of plan.moves) {
    const m = findAddon(catalog, mv.addonId)!;
    const [row] = await rows<{
      state: Moved['to'];
      generation: number;
      previous_state: Moved['from'];
    }>(
      ctx.tx,
      sql`select * from private.addon_move(${workspaceId}::uuid, ${m.id}, ${mv.to}, ${m.version},
            ${m.dataVersion}, ${m.settings?.version ?? 1})`,
    );
    if (!row) throw HfosError.internal();
    await ctx.emit({
      type: ADDON_MOVE_EVENTS[mv.action],
      entityType: 'addon',
      payload: {
        addonId: m.id,
        name: m.name,
        version: m.version,
        from: row.previous_state,
        to: row.state,
        generation: row.generation,
      },
    });
    moved.push({
      addonId: m.id,
      action: mv.action,
      from: row.previous_state,
      to: row.state,
      generation: row.generation,
    });
  }
  return { moved };
}

const known = (catalog: Catalog, addonId: string): AddonManifest => {
  const m = findAddon(catalog, addonId);
  if (!m) throw HfosError.rule('addon_unknown', 404, 'There is no such add-on.');
  return m;
};

/** Settings belong to an add-on that is on: while it's off they're kept, and out of reach (hidden until it's back). */
async function assertOn(ctx: CommandContext, m: AddonManifest): Promise<void> {
  const [row] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.addon_in_use(${ctx.scope.workspaceId!}::uuid, ${m.id}, false) as ok`,
  );
  if (!row?.ok) throw HfosError.addonInactive(m);
}

/** Checks settings against an add-on's schema, as a validation error the screen can show field by field. */
function checked(
  schema: z.ZodType | undefined,
  value: Record<string, unknown>,
  what: string,
): unknown {
  if (!schema) throw HfosError.validation(undefined, `This add-on has no ${what}.`);
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw HfosError.validation(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return parsed.data;
}

/** The lifecycle commands, over a catalogue. */
export function addonLifecycleCommands(catalog: Catalog) {
  const scope = (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  });

  const install = defineCommand({
    name: 'addon.install',
    description:
      'Install an add-on in this business (and, with `include`, what it needs). It turns on once the worker has set it up.',
    risk: 3,
    input: AddonMoveInput,
    output: AddonMoveOutput,
    permission: 'addons.manage',
    scope,
    emits: [ADDON_MOVE_EVENTS.install, ADDON_MOVE_EVENTS.enable],
    handler: (ctx, input) => makeMoves(ctx, catalog, input.addonId, 'install', input.include),
  });

  const enable = defineCommand({
    name: 'addon.enable',
    description: 'Turn an installed add-on back on, with its data and settings as they were.',
    risk: 2,
    input: AddonMoveInput,
    output: AddonMoveOutput,
    permission: 'addons.manage',
    scope,
    emits: [ADDON_MOVE_EVENTS.enable, ADDON_MOVE_EVENTS.install],
    handler: (ctx, input) => makeMoves(ctx, catalog, input.addonId, 'enable', input.include),
  });

  const disable = defineCommand({
    name: 'addon.disable',
    description:
      'Turn an add-on off: it stops, its screens and records are hidden, and its data and settings are kept.',
    risk: 2,
    input: AddonMoveInput,
    output: AddonMoveOutput,
    permission: 'addons.manage',
    scope,
    emits: [ADDON_MOVE_EVENTS.disable],
    handler: (ctx, input) => makeMoves(ctx, catalog, input.addonId, 'disable', input.include),
  });

  const uninstall = defineCommand({
    name: 'addon.uninstall',
    description:
      'Uninstall an add-on: it stops and lets go of what it holds outside HandsFreeOS; its data is kept until an owner deletes it.',
    risk: 3,
    input: AddonMoveInput,
    output: AddonMoveOutput,
    permission: 'addons.manage',
    scope,
    emits: [ADDON_MOVE_EVENTS.disable, ADDON_MOVE_EVENTS.uninstall],
    handler: (ctx, input) => makeMoves(ctx, catalog, input.addonId, 'uninstall', input.include),
  });

  const purge = defineCommand({
    name: 'addon.purge',
    description:
      'Permanently delete an uninstalled add-on’s data. Core records it touched stay; history keeps its lines without the details.',
    risk: 4,
    input: AddonPurgeInput,
    output: AddonMoveOutput,
    permission: 'addons.purge',
    scope,
    emits: [ADDON_MOVE_EVENTS.purge],
    async handler(ctx, input) {
      const m = known(catalog, input.addonId);
      if (input.confirmName.trim().toLowerCase() !== m.name.trim().toLowerCase())
        throw HfosError.validation(
          [{ path: 'confirmName', message: `Type ${m.name} to confirm.` }],
          `Type ${m.name} to confirm.`,
        );
      return makeMoves(ctx, catalog, input.addonId, 'purge', []);
    },
  });

  const saveSettings = defineCommand({
    name: 'addon.save_settings',
    description: 'Save an add-on’s settings and switches for this business.',
    risk: 2,
    input: AddonSaveSettingsInput,
    output: AddonSettingsSaved,
    // The add-on's own settings permission (its manifest's, else addons.manage), checked below and again in the
    // database: it isn't one fixed permission for every add-on.
    permission: null,
    scope,
    emits: ['addon.settings_saved'],
    async handler(ctx, input) {
      const m = known(catalog, input.addonId);
      await assertOn(ctx, m);
      const permission = m.settings?.permission ?? 'addons.manage';
      if (!(ctx.scope.workspacePermissions ?? []).includes(permission)) throw HfosError.forbidden();
      const settings =
        input.settings === undefined
          ? null
          : checked(m.settings?.workspace, input.settings, 'business settings');
      const declared = m.settings?.flags ?? {};
      for (const key of Object.keys(input.flags ?? {}))
        if (!Object.hasOwn(declared, key))
          throw HfosError.validation([{ path: `flags.${key}`, message: 'No such switch.' }]);
      await rows(
        ctx.tx,
        sql`select private.save_addon_settings(${ctx.scope.workspaceId}::uuid, ${m.id}, ${permission},
              ${settings === null ? null : JSON.stringify(settings)}::jsonb, ${m.settings?.version ?? 1},
              ${input.flags === undefined ? null : JSON.stringify(input.flags)}::jsonb)`,
      );
      await ctx.emit({
        type: 'addon.settings_saved',
        entityType: 'addon',
        // Which parts changed, never their values: settings can hold anything the add-on keeps.
        payload: {
          addonId: m.id,
          settings: input.settings !== undefined,
          flags: Object.keys(input.flags ?? {}),
        },
      });
      return { addonId: m.id, saved: true as const };
    },
  });

  const saveMySettings = defineCommand({
    name: 'addon.save_my_settings',
    description: 'Save your own settings for an add-on.',
    risk: 1,
    input: AddonSaveMySettingsInput,
    output: AddonSettingsSaved,
    permission: 'workspace.read',
    scope,
    emits: [],
    async handler(ctx, input) {
      const m = known(catalog, input.addonId);
      await assertOn(ctx, m);
      const settings = checked(m.settings?.user, input.settings, 'personal settings') as Record<
        string,
        unknown
      >;
      if (ctx.actor.type !== 'human') throw HfosError.forbidden();
      // Row security keeps it to the person's own row, and only while the add-on runs here.
      await ctx.tx
        .insert(addonUserSettings)
        .values({
          workspaceId: ctx.scope.workspaceId!,
          userId: ctx.actor.userId,
          addonId: m.id,
          settings,
          settingsVersion: m.settings?.version ?? 1,
        })
        .onConflictDoUpdate({
          target: [
            addonUserSettings.workspaceId,
            addonUserSettings.userId,
            addonUserSettings.addonId,
          ],
          set: { settings, settingsVersion: m.settings?.version ?? 1 },
        });
      return { addonId: m.id, saved: true as const };
    },
  });

  return { install, enable, disable, uninstall, purge, saveSettings, saveMySettings };
}
