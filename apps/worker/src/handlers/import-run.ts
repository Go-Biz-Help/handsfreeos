import { eq } from 'drizzle-orm';
import Papa from 'papaparse';
import {
  companyCreate,
  executeCommand,
  findMatches,
  HfosError,
  IMPORT_MAX_ROWS,
  mapCompanyRow,
  mapPersonRow,
  normalizePhone,
  otherEmailsOf,
  otherPhonesOf,
  personCreate,
  personUpdate,
  companyUpdate,
  tagCreate,
  type RequestMeta,
  type SystemActor,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { importErrors, imports } from '@hfos/db/schema';
import { recordSystemEvent } from '../system-event';
import { assertInWorkspace } from './file-removed';
import type { HandlerContext } from './types';

export const IMPORT_BATCH_SIZE = 100;
const ERROR_CAP = 1000;
/** A running import whose heartbeat is older than this was abandoned by a crashed worker and may be resumed. */
const STALE = '5 minutes';

type Outcome = 'created' | 'updated' | 'skipped';
type Job = {
  id: string;
  kind: 'people' | 'companies';
  file_name: string;
  object_path: string;
  mapping: Record<string, string>;
  options: { onMatch?: 'skip' | 'update' };
  processed_rows: number;
  error_count: number;
  created_by: string | null;
};

/** `import.requested`: runs the CSV through the same commands a person would use, in batches, resumably. */
export async function onImportRequested(ctx: HandlerContext): Promise<void> {
  await runImport(ctx, { batchSize: IMPORT_BATCH_SIZE });
}

export async function runImport(
  ctx: HandlerContext,
  opts: { batchSize: number },
): Promise<'done' | 'cancelled' | 'not_claimed' | 'failed'> {
  const importId = ctx.event.entityId;
  const workspaceId = ctx.event.workspaceId;
  const organizationId = ctx.event.organizationId;
  if (!importId || !workspaceId || !organizationId) throw new Error('import event without ids');
  const transact = <T>(fn: (tx: Tx) => Promise<T>) => asWorker(ctx.db, ctx.scope, fn);

  // Claim: pending, or running with a stale heartbeat (a second claim while alive is a no-op).
  const [job] = await transact((tx) =>
    rows<Job>(
      tx,
      sql`update app.imports
          set status = 'running', started_at = coalesce(started_at, now()), heartbeat_at = now(), last_error = null
          where id = ${importId} and workspace_id = ${workspaceId}
            and (status = 'pending' or (status = 'running' and coalesce(heartbeat_at, started_at, created_at) < now() - ${STALE}::interval))
          returning id, kind, file_name, object_path, mapping, options, processed_rows, error_count, created_by`,
    ),
  );
  if (!job) {
    ctx.log.info({ importId }, 'import not claimable (already running, finished or cancelled)');
    return 'not_claimed';
  }
  const actor: SystemActor = {
    type: 'system',
    workspaceId,
    organizationId,
    onBehalfOf: job.created_by,
  };
  const meta: RequestMeta = {
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
    channel: 'worker',
  };
  const onMatch = job.options.onMatch ?? 'skip';

  try {
    assertInWorkspace(job.object_path, workspaceId);
    const text = (await ctx.store.download('imports', job.object_path))
      .toString('utf8')
      .replace(/^\uFEFF/, '');
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      // Lines with nothing at all are dropped; a row of empty cells is kept and counted as skipped, so row
      // numbers in the error table match the spreadsheet.
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });
    const data = parsed.data;
    if (data.length > IMPORT_MAX_ROWS)
      throw new Error(`The file has ${data.length} rows; the limit is ${IMPORT_MAX_ROWS}.`);
    await transact((tx) =>
      tx
        .update(imports)
        .set({ totalRows: data.length, heartbeatAt: new Date() })
        .where(eq(imports.id, importId)),
    );

    const companyCache = new Map<string, string>();
    const tagCache = new Map<string, string>();
    for (const t of await transact((tx) =>
      rows<{ id: string; name: string }>(
        tx,
        sql`select id, name::text as name from app.tags where workspace_id = ${workspaceId}`,
      ),
    ))
      tagCache.set(t.name.toLowerCase(), t.id);

    const resolveTags = async (names: string[]): Promise<string[]> => {
      const ids: string[] = [];
      for (const name of names) {
        const key = name.toLowerCase();
        let id = tagCache.get(key);
        if (!id) {
          const out = await executeCommand(ctx.db, tagCreate, { workspaceId, name }, actor, meta);
          id = out.output.tagId;
          tagCache.set(key, id);
        }
        ids.push(id);
      }
      return ids;
    };
    const resolveCompany = async (name: string): Promise<string> => {
      const key = name.toLowerCase();
      const cached = companyCache.get(key);
      if (cached) return cached;
      const matches = await transact((tx) => findMatches(tx, workspaceId, 'company', { name }));
      let id = matches[0]?.id;
      if (!id) {
        const out = await executeCommand(
          ctx.db,
          companyCreate,
          { workspaceId, name, ignoreDuplicates: true },
          actor,
          meta,
        );
        id = out.output.companyId;
      }
      companyCache.set(key, id);
      return id;
    };

    /**
     * A matched record's other emails and numbers with the file's added to them (0100): an import that updates a
     * customer adds what it brings and never drops what the business had. Nothing when the file brings none.
     */
    const withOthers = async (
      table: 'people' | 'companies',
      id: string,
      m: { otherEmails: string[]; otherPhones: string[] },
    ) => {
      if (!m.otherEmails.length && !m.otherPhones.length) return {};
      const [had] = await transact((tx) =>
        rows<{ other_emails: unknown; other_phones: unknown }>(
          tx,
          table === 'people'
            ? sql`select other_emails, other_phones from app.people where id = ${id}`
            : sql`select other_emails, other_phones from app.companies where id = ${id}`,
        ),
      );
      return {
        ...(m.otherEmails.length
          ? {
              otherEmails: [
                ...otherEmailsOf(had?.other_emails),
                ...m.otherEmails.map((email) => ({ email })),
              ],
            }
          : {}),
        ...(m.otherPhones.length
          ? {
              otherPhones: [
                ...otherPhonesOf(had?.other_phones),
                ...m.otherPhones.map((phone) => ({ phone })),
              ],
            }
          : {}),
      };
    };

    const processRow = async (raw: Record<string, string>, importRow: number): Promise<Outcome> => {
      if (job.kind === 'people') {
        const m = mapPersonRow(raw, job.mapping);
        if (!m.firstName && !m.lastName && !m.email && !m.phone) return 'skipped';
        const [already] = await transact((tx) =>
          rows<{ id: string }>(
            tx,
            sql`select id from app.people where import_id = ${importId} and import_row = ${importRow}`,
          ),
        );
        if (already) return 'created';
        const phoneE164 = m.phone ? normalizePhone(m.phone) : null;
        const matches = await transact((tx) =>
          findMatches(tx, workspaceId, 'person', { email: m.email, phoneE164 }),
        );
        const fields = {
          firstName: m.firstName,
          lastName: m.lastName,
          email: m.email,
          phone: m.phone,
          address: m.address,
          notes: m.notes,
          source: m.source,
        };
        if (matches[0]) {
          if (onMatch === 'skip') return 'skipped';
          const patch = Object.fromEntries(
            Object.entries(fields).filter(([k, v]) => v !== null && v !== '' && k !== 'address'),
          );
          const address = Object.fromEntries(Object.entries(m.address).filter(([, v]) => v));
          await executeCommand(
            ctx.db,
            personUpdate,
            {
              workspaceId,
              personId: matches[0].id,
              ...patch,
              ...(Object.keys(address).length ? { address } : {}),
              ...(await withOthers('people', matches[0].id, m)),
              ...(m.company ? { companyId: await resolveCompany(m.company) } : {}),
            },
            actor,
            meta,
          );
          return 'updated';
        }
        await executeCommand(
          ctx.db,
          personCreate,
          {
            workspaceId,
            ...fields,
            otherEmails: m.otherEmails.map((email) => ({ email })),
            otherPhones: m.otherPhones.map((phone) => ({ phone })),
            companyId: m.company ? await resolveCompany(m.company) : null,
            tagIds: await resolveTags(m.tags),
            ignoreDuplicates: true,
            importId,
            importRow,
          },
          actor,
          meta,
        );
        return 'created';
      }
      const m = mapCompanyRow(raw, job.mapping);
      if (!m.name && !m.email && !m.phone) return 'skipped';
      const [already] = await transact((tx) =>
        rows<{ id: string }>(
          tx,
          sql`select id from app.companies where import_id = ${importId} and import_row = ${importRow}`,
        ),
      );
      if (already) return 'created';
      const phoneE164 = m.phone ? normalizePhone(m.phone) : null;
      const matches = await transact((tx) =>
        findMatches(tx, workspaceId, 'company', { email: m.email, phoneE164, name: m.name }),
      );
      const fields = {
        name: m.name,
        email: m.email,
        phone: m.phone,
        website: m.website,
        address: m.address,
        notes: m.notes,
        source: m.source,
      };
      if (matches[0]) {
        if (onMatch === 'skip') return 'skipped';
        const patch = Object.fromEntries(
          Object.entries(fields).filter(([k, v]) => v !== null && v !== '' && k !== 'address'),
        );
        const address = Object.fromEntries(Object.entries(m.address).filter(([, v]) => v));
        await executeCommand(
          ctx.db,
          companyUpdate,
          {
            workspaceId,
            companyId: matches[0].id,
            ...patch,
            ...(Object.keys(address).length ? { address } : {}),
            ...(await withOthers('companies', matches[0].id, m)),
          },
          actor,
          meta,
        );
        return 'updated';
      }
      await executeCommand(
        ctx.db,
        companyCreate,
        {
          workspaceId,
          ...fields,
          otherEmails: m.otherEmails.map((email) => ({ email })),
          otherPhones: m.otherPhones.map((phone) => ({ phone })),
          tagIds: await resolveTags(m.tags),
          ignoreDuplicates: true,
          importId,
          importRow,
        },
        actor,
        meta,
      );
      return 'created';
    };

    let errorCount = job.error_count;
    for (let start = job.processed_rows; start < data.length; start += opts.batchSize) {
      const batch = data.slice(start, start + opts.batchSize);
      const counts = { created: 0, updated: 0, skipped: 0, errors: 0 };
      const failures: { rowNumber: number; message: string; raw: Record<string, string> }[] = [];
      for (const [i, raw] of batch.entries()) {
        const importRow = start + i + 1;
        try {
          counts[await processRow(raw, importRow)]++;
        } catch (e) {
          counts.errors++;
          errorCount++;
          if (errorCount <= ERROR_CAP)
            failures.push({ rowNumber: importRow + 1, message: describeError(e), raw });
        }
      }
      const status = await transact(async (tx) => {
        if (failures.length)
          await tx.insert(importErrors).values(
            failures.map((f) => ({
              importId,
              workspaceId,
              rowNumber: f.rowNumber,
              message: f.message,
              raw: f.raw,
            })),
          );
        const processed = start + batch.length;
        const [row] = await rows<{ status: string }>(
          tx,
          sql`update app.imports
              set processed_rows = ${processed}, created_count = created_count + ${counts.created},
                  updated_count = updated_count + ${counts.updated}, skipped_count = skipped_count + ${counts.skipped},
                  error_count = error_count + ${counts.errors}, heartbeat_at = now()
              where id = ${importId} returning status`,
        );
        await recordSystemEvent(tx, {
          type: 'import.progressed',
          action: 'import.progress',
          organizationId,
          workspaceId,
          entityType: 'import',
          entityId: importId,
          payload: { processedRows: processed, totalRows: data.length },
          after: { fileName: job.file_name, processedRows: processed, totalRows: data.length },
          correlationId: ctx.event.correlationId,
          causationId: ctx.event.id,
        });
        return row?.status ?? 'running';
      });
      if (status === 'cancelled') {
        ctx.log.info(
          { importId, processed: start + batch.length },
          'import cancelled between batches',
        );
        await ctx.store.remove('imports', job.object_path);
        return 'cancelled';
      }
    }

    await transact(async (tx) => {
      const [final] = await rows<{
        created_count: number;
        updated_count: number;
        skipped_count: number;
        error_count: number;
      }>(
        tx,
        sql`update app.imports set status = 'done', finished_at = now(), heartbeat_at = now()
            where id = ${importId} and status = 'running'
            returning created_count, updated_count, skipped_count, error_count`,
      );
      if (!final) return;
      await recordSystemEvent(tx, {
        type: 'import.finished',
        action: 'import.finish',
        organizationId,
        workspaceId,
        entityType: 'import',
        entityId: importId,
        payload: { fileName: job.file_name, kind: job.kind, ...final },
        after: {
          fileName: job.file_name,
          kind: job.kind,
          created: final.created_count,
          updated: final.updated_count,
          skipped: final.skipped_count,
          errors: final.error_count,
        },
        correlationId: ctx.event.correlationId,
        causationId: ctx.event.id,
      });
    });
    await ctx.store.remove('imports', job.object_path);
    return 'done';
  } catch (e) {
    const message = describeError(e);
    const giveUp = ctx.attempt >= ctx.maxAttempts;
    ctx.log.warn({ importId, attempt: ctx.attempt, giveUp, err: message }, 'import run failed');
    await transact((tx) =>
      tx
        .update(imports)
        .set(
          giveUp
            ? { status: 'failed', lastError: message.slice(0, 2000), finishedAt: new Date() }
            : { status: 'pending', lastError: message.slice(0, 2000) },
        )
        .where(eq(imports.id, importId)),
    );
    if (giveUp) return 'failed';
    throw e;
  }
}

/** Plain-English row error: validation details become "field: message". */
export function describeError(e: unknown): string {
  if (e instanceof HfosError) {
    if (e.code === 'validation' && Array.isArray(e.details))
      return (e.details as { path?: unknown; message?: unknown }[])
        .map(
          (d) =>
            `${String(d.path ?? '').replace(/^\//, '') || 'row'}: ${String(d.message ?? 'invalid')}`,
        )
        .join('; ');
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
