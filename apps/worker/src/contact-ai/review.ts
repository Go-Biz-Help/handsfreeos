/**
 * One look at one customer (0107): the AI reads them, core's rules decide what of its answer is done, and the
 * commands do it — `record.set_tags` for each tag on or off, `person.update` for the details — as the system,
 * marked as the AI (`_contactAi` on the events, channel `contact_ai` and the AI's reason on each audit row). The look
 * itself is written to app.contact_ai_reviews whatever came of it: what the AI said, what was done, what was left
 * alone and why.
 */
import { randomUUID } from 'node:crypto';
import {
  automationSettingsOf,
  CONTACT_AI_DECISION_SCHEMA,
  ContactAiDecision,
  detailReason,
  executeCommandIn,
  localDateOf,
  NO_CONTACT_AI_CHANGES,
  personUpdate,
  planChanges,
  planContactChanges,
  recordSetTags,
  type ContactAiPlan,
  type ContactAiTagOption,
  type RequestMeta,
  type SystemActor,
  uuidArray,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { AiAskError, askStructured } from '../ai/ask';
import { systemActor, type TenantScope, type WorkerServices } from '../services';
import { loadContactProfile, type ContactProfile } from './profile';
import { contactAiPrompt, CONTACT_AI_SYSTEM } from './prompt';

export type ReviewTrigger = 'activity' | 'sweep';

export interface ReviewOptions {
  readonly trigger: ReviewTrigger;
  readonly sweepId: string | null;
  /** The event that brought it on. */
  readonly causeEventId: string | null;
  /** May it change tags, and which: null is every tag the business has. */
  readonly tags: boolean;
  readonly tagIds: readonly string[] | null;
  /** May it change contact details. */
  readonly details: boolean;
  /** What a person asked it to look for (a pass's instructions). */
  readonly instructions: string;
}

export interface ReviewResult {
  readonly outcome: 'changed' | 'unchanged' | 'skipped' | 'failed';
  readonly tagsAdded: number;
  readonly tagsRemoved: number;
  readonly detailsChanged: number;
}

const SKIPPED: ReviewResult = {
  outcome: 'skipped',
  tagsAdded: 0,
  tagsRemoved: 0,
  detailsChanged: 0,
};

type Deps = Pick<WorkerServices, 'db' | 'ai' | 'log' | 'wallet'>;

interface Setup {
  readonly profile: ContactProfile;
  readonly tags: readonly ContactAiTagOption[];
  readonly guide: string;
  readonly businessName: string;
  readonly today: string;
}

async function setupOf(
  tx: Tx,
  scope: TenantScope,
  personId: string,
  opts: ReviewOptions,
): Promise<Setup | null> {
  const profile = await loadContactProfile(tx, scope.workspaceId, personId);
  if (!profile || profile.archived) return null;
  const [ws] = await rows<{ name: string; settings: Record<string, unknown> | null; tz: string }>(
    tx,
    sql`select name, settings, timezone as tz from app.workspaces where id = ${scope.workspaceId}`,
  );
  const tags = opts.tags
    ? await rows<{ id: string; name: string }>(
        tx,
        sql`select id, name::text as name from app.tags where workspace_id = ${scope.workspaceId}
            ${opts.tagIds ? sql`and id = any(${uuidArray(opts.tagIds)})` : sql``}
            order by name`,
      )
    : [];
  return {
    profile,
    tags,
    guide: automationSettingsOf(ws?.settings).contactAi.guide,
    businessName: ws?.name ?? 'the business',
    today: localDateOf(Date.now(), ws?.tz || 'UTC'),
  };
}

/** The AI acting on its own, as the audit log names it. */
function aiActor(scope: TenantScope, opts: ReviewOptions): SystemActor {
  return {
    ...systemActor(scope),
    contactAi: { trigger: opts.trigger, sweepId: opts.sweepId },
  };
}

const meta = (correlationId: string, causationId: string | null, reason: string): RequestMeta => ({
  correlationId,
  causationId,
  channel: 'contact_ai',
  reason: reason.slice(0, 1000),
});

const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 200) || 'it failed';

/** Carries out a plan in one transaction, each change its own command; one refused leaves the rest. */
async function apply(
  tx: Tx,
  scope: TenantScope,
  personId: string,
  plan: ContactAiPlan,
  opts: ReviewOptions,
  correlationId: string,
) {
  const actor = aiActor(scope, opts);
  const skipped = [...plan.skipped];
  const addTags: { id: string; name: string; reason: string }[] = [];
  const removeTags: { id: string; name: string; reason: string }[] = [];
  for (const [mode, steps, done] of [
    ['add', plan.addTags, addTags],
    ['remove', plan.removeTags, removeTags],
  ] as const) {
    for (const t of steps) {
      try {
        await executeCommandIn(
          tx,
          recordSetTags,
          {
            workspaceId: scope.workspaceId,
            recordType: 'person',
            recordId: personId,
            tagIds: [t.id],
            mode,
          },
          actor,
          meta(correlationId, opts.causeEventId, t.reason),
        );
        done.push({ id: t.id, name: t.name, reason: t.reason });
      } catch (e) {
        skipped.push({
          what: `${mode === 'add' ? 'putting on' : 'taking off'} “${t.name}”`,
          why: errText(e),
        });
      }
    }
  }
  let details = plan.details;
  if (plan.personPatch && details.length) {
    try {
      const out = await executeCommandIn(
        tx,
        personUpdate,
        { workspaceId: scope.workspaceId, personId, ...plan.personPatch },
        actor,
        meta(correlationId, opts.causeEventId, detailReason(details)),
      );
      if (out.output.updated.length === 0) details = [];
    } catch (e) {
      skipped.push({ what: 'the contact details', why: errText(e) });
      details = [];
    }
  }
  return { addTags, removeTags, details, skipped };
}

/**
 * Looks at one customer and does what the rules allow of the AI's answer. Throws AiAskError when the AI can't be
 * asked (no AI, today's limit, the balance, a provider error); a pass or a job decides what that means.
 */
export async function reviewPerson(
  deps: Deps,
  scope: TenantScope,
  personId: string,
  opts: ReviewOptions,
): Promise<ReviewResult> {
  if (!opts.tags && !opts.details) return SKIPPED;
  const setup = await asWorker(deps.db, scope, (tx) => setupOf(tx, scope, personId, opts));
  if (!setup) return SKIPPED;
  const correlationId = randomUUID();
  const log = async (
    outcome: ReviewResult['outcome'],
    decision: unknown,
    applied: Record<string, unknown>,
    note: string | null,
    model: string | null,
    tx?: Tx,
  ) => {
    const write = (t: Tx) =>
      rows(
        t,
        sql`insert into app.contact_ai_reviews (workspace_id, person_id, trigger, sweep_id, cause_event_id,
              outcome, decision, applied, note, model, correlation_id)
            values (${scope.workspaceId}, ${personId}, ${opts.trigger}, ${opts.sweepId}, ${opts.causeEventId},
              ${outcome}, ${JSON.stringify(decision ?? {})}::jsonb, ${JSON.stringify(applied)}::jsonb,
              ${note ? note.slice(0, 500) : null}, ${model ? model.slice(0, 100) : null}, ${correlationId})`,
      );
    if (tx) await write(tx);
    else await asWorker(deps.db, scope, write);
  };

  // Nothing it may use: no tags to put on, and no details it may change.
  if (!setup.tags.length && !opts.details) {
    await log('skipped', NO_CONTACT_AI_CHANGES, {}, 'There are no tags it may use.', null);
    return SKIPPED;
  }
  if (!setup.profile.hasHistory && !opts.instructions.trim()) {
    await log(
      'skipped',
      NO_CONTACT_AI_CHANGES,
      {},
      'Nothing to go on yet beyond their name.',
      null,
    );
    return SKIPPED;
  }

  let decision: ContactAiDecision;
  let model: string;
  try {
    const answer = await askStructured(deps, scope, {
      system: CONTACT_AI_SYSTEM,
      messages: [
        {
          role: 'user',
          content: contactAiPrompt({
            businessName: setup.businessName,
            today: setup.today,
            tags: setup.tags,
            guide: setup.guide,
            instructions: opts.instructions,
            details: opts.details,
            profile: setup.profile,
          }),
        },
      ],
      schema: CONTACT_AI_DECISION_SCHEMA,
      zod: ContactAiDecision,
      maxTokens: 1200,
      usage: { source: 'automations' },
    });
    decision = answer.value;
    model = answer.model;
  } catch (e) {
    if (e instanceof AiAskError && e.code === 'bad_output') {
      await log('failed', {}, {}, 'The AI’s answer didn’t come back in the expected shape.', null);
      return { ...SKIPPED, outcome: 'failed' };
    }
    throw e;
  }

  return asWorker(deps.db, scope, async (tx) => {
    // Read again in this transaction: a person may have changed them while the AI was thinking.
    const fresh = await loadContactProfile(tx, scope.workspaceId, personId);
    if (!fresh || fresh.archived) return SKIPPED;
    const plan = planContactChanges(decision, fresh.snapshot, {
      tags: setup.tags,
      details: opts.details,
      trustedText: fresh.trustedText,
    });
    const done = planChanges(plan)
      ? await apply(tx, scope, personId, plan, opts, correlationId)
      : { addTags: [], removeTags: [], details: [], skipped: plan.skipped };
    const changed = done.addTags.length + done.removeTags.length + done.details.length > 0;
    await log(
      changed ? 'changed' : 'unchanged',
      decision,
      {
        addTags: done.addTags.map((t) => ({ name: t.name, reason: t.reason })),
        removeTags: done.removeTags.map((t) => ({ name: t.name, reason: t.reason })),
        details: done.details,
        skipped: done.skipped,
      },
      null,
      model,
      tx,
    );
    return {
      outcome: changed ? 'changed' : 'unchanged',
      tagsAdded: done.addTags.length,
      tagsRemoved: done.removeTags.length,
      detailsChanged: done.details.length,
    };
  });
}
