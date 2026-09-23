/**
 * The customer's language (M18 step 2). The teammate answers in the language the customer writes in and says
 * which (`language` on reply and hand_off); it is kept on the conversation. The fixed words HandsFreeOS sends
 * there itself — the business's hand-off line, the emergency safety steps — are the business's and ours, so
 * they are translated once per English text and language (app.fixed_text_translations) rather than written by
 * the model as it goes, and a hand-off uses the translation when there is one:
 * - the hand-off line the teammate translated in its own hand_off, when it passes the check below;
 * - else a kept translation of exactly that English;
 * - else the English.
 * The emergency steps always go out in English as well, after the translation.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  EMERGENCY_SAFETY_TEXT,
  loadTeammate,
  openHoursOf,
  scheduleJob,
  workspaceMessaging,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { askStructured, AiAskError } from '../ai/ask';
import type { JobHandler } from '../jobs';
import { tenantOf, type TenantScope } from '../services';
import { runtimeConfigOf } from './config';
import { TEAMMATE_JOBS } from './constants';
import { handoffExpectation, handoffLine } from './hours';

export const ENGLISH = 'en';

const hashOf = (text: string): string => createHash('sha256').update(text.trim()).digest('hex');

/** A kept translation of exactly this English, or null. */
export async function keptTranslation(
  tx: Tx,
  english: string,
  language: string,
): Promise<string | null> {
  const [row] = await rows<{ translated: string }>(
    tx,
    sql`select translated from app.fixed_text_translations
        where source_hash = ${hashOf(english)} and language = ${language}`,
  );
  return row?.translated ?? null;
}

/**
 * A translation the teammate wrote may carry only words: no link, address, phone number or placeholder the
 * English didn't have. Anything else falls back to a kept translation or the English.
 */
export function usableTranslation(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t || t.length > 600) return null;
  if (/https?:|www\.|@|\{|\}|\d{7,}/i.test(t)) return null;
  return t;
}

/**
 * Keeps the language the teammate says the customer writes in. When it changes to one other than English, the
 * worker translates the business's fixed words into it (the translate job), so the next hand-off can use them.
 */
export async function rememberLanguage(
  tx: Tx,
  scope: TenantScope,
  conversationId: string | null,
  language: string | null,
): Promise<void> {
  if (!conversationId || !language) return;
  const changed = await rows<{ id: string }>(
    tx,
    sql`update app.conversations set language = ${language}
        where id = ${conversationId} and language is distinct from ${language}
        returning id`,
  );
  if (!changed.length || language === ENGLISH) return;
  await scheduleJob(tx, {
    kind: TEAMMATE_JOBS.translate,
    dedupeKey: `translate:${scope.workspaceId}:${language}`,
    runAt: new Date(),
    payload: { language },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
}

/** What a translate job translates: every emergency's steps, and the business's hand-off line as it reads now. */
async function fixedTexts(tx: Tx, scope: TenantScope): Promise<string[]> {
  const out = new Set<string>(Object.values(EMERGENCY_SAFETY_TEXT));
  const teammate = await loadTeammate(tx, scope.workspaceId);
  if (teammate) {
    const m = await workspaceMessaging(tx, scope.workspaceId);
    const tz = m.timezone || 'UTC';
    const template = runtimeConfigOf(teammate.config).handOff.tellCustomer;
    out.add(handoffLine(template, handoffExpectation(openHoursOf(m.rawSettings), tz, Date.now())));
  }
  return [...out];
}

const Answer = z.object({
  translations: z
    .array(z.object({ index: z.int().min(0), text: z.string().trim().min(1).max(2000) }))
    .max(20),
});
const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['translations'],
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'text'],
        properties: { index: { type: 'integer' }, text: { type: 'string' } },
      },
    },
  },
} as const;

const SYSTEM = [
  'You translate short customer messages from a small business, faithfully and plainly, into the language asked for.',
  'Keep the meaning exactly: never add, drop or soften anything, and keep every instruction in the same order.',
  'Keep names, numbers such as 911, and times as they are. Write no links, phone numbers or placeholders that are not in the English.',
  'Answer with each text’s index and its translation.',
].join('\n');

/** `ai_teammate.translate`: the business's fixed words in one language, those not kept already. */
export const translateJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const language = ctx.job.payload['language'];
  if (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language) || language === ENGLISH)
    return;
  const missing = await asWorker(ctx.db, scope, async (tx) => {
    const texts = await fixedTexts(tx, scope);
    const out: string[] = [];
    for (const t of texts) if (!(await keptTranslation(tx, t, language))) out.push(t);
    return out;
  });
  if (!missing.length) return;
  let answer: z.output<typeof Answer>;
  try {
    ({ value: answer } = await askStructured(ctx, scope, {
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            `Translate each text into the language with the code "${language}".`,
            ...missing.map((t, i) => `[${i}] ${t}`),
          ].join('\n'),
        },
      ],
      schema: ANSWER_SCHEMA,
      zod: Answer,
      maxTokens: 2048,
      usage: { source: 'teammate' },
    }));
  } catch (e) {
    // No AI to spare today: the English goes out until the next time this language comes up.
    if (e instanceof AiAskError && !e.retryable) {
      ctx.log.warn({ err: e.message, language }, 'could not translate the fixed words');
      return;
    }
    throw e;
  }
  await asWorker(ctx.db, scope, async (tx) => {
    for (const t of answer.translations) {
      const english = missing[t.index];
      if (!english) continue;
      await tx.execute(
        sql`insert into app.fixed_text_translations (source_hash, language, translated)
            values (${hashOf(english)}, ${language}, ${t.text})
            on conflict (source_hash, language) do nothing`,
      );
    }
  });
};
