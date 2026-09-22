/**
 * Settings → Automations: saving `workspaces.settings.automations`, the switches and timings no other settings
 * document owned. Owners and admins, like the Action Center's settings it sits beside.
 */
import { eq } from 'drizzle-orm';
import { workspaces } from '@hfos/db/schema';
import { automationSettingsOf, type AutomationSettings } from '../automations/settings';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  AutomationsSaveSettingsInput,
  AutomationsSaveSettingsOutput,
} from '../schemas/automations';

/** Which switches a save turned on and off, for the audit log's sentence. */
function switchChanges(before: AutomationSettings, after: AutomationSettings) {
  const keys = Object.keys(after.switches) as (keyof AutomationSettings['switches'])[];
  return {
    turnedOn: keys.filter((k) => after.switches[k] && !before.switches[k]),
    turnedOff: keys.filter((k) => !after.switches[k] && before.switches[k]),
  };
}

export const automationsSaveSettings = defineCommand({
  name: 'automations.save_settings',
  description:
    'Save Settings → Automations’ own switches and timings: the day-before and day-of reminders, waitlist offers and the morning email.',
  risk: 2,
  input: AutomationsSaveSettingsInput,
  output: AutomationsSaveSettingsOutput,
  permission: 'workspace.update',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['automations.settings_saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    if (!w) throw HfosError.notFound('Workspace not found.');
    const stored = (w.settings ?? {}) as Record<string, unknown>;
    const current = automationSettingsOf(stored);
    const next = input.settings;
    const changed = JSON.stringify(stored['automations'] ?? null) !== JSON.stringify(next);
    if (!changed) return { workspaceId: ws, settings: next, changed: false };
    const [row] = await ctx.tx
      .update(workspaces)
      .set({ settings: { ...stored, automations: next } })
      .where(eq(workspaces.id, ws))
      .returning({ id: workspaces.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'automations.settings_saved',
      entityType: 'workspace',
      entityId: ws,
      payload: switchChanges(current, next),
      before: { automations: current },
      after: { automations: next },
    });
    return { workspaceId: ws, settings: next, changed: true };
  },
});
