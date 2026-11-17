/**
 * Reading a business card scanned on the phone (Contacts → + → Scan a business card; core's `crm/business-card.ts`).
 * One side at a time: the AI reads the details and says roughly where the card's corners are, the edges are found
 * exactly and the card straightened (card-picture.ts), and both come back to the phone, which fills the New contact
 * form from them. Nothing is saved here: the phone adds the contact, and the card's pictures, once the person checks
 * the form.
 *
 * With corners the person placed by hand, the picture is only straightened again: no AI, nothing counted.
 * The AI's tokens count as `business_card` usage for the person scanning, against the daily AI limit.
 *
 * POST /v1/contacts/read-card {workspaceId, side, image, corners?} → ReadCardOut
 * 403 without records.write; 400 when the picture can't be opened; 429 `budget_reached` or `rate_limited`;
 * 402 `wallet_empty`; 503 `ai_not_configured` or `ai_busy`; 502 `ai_failed`.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  BUSINESS_CARD_ASK,
  BUSINESS_CARD_SCHEMA,
  BUSINESS_CARD_SYSTEM,
  BusinessCardAnswer,
  CARD_IMAGE_MAX_BASE64,
  cardContactFromAnswer,
  cornersFromAnswer,
  executeQuery,
  HfosError,
  ReadCardInput,
  workspaceGet,
  type HumanActor,
  type ReadCardOut,
} from '@hfos/core/server';
import type { FastifyInstance } from 'fastify';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../ai/ask';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { straightenCard, uprightJpeg } from './card-picture';

/** Sides one address may send a minute. The daily AI limit applies on top. */
export const READ_CARD_PER_MINUTE = 20;
/** The longest side the AI sees: about what it reads at, so a bigger picture only costs more. */
const AI_EDGE = 1568;

const FAILED = 'The AI couldn’t read the card just now. Try again, or type the details in.';
const UNREADABLE =
  'That picture couldn’t be opened. Take it again, or choose a different picture.';

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

/** What reading needs: the database, the model, and the wallet and log its asks count against. */
export type ReadCardDeps = Pick<HttpDeps, 'httpDb' | 'ai' | 'log' | 'wallet'>;

export async function readCard(
  deps: ReadCardDeps,
  actor: HumanActor,
  input: ReadCardInput,
): Promise<ReadCardOut> {
  await requirePermission(deps, actor.userId, input.workspaceId, 'records.write');
  const photo = Buffer.from(input.image, 'base64');
  let forAi: Buffer;
  try {
    forAi = await uprightJpeg(photo, AI_EDGE);
  } catch {
    throw HfosError.rule('card_unreadable', 400, UNREADABLE);
  }

  // Corners placed by hand: straightened where the person put them, and nothing read.
  if (input.corners) {
    const flat = await straightenCard(photo, input.corners, { refine: false });
    return {
      picture: flat.picture.toString('base64'),
      width: flat.width,
      height: flat.height,
      corners: flat.corners,
      cropped: flat.cropped,
      isCard: true,
      contact: null,
    };
  }

  if (!deps.ai.provider) throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
  const { workspace } = await executeQuery(
    deps.httpDb,
    workspaceGet,
    { workspaceId: input.workspaceId },
    actor,
    { correlationId: randomUUID(), channel: 'mobile' },
  );
  const scope = { workspaceId: input.workspaceId, organizationId: workspace.organizationId };
  let answer: BusinessCardAnswer;
  try {
    ({ value: answer } = await askStructured(
      { db: deps.httpDb, ai: deps.ai, log: deps.log, wallet: deps.wallet },
      scope,
      {
        system: BUSINESS_CARD_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', mediaType: 'image/jpeg', data: forAi.toString('base64') },
              { type: 'text', text: BUSINESS_CARD_ASK },
            ],
          },
        ],
        schema: BUSINESS_CARD_SCHEMA,
        zod: BusinessCardAnswer,
        maxTokens: 1500,
        usage: { source: 'business_card', userId: actor.userId },
      },
    ));
  } catch (e) {
    throw aiError(e);
  }

  // The AI's corners are shares of the picture it saw, which is the photo turned upright: the same shares here.
  const flat = await straightenCard(photo, cornersFromAnswer(answer), { refine: true });
  return {
    picture: flat.picture.toString('base64'),
    width: flat.width,
    height: flat.height,
    corners: flat.corners,
    cropped: flat.cropped,
    isCard: answer.isCard,
    contact: cardContactFromAnswer(answer),
  };
}

export async function registerReadCardRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of cards in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    scoped.post(
      '/v1/contacts/read-card',
      {
        bodyLimit: CARD_IMAGE_MAX_BASE64 + 64 * 1024,
        config: { rateLimit: { max: READ_CARD_PER_MINUTE, timeWindow: 60_000 } },
      },
      async (req) => {
        const actor = await authenticate(deps, req);
        return readCard(deps, actor, parseBody(ReadCardInput, req.body));
      },
    );
  });
}
