/**
 * Workspace catalogs calendars refer to: services, resources, territories and the public booking site.
 * Owners and admins (calendars.manage) change them; archived rows stay for history and old appointments.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import {
  bookingSites,
  calendarResources,
  calendars,
  calendarServices,
  resources,
  schedules,
  serviceResources,
  services,
  serviceStaff,
  territories,
  territoryMembers,
} from '@hfos/db/schema';
import type { WeeklyHours } from '../calendar/config';
import { formatDuration, formatHours } from '../calendar/format';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { isUniqueViolation } from '../kernel/pg-errors';
import {
  BookingSiteUpdateInput,
  BookingSiteUpdateOutput,
  ResourceArchiveInput,
  ResourceArchiveOutput,
  ResourceCreateInput,
  ResourceCreateOutput,
  ResourceUpdateInput,
  ResourceUpdateOutput,
  ServiceArchiveInput,
  ServiceArchiveOutput,
  ServiceCreateInput,
  ServiceCreateOutput,
  ServiceUpdateInput,
  ServiceUpdateOutput,
  TerritoryCreateInput,
  TerritoryCreateOutput,
  TerritoryDeleteInput,
  TerritoryDeleteOutput,
  TerritoryUpdateInput,
  TerritoryUpdateOutput,
} from '../schemas/calendar';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];
const nameTaken = (what: string) =>
  HfosError.conflict(`There’s already a ${what} with that name.`, 'name_taken');
const lengths = (list: readonly number[]) => list.map(formatDuration).join(', ');

/** A service's or resource's own hours: undefined leaves them, null removes the layer, a list replaces it. */
async function setOwnerHours(
  tx: Tx,
  workspaceId: string,
  ownerKind: 'service' | 'resource',
  ownerId: string,
  hours: WeeklyHours | null | undefined,
  actorId: string,
): Promise<void> {
  if (hours === undefined) return;
  const own = and(
    eq(schedules.workspaceId, workspaceId),
    eq(schedules.ownerKind, ownerKind),
    eq(schedules.ownerId, ownerId),
  )!;
  if (hours === null) {
    await tx.delete(schedules).where(own);
    return;
  }
  await tx
    .insert(schedules)
    .values({ workspaceId, ownerKind, ownerId, weekly: hours, createdBy: actorId })
    .onConflictDoUpdate({
      target: [schedules.workspaceId, schedules.ownerKind, schedules.ownerId],
      set: { weekly: hours },
    });
}

async function writeServiceLinks(
  tx: Tx,
  workspaceId: string,
  serviceId: string,
  staff: readonly string[] | undefined,
  needs: readonly { resourceId: string; quantity: number }[] | undefined,
): Promise<void> {
  if (staff !== undefined) {
    await tx.delete(serviceStaff).where(eq(serviceStaff.serviceId, serviceId));
    const ids = unique(staff);
    if (ids.length)
      await tx
        .insert(serviceStaff)
        .values(ids.map((userId) => ({ workspaceId, serviceId, userId })));
  }
  if (needs !== undefined) {
    await tx.delete(serviceResources).where(eq(serviceResources.serviceId, serviceId));
    const byId = new Map(needs.map((n) => [n.resourceId, n.quantity]));
    if (byId.size)
      await tx.insert(serviceResources).values(
        [...byId].map(([resourceId, quantity]) => ({
          workspaceId,
          serviceId,
          resourceId,
          quantity,
        })),
      );
  }
}

// ---- Services ----

export const serviceCreate = defineCommand({
  name: 'service.create',
  description:
    'Add a service customers can book: one to six lengths, buffers, who does it, what it needs and optional service hours.',
  risk: 1,
  input: ServiceCreateInput,
  output: ServiceCreateOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['service.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const durations = unique(input.durations);
    const defaultDuration = input.defaultDuration ?? durations[0]!;
    if (!durations.includes(defaultDuration))
      throw HfosError.validation([
        { path: 'defaultDuration', message: 'Pick one of the lengths.' },
      ]);
    let row: { id: string } | undefined;
    try {
      [row] = await ctx.tx
        .insert(services)
        .values({
          workspaceId: ws,
          name: input.name,
          description: input.description ?? null,
          durations,
          defaultDuration,
          bufferBefore: input.bufferBefore,
          bufferAfter: input.bufferAfter,
          ...(input.color ? { color: input.color } : {}),
          priceCents: input.priceCents ?? null,
          locationKinds: unique(input.locationKinds),
          createdBy: me,
        })
        .returning({ id: services.id });
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken('service');
      throw e;
    }
    if (!row) throw HfosError.forbidden();
    await writeServiceLinks(ctx.tx, ws, row.id, input.staffUserIds, input.resources);
    await setOwnerHours(ctx.tx, ws, 'service', row.id, input.hours ?? undefined, me);
    await ctx.emit({
      type: 'service.created',
      entityType: 'service',
      entityId: row.id,
      payload: { name: input.name },
      after: {
        name: input.name,
        lengths: lengths(durations),
        bufferBefore: input.bufferBefore,
        bufferAfter: input.bufferAfter,
        staff: input.staffUserIds.length ? input.staffUserIds.length : 'everyone',
        hours: input.hours ? formatHours(input.hours) : null,
      },
    });
    return { serviceId: row.id };
  },
});

export const serviceUpdate = defineCommand({
  name: 'service.update',
  description: 'Change a service: name, lengths, buffers, who does it, what it needs or its hours.',
  risk: 1,
  input: ServiceUpdateInput,
  output: ServiceUpdateOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['service.updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(services)
      .where(and(eq(services.id, input.serviceId), eq(services.workspaceId, ws)));
    if (!current) throw HfosError.notFound('Service not found.');
    const patch: Partial<typeof services.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const change = <K extends keyof typeof services.$inferInsert>(
      key: K,
      value: (typeof services.$inferInsert)[K] | undefined,
      shown: (v: unknown) => unknown = (v) => v,
    ) => {
      if (value === undefined) return;
      if (JSON.stringify(value) === JSON.stringify(current[key as keyof typeof current])) return;
      patch[key] = value;
      before[key] = shown(current[key as keyof typeof current]);
      after[key] = shown(value);
    };
    change('name', input.name);
    change(
      'description',
      input.description === undefined ? undefined : (input.description ?? null),
    );
    const durations = input.durations ? unique(input.durations) : current.durations;
    let defaultDuration = input.defaultDuration ?? current.defaultDuration;
    if (!durations.includes(defaultDuration)) {
      if (input.defaultDuration !== undefined)
        throw HfosError.validation([
          { path: 'defaultDuration', message: 'Pick one of the lengths.' },
        ]);
      defaultDuration = durations[0]!;
    }
    change('durations', input.durations ? durations : undefined, (v) => lengths(v as number[]));
    change('defaultDuration', defaultDuration, (v) => formatDuration(v as number));
    change('bufferBefore', input.bufferBefore);
    change('bufferAfter', input.bufferAfter);
    change('color', input.color);
    change('priceCents', input.priceCents === undefined ? undefined : (input.priceCents ?? null));
    change('locationKinds', input.locationKinds ? unique(input.locationKinds) : undefined);
    const updated = [
      ...Object.keys(patch),
      ...(input.staffUserIds !== undefined ? ['staffUserIds'] : []),
      ...(input.resources !== undefined ? ['resources'] : []),
      ...(input.hours !== undefined ? ['hours'] : []),
    ];
    if (!updated.length) return { serviceId: current.id, updated };
    if (Object.keys(patch).length)
      try {
        await ctx.tx.update(services).set(patch).where(eq(services.id, current.id));
      } catch (e) {
        if (isUniqueViolation(e)) throw nameTaken('service');
        throw e;
      }
    await writeServiceLinks(ctx.tx, ws, current.id, input.staffUserIds, input.resources);
    await setOwnerHours(ctx.tx, ws, 'service', current.id, input.hours, me);
    if (input.hours !== undefined) after.hours = input.hours ? formatHours(input.hours) : 'none';
    const name = (patch.name as string | undefined) ?? current.name;
    await ctx.emit({
      type: 'service.updated',
      entityType: 'service',
      entityId: current.id,
      payload: { name, fields: updated },
      before: { name: current.name, ...before },
      after: { name, ...after },
    });
    return { serviceId: current.id, updated };
  },
});

export const serviceArchive = defineCommand({
  name: 'service.archive',
  description:
    'Archive a service. Its appointments keep it; calendars still offering it show a conflict to fix.',
  risk: 1,
  input: ServiceArchiveInput,
  output: ServiceArchiveOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['service.archived'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(services)
      .where(and(eq(services.id, input.serviceId), eq(services.workspaceId, ws)));
    if (!current) throw HfosError.notFound('Service not found.');
    const using = await ctx.tx
      .select({ id: calendars.id, name: calendars.name })
      .from(calendarServices)
      .innerJoin(calendars, eq(calendars.id, calendarServices.calendarId))
      .where(and(eq(calendarServices.serviceId, current.id), ne(calendars.status, 'archived')));
    if (current.archivedAt) return { serviceId: current.id, calendars: using };
    await ctx.tx
      .update(services)
      .set({ archivedAt: new Date() })
      .where(eq(services.id, current.id));
    await ctx.emit({
      type: 'service.archived',
      entityType: 'service',
      entityId: current.id,
      payload: { name: current.name, calendarIds: using.map((c) => c.id) },
      before: { name: current.name, archived: false },
      after: { name: current.name, archived: true },
    });
    return { serviceId: current.id, calendars: using };
  },
});

// ---- Resources ----

export const resourceCreate = defineCommand({
  name: 'resource.create',
  description:
    'Add a room, truck or piece of equipment bookings can reserve, with a quantity and optional hours.',
  risk: 1,
  input: ResourceCreateInput,
  output: ResourceCreateOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['resource.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    let row: { id: string } | undefined;
    try {
      [row] = await ctx.tx
        .insert(resources)
        .values({
          workspaceId: ws,
          name: input.name,
          kind: input.kind,
          quantity: input.quantity,
          location: input.location ?? null,
          createdBy: me,
        })
        .returning({ id: resources.id });
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken('resource');
      throw e;
    }
    if (!row) throw HfosError.forbidden();
    await setOwnerHours(ctx.tx, ws, 'resource', row.id, input.hours ?? undefined, me);
    await ctx.emit({
      type: 'resource.created',
      entityType: 'resource',
      entityId: row.id,
      payload: { name: input.name },
      after: {
        name: input.name,
        kind: input.kind,
        quantity: input.quantity,
        hours: input.hours ? formatHours(input.hours) : null,
      },
    });
    return { resourceId: row.id };
  },
});

export const resourceUpdate = defineCommand({
  name: 'resource.update',
  description: 'Change a resource’s name, kind, quantity, location or hours.',
  risk: 1,
  input: ResourceUpdateInput,
  output: ResourceUpdateOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['resource.updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(resources)
      .where(and(eq(resources.id, input.resourceId), eq(resources.workspaceId, ws)));
    if (!current) throw HfosError.notFound('Resource not found.');
    const patch: Partial<typeof resources.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const fields = {
      name: input.name,
      kind: input.kind,
      quantity: input.quantity,
      location: input.location === undefined ? undefined : (input.location ?? null),
    } as const;
    for (const [key, value] of Object.entries(fields) as [keyof typeof fields, unknown][]) {
      if (value === undefined || value === current[key]) continue;
      (patch as Record<string, unknown>)[key] = value;
      before[key] = current[key];
      after[key] = value;
    }
    const updated = [...Object.keys(patch), ...(input.hours !== undefined ? ['hours'] : [])];
    if (!updated.length) return { resourceId: current.id, updated };
    if (Object.keys(patch).length)
      try {
        await ctx.tx.update(resources).set(patch).where(eq(resources.id, current.id));
      } catch (e) {
        if (isUniqueViolation(e)) throw nameTaken('resource');
        throw e;
      }
    await setOwnerHours(ctx.tx, ws, 'resource', current.id, input.hours, me);
    if (input.hours !== undefined)
      after.hours = input.hours ? formatHours(input.hours) : 'always open';
    const name = (patch.name as string | undefined) ?? current.name;
    await ctx.emit({
      type: 'resource.updated',
      entityType: 'resource',
      entityId: current.id,
      payload: { name, fields: updated },
      before: { name: current.name, ...before },
      after: { name, ...after },
    });
    return { resourceId: current.id, updated };
  },
});

export const resourceArchive = defineCommand({
  name: 'resource.archive',
  description:
    'Archive a resource. Its appointments keep it; calendars that need it show a conflict to fix.',
  risk: 1,
  input: ResourceArchiveInput,
  output: ResourceArchiveOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['resource.archived'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(resources)
      .where(and(eq(resources.id, input.resourceId), eq(resources.workspaceId, ws)));
    if (!current) throw HfosError.notFound('Resource not found.');
    const using = await ctx.tx
      .select({ id: calendars.id, name: calendars.name })
      .from(calendarResources)
      .innerJoin(calendars, eq(calendars.id, calendarResources.calendarId))
      .where(and(eq(calendarResources.resourceId, current.id), ne(calendars.status, 'archived')));
    if (current.archivedAt) return { resourceId: current.id, calendars: using };
    await ctx.tx
      .update(resources)
      .set({ archivedAt: new Date() })
      .where(and(eq(resources.id, current.id), isNull(resources.archivedAt)));
    await ctx.emit({
      type: 'resource.archived',
      entityType: 'resource',
      entityId: current.id,
      payload: { name: current.name, calendarIds: using.map((c) => c.id) },
      before: { name: current.name, archived: false },
      after: { name: current.name, archived: true },
    });
    return { resourceId: current.id, calendars: using };
  },
});

// ---- Territories ----

async function setTerritoryMembers(
  tx: Tx,
  workspaceId: string,
  territoryId: string,
  userIds: readonly string[],
): Promise<void> {
  await tx.delete(territoryMembers).where(eq(territoryMembers.territoryId, territoryId));
  const ids = unique(userIds);
  if (ids.length)
    await tx
      .insert(territoryMembers)
      .values(ids.map((userId) => ({ workspaceId, territoryId, userId })));
}

export const territoryCreate = defineCommand({
  name: 'territory.create',
  description: 'Add a territory: a list of ZIP codes and the people who cover them.',
  risk: 1,
  input: TerritoryCreateInput,
  output: TerritoryCreateOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['territory.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const postalCodes = unique(input.postalCodes).sort();
    let row: { id: string } | undefined;
    try {
      [row] = await ctx.tx
        .insert(territories)
        .values({ workspaceId: ws, name: input.name, postalCodes, createdBy: me })
        .returning({ id: territories.id });
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken('territory');
      throw e;
    }
    if (!row) throw HfosError.forbidden();
    await setTerritoryMembers(ctx.tx, ws, row.id, input.userIds);
    await ctx.emit({
      type: 'territory.created',
      entityType: 'territory',
      entityId: row.id,
      payload: { name: input.name },
      after: {
        name: input.name,
        zipCodes: postalCodes.length,
        people: unique(input.userIds).length,
      },
    });
    return { territoryId: row.id };
  },
});

export const territoryUpdate = defineCommand({
  name: 'territory.update',
  description: 'Rename a territory or change its ZIP codes or people.',
  risk: 1,
  input: TerritoryUpdateInput,
  output: TerritoryUpdateOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['territory.updated'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(territories)
      .where(and(eq(territories.id, input.territoryId), eq(territories.workspaceId, ws)));
    if (!current) throw HfosError.notFound('Territory not found.');
    const patch: Partial<typeof territories.$inferInsert> = {};
    if (input.name !== undefined && input.name !== current.name) patch.name = input.name;
    const postalCodes = input.postalCodes ? unique(input.postalCodes).sort() : undefined;
    if (postalCodes && JSON.stringify(postalCodes) !== JSON.stringify(current.postalCodes))
      patch.postalCodes = postalCodes;
    const updated = [...Object.keys(patch), ...(input.userIds !== undefined ? ['userIds'] : [])];
    if (!updated.length) return { territoryId: current.id, updated };
    if (Object.keys(patch).length)
      try {
        await ctx.tx.update(territories).set(patch).where(eq(territories.id, current.id));
      } catch (e) {
        if (isUniqueViolation(e)) throw nameTaken('territory');
        throw e;
      }
    if (input.userIds !== undefined)
      await setTerritoryMembers(ctx.tx, ws, current.id, input.userIds);
    const name = patch.name ?? current.name;
    await ctx.emit({
      type: 'territory.updated',
      entityType: 'territory',
      entityId: current.id,
      payload: { name, fields: updated },
      before: { name: current.name, zipCodes: current.postalCodes.length },
      after: {
        name,
        zipCodes: (postalCodes ?? current.postalCodes).length,
        ...(input.userIds !== undefined ? { people: unique(input.userIds).length } : {}),
      },
    });
    return { territoryId: current.id, updated };
  },
});

export const territoryDelete = defineCommand({
  name: 'territory.delete',
  description: 'Delete a territory. Calendars routing by ZIP stop sending its codes to its people.',
  risk: 1,
  input: TerritoryDeleteInput,
  output: TerritoryDeleteOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['territory.deleted'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(territories)
      .where(and(eq(territories.id, input.territoryId), eq(territories.workspaceId, ws)));
    if (!current) throw HfosError.notFound('Territory not found.');
    await ctx.tx.delete(territories).where(eq(territories.id, current.id));
    await ctx.emit({
      type: 'territory.deleted',
      entityType: 'territory',
      entityId: current.id,
      payload: { name: current.name },
      before: { name: current.name, zipCodes: current.postalCodes.length },
    });
    return { territoryId: current.id };
  },
});

// ---- The booking site ----

export const bookingSiteUpdate = defineCommand({
  name: 'booking_site.update',
  description:
    'Set up or change the public booking site (/book/<name>) that lists the public calendars.',
  risk: 1,
  input: BookingSiteUpdateInput,
  output: BookingSiteUpdateOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['booking_site.updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [existing] = await ctx.tx
      .select()
      .from(bookingSites)
      .where(eq(bookingSites.workspaceId, ws));
    const values = {
      slug: input.slug,
      name: input.name,
      intro: input.intro ?? null,
      enabled: input.enabled,
    };
    let row: { id: string } | undefined;
    try {
      [row] = existing
        ? await ctx.tx
            .update(bookingSites)
            .set(values)
            .where(eq(bookingSites.id, existing.id))
            .returning({ id: bookingSites.id })
        : await ctx.tx
            .insert(bookingSites)
            .values({ workspaceId: ws, ...values, createdBy: me })
            .returning({ id: bookingSites.id });
    } catch (e) {
      if (isUniqueViolation(e))
        throw HfosError.conflict('That link name is taken. Pick another.', 'slug_taken');
      throw e;
    }
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'booking_site.updated',
      entityType: 'booking_site',
      entityId: row.id,
      payload: { slug: input.slug, enabled: input.enabled },
      before: existing
        ? { name: existing.name, slug: existing.slug, enabled: existing.enabled }
        : null,
      after: { name: input.name, slug: input.slug, enabled: input.enabled },
    });
    return { siteId: row.id, slug: input.slug };
  },
});
