/**
 * The definition a run follows: its published version's (cached by version id: versions never change), or the
 * draft snapshot a test run keeps.
 */
import { parseStoredDefinition, type WorkflowDefinition } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';

const MAX_CACHED = 500;
const cache = new Map<string, WorkflowDefinition>();

export async function versionDefinition(tx: Tx, versionId: string): Promise<WorkflowDefinition> {
  const hit = cache.get(versionId);
  if (hit) return hit;
  const [v] = await rows<{ definition: unknown }>(
    tx,
    sql`select definition from app.workflow_versions where id = ${versionId}`,
  );
  if (!v) throw new Error(`workflow version ${versionId} not found`);
  const def = parseStoredDefinition(v.definition);
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(versionId, def);
  return def;
}

export async function runDefinition(
  tx: Tx,
  run: { readonly versionId: string | null; readonly testDefinition: unknown },
): Promise<WorkflowDefinition> {
  return run.versionId
    ? versionDefinition(tx, run.versionId)
    : parseStoredDefinition(run.testDefinition);
}
