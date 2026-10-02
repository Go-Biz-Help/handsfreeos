/**
 * Reading a deal's contract, amendment or addendum in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md,
 * "Round four", step 2).
 *
 * - **The words first.** A PDF with words is read from its words, page by page, and every value the model finds must
 *   be in them (`checkedContractRead`). A scan has none: its pages go to the model as the document itself, and every
 *   value says it was read from a scan, for the agent to check closely.
 * - **Nothing changes on the deal.** What passed waits for a person (`realestate.contract.read_done`); its agent hears
 *   while values wait, and the card goes once none do.
 * - The model's use is the add-on's.
 */
import { AI_DOCUMENT_MAX_BYTES, AI_DOCUMENT_MAX_PAGES } from '@hfos/ai';
import {
  checkedContractRead,
  CONTRACT_READ_SCHEMA,
  CONTRACT_READ_SYSTEM,
  ContractReadAnswer,
  contractReadPrompt,
  contractScanPrompt,
  type ReadKind,
} from '@hfos/core/addons/realestate/contract-read';
import { contractReadDone } from '@hfos/core/addons/realestate/ops/contract';
import { executeCommand, localDateOf } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import { pdfPages } from '../../files/document-text';
import { readFileBytes } from '../../files/read';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import type { AddonEventContext } from '../types';

/** The largest contract read: its words are read whatever its size; a scan must also fit what the model takes. */
export const CONTRACT_MAX_BYTES = 25 * 1024 * 1024;
/** Fewer words than this in the whole PDF and it's a scan. */
const SCAN_BELOW_CHARS = 200;

const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** The card a reading keeps up while its values wait. */
export const readAlertKey = (readId: string) => `read:${readId}`;

/** What the deal knows to count a date from, and the business's calendar. */
async function readContextOf(ctx: AddonEventContext, dealId: string) {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [deal] = await rows<{ side: 'buyer' | 'listing'; timezone: string; closed: unknown }>(
      tx,
      sql`select d.side, w.timezone,
            (select settings -> 'closedDays' from app.addon_installations
              where workspace_id = d.workspace_id and addon_id = 'realestate') as closed
          from addon_realestate.deals d join app.workspaces w on w.id = d.workspace_id
          where d.workspace_id = ${ctx.scope.workspaceId} and d.record_id = ${dealId}`,
    );
    if (!deal) return null;
    const dates = await rows<{ key: string; date: string }>(
      tx,
      sql`select distinct on (key) key, value_date::text as date
          from addon_realestate.term_entries
          where deal_record_id = ${dealId} and value_date is not null
            and superseded_at is null and rejected_at is null
          order by key, entered_at desc`,
    );
    const closed =
      deal.closed && typeof deal.closed === 'object' && !Array.isArray(deal.closed)
        ? Object.entries(deal.closed as Record<string, unknown>).filter(
            (e): e is [string, string] =>
              /^\d{4}-\d{2}-\d{2}$/.test(e[0]) && typeof e[1] === 'string',
          )
        : [];
    return {
      side: deal.side,
      today: localDateOf(Date.now(), deal.timezone),
      known: Object.fromEntries(dates.map((d) => [d.key, d.date])),
      calendar: { closedDays: new Map(closed) },
    };
  });
}

/** `realestate.contract.read_requested`: read the document, check what's found, and leave it for a person. */
export async function contractReadRequested(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const readId = str(p['readId']);
  const fileId = str(p['fileId']);
  const dealId = ctx.event.entityId;
  if (!readId || !fileId || !dealId) return;
  const kind = (str(p['kind']) ?? 'contract') as ReadKind;
  const title = str(p['title']) ?? 'The document';
  const record = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      contractReadDone,
      { workspaceId: ctx.scope.workspaceId, readId, ...input },
      ctx.actor,
      ctx.meta,
    );
  const file = await readFileBytes(ctx, ctx.scope, fileId, CONTRACT_MAX_BYTES);
  if (!file.ok) {
    await record({
      failure:
        file.why === 'too_large'
          ? `“${title}” is over 25 MB, too big to read. Save a smaller PDF of it, add that to the deal, and it’s read on its own.`
          : `“${title}” isn’t there anymore, so it wasn’t read. Add it to the deal again.`,
    });
    return;
  }
  const pdf = await pdfPages(file.bytes);
  if (!pdf) {
    await record({
      failure: `“${title}” couldn’t be opened as a PDF. Save it again as a PDF, add that to the deal, and it’s read on its own.`,
    });
    return;
  }
  const words = pdf.pages.reduce((n, page) => n + page.length, 0);
  const scan = words < SCAN_BELOW_CHARS;
  if (scan && (file.bytes.length > AI_DOCUMENT_MAX_BYTES || pdf.total > AI_DOCUMENT_MAX_PAGES)) {
    await record({
      scan,
      pages: pdf.total,
      failure: `“${title}” is a scan of ${pdf.total} pages, and scans are read up to ${AI_DOCUMENT_MAX_PAGES} pages and 20 MB. Scan only the signed pages that matter, or enter the key dates yourself.`,
    });
    return;
  }
  const at = await readContextOf(ctx, dealId);
  if (!at) return;
  let prompt: { messages: Parameters<typeof askStructured>[2]['messages']; unread: number | null };
  if (scan)
    prompt = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mediaType: 'application/pdf',
              data: file.bytes.toString('base64'),
              title,
              pages: pdf.total,
            },
            { type: 'text', text: contractScanPrompt(kind) },
          ],
        },
      ],
      unread: null,
    };
  else {
    const { prompt: text, unread } = contractReadPrompt(kind, pdf.pages);
    prompt = { messages: [{ role: 'user', content: text }], unread };
  }
  try {
    const { value, model } = await askStructured(ctx, ctx.scope, {
      system: CONTRACT_READ_SYSTEM,
      messages: prompt.messages,
      schema: CONTRACT_READ_SCHEMA,
      zod: ContractReadAnswer,
      maxTokens: 6000,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    const checked = checkedContractRead(value, {
      side: at.side,
      pages: scan ? null : pdf.pages,
      pageCount: pdf.total,
      known: at.known,
      calendar: at.calendar,
      today: at.today,
    });
    const unclear = [...checked.unclear];
    if (prompt.unread)
      unclear.push({
        what: `Pages ${prompt.unread} to ${pdf.total} weren’t read: the document is too long to read at once. Check them yourself.`,
        quote: null,
        page: prompt.unread,
        clause: null,
      });
    await record({
      values: checked.values,
      unclear: unclear.slice(0, 30),
      dropped: checked.dropped,
      scan,
      pages: pdf.total,
      model,
    });
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    if (e.retryable && ctx.attempt < 3) throw e;
    await record({
      scan,
      pages: pdf.total,
      failure: `The AI couldn’t read “${title}” just now: ${e.message} Read it again in a minute, or enter the key dates yourself.`,
    });
  }
}

/** `realestate.contract.read_finished`: its agent hears what waits for them, or that it couldn't be read. */
export async function contractReadFinished(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const readId = str(p['readId']);
  const dealId = ctx.event.entityId;
  if (!readId || !dealId) return;
  const name = str(p['name']) ?? 'A deal';
  const title = str(p['title']) ?? 'the document';
  const waiting = typeof p['waiting'] === 'number' ? p['waiting'] : 0;
  const failed = p['state'] === 'failed';
  if (!failed && waiting === 0) return;
  await raiseAddonAlert(ctx, {
    key: readAlertKey(readId),
    severity: 'attention',
    title: (failed
      ? `${name}: “${title}” couldn’t be read`
      : `${name}: ${waiting} ${waiting === 1 ? 'value' : 'values'} from “${title}” to confirm`
    ).slice(0, 200),
    detail: failed
      ? 'Open it to read why, then read it again or enter the key dates yourself.'
      : p['scan']
        ? 'It was a scan, so check each value against its page before you confirm it.'
        : 'Check each value beside its clause, then confirm them. Nothing on the deal changes until you do.',
    href: `/a/realestate/deals/${dealId}/contract/${readId}`,
    permission: 'realestate.use',
    customRecordId: dealId,
    assigneeUserId: str(p['ownerUserId']),
  });
}

/** A value confirmed or set aside: once none wait, the card goes. */
export async function contractDecided(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const readId = str(p['readId']);
  if (readId && p['left'] === 0) await clearAddonAlert(ctx, readAlertKey(readId), 'done');
}
