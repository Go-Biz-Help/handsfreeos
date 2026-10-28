import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { imports } from '@hfos/db/schema';
import { COMPANY_FIELDS, PERSON_FIELDS, SKIP } from '../crm/import-mapping';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  ImportCancelInput,
  ImportCancelOutput,
  ImportCreateInput,
  ImportCreateOutput,
  ImportStartInput,
  ImportStartOutput,
} from '../schemas/import';

export const importCreate = defineCommand({
  name: 'import.create',
  description:
    'Reserve an import. Upload the CSV to the returned path, then start it with a column mapping.',
  risk: 1,
  input: ImportCreateInput,
  output: ImportCreateOutput,
  permission: 'records.import',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: [],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const importId = randomUUID();
    const objectPath = `${workspaceId}/${importId}.csv`;
    const [row] = await ctx.tx
      .insert(imports)
      .values({
        id: importId,
        workspaceId,
        kind: input.kind,
        fileName: input.fileName,
        objectPath,
        createdBy: requireHuman(ctx).userId,
      })
      .returning({ id: imports.id });
    if (!row) throw HfosError.forbidden();
    return { importId, bucket: 'imports', objectPath };
  },
});

const IMPORT_GONE = 'That import isn’t there anymore. Refresh Settings → Imports and try again.';

export const importStart = defineCommand({
  name: 'import.start',
  description: 'Start a reserved import with the column mapping and how to treat matches.',
  risk: 3,
  input: ImportStartInput,
  output: ImportStartOutput,
  permission: 'records.import',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['import.requested'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(imports)
      .where(and(eq(imports.id, input.importId), eq(imports.workspaceId, ctx.scope.workspaceId!)));
    if (!current) throw HfosError.notFound(IMPORT_GONE);
    if (current.status !== 'pending')
      throw HfosError.rule(
        'import_not_ready',
        409,
        `The import of ${current.fileName} has already started. Refresh Settings → Imports to see how it’s going.`,
      );
    if (current.createdBy !== requireHuman(ctx).userId)
      throw HfosError.forbidden(
        'Only the person who uploaded this spreadsheet can start its import. Ask them to start it, or upload it again yourself.',
      );
    const allowed = new Set<string>([
      ...(current.kind === 'people' ? PERSON_FIELDS : COMPANY_FIELDS),
      SKIP,
    ]);
    for (const [column, field] of Object.entries(input.mapping)) {
      if (!allowed.has(field))
        throw HfosError.validation([
          { path: `mapping.${column}`, message: 'Pick a field from the list for this column.' },
        ]);
    }
    const mapped = new Set(Object.values(input.mapping).filter((f) => f !== SKIP));
    if (
      current.kind === 'people' &&
      !mapped.has('first_name') &&
      !mapped.has('last_name') &&
      !mapped.has('full_name')
    )
      throw HfosError.validation([{ path: 'mapping', message: 'Map a name column.' }]);
    if (current.kind === 'companies' && !mapped.has('name'))
      throw HfosError.validation([{ path: 'mapping', message: 'Map the company name column.' }]);
    if (
      mapped.has('call_consent') &&
      !mapped.has('call_consent_source') &&
      !input.options.callConsentSource
    )
      throw HfosError.validation([
        {
          path: 'options.callConsentSource',
          message:
            'Say where these people agreed to calls in writing, like “Website form, Oct 2026”, or map a “Where they agreed to calls” column.',
        },
      ]);
    const [info] = await rows<{ size_bytes: number | null }>(
      ctx.tx,
      sql`select size_bytes from private.storage_object_info('imports', ${current.objectPath})`,
    );
    if (!info)
      throw HfosError.rule(
        'import_not_ready',
        409,
        `${current.fileName} didn’t finish uploading. Upload it again, then start the import.`,
      );
    await ctx.tx
      .update(imports)
      .set({ mapping: input.mapping, options: input.options })
      .where(eq(imports.id, current.id));
    await ctx.emit({
      type: 'import.requested',
      entityType: 'import',
      entityId: current.id,
      payload: {
        importId: current.id,
        kind: current.kind,
        fileName: current.fileName,
        sizeBytes: Number(info.size_bytes ?? 0),
      },
      after: {
        fileName: current.fileName,
        kind: current.kind,
        onMatch: input.options.onMatch,
        columns: Object.keys(input.mapping).length,
        ...(mapped.has('call_consent') ? { callConsent: true } : {}),
      },
    });
    return { importId: current.id };
  },
});

export const importCancel = defineCommand({
  name: 'import.cancel',
  description: 'Stop an import that is pending or running. Rows already imported stay.',
  risk: 2,
  input: ImportCancelInput,
  output: ImportCancelOutput,
  permission: 'records.import',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['import.cancelled'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(imports)
      .where(and(eq(imports.id, input.importId), eq(imports.workspaceId, ctx.scope.workspaceId!)));
    if (!current) throw HfosError.notFound(IMPORT_GONE);
    if (current.status !== 'pending' && current.status !== 'running')
      return { importId: current.id, status: current.status };
    await ctx.tx
      .update(imports)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(imports.id, current.id));
    await ctx.emit({
      type: 'import.cancelled',
      entityType: 'import',
      entityId: current.id,
      payload: { fileName: current.fileName },
      before: { status: current.status },
      after: { status: 'cancelled' },
    });
    return { importId: current.id, status: 'cancelled' as const };
  },
});
