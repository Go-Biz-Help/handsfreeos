/**
 * The Assistant's extra tools (packages/core/src/assistant/tools-extra.ts): what each does when it runs on its own
 * ("auto"), and the card it shows and the command it runs once the person presses Confirm ("confirm").
 *
 * Four kinds of thing, each through the commands its screen runs:
 * - The AI teammate's finer rules (Qualify, Limits, Hand-off, Phone calls, Identity, Autonomy): read, patched and
 *   saved on the revision it was read at, like manage_ai_teammate, and the card lists each rule before → after.
 * - Settings → Automations: every row's switch, through whichever store it lives in (its own settings, what Home
 *   watches for, or the AI teammate), exactly as the page's switches do (`automationPatch`). Re-engaging dead leads
 *   stays off until someone reads its message on the screen, so the card for it can't be confirmed.
 * - The person's own phone alerts and side menu, and taking part in Ideas and Get help: theirs alone.
 * - Adding a business and pushing to client businesses, which only the organization's owners and admins may do. The
 *   commands check that on the organization; the cards say so first rather than failing on Confirm.
 */
import { randomUUID } from 'node:crypto';
import {
  applyTeammatePatch,
  attentionSettingsOf,
  AUTOMATION_GROUP_TITLES,
  automationCounts,
  automationDef,
  automationPatch,
  automationRow,
  automationRows,
  automationSettingsOf,
  DEFAULT_MENU,
  diffTeammateConfigs,
  formatClock,
  GET_HELP_WORDS,
  HfosError,
  IDEA_STATUS_WORDS,
  ideaUpdateLine,
  IDEAS_WORDS,
  isValidTimeZone,
  MENU_ALWAYS_SHOWN,
  MENU_WORDS,
  menuOf,
  menuSummary,
  moveKey,
  parseAutomationSettings,
  pushSwitchesOf,
  PUSH_SWITCHES,
  reengageOn,
  sameMenu,
  storedMenu,
  SUGGESTED_MENU,
  validateTeammate,
  type AttentionSettings,
  type AutomationContext,
  type AutomationId,
  type AutomationPatch,
  type AutomationSettings,
  type IdeaStatus,
  type Menu,
  type MenuKey,
  type NotifyWho,
  type PushSwitch,
  type PushSwitches,
  type QualifyingQuestion,
  type QualifyingQuestionInput,
  type QuestionKind,
  type TeammateCatalogs,
  type TeammateConfig,
  type TeammatePatch,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext, ToolOutcome } from './runtime';
import { command, query } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };
type Warning = { kind: string; text: string };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : undefined);
const action = (args: Args) => String(args['action'] ?? '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const joinAnd = (items: readonly string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
/** Customer-bound wording keeps straight quotes: a curly one sends a text in the slower encoding. */
const straight = (s: string | undefined) => s?.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
/** Somebody else's words, marked so the model reads them as what they wrote and nothing more. */
const theirs = (text: string) => ({ someone_wrote: text });
/** "Nothing would change.", and why, so the model can tell the person what already matches. */
const nothingChanges = (why: string) => HfosError.validation([], `Nothing would change. ${why}`);

/** A settings document that doesn't pass its schema, as the field errors a person would see on the screen. */
function invalid(e: unknown, message: string): unknown {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] } | null)?.issues;
  if (!(e instanceof Error) || !Array.isArray(issues)) return e;
  return HfosError.validation(
    issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    `${message}: ${issues[0]?.message ?? 'check the values'}`,
  );
}

/** At most ten rows fit on a card; the last one says how many more there are. */
const capFields = (fields: Field[]): Field[] =>
  fields.length <= 10
    ? fields
    : [...fields.slice(0, 9), { label: 'And', value: `${fields.length - 9} more changes` }];

interface Me {
  user: { fullName: string; settings: Record<string, unknown> };
  organizations: { id: string; name: string; role: string }[];
  workspaces: { id: string; organizationId: string; organizationName: string; name: string }[];
}
const meOf = (db: Db, ctx: ToolContext) => query<Me>(db, ctx, 'account.me');

// ---------- the AI teammate's finer rules ----------

interface TeammateGet {
  teammate: {
    id: string;
    name: string;
    status: 'off' | 'training' | 'automatic';
    revision: number;
    config: TeammateConfig;
  } | null;
  catalogs: TeammateCatalogs;
  canManage: boolean;
}

const teammateOf = (db: Db, ctx: ToolContext) => query<TeammateGet>(db, ctx, 'ai_teammate.get');

async function requireTeammate(db: Db, ctx: ToolContext) {
  const got = await teammateOf(db, ctx);
  if (!got.teammate)
    throw HfosError.notFound(
      'There’s no AI teammate yet. Set one up first with manage_ai_teammate.',
    );
  return { teammate: got.teammate, catalogs: got.catalogs };
}

interface QuestionArgs {
  questionId?: string;
  question?: string;
  kind?: QuestionKind;
  choices?: string[];
  required?: boolean;
  notAFitAnswers?: string[];
  notAFitBelow?: number | null;
  notAFitAbove?: number | null;
  fileTell?: string;
  fileTellUserIds?: string[];
}

/**
 * A question from what was asked, on top of the one it changes. When its kind changes, whatever no longer fits is
 * dropped, as the screen does (a yes/no question has no choices, a text question rules nobody out); what was asked
 * for explicitly is kept, so the settings' own check says what's wrong with it.
 */
function questionFrom(
  input: QuestionArgs,
  base: QualifyingQuestion | null,
  id: string,
): QualifyingQuestionInput {
  const kind = input.kind ?? base?.kind ?? 'text';
  const options =
    input.choices ?? (kind === 'choice' && base?.kind === 'choice' ? base.options : []);
  // "No" is the yes/no answer "no", and "rent" the choice "Rent": the settings match them exactly.
  const same = (a: string) =>
    kind === 'yes_no'
      ? a.toLowerCase()
      : (options.find((o) => o.toLowerCase() === a.toLowerCase()) ?? a);
  let answers = input.notAFitAnswers?.map(same) ?? base?.notAFitIf.answers ?? [];
  if (input.notAFitAnswers === undefined)
    answers =
      kind === 'choice'
        ? answers.filter((a) => options.includes(a))
        : kind === 'yes_no'
          ? answers.filter((a) => a === 'yes' || a === 'no').slice(0, 1)
          : [];
  const range = (given: number | null | undefined, was: number | null | undefined) =>
    given !== undefined ? given : kind === 'number' ? (was ?? null) : null;
  // A file question tells someone when it arrives: whoever was said, else whoever it told, else owners and admins.
  const told = whoHears(input.fileTell, input.fileTellUserIds, 'fileTell');
  const notify =
    kind !== 'file'
      ? null
      : told !== undefined
        ? told
        : base?.kind === 'file'
          ? base.notify
          : { kind: 'admins' as const };
  return {
    id,
    question: input.question ?? base?.question ?? '',
    kind,
    options,
    required: input.required ?? base?.required ?? true,
    notAFitIf: {
      answers,
      below: range(input.notAFitBelow, base?.notAFitIf.below),
      above: range(input.notAFitAbove, base?.notAFitIf.above),
    },
    notify,
  };
}

function nextQuestions(
  current: readonly QualifyingQuestion[],
  args: Args,
): QualifyingQuestionInput[] | undefined {
  const add = list<QuestionArgs>(args['addQuestions']);
  const change = list<QuestionArgs>(args['changeQuestions']);
  const remove = list<string>(args['removeQuestionIds']);
  if (!add?.length && !change?.length && !remove?.length) return undefined;
  const missing = [...(remove ?? []), ...(change ?? []).map((c) => c.questionId ?? '')].filter(
    (id) => !current.some((q) => q.id === id),
  );
  if (missing.length)
    throw HfosError.notFound(
      `No question with the id ${missing.join(', ')}. The ids are in get_settings with area ai_teammate.`,
    );
  let out: QualifyingQuestionInput[] = current.map((q) => ({ ...q }));
  out = out.filter((q) => !remove?.includes(q.id));
  for (const c of change ?? []) {
    const at = out.findIndex((q) => q.id === c.questionId);
    const base = current.find((q) => q.id === c.questionId);
    if (at >= 0 && base) out[at] = questionFrom(c, base, base.id);
  }
  const taken = new Set(out.map((q) => q.id));
  for (const a of add ?? []) {
    let id: string;
    do id = `q${randomUUID().slice(0, 6)}`;
    while (taken.has(id));
    taken.add(id);
    out.push(questionFrom(a, null, id));
  }
  return out;
}

/** Who hears, from the words the tool takes to the settings' own shape (undefined: unchanged). */
function whoHears(
  choice: string | undefined,
  userIds: string[] | undefined,
  what: string,
): NotifyWho | null | undefined {
  if (choice === undefined) return userIds?.length ? { kind: 'users', userIds } : undefined;
  switch (choice) {
    case 'no_one':
      return null;
    case 'owners_and_admins':
      return { kind: 'admins' };
    case 'lead_assignee':
      return { kind: 'lead_assignee' };
    case 'customer_owner':
      return { kind: 'person_owner' };
    default:
      if (!userIds?.length)
        throw HfosError.validation(
          [{ path: `${what}UserIds`, message: 'Pick someone.' }],
          `Say who hears about it: give their user ids from list_team in ${what}UserIds.`,
        );
      return { kind: 'users', userIds };
  }
}

function nextTopics(current: readonly string[], args: Args): string[] | undefined {
  const add = list<string>(args['addSensitiveTopics']) ?? [];
  const remove = list<string>(args['removeSensitiveTopics']) ?? [];
  if (!add.length && !remove.length) return undefined;
  const lower = (s: string) => s.trim().toLowerCase();
  const gone = remove.filter((t) => !current.some((c) => lower(c) === lower(t)));
  if (gone.length)
    throw HfosError.validation(
      gone.map((t) => ({
        path: 'removeSensitiveTopics',
        message: `“${t}” isn’t one of its topics.`,
      })),
      `“${gone[0]}” isn’t one of its topics. Refunds, legal threats, complaints and cancelling service are built in, and always go to a person.`,
    );
  const kept = current.filter((c) => !remove.some((t) => lower(t) === lower(c)));
  for (const t of add) if (!kept.some((c) => lower(c) === lower(t))) kept.push(t.trim());
  return kept;
}

/** Only what was asked for; everything else in the teammate's settings is left exactly as it is. */
function rulesPatch(config: TeammateConfig, args: Args): TeammatePatch {
  const patch: Record<string, Record<string, unknown>> = {};
  const put = (module: string, key: string, value: unknown) => {
    if (value !== undefined) (patch[module] ??= {})[key] = value;
  };
  const nest = (module: string, key: string, inner: Record<string, unknown>) => {
    const given = Object.fromEntries(Object.entries(inner).filter(([, v]) => v !== undefined));
    if (Object.keys(given).length) put(module, key, given);
  };
  // Null or empty goes back to the usual one.
  const cleared = (key: string) => (args[key] === undefined ? undefined : (str(args[key]) ?? ''));

  // Identity
  put('identity', 'signature', cleared('emailSignature'));
  put('identity', 'toneNote', cleared('tone'));
  // Qualify
  put('qualify', 'enabled', bool(args['qualifies']));
  put('qualify', 'questions', nextQuestions(config.qualify.questions, args));
  nest('qualify', 'whenQualified', {
    stageId: args['qualifiedLeadStageId'],
    notify: whoHears(
      str(args['qualifiedTell']),
      list<string>(args['qualifiedTellUserIds']),
      'qualifiedTell',
    ),
    offerTimes: bool(args['offerTimesWhenQualified']),
  });
  nest('qualify', 'whenNotAFit', { tellTeam: bool(args['tellTeamWhenNotAFit']) });
  put('deals', 'enabled', bool(args['opensAndClosesDeals']));
  // Limits, and money as the Limits section has it
  put('limits', 'repliesPerConversationPerDay', num(args['repliesPerCustomerPerDay']));
  put('limits', 'toolRounds', num(args['lookUpsPerReply']));
  put('limits', 'dailySharePercent', num(args['shareOfDailyAiLimitPercent']));
  put('money', 'discounts', str(args['discounts']));
  put('money', 'maxPercent', num(args['largestDiscountPercent']));
  put('money', 'bills', bool(args['billsAndPayments']));
  put('money', 'newBills', bool(args['newBills']));
  put('money', 'quotes', str(args['quotes']));
  put('money', 'plans', bool(args['maintenancePlans']));
  // Hand-off
  put('handOff', 'onFrustration', bool(args['handOffWhenFrustrated']));
  put('handOff', 'sensitiveTopics', nextTopics(config.handOff.sensitiveTopics, args));
  const tell = str(args['handOffTell']);
  put(
    'handOff',
    'notify',
    whoHears(
      tell === 'owners_and_admins' ? tell : tell ? 'people' : undefined,
      list<string>(args['handOffTellUserIds']),
      'handOffTell',
    ) ?? undefined,
  );
  nest('handOff', 'alerts', {
    push: bool(args['handOffPhoneAlert']),
    text: bool(args['handOffText']),
    email: bool(args['handOffEmail']),
  });
  put('handOff', 'tellCustomer', straight(str(args['handOffMessage'])));
  // Phone calls
  put('phone', 'enabled', bool(args['answersPhoneCalls']));
  put('phone', 'answer', str(args['phonePicksUp']));
  put('phone', 'voice', str(args['phoneVoice']));
  put('phone', 'greeting', cleared('phoneGreeting'));
  // Autonomy
  put('autonomy', 'approvalsNeeded', num(args['approvalsBeforeAutomatic']));
  put('autonomy', 'draftExpiresMinutes', num(args['draftsExpireAfterMinutes']));
  return patch as TeammatePatch;
}

/** Stage and people ids must be ones the business has, or the save would name someone who isn't there. */
function checkRefs(args: Args, catalogs: TeammateCatalogs): void {
  const stageId = str(args['qualifiedLeadStageId']);
  const stages = catalogs.pipelines?.flatMap((p) => p.stages.filter((s) => !s.archived));
  if (stageId && stages && !stages.some((s) => s.id === stageId))
    throw HfosError.notFound(
      'No open stage with that id. The stages are in get_settings with area pipelines.',
    );
  const people = [
    ...(list<string>(args['qualifiedTellUserIds']) ?? []),
    ...(list<string>(args['handOffTellUserIds']) ?? []),
  ];
  const strangers = people.filter(
    (id) => !catalogs.members.some((m) => m.userId === id && m.active),
  );
  if (strangers.length)
    throw HfosError.notFound('That person isn’t on the team. The team’s ids come from list_team.');
}

function nextRules(config: TeammateConfig, args: Args, catalogs: TeammateCatalogs) {
  checkRefs(args, catalogs);
  const patch = rulesPatch(config, args);
  try {
    return applyTeammatePatch(config, patch);
  } catch (e) {
    throw invalid(e, 'That doesn’t fit the AI teammate’s settings');
  }
}

const KIND_WORDS: Record<QuestionKind, string> = {
  text: 'text',
  choice: 'choice',
  yes_no: 'yes or no',
  number: 'number',
  file: 'a file they send',
};

function questionWords(q: QualifyingQuestion): string {
  const parts = [`“${q.question}”`, KIND_WORDS[q.kind]];
  if (q.kind === 'choice') parts.push(q.options.join(' / '));
  if (!q.required) parts.push('optional');
  const r = q.notAFitIf;
  if (r.answers.length) parts.push(`not a fit: ${r.answers.join(', ')}`);
  if (r.below !== null) parts.push(`not a fit below ${r.below}`);
  if (r.above !== null) parts.push(`not a fit above ${r.above}`);
  return parts.join(' · ');
}

/** Each rule that changes, before → after, in the words the teammate's history uses. */
function ruleFields(a: TeammateConfig, b: TeammateConfig, catalogs: TeammateCatalogs): Field[] {
  const fields: Field[] = [];
  const TEXT_LINES = [
    'Signature changed',
    'Tone note changed',
    'Hand-off message changed',
    'Phone greeting changed',
  ];
  for (const line of diffTeammateConfigs(a, b, catalogs)) {
    // Questions and the wording get lines of their own below, with what they now say.
    if (/^(Added|Changed|Removed) the question /.test(line) || TEXT_LINES.includes(line)) continue;
    const colon = line.indexOf(': ');
    const arrow = line.indexOf(' → ');
    fields.push(
      colon > 0 && arrow > colon
        ? { label: line.slice(0, colon), value: line.slice(colon + 2) }
        : { label: 'Change', value: line },
    );
  }
  const before = new Map(a.qualify.questions.map((q) => [q.id, q]));
  for (const q of b.qualify.questions) {
    const old = before.get(q.id);
    if (!old) fields.push({ label: 'New question', value: questionWords(q) });
    else if (JSON.stringify(old) !== JSON.stringify(q))
      fields.push({ label: 'Changed question', value: questionWords(q) });
  }
  for (const q of a.qualify.questions)
    if (!b.qualify.questions.some((x) => x.id === q.id))
      fields.push({ label: 'Removed question', value: `“${q.question}”` });
  if (a.identity.signature !== b.identity.signature)
    fields.push({ label: 'Email signature', value: b.identity.signature || 'The usual one' });
  if (a.identity.toneNote !== b.identity.toneNote)
    fields.push({ label: 'Tone', value: b.identity.toneNote || 'Only your tone of voice' });
  if (a.handOff.tellCustomer !== b.handOff.tellCustomer)
    fields.push({ label: 'Tells the customer', value: b.handOff.tellCustomer });
  if (a.phone.greeting !== b.phone.greeting)
    fields.push({ label: 'Phone greeting', value: b.phone.greeting || 'The usual greeting' });
  return capFields(fields);
}

const asksForMoney = (c: TeammateConfig) =>
  [
    c.money.discounts !== 'never',
    c.money.bills,
    c.money.newBills,
    c.money.quotes !== 'off',
    c.money.plans,
  ] as const;

function ruleWarnings(
  a: TeammateConfig,
  b: TeammateConfig,
  catalogs: TeammateCatalogs,
  name: string,
): Warning[] {
  const out: Warning[] = [];
  const key = (i: { code: string; message: string }) => `${i.code}:${i.message}`;
  const had = new Set(
    validateTeammate(a, catalogs)
      .filter((i) => i.severity === 'error')
      .map(key),
  );
  const fresh = validateTeammate(b, catalogs).filter(
    (i) => i.severity === 'error' && !had.has(key(i)),
  );
  if (fresh.length)
    out.push({
      kind: 'caution',
      text: `${fresh.map((i) => i.message).join('. ')}. It saves, but ${name} can’t be turned on until that’s fixed.`,
    });
  if (!a.phone.enabled && b.phone.enabled)
    out.push({
      kind: 'caution',
      text: catalogs.textingReady
        ? `${name} will pick up your business number and talk with callers live.`
        : `Your business number isn’t set up yet, so ${name} has no calls to answer until it is.`,
    });
  const was = asksForMoney(a);
  if (asksForMoney(b).some((on, i) => on && !was[i]))
    out.push({
      kind: 'note',
      text: 'Anything that asks a customer for money waits for an owner’s or admin’s OK, even after training wheels.',
    });
  if (a.handOff.tellCustomer !== b.handOff.tellCustomer)
    out.push({ kind: 'note', text: 'Customers get these words when they’re handed to a person.' });
  return out.slice(0, 3);
}

const updateAiTeammateRules: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { teammate, catalogs } = await requireTeammate(db, ctx);
    const next = nextRules(teammate.config, args, catalogs);
    const fields = ruleFields(teammate.config, next, catalogs);
    if (!fields.length) throw nothingChanges(`${teammate.name}’s rules are already set that way.`);
    return {
      card: settingsCard(toolCallId, 'update_ai_teammate_rules', {
        title: `Change ${teammate.name}’s rules`,
        fields,
        confirmLabel: 'Save the change',
        warnings: ruleWarnings(teammate.config, next, catalogs, teammate.name),
      }),
      result: { waiting: true, changes: fields.map((f) => `${f.label}: ${f.value}`) },
    };
  },

  async commit(db, ctx, args) {
    // Read again and saved on that revision: someone saving in between is a conflict, not a silent overwrite.
    const { teammate, catalogs } = await requireTeammate(db, ctx);
    await command(db, ctx, 'ai_teammate.save_config', {
      teammateId: teammate.id,
      baseRevision: teammate.revision,
      config: nextRules(teammate.config, args, catalogs),
    });
    return {
      outcome: 'Saved',
      href: `/app/w/${ctx.workspaceId}/ai-team`,
      command: 'ai_teammate.save_config',
    };
  },
};

// ---------- Settings → Automations ----------

interface AutomationState {
  readonly ctx: AutomationContext;
  readonly teammate: TeammateGet['teammate'];
  readonly canManageTeammate: boolean;
  /** For Intake questions: the forms it could send (null when they couldn't be read). */
  readonly forms: { formId: string; name: string; status: string }[] | null;
}

/** Everything the page reads to draw its rows, read the way the page reads it. */
async function automationState(db: Db, ctx: ToolContext): Promise<AutomationState> {
  const [{ workspace }, team, services, plans, forms] = await Promise.all([
    query<{ workspace: { settings: Record<string, unknown> } }>(db, ctx, 'workspace.get'),
    teammateOf(db, ctx).catch(() => null),
    query<{ items: { repeatMonths: number | null }[] }>(db, ctx, 'service.list').catch(() => null),
    query<{ plans: { serviceId: string | null; archivedAt: string | null }[] }>(
      db,
      ctx,
      'plan.list',
    ).catch(() => null),
    query<{ items: { formId: string; name: string; status: string }[] }>(
      db,
      ctx,
      'form.list',
    ).catch(() => null),
  ]);
  const teammate = team?.teammate ?? null;
  return {
    ctx: {
      attention: attentionSettingsOf(workspace.settings),
      automations: automationSettingsOf(workspace.settings),
      teammate: teammate
        ? { status: teammate.status, config: teammate.config as unknown as Record<string, unknown> }
        : null,
      // Not knowing reads as ready, as on the page.
      ...(services && plans
        ? {
            maintenanceReady:
              services.items.some((s) => s.repeatMonths !== null) ||
              plans.plans.some((p) => p.serviceId !== null && !p.archivedAt),
          }
        : {}),
    },
    teammate,
    canManageTeammate: team?.canManage ?? false,
    forms: forms?.items ?? null,
  };
}

async function listAutomations(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const state = await automationState(db, ctx);
  const group = str(args['group']);
  const rows = automationRows(state.ctx);
  const counts = automationCounts(rows);
  const a = state.ctx.automations;
  return {
    result: {
      working: `${counts.working} of ${counts.total} are working${
        counts.needsSetup ? `; ${counts.needsSetup} need something set up first` : ''
      }`,
      automations: rows
        .filter((r) => !group || r.def.group === group)
        .map((r) => ({
          id: r.def.id,
          name: r.def.label,
          group: AUTOMATION_GROUP_TITLES[r.def.group],
          does: r.def.oneLiner,
          on: r.on,
          ...(r.locked ? { alwaysOn: true } : {}),
          ...(r.on && r.needsSetup ? { notWorkingYet: r.needsSetup.text } : {}),
          ...(r.awaitingReview
            ? { turnsOnOnlyOnTheScreen: 'Its message is read first, in Adjust' }
            : {}),
          ...(r.on && r.drafts ? { waitsForApprovalWhileTraining: true } : {}),
          ...(r.fallback ? { withoutAiTeammate: r.fallback } : {}),
        })),
      reengage: {
        afterDays: a.reengage.afterDays,
        mostPerDay: a.reengage.maxPerDay,
        notAgainForDays: a.reengage.cooldownDays,
        message: a.reengage.template,
        messageRead: a.reengage.reviewedAt !== null,
      },
      intakeForm: a.intake.formId
        ? (state.forms?.find((f) => f.formId === a.intake.formId)?.name ?? 'A form')
        : null,
      endOfDayEmailAt: a.briefings.eveningAt,
      whenVoicemailAnswers: a.calls.voicemail,
      callsToLeads: {
        from: a.calls.hours.start,
        until: a.calls.hours.end,
        atWeekends: a.calls.hours.weekends,
        tries: a.calls.tries,
      },
      asksForOkToCall: a.calls.askConsent,
    },
  };
}

function withPatch(ctx: AutomationContext, patch: AutomationPatch): AutomationContext {
  switch (patch.store) {
    case 'attention':
      return { ...ctx, attention: patch.settings };
    case 'automations':
      return { ...ctx, automations: patch.settings };
    case 'teammate':
      return ctx.teammate ? { ...ctx, teammate: { ...ctx.teammate, config: patch.config } } : ctx;
  }
}

interface AutomationPlan {
  readonly automations: AutomationSettings;
  readonly attention: AttentionSettings;
  readonly teammateConfig: Record<string, unknown> | null;
  readonly stores: ReadonlySet<AutomationPatch['store']>;
  readonly fields: Field[];
  /** Asked to turn on an automation whose message is read first, other than re-engaging dead leads. */
  readonly reviewFirst: boolean;
  /**
   * Turning on re-engaging dead leads the first time: the card shows its message, and Confirm is the screen's "Looks
   * good, turn on" (the owner, 2026-10-26: the Assistant does whatever the person can).
   */
  readonly readFirst: boolean;
  readonly blocked: string[];
  /** Labels of what will text or call customers on its own once this saves. */
  readonly reaching: string[];
  readonly notes: string[];
}

const VOICEMAIL_WORDS: Record<string, string> = {
  text: 'Hang up and send a text instead',
  message: 'Leave a short message',
  hang_up: 'Just hang up',
};

/** Every switch through `automationPatch`, one after another, so each store is saved once with all of its changes. */
function planAutomations(state: AutomationState, args: Args): AutomationPlan {
  const turnOn = [...new Set(list<AutomationId>(args['turnOn']) ?? [])];
  const turnOff = [...new Set(list<AutomationId>(args['turnOff']) ?? [])];
  const both = turnOn.filter((id) => turnOff.includes(id));
  if (both.length)
    throw HfosError.validation(
      both.map((id) => ({ path: 'turnOn', message: `${automationDef(id).label}: on or off?` })),
      `${joinAnd(both.map((id) => automationDef(id).label))} ${both.length === 1 ? 'is' : 'are'} in both turnOn and turnOff. Turn each automation on or off, not both.`,
    );
  let at = state.ctx;
  const stores = new Set<AutomationPatch['store']>();
  const fields: Field[] = [];
  const blocked: string[] = [];
  const reaching: string[] = [];
  const notes: string[] = [];
  let reviewFirst = false;
  let readFirst = false;

  // The intake form first, so turning Intake questions on in the same breath doesn't say it still needs one.
  const formId = args['intakeFormId'];
  let intakeField: Field | null = null;
  if (formId !== undefined && formId !== at.automations.intake.formId) {
    const form = formId === null ? null : state.forms?.find((f) => f.formId === formId);
    if (formId !== null && !form)
      throw HfosError.notFound('No form with that id. The forms come from list_forms.');
    if (form && form.status !== 'live')
      throw HfosError.validation(
        [{ path: 'intakeFormId', message: 'Publish the form first.' }],
        `${form.name} isn’t live yet. Publish it first, then pick it.`,
      );
    at = {
      ...at,
      automations: {
        ...at.automations,
        intake: { ...at.automations.intake, formId: formId as string | null },
      },
    };
    stores.add('automations');
    intakeField = { label: 'Intake form', value: form?.name ?? 'None' };
  }
  for (const [ids, on] of [
    [turnOn, true],
    [turnOff, false],
  ] as const) {
    for (const id of ids) {
      const def = automationDef(id);
      const row = automationRow(def, at);
      if (row.locked) {
        if (!on) blocked.push(`${def.label} is always on.`);
        continue;
      }
      if (row.on === on) continue;
      if (on && row.awaitingReview && id === 'reengage_dead_leads') {
        at = {
          ...at,
          automations: {
            ...at.automations,
            switches: { ...at.automations.switches, reengage: true },
            reengage: { ...at.automations.reengage, reviewedAt: new Date().toISOString() },
          },
        };
        stores.add('automations');
        fields.push({ label: def.label, value: 'On' });
        reaching.push(def.label);
        readFirst = true;
        continue;
      }
      if (on && row.awaitingReview) {
        reviewFirst = true;
        fields.push({ label: def.label, value: 'On' });
        continue;
      }
      if (def.binding.store === 'teammate' && !state.teammate) {
        blocked.push(
          `${def.label} is the AI teammate’s, and there isn’t one yet. Set one up under AI teammate first.`,
        );
        continue;
      }
      if (def.binding.store === 'teammate' && !state.canManageTeammate) {
        blocked.push(
          `${def.label} is the AI teammate’s: only people who can run the AI teammate can switch it. Ask an owner or admin.`,
        );
        continue;
      }
      const patch = automationPatch(id, on, at);
      if (!patch) {
        blocked.push(`${def.label} can’t be switched here. Switch it in Settings → Automations.`);
        continue;
      }
      at = withPatch(at, patch);
      stores.add(patch.store);
      fields.push({ label: def.label, value: on ? 'On' : 'Off' });
      if (!on) continue;
      if (def.effect === 'texts' || def.effect === 'calls') reaching.push(def.label);
      const after = automationRow(def, at);
      if (after.needsSetup) notes.push(`${def.label}: ${after.needsSetup.text}`);
    }
  }

  if (intakeField) {
    fields.push(intakeField);
    const intake = automationRow(automationDef('intake_questions'), at);
    if (
      intake.working &&
      !state.ctx.automations.intake.formId &&
      !reaching.includes(intake.def.label)
    )
      reaching.push(intake.def.label);
  }

  // The timings and wording only Settings → Automations keeps.
  const now = at.automations;
  const reengage = {
    afterDays: num(args['reengageAfterDays']) ?? now.reengage.afterDays,
    maxPerDay: num(args['reengageMostPerDay']) ?? now.reengage.maxPerDay,
    cooldownDays: num(args['reengageNotAgainForDays']) ?? now.reengage.cooldownDays,
    template: straight(str(args['reengageMessage'])) ?? now.reengage.template,
  };
  const eveningAt = str(args['endOfDayEmailAt']) ?? now.briefings.eveningAt;
  const voicemail = (str(args['whenVoicemailAnswers']) ??
    now.calls.voicemail) as AutomationSettings['calls']['voicemail'];
  const askConsent =
    typeof args['askForOkToCall'] === 'boolean' ? args['askForOkToCall'] : now.calls.askConsent;
  const hours = {
    start: str(args['callLeadsFrom']) ?? now.calls.hours.start,
    end: str(args['callLeadsUntil']) ?? now.calls.hours.end,
    weekends:
      typeof args['callLeadsAtWeekends'] === 'boolean'
        ? args['callLeadsAtWeekends']
        : now.calls.hours.weekends,
  };
  const tries = num(args['callTries']) ?? now.calls.tries;
  const next: AutomationSettings = {
    ...now,
    reengage: { ...now.reengage, ...reengage },
    briefings: { ...now.briefings, eveningAt },
    calls: { ...now.calls, voicemail, askConsent, hours, tries },
  };
  if (reengage.afterDays !== now.reengage.afterDays)
    fields.push({ label: 'Re-engage: gone cold after', value: plural(reengage.afterDays, 'day') });
  if (reengage.maxPerDay !== now.reengage.maxPerDay)
    fields.push({ label: 'Re-engage: at most a day', value: plural(reengage.maxPerDay, 'text') });
  if (reengage.cooldownDays !== now.reengage.cooldownDays)
    fields.push({
      label: 'Re-engage: not again for',
      value: plural(reengage.cooldownDays, 'day'),
    });
  // Turned on the first time, the message is on the card to read before Confirm.
  if (readFirst && reengage.template === now.reengage.template)
    fields.push({ label: 'Re-engage message', value: reengage.template });
  if (reengage.template !== now.reengage.template) {
    fields.push({ label: 'Re-engage message', value: reengage.template });
    if (reengageOn(next)) reaching.push('The re-engage message');
  }
  if (eveningAt !== now.briefings.eveningAt)
    fields.push({ label: 'End-of-day email at', value: eveningAt });
  if (voicemail !== now.calls.voicemail)
    fields.push({ label: 'When a voicemail box answers', value: VOICEMAIL_WORDS[voicemail]! });
  if (hours.start !== now.calls.hours.start || hours.end !== now.calls.hours.end)
    fields.push({
      label: 'Calling hours for leads',
      value: `${formatClock(hours.start)} to ${formatClock(hours.end)}, in each lead’s own time`,
    });
  if (hours.weekends !== now.calls.hours.weekends)
    fields.push({ label: 'Calls to leads at weekends', value: hours.weekends ? 'Yes' : 'No' });
  if (tries !== now.calls.tries)
    fields.push({
      label: 'When a lead doesn’t answer',
      value: tries === 1 ? 'Call once' : `Try up to ${tries} times, a day apart`,
    });
  if (askConsent !== now.calls.askConsent)
    fields.push({ label: 'Ask for an OK to call', value: askConsent ? 'On' : 'Off' });
  if (JSON.stringify(next) !== JSON.stringify(now)) {
    try {
      parseAutomationSettings(next);
    } catch (e) {
      throw invalid(e, 'That doesn’t fit Settings → Automations');
    }
    stores.add('automations');
    at = { ...at, automations: next };
  }
  return {
    automations: at.automations,
    attention: at.attention,
    teammateConfig: at.teammate?.config ? { ...at.teammate.config } : null,
    stores,
    fields,
    reviewFirst,
    readFirst,
    blocked,
    reaching,
    notes,
  };
}

function automationWarnings(plan: AutomationPlan, training: boolean): Warning[] {
  const out: Warning[] = [];
  if (plan.readFirst)
    out.push({
      kind: 'caution',
      text: 'Re-engage dead leads texts open leads who haven’t heard from you in months, on its own. Read its message above: saving is your “Looks good, turn on”.',
    });
  if (plan.reviewFirst)
    out.push({
      kind: 'blocked',
      text: 'Re-engage dead leads texts people who haven’t heard from you in months, so it turns on only on Settings → Automations: Adjust on it, read the message, then Looks good, turn on.',
    });
  if (plan.blocked.length) out.push({ kind: 'blocked', text: plan.blocked.join(' ') });
  if (plan.reaching.length)
    out.push({
      kind: 'caution',
      text: `${joinAnd(plan.reaching)} ${plan.reaching.length === 1 ? 'reaches' : 'reach'} customers on ${
        plan.reaching.length === 1 ? 'its' : 'their'
      } own.${training ? ' What your AI teammate writes waits for approval while it’s training.' : ''}`,
    });
  if (plan.notes.length)
    out.push({ kind: 'note', text: `Not working until set up: ${plan.notes.join(' ')}` });
  return out.slice(0, 3);
}

const REENGAGE_ON_SCREEN =
  'Re-engaging dead leads turns on only from Settings → Automations, where its message is read first.';

const updateAutomations: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const state = await automationState(db, ctx);
    const plan = planAutomations(state, args);
    const stopped = plan.reviewFirst || plan.blocked.length > 0;
    if (!plan.fields.length && !stopped)
      throw nothingChanges('Those automations are already set that way.');
    return {
      card: settingsCard(toolCallId, 'update_automations', {
        title: 'Change your automations',
        fields: capFields(plan.fields),
        confirmLabel: stopped ? '' : 'Save the change',
        warnings: automationWarnings(plan, state.teammate?.status === 'training'),
      }),
      result: stopped
        ? {
            blocked: true,
            why: [...(plan.reviewFirst ? [REENGAGE_ON_SCREEN] : []), ...plan.blocked].join(' '),
          }
        : { waiting: true, changes: plan.fields.map((f) => `${f.label}: ${f.value}`) },
    };
  },

  async commit(db, ctx, args) {
    const state = await automationState(db, ctx);
    const plan = planAutomations(state, args);
    if (plan.reviewFirst || plan.blocked.length)
      throw HfosError.conflict(
        `${[...(plan.reviewFirst ? [REENGAGE_ON_SCREEN] : []), ...plan.blocked].join(' ')} Nothing was changed.`,
        'automation_blocked',
      );
    const ran: string[] = [];
    if (plan.stores.has('automations')) {
      await command(db, ctx, 'automations.save_settings', { settings: plan.automations });
      ran.push('automations.save_settings');
    }
    if (plan.stores.has('attention')) {
      await command(db, ctx, 'attention.save_settings', { settings: plan.attention });
      ran.push('attention.save_settings');
    }
    if (plan.stores.has('teammate') && state.teammate && plan.teammateConfig) {
      await command(db, ctx, 'ai_teammate.save_config', {
        teammateId: state.teammate.id,
        baseRevision: state.teammate.revision,
        config: plan.teammateConfig,
      });
      ran.push('ai_teammate.save_config');
    }
    if (!ran.length) throw nothingChanges('Those automations are already set that way.');
    return {
      outcome: 'Saved',
      href: `/app/w/${ctx.workspaceId}/settings/automations`,
      command: ran[0]!,
    };
  },
};

// ---------- the person's own alerts and side menu ----------

/** Each phone alert in the words Settings → Account, Notifications uses. */
const PUSH_LABELS: Record<PushSwitch, string> = {
  customerWaiting: 'A customer waiting on a reply',
  missedCall: 'A call nobody took',
  urgent: 'Urgent items',
  approval: 'Approvals',
  booking: 'Your appointments',
  assigned: 'Assigned to you',
  payment: 'A customer pays',
  wallet: 'Your balance runs out',
  jobs: 'A job you were on is over',
  connections: 'A connection stops working',
  addons: 'An add-on needs you',
  supportTickets: 'New support tickets',
  qualifying: 'Your AI teammate’s qualifying',
  documents: 'Documents you sent',
};

function nextPush(now: PushSwitches, args: Args): PushSwitches {
  const on = list<PushSwitch>(args['turnOn']) ?? [];
  const off = list<PushSwitch>(args['turnOff']) ?? [];
  const both = on.filter((k) => off.includes(k));
  if (both.length)
    throw HfosError.validation(
      both.map((k) => ({ path: 'turnOn', message: `${PUSH_LABELS[k]}: on or off?` })),
      `${joinAnd(both.map((k) => PUSH_LABELS[k]))} ${both.length === 1 ? 'is' : 'are'} in both turnOn and turnOff. Turn each alert on or off, not both.`,
    );
  const next = { ...now };
  for (const k of on) next[k] = true;
  for (const k of off) next[k] = false;
  return next;
}

const notificationsOf = (settings: Record<string, unknown>) =>
  (settings['notifications'] as Record<string, boolean> | undefined) ?? {};

const updateMyAlerts: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const me = await meOf(db, ctx);
    const now = pushSwitchesOf(me.user.settings);
    const next = nextPush(now, args);
    const fields: Field[] = PUSH_SWITCHES.filter((k) => next[k] !== now[k]).map((k) => ({
      label: `Phone alert: ${PUSH_LABELS[k]}`,
      value: next[k] ? 'On' : 'Off',
    }));
    const pushChanged = fields.length > 0;
    const digest = bool(args['agencyDigestEmail']);
    const digestWas = notificationsOf(me.user.settings)['agencyDigest'] !== false;
    if (digest !== undefined && digest !== digestWas)
      fields.push({ label: 'Email: Daily agency digest', value: digest ? 'Yes' : 'No' });
    if (!fields.length) throw nothingChanges('Your alerts are already set that way.');
    const warnings: Warning[] = [];
    if (pushChanged && Object.values(next).some(Boolean)) {
      const phones = await query<{ devices: unknown[] }>(db, ctx, 'push_device.list').catch(
        () => null,
      );
      if (phones && !phones.devices.length)
        warnings.push({
          kind: 'note',
          text: 'You aren’t signed in on the HandsFreeOS phone app yet, so phone alerts start once you are.',
        });
    }
    if (digest && !me.organizations.length)
      warnings.push({
        kind: 'note',
        text: 'That email only goes to an agency’s owners and admins.',
      });
    return {
      card: settingsCard(toolCallId, 'update_my_alerts', {
        title: 'Change your alerts',
        fields,
        confirmLabel: 'Save the change',
        warnings,
      }),
      result: { waiting: true, changes: fields.map((f) => `${f.label}: ${f.value}`) },
    };
  },

  async commit(db, ctx, args) {
    const me = await meOf(db, ctx);
    const now = pushSwitchesOf(me.user.settings);
    const next = nextPush(now, args);
    const digest = bool(args['agencyDigestEmail']);
    // Settings save a whole top-level key at a time: all eleven push switches, and every email switch.
    const settings = {
      ...(PUSH_SWITCHES.some((k) => next[k] !== now[k]) ? { push: next } : {}),
      ...(digest === undefined
        ? {}
        : { notifications: { ...notificationsOf(me.user.settings), agencyDigest: digest } }),
    };
    if (!Object.keys(settings).length)
      throw nothingChanges('Your alerts are already set that way.');
    await command(db, ctx, 'user.update_profile', { settings });
    return {
      outcome: 'Saved',
      href: `/app/w/${ctx.workspaceId}/settings#notifications`,
      command: 'user.update_profile',
    };
  },
};

/** Each place in the side menu's own words (the web's nav-links). */
const MENU_LABELS: Record<MenuKey, string> = {
  home: 'Home',
  inbox: 'Inbox',
  customers: 'Contacts',
  pipeline: 'Pipeline',
  calendar: 'Calendar',
  money: 'Money',
  workflows: 'Workflows',
  campaigns: 'Campaigns',
  forms: 'Forms',
  documents: 'Documents',
  reviews: 'Reviews',
  knowledge: 'Knowledge',
  'ai-team': 'AI teammate',
  tasks: 'Tasks',
  members: 'Members',
  audit: 'Audit log',
  settings: 'Settings',
};
const placesWords = (keys: readonly MenuKey[]) => joinAnd(keys.map((k) => MENU_LABELS[k]));
const alwaysShown = (keys: readonly MenuKey[]) =>
  `${placesWords(keys)} always ${keys.length === 1 ? 'stays' : 'stay'} in the menu.`;

function nextMenu(menu: Menu, args: Args): { next: Menu; refused: MenuKey[]; places: MenuKey[] } {
  const act = action(args);
  if (act === 'use_suggested') return { next: SUGGESTED_MENU, refused: [], places: [] };
  if (act === 'start_over') return { next: DEFAULT_MENU, refused: [], places: [] };
  const places = [...new Set(list<MenuKey>(args['places']) ?? [])];
  if (!places.length)
    throw HfosError.validation(
      [{ path: 'places', message: 'Say which places.' }],
      `Say which places to ${act}: give them in places.`,
    );
  let next = menu;
  const refused: MenuKey[] = [];
  for (const key of places) {
    if (act === 'hide') {
      if (MENU_ALWAYS_SHOWN.includes(key)) refused.push(key);
      else if (!next.hidden.includes(key)) next = moveKey(next, key, 'hidden');
    } else if (next.hidden.includes(key)) next = moveKey(next, key, 'menu');
  }
  return { next, refused, places };
}

const arrangeMyMenu: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const me = await meOf(db, ctx);
    const menu = menuOf(me.user.settings);
    const { next, refused, places } = nextMenu(menu, args);
    const act = action(args);
    if (!refused.length && sameMenu(menu, next))
      throw nothingChanges('Your side menu already looks like that.');
    const moved = places.filter((k) => !refused.includes(k));
    const more = SUGGESTED_MENU.entries.find((e) => e.kind === 'group');
    const fields: Field[] =
      act === 'hide'
        ? [{ label: 'Hide', value: placesWords(moved) }]
        : act === 'show'
          ? [{ label: 'Show again', value: placesWords(moved) }]
          : act === 'use_suggested'
            ? [
                {
                  label: 'In the menu',
                  value: placesWords(
                    SUGGESTED_MENU.entries.flatMap((e) => (e.kind === 'link' ? [e.key] : [])),
                  ),
                },
                ...(more?.kind === 'group'
                  ? [{ label: `In ${more.label}`, value: placesWords(more.keys) }]
                  : []),
              ]
            : [{ label: 'Your menu', value: 'Every place, one under the other' }];
    if (act === 'hide' || act === 'show')
      fields.push({ label: 'Your menu', value: menuSummary(next) });
    const warnings: Warning[] = refused.length
      ? [{ kind: 'blocked', text: alwaysShown(refused) }]
      : act === 'hide'
        ? [{ kind: 'note', text: MENU_WORDS.hiddenHint }]
        : (act === 'use_suggested' || act === 'start_over') &&
            (menu.hidden.length || menu.entries.some((e) => e.kind === 'group'))
          ? [{ kind: 'note', text: 'Your own groups go, and hidden places come back.' }]
          : [];
    return {
      card: settingsCard(toolCallId, 'arrange_my_menu', {
        title:
          act === 'hide'
            ? 'Hide from your side menu'
            : act === 'show'
              ? 'Show in your side menu'
              : act === 'use_suggested'
                ? 'Use the suggested groups'
                : 'Start your side menu over',
        fields,
        confirmLabel: refused.length ? '' : 'Save menu',
        warnings,
      }),
      result: refused.length
        ? { blocked: true, why: `${placesWords(refused)} can’t be hidden.` }
        : { waiting: true, menu: menuSummary(next) },
    };
  },

  async commit(db, ctx, args) {
    // Made on the menu as saved now. `settings.menu` is replaced whole, the same save the menu editor makes, so it
    // says which menu it was made on: one saved in between (the editor, another device) is read again and the
    // change made on that instead, once.
    for (let tries = 1; ; tries += 1) {
      const me = await meOf(db, ctx);
      const menu = menuOf(me.user.settings);
      const { next, refused } = nextMenu(menu, args);
      if (refused.length) throw HfosError.validation([], alwaysShown(refused));
      if (sameMenu(menu, next)) throw nothingChanges('Your side menu already looks like that.');
      try {
        await command(db, ctx, 'user.update_profile', {
          settings: { menu: storedMenu(next) },
          expectedSettings: { menu: me.user.settings['menu'] ?? null },
        });
        break;
      } catch (e) {
        if (tries > 1 || !(e instanceof HfosError && e.rule === 'settings_changed')) throw e;
      }
    }
    return {
      outcome: 'Menu saved',
      href: `/app/w/${ctx.workspaceId}/settings`,
      command: 'user.update_profile',
    };
  },
};

// ---------- Ideas ----------

interface IdeaSummary {
  id: string;
  number: number;
  title: string;
  excerpt: string;
  areaId: string;
  status: IdeaStatus;
  voteCount: number;
  author: { name: string; you: boolean };
  voted: boolean;
}
interface IdeaGet {
  idea: IdeaSummary & {
    body: string;
    following: boolean;
    votingOpen: boolean;
    mergedInto: { id: string; number: number; title: string } | null;
  };
  comments: {
    body: string;
    author: { name: string; you: boolean; team: boolean };
    hidden: boolean;
    createdAt: string;
  }[];
  updates: Parameters<typeof ideaUpdateLine>[0][];
}
interface IdeaAreas {
  areas: { id: string; name: string; archived: boolean }[];
}

const ideaHref = (ctx: ToolContext, id: string) => `/app/w/${ctx.workspaceId}/ideas/${id}`;
const ideaOf = (db: Db, ctx: ToolContext, ideaId: unknown) =>
  query<IdeaGet>(db, ctx, 'idea.get', { ideaId });

async function findIdeas(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const ideaId = str(args['ideaId']);
  if (ideaId) {
    const { idea, comments, updates } = await ideaOf(db, ctx, ideaId);
    return {
      result: {
        idea: {
          id: idea.id,
          number: idea.number,
          status: IDEA_STATUS_WORDS[idea.status],
          votes: idea.voteCount,
          youVoted: idea.voted,
          youFollow: idea.following,
          votingOpen: idea.votingOpen,
          sharedByYou: idea.author.you,
          ...(idea.mergedInto
            ? { mergedInto: { id: idea.mergedInto.id, number: idea.mergedInto.number } }
            : {}),
          words: theirs(`${idea.title}\n\n${idea.body}`.trim()),
        },
        comments: comments
          .filter((c) => !c.hidden)
          .slice(-10)
          .map((c) => ({
            by: c.author.team ? 'HandsFreeOS team' : c.author.you ? 'You' : 'Someone',
            on: c.createdAt.slice(0, 10),
            words: theirs(c.body),
          })),
        story: updates.map(ideaUpdateLine),
      },
    };
  }
  const [{ ideas }, areas] = await Promise.all([
    query<{ ideas: IdeaSummary[] }>(db, ctx, 'idea.list', {
      ...(str(args['search']) ? { search: str(args['search']) } : {}),
      ...(str(args['sort']) ? { sort: str(args['sort']) } : {}),
      ...(str(args['status']) ? { status: str(args['status']) } : {}),
      ...(str(args['mine']) ? { mine: str(args['mine']) } : {}),
      limit: num(args['limit']) ?? 10,
    }),
    query<IdeaAreas>(db, ctx, 'idea.areas').catch(() => null),
  ]);
  return {
    result: {
      count: ideas.length,
      ideas: ideas.map((i) => ({
        id: i.id,
        number: i.number,
        status: IDEA_STATUS_WORDS[i.status],
        votes: i.voteCount,
        youVoted: i.voted,
        sharedByYou: i.author.you,
        area: i.areaId,
        words: theirs(i.excerpt ? `${i.title} — ${i.excerpt}` : i.title),
      })),
      ...(areas
        ? { areas: areas.areas.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name })) }
        : {}),
    },
    card: ideas.length
      ? {
          type: 'list',
          title: plural(ideas.length, 'idea'),
          items: ideas.slice(0, 12).map((i) => ({
            title: `#${i.number} ${i.title}`,
            detail: `${IDEA_STATUS_WORDS[i.status]} · ${IDEAS_WORDS.votes(i.voteCount)}${i.voted ? ' · you voted' : ''}`,
            tone: i.voted ? ('accent' as const) : ('muted' as const),
            href: ideaHref(ctx, i.id),
          })),
        }
      : null,
  };
}

const IDEA_NOTE = 'Other businesses on HandsFreeOS can see it, and the team reads every one.';

const manageIdea: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    if (act === 'share') {
      const title = str(args['title']);
      if (!title)
        throw HfosError.validation(
          [{ path: 'title', message: IDEAS_WORDS.needsTitle }],
          'The idea needs a title. Give a few words in title.',
        );
      const areaId = str(args['areaId']) ?? 'other';
      const [areas, similar] = await Promise.all([
        query<IdeaAreas>(db, ctx, 'idea.areas').catch(() => null),
        query<{ ideas: { id: string; number: number; title: string; voteCount: number }[] }>(
          db,
          ctx,
          'idea.similar',
          { text: title },
        ).catch(() => null),
      ]);
      const area = areas?.areas.find((a) => a.id === areaId && !a.archived);
      if (areas && !area)
        throw HfosError.validation(
          [{ path: 'areaId', message: IDEAS_WORDS.needsArea }],
          `“${areaId}” isn’t one of the areas an idea can be about. Use one of the areas find_ideas gives.`,
        );
      const alike = (similar?.ideas ?? []).slice(0, 2);
      const details = str(args['details']);
      return {
        card: settingsCard(toolCallId, 'manage_idea', {
          title: 'Share this idea with HandsFreeOS?',
          fields: [
            { label: 'Your idea', value: title },
            ...(details ? [{ label: 'Tell us more', value: clip(details, 400) }] : []),
            { label: 'About', value: area?.name ?? 'Something else' },
          ],
          confirmLabel: IDEAS_WORDS.shareButton,
          warnings: [
            { kind: 'note', text: `${IDEA_NOTE} You’ll hear by email when it moves.` },
            ...(alike.length
              ? [
                  {
                    kind: 'note',
                    text: `${IDEAS_WORDS.similar} ${alike
                      .map(
                        (i) =>
                          `#${i.number} “${clip(i.title, 60)}” (${IDEAS_WORDS.votes(i.voteCount)})`,
                      )
                      .join(', ')}`,
                  },
                ]
              : []),
          ],
        }),
        result: {
          waiting: true,
          ...(alike.length
            ? {
                alreadyOnTheBoard: alike.map((i) => ({
                  id: i.id,
                  number: i.number,
                  votes: i.voteCount,
                  words: theirs(i.title),
                })),
              }
            : {}),
        },
      };
    }

    if (!str(args['ideaId']))
      throw HfosError.validation(
        [{ path: 'ideaId', message: 'Which idea?' }],
        'Which idea? Its id comes from find_ideas.',
      );
    const { idea } = await ideaOf(db, ctx, args['ideaId']);
    const name = `#${idea.number} “${clip(idea.title, 80)}”`;
    const merged = () =>
      idea.mergedInto
        ? HfosError.conflict(
            `This idea was merged into #${idea.mergedInto.number}. Use that one instead.`,
            'idea_merged',
          )
        : null;
    const card = (title: string, confirmLabel: string, fields: Field[], note?: string) => ({
      card: settingsCard(toolCallId, 'manage_idea', {
        title,
        fields: [{ label: 'Idea', value: name }, ...fields],
        confirmLabel,
        warnings: note ? [{ kind: 'note', text: note }] : [],
      }),
      result: { waiting: true, action: act, idea: idea.number },
    });
    const votes = { label: 'Votes now', value: IDEAS_WORDS.votes(idea.voteCount) };
    switch (act) {
      case 'vote': {
        const stop = merged();
        if (stop) throw stop;
        if (!idea.votingOpen)
          throw HfosError.conflict(
            `Voting has closed on ${name}, so it can’t take a vote now.`,
            'idea_voting_closed',
          );
        if (idea.voted) throw nothingChanges(`You’ve already voted for ${name}.`);
        return card(`Vote for ${name}?`, 'Vote for it', [votes], IDEAS_WORDS.followOn);
      }
      case 'unvote':
        if (!idea.voted) throw nothingChanges(`You haven’t voted for ${name}.`);
        return card(`Take back your vote for ${name}?`, 'Take it back', [votes]);
      case 'comment': {
        const stop = merged();
        if (stop) throw stop;
        const body = str(args['comment']);
        if (!body)
          throw HfosError.validation(
            [{ path: 'comment', message: 'Write something first.' }],
            'The comment is empty. Put its words in comment.',
          );
        return card(
          `Comment on ${name}?`,
          IDEAS_WORDS.commentButton,
          [{ label: 'Your comment', value: clip(body, 500) }],
          'Everyone who can see the idea can read it.',
        );
      }
      case 'follow':
      case 'unfollow': {
        const follow = act === 'follow';
        if (idea.following === follow)
          throw nothingChanges(
            follow ? `You already follow ${name}.` : `You don’t follow ${name}.`,
          );
        return follow
          ? card(`Email you updates about ${name}?`, 'Follow it', [], IDEAS_WORDS.followDetail)
          : card(`Stop the emails about ${name}?`, 'Stop them', []);
      }
      default:
        throw HfosError.validation(
          [{ path: 'action', message: 'Unknown action.' }],
          `manage_idea can’t ${act || 'do that'}. Use share, vote, unvote, comment, follow or unfollow as action.`,
        );
    }
  },

  async commit(db, ctx, args) {
    const act = action(args);
    if (act === 'share') {
      const out = await command<{ ideaId: string; number: number }>(db, ctx, 'idea.share', {
        title: str(args['title']),
        body: str(args['details']) ?? '',
        areaId: str(args['areaId']) ?? 'other',
      });
      return {
        outcome: IDEAS_WORDS.shared(out.number),
        href: ideaHref(ctx, out.ideaId),
        command: 'idea.share',
      };
    }
    const ideaId = str(args['ideaId'])!;
    const href = ideaHref(ctx, ideaId);
    switch (act) {
      case 'vote':
        await command(db, ctx, 'idea.vote', { ideaId });
        return { outcome: 'Voted. You’ll hear when it moves.', href, command: 'idea.vote' };
      case 'unvote':
        await command(db, ctx, 'idea.unvote', { ideaId });
        return { outcome: 'Your vote is taken back.', href, command: 'idea.unvote' };
      case 'comment':
        await command(db, ctx, 'idea.comment', { ideaId, body: str(args['comment']) });
        return { outcome: 'Comment added.', href, command: 'idea.comment' };
      default: {
        const following = act === 'follow';
        await command(db, ctx, 'idea.follow', { ideaId, following });
        return {
          outcome: following ? IDEAS_WORDS.followOn : IDEAS_WORDS.followOff,
          href,
          command: 'idea.follow',
        };
      }
    }
  },
};

// ---------- Get help ----------

/** What must never go to support in a message: a card number, a password, a key. */
const SECRETS = [
  /\b(?:\d[ -]?){13,19}\b/,
  /\b(password|passcode|passwd|pwd)\b\s*(is\b|:|=)/i,
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{6,}/,
];
const hasSecret = (args: Args) =>
  SECRETS.some((r) => r.test(`${str(args['subject']) ?? ''}\n${str(args['details']) ?? ''}`));

const contactSupport: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { workspace } = await query<{ workspace: { name: string } }>(db, ctx, 'workspace.get');
    const secret = hasSecret(args);
    return {
      card: settingsCard(toolCallId, 'contact_support', {
        title: 'Send this to HandsFreeOS support?',
        fields: [
          { label: GET_HELP_WORDS.subject, value: str(args['subject']) ?? '' },
          { label: GET_HELP_WORDS.body, value: clip(str(args['details']) ?? '', 600) },
          { label: 'About', value: workspace.name },
        ],
        confirmLabel: secret ? '' : GET_HELP_WORDS.send,
        warnings: [
          secret
            ? {
                kind: 'blocked',
                text: 'It looks like there’s a password, card number or key in it. Take that out first: support never needs one.',
              }
            : {
                kind: 'note',
                text: 'A person at HandsFreeOS reads it, Monday to Friday, and answers by email.',
              },
        ],
      }),
      result: secret
        ? { blocked: true, why: 'Take out the password, card number or key, then ask again.' }
        : { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    if (hasSecret(args))
      throw HfosError.validation(
        [],
        'A support message can’t carry a password, card number or key. Take out the one in this message, then ask again.',
      );
    const out = await command<{ ticketId: string; number: number }>(
      db,
      ctx,
      'support.request.create',
      {
        subject: str(args['subject']) ?? '',
        body: str(args['details']),
        // Where they asked from, never anything typed.
        context: { page: 'Ask HandsFreeOS' },
      },
    );
    return {
      outcome: GET_HELP_WORDS.sent(out.number),
      href: null,
      command: 'support.request.create',
    };
  },
};

// ---------- adding a business, and the agency area ----------

/** The organization this business belongs to, and whether the person runs it (owner or admin). */
async function agencyOf(db: Db, ctx: ToolContext) {
  const me = await meOf(db, ctx);
  const org = me.organizations.find((o) => o.id === ctx.organizationId) ?? null;
  const businesses = me.workspaces.filter((w) => w.organizationId === ctx.organizationId);
  return {
    org,
    name: org?.name ?? businesses[0]?.organizationName ?? 'this organization',
    businesses,
  };
}

const notAgencyAdmin = (name: string) =>
  `Only the owners and admins of ${name} can do this. Ask one of them.`;

const addBusiness: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { org, name: orgName, businesses } = await agencyOf(db, ctx);
    const name = str(args['name'])!;
    const timezone = str(args['timezone']) ?? ctx.timezone;
    if (!isValidTimeZone(timezone))
      throw HfosError.validation(
        [{ path: 'timezone', message: 'Unknown time zone.' }],
        `“${timezone}” isn’t a time zone. Use one like America/Chicago.`,
      );
    const mine = args['whoRunsIt'] === 'me';
    const twin = businesses.find((w) => w.name.toLowerCase() === name.toLowerCase());
    const warnings: Warning[] = !org
      ? [{ kind: 'blocked', text: notAgencyAdmin(orgName) }]
      : [
          {
            kind: 'note',
            text: mine
              ? 'You’ll be on its team, can be booked for its jobs, and get its emails.'
              : 'You won’t be on its team. You can still change everything, and its emails come to you until its own people are invited.',
          },
          ...(twin
            ? [{ kind: 'caution', text: `${orgName} already has a business called ${twin.name}.` }]
            : []),
        ];
    return {
      card: settingsCard(toolCallId, 'add_business', {
        title: `Add ${name}?`,
        fields: [
          { label: 'Business', value: name },
          { label: 'Under', value: orgName },
          { label: 'Time zone', value: timezone },
          {
            label: 'Who runs it',
            value: mine ? 'You — you go on its team' : 'A client — you set it up for them',
          },
        ],
        confirmLabel: org ? 'Add business' : '',
        warnings,
      }),
      result: org ? { waiting: true } : { blocked: true, why: notAgencyAdmin(orgName) },
    };
  },

  async commit(db, ctx, args) {
    const name = str(args['name'])!;
    const out = await command<{ workspaceId: string }>(db, ctx, 'workspace.create', {
      organizationId: ctx.organizationId,
      name,
      timezone: str(args['timezone']) ?? ctx.timezone,
      joinAsOwner: args['whoRunsIt'] === 'me',
    });
    return {
      outcome: `${name} is added. It starts empty, ready to set up.`,
      href: `/app/w/${out.workspaceId}`,
      command: 'workspace.create',
    };
  },
};

interface TemplateSummary {
  id: string;
  name: string;
  latestVersion: number | null;
  archivedAt: string | null;
  installs: { total: number; installed: number; pending: number; failed: number; behind: number };
}
interface TemplateGet {
  template: TemplateSummary & { placeholders: { key: string; label: string }[] };
  installs: {
    workspaceId: string;
    workspaceName: string;
    workflowId: string | null;
    status: string;
    behind: boolean;
    mapping: Record<string, unknown>;
  }[];
}
interface PackSummary {
  id: string;
  name: string;
  items: unknown[];
  version: number;
  archivedAt: string | null;
}

const isForbidden = (e: unknown) => e instanceof HfosError && e.status === 403;
const templateOf = (db: Db, ctx: ToolContext, templateId: unknown) =>
  query<TemplateGet>(db, ctx, 'workflow_template.get', {
    organizationId: ctx.organizationId,
    templateId,
  });

async function getAgencyArea(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const { org, name, businesses } = await agencyOf(db, ctx);
  if (!org) return { result: { notYours: notAgencyAdmin(name) } };
  const organizationId = ctx.organizationId;
  try {
    const templateId = str(args['templateId']);
    if (templateId) {
      const got = await templateOf(db, ctx, templateId);
      const keys = got.template.placeholders;
      return {
        result: {
          template: {
            id: got.template.id,
            name: got.template.name,
            version: got.template.latestVersion,
            detailsEachBusinessPicks: keys.map((p) => p.label),
          },
          businesses: got.installs.map((i) => ({
            id: i.workspaceId,
            name: i.workspaceName,
            status: i.status,
            ...(i.behind ? { behind: true } : {}),
            stillToPick: keys.filter((p) => !i.mapping[p.key]).map((p) => p.label),
          })),
        },
      };
    }
    const [templates, packs] = await Promise.all([
      query<{ items: TemplateSummary[] }>(db, ctx, 'workflow_template.list', { organizationId }),
      query<{ items: PackSummary[] }>(db, ctx, 'knowledge_pack.list', { organizationId }),
    ]);
    return {
      result: {
        agency: name,
        businesses: businesses.map((w) => ({ id: w.id, name: w.name })),
        templates: templates.items.map((t) => ({
          id: t.id,
          name: t.name,
          published: t.latestVersion !== null,
          ...(t.latestVersion !== null ? { version: t.latestVersion } : {}),
          inBusinesses: t.installs.total,
        })),
        packs: packs.items.map((p) => ({
          id: p.id,
          name: p.name,
          items: p.items.length,
          version: p.version,
        })),
      },
    };
  } catch (e) {
    if (isForbidden(e)) return { result: { notYours: notAgencyAdmin(name) } };
    throw e;
  }
}

const pushToClientBusinesses: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { org, name: orgName, businesses } = await agencyOf(db, ctx);
    if (!org)
      return {
        card: settingsCard(toolCallId, 'push_to_client_businesses', {
          title: 'Push to client businesses',
          fields: [],
          confirmLabel: '',
          warnings: [{ kind: 'blocked', text: notAgencyAdmin(orgName) }],
        }),
        result: { blocked: true, why: notAgencyAdmin(orgName) },
      };
    const ids = [...new Set(list<string>(args['businessIds']) ?? [])];
    const strangers = ids.filter((id) => !businesses.some((w) => w.id === id));
    if (strangers.length)
      throw HfosError.validation(
        strangers.map((id) => ({ path: 'businessIds', message: `${id} isn’t in ${orgName}.` })),
        `That business isn’t in ${orgName}. The ids come from get_agency_area.`,
      );
    const names = ids.map((id) => businesses.find((w) => w.id === id)!.name);
    const to = { label: 'Businesses', value: clip(joinAnd(names), 300) };
    const title = (what: string) =>
      `Push “${what}” to ${plural(ids.length, 'business', 'businesses')}?`;

    if (args['what'] === 'template') {
      if (!str(args['templateId']))
        throw HfosError.validation(
          [{ path: 'templateId', message: 'Which template?' }],
          'Which template? Its id comes from get_agency_area.',
        );
      const got = await templateOf(db, ctx, args['templateId']);
      const t = got.template;
      if (t.archivedAt)
        throw HfosError.conflict(
          `“${t.name}” is archived, so it can’t be pushed anymore. Pick another template from get_agency_area.`,
          'template_archived',
        );
      if (t.latestVersion === null)
        throw HfosError.conflict(
          `“${t.name}” hasn’t been published yet, so there’s nothing to push. Publish it in Agency area → Templates first.`,
          'template_not_published',
        );
      const installOf = (id: string) => got.installs.find((i) => i.workspaceId === id);
      const has = ids.filter((id) => installOf(id)?.workflowId);
      const toPick = t.placeholders.filter((p) => ids.some((id) => !installOf(id)?.mapping[p.key]));
      return {
        card: settingsCard(toolCallId, 'push_to_client_businesses', {
          title: title(t.name),
          fields: [
            { label: 'Template', value: `${t.name} · version ${t.latestVersion}` },
            to,
            ...(has.length
              ? [
                  {
                    label: 'Already have it',
                    value: `${joinAnd(has.map((id) => installOf(id)!.workspaceName))}: they see Update available`,
                  },
                ]
              : []),
          ],
          confirmLabel: 'Push',
          warnings: [
            {
              kind: 'note',
              text: 'Each business gets a draft. Nothing runs until it tests and publishes it.',
            },
            ...(toPick.length
              ? [
                  {
                    kind: 'note',
                    text: `Each business picks its own ${joinAnd(toPick.map((p) => p.label.toLowerCase()))}; its draft can’t publish until it has.`,
                  },
                ]
              : []),
          ],
        }),
        result: { waiting: true, businesses: names },
      };
    }

    if (!str(args['packId']))
      throw HfosError.validation(
        [{ path: 'packId', message: 'Which pack?' }],
        'Which pack? Its id comes from get_agency_area.',
      );
    const { items } = await query<{ items: PackSummary[] }>(db, ctx, 'knowledge_pack.list', {
      organizationId: ctx.organizationId,
      includeArchived: true,
    });
    const pack = items.find((p) => p.id === args['packId']);
    if (!pack)
      throw HfosError.notFound('No knowledge pack has that id. Its id comes from get_agency_area.');
    if (pack.archivedAt)
      throw HfosError.conflict(
        `“${pack.name}” is archived, so it can’t be pushed. Restore it in Agency area → Knowledge packs first.`,
        'pack_archived',
      );
    if (!pack.items.length)
      throw HfosError.conflict(
        `“${pack.name}” has nothing in it yet, so there’s nothing to push. Add items to it in Agency area → Knowledge packs first.`,
        'pack_empty',
      );
    return {
      card: settingsCard(toolCallId, 'push_to_client_businesses', {
        title: title(pack.name),
        fields: [
          { label: 'Pack', value: `${pack.name} · ${plural(pack.items.length, 'item')}` },
          to,
        ],
        confirmLabel: 'Push',
        warnings: [
          {
            kind: 'note',
            text: 'Each business gets the items as suggestions to accept, edit or reject. Nothing reaches its AI until someone accepts.',
          },
        ],
      }),
      result: { waiting: true, businesses: names },
    };
  },

  async commit(db, ctx, args) {
    const organizationId = ctx.organizationId;
    const workspaceIds = [...new Set(list<string>(args['businessIds']) ?? [])];
    const n = plural(workspaceIds.length, 'business', 'businesses');
    if (args['what'] === 'template') {
      // No mappings: a business that already picked its details keeps them, and the rest pick their own.
      await command(db, ctx, 'workflow_template.push', {
        organizationId,
        templateId: args['templateId'],
        workspaceIds,
      });
      return {
        outcome: `Pushed to ${n}. Each gets a draft to test and publish.`,
        href: `/app/org/${organizationId}/templates/${String(args['templateId'])}`,
        command: 'workflow_template.push',
      };
    }
    await command(db, ctx, 'knowledge_pack.push', {
      organizationId,
      packId: args['packId'],
      workspaceIds,
    });
    return {
      outcome: `Pushed to ${n} as suggestions.`,
      href: `/app/org/${organizationId}/packs`,
      command: 'knowledge_pack.push',
    };
  },
};

export const extraAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {
  list_automations: listAutomations,
  find_ideas: findIdeas,
  get_agency_area: getAgencyArea,
};

export const extraConfirmTools: Record<string, SettingsConfirmTool> = {
  update_ai_teammate_rules: updateAiTeammateRules,
  update_automations: updateAutomations,
  update_my_alerts: updateMyAlerts,
  arrange_my_menu: arrangeMyMenu,
  manage_idea: manageIdea,
  contact_support: contactSupport,
  add_business: addBusiness,
  push_to_client_businesses: pushToClientBusinesses,
};

/** What the panel says while each one runs. */
export const extraStepLabels: Record<string, string> = {
  update_ai_teammate_rules: 'Changing your AI teammate’s rules',
  list_automations: 'Looking at your automations',
  update_automations: 'Changing your automations',
  update_my_alerts: 'Changing your alerts',
  arrange_my_menu: 'Arranging your menu',
  find_ideas: 'Looking at ideas',
  manage_idea: 'Getting the idea ready',
  contact_support: 'Writing to support',
  add_business: 'Adding the business',
  get_agency_area: 'Looking at the agency area',
  push_to_client_businesses: 'Getting the push ready',
};
