/**
 * The AI's words for finding people by topic (docs/outreach.md, decision 92): for each customers' playbook, the
 * hashtags Instagram looks at, the phrases LinkedIn's post search goes with and the kinds of business Alignable's
 * search looks for, written once while a list is empty and the AI hasn't written it, with whether the business works
 * with those clients online. Core holds what the model is asked and checks what it answers
 * (packages/core/src/addons/outreach/topics.ts), and `outreach.playbook.words` keeps it, never over the person's own
 * words and never again once they emptied a list. Partner playbooks get none.
 *
 * - A playbook saved, a network turned on and the day started (a safety net) queue one write per business.
 * - Only for the networks somebody in the business works: one nobody works waits till someone turns it on.
 * - One ask per playbook that needs words, a few playbooks a run, the rest straight after while a run writes some: an
 *   answer it can't use is passed over, and waits for the next save or day. At the day's AI limit the rest wait 6
 *   hours; with the AI not set up nothing is written till the next save or day, and the old words are looked with
 *   meanwhile.
 * - The words it keeps tell nobody to write again: `outreach.playbook.words` never says the playbook was saved.
 */
import { liveMainOffer } from './assist';
import { NETWORKS_DEFAULTS, NetworksSettings } from '@hfos/core/addons/outreach/automation';
import { outreachSettings } from '@hfos/core/addons/outreach/chat-read';
import { playbookWords } from '@hfos/core/addons/outreach/ops/playbooks';
import {
  PARTNER_GOAL,
  PlaybookDetails,
  upgradePlaybookDetails,
  WORDS_PLATFORM_KEYS,
  type WordsPlatform,
} from '@hfos/core/addons/outreach/playbooks';
import {
  checkedFindWords,
  FIND_WORDS_SCHEMA,
  FIND_WORDS_SYSTEM,
  FindWordsAnswer,
  findWordsPrompt,
  wordsDue,
  type FindWords,
  type FindWordsDue,
} from '@hfos/core/addons/outreach/topics';
import { executeCommand, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';

export const WRITE_WORDS_JOB = 'outreach.write_words';
/** How many playbooks one run writes for: the rest come straight after. */
export const WRITE_WORDS_BATCH = 5;
/**
 * How many asks one run makes at most: an answer it can't use is passed over for the next playbook, so the ones after
 * it are reached, without asking again and again.
 */
export const WRITE_WORDS_ASKS_MOST = 2 * WRITE_WORDS_BATCH;
const HOUR = 3_600_000;

/** A playbook saved, a network turned on, or the day started: the playbooks with no words yet get them now. */
export async function wordsWanted(ctx: AddonEventContext): Promise<void> {
  // Another add-on's settings saved, or none of this one's: nothing to write.
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (p['addonId'] !== undefined && p['addonId'] !== ctx.manifest.id) return;
  await asWorker(ctx.db, ctx.scope, (tx) => scheduleWordsWrite(tx, ctx));
}

/**
 * Queues the business's one words write, now: also data version 9's, which let go of the AI's words on who playbooks
 * are for, to be written again around their topic (decision 141).
 */
export async function scheduleWordsWrite(tx: Tx, ctx: AddonScopeContext): Promise<void> {
  await scheduleAddonJob(
    tx,
    { id: ctx.manifest.id, generation: ctx.generation },
    {
      kind: WRITE_WORDS_JOB,
      dedupeKey: `${WRITE_WORDS_JOB}:${ctx.scope.workspaceId}`,
      runAt: new Date(),
      payload: {},
      workspaceId: ctx.scope.workspaceId,
      organizationId: ctx.scope.organizationId,
    },
    { pullEarlier: true },
  );
}

/**
 * The networks with words that somebody in the business works: anyone's own choice, or the business's starting choice
 * for those who haven't made their own, inside the networks the business allows.
 */
function networksWorked(
  settings: unknown,
  kept: readonly { networks: unknown }[],
): WordsPlatform[] {
  const rules = outreachSettings(settings).rules;
  const choices = [
    rules.defaults.networks,
    ...kept.map((k) => {
      const read = NetworksSettings.safeParse(k.networks ?? {});
      return read.success ? read.data : NETWORKS_DEFAULTS;
    }),
  ];
  return WORDS_PLATFORM_KEYS.filter(
    (p) => rules.networksAllowed.includes(p) && choices.some((c) => c[p].on),
  );
}

/** `outreach.write_words`: writes the words of the business's customers' playbooks that need them. */
export async function writeWordsJob(ctx: AddonJobContext): Promise<JobResult> {
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    business: (
      await rows<{ name: string }>(tx, sql`select name from app.workspaces where id = ${ws}`)
    )[0],
    settings: (
      await rows<{ settings: unknown }>(
        tx,
        sql`select settings from app.addon_installations
            where workspace_id = ${ws} and addon_id = ${ctx.manifest.id}`,
      )
    )[0]?.settings,
    kept: await rows<{ networks: unknown }>(
      tx,
      sql`select networks from addon_outreach.automation where workspace_id = ${ws}`,
    ),
    playbooks: await rows<{ id: string; name: string; details: unknown }>(
      tx,
      sql`select id, name, details from addon_outreach.playbooks
          where workspace_id = ${ws} and archived_at is null
            and (details ->> 'goal') is distinct from ${PARTNER_GOAL}
          order by created_at`,
    ),
  }));
  const worked = networksWorked(found.settings, found.kept);
  if (!worked.length) return;
  const due = found.playbooks.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    if (!read.success) return [];
    const needs: FindWordsDue = wordsDue(read.data, worked);
    return needs.networks.length ? [{ id: p.id, name: p.name, details: read.data, needs }] : [];
  });
  if (!due.length) return;
  const business = found.business?.name ?? 'the business';
  const offer = (await liveMainOffer(ctx))?.offer ?? null;

  let wrote = 0;
  let asked = 0;
  for (const p of due) {
    if (wrote >= WRITE_WORDS_BATCH || asked >= WRITE_WORDS_ASKS_MOST) break;
    asked++;
    let words: FindWords;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: FIND_WORDS_SYSTEM,
        messages: [
          {
            role: 'user',
            content: findWordsPrompt({
              business,
              offer,
              playbook: {
                name: p.name,
                niche: p.details.niche ?? null,
                audience: p.details.audience,
                problem: p.details.problem ?? null,
                offer: p.details.offer,
                area: p.details.area,
                worksOnline: p.details.worksOnline ?? null,
                signs: p.details.signs,
                groupWords: p.details.groupWords,
              },
              due: p.needs,
            }),
          },
        ],
        schema: FIND_WORDS_SCHEMA,
        zod: FindWordsAnswer,
        maxTokens: 1000,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      words = checkedFindWords(value, p.needs, business);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      // The day's limit or an empty balance: the rest wait a few hours. Not set up: the next save or day asks again.
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.code === 'ai_unavailable') return;
      // A busy model is worth another try; one still busy waits an hour.
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      // An answer it couldn't use: this playbook waits for the next save or day.
      continue;
    }
    try {
      const { output } = await executeCommand(
        ctx.db,
        playbookWords,
        { workspaceId: ws, playbookId: p.id, ...words },
        ctx.actor,
        ctx.meta,
      );
      if (output.written.length) wrote++;
    } catch (e) {
      // Made a partner playbook, or gone, since it was read: nothing to write.
      if (
        e instanceof HfosError &&
        (e.code === 'not_found' || e.rule === 'outreach_playbook_partner_words')
      )
        continue;
      throw e;
    }
  }
  // More to write, and this run wrote some: the rest come straight after. A run that wrote none leaves them to the
  // next save or day, so answers it can't use are never asked for again and again.
  if (asked < due.length && wrote > 0) return { rescheduleAt: new Date(ctx.now) };
}
