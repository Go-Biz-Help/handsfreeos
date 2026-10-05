/**
 * The whole transaction, exported (round six, step 10; spec §18 and §26): one zip a brokerage can keep, hand to a
 * lawyer or a regulator, or open in ten years without HandsFreeOS.
 *
 * - **What's in it**: every file on the deal (each document version, evidence, photos, signed copies) under
 *   `files/`, each checked against the fingerprint it was stored with; the deal's own rows, table by table, under
 *   `data/` (its terms and their history, duties with their proof and log and who approved what, contingencies,
 *   offers, inspections, financing, showings, vendors, field notes, the walkthrough); its timeline, tasks,
 *   appointments, portal thread and the client updates sent; and its events and audit lines. `manifest.json`
 *   (`hfos.transaction-export`, version 1) lists each file with its SHA-256; `README.html` says what's where.
 * - **Never in it**: anything that looks like a secret (the manifest's own rule for offline columns), the IP
 *   addresses and browsers on audit lines, and other deals.
 * - **One job**, queued by `realestate.deal.export`. Over 200 MB of files is refused with words that say so; the zip
 *   is kept as a file on the deal (`file.store`), and the person who asked gets an alert when it's ready.
 */
import { createHash } from 'node:crypto';
import { exportFinished } from '@hfos/core/addons/realestate/ops/export';
import { executeCommand, fileStore, storedFilePath } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { makeZip, zipName, type ZipEntry } from '../../files/zip';
import { assertInWorkspace } from '../../handlers/file-removed';
import { raiseAddonAlert } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

export const EXPORT_JOB = 'realestate.export';
/** Files beyond this are refused: a zip this size still opens on a laptop and attaches to a cloud drive. */
export const EXPORT_MAX_BYTES = 200 * 1024 * 1024;

/** Also a listing's access instructions (its lockbox code): they go only to the confirmed agent, before a showing. */
const SECRET =
  /(_enc$|secret|password|pkce|oauth_state|token_hash|_hmac$|(^|_)key_id$|^token$|client_state|access_code|^showing_access$)/;
/** Never written down: who someone was by their network address and browser. */
const PRIVATE_AUDIT = new Set(['ip', 'user_agent']);

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');

/** A file id made from the export's own, so a job tried again keeps one zip. */
function fileIdFor(exportId: string): string {
  const h = createHash('sha256').update(`${exportId}:export`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Leaves out every column that looks like a secret. */
function clean(row: Record<string, unknown>, drop: ReadonlySet<string> = new Set()) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!SECRET.test(k) && !drop.has(k)) out[k] = v;
  return out;
}

/** `realestate.deal.export_requested`: its job, now. */
export async function exportRequested(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const exportId = typeof p['exportId'] === 'string' ? p['exportId'] : null;
  if (!exportId) return;
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: EXPORT_JOB,
        dedupeKey: `${EXPORT_JOB}:${exportId}`,
        runAt: new Date(),
        payload: { exportId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

type ExportRow = {
  id: string;
  deal_record_id: string;
  state: string;
  requested_by: string | null;
};

type FileRow = {
  id: string;
  name: string;
  mime_type: string | null;
  size_bytes: string | number | null;
  bucket: string;
  object_path: string;
  sha256: string | null;
  created_at: Date | string;
  locked_at: Date | string | null;
};

type DocRow = {
  id: string;
  file_id: string | null;
  kind: string;
  title: string;
  status: string;
};

/** The deal's rows in every table of the add-on that has them, read from the database's own list of columns. */
async function addonRows(
  tx: Tx,
  dealId: string,
): Promise<Record<string, Record<string, unknown>[]>> {
  const tables = await rows<{ table_name: string; key: string }>(
    tx,
    sql`select c.table_name, c.column_name as key from information_schema.columns c
        where c.table_schema = 'addon_realestate'
          and (c.column_name = 'deal_record_id' or (c.table_name = 'deals' and c.column_name = 'record_id'))
        order by c.table_name collate "C"`,
  );
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of tables) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(t.table_name)) continue;
    const list = await rows<Record<string, unknown>>(
      tx,
      sql`select * from ${sql.identifier('addon_realestate')}.${sql.identifier(t.table_name)}
          where ${sql.identifier(t.key)} = ${dealId}::uuid`,
    );
    if (list.length) out[t.table_name] = list.map((r) => clean(r));
  }
  return out;
}

/** The deal's own rows in core: the record, its timeline, tasks, appointments, portal thread, events and audit. */
async function coreRows(
  tx: Tx,
  dealId: string,
): Promise<Record<string, Record<string, unknown>[]>> {
  const q = async (name: string, query: ReturnType<typeof sql>, drop?: ReadonlySet<string>) => {
    const list = await rows<Record<string, unknown>>(tx, query);
    return [name, list.map((r) => clean(r, drop))] as const;
  };
  const parts = await Promise.all([
    q('record', sql`select * from app.custom_records where id = ${dealId}::uuid`),
    q(
      'timeline',
      sql`select * from app.activities where custom_record_id = ${dealId}::uuid order by occurred_at, created_at`,
    ),
    q(
      'tasks',
      sql`select * from app.tasks where custom_record_id = ${dealId}::uuid order by created_at`,
    ),
    q(
      'appointments',
      sql`select * from app.appointments where custom_record_id = ${dealId}::uuid order by starts_at`,
    ),
    q(
      'conversations',
      sql`select * from app.conversations where custom_record_id = ${dealId}::uuid order by created_at`,
    ),
    q(
      'messages',
      sql`select m.* from app.messages m join app.conversations c on c.id = m.conversation_id
          where c.custom_record_id = ${dealId}::uuid order by m.created_at`,
    ),
    q(
      'files',
      sql`select * from app.files where record_type = 'custom_record' and record_id = ${dealId}::uuid
          order by created_at`,
    ),
    q(
      'events',
      sql`select * from app.events where entity_id = ${dealId}::uuid order by occurred_at, id`,
    ),
    q(
      'audit',
      sql`select * from app.audit_logs where entity_id = ${dealId}::uuid order by created_at, id`,
      PRIVATE_AUDIT,
    ),
    q(
      'holds',
      sql`select * from app.record_holds where custom_record_id = ${dealId}::uuid order by created_at`,
    ),
  ]);
  return Object.fromEntries(parts.filter(([, list]) => list.length));
}

const FOLDER: Readonly<Record<string, string>> = {
  document: 'documents',
  evidence: 'proof',
  other: 'other files',
};

function readme(
  deal: string,
  business: string,
  at: string,
  counts: Record<string, number>,
): Buffer {
  const esc = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const lines = Object.entries(counts)
    .map(([k, n]) => `<li><code>${esc(k)}</code>: ${n}</li>`)
    .join('');
  return Buffer.from(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(deal)}: the whole transaction</title>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; line-height: 1.5; color: #191d25">
<h1 style="font-size: 22px">${esc(deal)}</h1>
<p>Everything ${esc(business)} kept on this deal in HandsFreeOS, exported ${esc(at)}.</p>
<ul>
<li><code>files/</code>: every document version, proof and photo, as stored. Each one’s SHA-256 is in <code>manifest.json</code>, with whether it still matches the fingerprint taken when it was stored.</li>
<li><code>data/</code>: the deal’s records as JSON, one file per kind: terms and their history, duties with their proof, log and approvals, contingencies, offers, inspections, financing, showings, vendors, field notes and the walkthrough.</li>
<li><code>data/core/</code>: the deal’s timeline, tasks, appointments, portal thread, events and audit lines.</li>
<li><code>manifest.json</code>: what’s here, in a form other software reads (<code>hfos.transaction-export</code>, version 1).</li>
</ul>
<h2 style="font-size: 16px">How many of each</h2><ul>${lines}</ul>
<p style="color: #5b616a; font-size: 13px">Secrets (keys, tokens) and the network addresses on audit lines are left out on purpose.</p>
</body></html>\n`,
    'utf8',
  );
}

/** `realestate.export`: the zip, built, checked, stored on the deal, and the person told. */
export async function exportJob(ctx: AddonJobContext): Promise<JobResult> {
  const exportId = (ctx.job.payload as { exportId?: unknown }).exportId;
  if (typeof exportId !== 'string') return;
  const ws = ctx.scope.workspaceId;
  const finish = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      exportFinished,
      { workspaceId: ws, exportId, ...input },
      ctx.actor,
      ctx.meta,
    );
  const gathered = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [x] = await rows<ExportRow>(
      tx,
      sql`select id, deal_record_id, state, requested_by from addon_realestate.exports
          where id = ${exportId}::uuid and workspace_id = ${ws}::uuid`,
    );
    if (!x || x.state !== 'building') return null;
    const [deal] = await rows<{ name: string; business: string }>(
      tx,
      sql`select r.name, w.name as business from app.custom_records r join app.workspaces w on w.id = r.workspace_id
          where r.id = ${x.deal_record_id}::uuid`,
    );
    const files = await rows<FileRow>(
      tx,
      sql`select id, name, mime_type, size_bytes, bucket, object_path, sha256, created_at, locked_at
          from app.files
          where workspace_id = ${ws}::uuid and record_type = 'custom_record' and record_id = ${x.deal_record_id}::uuid
            and status = 'ready' and deleted_at is null
          order by created_at`,
    );
    const docs = await rows<DocRow>(
      tx,
      sql`select id, file_id, kind, title, status from addon_realestate.documents
          where deal_record_id = ${x.deal_record_id}::uuid`,
    );
    const evidence = await rows<{ file_id: string }>(
      tx,
      sql`select distinct file_id from addon_realestate.duty_evidence
          where deal_record_id = ${x.deal_record_id}::uuid and file_id is not null`,
    );
    return {
      x,
      deal: deal?.name ?? 'Deal',
      business: deal?.business ?? '',
      files,
      docs,
      evidence: new Set(evidence.map((e) => e.file_id)),
      addon: await addonRows(tx, x.deal_record_id),
      core: await coreRows(tx, x.deal_record_id),
    };
  });
  if (!gathered) return;
  const total = gathered.files.reduce((n, f) => n + Number(f.size_bytes ?? 0), 0);
  if (total > EXPORT_MAX_BYTES) {
    const mb = Math.ceil(total / (1024 * 1024));
    await finish({
      failure: `The deal’s files come to ${mb} MB, over the 200 MB one export holds. Ask HandsFreeOS support for a larger export.`,
    });
    return;
  }
  const entries: ZipEntry[] = [];
  const listed: Record<string, unknown>[] = [];
  const docByFile = new Map(gathered.docs.filter((d) => d.file_id).map((d) => [d.file_id!, d]));
  for (const f of gathered.files) {
    assertInWorkspace(f.object_path, ws);
    const bytes = await ctx.store.download(f.bucket, f.object_path);
    const hash = sha256(bytes);
    const doc = docByFile.get(f.id) ?? null;
    const folder = doc
      ? FOLDER.document!
      : gathered.evidence.has(f.id)
        ? FOLDER.evidence!
        : FOLDER.other!;
    const path = `files/${folder}/${zipName(doc ? `${doc.title} (${f.name})` : f.name)}`;
    entries.push({ name: path, data: bytes, at: new Date(f.created_at) });
    listed.push({
      path,
      fileId: f.id,
      name: f.name,
      mimeType: f.mime_type,
      sizeBytes: bytes.length,
      sha256: hash,
      storedSha256: f.sha256,
      // Null when no fingerprint was taken when it was stored (files from before step 3).
      matchesStored: f.sha256 ? f.sha256 === hash : null,
      locked: !!f.locked_at,
      document: doc ? { id: doc.id, kind: doc.kind, title: doc.title, status: doc.status } : null,
    });
  }
  const counts: Record<string, number> = { files: gathered.files.length };
  const data: Record<string, unknown>[] = [];
  for (const [table, list] of Object.entries(gathered.addon)) {
    const path = `data/${table}.json`;
    entries.push({ name: path, data: json(list) });
    data.push({ path, table: `addon_realestate.${table}`, rows: list.length });
    counts[table] = list.length;
  }
  for (const [part, list] of Object.entries(gathered.core)) {
    const path = `data/core/${part}.json`;
    entries.push({ name: path, data: json(list) });
    data.push({ path, table: part, rows: list.length });
    counts[`core/${part}`] = list.length;
  }
  const at = new Date(ctx.now).toISOString();
  const manifest = json({
    format: 'hfos.transaction-export',
    version: 1,
    exportedAt: at,
    exportId,
    business: { id: ws, name: gathered.business },
    deal: { id: gathered.x.deal_record_id, name: gathered.deal },
    requestedBy: gathered.x.requested_by,
    files: listed,
    data,
    counts,
    leftOut: ['secrets (keys, tokens, hashes)', 'network addresses and browsers on audit lines'],
  });
  entries.unshift(
    { name: 'README.html', data: readme(gathered.deal, gathered.business, at, counts) },
    { name: 'manifest.json', data: manifest },
  );
  const zip = makeZip(entries);
  const fileId = fileIdFor(exportId);
  const name = `${gathered.deal.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 120)} transaction ${at.slice(0, 10)}.zip`;
  const path = storedFilePath(ws, 'custom_record', gathered.x.deal_record_id, fileId, name);
  assertInWorkspace(path, ws);
  await ctx.store.upload('attachments', path, zip, 'application/zip', { upsert: true });
  await executeCommand(
    ctx.db,
    fileStore,
    {
      workspaceId: ws,
      id: fileId,
      recordType: 'custom_record',
      recordId: gathered.x.deal_record_id,
      name,
      mimeType: 'application/zip',
      from: 'export',
    },
    ctx.actor,
    ctx.meta,
  );
  await finish({ fileId, manifestSha256: sha256(manifest), counts });
  if (gathered.x.requested_by)
    await raiseAddonAlert(ctx, {
      key: `export:${exportId}`,
      customRecordId: gathered.x.deal_record_id,
      severity: 'info',
      title: `The whole transaction for ${gathered.deal} is ready`,
      detail: `${gathered.files.length} files and every record, with a manifest. It’s on the deal’s Documents, under Exports.`,
      href: `/a/realestate/deals/${gathered.x.deal_record_id}/documents`,
      permission: 'realestate.export',
      audienceUserIds: [gathered.x.requested_by],
    });
}
