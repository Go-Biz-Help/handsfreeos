import { and, desc, eq, ne } from 'drizzle-orm';
import { numberPorts } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { defineQuery } from '../kernel/define';
import { NumberPortListInput, NumberPortListOutput } from '../schemas/port';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

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
