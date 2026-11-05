/**
 * What `registration.submit` needs before it lets details through (the owner's rule, 2026-11-05): the worker's checks
 * found exactly these details all green (`registration.record_check`, written here as the review step's worker would),
 * and every tick only the business can give is ticked. Details that don't read as a registration are left as they
 * are, so a test of their refusal still sees it.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { testDbs } from '@hfos/db/testing';
import { registrationRecordCheck } from '../src/commands/registration';
import { executeCommand } from '../src/kernel/execute';
import { CONFIRMATION_IDS } from '../src/messaging/preflight';
import { registrationFingerprint } from '../src/messaging/registration-fingerprint';
import { BusinessProfile } from '../src/schemas/telephony';

export async function allGreen<T>(input: T): Promise<T> {
  const i = input as { workspaceId?: string; kind?: string; business?: unknown };
  const read = BusinessProfile.safeParse(i?.business);
  if (!i?.workspaceId || !i.kind || !read.success) return input;
  const [ws] = await rows<{ organization_id: string }>(
    testDbs().admin.db,
    sql`select organization_id from app.workspaces where id = ${i.workspaceId}`,
  );
  if (!ws) return input;
  await executeCommand(
    testDbs().worker.db,
    registrationRecordCheck,
    {
      workspaceId: i.workspaceId,
      fingerprint: registrationFingerprint(i.kind, read.data),
      notGreen: [],
      checks: [],
    },
    { type: 'system', workspaceId: i.workspaceId, organizationId: ws.organization_id },
    { correlationId: randomUUID(), channel: 'test' },
  );
  return {
    ...i,
    business: { ...(i.business as object), confirmed: [...CONFIRMATION_IDS] },
  } as T;
}
