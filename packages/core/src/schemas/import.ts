import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { UserRef } from './crm';

export const importKind = z.enum(['people', 'companies']);
export const importStatus = z.enum(['pending', 'running', 'done', 'failed', 'cancelled']);
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 20_000;

export const ImportCreateInput = z.object({
  workspaceId: uuid,
  kind: importKind,
  fileName: z.string().trim().min(1).max(200),
});
export const ImportCreateOutput = z.object({
  importId: uuid,
  bucket: z.string(),
  objectPath: z.string(),
});

export const ImportOptions = z.object({ onMatch: z.enum(['skip', 'update']).default('skip') });
export const ImportStartInput = z.object({
  workspaceId: uuid,
  importId: uuid,
  /** CSV column header → field key (see crm/import-mapping). */
  mapping: z.record(z.string().max(200), z.string().max(40)),
  options: ImportOptions.default({ onMatch: 'skip' }),
});
export const ImportStartOutput = z.object({ importId: uuid });
export const ImportCancelInput = z.object({ workspaceId: uuid, importId: uuid });
export const ImportCancelOutput = z.object({ importId: uuid, status: importStatus });

export const ImportOut = z.object({
  id: uuid,
  kind: importKind,
  fileName: z.string(),
  status: importStatus,
  mapping: z.record(z.string(), z.string()),
  options: ImportOptions,
  totalRows: z.number().int(),
  processedRows: z.number().int(),
  createdCount: z.number().int(),
  updatedCount: z.number().int(),
  skippedCount: z.number().int(),
  errorCount: z.number().int(),
  lastError: z.string().nullable(),
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  createdBy: UserRef,
  createdAt: isoDateTime,
});
export const ImportGetInput = z.object({ workspaceId: uuid, importId: uuid });
export const ImportGetOutput = z.object({
  import: ImportOut,
  errors: z.array(
    z.object({
      rowNumber: z.number().int(),
      message: z.string(),
      raw: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
});
export const ImportListInput = z.object({ workspaceId: uuid });
export const ImportListOutput = z.object({ imports: z.array(ImportOut) });
