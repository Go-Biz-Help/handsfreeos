/**
 * The agency's pushes, delivered to each business (Milestone 6, step 12). A push is one organization-level
 * event, and the system actor is bound to one business at a time, so each push queues one job per business:
 * - `workflow_template.pushed` → a `workflow_template.install` job per install (deduped by the install's id).
 *   Core's workflow_template.install resolves the newest version with that business's mapping (a suggestion by
 *   name for keys never mapped) and makes a draft with its template origin, or marks the install failed with
 *   the reason. Unmapped placeholders stay in the draft as issues with a Fix; publishing still needs that
 *   business's own passing test.
 * - `knowledge_pack.pushed` → a `knowledge_pack.install` job per business (deduped by pack, version and
 *   business): each item becomes a suggestion with reason `pack`, once per item and version even when the
 *   job runs again, and never for something the business already has.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  executeCommandIn,
  HfosError,
  KnowledgeArticle,
  KnowledgeFact,
  KnowledgeFaq,
  knowledgeSuggestionPropose,
  scheduleJob,
  workflowTemplateInstall,
  type KnowledgeProposal,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { workflowTemplateInstalls } from '@hfos/db/schema';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage, MAX_ATTEMPTS } from '../outbox';
import { systemActor, tenantOf } from '../services';

export const TEMPLATE_JOBS = {
  /** One pushed template into one business. */
  install: 'workflow_template.install',
  /** One pushed knowledge pack into one business, as suggestions. */
  pack: 'knowledge_pack.install',
} as const;

export const installJobKey = (installId: string): string => `wf-tpl-install:${installId}`;
export const packJobKey = (packId: string, version: number, workspaceId: string): string =>
  `kpack:${packId}:${version}:${workspaceId}`;

/** Suggestions proposed per command (knowledge_suggestion.propose takes at most 200). */
const PROPOSE_BATCH = 200;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function jobMeta(payload: Record<string, unknown>): RequestMeta {
  return {
    correlationId: str(payload['correlationId']) ?? randomUUID(),
    causationId: str(payload['causationId']),
    channel: 'worker',
  };
}

// ---- Workflow templates ----

/** One install job per business the template was pushed to (the push lists installs in its businesses' order). */
export const onTemplatePushed: EventHandler = async (ctx) => {
  const e = ctx.event;
  const p = isRecord(e.payload) ? e.payload : {};
  const workspaceIds = strings(p['workspaceIds']);
  const installIds = strings(p['installIds']);
  if (!e.organizationId || workspaceIds.length !== installIds.length) {
    ctx.log.warn({ eventId: e.id }, 'a template push without its installs; ignored');
    return;
  }
  for (const [i, installId] of installIds.entries())
    await scheduleJob(ctx.tx, {
      kind: TEMPLATE_JOBS.install,
      dedupeKey: installJobKey(installId),
      runAt: new Date(),
      payload: {
        installId,
        templateId: str(p['templateId']),
        correlationId: e.correlationId,
        causationId: e.id,
      },
      workspaceId: workspaceIds[i]!,
      organizationId: e.organizationId,
    });
};

async function markFailed(tx: Tx, installId: string, reason: string): Promise<void> {
  await tx
    .update(workflowTemplateInstalls)
    .set({ status: 'failed', lastError: reason.slice(0, 2000) })
    .where(eq(workflowTemplateInstalls.id, installId));
}

/**
 * Installs one push in its business. A refusal won't change on a retry, so it marks the install failed at
 * once; anything else gets the job's retries, then fails it with a reason to push again.
 */
export const templateInstallJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const installId = String(ctx.job.payload['installId'] ?? '');
  await asWorker(ctx.db, scope, async (tx) => {
    try {
      const { output } = await executeCommandIn(
        tx,
        workflowTemplateInstall,
        { workspaceId: scope.workspaceId, installId },
        systemActor(scope),
        jobMeta(ctx.job.payload),
      );
      ctx.log.info(
        { installId, status: output.status, created: output.created, unmapped: output.unmapped },
        'template install done',
      );
    } catch (e) {
      if (e instanceof HfosError && e.code === 'not_found') {
        ctx.log.info(
          { installId },
          'the install is gone (its template was deleted); nothing to do',
        );
        return;
      }
      if (!(e instanceof HfosError) && ctx.attempt < MAX_ATTEMPTS) throw e;
      await markFailed(
        tx,
        installId,
        e instanceof HfosError
          ? e.message
          : 'Something went wrong while installing it. Push it again in a minute.',
      );
      ctx.log.warn({ installId, err: errorMessage(e) }, 'template install failed');
    }
  });
};

// ---- Knowledge packs ----

/** One delivery job per business the pack was pushed to. */
export const onPackPushed: EventHandler = async (ctx) => {
  const e = ctx.event;
  const p = isRecord(e.payload) ? e.payload : {};
  const packId = str(p['packId']);
  const version = Number(p['version']);
  if (!e.organizationId || !packId || !Number.isInteger(version)) {
    ctx.log.warn({ eventId: e.id }, 'a knowledge pack push without its pack; ignored');
    return;
  }
  for (const workspaceId of strings(p['workspaceIds']))
    await scheduleJob(ctx.tx, {
      kind: TEMPLATE_JOBS.pack,
      dedupeKey: packJobKey(packId, version, workspaceId),
      runAt: new Date(),
      payload: {
        packId,
        version,
        requestedBy: str(p['requestedBy']),
        correlationId: e.correlationId,
        causationId: e.id,
      },
      workspaceId,
      organizationId: e.organizationId,
    });
};

type PackContent = Extract<KnowledgeProposal, { reason: 'pack' }>['content'];

/** A pack item as the item it proposes; null when it doesn't fit a knowledge item's own limits. */
export function packContent(item: unknown): PackContent | null {
  if (!isRecord(item)) return null;
  const title = str(item['title']);
  const body = str(item['body']);
  const tags = strings(item['tags']);
  const parsed =
    item['kind'] === 'faq'
      ? KnowledgeFaq.safeParse({ kind: 'faq', question: title, answer: body, tags })
      : item['kind'] === 'article'
        ? KnowledgeArticle.safeParse({ kind: 'article', title, body, tags })
        : item['kind'] === 'fact'
          ? KnowledgeFact.safeParse({ kind: 'fact', title, body, tags })
          : null;
  return parsed?.success ? parsed.data : null;
}

/** How items are told apart: their question or title, in any case and spacing. */
const itemKey = (title: string) => title.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Proposes a pack's items to one business as suggestions. Skips an item this pack's version already
 * proposed there (whatever became of it) and one the knowledge base already has, so a retried or repeated
 * job adds nothing twice. All in one transaction: a failure leaves nothing half done.
 */
export const packInstallJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const ws = scope.workspaceId;
  const packId = String(ctx.job.payload['packId'] ?? '');
  await asWorker(ctx.db, scope, async (tx) => {
    const [pack] = await rows<{ items: unknown; version: number; archived_at: Date | null }>(
      tx,
      sql`select items, version, archived_at from app.knowledge_packs where id = ${packId}`,
    );
    if (!pack || pack.archived_at) {
      ctx.log.info({ packId }, 'the pack is gone or archived; nothing to deliver');
      return;
    }
    // The pack keeps only its newest items: they go out under the version they are.
    const version = pack.version;
    const had = await rows<{ title: string | null }>(
      tx,
      sql`select proposed ->> 'title' as title from app.knowledge_suggestions
          where workspace_id = ${ws} and reason = 'pack'
            and source ->> 'packId' = ${packId} and source ->> 'version' = ${String(version)}
          union all
          select title from app.knowledge_items where workspace_id = ${ws} and status <> 'archived'`,
    );
    const seen = new Set(had.map((r) => itemKey(r.title ?? '')));
    const suggestions: KnowledgeProposal[] = [];
    let skipped = 0;
    let unfit = 0;
    for (const item of Array.isArray(pack.items) ? pack.items : []) {
      const content = packContent(item);
      if (!content) {
        unfit += 1;
        continue;
      }
      const key = itemKey(content.kind === 'faq' ? content.question : content.title);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      suggestions.push({ reason: 'pack', content, packId, version });
    }
    const actor = systemActor(scope, str(ctx.job.payload['requestedBy']));
    const meta = jobMeta(ctx.job.payload);
    for (let i = 0; i < suggestions.length; i += PROPOSE_BATCH)
      await executeCommandIn(
        tx,
        knowledgeSuggestionPropose,
        { workspaceId: ws, suggestions: suggestions.slice(i, i + PROPOSE_BATCH) },
        actor,
        meta,
      );
    ctx.log.info(
      { packId, version, proposed: suggestions.length, skipped, unfit },
      'knowledge pack delivered',
    );
  });
};

/** Job kind → handler, for scheduled.ts's jobs map. */
export const templateJobs: JobMap = {
  [TEMPLATE_JOBS.install]: templateInstallJob,
  [TEMPLATE_JOBS.pack]: packInstallJob,
};
