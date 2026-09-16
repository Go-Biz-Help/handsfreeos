/**
 * A business for the Action Center's worker tests (M8 step 4): booking-world's (an owner who works every hour,
 * texting ready, quiet hours off), open around the clock unless a test says otherwise, and a member to assign to.
 * Plus the helpers to file customers and leads the way the worker or a person would, to read items and the events the
 * worker recorded about them, and to run the sweep and the plan as the worker does.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  ALWAYS_OPEN_HOURS,
  executeCommand,
  leadCreate,
  personCreate,
  phoneUpdateSettings,
  workspaceUpdate,
  type CommandDef,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { attentionItems } from '@hfos/db/schema';
import { createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { expect } from 'vitest';
import type { z } from 'zod';
import { ATTENTION_JOBS, ensureSweeps, sweepJobKey } from '../src/attention/index';
import { processJobs } from '../src/jobs';
import { jobs } from '../src/scheduled';
import { systemActor } from '../src/services';
import {
  admin,
  CHI,
  drain,
  iso,
  makeWorld,
  nextPhone,
  readyTexting,
  run,
  type World,
} from './booking-world';

export const DAY = 86_400_000;

export interface AttentionWorld extends World {
  /** Marco, a member: someone to assign to. */
  readonly member: TestUser;
}

export async function attentionWorld(label: string): Promise<AttentionWorld> {
  const w = await makeWorld(label);
  await readyTexting(w);
  const member = await createTestUser(`${label}-marco`, { fullName: 'Marco Member' });
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  await setOpenHours(w, ALWAYS_OPEN_HOURS);
  return Object.assign(w, { member });
}

/** The business's open hours (the unanswered lead's 15 minutes count only these). */
export const setOpenHours = (w: World, openHours: unknown) =>
  run(w, workspaceUpdate, { workspaceId: w.workspaceId, settings: { openHours } });

/** How long a customer's message may wait for a reply (0: a waiting customer is listed at once, never urgent). */
export const setReplyThreshold = (w: World, minutes: number) =>
  run(w, phoneUpdateSettings, { workspaceId: w.workspaceId, unansweredReminderMinutes: minutes });

/** A command as HandsFreeOS (the worker's system actor): a web form's lead, a customer a text filed. */
export function sys<I extends z.ZodType, O extends z.ZodType>(
  w: World,
  cmd: CommandDef<I, O>,
  input: unknown,
): Promise<z.output<O>> {
  return executeCommand(
    testDbs().worker.db,
    cmd,
    input,
    systemActor({ workspaceId: w.workspaceId, organizationId: w.organizationId }),
    { correlationId: randomUUID(), channel: 'worker' },
  ).then((r) => r.output);
}

/** A customer HandsFreeOS filed (nobody on the team typed them in), with a mobile number. */
export async function filedCustomer(
  w: World,
  first: string,
): Promise<{ id: string; phone: string }> {
  const phone = nextPhone();
  const { personId } = await sys(w, personCreate, {
    workspaceId: w.workspaceId,
    firstName: first,
    lastName: 'Test',
    phone,
    ignoreDuplicates: true,
  });
  return { id: personId, phone };
}

/** Moves a lead's clock back (it came in, and entered its stage, that long ago). No event. */
export async function backdate(leadId: string, minutes: number): Promise<void> {
  const by = `${minutes} minutes`;
  await rows(
    admin(),
    sql`update app.leads set created_at = created_at - ${by}::interval,
          stage_entered_at = stage_entered_at - ${by}::interval
        where id = ${leadId}`,
  );
}

/** A lead that came in on its own (a web form), `minutesAgo` minutes ago. Its events wait for the next drain. */
export async function inboundLead(
  w: World,
  personId: string,
  title: string,
  minutesAgo = 0,
): Promise<string> {
  const { leadId } = await sys(w, leadCreate, { workspaceId: w.workspaceId, title, personId });
  if (minutesAgo) await backdate(leadId, minutesAgo);
  return leadId;
}

/** A lead the owner typed in (never unanswered or hot on that alone), `daysAgo` days ago, maybe with a next action. */
export async function typedLead(
  w: World,
  personId: string,
  title: string,
  opts: { readonly daysAgo?: number; readonly nextActionInDays?: number } = {},
): Promise<string> {
  const { leadId } = await run(w, leadCreate, {
    workspaceId: w.workspaceId,
    title,
    personId,
    ...(opts.nextActionInDays
      ? {
          nextAction: 'Check in about the quote',
          nextActionAt: iso(Date.now() + opts.nextActionInDays * DAY),
        }
      : {}),
  });
  if (opts.daysAgo) await backdate(leadId, opts.daysAgo * 24 * 60);
  return leadId;
}

export type ItemRow = typeof attentionItems.$inferSelect;

export const itemsOf = (w: World, subjectIds: readonly string[]): Promise<ItemRow[]> =>
  admin()
    .select()
    .from(attentionItems)
    .where(
      and(
        eq(attentionItems.workspaceId, w.workspaceId),
        inArray(attentionItems.subjectId, [...subjectIds]),
      ),
    );

export async function itemOf(w: World, subjectId: string, kind: string): Promise<ItemRow> {
  const found = (await itemsOf(w, [subjectId])).find((i) => i.kind === kind);
  expect(found, `a ${kind} item for ${subjectId}`).toBeDefined();
  return found!;
}

export const codes = (item: ItemRow): string[] =>
  (item.reasons as { code: string }[]).map((c) => c.code);

/**
 * What the worker recorded about an item: the attention_item.* events' last words, sorted (events written in one
 * transaction share their time, so their order isn't kept).
 */
export async function itemEvents(itemId: string): Promise<string[]> {
  const list = await rows<{ event_type: string }>(
    admin(),
    sql`select event_type from app.events
        where entity_type = 'attention_item' and entity_id = ${itemId} and event_type like 'attention_item.%'`,
  );
  return list.map((e) => e.event_type.slice('attention_item.'.length)).sort();
}

/** Runs the business's sweep job as of `at` (the job the plan makes, made first if none is waiting), then the outbox. */
export async function runSweep(w: World, at: number = Date.now()): Promise<void> {
  await asWorker(w.s.db, {}, (tx) =>
    ensureSweeps(
      tx,
      [{ workspaceId: w.workspaceId, organizationId: w.organizationId, timeZone: CHI }],
      at,
    ),
  );
  const runner = `sweep-${w.workerId}`;
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner}
        where kind = ${ATTENTION_JOBS.sweep} and dedupe_key = ${sweepJobKey(w.workspaceId)}
          and status = 'pending'`,
  );
  const ran = await processJobs({
    ...w.s,
    jobs,
    workerId: runner,
    batchSize: 5,
    reservedOnly: true,
    clock: () => at,
  });
  expect(ran).toMatchObject({ claimed: 1, done: 0, rescheduled: 1, failed: 0, retried: 0 });
  await drain(w);
}

/** Runs the global plan once, as its hourly job would (under a key of its own, so a real one waiting is left alone). */
export async function runPlan(w: World): Promise<void> {
  const runner = `plan-${w.workerId}`;
  await rows(
    admin(),
    sql`insert into app.scheduled_jobs (kind, dedupe_key, run_at, payload, locked_at, locked_by)
        values (${ATTENTION_JOBS.plan}, ${`plan:attention:test:${randomUUID()}`}, now(), '{}'::jsonb,
          now(), ${runner})`,
  );
  const ran = await processJobs({
    ...w.s,
    jobs,
    workerId: runner,
    batchSize: 5,
    reservedOnly: true,
  });
  expect(ran).toMatchObject({ claimed: 1, failed: 0, retried: 0 });
}

/** The business's sweeps waiting. */
export const pendingSweeps = (w: World) =>
  rows<{ id: string; run_at: Date }>(
    admin(),
    sql`select id, run_at from app.scheduled_jobs
        where kind = ${ATTENTION_JOBS.sweep} and workspace_id = ${w.workspaceId} and status = 'pending'`,
  );
