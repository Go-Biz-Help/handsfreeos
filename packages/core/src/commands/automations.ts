/**
 * Settings → Automations: saving `workspaces.settings.automations`, the switches and timings no other settings
 * document owned. Owners and admins, like the Action Center's settings it sits beside.
 */
import { eq } from 'drizzle-orm';
import { workspaces } from '@hfos/db/schema';
import { checkNudgeTemplate } from '../attention/nudge';
import { automationSettingsOf, type AutomationSettings } from '../automations/settings';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  AutomationsSaveSettingsInput,
  AutomationsSaveSettingsOutput,
} from '../schemas/automations';
import { nudgeCheckContext } from './attention';

/** Which switches a save turned on and off, for the audit log's sentence. */
function switchChanges(before: AutomationSettings, after: AutomationSettings) {
  const keys = Object.keys(after.switches) as (keyof AutomationSettings['switches'])[];
  return {
    turnedOn: keys.filter((k) => after.switches[k] && !before.switches[k]),
    turnedOff: keys.filter((k) => !after.switches[k] && before.switches[k]),
    reengageReviewed: !before.reengage.reviewedAt && !!after.reengage.reviewedAt,
  };
}

export const automationsSaveSettings = defineCommand({
  name: 'automations.save_settings',
  description:
    'Save Settings → Automations’ own switches and timings: the day-before and day-of reminders, waitlist offers, the morning email, and re-engaging dead leads with its message. Turning re-engaging on (“Looks good, turn on”) records that the message was read.',
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
      .select({ name: workspaces.name, settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    if (!w) throw HfosError.notFound('Workspace not found.');
    const stored = (w.settings ?? {}) as Record<string, unknown>;
    const current = automationSettingsOf(stored);
    // "Looks good, turn on": the first review stands, on the server's clock.
    const reviewed =
      input.settings.reengage.reviewedAt === null
        ? null
        : (current.reengage.reviewedAt ?? new Date().toISOString());
    const next: AutomationSettings = {
      ...input.settings,
      reengage: { ...input.settings.reengage, reviewedAt: reviewed },
    };
    // The message gives only the business's own links and numbers, never an amount, like the follow-up nudge.
    const check = checkNudgeTemplate(next.reengage.template, await nudgeCheckContext(ctx, w.name));
    if (!check.ok)
      throw HfosError.validation(
        check.problems.map((p) => ({ path: 'settings.reengage.template', message: p.message })),
        'The re-engage message needs a change.',
      );
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
