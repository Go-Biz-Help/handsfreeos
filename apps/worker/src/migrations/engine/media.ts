/**
 * Copying the files across.
 *
 * A record that points at the old system's storage is not history, it is a rented photograph. The link works
 * while the account is open, needs that account's own sign-in, and goes dark the day the business cancels —
 * which is the day after we told them they could. So every photo somebody texted, every call recording and
 * every attachment is fetched and written into this system's own storage, and the record is repointed at our
 * copy. What cannot be fetched is said plainly rather than left as an image that will not load.
 *
 * The work is listed by the importers, inside the transaction that writes the record, and done here
 * afterwards in small batches: a download does not belong in a transaction that holds a row lock.
 */
import { createHash } from 'node:crypto';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { CrmSourceAdapter, SourceConnection, SourceScope } from '@hfos/core/server';
import type { Logger } from 'pino';
import { SafeFetchError, type SafeFetch } from '../../http/safe-fetch';
import type { ObjectStore } from '../../storage';

/** The bucket texts' photos, call recordings and mail attachments live in, the same one they arrive in. */
const BUCKET = 'telephony';
/** Files this size and under are copied. Above it the record says where it was instead of holding a half file. */
const MAX_BYTES = 25 * 1024 * 1024;
/** Long enough for a recording on a slow morning, short enough that a lease outlives the batch. */
const FETCH_TIMEOUT_MS = 45_000;
/** Files copied per batch. The job is put back for the next one until none are left. */
export const MEDIA_BATCH = 10;
/** Tries before a file is left alone. A link that is gone does not get better by being asked five times. */
const MAX_TRIES = 4;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'text/vcard': 'vcf',
};

export interface MediaDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly store: ObjectStore;
  readonly fetchUrl: SafeFetch;
}

export interface MediaJobScope {
  readonly migrationId: string;
  readonly organizationId: string;
  readonly scopeId: string;
  readonly workspaceId: string;
}

export interface MediaBatchResult {
  readonly copied: number;
  readonly reused: number;
  readonly missing: number;
  readonly skipped: number;
  readonly failed: number;
  /** True when this batch emptied the list, so the job is done rather than put back. */
  readonly done: boolean;
}

type MediaRow = {
  id: string;
  source_object_type: string;
  source_object_id: string;
  source_locator: string;
  file_name: string | null;
  declared_mime: string | null;
  attempts: number;
};

/** A file name a storage path can hold, and a person can still read. */
const safeName = (name: string): string =>
  name
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .trim()
    .slice(0, 100) || 'file';

/** The bare type, without the charset the server tacked on. */
const bareMime = (value: string | null | undefined): string | null => {
  const bare = (value ?? '').split(';')[0]?.trim().toLowerCase();
  return bare && bare.length <= 200 ? bare : null;
};

/**
 * What the file is. The server's word first — unless its word is "some bytes", which is what a bucket says
 * about a call recording it was never told the type of (the first real account's .wav recordings all came
 * back as `application/octet-stream`, and were kept as that, so nothing would play them). Then what its
 * name says, then what the old system said it was.
 */
const mimeOf = (
  header: string | null | undefined,
  declared: string | null | undefined,
  locator: string,
): string | null => {
  const said = bareMime(header);
  if (said && said !== 'application/octet-stream' && said !== 'binary/octet-stream') return said;
  const fromPath = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(locator)?.[1]?.toLowerCase();
  const byExtension = fromPath
    ? Object.entries(EXTENSIONS).find(([, ext]) => ext === fromPath)?.[0]
    : undefined;
  // The name before the label: the importer labels every recording an mp3, and some of them are .wav.
  return byExtension ?? bareMime(declared) ?? said;
};

const extensionFor = (mime: string | null, locator: string): string => {
  if (mime && EXTENSIONS[mime]) return EXTENSIONS[mime]!;
  const fromPath = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(locator)?.[1]?.toLowerCase();
  return fromPath ?? 'bin';
};

/** What to call it in the timeline when the old system did not say. */
const nameFor = (row: MediaRow, mime: string | null, ext: string): string => {
  if (row.file_name) return safeName(row.file_name);
  const kind = mime?.startsWith('image/')
    ? 'photo'
    : mime?.startsWith('video/')
      ? 'video'
      : mime?.startsWith('audio/')
        ? 'recording'
        : 'attachment';
  return `${kind}.${ext}`;
};

/**
 * One batch of files: claim a few, fetch each one, store it, and point the record at the copy.
 *
 * Claiming marks the rows `copying` in their own transaction, so two workers never fetch the same file, and
 * a worker that dies leaves rows that the next claim picks up once they have gone stale.
 */
export async function copyMediaBatch(
  deps: MediaDeps,
  scope: MediaJobScope,
  source: {
    readonly adapter: CrmSourceAdapter;
    readonly connection: SourceConnection;
    readonly sourceScope: SourceScope;
  },
  limit = MEDIA_BATCH,
): Promise<MediaBatchResult> {
  const claimed = await asWorker(
    deps.db,
    { workspaceId: scope.workspaceId, organizationId: scope.organizationId },
    (tx) =>
      rows<MediaRow>(
        tx,
        sql`update app.migration_media m
               set state = 'copying', attempts = m.attempts + 1
             where m.id in (
               select id from app.migration_media
                where migration_id = ${scope.migrationId} and scope_id = ${scope.scopeId}
                  and attempts < ${MAX_TRIES}
                  and (state = 'pending'
                       -- A worker that died mid-copy left this behind; nobody else is holding it now.
                       or (state = 'copying' and updated_at < now() - interval '10 minutes'))
                order by created_at, id
                limit ${limit}
                for update skip locked)
            returning m.id::text as id, m.source_object_type, m.source_object_id, m.source_locator,
              m.file_name, m.declared_mime, m.attempts`,
      ),
  );

  let copied = 0;
  let reused = 0;
  let missing = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      const outcome = await copyOne(deps, scope, source, row);
      if (outcome === 'copied') copied += 1;
      else if (outcome === 'reused') reused += 1;
      else if (outcome === 'missing') missing += 1;
      else skipped += 1;
    } catch (e) {
      failed += 1;
      await giveUpOrRetry(deps, scope, row, e as Error);
    }
  }

  const [left] = await asWorker(
    deps.db,
    { workspaceId: scope.workspaceId, organizationId: scope.organizationId },
    (tx) =>
      rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from app.migration_media
             where migration_id = ${scope.migrationId} and scope_id = ${scope.scopeId}
               and state = 'pending' and attempts < ${MAX_TRIES}`,
      ),
  );
  return { copied, reused, missing, skipped, failed, done: (left?.count ?? 0) === 0 };
}

type CopyOutcome = 'copied' | 'reused' | 'missing' | 'skipped';

async function copyOne(
  deps: MediaDeps,
  scope: MediaJobScope,
  source: {
    readonly adapter: CrmSourceAdapter;
    readonly connection: SourceConnection;
    readonly sourceScope: SourceScope;
  },
  row: MediaRow,
): Promise<CopyOutcome> {
  // Which record will point at this, and does it still exist? Asked first: a file whose record never
  // arrived is not worth a download.
  const target = await targetOf(deps, scope, row);
  if (!target)
    return settle(deps, scope, row, 'skipped', 'The record this belongs to is not here.');

  const headers = source.adapter.mediaAuth?.(
    source.connection,
    source.sourceScope,
    row.source_locator,
  );
  let res;
  try {
    res = await deps.fetchUrl(row.source_locator, {
      headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      binary: true,
      maxBytes: MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (e) {
    // An address we will never be allowed to fetch is not worth four tries.
    if (e instanceof SafeFetchError && e.code !== 'timeout' && e.code !== 'network')
      return settle(deps, scope, row, 'skipped', e.message);
    throw e;
  }
  if (res.status === 404 || res.status === 410)
    return settle(deps, scope, row, 'missing', 'The old system no longer has this file.');
  if (res.status < 200 || res.status >= 300)
    throw new Error(`the old system answered ${res.status} for a file`);
  if (res.truncated)
    return settle(
      deps,
      scope,
      row,
      'skipped',
      `Bigger than ${Math.round(MAX_BYTES / (1024 * 1024))} MB, so it stayed where it was.`,
    );
  if (res.bytes.length === 0)
    return settle(deps, scope, row, 'missing', 'The file came back empty.');

  const detected = mimeOf(res.headers['content-type'], row.declared_mime, row.source_locator);
  const ext = extensionFor(detected, row.source_locator);
  const name = nameFor(row, detected, ext);
  const checksum = createHash('sha256').update(res.bytes).digest('hex');

  // The same bytes under two records — a photo sent to two people — is one copy in storage and two
  // references to it.
  const existing = await asWorker(
    deps.db,
    { workspaceId: scope.workspaceId, organizationId: scope.organizationId },
    (tx) =>
      rows<{ bucket: string; object_path: string }>(
        tx,
        sql`select bucket, object_path from app.migration_media
             where workspace_id = ${scope.workspaceId} and checksum = ${checksum}
               and state = 'stored' and bucket is not null and object_path is not null
             limit 1`,
      ),
  );
  const shared = existing[0];
  const objectPath =
    shared?.object_path ??
    (target.kind === 'call'
      ? `${scope.workspaceId}/calls/${target.id}/${target.isVoicemail ? 'voicemail' : 'recording'}.${ext}`
      : `${scope.workspaceId}/messages/${target.id}/${checksum.slice(0, 12)}.${ext}`);
  if (!shared)
    await deps.store.upload(BUCKET, objectPath, res.bytes, detected ?? 'application/octet-stream', {
      upsert: true,
    });

  await asWorker(
    deps.db,
    { workspaceId: scope.workspaceId, organizationId: scope.organizationId },
    async (tx) => {
      if (target.kind === 'call') {
        await tx.execute(sql`
          update app.calls set recording_object_path = ${objectPath}
           where id = ${target.id}::uuid and workspace_id = ${scope.workspaceId}`);
      } else {
        // Appended, so a message with several photos keeps them all and keeps them in order.
        await tx.execute(sql`
          update app.messages
             set media = coalesce(media, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                   'bucket', ${BUCKET}::text,
                   'objectPath', ${objectPath}::text,
                   'contentType', ${detected ?? 'application/octet-stream'}::text,
                   'sizeBytes', ${res.bytes.length}::bigint,
                   'name', ${name}::text))
           where id = ${target.id}::uuid and workspace_id = ${scope.workspaceId}
             and not media @> jsonb_build_array(jsonb_build_object('objectPath', ${objectPath}::text))`);
      }
      await tx.execute(sql`
        update app.migration_media
           set state = 'stored', bucket = ${BUCKET}, object_path = ${objectPath},
               file_name = ${name}, detected_mime = ${detected}, size_bytes = ${res.bytes.length},
               checksum = ${checksum}, stored_at = now(), last_error = null
         where id = ${row.id}::uuid`);
    },
  );
  return shared ? 'reused' : 'copied';
}

type MediaTarget = { kind: 'call' | 'message'; id: string; isVoicemail: boolean };

/** The record here that this file belongs to, if it is still there. */
async function targetOf(
  deps: MediaDeps,
  scope: MediaJobScope,
  row: MediaRow,
): Promise<MediaTarget | null> {
  const [mapped] = await asWorker(
    deps.db,
    { workspaceId: scope.workspaceId, organizationId: scope.organizationId },
    (tx) =>
      rows<{ target_type: string; target_id: string }>(
        tx,
        sql`select target_type, target_id::text as target_id
              from app.migration_source_mappings
             where workspace_id = ${scope.workspaceId}
               and source_object_type = ${row.source_object_type}
               and source_object_id = ${row.source_object_id}
             limit 1`,
      ),
  );
  if (!mapped) return null;
  if (mapped.target_type === 'call') {
    const [call] = await asWorker(
      deps.db,
      { workspaceId: scope.workspaceId, organizationId: scope.organizationId },
      (tx) =>
        rows<{ is_voicemail: boolean }>(
          tx,
          sql`select is_voicemail from app.calls
               where id = ${mapped.target_id}::uuid and workspace_id = ${scope.workspaceId}`,
        ),
    );
    return call ? { kind: 'call', id: mapped.target_id, isVoicemail: call.is_voicemail } : null;
  }
  if (mapped.target_type === 'message') {
    const [message] = await asWorker(
      deps.db,
      { workspaceId: scope.workspaceId, organizationId: scope.organizationId },
      (tx) =>
        rows<{ id: string }>(
          tx,
          sql`select id::text as id from app.messages
               where id = ${mapped.target_id}::uuid and workspace_id = ${scope.workspaceId}`,
        ),
    );
    return message ? { kind: 'message', id: mapped.target_id, isVoicemail: false } : null;
  }
  return null;
}

/** A file that will not be copied, and why, in words a business would use. */
async function settle(
  deps: MediaDeps,
  scope: MediaJobScope,
  row: MediaRow,
  state: 'missing' | 'skipped',
  why: string,
): Promise<CopyOutcome> {
  await asWorker(
    deps.db,
    { workspaceId: scope.workspaceId, organizationId: scope.organizationId },
    (tx) =>
      tx.execute(sql`
        update app.migration_media set state = ${state}::app.migration_media_state,
               last_error = ${why.slice(0, 2000)}
         where id = ${row.id}::uuid`),
  );
  return state === 'missing' ? 'missing' : 'skipped';
}

/** A file that broke: back in the queue if there are tries left, left alone with its reason if not. */
async function giveUpOrRetry(
  deps: MediaDeps,
  scope: MediaJobScope,
  row: MediaRow,
  error: Error,
): Promise<void> {
  const done = row.attempts + 1 >= MAX_TRIES;
  deps.log.warn(
    { mediaId: row.id, attempts: row.attempts + 1, permanent: done },
    'migration file copy failed',
  );
  await asWorker(
    deps.db,
    { workspaceId: scope.workspaceId, organizationId: scope.organizationId },
    (tx) =>
      tx.execute(sql`
        update app.migration_media
           set state = ${done ? 'failed' : 'pending'}::app.migration_media_state,
               last_error = ${error.message.slice(0, 2000)}
         where id = ${row.id}::uuid`),
  );
}
