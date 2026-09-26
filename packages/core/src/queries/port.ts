import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { migrationReconnectTasks, numberPorts, phoneNumbers } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { defineQuery } from '../kernel/define';
import { CLAIMED_STATUSES } from '../messaging/store';
import { NumberPortListInput, NumberPortListOutput } from '../schemas/port';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The numbers a migration found this business texting and ringing from (M11), and not yet on their way here.
 *
 * A migration writes each one down as a task — the number is the business's to move, never ours to move
 * quietly — and until now nothing on the port screen read those tasks, so a business had to type the numbers
 * in again from memory. Offered here so they are one press away. A number already being moved, or already
 * this business's, is left out: it is on the screen already, as a port or as a number.
 *
 * The tasks are readable by whoever can change the workspace; somebody who cannot simply sees none.
 */
export async function numbersFromMigration(
  tx: Tx,
  workspaceId: string,
): Promise<{ e164: string; display: string }[]> {
  const tasks = await tx
    .select({
      label: migrationReconnectTasks.label,
      descriptor: migrationReconnectTasks.descriptor,
    })
    .from(migrationReconnectTasks)
    .where(
      and(
        eq(migrationReconnectTasks.workspaceId, workspaceId),
        eq(migrationReconnectTasks.kind, 'messaging'),
        inArray(migrationReconnectTasks.state, ['todo', 'in_progress', 'blocked']),
      ),
    );
  const found = new Set<string>();
  for (const t of tasks) {
    const named = (t.descriptor as Record<string, unknown> | null)?.['number'];
    const e164 = typeof named === 'string' ? named : t.label;
    if (/^\+[1-9][0-9]{7,14}$/.test(e164)) found.add(e164);
  }
  if (!found.size) return [];
  const numbers = [...found];
  const [ported, owned] = await Promise.all([
    tx
      .select({ e164: numberPorts.e164 })
      .from(numberPorts)
      .where(
        and(
          eq(numberPorts.workspaceId, workspaceId),
          inArray(numberPorts.e164, numbers),
          ne(numberPorts.status, 'cancelled'),
        ),
      ),
    tx
      .select({ e164: phoneNumbers.e164 })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.workspaceId, workspaceId),
          inArray(phoneNumbers.e164, numbers),
          inArray(phoneNumbers.status, [...CLAIMED_STATUSES]),
        ),
      ),
  ]);
  const taken = new Set([...ported, ...owned].map((r) => r.e164));
  return numbers
    .filter((e164) => !taken.has(e164))
    .sort()
    .map((e164) => ({ e164, display: formatPhone(e164) }));
}

/**
 * Every number this business is moving to us (M17).
 *
 * **`channels.manage`, the same as buying or releasing a number**, because it is the same decision and
 * because `number_ports` holds the losing carrier's PIN. The row never leaves here whole: what comes back
 * says which details and papers are *in*, never what they say.
 */
export const numberPortList = defineQuery({
  name: 'number_port.list',
  description: 'Numbers this business is bringing from another carrier, and where each one stands.',
  input: NumberPortListInput,
  output: NumberPortListOutput,
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const all = await ctx.tx
      .select()
      .from(numberPorts)
      .where(
        input.includeFinished
          ? eq(numberPorts.workspaceId, input.workspaceId)
          : // A port that was called off or turned down still shows — being turned down is the moment a
            // business most needs to see why. Only a finished one drops out of the default view.
            and(eq(numberPorts.workspaceId, input.workspaceId), ne(numberPorts.status, 'complete')),
      )
      .orderBy(desc(numberPorts.createdAt))
      .limit(50);
    return {
      fromMigration: await numbersFromMigration(ctx.tx, input.workspaceId),
      ports: all.map((p) => {
        const submission = p.submission as Record<string, unknown>;
        const documents = p.documents as Record<string, unknown>;
        return {
          id: p.id,
          e164: p.e164,
          display: formatPhone(p.e164),
          kind: p.kind,
          status: p.status,
          documents: { loa: Boolean(documents['loa']), bill: Boolean(documents['bill']) },
          detailsReady: ['accountNumber', 'pin', 'authorizedBy', 'serviceAddress'].every(
            (k) => typeof submission[k] === 'string' && (submission[k] as string).trim().length > 0,
          ),
          rejectionReason: p.rejectionReason,
          scheduledFor: p.scheduledFor,
          submittedAt: iso(p.submittedAt),
          completedAt: iso(p.completedAt),
          createdAt: p.createdAt.toISOString(),
        };
      }),
    };
  },
});
