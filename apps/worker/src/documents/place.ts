/**
 * The AI placing the fields on a template's PDF (docs/documents.md; the owner's answer 4a). The editor finds the
 * spots a field could go and sends them with the words around each (core's `findDocumentSpots`); the model says
 * which are fields, of what kind and for whom, and core turns its answer into fields that sit exactly on their line
 * or box (`placedFields`). Nothing is saved here: the editor adds what comes back as one change it can undo.
 *
 * When the PDF has few words to go on (a scan, or blanks with no labels), the model reads the PDF itself too.
 * The tokens count as `documents` usage for the person asking, against the daily AI limit.
 *
 * POST /v1/documents/place-fields {workspaceId, templateId, roles, start, spots} → {fields}
 * 403 without documents.manage; 409 `document_template_archived` or `document_template_no_pdf`; 429 `budget_reached`
 * or `rate_limited`; 402 `wallet_empty`; 503 `ai_not_configured` or `ai_busy`; 502 `ai_failed`.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { AI_DOCUMENT_MAX_BYTES, type AiMessage } from '@hfos/ai';
import {
  documentTemplateGet,
  DocumentPlaceFind,
  DocumentRole,
  executeQuery,
  HfosError,
  MAX_DOCUMENT_ROLES,
  parseDocumentDefinition,
  PLACE_FIELDS_SCHEMA,
  PLACE_FIELDS_SYSTEM,
  PlaceFieldsAnswer,
  placeFieldsPrompt,
  placedFields,
  workspaceGet,
  type DocumentField,
  type HumanActor,
} from '@hfos/core/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../ai/ask';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';

/** Asks one address may make a minute. The daily AI limit applies on top. */
export const PLACE_FIELDS_PER_MINUTE = 6;
/** Below this many characters of words at the start, the model reads the PDF itself. */
const FEW_WORDS = 40;
/** …and when fewer than this share of the spots have words around them. */
const FEW_LABELLED = 0.3;
/** The most pages the model reads of a PDF it's shown: a scan's pages cost far more than its words. */
const MAX_PDF_PAGES = 30;

export const PlaceFieldsBody = DocumentPlaceFind.extend({
  workspaceId: z.uuid(),
  templateId: z.uuid(),
  /** Who signs it as the editor has them now, saved or not. */
  roles: z.array(DocumentRole).min(1).max(MAX_DOCUMENT_ROLES),
});

const FAILED =
  'The AI couldn’t place the fields just now. Try again, or place them yourself from the left.';

function aiError(e: unknown): unknown {
  if (!(e instanceof AiAskError)) return e;
  switch (e.code) {
    case 'ai_unavailable':
      return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
    case 'budget_reached':
      return HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
    case 'wallet_empty':
      return HfosError.rule('wallet_empty', 402, e.message);
    case 'provider_error':
      return e.retryable
        ? HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE)
        : HfosError.rule('ai_failed', 502, FAILED);
    case 'bad_output':
      return HfosError.rule('ai_failed', 502, FAILED);
  }
}

const meta = () => ({ correlationId: randomUUID(), channel: 'web' as const });

/** What placing needs: the database, the file store, the model, and the wallet and log its asks count against. */
export type PlaceFieldsDeps = Pick<HttpDeps, 'httpDb' | 'store' | 'ai' | 'log' | 'wallet'>;

/** Few words to go on: the model had better see the pages. */
export function needsThePdf(find: Pick<DocumentPlaceFind, 'start' | 'spots'>): boolean {
  if (find.start.trim().length < FEW_WORDS) return true;
  const labelled = find.spots.filter((s) =>
    [s.left, s.right, s.above, s.below].some((t) => t.trim()),
  ).length;
  return labelled < find.spots.length * FEW_LABELLED;
}

export async function placeFields(
  deps: PlaceFieldsDeps,
  actor: HumanActor,
  input: z.output<typeof PlaceFieldsBody>,
): Promise<{ fields: DocumentField[] }> {
  await requirePermission(deps, actor.userId, input.workspaceId, 'documents.manage');
  if (!deps.ai.provider) throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
  const [{ workspace }, template] = await Promise.all([
    executeQuery(deps.httpDb, workspaceGet, { workspaceId: input.workspaceId }, actor, meta()),
    executeQuery(
      deps.httpDb,
      documentTemplateGet,
      { workspaceId: input.workspaceId, templateId: input.templateId },
      actor,
      meta(),
    ),
  ]);
  if (template.archivedAt)
    throw HfosError.rule(
      'document_template_archived',
      409,
      `“${template.name}” is archived, so it can’t change. Restore it first, or make a new template.`,
    );
  if (!template.source)
    throw HfosError.rule(
      'document_template_no_pdf',
      409,
      `“${template.name}” has no PDF yet. Add one, then the AI can place its fields.`,
    );
  const pages = parseDocumentDefinition(template.definition).pages;
  const find = { start: input.start, spots: input.spots.filter((s) => s.page < pages.length) };
  if (!find.spots.length)
    throw HfosError.validation(
      [],
      'There’s nowhere on this PDF that looks like a field. Place them yourself from the left.',
    );

  const prompt = placeFieldsPrompt(input.roles, find);
  let content: AiMessage['content'] = prompt;
  if (needsThePdf(find) && pages.length <= MAX_PDF_PAGES) {
    const bytes = await deps.store
      .download(template.source.bucket, template.source.objectPath)
      .catch(() => null);
    if (bytes && bytes.length <= AI_DOCUMENT_MAX_BYTES)
      content = [
        {
          type: 'document',
          mediaType: 'application/pdf',
          data: bytes.toString('base64'),
          title: template.source.name,
          pages: pages.length,
        },
        { type: 'text', text: prompt },
      ];
  }

  const scope = { workspaceId: input.workspaceId, organizationId: workspace.organizationId };
  try {
    const { value } = await askStructured(
      { db: deps.httpDb, ai: deps.ai, log: deps.log, wallet: deps.wallet },
      scope,
      {
        system: PLACE_FIELDS_SYSTEM,
        messages: [{ role: 'user', content }],
        schema: PLACE_FIELDS_SCHEMA,
        zod: PlaceFieldsAnswer,
        maxTokens: Math.min(16_000, 600 + find.spots.length * 60),
        usage: { source: 'documents', userId: actor.userId },
      },
    );
    return { fields: placedFields(value, find, { roles: input.roles, pages }) };
  } catch (e) {
    throw aiError(e);
  }
}

export async function registerPlaceFieldsRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of asks in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    scoped.post(
      '/v1/documents/place-fields',
      { config: { rateLimit: { max: PLACE_FIELDS_PER_MINUTE, timeWindow: 60_000 } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        return placeFields(deps, actor, parseBody(PlaceFieldsBody, req.body));
      },
    );
  });
}
