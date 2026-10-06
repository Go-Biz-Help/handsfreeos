/**
 * Add-ons' checks on the AI teammate's replies (round seven; Chris 2026-10-05: fair housing checks run on its
 * replies). An add-on whose manifest says `teammate.checksReplies` checks every reply the teammate writes while it
 * uses that add-on, after core's safety check passed it. A flagged reply never goes out on its own: it waits as a
 * draft for a person, with what was found, even when the teammate answers on its own.
 */
import { teammateUsesAddon } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { addonScope } from '../addons/context';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import type { AddonWorkerModule } from '../addons/types';
import type { WorkerServices } from '../services';
import { workerMeta, type TenantScope } from '../services';
import type { RunContext } from './context';

export interface ReplyFlag {
  readonly addonName: string;
  readonly message: string;
}

/** What the add-ons this teammate uses found in its reply; none when they found nothing, or none check. */
export async function addonReplyFlags(
  services: WorkerServices,
  scope: TenantScope,
  rc: RunContext,
  text: string,
  modules: readonly AddonWorkerModule[] = ADDON_WORKER_MODULES,
): Promise<ReplyFlag[]> {
  const checking = modules.filter(
    (m) =>
      m.checkTeammateReply &&
      m.manifest.teammate?.checksReplies &&
      (rc.addons ?? []).includes(m.manifest.id) &&
      teammateUsesAddon(rc.config, m.manifest.id),
  );
  if (checking.length === 0) return [];
  const generations = new Map(
    (
      await asWorker(services.db, scope, (tx) =>
        rows<{ addon_id: string; generation: number }>(
          tx,
          sql`select addon_id, generation from app.addon_installations
              where workspace_id = ${scope.workspaceId} and state = 'enabled'`,
        ),
      )
    ).map((r) => [r.addon_id, r.generation]),
  );
  const flags: ReplyFlag[] = [];
  for (const m of checking) {
    const generation = generations.get(m.manifest.id);
    if (generation === undefined) continue;
    const found = await m.checkTeammateReply!(
      addonScope(services, m.manifest, scope, generation, workerMeta(null, null)),
      { text, channel: rc.conversation.channel, personId: rc.conversation.personId },
    );
    for (const message of found.slice(0, 10))
      flags.push({ addonName: m.manifest.name, message: message.slice(0, 600) });
  }
  return flags.slice(0, 10);
}
