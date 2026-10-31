/**
 * The script the AI teammate follows on a call it placed to a lead (Sales Coach, round five part three): a workflow's
 * "AI teammate calls them" step, or a call campaign's call. An add-on whose manifest says `callScripts`, running in
 * the business, writes it as the customer picks up (its worker half's `callScript`), and the call's prompt carries it
 * (voice-agent/prompt.ts). The first add-on with one wins.
 *
 * Core never names the add-on: it asks whichever add-ons declare it, as live listening does (`liveCalls`). Core's
 * rules for these calls still hold whatever the script says: the greeting says who it is, that it's an AI and that
 * the call is recorded; it offers only what the step or campaign allows; and it books as the step says. A script
 * that fails, or takes too long, leaves the call to go on without one.
 */
import type { AiCallPurpose } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { addonActor } from '../addons/context';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import type { AddonWorkerModule, ScriptedCall } from '../addons/types';
import { workerMeta, type TenantScope, type WorkerServices } from '../services';

/** The calls a script is for: the ones to leads. */
export const SCRIPTED_PURPOSES: ReadonlySet<AiCallPurpose> = new Set(['workflow', 'campaign']);

/** A script's longest: it's read on every turn of the call. */
export const CALL_SCRIPT_MAX = 6000;

/** How long the customer may wait at pickup for a script: past this, the call goes on without one. */
export const CALL_SCRIPT_WAIT_MS = 1500;

/** The script an add-on writes for this call, or null when none runs here, none has one, or it failed. */
export async function addonCallScript(
  services: Pick<WorkerServices, 'db' | 'log'>,
  scope: TenantScope,
  call: Omit<ScriptedCall, 'purpose'> & { readonly purpose: AiCallPurpose },
  modules: readonly AddonWorkerModule[] = ADDON_WORKER_MODULES,
): Promise<string | null> {
  if (!SCRIPTED_PURPOSES.has(call.purpose)) return null;
  const writing = modules.filter((m) => m.callScript && m.manifest.callScripts);
  if (writing.length === 0) return null;
  const running = new Map(
    (
      await asWorker(services.db, scope, (tx) =>
        rows<{ addon_id: string; generation: number }>(
          tx,
          sql`select addon_id, generation from app.addon_installations
              where workspace_id = ${scope.workspaceId}
                and private.addon_in_use(workspace_id, addon_id, false)`,
        ),
      )
    ).map((r) => [r.addon_id, r.generation]),
  );
  for (const m of writing) {
    const generation = running.get(m.manifest.id);
    if (generation === undefined) continue;
    const log = services.log.child({ addon: m.manifest.id, workspaceId: scope.workspaceId });
    let timer: NodeJS.Timeout | undefined;
    try {
      const script = await Promise.race([
        m.callScript!(
          {
            db: services.db,
            log,
            manifest: m.manifest,
            scope,
            actor: addonActor(scope, m.manifest),
            generation,
            meta: workerMeta(null, null),
          },
          { ...call, purpose: call.purpose as ScriptedCall['purpose'] },
        ),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), CALL_SCRIPT_WAIT_MS);
        }),
      ]);
      if (script?.trim()) return script.trim().slice(0, CALL_SCRIPT_MAX);
    } catch (e) {
      log.warn({ err: e }, 'the call’s script couldn’t be written; the call goes on without one');
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
