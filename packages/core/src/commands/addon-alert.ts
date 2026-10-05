/**
 * Acknowledging an add-on's alert from its Home card (Real Estate step 5): "I've seen this". Only someone who sees
 * the alert may, and only one that asks for it; the database decides both (`private.acknowledge_addon_alert`). The
 * add-on that raised it hears about it (`addon_alert.acknowledged`, delivered to it alone) and stops raising it
 * higher; the card stops asking.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { AddonAlertAcknowledgeInput, AddonAlertAcknowledgeOutput } from '../schemas/addon-alert';

export const addonAlertAcknowledge = defineCommand({
  name: 'addon_alert.acknowledge',
  description:
    'Say you’ve seen an alert an add-on raised (a late duty, a deal at risk), from its card on Home. The add-on stops raising it higher; it goes when the work is done.',
  risk: 1,
  input: AddonAlertAcknowledgeInput,
  output: AddonAlertAcknowledgeOutput,
  // Seeing the alert at all takes its add-on's permission: the database checks it.
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['addon_alert.acknowledged'],
  async handler(ctx, input) {
    const [done] = await rows<{ acknowledged_at: string; changed: boolean }>(
      ctx.tx,
      sql`select acknowledged_at::text, changed
          from private.acknowledge_addon_alert(${input.workspaceId}::uuid, ${input.alertId}::uuid)`,
    );
    if (!done) throw HfosError.internal();
    const acknowledgedAt = new Date(done.acknowledged_at).toISOString();
    if (done.changed) {
      const [alert] = await rows<{ addon_id: string; key: string }>(
        ctx.tx,
        sql`select addon_id, key from app.addon_alerts where id = ${input.alertId}`,
      );
      await ctx.emit({
        type: 'addon_alert.acknowledged',
        entityType: 'addon_alert',
        entityId: input.alertId,
        payload: {
          alertId: input.alertId,
          addonId: alert?.addon_id ?? null,
          key: alert?.key ?? null,
          by: requireHuman(ctx).userId,
          acknowledgedAt,
        },
      });
    }
    return { alertId: input.alertId, acknowledgedAt, changed: done.changed };
  },
});

export const addonAlertCommands = [addonAlertAcknowledge];
