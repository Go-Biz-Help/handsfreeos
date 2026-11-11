/**
 * What Contractor Operations' commands and queries share (docs/contractor.md): its kinds of records and relationship
 * types here, loading a job, keeping a project's % done, its timeline lines, and the people a job can have.
 * Server-only.
 */
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { addonTimelineLine } from '../../server';
import type { StarterItem } from '../checklists';
import { contractorAddon } from '../manifest';
import { jobPercent, type JobKind, type JobStatus, type PhaseStatus } from '../progress';
import { ChecklistStarter } from '../schemas';
import { jobs, phases } from '../tables';
import type { Trade } from '../trades';
import { REFUSALS } from '../words';

export type Ctx = CommandContext | QueryContext;

export const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const settingUp = () => HfosError.rule('contractor_setting_up', 409, REFUSALS.settingUp);

/** The add-on's kinds of records here: a job and a property. */
export async function kindIds(ctx: Ctx): Promise<{ job: string; property: string }> {
  const list = await rows<{ id: string; key: string }>(
    ctx.tx,
    sql`select id, key from app.custom_record_types
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'contractor'
          and key in ('contractor_job', 'contractor_property')`,
  );
  const job = list.find((k) => k.key === 'contractor_job')?.id;
  const property = list.find((k) => k.key === 'contractor_property')?.id;
  if (!job || !property) throw settingUp();
  return { job, property };
}

export type RelationshipKey = 'contractor_customer' | 'contractor_owner' | 'contractor_site';

/** The add-on's relationship types here, by their key in its manifest. */
export async function relationshipTypeIds(ctx: Ctx): Promise<ReadonlyMap<string, string>> {
  const list = await rows<{ id: string; addon_key: string }>(
    ctx.tx,
    sql`select id, addon_key from app.relationship_types
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'contractor' and archived_at is null`,
  );
  return new Map(list.map((t) => [t.addon_key, t.id]));
}

export async function relationshipTypeId(ctx: Ctx, key: RelationshipKey): Promise<string> {
  const id = (await relationshipTypeIds(ctx)).get(key);
  if (!id) throw settingUp();
  return id;
}

/** The business's time zone, for its today. */
export async function timeZoneOf(ctx: Ctx): Promise<string> {
  const [w] = await rows<{ timezone: string }>(
    ctx.tx,
    sql`select timezone from app.workspaces where id = ${ctx.scope.workspaceId!}`,
  );
  return w?.timezone ?? 'America/Chicago';
}

/** The business's settings for the add-on, as stored on its installation. */
export async function settingsOf(ctx: Ctx): Promise<{
  trades: readonly string[];
  phases: readonly string[];
  checklist: readonly StarterItem[];
}> {
  const [i] = await rows<{ settings: Record<string, unknown> | null }>(
    ctx.tx,
    sql`select settings from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'contractor'`,
  );
  const s = i?.settings ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const checklist = z.array(ChecklistStarter).safeParse(s.checklist ?? []);
  return {
    trades: list(s.trades),
    phases: list(s.phases),
    checklist: checklist.success ? checklist.data : [],
  };
}

/** A job as its commands need it: its row and its record's name. */
export interface Job {
  readonly recordId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly archived: boolean;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly statusReason: string | null;
  readonly trade: Trade | null;
  readonly details: string | null;
  readonly startsOn: string | null;
  readonly dueOn: string | null;
  readonly percentDone: number;
  readonly leadUserId: string | null;
}

/** Loads a job of this business, locked for the change when asked; refused as gone when it isn't here. */
export async function loadJob(
  ctx: Ctx,
  jobId: string,
  opts: { readonly lock?: boolean } = {},
): Promise<Job> {
  const lock = opts.lock ? sql` for update of j` : sql``;
  const [j] = await rows<{
    record_id: string;
    workspace_id: string;
    name: string;
    archived: boolean;
    kind: JobKind;
    status: JobStatus;
    status_reason: string | null;
    trade: Trade | null;
    details: string | null;
    starts_on: string | null;
    due_on: string | null;
    percent_done: number;
    lead_user_id: string | null;
  }>(
    ctx.tx,
    sql`select j.record_id, j.workspace_id, r.name, r.archived_at is not null as archived, j.kind, j.status,
          j.status_reason, j.trade, j.details, j.starts_on::text, j.due_on::text, j.percent_done, j.lead_user_id
        from addon_contractor.jobs j
        join app.custom_records r on r.id = j.record_id
        where j.record_id = ${jobId} and j.workspace_id = ${ctx.scope.workspaceId!}${lock}`,
  );
  if (!j) throw HfosError.notFound(REFUSALS.jobGone);
  return {
    recordId: j.record_id,
    workspaceId: j.workspace_id,
    name: j.name,
    archived: j.archived,
    kind: j.kind,
    status: j.status,
    statusReason: j.status_reason,
    trade: j.trade,
    details: j.details,
    startsOn: j.starts_on,
    dueOn: j.due_on,
    percentDone: j.percent_done,
    leadUserId: j.lead_user_id,
  };
}

/** A job's phases, in order. */
export async function phasesOf(ctx: Ctx, jobId: string) {
  return ctx.tx
    .select()
    .from(phases)
    .where(and(eq(phases.recordId, jobId), eq(phases.workspaceId, ctx.scope.workspaceId!)))
    .orderBy(asc(phases.position), asc(phases.createdAt));
}

/**
 * Keeps a job's % done where its rules put it (./progress.ts) after its phases or status change, and says what it
 * is now.
 */
export async function keepPercent(ctx: CommandContext, job: Job): Promise<number> {
  const list = await phasesOf(ctx, job.recordId);
  const [now] = await ctx.tx
    .select({ kind: jobs.kind, status: jobs.status, percentDone: jobs.percentDone })
    .from(jobs)
    .where(eq(jobs.recordId, job.recordId));
  if (!now) return job.percentDone;
  const percent = jobPercent(
    { kind: now.kind, status: now.status, percentDone: now.percentDone },
    list.map((p) => ({ status: p.status as PhaseStatus, percentDone: p.percentDone })),
  );
  if (percent !== now.percentDone)
    await ctx.tx
      .update(jobs)
      .set({ percentDone: percent, updatedAt: new Date() })
      .where(eq(jobs.recordId, job.recordId));
  return percent;
}

/** A line on the job's timeline (and its customer's, when it says so), in the add-on's words. */
export const jobLine = (
  ctx: CommandContext,
  jobId: string,
  words: string,
  more: {
    readonly body?: string | null;
    readonly eventId?: string;
    readonly personId?: string | null;
  } = {},
) =>
  addonTimelineLine(ctx, contractorAddon, {
    customRecordId: jobId,
    personId: more.personId ?? null,
    words,
    body: more.body ?? null,
    eventId: more.eventId ?? null,
  });

/** A person on the business's team, by name ("Dana Reyes", or their email). */
export async function userName(ctx: Ctx, userId: string): Promise<string | null> {
  const [u] = await rows<{ name: string }>(
    ctx.tx,
    sql`select coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name
        from app.users u
        join app.workspace_memberships m on m.user_id = u.id and m.workspace_id = ${ctx.scope.workspaceId!}
        where u.id = ${userId}`,
  );
  return u?.name ?? null;
}

/**
 * Refuses someone who can't be put on a job: not on the business's team, or (when the person asking may see who
 * holds what) without "Use Contractor Operations". An owner holds every permission.
 */
export async function requireCanWork(ctx: Ctx, userId: string): Promise<string> {
  const name = await userName(ctx, userId);
  if (!name) throw HfosError.rule('contractor_not_on_team', 409, REFUSALS.notOnTeam('That person'));
  const held = await rows<{ user_id: string; role: string; permissions: string[] | null }>(
    ctx.tx,
    sql`select user_id, role, permissions from private.workspace_member_permissions(${ctx.scope.workspaceId!}::uuid)`,
  );
  if (!held.length) return name;
  const me = held.find((h) => h.user_id === userId);
  if (!me || (me.role !== 'owner' && !(me.permissions ?? []).includes('contractor.use')))
    throw HfosError.rule('contractor_not_on_team', 409, REFUSALS.notOnTeam(name));
  return name;
}

/** A customer of this business, by name; refused when they aren't here. */
export async function customerName(ctx: Ctx, personId: string): Promise<string> {
  const [p] = await rows<{ name: string }>(
    ctx.tx,
    sql`select coalesce(nullif(btrim(concat_ws(' ', first_name, last_name)), ''), email::text, phone_e164, 'Customer') as name
        from app.people where id = ${personId} and workspace_id = ${ctx.scope.workspaceId!} and archived_at is null`,
  );
  if (!p) throw HfosError.notFound(REFUSALS.customerGone);
  return p.name;
}

/** A property of this business, by its address; refused when it isn't here. */
export async function propertyName(ctx: Ctx, propertyId: string): Promise<string> {
  const kinds = await kindIds(ctx);
  const [r] = await rows<{ name: string }>(
    ctx.tx,
    sql`select name from app.custom_records
        where id = ${propertyId} and workspace_id = ${ctx.scope.workspaceId!} and type_id = ${kinds.property}
          and archived_at is null`,
  );
  if (!r) throw HfosError.notFound(REFUSALS.propertyGone);
  return r.name;
}

/** The pair joining a job to its customer (`contractor_customer`) or its property (`contractor_site`), if any. */
export async function pairsOf(
  ctx: Ctx,
  jobId: string,
): Promise<{
  customer: { id: string; personId: string } | null;
  site: { id: string; propertyId: string } | null;
}> {
  const types = await relationshipTypeIds(ctx);
  const list = await rows<{ id: string; type_id: string; a_id: string; b_id: string }>(
    ctx.tx,
    sql`select id, type_id, a_id, b_id from app.relationships
        where workspace_id = ${ctx.scope.workspaceId!}
          and ((type_id = ${types.get('contractor_customer') ?? null} and b_id = ${jobId})
            or (type_id = ${types.get('contractor_site') ?? null} and a_id = ${jobId}))
        order by created_at`,
  );
  const c = list.find((r) => r.type_id === types.get('contractor_customer'));
  const s = list.find((r) => r.type_id === types.get('contractor_site'));
  return {
    customer: c ? { id: c.id, personId: c.a_id } : null,
    site: s ? { id: s.id, propertyId: s.b_id } : null,
  };
}

/** A subcontractor as the screens show one: a contact, the company they're at, and whether they can be texted. */
export interface SubOut {
  readonly personId: string;
  readonly name: string;
  readonly company: string | null;
  readonly canText: boolean;
  /** For "Hi Dana," in a text to them. */
  readonly firstName: string | null;
}

/** A subcontractor as an operation answers one. */
export const subOut = (s: SubOut) => ({
  personId: s.personId,
  name: s.name,
  company: s.company,
  canText: s.canText,
});

/** These contacts of this business, as subcontractors, by id. One that isn't here (or was archived) is left out. */
export async function subsOf(
  ctx: Ctx,
  personIds: readonly string[],
): Promise<ReadonlyMap<string, SubOut>> {
  if (!personIds.length) return new Map();
  const list = await rows<{
    id: string;
    name: string;
    company: string | null;
    can_text: boolean;
    first_name: string | null;
  }>(
    ctx.tx,
    sql`select p.id, nullif(btrim(p.first_name), '') as first_name,
          coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.email::text, p.phone_e164, 'Contact')
            as name,
          c.name as company, (p.phone_e164 is not null) as can_text
        from app.people p left join app.companies c on c.id = p.company_id
        where p.workspace_id = ${ctx.scope.workspaceId!} and p.archived_at is null
          and p.id = any(${`{${personIds.join(',')}}`}::uuid[])`,
  );
  return new Map(
    list.map((p) => [
      p.id,
      {
        personId: p.id,
        name: p.name,
        company: p.company,
        canText: p.can_text,
        firstName: p.first_name,
      },
    ]),
  );
}
