/**
 * "Maintenance due": one customer's own schedule for a service. Every N months, never, or back to what their
 * plan or the service says ("default"). The daily job reads it the next morning.
 */
import { and, eq } from 'drizzle-orm';
import { people, services, serviceSchedules } from '@hfos/db/schema';
import { maintenanceLines } from '../automations/maintenance-load';
import { everyMonthsWords } from '../automations/maintenance';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { workspaceMessaging } from '../messaging/store';
import { MaintenanceSetScheduleInput, MaintenanceSetScheduleOutput } from '../schemas/maintenance';

export const maintenanceSetSchedule = defineCommand({
  name: 'maintenance.set_schedule',
  description:
    'Set how often one customer is due for a service (every N months), stop reminding them ("never"), or go back to what their plan or the service says ("default").',
  risk: 1,
  input: MaintenanceSetScheduleInput,
  output: MaintenanceSetScheduleOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['maintenance.schedule_set'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [person] = await ctx.tx
      .select({ id: people.id, first: people.firstName, last: people.lastName })
      .from(people)
      .where(and(eq(people.id, input.personId), eq(people.workspaceId, ws)));
    if (!person)
      throw HfosError.notFound(
        'That customer isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    const [service] = await ctx.tx
      .select({ id: services.id, name: services.name })
      .from(services)
      .where(and(eq(services.id, input.serviceId), eq(services.workspaceId, ws)));
    if (!service)
      throw HfosError.notFound(
        'That service isn’t there anymore. It may have been deleted. Refresh and pick another.',
      );
    const where = and(
      eq(serviceSchedules.personId, person.id),
      eq(serviceSchedules.serviceId, service.id),
    );
    if (input.every === 'default') await ctx.tx.delete(serviceSchedules).where(where);
    else {
      const everyMonths = input.every === 'never' ? null : input.every;
      await ctx.tx
        .insert(serviceSchedules)
        .values({
          workspaceId: ws,
          personId: person.id,
          serviceId: service.id,
          everyMonths,
          updatedBy: userIdOf(ctx.actor),
        })
        .onConflictDoUpdate({
          target: [serviceSchedules.personId, serviceSchedules.serviceId],
          set: { everyMonths, updatedBy: userIdOf(ctx.actor) },
        });
    }
    const m = await workspaceMessaging(ctx.tx, ws);
    const [line] = (
      await maintenanceLines(ctx.tx, ws, { personId: person.id, timeZone: m.timezone || 'UTC' })
    ).filter((l) => l.serviceId === service.id);
    const words =
      input.every === 'default'
        ? 'as the service says'
        : input.every === 'never'
          ? 'never'
          : everyMonthsWords(input.every);
    await ctx.emit({
      type: 'maintenance.schedule_set',
      entityType: 'person',
      entityId: person.id,
      payload: { serviceId: service.id, every: input.every },
      after: {
        customer: `${person.first} ${person.last}`.trim(),
        service: service.name,
        every: words,
      },
    });
    return {
      personId: person.id,
      serviceId: service.id,
      everyMonths: line?.schedule.everyMonths ?? null,
      source: line?.schedule.source ?? null,
      dueOn: line?.dueOn ?? null,
    };
  },
});
