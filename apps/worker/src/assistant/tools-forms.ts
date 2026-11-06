/**
 * The Assistant's form tools. Looking a form up, reading its results and building or changing one run on
 * their own — because a draft is the business's own working copy and no customer can see it. Publishing,
 * closing and texting somebody a link wait for the person's OK on a card: those are the moments a form
 * reaches the public.
 *
 * Everything goes through the same commands and queries the screens use, as the person, marked as done
 * through the Assistant.
 */
import { createHash } from 'node:crypto';
import {
  ANSWER_TARGETS,
  answerProblem,
  ANSWERS_SHOWN_ON_THE_WEB,
  answerWords,
  describeForm,
  formEmbedSnippet,
  FORM_SOURCE_WORDS,
  FORM_STARTERS,
  formState,
  HfosError,
  isCustomTarget,
  customTargetFieldId,
  liveOf,
  mostPoints,
  NOT_FILLED_IN_FOR_THEM,
  parseStoredForm,
  publicFormPath,
  questionKindLabel,
  ruleText,
  type AnswerSheet,
  type AnswerTargetKey,
  type AnswerValue,
  type AssistantCard,
  type FormDefinition,
  type Question,
  type QuestionType,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { AI_UNAVAILABLE_MESSAGE } from '../ai/ask';
import { draftForm } from '../forms/builder';
import type { SafeFetch } from '../http/safe-fetch';
import { siteAddress, websiteDesign } from '../http/website-style';
import type { WorkerServices } from '../services';
import { publicOriginFor } from './full-links';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { command, query, quoted, rehearse, when } from './tools-read';

type Args = Record<string, unknown>;
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;

export interface FormToolDeps {
  readonly ai: WorkerServices['ai'];
  readonly log: Logger;
  readonly wallet: WorkerServices['wallet'];
  /** For Match my website: the worker's safe fetch (https only, never a private address). */
  readonly fetchUrl?: SafeFetch;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const formPaths = (ws: string) => ({
  list: () => `/app/w/${ws}/forms`,
  form: (id: string) => `/app/w/${ws}/forms/${id}`,
});

function confirmCard(
  toolCallId: string,
  tool: string,
  card: Pick<ConfirmCard, 'title' | 'fields' | 'body' | 'warnings' | 'confirmLabel'> &
    Partial<Pick<ConfirmCard, 'personId'>>,
): ConfirmCard {
  return {
    type: 'confirm',
    toolCallId,
    tool,
    personId: null,
    conversationId: null,
    stageFrom: null,
    stageTo: null,
    reasons: [],
    editable: false,
    ...card,
  };
}

interface FormSummary {
  formId: string;
  name: string;
  mode: string;
  status: string;
  slug: string;
  questionCount: number;
  responseCount: number;
  completionRate: number | null;
  version: number | null;
  /** The sites allowed to show it in a frame (Share → Sites allowed to show it). */
  embedOrigins: string[];
  /** Let the AI teammate ask it (Share). */
  inChat: boolean;
}

/** Said when a form tool is called without a form. */
const NO_FORM_ID = 'Say which form: give its formId, from list_forms.';
/** Why a published form has no link: every form's link starts with the business's link name. */
export const NO_LINK_NAME =
  'This business has no link name yet, so its forms have no address. Set one under Settings → Calendars → Booking site.';

/** The business's link name (Settings → Calendars → Booking site), which every form's link starts with. */
const siteSlugOf = async (db: Db, ctx: ToolContext): Promise<string | null> =>
  (await query<{ site: { slug: string } | null }>(db, ctx, 'booking_site.get', {})).site?.slug ??
  null;

/** Why a live poll has no link: its public page is never served, so a link to it would only say it isn't there. */
const POLL_HAS_NO_LINK =
  'A live poll has no link: its questions pop up during a HandsFreeOS video call or webinar.';

/**
 * A form's link as Share copies it, for what the model reads: its path, which the executor writes out whole on the
 * business's own domain when one is serving (full-links.ts). Null for a draft, which has no link yet, and for a live
 * poll, which never has one.
 */
const linkPath = (site: string | null, f: Pick<FormSummary, 'status' | 'slug' | 'mode'>) =>
  site && f.status !== 'draft' && f.mode !== 'poll' ? publicFormPath(site, f.slug) : null;

/**
 * A form's whole link, as it goes to a customer and on a card: on the business's own domain once it's serving, else the
 * app's address. Null when the business has no link name yet.
 */
export async function wholeFormLink(
  db: Db,
  ctx: ToolContext,
  webUrl: string,
  formSlug: string,
): Promise<string | null> {
  const site = await siteSlugOf(db, ctx);
  if (!site) return null;
  const origin = (await publicOriginFor(db, ctx, webUrl)).replace(/\/+$/, '');
  return `${origin}${publicFormPath(site, formSlug)}`;
}

/** "62% finish it", as the Forms list says it. */
const finishWords = (rate: number | null) =>
  rate === null ? undefined : `${Math.round(rate * 100)}% finish it`;

// ---------- reading ----------

async function listForms(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const [out, site] = await Promise.all([
    query<{ items: FormSummary[] }>(db, ctx, 'form.list', {
      ...(str(args['status']) ? { status: [str(args['status'])] } : {}),
      ...(str(args['mode']) ? { mode: [str(args['mode'])] } : {}),
    }),
    siteSlugOf(db, ctx),
  ]);
  return {
    result: {
      forms: out.items.map((f) => ({
        formId: f.formId,
        name: f.name,
        kind: f.mode,
        status: f.status,
        link: linkPath(site, f),
        questions: f.questionCount,
        answers: f.responseCount,
        ...(finishWords(f.completionRate) ? { finishRate: finishWords(f.completionRate) } : {}),
        version: f.version,
        sitesAllowedToShowIt: f.embedOrigins,
        aiTeammateAsksIt: f.inChat,
      })),
      ...(!site && out.items.some((f) => f.status !== 'draft' && f.mode !== 'poll')
        ? { noLink: NO_LINK_NAME }
        : {}),
      ...(out.items.some((f) => f.mode === 'poll') ? { pollLink: POLL_HAS_NO_LINK } : {}),
    },
  };
}

interface Catalogs {
  pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[];
  tags: { id: string; name: string }[];
  workflows: { id: string; name: string }[];
  customFields: { id: string; label: string }[];
  team: { userId: string; name: string }[];
  calendars: { id: string; name: string; services: { id: string; name: string }[] }[];
}

/** The names the editor's pickers show, for the ids a form keeps. */
function namesFrom(c: Catalogs | null) {
  const of = (list: { id: string; name: string }[] | undefined, id: unknown) =>
    (list ?? []).find((x) => x.id === id)?.name ?? null;
  return {
    calendar: (id: unknown) => of(c?.calendars, id),
    service: (id: unknown) =>
      of(
        c?.calendars.flatMap((x) => x.services),
        id,
      ),
    pipeline: (id: unknown) => of(c?.pipelines, id),
    stage: (id: unknown) =>
      of(
        c?.pipelines.flatMap((p) => p.stages),
        id,
      ),
    workflow: (id: unknown) => of(c?.workflows, id) ?? 'A workflow that isn’t live',
    tag: (id: unknown) => of(c?.tags, id) ?? 'A deleted tag',
    person: (id: unknown) => (c?.team ?? []).find((t) => t.userId === id)?.name ?? 'Someone',
    /** Where the answer goes, as the question's Where the answer goes says it. */
    target: (mapTo: string) =>
      isCustomTarget(mapTo)
        ? ((c?.customFields ?? []).find((f) => f.id === customTargetFieldId(mapTo))?.label ??
          'A field of this business’s')
        : (ANSWER_TARGETS[mapTo as AnswerTargetKey]?.label ?? mapTo),
  };
}
type Names = ReturnType<typeof namesFrom>;

/** Who a lead or task goes to, or who hears about an answer, in the builder's words. */
function whoWords(
  // An id, or a starter's placeholder for one (a person's name is looked up, so a placeholder reads as Someone).
  who: { kind: string; userId?: unknown; userIds?: readonly unknown[] } | null | undefined,
  names: Names,
): string {
  switch (who?.kind) {
    case 'user':
      return names.person(who.userId);
    case 'users':
      return (who.userIds ?? []).map((id) => names.person(id)).join(', ');
    case 'admins':
      return 'The owners and admins';
    case 'lead_assignee':
      return 'Whoever has the lead';
    case 'person_owner':
      return 'Whoever looks after the customer';
    default:
      return 'Nobody';
  }
}

/** A question's own settings with the calendars and services it books named, not given as ids. */
function settingsOf(config: Record<string, unknown>, names: Names): Record<string, unknown> {
  const { choices: _choices, calendarId, serviceId, ...rest } = config;
  return {
    ...rest,
    ...(typeof calendarId === 'string'
      ? { calendar: calendarId ? (names.calendar(calendarId) ?? 'A calendar that’s gone') : null }
      : {}),
    ...(serviceId !== undefined
      ? { service: serviceId ? (names.service(serviceId) ?? 'A service that’s gone') : null }
      : {}),
  };
}

/** One question as its row and its settings show it: the choices, where the answer goes, when it shows. */
function questionOut(q: Question, definition: FormDefinition, names: Names) {
  const config = (q.config ?? {}) as Record<string, unknown>;
  const choices = (config['choices'] as { id: string; label: string }[] | undefined) ?? [];
  const settings = settingsOf(config, names);
  return {
    id: q.id,
    title: q.title,
    kind: questionKindLabel({ type: q.type as QuestionType, config: q.config }),
    ...(q.help ? { help: q.help } : {}),
    ...(q.required ? { required: true } : {}),
    ...(choices.length ? { choices: choices.map((c) => ({ id: c.id, label: c.label })) } : {}),
    ...(q.mapTo ? { fillsIn: names.target(q.mapTo) } : {}),
    ...(q.showIf.conditions.length ? { showsOnlyWhen: ruleText(q.showIf, definition) } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(definition.mode === 'poll' ? { live: liveOf(q) } : {}),
  };
}

/**
 * What happens when somebody sends it, as the builder sets it: the customer it makes, the lead or task it opens, the
 * workflows it starts and who hears about it.
 */
function whenSentOf(d: FormDefinition, names: Names) {
  const o = d.onSubmit;
  return {
    customer: {
      matchedBy: o.person.match,
      addsNewOnes: o.person.create,
      ...(o.person.source ? { source: o.person.source } : {}),
      ...(o.person.tagIds.length ? { tags: o.person.tagIds.map((id) => names.tag(id)) } : {}),
    },
    lead: o.lead
      ? {
          pipeline: names.pipeline(o.lead.pipelineId),
          stage: names.stage(o.lead.stageId),
          title: o.lead.title,
          assignedTo: whoWords(o.lead.assignTo, names),
          ...(o.lead.valueFrom
            ? {
                valueFrom:
                  d.calculations.find((c) => c.id === o.lead!.valueFrom)?.name ?? 'A calculation',
              }
            : {}),
        }
      : null,
    task: o.task
      ? {
          title: o.task.title,
          assignedTo: whoWords(o.task.assignTo, names),
          dueInDays: o.task.dueInDays,
        }
      : null,
    workflows: o.workflowIds.map((id) => names.workflow(id)),
    tells: o.notify ? whoWords(o.notify, names) : 'Nobody',
  };
}

async function getForm(db: Db, ctx: ToolContext, args: Args, webUrl: string): Promise<ToolOutcome> {
  const formId = str(args['formId']);
  if (!formId) throw HfosError.validation(undefined, NO_FORM_ID);
  const [out, site, catalogs] = await Promise.all([
    query<{
      form: FormSummary;
      definition: unknown;
      issues: { message: string }[];
      unpublishedChanges: boolean;
    }>(db, ctx, 'form.get', { formId }),
    siteSlugOf(db, ctx),
    query<Catalogs>(db, ctx, 'form.catalogs').catch(() => null),
  ]);
  const d = out.definition as FormDefinition;
  const f = out.form;
  const names = namesFrom(catalogs);
  const link = linkPath(site, f);
  const poll = d.mode === 'poll';
  return {
    result: {
      form: {
        formId: f.formId,
        name: f.name,
        kind: f.mode,
        status: f.status,
        answers: f.responseCount,
        ...(finishWords(f.completionRate) ? { finishRate: finishWords(f.completionRate) } : {}),
        version: f.version,
        unpublishedChanges: out.unpublishedChanges,
      },
      // Share: the link, the snippet for their own site, the sites allowed to show it and the AI teammate's switch.
      link,
      ...(poll
        ? { noLink: POLL_HAS_NO_LINK }
        : f.status !== 'draft' && !site
          ? { noLink: NO_LINK_NAME }
          : {}),
      ...(link && !poll
        ? {
            embedSnippet: formEmbedSnippet({ publicUrl: link, appOrigin: webUrl, name: f.name }),
            embedNote:
              'The snippet works only on the sites in sitesAllowedToShowIt (do_form_set_delivery embedOrigins sets the whole list).',
          }
        : {}),
      sitesAllowedToShowIt: f.embedOrigins,
      aiTeammateAsksIt: f.inChat,
      // The questions tab, as the person would see each question open.
      heading: d.title,
      ...(d.intro ? { intro: d.intro } : {}),
      asks: describeForm(d),
      questions: d.pages.flatMap((p) => p.questions.map((q) => questionOut(q, d, names))),
      ...(d.pages.length > 1
        ? {
            pages: d.pages.map((p, i) => ({
              id: p.id,
              page: i + 1,
              heading: p.title,
              questionIds: p.questions.map((q) => q.id),
              ...(p.savesContact ? { savesTheirDetailsWhenTheyLeave: true } : {}),
              ...(p.showIf.conditions.length ? { showsOnlyWhen: ruleText(p.showIf, d) } : {}),
            })),
          }
        : {}),
      settings: {
        whoTheyAre: d.settings.identity,
        oneQuestionAtATime: d.settings.oneQuestionAtATime,
        onePageAtATime: d.settings.onePageAtATime,
        showProgress: d.settings.showProgress,
        saveAndComeBack: d.settings.saveAndResume,
        oneAnswerEach: d.settings.oneResponsePerPerson,
        buttonSays: d.settings.submitLabel,
        ...(d.settings.closesAt ? { closesAt: d.settings.closesAt } : {}),
        ...(d.settings.closesAfter ? { closesAfterAnswers: d.settings.closesAfter } : {}),
      },
      design: d.design,
      whenSent: whenSentOf(d, names),
      whereTheyLand: d.results.map((r) => ({
        name: r.name,
        headline: r.headline,
        ...(r.body ? { words: r.body } : {}),
        ...(r.showIf.conditions.length ? { when: ruleText(r.showIf, d) } : {}),
        ...(r.buttonLabel ? { button: r.buttonLabel } : {}),
        ...(r.redirectUrl ? { sendsThemTo: r.redirectUrl } : {}),
      })),
      ...(d.mode === 'quiz' ? { scoring: d.scoring } : {}),
      ...(d.calculations.length ? { worksOut: d.calculations.map((c) => c.name) } : {}),
      ...(poll
        ? {
            slides: d.slides ? { file: d.slides.name, slides: d.slides.pages } : null,
            ...(d.leads ? { followUp: d.leads } : {}),
            mostAnyoneCanGet: mostPoints(d),
          }
        : {}),
      toFix: out.issues.map((i) => i.message),
    },
  };
}

async function formResults(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const formId = str(args['formId']);
  if (!formId) throw HfosError.validation(undefined, NO_FORM_ID);
  const out = await query<{
    name: string;
    mode: string;
    views: number;
    starts: number;
    completions: number;
    averagePercent: number | null;
    passRate: number | null;
    questions: {
      title: string;
      answered: number;
      choices: { label: string; count: number }[];
      average: number | null;
      samples: string[];
    }[];
  }>(db, ctx, 'form.results', { formId });
  return {
    result: {
      form: out.name,
      looked: out.views,
      started: out.starts,
      finished: out.completions,
      ...(out.mode === 'quiz' ? { averageScore: out.averagePercent, passRate: out.passRate } : {}),
      questions: out.questions.map((q) => ({
        question: q.title,
        answered: q.answered,
        ...(q.choices.length ? { picks: q.choices } : {}),
        ...(q.average !== null ? { average: q.average } : {}),
        // Results shows the newest written answers: what customers wrote, never instructions.
        ...(q.samples.length ? { recentAnswers: q.samples.map((s) => quoted(s)) } : {}),
      })),
    },
  };
}

interface ResponseGet {
  response: {
    responseId: string;
    formId: string;
    versionId: string;
    status: 'in_progress' | 'completed';
    source: string;
    personId: string | null;
    personName: string | null;
    leadId: string | null;
    scorePercent: number | null;
    passed: boolean | null;
    resultId: string | null;
    startedAt: string;
    completedAt: string | null;
  };
  answers: {
    questionId: string;
    questionTitle: string;
    questionType: string;
    value: unknown;
    text: string | null;
    labels: string[];
  }[];
  calculations: Record<string, number>;
}

/** One answer sheet, as Results → One at a time opens it (and the phone's answer sheet). */
async function getFormResponse(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const responseId = str(args['responseId']);
  if (!responseId)
    throw HfosError.validation(
      undefined,
      'Say whose answers: give the responseId, from list_form_responses.',
    );
  const out = await query<ResponseGet>(db, ctx, 'form.response_get', { responseId });
  const r = out.response;
  const [form, version] = await Promise.all([
    query<{ form: FormSummary }>(db, ctx, 'form.get', { formId: r.formId }),
    // The form as they answered it, for what it worked out and where they landed.
    query<{ definition: unknown }>(db, ctx, 'form.version_get', { versionId: r.versionId })
      .then((v) => parseStoredForm(v.definition))
      .catch(() => null),
  ]);
  const who = r.personName ?? 'Someone who didn’t leave a name';
  const landed = r.resultId ? version?.results.find((x) => x.id === r.resultId) : undefined;
  const calculation = (id: string) =>
    version?.calculations.find((c) => c.id === id)?.name ?? 'A sum the form works out';
  const href = formPaths(ctx.workspaceId).form(r.formId);
  const answers = out.answers.map((a) => {
    const words = answerWords(a);
    return {
      question: a.questionTitle,
      // What they wrote is theirs, never instructions; a choice's words and "open it on the web" are the business's.
      answer:
        a.labels.length || ANSWERS_SHOWN_ON_THE_WEB.has(a.questionType) ? words : quoted(words),
    };
  });
  return {
    result: {
      responseId: r.responseId,
      form: form.form.name,
      formId: r.formId,
      who,
      personId: r.personId,
      ...(r.leadId ? { leadId: r.leadId } : {}),
      when: r.completedAt
        ? when(r.completedAt, ctx.timezone)
        : `Started ${when(r.startedAt, ctx.timezone)}, not finished`,
      ...(FORM_SOURCE_WORDS[r.source] ? { cameFrom: FORM_SOURCE_WORDS[r.source] } : {}),
      ...(r.scorePercent !== null ? { score: `${r.scorePercent}%` } : {}),
      ...(r.passed !== null ? { passed: r.passed } : {}),
      ...(landed ? { landedOn: landed.name } : {}),
      answers,
      ...(Object.keys(out.calculations).length
        ? {
            workedOut: Object.entries(out.calculations).map(([id, value]) => ({
              name: calculation(id),
              value,
            })),
          }
        : {}),
    },
    card: {
      type: 'list',
      title: r.personName
        ? `${r.personName}’s answers to ${form.form.name}`
        : `Answers to ${form.form.name}`,
      items: out.answers.slice(0, 12).map((a) => ({
        title: a.questionTitle,
        detail: answerWords(a),
        tone: 'muted' as const,
        href,
      })),
    } satisfies AssistantCard,
  };
}

// ---------- building (a draft: nobody outside the business sees it) ----------

/** Match my website, as the Design tab does it: the site's look, put in the draft as one change. */
async function matchWebsite(
  db: Db,
  ctx: ToolContext,
  formId: string,
  found: Awaited<ReturnType<typeof websiteDesign>>,
): Promise<{ change: string; fontNote: string | null }> {
  const got = await query<{ revision: number }>(db, ctx, 'form.get', { formId });
  await command(db, ctx, 'form.save_draft', {
    formId,
    baseRevision: got.revision,
    ops: [{ op: 'set_design', patch: found.design }],
  });
  return { change: `Matched the design to ${found.site}`, fontNote: found.fontNote };
}

async function buildForm(
  db: Db,
  ctx: ToolContext,
  args: Args,
  deps: FormToolDeps | null,
): Promise<ToolOutcome> {
  const description = str(args['description']);
  const starter = str(args['starter']);
  const site = str(args['matchWebsite']);
  if (!description && !starter && !site)
    throw HfosError.validation(
      undefined,
      'Say what the form should ask: put it in description, in the person’s words, or name a starter.',
    );
  if (description && !deps?.ai.provider)
    return { result: { error: AI_UNAVAILABLE_MESSAGE }, isError: true };
  // Read before anything is made, so a form isn't started for a look that can't be read.
  if (site && !deps?.fetchUrl)
    throw HfosError.rule(
      'website_unreadable',
      503,
      'Websites can’t be read from here just now. Use Match my website on the form’s Design tab instead.',
    );
  const look =
    site && deps?.fetchUrl
      ? await websiteDesign({ fetchUrl: deps.fetchUrl, log: deps.log }, siteAddress(site))
      : null;

  let formId = str(args['formId']);
  let made = false;
  if (!formId) {
    const created = await command<{ formId: string }>(db, ctx, 'form.create', {
      name: str(args['name']) ?? FORM_STARTERS.find((s) => s.key === starter)?.name ?? 'New form',
      mode: str(args['mode']) ?? 'form',
      ...(starter ? { starter } : {}),
    });
    formId = created.formId;
    made = true;
  }
  const matched = look ? await matchWebsite(db, ctx, formId, look) : null;
  const drafted =
    description && deps
      ? await draftForm({ db, ai: deps.ai, log: deps.log, wallet: deps.wallet }, ctx.actor, {
          workspaceId: ctx.workspaceId,
          formId,
          prompt: description,
        })
      : null;
  const issues = drafted
    ? drafted.issues
    : (await query<{ issues: { message: string }[] }>(db, ctx, 'form.get', { formId })).issues;
  const changes = [
    ...(made && starter
      ? [`Started from “${FORM_STARTERS.find((s) => s.key === starter)?.name ?? starter}”`]
      : []),
    ...(matched ? [matched.change] : []),
    ...(drafted?.changes ?? []),
  ];
  const href = formPaths(ctx.workspaceId).form(formId);
  return {
    result: {
      formId,
      created: made,
      summary: drafted?.summary ?? null,
      changes,
      ...(matched?.fontNote ? { fontNote: matched.fontNote } : {}),
      ...(drafted?.leftover.length ? { couldNotDo: drafted.leftover } : {}),
      ...(issues.length ? { toFixBeforePublishing: issues.map((i) => i.message) } : {}),
      saved: 'As a draft. Nothing a customer sees has changed; publishing is a separate step.',
    },
    card: {
      type: 'done',
      toolCallId: '',
      kind: 'note',
      title: made ? 'Drafted a form' : 'Changed a form',
      detail: [
        ...(drafted?.summary ? [drafted.summary] : []),
        ...changes.slice(0, 6),
        ...(issues.length ? [`Still to fix: ${issues[0]!.message}`] : []),
      ].join(' · '),
      href,
      undoable: false,
    } as AssistantCard,
    command: made ? 'form.create' : 'form.save_draft',
    record: { formId, href },
  };
}

// ---------- what the public sees: on a card ----------

interface ConfirmTool {
  prepare(
    db: Db,
    ctx: ToolContext,
    args: Args,
    toolCallId: string,
    /** `webUrl`, for a link the card shows whole, as it will go out. */
    deps?: { readonly webUrl?: string },
  ): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    /** `webUrl` is the web app's address: a link that goes to a customer needs the whole thing, not a path. */
    extra: { readonly toolCallId: string; readonly webUrl: string },
  ): Promise<CommittedAction>;
}

const ACTION_WORDS = {
  publish: { title: 'Publish this form?', confirm: 'Publish' },
  close: { title: 'Stop taking answers?', confirm: 'Close it' },
  reopen: { title: 'Take answers again?', confirm: 'Reopen' },
} as const;

const publishForm: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const formId = str(args['formId']);
    const action = (str(args['action']) ?? 'publish') as keyof typeof ACTION_WORDS;
    if (!formId) throw HfosError.validation(undefined, NO_FORM_ID);
    const out = await query<{
      form: FormSummary;
      issues: { message: string }[];
      unpublishedChanges: boolean;
      definition: Parameters<typeof describeForm>[0];
    }>(db, ctx, 'form.get', { formId });
    const words = ACTION_WORDS[action] ?? ACTION_WORDS.publish;
    const fields =
      action === 'publish'
        ? [
            { label: 'Form', value: out.form.name },
            { label: 'Asks', value: plural(out.form.questionCount, 'question') },
            {
              label: 'What changes',
              value: out.form.version
                ? `It is on version ${out.form.version}; this makes version ${out.form.version + 1}.`
                : 'Anybody with the link will be able to fill it in.',
            },
          ]
        : [
            { label: 'Form', value: out.form.name },
            {
              label: 'What changes',
              value:
                action === 'close'
                  ? 'It stops taking answers. The link still opens and says so.'
                  : 'It takes answers again.',
            },
          ];
    const blocked = action === 'publish' && out.issues.length ? out.issues[0]!.message : null;
    return {
      card: confirmCard(toolCallId, 'publish_form', {
        title: words.title,
        fields,
        body: action === 'publish' ? describeForm(out.definition).slice(0, 6).join('\n') : null,
        warnings: blocked ? [{ kind: 'form_issues', text: blocked }] : [],
        confirmLabel: blocked ? '' : words.confirm,
      }),
      result: { asked: words.title, issues: out.issues.map((i) => i.message) },
    };
  },
  async commit(db, ctx, args) {
    const formId = String(args['formId']);
    const action = (str(args['action']) ?? 'publish') as keyof typeof ACTION_WORDS;
    if (action === 'publish') {
      const got = await query<{ revision: number; form: FormSummary }>(db, ctx, 'form.get', {
        formId,
      });
      const out = await command<{ version: number }>(db, ctx, 'form.publish', {
        formId,
        baseRevision: got.revision,
        source: 'assistant',
      });
      return {
        outcome:
          out.version === 1
            ? `Published “${got.form.name}”. It is taking answers.`
            : `Published version ${out.version} of “${got.form.name}”.`,
        href: formPaths(ctx.workspaceId).form(formId),
        command: 'form.publish',
      };
    }
    await command(db, ctx, 'form.set_status', {
      formId,
      status: action === 'close' ? 'closed' : 'live',
    });
    return {
      outcome:
        action === 'close' ? 'It has stopped taking answers.' : 'It is taking answers again.',
      href: formPaths(ctx.workspaceId).form(formId),
      command: 'form.set_status',
    };
  },
};

/** The link a text or email carries, under the words: refused when the business has no link name to build it on. */
async function linkToSend(db: Db, ctx: ToolContext, webUrl: string, slug: string) {
  // Publishing gives the business its public name, so a live form has one. Without it there is no address to
  // send, and texting somebody a bare path would be worse than saying so.
  const link = await wholeFormLink(db, ctx, webUrl, slug);
  if (!link) throw HfosError.conflict(NO_LINK_NAME, 'no_booking_site');
  return link;
}

const sendForm: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const formId = str(args['formId']);
    const personId = str(args['personId']);
    const message = str(args['message']);
    if (!formId || !personId || !message) {
      const lacking = [
        !formId && 'formId (from list_forms)',
        !personId && 'personId (from search_customers)',
        !message && 'message (what to say with the link)',
      ].filter(Boolean);
      throw HfosError.validation(undefined, `This needs ${lacking.join(' and ')} too.`);
    }
    const form = await query<{ form: FormSummary }>(db, ctx, 'form.get', { formId });
    if (form.form.status !== 'live')
      throw HfosError.rule(
        'form_not_live',
        409,
        form.form.status === 'closed'
          ? `“${form.form.name}” was closed and isn’t taking answers. Reopen it with publish_form first.`
          : `“${form.form.name}” isn’t published yet, so it isn’t taking answers. Publish it with publish_form first.`,
      );
    // A live poll's page is never served: a text with its link would only open a page that isn't there.
    if (form.form.mode === 'poll')
      throw HfosError.rule(
        'form_is_a_poll',
        409,
        `“${form.form.name}” is a live poll, so it has no link to send: its questions pop up during a HandsFreeOS video call or webinar. Invite them to the call instead.`,
      );
    // The address that goes with the words, as it will go out, so it's agreed to with the rest.
    const link = await linkToSend(db, ctx, deps?.webUrl ?? '', form.form.slug);
    const person = await query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
      personId,
    });
    const channel = str(args['channel']) === 'email' ? 'email' : 'sms';
    return {
      card: confirmCard(toolCallId, 'send_form', {
        title: channel === 'sms' ? 'Send this text?' : 'Send this email?',
        fields: [
          { label: 'To', value: person.person.fullName },
          { label: 'Form', value: form.form.name },
        ],
        body: `${message}\n\n${link}`,
        warnings: [],
        confirmLabel: 'Send it',
        personId,
      }),
      result: { asked: 'Waiting for their OK before it goes out.', link },
    };
  },
  async commit(db, ctx, args, extra) {
    const formId = String(args['formId']);
    const personId = String(args['personId']);
    const channel = str(args['channel']) === 'email' ? 'email' : 'sms';
    const form = await query<{ form: FormSummary }>(db, ctx, 'form.get', { formId });
    // Their own domain once one is serving (M17), so the link the Assistant sends matches the one on their
    // booking page and their flyers.
    const link = await linkToSend(db, ctx, extra.webUrl, form.form.slug);
    const body = `${String(args['message'])}\n\n${link}`;
    if (channel === 'sms') {
      await command(db, ctx, 'message.send', { personId, body });
      return { outcome: 'Sent.', href: null, command: 'message.send' };
    }
    await command(db, ctx, 'email.send', {
      personId,
      subject: form.form.name,
      body,
    });
    return { outcome: 'Sent.', href: null, command: 'email.send' };
  },
};

// ---------- filling one in for a customer: the phone's Fill it in ----------

/** A choice by its id or by its words; anything else stays as said (a form that allows Other takes it). */
function choiceOf(q: Question, said: unknown): unknown {
  if (typeof said !== 'string') return said;
  const choices = ((q.config ?? {}) as { choices?: { id: string; label: string }[] }).choices ?? [];
  const text = said.trim();
  const found =
    choices.find((c) => c.id === text) ??
    choices.find((c) => c.label.trim().toLowerCase() === text.toLowerCase());
  return found ? found.id : text;
}

/** What the model said, as the answer the question takes: what the phone's field would have sent. */
function answerFor(q: Question, said: unknown): AnswerValue {
  switch (q.type) {
    case 'choice':
      return choiceOf(q, said) as AnswerValue;
    case 'checkboxes':
      return (Array.isArray(said) ? said : [said]).map((x) => choiceOf(q, x)) as string[];
    case 'yes_no':
      if (typeof said === 'string' && /^(yes|y|true)$/i.test(said.trim())) return 'yes';
      if (typeof said === 'string' && /^(no|n|false)$/i.test(said.trim())) return 'no';
      return said as AnswerValue;
    case 'number':
    case 'money':
    case 'rating':
    case 'scale': {
      const n = typeof said === 'string' && said.trim() ? Number(said.trim()) : NaN;
      return (Number.isFinite(n) ? n : said) as AnswerValue;
    }
    default:
      return said as AnswerValue;
  }
}

/** An answer in words, for the card: the choices' words, Yes or No, an address on one line. */
function shownAs(q: Question, value: AnswerValue): string {
  const choices = ((q.config ?? {}) as { choices?: { id: string; label: string }[] }).choices ?? [];
  const label = (v: unknown) => choices.find((c) => c.id === v)?.label ?? String(v);
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (q.type === 'yes_no') return value === 'yes' ? 'Yes' : value === 'no' ? 'No' : String(value);
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, unknown>)
      .filter((v) => typeof v === 'string' && v.trim())
      .join(', ');
  return q.type === 'choice' ? label(value) : String(value ?? '');
}

/** What a question needs that only the customer can give, in words. */
const NEEDS_THEM: Partial<Record<QuestionType, string>> = {
  file: 'a file from them',
  signature: 'their signature',
  payment: 'a card payment',
  video: 'them to watch a video',
  booking: 'them to pick a time',
  button: 'them to press a button',
};

/** The form people fill in now (its live version), with the sheet the model's answers make on it. */
async function sheetFor(db: Db, ctx: ToolContext, args: Args) {
  const formId = str(args['formId']);
  if (!formId) throw HfosError.validation(undefined, NO_FORM_ID);
  const got = await query<{
    form: FormSummary;
    versions: { versionId: string; live: boolean }[];
  }>(db, ctx, 'form.get', { formId });
  const f = got.form;
  if (f.mode === 'poll')
    throw HfosError.rule(
      'form_is_a_poll',
      409,
      `“${f.name}” is a live poll: it’s answered during a video call, so it can’t be filled in for someone.`,
    );
  const live = got.versions.find((v) => v.live);
  if (f.status !== 'live' || !live)
    throw HfosError.rule(
      'form_not_live',
      409,
      f.status === 'closed'
        ? `“${f.name}” was closed and isn’t taking answers. Reopen it with publish_form first.`
        : `“${f.name}” isn’t published yet, so it can’t take answers. Publish it with publish_form first.`,
    );
  const version = await query<{ definition: unknown }>(db, ctx, 'form.version_get', {
    versionId: live.versionId,
  });
  const definition = parseStoredForm(version.definition);
  const questions = new Map(
    definition.pages.flatMap((p) => p.questions).map((q) => [q.id, q] as const),
  );
  const given = (args['answers'] ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(given).filter((id) => !questions.has(id));
  if (unknown.length)
    throw HfosError.validation(
      undefined,
      `“${f.name}” has no question ${unknown.join(', ')}. Use the question ids get_form gives.`,
    );
  const raw: AnswerSheet = Object.fromEntries(
    Object.entries(given).map(([id, said]) => [id, answerFor(questions.get(id)!, said)]),
  );
  // What shows, given these answers: an answer to a question that hid itself is dropped, as the server drops it.
  const state = formState(definition, raw);
  const cannot = state.questions.find((q) => NOT_FILLED_IN_FOR_THEM.includes(q.type));
  if (cannot)
    throw HfosError.rule(
      'form_needs_the_customer',
      409,
      `“${cannot.title}” needs ${NEEDS_THEM[cannot.type] ?? 'the customer'}, which can’t be filled in for them. Send them the link with send_form so they fill it in themselves.`,
    );
  const problems = state.questions
    .map((q) => ({ q, problem: answerProblem(q, state.answers[q.id] ?? null) }))
    .filter((p) => p.problem);
  if (problems.length)
    throw HfosError.validation(
      undefined,
      `Some answers won’t do yet. ${problems
        .slice(0, 8)
        .map((p) => `“${p.q.title}” (${p.q.id}): ${p.problem}`)
        .join(' ')} Ask the person for what’s missing, then try again.`,
    );
  const dropped = Object.keys(raw)
    .filter((id) => !(id in state.answers))
    .map((id) => questions.get(id)!.title);
  return { form: f, definition, state, dropped };
}

/** The same answer sheet for the same card, so a Confirm sent twice is one sheet, as the phone's own id makes it. */
function sheetId(toolCallId: string): string {
  const h = createHash('sha256').update(`fill_in_form:${toolCallId}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** What sending it starts, as the builder sets it, in a line for the card's warning. */
function sendingDoes(d: FormDefinition, names: Names): string {
  const sent = whenSentOf(d, names);
  // An anonymous form keeps no customer, so it opens no lead either.
  const anonymous = d.settings.identity === 'anonymous';
  const parts = [
    anonymous
      ? 'keeps the answers with no name on them'
      : sent.customer.addsNewOnes
        ? 'adds them as a customer, or matches one'
        : 'matches a customer',
    ...(sent.lead && !anonymous
      ? [`opens a lead${sent.lead.stage ? ` in ${sent.lead.stage}` : ''}`]
      : []),
    ...(sent.task ? [`makes the task “${sent.task.title}”`] : []),
    ...(sent.workflows.length ? [`starts ${sent.workflows.join(', ')}`] : []),
    ...(sent.tells !== 'Nobody' ? [`tells ${sent.tells}`] : []),
  ];
  return `Sending it does what their own answers would: it ${parts.join(', ')}.`;
}

/** The most lines a Confirm card holds (core's AssistantCard), the form's own among them. */
const CARD_FIELDS = 10;

const fillInForm: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { form, definition, state, dropped } = await sheetFor(db, ctx, args);
    const answered = state.questions.filter((q) => q.id in state.answers);
    if (!answered.length)
      throw HfosError.validation(
        undefined,
        `No answers for “${form.name}” yet. Give them by question id, from get_form.`,
      );
    // Its own rules, tried now and rolled back: a sheet the server won't take is refused here, before anyone presses
    // Confirm.
    await rehearse(db, ctx, 'form_response.record', {
      formId: form.formId,
      answers: state.answers,
    });
    const catalogs = await query<Catalogs>(db, ctx, 'form.catalogs').catch(() => null);
    const lines = answered.map((q) => ({
      label: q.title,
      value: shownAs(q, state.answers[q.id] ?? null),
    }));
    // Every answer is on the card: a line each while they fit beside the form's name, else written out under it.
    const fits = lines.length < CARD_FIELDS;
    return {
      card: confirmCard(toolCallId, 'fill_in_form', {
        title: `Send “${form.name}” with these answers?`,
        fields: [{ label: 'Form', value: form.name }, ...(fits ? lines : [])],
        body: fits ? null : lines.map((l) => `${l.label}: ${l.value}`).join('\n'),
        warnings: [
          { kind: 'caution', text: sendingDoes(definition, namesFrom(catalogs)) },
          {
            kind: 'note',
            text: 'The OK to text and OK to call boxes stay unticked: a yes has to come from the customer themselves.',
          },
        ],
        confirmLabel: 'Send it',
      }),
      result: {
        asked: 'Waiting for their OK before it is sent.',
        answers: answered.length,
        ...(dropped.length ? { notAsked: dropped } : {}),
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const { form, state } = await sheetFor(db, ctx, args);
    const out = await command<{
      responseId: string;
      personId: string | null;
      leadId: string | null;
    }>(db, ctx, 'form_response.record', {
      id: sheetId(extra.toolCallId),
      formId: form.formId,
      answers: state.answers,
    });
    const person = out.personId
      ? await query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
          personId: out.personId,
        }).catch(() => null)
      : null;
    return {
      outcome: `Sent “${form.name}”${person ? ` for ${person.person.fullName}` : ''}. It does what their own answers would.`,
      href: formPaths(ctx.workspaceId).form(form.formId),
      command: 'form_response.record',
      answer: { responseId: out.responseId, personId: out.personId, leadId: out.leadId },
    };
  },
};

export const formAutoTools: Record<
  string,
  (
    db: Db,
    ctx: ToolContext,
    args: Args,
    deps: FormToolDeps | null,
    /** The web app's address: where a form's embed snippet loads its script from. */
    webUrl: string,
  ) => Promise<ToolOutcome>
> = {
  list_forms: (db, ctx, args) => listForms(db, ctx, args),
  get_form: (db, ctx, args, _deps, webUrl) => getForm(db, ctx, args, webUrl),
  form_results: (db, ctx, args) => formResults(db, ctx, args),
  get_form_response: (db, ctx, args) => getFormResponse(db, ctx, args),
  build_form: (db, ctx, args, deps) => buildForm(db, ctx, args, deps),
};

export const formConfirmTools: Record<string, ConfirmTool> = {
  publish_form: publishForm,
  send_form: sendForm,
  fill_in_form: fillInForm,
};
