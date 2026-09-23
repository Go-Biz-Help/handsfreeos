/**
 * "Maintenance due" on a customer's page: each service they've had, how often they're due, when next, and
 * where the reminders stand.
 */
import { rows, sql } from '@hfos/db/client';
import { maintenanceLines } from '../automations/maintenance-load';
import { defineQuery } from '../kernel/define';
import { workspaceMessaging } from '../messaging/store';
import { MaintenanceForPersonInput, MaintenanceForPersonOutput } from '../schemas/maintenance';

export const maintenanceForPerson = defineQuery({
  name: 'maintenance.for_person',
  description:
    'A customer’s regular services: when each was last done, how often it’s due (theirs, their plan’s or the service’s), when next, and the reminders sent.',
  input: MaintenanceForPersonInput,
  output: MaintenanceForPersonOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const m = await workspaceMessaging(ctx.tx, ws);
    const lines = await maintenanceLines(ctx.tx, ws, {
      personId: input.personId,
      timeZone: m.timezone || 'UTC',
    });
    const extra = await rows<{
      service_id: string;
      repeat_months: number | null;
      due_on: string | null;
      sent_count: number | null;
      status: 'reminding' | 'booked' | 'card' | 'stopped' | null;
      last_sent_at: Date | null;
    }>(
      ctx.tx,
      sql`select s.id as service_id, s.repeat_months, r.due_on::text as due_on, r.sent_count, r.status,
            coalesce(r.second_sent_at, r.first_sent_at) as last_sent_at
          from app.services s
          left join lateral (select * from app.maintenance_reminders r
            where r.person_id = ${input.personId} and r.service_id = s.id
            order by r.due_on desc limit 1) r on true
          where s.workspace_id = ${ws}`,
    );
    const byService = new Map(extra.map((e) => [e.service_id, e]));
    return {
      items: lines
        .map((l) => {
          const e = byService.get(l.serviceId);
          return {
            serviceId: l.serviceId,
            serviceName: l.serviceName,
            lastVisitOn: l.lastVisitOn,
            everyMonths: l.schedule.everyMonths,
            source: l.schedule.source,
            planName: l.plan?.name ?? null,
            serviceMonths: e?.repeat_months ?? null,
            dueOn: l.dueOn,
            bookedAhead: l.bookedAhead,
            reminder:
              e?.due_on && e.status
                ? {
                    dueOn: e.due_on,
                    sentCount: e.sent_count ?? 0,
                    status: e.status,
                    lastSentAt: e.last_sent_at ? new Date(e.last_sent_at).toISOString() : null,
                  }
                : null,
          };
        })
        .sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    };
  },
});
