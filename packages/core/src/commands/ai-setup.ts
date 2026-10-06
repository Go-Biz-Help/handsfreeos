/**
 * Quick setup for the AI teammate (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): keeping the answers while
 * someone is part way through, and Save, which carries out the plan `planAiSetup` shows.
 *
 * The answers live in `workspaces.settings.aiSetup` until Save, so a person can stop on the computer and carry on
 * from the phone, and nothing in the business changes before they finish. The first screen is the exception: the
 * business's name, kind and website are saved straight away, and Ava starts reading the website then, so it has
 * read it by the end.
 *
 * Save runs the commands each part already has (open hours, the business profile, facts and FAQs, what the website
 * scan found, services, a booking calendar, a service area, the website chat) in this transaction, each with its
 * own permission and events. The teammate is set up or saved here, with "Quick setup" heading its revision. It
 * stays off: the last screen tests it, and turning it on is `ai_teammate.set_status`.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { knowledgeSources, workspaces } from '@hfos/db/schema';
import {
  aiSetupOf,
  laterAiSetupStep,
  storedAiSetup,
  AI_SETUP_SETTINGS_KEY,
  type AiSetupAnswers,
  type AiSetupRecord,
} from '../ai-setup/answers';
import { AI_SETUP_READ_ASKED_KEY, aiSetupReadDue } from '../ai-setup/found';
import { setupKindOf, type SetupKind } from '../ai-setup/kinds';
import { loadAiSetupState, loadAiSetupTemplates } from '../ai-setup/load';
import { planAiSetup, teammateFromAiSetup } from '../ai-setup/plan';
import { AI_SETUP_FACT_TAG, AI_SETUP_FOUND_KEY, AiSetupFound } from '../ai-setup/state';
import { aiSetupProblems } from '../ai-setup/summary';
import { chosenAiSetupTemplate, withAiSetupTemplate } from '../ai-setup/templates';
import { AI_SETUP_AREA_NAME } from '../ai-setup/words';
import { HfosError, type HfosErrorCode } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import {
  AiSetupFinishInput,
  AiSetupFinishOutput,
  AiSetupNoteFoundInput,
  AiSetupNoteFoundOutput,
  AiSetupSaveInput,
  AiSetupSaveOutput,
} from '../schemas/ai-setup';
import { insertTeammate, saveTeammate } from './ai-team';
import { calendarCreate, calendarSetStatus } from './calendar';
import { serviceCreate, territoryCreate } from './calendar-catalog';
import { chatWidgetCreate, chatWidgetUpdate } from './chat-widget';
import {
  knowledgeItemArchive,
  knowledgeItemCreate,
  knowledgeItemImportFaqs,
  knowledgeItemUpdate,
  knowledgeProfileUpdate,
  knowledgeScanStart,
  knowledgeSourceSet,
  knowledgeSuggestionAccept,
  knowledgeSuggestionReject,
  normalizeSiteUrl,
} from './knowledge';
import { workspaceUpdate } from './workspace.update';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** The business's quick setup and its kind of business, read with its row held until this command saves. */
async function lockSetup(ctx: CommandContext) {
  const [w] = await ctx.tx
    .select({ settings: workspaces.settings, industry: workspaces.industry })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.scope.workspaceId!))
    .for('update');
  if (!w)
    throw HfosError.notFound(
      'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
    );
  return {
    record: aiSetupOf((w.settings ?? {}) as Record<string, unknown>),
    kind: setupKindOf(w.industry),
  };
}

async function saveRecord(ctx: CommandContext, next: AiSetupRecord) {
  // Read again: the commands this one ran may have changed other settings since it was locked.
  const [w] = await ctx.tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.scope.workspaceId!));
  const [row] = await ctx.tx
    .update(workspaces)
    .set({
      settings: {
        ...((w?.settings ?? {}) as Record<string, unknown>),
        [AI_SETUP_SETTINGS_KEY]: storedAiSetup(next),
      },
    })
    .where(eq(workspaces.id, ctx.scope.workspaceId!))
    .returning({ id: workspaces.id });
  // Row-level security lets only someone with workspace.update change a business's settings.
  if (!row)
    throw HfosError.forbidden(
      'Quick setup saves to the business’s settings, and your role can’t change them. Ask an owner of this business to run it, or to give you that permission in Settings → Permissions.',
    );
}

/**
 * Runs an inner command, and gives null instead when it's refused for one of these reasons, so the rest carries on.
 * Its own writes are already undone (it ran in a savepoint).
 */
async function unlessRefused<T>(
  run: () => Promise<T>,
  refusals: { readonly codes?: readonly HfosErrorCode[]; readonly rules?: readonly string[] },
): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    if (
      e instanceof HfosError &&
      (refusals.codes?.includes(e.code) || (e.rule && refusals.rules?.includes(e.rule)))
    )
      return null;
    throw e;
  }
}

/** The first screen: the business's name and kind, and its website, which Ava starts reading. */
async function saveBusiness(
  ctx: CommandContext,
  business: NonNullable<AiSetupSaveInput['business']>,
): Promise<{ scanStarted: boolean }> {
  const ws = ctx.scope.workspaceId!;
  const [w] = await ctx.tx
    .select({ name: workspaces.name, industry: workspaces.industry, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ws));
  const settings = (w?.settings ?? {}) as Record<string, unknown>;
  let website: string | null | undefined;
  if (business.website !== undefined) {
    try {
      website = business.website ? normalizeSiteUrl(business.website) : null;
    } catch (e) {
      if (!(e instanceof HfosError)) throw e;
      throw HfosError.validation(
        [{ path: 'business.website', message: e.message }],
        `That website address doesn’t look right. ${e.message}`,
      );
    }
  }
  const update = {
    ...(business.name !== undefined && business.name !== w?.name ? { name: business.name } : {}),
    ...(business.industry !== undefined && business.industry !== w?.industry
      ? { industry: business.industry }
      : {}),
    ...(website !== undefined && website !== (settings['website'] ?? null)
      ? { settings: { website } }
      : {}),
  };
  if (Object.keys(update).length)
    await executeCommandWithin(ctx, workspaceUpdate, { workspaceId: ws, ...update });
  if (!website) return { scanStarted: false };

  const source = await executeCommandWithin(ctx, knowledgeSourceSet, {
    workspaceId: ws,
    url: website,
  });
  const { sourceId } = source.output;
  // What the screens start from (what the business does, its services, area, hours and questions for leads):
  // the worker reads the site's main pages (ai-setup/read-site), once per address unless nothing came of it.
  const [src] = await ctx.tx
    .select({ url: knowledgeSources.url, settings: knowledgeSources.settings })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, sourceId))
    .for('update');
  const now = new Date();
  if (src && aiSetupReadDue(src, now)) {
    const asked = { [AI_SETUP_READ_ASKED_KEY]: { url: src.url, at: now.toISOString() } };
    await ctx.tx.execute(sql`update app.knowledge_sources
        set settings = settings || ${JSON.stringify(asked)}::jsonb where id = ${sourceId}`);
    await ctx.emit({
      type: 'ai_setup.read_requested',
      entityType: 'knowledge_source',
      entityId: sourceId,
      payload: { sourceId, url: src.url, requestedBy: requireHuman(ctx).userId },
      after: { url: src.url },
    });
  }
  // The scan, for Knowledge: unless it's been read, or is being read, at this address.
  const [read] = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from app.knowledge_scans where source_id = ${sourceId}
        and status in ('queued', 'running', 'done') limit 1`,
  );
  if (read) return { scanStarted: false };
  const started = await unlessRefused(
    () => executeCommandWithin(ctx, knowledgeScanStart, { workspaceId: ws }),
    { rules: ['scan_running'] },
  );
  return { scanStarted: started !== null };
}

/**
 * The first screen's "Start from" (§9): the agency's saved answers picked, kept with the draft, and the answers with
 * what saved answers set picked again when where they start from changed, by picking others or, while nobody
 * picked, by the kind of business changing. A business with a teammate starts from its own settings instead.
 */
async function startFrom(
  ctx: CommandContext,
  input: AiSetupSaveInput,
  record: AiSetupRecord,
  kinds: { readonly before: SetupKind; readonly now: SetupKind },
): Promise<{ template: string | null | undefined; answers: AiSetupAnswers }> {
  const ws = ctx.scope.workspaceId!;
  const kept = { template: record.template, answers: input.answers };
  const [w] = await rows<{ organizationId: string; teammate: boolean }>(
    ctx.tx,
    sql`select w.organization_id as "organizationId",
          exists (select 1 from app.ai_teammates t where t.workspace_id = w.id) as teammate
        from app.workspaces w where w.id = ${ws}`,
  );
  if (!w || w.teammate) return kept;
  const templates = await loadAiSetupTemplates(ctx.tx, w.organizationId);
  if (input.templateId && !templates.some((t) => t.id === input.templateId))
    throw HfosError.rule(
      'template_gone',
      409,
      'Those saved answers aren’t there anymore. Pick others, or start from our picks.',
    );
  const picked = input.templateId !== undefined ? input.templateId : record.template;
  const was = chosenAiSetupTemplate(templates, record.template, kinds.before);
  const now = chosenAiSetupTemplate(templates, picked, kinds.now);
  if (was?.id === now?.id) return { ...kept, template: picked };
  const state = await loadAiSetupState(ctx.tx, ws);
  return {
    template: picked,
    answers: withAiSetupTemplate(input.answers, state, now?.answers ?? null),
  };
}

export const aiSetupSave = defineCommand({
  name: 'ai_setup.save',
  description:
    'Keep quick setup’s answers while someone is part way through, so they can carry on later or from the phone. Nothing in the business changes until Save, except the first screen: the business’s name, kind and website are saved straight away, and the AI teammate starts reading the website. The first screen also picks where the answers start from: answers the business’s agency saved, or our picks.',
  risk: 1,
  input: AiSetupSaveInput,
  output: AiSetupSaveOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['ai_setup.started', 'ai_setup.read_requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    if (input.business && input.step !== 'business')
      throw HfosError.validation([
        { path: 'business', message: 'The business’s details are saved from the first screen.' },
      ]);
    if (input.templateId !== undefined && input.step !== 'business')
      throw HfosError.validation([
        {
          path: 'templateId',
          message: 'Where the answers start from is picked on the first screen.',
        },
      ]);
    const before = await lockSetup(ctx);
    const { scanStarted } = input.business
      ? await saveBusiness(ctx, input.business)
      : { scanStarted: false };
    const { record, kind } = await lockSetup(ctx);
    const kindChanged = kind !== before.kind;
    // These answers were given for the kind before, so what's picked by kind is picked again (`resumeAiSetup`).
    const answeredFor: SetupKind = kindChanged ? (record.kind ?? before.kind) : kind;
    const reached = laterAiSetupStep(record.reached, input.step);
    const { template, answers } =
      input.step === 'business'
        ? await startFrom(ctx, input, record, { before: before.kind, now: kind })
        : { template: record.template, answers: input.answers };
    // A new run: the first one, or the first save since the last finish.
    const newRun = !record.draft;
    await saveRecord(ctx, {
      ...record,
      draft: answers,
      reached,
      kind: answeredFor,
      ...(template !== undefined ? { template } : {}),
      started:
        newRun || !record.started ? { at: new Date().toISOString(), by: me } : record.started,
    });
    if (newRun)
      await ctx.emit({
        type: 'ai_setup.started',
        entityType: 'workspace',
        entityId: ws,
        payload: { step: input.step, run: record.runs + 1 },
        after: { run: record.runs + 1 },
      });
    return { workspaceId: ws, reached, kind, kindChanged, scanStarted };
  },
});

export const aiSetupFinish = defineCommand({
  name: 'ai_setup.finish',
  description:
    'Save quick setup: open hours, the business profile, quick facts and answers, what to keep from the website, services and a booking calendar when Ava books, a website chat, and the AI teammate’s settings, all at once. The teammate stays off until it’s turned on. Refuses answers that started from older teammate settings (revision_conflict).',
  risk: 2,
  input: AiSetupFinishInput,
  output: AiSetupFinishOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['ai_setup.finished', 'ai_teammate.created', 'ai_teammate.config_saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const { record } = await lockSetup(ctx);
    const state = await loadAiSetupState(ctx.tx, ws);
    if ((state.teammate?.revision ?? null) !== input.baseRevision)
      throw new HfosError(
        'conflict',
        409,
        'Someone changed the AI teammate while you were in quick setup. Reload to start from what they saved, then save again.',
        { revision: state.teammate?.revision ?? null },
        'revision_conflict',
      );
    const answers = input.answers;
    const problems = aiSetupProblems(answers, state);
    if (problems.length)
      throw HfosError.validation(
        problems.map((p) => ({
          path: p.path ? `answers.${p.path}` : 'answers',
          message: p.message,
        })),
        problems[0]!.message,
      );
    const plan = planAiSetup(state, answers);
    const notes: string[] = [];

    // The business: open hours, then the profile, facts and answers.
    if (plan.openHours)
      await executeCommandWithin(ctx, workspaceUpdate, {
        workspaceId: ws,
        settings: { openHours: plan.openHours },
      });
    if (plan.profile)
      await executeCommandWithin(ctx, knowledgeProfileUpdate, {
        workspaceId: ws,
        profile: plan.profile,
      });
    for (const f of plan.facts.create)
      await executeCommandWithin(ctx, knowledgeItemCreate, {
        workspaceId: ws,
        content: { kind: 'fact', title: f.title, body: f.body, tags: [AI_SETUP_FACT_TAG] },
        status: 'published',
      });
    for (const f of plan.facts.update)
      await executeCommandWithin(ctx, knowledgeItemUpdate, {
        workspaceId: ws,
        itemId: f.id,
        content: {
          kind: 'fact',
          title: f.title,
          body: f.body,
          tags: state.facts.find((x) => x.id === f.id)?.tags ?? [AI_SETUP_FACT_TAG],
        },
      });
    for (const f of plan.facts.archive)
      await executeCommandWithin(ctx, knowledgeItemArchive, { workspaceId: ws, itemId: f.id });
    if (plan.faqs.length)
      await executeCommandWithin(ctx, knowledgeItemImportFaqs, {
        workspaceId: ws,
        rows: plan.faqs.map((q) => ({ question: q.question, answer: q.answer })),
        status: 'published',
      });

    // What the website scan found: kept ready to use, or turned down. One someone decided meanwhile is left be.
    const decided = { codes: ['not_found'], rules: ['suggestion_decided'] } satisfies {
      codes: HfosErrorCode[];
      rules: string[];
    };
    let stuck = 0;
    for (const suggestionId of plan.keep)
      try {
        await unlessRefused(
          () =>
            executeCommandWithin(ctx, knowledgeSuggestionAccept, {
              workspaceId: ws,
              suggestionId,
              status: 'published',
            }),
          decided,
        );
      } catch (e) {
        // One that fails an item's checks as written waits in Knowledge → Suggestions for a person to edit.
        if (!(e instanceof HfosError) || e.code !== 'validation') throw e;
        stuck += 1;
      }
    for (const suggestionId of plan.drop)
      await unlessRefused(
        () =>
          executeCommandWithin(ctx, knowledgeSuggestionReject, { workspaceId: ws, suggestionId }),
        decided,
      );
    if (stuck)
      notes.push(
        `${stuck === 1 ? 'One thing' : `${stuck} things`} from your website couldn’t be kept as written. ${stuck === 1 ? 'It’s' : 'They’re'} waiting in Knowledge → Suggestions.`,
      );

    // Booking: the services become a calendar customers can book, with a ZIP check for a list of ZIP codes.
    let calendarId: string | null = null;
    if (plan.booking.calendar) {
      const serviceIds = state.services.map((s) => s.id);
      for (const s of plan.booking.services) {
        const made = await executeCommandWithin(ctx, serviceCreate, {
          workspaceId: ws,
          name: s.name,
          description: s.description || null,
        });
        serviceIds.push(made.output.serviceId);
      }
      const made = await executeCommandWithin(ctx, calendarCreate, {
        workspaceId: ws,
        name: plan.booking.calendar,
        preset: 'service',
        services: serviceIds.slice(0, 50),
      });
      calendarId = made.output.calendarId;
      try {
        await executeCommandWithin(ctx, calendarSetStatus, {
          workspaceId: ws,
          calendarId,
          status: 'active',
        });
      } catch (e) {
        if (!(e instanceof HfosError) || e.rule !== 'calendar_issues') throw e;
        notes.push(e.message);
      }
    }
    if (plan.booking.zipCodes)
      await executeCommandWithin(ctx, territoryCreate, {
        workspaceId: ws,
        name: AI_SETUP_AREA_NAME,
        postalCodes: [...plan.booking.zipCodes],
      });

    // The website chat, answered by the teammate.
    let chat: { widgetId: string; publicKey: string } | null = null;
    if (plan.chat && state.website) {
      const made = await executeCommandWithin(ctx, chatWidgetCreate, {
        workspaceId: ws,
        allowedOrigins: [state.website],
        teammateId: state.teammate?.id ?? null,
      });
      chat = { widgetId: made.output.widgetId, publicKey: made.output.publicKey };
    }

    // The teammate, with what was just made.
    const next = teammateFromAiSetup(state, answers, {
      calendarId,
      widgetId: chat?.widgetId ?? null,
    });
    let saved: { teammateId: string; revision: number };
    if (state.teammate)
      saved = await saveTeammate(ctx, {
        teammateId: state.teammate.id,
        baseRevision: state.teammate.revision,
        next,
        note: 'Quick setup',
      });
    else {
      saved = await insertTeammate(ctx, {
        config: next,
        summary: 'Created with quick setup',
        preset: null,
      });
      if (chat)
        await executeCommandWithin(ctx, chatWidgetUpdate, {
          workspaceId: ws,
          widgetId: chat.widgetId,
          teammateId: saved.teammateId,
        });
    }

    const run = record.runs + 1;
    await saveRecord(ctx, {
      draft: null,
      reached: null,
      kind: null,
      started: record.started,
      finished: { at: new Date().toISOString(), by: me },
      runs: run,
    });
    await ctx.emit({
      type: 'ai_setup.finished',
      entityType: 'ai_teammate',
      entityId: saved.teammateId,
      payload: {
        teammateId: saved.teammateId,
        created: plan.creates,
        run,
        changes: plan.changes.slice(0, 50),
      },
      after: { name: next.identity.name, run, changes: plan.changes.slice(0, 20) },
    });
    return {
      teammateId: saved.teammateId,
      revision: saved.revision,
      changes: [...plan.changes],
      chat,
      calendarId,
      notes,
    };
  },
});

export const aiSetupNoteFound = defineCommand({
  name: 'ai_setup.note_found',
  description:
    'System: keep what the AI teammate read on the business’s website for quick setup to start from: what the business does, its services, where it works, its open hours, the quick facts it answers and questions to ask leads. Kept with the website in Knowledge; a newer website address is read on its own.',
  risk: 0,
  input: AiSetupNoteFoundInput,
  output: AiSetupNoteFoundOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['ai_setup.found'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [source] = await ctx.tx
      .select({
        id: knowledgeSources.id,
        url: knowledgeSources.url,
        settings: knowledgeSources.settings,
      })
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.id, input.sourceId), eq(knowledgeSources.workspaceId, ws)))
      .for('update');
    // The website changed (or went) while it was being read.
    if (!source || source.url !== input.found.url) return { kept: false };
    const found = AiSetupFound.parse({ ...input.found, at: new Date().toISOString() });
    await ctx.tx
      .update(knowledgeSources)
      .set({
        settings: {
          ...((source.settings ?? {}) as Record<string, unknown>),
          [AI_SETUP_FOUND_KEY]: found,
        },
      })
      .where(eq(knowledgeSources.id, source.id));
    const counts = {
      services: found.services.length,
      questions: found.questions.length,
      hours: found.openHours !== null,
      facts: Object.keys(found.facts).length,
    };
    await ctx.emit({
      type: 'ai_setup.found',
      entityType: 'knowledge_source',
      entityId: source.id,
      payload: { sourceId: source.id, url: source.url, ...counts },
      after: { url: source.url, ...counts },
    });
    return { kept: true };
  },
});
