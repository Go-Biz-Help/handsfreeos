/**
 * `file.received` (20261018000400): a customer sent the file a qualifying question asks for, like a photo or PDF of
 * their electric bill, through the link the AI teammate texted or by text or email. Core has already filed it on
 * the lead (the customer, when the lead has gone) as a pending file and answered the question. Here:
 *
 * 1. **The copy.** Each file is copied from the customer's message (the `telephony` bucket) to its place on the
 *    record (`attachments`), and `file.finish_copy` marks it ready and puts it on the timeline. The message keeps
 *    its own, so deleting one never takes the other.
 * 2. **The alert.** Whoever the question names hears: an email each, and a push (the customer's-messages switch).
 *    Once per event: a marker event stops a retry emailing anyone twice.
 */
import {
  executeCommandIn,
  fileFinishCopy,
  isWorkspaceUser,
  NotifyWho,
  uuidArray,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { fileReceivedEmail } from '../emails/templates';
import { errorMessage } from '../outbox';
import { personName } from '../push/moment';
import { queuePush } from '../push/queue';
import { systemActor, tenantOf, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { assertInWorkspace } from './file-removed';
import { workspaceManagers } from './telephony';
import type { HandlerContext } from './types';

const TOLD = 'file.received_told';

interface Copy {
  readonly fileId: string;
  readonly name: string;
  readonly from: { readonly bucket: string; readonly objectPath: string };
  readonly contentType: string;
}

interface Received {
  readonly leadId: string | null;
  readonly personId: string | null;
  readonly conversationId: string | null;
  readonly question: string;
  readonly notify: NotifyWho | null;
  readonly via: 'file_link' | 'message';
  readonly files: readonly Copy[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function receivedOf(payload: unknown): Received {
  const p = (payload ?? {}) as Record<string, unknown>;
  const notify = NotifyWho.safeParse(p['notify']);
  const files = (Array.isArray(p['files']) ? p['files'] : []).flatMap((f): Copy[] => {
    const x = (f ?? {}) as Record<string, unknown>;
    const from = (x['from'] ?? {}) as Record<string, unknown>;
    const fileId = str(x['fileId']);
    const bucket = str(from['bucket']);
    const objectPath = str(from['objectPath']);
    if (!fileId || !bucket || !objectPath) return [];
    return [
      {
        fileId,
        name: str(x['name']) ?? 'file',
        from: { bucket, objectPath },
        contentType: str(x['contentType']) ?? 'application/octet-stream',
      },
    ];
  });
  return {
    leadId: str(p['leadId']),
    personId: str(p['personId']),
    conversationId: str(p['conversationId']),
    question: str(p['question']) ?? 'a qualifying question',
    notify: notify.success ? notify.data : null,
    via: p['via'] === 'file_link' ? 'file_link' : 'message',
    files,
  };
}

/** Copies one file onto its record and marks it ready. A file deleted (or copied) since is left as it is. */
async function copyOne(ctx: HandlerContext, scope: TenantScope, meta: RequestMeta, f: Copy) {
  const [row] = await rows<{ object_path: string; status: string; deleted_at: Date | null }>(
    ctx.tx,
    sql`select object_path, status::text as status, deleted_at from app.files
        where id = ${f.fileId} and workspace_id = ${scope.workspaceId}`,
  );
  if (!row || row.deleted_at || row.status === 'ready') return;
  // The worker's key never reaches outside the business the event is for.
  assertInWorkspace(f.from.objectPath, scope.workspaceId);
  assertInWorkspace(row.object_path, scope.workspaceId);
  let data: Buffer;
  try {
    data = await ctx.store.download(f.from.bucket, f.from.objectPath);
  } catch (e) {
    // The message's own copy has gone since (its mail removed, say): nothing to copy, and the pending file is swept.
    if (!(await ctx.store.exists(f.from.bucket, f.from.objectPath))) {
      ctx.log.warn({ fileId: f.fileId }, 'a customer’s file was gone before it could be copied');
      return;
    }
    throw e;
  }
  await ctx.store.upload('attachments', row.object_path, data, f.contentType, { upsert: true });
  await executeCommandIn(
    ctx.tx,
    fileFinishCopy,
    { workspaceId: scope.workspaceId, fileId: f.fileId, sizeBytes: Math.max(1, data.length) },
    systemActor(scope),
    meta,
  );
}

interface Recipient {
  readonly id: string;
  readonly email: string;
}

/** The people a question's "Tell" reaches who still work here: owners and admins, the assignee, the owner, or named. */
async function recipients(
  tx: Tx,
  workspaceId: string,
  who: NotifyWho,
  r: Received,
): Promise<Recipient[]> {
  const usersById = async (ids: readonly (string | null | undefined)[]) => {
    const here: string[] = [];
    for (const id of new Set(ids.filter((v): v is string => typeof v === 'string')))
      if (await isWorkspaceUser(tx, workspaceId, id)) here.push(id);
    if (!here.length) return [];
    return rows<{ id: string; email: string }>(
      tx,
      sql`select id, email::text as email from app.users where id = any(${uuidArray(here)}) order by email`,
    );
  };
  switch (who.kind) {
    case 'admins':
      return (await workspaceManagers(tx, workspaceId)).map((u) => ({ id: u.id, email: u.email }));
    case 'users':
      return usersById(who.userIds.map((v) => (typeof v === 'string' ? v : null)));
    case 'lead_assignee': {
      if (!r.leadId) return [];
      const [l] = await rows<{ assignee_user_id: string | null }>(
        tx,
        sql`select assignee_user_id from app.leads where id = ${r.leadId} and workspace_id = ${workspaceId}`,
      );
      return usersById([l?.assignee_user_id]);
    }
    case 'person_owner': {
      if (!r.personId) return [];
      const [p] = await rows<{ owner_user_id: string | null }>(
        tx,
        sql`select owner_user_id from app.people where id = ${r.personId} and workspace_id = ${workspaceId}`,
      );
      return usersById([p?.owner_user_id]);
    }
  }
}

/** Tells whoever the question names, once: an email each and a push. */
async function tell(ctx: HandlerContext, scope: TenantScope, r: Received): Promise<void> {
  if (!r.notify || !r.files.length) return;
  const [done] = await rows(
    ctx.tx,
    sql`select 1 from app.events where causation_id = ${ctx.event.id} and event_type = ${TOLD} limit 1`,
  );
  if (done) return;
  const ws = scope.workspaceId;
  const people = await recipients(ctx.tx, ws, r.notify, r);
  if (!people.length) return;
  const customer = (await personName(ctx.tx, r.personId)) ?? 'A customer';
  const names = r.files.map((f) => f.name);
  const onLead = !!r.leadId && ctx.event.entityType === 'lead';
  const path = onLead
    ? `/app/w/${ws}/leads/${r.leadId}`
    : r.personId
      ? `/app/w/${ws}/customers/${r.personId}`
      : r.conversationId
        ? `/app/w/${ws}/inbox/${r.conversationId}`
        : `/app/w/${ws}`;
  const what = names.length === 1 ? `“${names[0]}”` : `${names.length} files`;
  // In a savepoint: a push that can't be queued never costs the emails, nor the copy.
  const push = (tx: Tx) =>
    queuePush(tx, scope, {
      key: `file:${ctx.event.id}`,
      category: 'customer_file',
      userIds: people.map((p) => p.id),
      title: `File sent · ${customer}`,
      body: `${what} for “${r.question}”`,
      path,
      refs: {
        ...(onLead && r.leadId ? { leadId: r.leadId } : {}),
        ...(r.personId ? { personId: r.personId } : {}),
        ...(r.conversationId ? { conversationId: r.conversationId } : {}),
      },
    });
  try {
    await ctx.tx.transaction(push);
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err) }, 'could not queue the file push');
  }
  const mail = fileReceivedEmail({
    customer,
    question: r.question,
    files: names,
    via: r.via,
    link: `${ctx.webUrl}${path}`,
    onLead,
  });
  const emailed: string[] = [];
  for (const p of people)
    try {
      await ctx.mailer.send({ to: p.email, ...mail });
      emailed.push(p.email);
    } catch (e) {
      ctx.log.warn({ err: errorMessage(e), userId: p.id }, 'could not email that a file came in');
    }
  await recordSystemEvent(ctx.tx, {
    type: TOLD,
    action: 'file.received_tell',
    organizationId: scope.organizationId,
    workspaceId: ws,
    entityType: ctx.event.entityType,
    entityId: ctx.event.entityId,
    payload: { userIds: people.map((p) => p.id), _broadcast: false },
    after: { emailed, question: r.question },
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
  });
}

export async function onFileReceived(ctx: HandlerContext): Promise<void> {
  const scope = tenantOf(ctx.scope);
  const r = receivedOf(ctx.event.payload);
  const meta: RequestMeta = {
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
    channel: 'worker',
  };
  // Copied first, so the link in the alert opens a file that's there.
  for (const f of r.files) await copyOne(ctx, scope, meta, f);
  await tell(ctx, scope, r);
}
