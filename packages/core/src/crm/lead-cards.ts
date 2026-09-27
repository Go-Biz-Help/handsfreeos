import { and, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Tx } from '@hfos/db/client';
import { companies, leads, people, pipelineStages, users } from '@hfos/db/schema';
import type { LeadCard } from '../schemas/lead';
import { fullName, tagsByRecord } from './records';

/** A card with its `updated_at` to the microsecond, the key `lead.list` pages on (a `Date` keeps milliseconds). */
export type KeyedLeadCard = LeadCard & { updatedKey: string };

/** Leads with everything a board card or list row shows, in the given order. */
export async function leadCards(
  tx: Tx,
  workspaceId: string,
  where: SQL,
  orderBy: SQL[],
  limit?: number,
): Promise<KeyedLeadCard[]> {
  const assignee = alias(users, 'assignee');
  let q = tx
    .select({
      lead: leads,
      stage: { name: pipelineStages.name, kind: pipelineStages.kind },
      person: {
        id: people.id,
        firstName: people.firstName,
        lastName: people.lastName,
        archivedAt: people.archivedAt,
      },
      company: { id: companies.id, name: companies.name, archivedAt: companies.archivedAt },
      assignee: { id: assignee.id, fullName: assignee.fullName, email: assignee.email },
      updatedKey: sql<string>`to_char(${leads.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(leads)
    .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
    .leftJoin(people, eq(people.id, leads.personId))
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .leftJoin(assignee, eq(assignee.id, leads.assigneeUserId))
    .where(and(eq(leads.workspaceId, workspaceId), where))
    .orderBy(...orderBy)
    .$dynamic();
  if (limit) q = q.limit(limit);
  const rows = await q;
  const tags = await tagsByRecord(
    tx,
    workspaceId,
    'lead',
    rows.map((r) => r.lead.id),
  );
  return rows.map((r) => ({
    id: r.lead.id,
    title: r.lead.title,
    pipelineId: r.lead.pipelineId,
    stageId: r.lead.stageId,
    stageName: r.stage.name,
    stageKind: r.stage.kind,
    status: r.lead.status,
    person: r.person?.id
      ? {
          id: r.person.id,
          fullName: fullName(r.person.firstName!, r.person.lastName!),
          archived: !!r.person.archivedAt,
        }
      : null,
    company: r.company?.id
      ? { id: r.company.id, name: r.company.name!, archived: !!r.company.archivedAt }
      : null,
    valueCents: Number(r.lead.valueCents),
    source: r.lead.source,
    assignee: r.assignee?.id
      ? { id: r.assignee.id, fullName: r.assignee.fullName || r.assignee.email! }
      : null,
    expectedCloseOn: r.lead.expectedCloseOn,
    nextAction: r.lead.nextAction,
    nextActionAt: r.lead.nextActionAt?.toISOString() ?? null,
    needsNextAction: r.lead.status === 'open' && !r.lead.nextAction,
    nextActionOverdue:
      r.lead.status === 'open' &&
      !!r.lead.nextActionAt &&
      r.lead.nextActionAt.getTime() <= Date.now(),
    lastContactAt: r.lead.lastContactAt?.toISOString() ?? null,
    wonAt: r.lead.wonAt?.toISOString() ?? null,
    lostAt: r.lead.lostAt?.toISOString() ?? null,
    lostReason: r.lead.lostReason,
    position: Number(r.lead.position),
    tags: tags.get(r.lead.id) ?? [],
    stageEnteredAt: r.lead.stageEnteredAt.toISOString(),
    archivedAt: r.lead.archivedAt?.toISOString() ?? null,
    createdAt: r.lead.createdAt.toISOString(),
    updatedAt: r.lead.updatedAt.toISOString(),
    updatedKey: r.updatedKey,
  }));
}
