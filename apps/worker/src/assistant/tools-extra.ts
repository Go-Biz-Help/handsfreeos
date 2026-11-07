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
 * - Adding a business, changing a template's steps and pushing to client businesses, which only the organization's
 *   owners and admins may do. The commands check that on the organization; the cards say so first rather than
 *   failing on Confirm. A template's steps change op by op against its draft, as a workflow's do (tools-content.ts).
 */
import { randomUUID } from 'node:crypto';
import {
  ADDON_CATALOG,
  addonOfMenuKey,
  applyTeammatePatch,
  assistantCoverage,
  attentionSettingsOf,
  AUTOMATION_GROUP_TITLES,
  automationCounts,
  automationDef,
  automationPatch,
  automationRow,
  automationRows,
  automationSettingsOf,
  coverageCards,
  coverageGapsForClaude,
  DEFAULT_INTAKE_MESSAGE,
  DEFAULT_MENU,
  diffTeammateConfigs,
  effectiveMapping,
  entryKeys,
  followUpLadderWords,
  formatClock,
  GET_HELP_WORDS,
  guessStageRole,
  HfosError,
  IDEA_STATUS_MEANING,
  IDEA_STATUS_WORDS,
  ideaUpdateLine,
  IDEAS_WORDS,
  isAlwaysShown,
  isMenuKey,
  isValidTimeZone,
  lineCheckPriceWords,
  managesAnAgency,
  MENU_GROUPS_MAX,
  MENU_WORDS,
  menuOf,
  menuPlaceOpen,
  menuSummary,
  migrationStatusWords,
  moveKey,
  normalizeMenu,
  parseAutomationSettings,
  parseDefinition,
  placeholderChoices,
  pushSwitchesOf,
  PUSH_SWITCHES,
  reengageOn,
  renameGroup,
  sameMenu,
  storedMenu,
  STAGE_ROLE_LABELS,
  SUGGESTED_MENU,
  templateIssues,
  ungroup,
  validateTeammate,
  withAddonPlaces,
  withoutKey,
  type AttentionSettings,
  type AutomationContext,
  type AutomationId,
  type AutomationPatch,
  type AutomationSettings,
  type FollowUpStep,
  type IdeaStatus,
  type LineCheckCents,
  type Menu,
  type MenuEntry,
  type MenuGroup,
  type MenuKey,
  type MenuPlaceKey,
  type NotifyWho,
  type PushSwitch,
  type PushSwitches,
  type QualifyingQuestion,
  type QualifyingQuestionInput,
  type QuestionKind,
  type StageRole,
  type TeammateCatalogs,
  type TeammateConfig,
  type TeammatePatch,
  type WorkflowCatalogs,
  type WorkflowOp,
  type WorkflowPlaceholder,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { keptAnswer } from './committed';
import { personQuery } from './context';
import type { ToolContext, ToolOutcome } from './runtime';
import { toolCallScreen } from './store';
import { draftChanges, draftSaved, draftToRead } from './tools-content';
import { command, query, rehearse } from './tools-read';
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
  const order = list<string>(args['questionOrder']);
  if (!add?.length && !change?.length && !remove?.length && !order?.length) return undefined;
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
  if (order?.length) out = inOrder(out, order);
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

/**
 * The questions it keeps, in the order given, as the Qualify section's arrows set it (tm-11). Each keeps its id, so
 * answers already given stay with their question. The order must name every question it keeps, each once.
 */
function inOrder(
  kept: QualifyingQuestionInput[],
  order: readonly string[],
): QualifyingQuestionInput[] {
  const ids = kept.map((q) => q.id);
  const unknown = order.filter((id) => !ids.includes(id));
  if (unknown.length)
    throw HfosError.notFound(
      `No question with the id ${unknown.join(', ')} is kept. The ids are in get_settings with area ai_teammate.`,
    );
  const missing = ids.filter((id) => !order.includes(id));
  if (missing.length || new Set(order).size !== order.length)
    throw HfosError.validation(
      [{ path: 'questionOrder', message: 'Name every question it keeps, each once.' }],
      'To change the order, name every question it keeps, each once, in the order it should ask them. Questions added in the same change go after them.',
    );
  return order.map((id) => kept.find((q) => q.id === id)!);
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

  // Identity and channels
  put('identity', 'signature', cleared('emailSignature'));
  put('identity', 'toneNote', cleared('tone'));
  put('channels', 'emailAddressId', str(args['emailsFromAddressId']));
  put('channels', 'widgetId', str(args['chatWidgetId']));
  // Respond: its first message to a new lead
  nest('respond', 'newLeads', {
    channel: str(args['firstMessageBy']),
    delayMinutes: num(args['firstMessageAfterMinutes']),
  });
  // Book, photos and its own hours
  put('book', 'reschedule', bool(args['reschedules']));
  put('book', 'cancel', bool(args['cancels']));
  put('book', 'waitlist', bool(args['usesWaitlist']));
  put('book', 'repeats', bool(args['booksRepeatVisits']));
  put('book', 'serviceArea', bool(args['checksServiceArea']));
  put('photos', 'enabled', bool(args['looksAtPhotos']));
  put('photos', 'priceRanges', bool(args['priceRangesFromPhotos']));
  const ownHours = list<{ day: number; start: string; end: string }>(args['ownHours']);
  if (ownHours) {
    put('hours', 'mode', 'custom');
    put('hours', 'custom', ownHours);
  }
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
  // Add-ons, by id once checkRefs has found them
  const addons = {
    ...Object.fromEntries((list<string>(args['useAddons']) ?? []).map((id) => [id, { on: true }])),
    ...Object.fromEntries(
      (list<string>(args['stopUsingAddons']) ?? []).map((id) => [id, { on: false }]),
    ),
  };
  if (Object.keys(addons).length) (patch as Record<string, unknown>)['addons'] = addons;
  return patch as TeammatePatch;
}

/** The add-ons running here that give the AI teammate something to use, as its Add-ons section lists them. */
async function teammateAddonsHere(
  db: Db,
  ctx: ToolContext,
): Promise<{ id: string; name: string }[]> {
  const { installed } = await query<{ installed?: { addonId: string; running: boolean }[] }>(
    db,
    ctx,
    'addon.list',
  );
  const running = new Set((installed ?? []).filter((i) => i.running).map((i) => i.addonId));
  return ADDON_CATALOG.filter((m) => !!m.teammate && running.has(m.id)).map((m) => ({
    id: m.id,
    name: m.name,
  }));
}

/**
 * Add-ons named in useAddons and stopUsingAddons, as their ids. Turning one on needs it running here and giving
 * the teammate something; turning one off always works, so a stopped add-on can still be switched off.
 */
async function addonArgs(db: Db, ctx: ToolContext, args: Args, name: string): Promise<Args> {
  const use = list<string>(args['useAddons']) ?? [];
  const stop = list<string>(args['stopUsingAddons']) ?? [];
  if (!use.length && !stop.length) return args;
  const lower = (s: string) => s.trim().toLowerCase();
  const find = (asked: string) =>
    ADDON_CATALOG.find((m) => lower(m.id) === lower(asked) || lower(m.name) === lower(asked));
  const here = use.length ? await teammateAddonsHere(db, ctx) : [];
  const ids = (asked: string[], on: boolean) =>
    asked.map((a) => {
      const m = find(a);
      if (!m)
        throw HfosError.notFound(
          `No add-on is called “${a}”. The add-ons are in get_settings with area add_ons.`,
        );
      if (on && !m.teammate)
        throw HfosError.rule(
          'addon_not_for_teammate',
          400,
          `${m.name} has nothing for ${name} to use in a conversation.`,
        );
      if (on && !here.some((h) => h.id === m.id))
        throw HfosError.rule(
          'addon_not_on',
          409,
          `${m.name} isn’t on in this business, so ${name} can’t use it yet. Turn it on in Add-ons first.`,
        );
      return m.id;
    });
  return { ...args, useAddons: ids(use, true), stopUsingAddons: ids(stop, false) };
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
  const address = str(args['emailsFromAddressId']);
  if (address && !catalogs.emailAddresses.some((a) => a.id === address))
    throw HfosError.notFound(
      'No email address with that id. The addresses it can send from are catalogs.emailAddresses in get_settings with area ai_teammate; add one in Settings → Email.',
    );
  const widget = str(args['chatWidgetId']);
  if (widget && !catalogs.chatWidgets.some((w) => w.id === widget))
    throw HfosError.notFound(
      'No website chat with that id. The chats are catalogs.chatWidgets in get_settings with area ai_teammate.',
    );
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
    // Questions, their order and the wording get lines of their own below, with what they now say.
    if (
      /^(Added|Changed|Removed) the question /.test(line) ||
      line === 'Question order changed' ||
      TEXT_LINES.includes(line)
    )
      continue;
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
  // The order it asks them in, as the arrows leave it, when the ones it kept move (tm-11).
  const kept = (c: TeammateConfig) =>
    c.qualify.questions
      .map((q) => q.id)
      .filter((id) => before.has(id) && b.qualify.questions.some((q) => q.id === id));
  if (JSON.stringify(kept(a)) !== JSON.stringify(kept(b)))
    fields.push({
      label: 'Order',
      value: b.qualify.questions.map((q, i) => `${i + 1}. ${q.question}`).join(' '),
    });
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
  async prepare(db, ctx, asked, toolCallId) {
    const { teammate, catalogs } = await requireTeammate(db, ctx);
    const args = await addonArgs(db, ctx, asked, teammate.name);
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

  async commit(db, ctx, asked) {
    // Read again and saved on that revision: someone saving in between is a conflict, not a silent overwrite.
    const { teammate, catalogs } = await requireTeammate(db, ctx);
    const args = await addonArgs(db, ctx, asked, teammate.name);
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
  /**
   * Whether the person asking is an owner of the business: only an owner reads an automatic message's wording and
   * turns it on (Looks good, turn on), as the screen shows that button to owners alone.
   */
  readonly owner: boolean;
  /** For Intake questions: the forms it could send (null when they couldn't be read). */
  readonly forms: { formId: string; name: string; status: string }[] | null;
  /** For Business landlines: what checking a number costs, as the page shows it (null when it can't see prices). */
  readonly lineCheckCents: LineCheckCents | null;
  /** For What each stage means: every open stage, by pipeline (null when they couldn't be read). */
  readonly stages: { id: string; name: string; pipeline: string }[] | null;
}

/** Everything the page reads to draw its rows, read the way the page reads it. */
async function automationState(db: Db, ctx: ToolContext): Promise<AutomationState> {
  const [{ workspace }, team, services, plans, forms, prices, pipelines] = await Promise.all([
    query<{ workspace: { settings: Record<string, unknown>; role: string | null } }>(
      db,
      ctx,
      'workspace.get',
    ),
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
    query<{ items: { key: string | null; cents: number }[] }>(db, ctx, 'usage.prices').catch(
      () => null,
    ),
    query<{
      pipelines: {
        name: string;
        archivedAt: string | null;
        stages: { id: string; name: string; kind: string }[];
      }[];
    }>(db, ctx, 'pipeline.list').catch(() => null),
  ]);
  const teammate = team?.teammate ?? null;
  const priced = (key: string) => prices?.items.find((p) => p.key === key)?.cents;
  const line = priced('lookup.line_type');
  const owner = priced('lookup.caller_name');
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
    owner: workspace.role === 'owner',
    forms: forms?.items ?? null,
    lineCheckCents: line !== undefined && owner !== undefined ? { line, owner } : null,
    // The open stages the page lists, as it lists them.
    stages: pipelines
      ? pipelines.pipelines
          .filter((p) => !p.archivedAt)
          .flatMap((p) =>
            p.stages
              .filter((st) => st.kind === 'open')
              .map((st) => ({ id: st.id, name: st.name, pipeline: p.name })),
          )
      : null,
  };
}

/** What moves a deal into a stage: the business's pick, else the guess from its name, as the page shows it. */
const stageMeaning = (roles: Record<string, string>, stage: { id: string; name: string }) =>
  (roles[stage.id] ?? guessStageRole(stage.name) ?? 'none') as StageRole | 'none';
const stageMeaningWords = (means: StageRole | 'none') =>
  means === 'none' ? 'Nothing: deals reach it only by hand' : STAGE_ROLE_LABELS[means];

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
            ? { messageReadFirst: 'Turning it on puts its message on the card to read first' }
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
      followUps: state.teammate
        ? {
            times: followUpLadderWords(state.teammate.config.followUp.ladder),
            ladder: state.teammate.config.followUp.ladder,
            thenMonthlyForMonths: state.teammate.config.followUp.monthlyForMonths,
          }
        : null,
      intakeForm: a.intake.formId
        ? (state.forms?.find((f) => f.formId === a.intake.formId)?.name ?? 'A form')
        : null,
      // What Intake questions sends with the form, as its Adjust sheet shows it; null puts the standard back.
      intakeMessage: a.intake.message,
      intakeMessageIsStandard: a.intake.message === DEFAULT_INTAKE_MESSAGE,
      endOfDayEmailAt: a.briefings.eveningAt,
      whenVoicemailAnswers: a.calls.voicemail,
      callsToLeads: {
        from: a.calls.hours.start,
        until: a.calls.hours.end,
        atWeekends: a.calls.hours.weekends,
        tries: a.calls.tries,
      },
      asksForOkToCall: a.calls.askConsent,
      callsBusinessLandlines: a.calls.businessLandlines,
      maintenanceDue: {
        message: a.maintenance.template,
        planMessage: a.maintenance.planTemplate,
        daysBefore: a.maintenance.leadDays,
        daysBetween: a.maintenance.secondAfterDays,
        mostPerDay: a.maintenance.maxPerDay,
      },
      stageMeanings: state.stages?.map((st) => ({
        stageId: st.id,
        stage: `${st.name} (${st.pipeline})`,
        means: stageMeaningWords(stageMeaning(a.pipeline.roles, st)),
      })),
      howYouTag: a.contactAi.guide || null,
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
  /** Fewer follow-ups than before, or new times while follow-ups are off: said, so nobody is surprised. */
  readonly followUpNote: string | null;
}

const monthsWords = (n: number) => (n === 0 ? 'none' : `${n} month${n === 1 ? '' : 's'}`);

const VOICEMAIL_WORDS: Record<string, string> = {
  text: 'Hang up and send a text instead',
  message: 'Leave a short message',
  hang_up: 'Just hang up',
};

/** The screen's own words to someone who isn't an owner: only an owner reads the wording and turns it on. */
const OWNER_READS_FIRST = (label: string) =>
  `${label} goes on only once an owner has read its message and chosen Looks good, turn on. Ask an owner of this business.`;

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
      if (on && row.awaitingReview && id === 'reengage_dead_leads' && !state.owner) {
        blocked.push(OWNER_READS_FIRST(def.label));
        continue;
      }
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

  // When each follow-up after silence goes: the AI teammate's, saved with its settings as the Adjust panel does.
  let followUpNote: string | null = null;
  const ladder = list<FollowUpStep>(args['followUpTimes']);
  const monthly = num(args['followUpMonthlyForMonths']);
  const followUps = automationDef('follow_ups_after_silence');
  if ((ladder || monthly !== undefined) && !at.teammate)
    blocked.push(
      `When ${followUps.label.toLowerCase()} go is the AI teammate’s, and there isn’t one yet. Set one up under AI teammate first.`,
    );
  else if ((ladder || monthly !== undefined) && !state.canManageTeammate)
    blocked.push(
      `When ${followUps.label.toLowerCase()} go is the AI teammate’s: only people who can run the AI teammate can change it. Ask an owner or admin.`,
    );
  else if (at.teammate && (ladder || monthly !== undefined)) {
    const was = at.teammate.config as unknown as TeammateConfig;
    let next: TeammateConfig;
    try {
      next = applyTeammatePatch(was, {
        followUp: {
          ...(ladder ? { ladder: ladder.map((x) => ({ after: x.after, unit: x.unit })) } : {}),
          ...(monthly === undefined ? {} : { monthlyForMonths: monthly }),
        },
      });
    } catch (e) {
      throw invalid(e, 'Those follow-up times don’t work');
    }
    const a = was.followUp;
    const b = next.followUp;
    if (JSON.stringify(a.ladder) !== JSON.stringify(b.ladder))
      fields.push({
        label: 'Follow-up times',
        value: `${followUpLadderWords(a.ladder)} → ${followUpLadderWords(b.ladder)}`,
      });
    if (a.monthlyForMonths !== b.monthlyForMonths)
      fields.push({
        label: 'Then monthly for',
        value: `${monthsWords(a.monthlyForMonths)} → ${monthsWords(b.monthlyForMonths)}`,
      });
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      at = withPatch(at, { store: 'teammate', config: next as unknown as Record<string, unknown> });
      stores.add('teammate');
      if (b.ladder.length < a.ladder.length)
        followUpNote = `That’s ${b.ladder.length} follow-up${b.ladder.length === 1 ? '' : 's'} instead of ${a.ladder.length}.`;
      if (!b.enabled)
        followUpNote = `${followUpNote ? `${followUpNote} ` : ''}${followUps.label} is off, so nothing goes until it’s on.`;
    }
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
  const businessLandlines =
    typeof args['callBusinessLandlines'] === 'boolean'
      ? args['callBusinessLandlines']
      : now.calls.businessLandlines;
  const maintenance = {
    template: straight(str(args['maintenanceMessage'])) ?? now.maintenance.template,
    planTemplate: straight(str(args['maintenancePlanMessage'])) ?? now.maintenance.planTemplate,
    leadDays: num(args['maintenanceDaysBefore']) ?? now.maintenance.leadDays,
    secondAfterDays: num(args['maintenanceDaysBetween']) ?? now.maintenance.secondAfterDays,
    maxPerDay: num(args['maintenanceMostPerDay']) ?? now.maintenance.maxPerDay,
  };
  // null puts the standard wording back, as Use the standard wording does.
  const intakeMessage =
    args['intakeMessage'] === null
      ? DEFAULT_INTAKE_MESSAGE
      : (straight(str(args['intakeMessage'])) ?? now.intake.message);
  const guide = str(args['howYouTag'])?.trim() ?? now.contactAi.guide;
  // A stage set back to the guess from its name drops the pick, as the page does.
  const roles = { ...now.pipeline.roles };
  const stageFields: Field[] = [];
  for (const pick of list<{ stageId: string; means: StageRole | 'none' }>(args['stageMeanings']) ??
    []) {
    const stage = state.stages?.find((st) => st.id === pick.stageId);
    if (!stage)
      throw HfosError.notFound(
        'No open stage with that id. The stages come from get_settings pipelines.',
      );
    if (stageMeaning(roles, stage) === pick.means) continue;
    if (pick.means === (guessStageRole(stage.name) ?? 'none')) delete roles[stage.id];
    else roles[stage.id] = pick.means;
    stageFields.push({
      label: `${stage.name} (${stage.pipeline})`,
      value: stageMeaningWords(pick.means),
    });
  }
  const next: AutomationSettings = {
    ...now,
    reengage: { ...now.reengage, ...reengage },
    briefings: { ...now.briefings, eveningAt },
    calls: { ...now.calls, voicemail, askConsent, hours, tries, businessLandlines },
    maintenance: { ...now.maintenance, ...maintenance },
    intake: { ...now.intake, message: intakeMessage },
    pipeline: { ...now.pipeline, roles },
    contactAi: { ...now.contactAi, guide },
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
  if (businessLandlines !== now.calls.businessLandlines)
    fields.push({
      label: 'Call business landlines without a yes',
      value:
        businessLandlines && state.lineCheckCents
          ? `On. Each check is charged to your balance: ${lineCheckPriceWords(state.lineCheckCents)}`
          : businessLandlines
            ? 'On. Each check is charged to your balance'
            : 'Off',
    });
  const newText = maintenance.template !== now.maintenance.template;
  const newPlanText = maintenance.planTemplate !== now.maintenance.planTemplate;
  if (newText) fields.push({ label: 'Maintenance due text', value: maintenance.template });
  if (newPlanText)
    fields.push({ label: 'For customers on a maintenance plan', value: maintenance.planTemplate });
  if ((newText || newPlanText) && automationRow(automationDef('maintenance_due'), at).on)
    reaching.push('The maintenance due text');
  if (maintenance.leadDays !== now.maintenance.leadDays)
    fields.push({
      label: 'Maintenance due: first text',
      value:
        maintenance.leadDays === 0
          ? 'On the day the visit is due'
          : `${plural(maintenance.leadDays, 'day')} before the visit is due`,
    });
  if (maintenance.secondAfterDays !== now.maintenance.secondAfterDays)
    fields.push({
      label: 'Maintenance due: second text, then a card',
      value: `${plural(maintenance.secondAfterDays, 'day')} after, each time`,
    });
  if (maintenance.maxPerDay !== now.maintenance.maxPerDay)
    fields.push({
      label: 'Maintenance due: at most a day',
      value: plural(maintenance.maxPerDay, 'first text'),
    });
  if (intakeMessage !== now.intake.message) {
    fields.push({
      label: 'Intake message',
      value:
        intakeMessage === DEFAULT_INTAKE_MESSAGE
          ? `${intakeMessage} (the standard wording)`
          : intakeMessage,
    });
    if (automationRow(automationDef('intake_questions'), at).working)
      reaching.push('The intake message');
  }
  fields.push(...stageFields);
  if (guide !== now.contactAi.guide)
    fields.push({ label: 'How you tag customers', value: guide || 'Nothing written' });
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
    followUpNote,
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
  if (plan.followUpNote) out.push({ kind: 'note', text: plan.followUpNote });
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

/**
 * Daily agency digest's switch as asked, refused for anyone whose Notifications don't have the row: only an agency's
 * owners and admins do (managesAnAgency), as both apps decide it.
 */
function digestAsked(me: Me, args: Args): boolean | undefined {
  const digest = bool(args['agencyDigestEmail']);
  if (
    digest !== undefined &&
    !managesAnAgency({ organizations: me.organizations, businesses: me.workspaces })
  )
    throw HfosError.rule(
      'not_an_agency',
      409,
      'The daily agency digest is only for the owners and admins of an agency with more than one business, so you have no such email to turn on or off. Nothing was changed.',
    );
  return digest;
}

/**
 * The person's own phone alerts, as Settings → Account under Notifications saves them: one tool for everyone's, and
 * HandsFreeOS's support people's New support tickets on a tool of its own, so nobody else is told it exists.
 */
const myAlerts = (name: string): SettingsConfirmTool => ({
  async prepare(db, ctx, args, toolCallId) {
    const me = await meOf(db, ctx);
    const now = pushSwitchesOf(me.user.settings);
    const next = nextPush(now, args);
    const fields: Field[] = PUSH_SWITCHES.filter((k) => next[k] !== now[k]).map((k) => ({
      label: `Phone alert: ${PUSH_LABELS[k]}`,
      value: next[k] ? 'On' : 'Off',
    }));
    const pushChanged = fields.length > 0;
    const digest = digestAsked(me, args);
    const digestWas = notificationsOf(me.user.settings)['agencyDigest'] !== false;
    if (digest !== undefined && digest !== digestWas)
      fields.push({ label: 'Email: Daily agency digest', value: digest ? 'On' : 'Off' });
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
    return {
      card: settingsCard(toolCallId, name, {
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
    const digest = digestAsked(me, args);
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
});

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
/** A place in the menu's words: core's own, or the add-on's name. */
const placeLabel = (key: MenuPlaceKey) =>
  isMenuKey(key) ? MENU_LABELS[key] : (addonOfMenuKey(ADDON_CATALOG, key)?.name ?? key);
const placesWords = (keys: readonly MenuPlaceKey[]) => joinAnd(keys.map(placeLabel));
const alwaysShown = (keys: readonly MenuPlaceKey[]) =>
  `${placesWords(keys)} always ${keys.length === 1 ? 'stays' : 'stay'} in the menu.`;

type Open = (key: MenuPlaceKey) => boolean;

/**
 * The person's menu as Edit menu starts from it in this business: what they saved, with the add-ons running here
 * they never arranged at the end; and which places are open to them here, the only ones the editor lists.
 */
export async function menuHere(
  db: Db,
  ctx: ToolContext,
): Promise<{ me: Me; menu: Menu; open: Open }> {
  const [me, { workspace }] = await Promise.all([
    meOf(db, ctx),
    query<{ workspace: { permissions: string[]; addons: string[] } }>(db, ctx, 'workspace.get'),
  ]);
  const addons = { running: workspace.addons, catalog: ADDON_CATALOG };
  return {
    me,
    menu: withAddonPlaces(menuOf(me.user.settings), workspace.permissions, addons),
    open: (key) => menuPlaceOpen(key, workspace.permissions, addons),
  };
}

/** The menu top to bottom as the person sees it, each group with what's in it: "Home, Inbox, More (Forms, Reviews)". */
export function menuLayout(menu: Menu, open: Open): string {
  const clean = normalizeMenu(menu);
  const rows = clean.entries.flatMap((e) => {
    if (e.kind === 'link') return open(e.key) ? [placeLabel(e.key)] : [];
    const keys = e.keys.filter(open);
    return keys.length ? [`${e.label} (${keys.map(placeLabel).join(', ')})`] : [];
  });
  const hidden = clean.hidden.filter(open);
  return `${rows.join(', ')}${hidden.length ? `; hidden: ${hidden.map(placeLabel).join(', ')}` : ''}`;
}

/** A group of the menu by its name, as the person calls it. */
const groupNamed = (menu: Menu, name: string): MenuGroup | undefined =>
  menu.entries.find(
    (e): e is MenuGroup => e.kind === 'group' && e.label.toLowerCase() === name.toLowerCase(),
  );

/** The groups the person can see, by name. */
const groupNames = (menu: Menu, open: Open) =>
  joinAnd(
    menu.entries.flatMap((e) => (e.kind === 'group' && e.keys.some(open) ? [`“${e.label}”`] : [])),
  );

/** The places, in order, as rows of the menu itself at `at`. */
function linksAt(menu: Menu, at: number, keys: readonly MenuPlaceKey[]): Menu {
  const entries = [...menu.entries];
  entries.splice(at, 0, ...keys.map((key): MenuEntry => ({ kind: 'link', key })));
  return { ...menu, entries };
}

/**
 * Move: the places, in the order given, just above `before` (inside its group when it's in one); without it, out
 * of the group the first one is in to just under it, or to the bottom of the menu.
 */
function movePlaces(
  menu: Menu,
  places: readonly MenuPlaceKey[],
  before: MenuPlaceKey | undefined,
): Menu {
  const base = places.reduce(withoutKey, menu);
  if (!before) {
    const from = menu.entries.find(
      (e): e is MenuGroup => e.kind === 'group' && e.keys.includes(places[0]!),
    );
    // withoutKey keeps a group it empties, so the one they came out of is still there to go under.
    const at = from ? base.entries.findIndex((e) => e.kind === 'group' && e.id === from.id) : -1;
    return linksAt(base, at < 0 ? base.entries.length : at + 1, places);
  }
  const at = base.entries.findIndex((e) => entryKeys(e).includes(before));
  if (at < 0)
    throw HfosError.validation(
      [{ path: 'before', message: 'Not in the menu.' }],
      `${placeLabel(before)} is hidden, so nothing can go above it. Show it first, or name a place in the menu.`,
    );
  const holder = base.entries[at]!;
  if (holder.kind === 'link') return linksAt(base, at, places);
  const keys = [...holder.keys];
  keys.splice(keys.indexOf(before), 0, ...places);
  return { ...base, entries: base.entries.map((e, i) => (i === at ? { ...holder, keys } : e)) };
}

const missing = (path: string, why: string) =>
  HfosError.validation([{ path, message: 'Missing.' }], why);

function nextMenu(
  menu: Menu,
  args: Args,
  open: Open,
): { next: Menu; refused: MenuPlaceKey[]; places: MenuPlaceKey[]; group?: MenuGroup } {
  const act = action(args);
  if (act === 'use_suggested') return { next: SUGGESTED_MENU, refused: [], places: [] };
  if (act === 'start_over') return { next: DEFAULT_MENU, refused: [], places: [] };
  if (act === 'rename_group' || act === 'ungroup') {
    const name = str(args['group']);
    if (!name) throw missing('group', 'Say which group: give its name in group.');
    const group = groupNamed(menu, name);
    if (!group)
      throw HfosError.notFound(
        menu.entries.some((e) => e.kind === 'group' && e.keys.some(open))
          ? `Your menu has no group called “${name}”. Its groups are ${groupNames(menu, open)}.`
          : 'Your menu has no groups yet. Put places into one with action group.',
      );
    if (act === 'ungroup')
      return { next: ungroup(menu, group.id), refused: [], places: [...group.keys], group };
    const label = str(args['name']);
    if (!label) throw missing('name', 'Say what to call the group: give it in name.');
    return { next: renameGroup(menu, group.id, label), refused: [], places: [], group };
  }
  const places = [...new Set(list<MenuPlaceKey>(args['places']) ?? [])];
  if (!places.length)
    throw HfosError.validation(
      [{ path: 'places', message: 'Say which places.' }],
      `Say which places to ${act}: give them in places.`,
    );
  // An add-on is a place only where it runs and they can open it, as the editor lists it.
  const closed = places.filter((k) => !isMenuKey(k) && !open(k));
  if (closed.length)
    throw HfosError.validation(
      [{ path: 'places', message: 'Not in the menu here.' }],
      `${placesWords(closed)} ${closed.length === 1 ? 'isn’t' : 'aren’t'} in your menu here: not running in this business, or nothing in ${closed.length === 1 ? 'it' : 'them'} is open to you. An owner turns add-ons on in Add-ons.`,
    );
  if (act === 'move') {
    const before = str(args['before']) as MenuPlaceKey | undefined;
    if (before && places.includes(before))
      throw HfosError.validation(
        [{ path: 'before', message: 'One of the places moved.' }],
        `${placeLabel(before)} is one of the places being moved. Name another place in before.`,
      );
    if (before && !isMenuKey(before) && !open(before))
      throw HfosError.validation(
        [{ path: 'before', message: 'Not in the menu here.' }],
        `${placeLabel(before)} isn’t in your menu here. Name a place that is.`,
      );
    return { next: movePlaces(menu, places, before), refused: [], places };
  }
  if (act === 'group') {
    const name = str(args['group']);
    if (!name) throw missing('group', 'Say which group: give its name in group.');
    let next = menu;
    let group = groupNamed(next, name);
    if (!group) {
      if (next.entries.filter((e) => e.kind === 'group').length >= MENU_GROUPS_MAX)
        throw HfosError.rule(
          'menu_groups_full',
          409,
          `${MENU_WORDS.groupsFull} Put them into one you have (${groupNames(next, open)}), or ungroup one first.`,
        );
      // A new group, named as they said, where the first place stood in the menu (else at the bottom, where the
      // editor's Move to → a new group puts one).
      const was = next.entries.findIndex((e) => e.kind === 'link' && e.key === places[0]);
      next = moveKey(next, places[0]!, 'new');
      const made = next.entries[next.entries.length - 1] as MenuGroup;
      if (was >= 0) {
        const entries = next.entries.slice(0, -1);
        entries.splice(was, 0, made);
        next = { ...next, entries };
      }
      next = renameGroup(next, made.id, name);
      group = groupNamed(next, name)!;
    }
    const id = group.id;
    for (const key of places) next = moveKey(next, key, { group: id });
    return { next, refused: [], places, group: groupNamed(next, name) };
  }
  let next = menu;
  const refused: MenuPlaceKey[] = [];
  for (const key of places) {
    if (act === 'hide') {
      if (isAlwaysShown(key)) refused.push(key);
      else if (!next.hidden.includes(key)) next = moveKey(next, key, 'hidden');
    } else if (next.hidden.includes(key)) next = moveKey(next, key, 'menu');
  }
  return { next, refused, places };
}

const MENU_TITLES: Record<string, string> = {
  hide: 'Hide from your side menu',
  show: 'Show in your side menu',
  move: 'Move in your side menu',
  group: 'Group places in your side menu',
  rename_group: 'Rename a group in your side menu',
  ungroup: 'Ungroup in your side menu',
  use_suggested: 'Use the suggested groups',
  start_over: 'Start your side menu over',
};

/** What the card says the change is, before the menu it makes. */
function menuFields(
  act: string,
  args: Args,
  moved: readonly MenuPlaceKey[],
  group: MenuGroup | undefined,
  isNew: boolean,
  open: Open,
): Field[] {
  const before = str(args['before']) as MenuPlaceKey | undefined;
  const more = SUGGESTED_MENU.entries.find((e) => e.kind === 'group');
  switch (act) {
    case 'hide':
      return [{ label: 'Hide', value: placesWords(moved) }];
    case 'show':
      return [{ label: 'Show again', value: placesWords(moved) }];
    case 'move':
      return [
        { label: 'Move', value: placesWords(moved) },
        before
          ? { label: 'Just above', value: placeLabel(before) }
          : { label: 'To', value: 'Just under their group, or the bottom of the menu' },
      ];
    case 'group':
      return [
        { label: isNew ? 'New group' : 'Into', value: group?.label ?? '' },
        { label: 'Places', value: placesWords(moved) },
      ];
    case 'rename_group':
      return [
        { label: 'Group', value: group?.label ?? '' },
        { label: 'New name', value: str(args['name']) ?? '' },
      ];
    case 'ungroup':
      return [
        { label: 'Ungroup', value: group?.label ?? '' },
        { label: 'Back in the menu', value: placesWords(moved.filter(open)) },
      ];
    case 'use_suggested':
      return [
        {
          label: 'In the menu',
          value: placesWords(
            SUGGESTED_MENU.entries.flatMap((e) => (e.kind === 'link' ? [e.key] : [])),
          ),
        },
        ...(more?.kind === 'group'
          ? [{ label: `In ${more.label}`, value: placesWords(more.keys) }]
          : []),
      ];
    default:
      return [{ label: 'Your menu', value: 'Every place, one under the other' }];
  }
}

const arrangeMyMenu: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { menu, open } = await menuHere(db, ctx);
    const { next, refused, places, group } = nextMenu(menu, args, open);
    const act = action(args);
    if (!refused.length && sameMenu(menu, next))
      throw nothingChanges('Your side menu already looks like that.');
    const moved = places.filter((k) => !refused.includes(k));
    const isNew = act === 'group' && !groupNamed(menu, str(args['group']) ?? '');
    const fields = menuFields(act, args, moved, group, isNew, open);
    if (act !== 'use_suggested' && act !== 'start_over')
      fields.push({ label: 'Your menu', value: menuLayout(next, open) });
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
        title: MENU_TITLES[act] ?? MENU_TITLES['start_over']!,
        fields,
        confirmLabel: refused.length ? '' : 'Save menu',
        warnings,
      }),
      result: refused.length
        ? { blocked: true, why: `${placesWords(refused)} can’t be hidden.` }
        : { waiting: true, menu: menuSummary(next), layout: menuLayout(next, open) },
    };
  },

  async commit(db, ctx, args) {
    // Made on the menu as saved now. `settings.menu` is replaced whole, the same save the menu editor makes, so it
    // says which menu it was made on: one saved in between (the editor, another device) is read again and the
    // change made on that instead, once.
    for (let tries = 1; ; tries += 1) {
      const { me, menu, open } = await menuHere(db, ctx);
      const { next, refused } = nextMenu(menu, args, open);
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
  commentCount: number;
  author: { name: string; you: boolean };
  voted: boolean;
  createdAt: string;
}
interface IdeaGet {
  idea: IdeaSummary & {
    body: string;
    following: boolean;
    canEdit: boolean;
    votingOpen: boolean;
    mergedInto: { id: string; number: number; title: string } | null;
    hidden: boolean;
  };
  comments: {
    id: string;
    body: string;
    author: { name: string; you: boolean; team: boolean };
    hidden: boolean;
    createdAt: string;
  }[];
  updates: (Parameters<typeof ideaUpdateLine>[0] & {
    note: string;
    other: { id: string; number: number; title: string } | null;
    whatsNew: { id: string; title: string } | null;
    by: string;
    createdAt: string;
  })[];
  shipped: { id: string; title: string; publishedAt: string }[];
}
interface IdeaAreas {
  areas: { id: string; name: string; description: string; archived: boolean; openCount: number }[];
}

const ideaHref = (ctx: ToolContext, id: string) => `/app/w/${ctx.workspaceId}/ideas/${id}`;
/**
 * The link the emails about an idea use: it names no business, so it opens the idea for anyone on HandsFreeOS, in the
 * business they were last in. The address in the bar names this business, which nobody else can open.
 */
const ideaLink = (webUrl: string, id: string) => `${webUrl.replace(/\/+$/, '')}/app/ideas/${id}`;
const ideaOf = (db: Db, ctx: ToolContext, ideaId: unknown) =>
  query<IdeaGet>(db, ctx, 'idea.get', { ideaId });
/** Who someone is beside an idea or a comment, as the board names them. */
const ideaPerson = (p: { name: string; you: boolean }) =>
  p.you ? IDEAS_WORDS.you : p.name || IDEAS_WORDS.someone;
const dayOf = (iso: string) => iso.slice(0, 10);

/** The comments an idea's read gives unless every one is asked for: the latest. */
const LAST_COMMENTS = 10;

async function findIdeas(db: Db, ctx: ToolContext, args: Args, webUrl = ''): Promise<ToolOutcome> {
  const ideaId = str(args['ideaId']);
  if (ideaId) {
    const [{ idea, comments, updates, shipped }, areas] = await Promise.all([
      ideaOf(db, ctx, ideaId),
      query<IdeaAreas>(db, ctx, 'idea.areas').catch(() => null),
    ]);
    const shown = args['allComments'] === true ? comments : comments.slice(-LAST_COMMENTS);
    return {
      result: {
        idea: {
          id: idea.id,
          number: idea.number,
          link: ideaLink(webUrl, idea.id),
          status: IDEA_STATUS_WORDS[idea.status],
          whereItStands: IDEA_STATUS_MEANING[idea.status],
          votes: idea.voteCount,
          youVoted: idea.voted,
          youFollow: idea.following,
          votingOpen: idea.votingOpen,
          sharedBy: ideaPerson(idea.author),
          sharedByYou: idea.author.you,
          sharedOn: dayOf(idea.createdAt),
          // As the author wrote them, apart: do_idea_edit takes all three back, so a fixed title keeps the rest.
          title: theirs(idea.title),
          details: theirs(idea.body),
          areaId: idea.areaId,
          area: areas?.areas.find((a) => a.id === idea.areaId)?.name ?? idea.areaId,
          canEdit: idea.canEdit,
          ...(idea.hidden ? { takenOffTheBoard: IDEAS_WORDS.hidden } : {}),
          ...(idea.mergedInto
            ? {
                mergedInto: {
                  id: idea.mergedInto.id,
                  number: idea.mergedInto.number,
                  title: theirs(idea.mergedInto.title),
                },
                merged: IDEAS_WORDS.mergedAfter,
              }
            : {}),
          ...(shipped.length
            ? { inWhatsNew: shipped.map((s) => ({ title: s.title, on: dayOf(s.publishedAt) })) }
            : {}),
        },
        // As the idea's page shows them: who wrote each, the team's marked, and to the team the ones taken down too
        // (idea.get gives those only to them). commentId is what do_idea_set_comment_hidden takes.
        commentCount: comments.length,
        comments: shown.map((c) => ({
          commentId: c.id,
          by: ideaPerson(c.author),
          ...(c.author.team ? { team: IDEAS_WORDS.team } : {}),
          ...(c.hidden ? { takenDown: true } : {}),
          on: dayOf(c.createdAt),
          words: theirs(c.body),
        })),
        ...(shown.length < comments.length
          ? {
              earlierComments: comments.length - shown.length,
              note: `Only the last ${LAST_COMMENTS} comments are here. Ask again with allComments for every one.`,
            }
          : {}),
        // What happened, as the page tells it: each move, who made it and when, and the team's note in their words.
        story: updates.map((u) => ({
          line: ideaUpdateLine(u),
          by: u.by,
          on: dayOf(u.createdAt),
          ...(u.note.trim() ? { note: theirs(u.note) } : {}),
          ...(u.other
            ? {
                otherIdea: { id: u.other.id, number: u.other.number, title: theirs(u.other.title) },
              }
            : {}),
          ...(u.whatsNew ? { whatsNew: u.whatsNew.title } : {}),
        })),
      },
    };
  }
  const [{ ideas, nextCursor }, areas] = await Promise.all([
    query<{ ideas: IdeaSummary[]; nextCursor: string | null }>(db, ctx, 'idea.list', {
      ...(str(args['search']) ? { search: str(args['search']) } : {}),
      ...(str(args['sort']) ? { sort: str(args['sort']) } : {}),
      ...(str(args['status']) ? { status: str(args['status']) } : {}),
      ...(str(args['areaId']) ? { areaId: str(args['areaId']) } : {}),
      ...(str(args['mine']) ? { mine: str(args['mine']) } : {}),
      ...(str(args['cursor']) ? { cursor: str(args['cursor']) } : {}),
      limit: num(args['limit']) ?? 10,
    }),
    query<IdeaAreas>(db, ctx, 'idea.areas').catch(() => null),
  ]);
  return {
    result: {
      count: ideas.length,
      // A page, as the board's Show more ideas reads on from it.
      ...(nextCursor
        ? {
            more: true,
            nextCursor,
            note: 'There are more ideas than these: pass nextCursor as cursor for the next ones.',
          }
        : {}),
      ideas: ideas.map((i) => ({
        id: i.id,
        number: i.number,
        status: IDEA_STATUS_WORDS[i.status],
        votes: i.voteCount,
        youVoted: i.voted,
        comments: i.commentCount,
        sharedBy: ideaPerson(i.author),
        sharedByYou: i.author.you,
        sharedOn: dayOf(i.createdAt),
        area: i.areaId,
        link: ideaLink(webUrl, i.id),
        words: theirs(i.excerpt ? `${i.title} — ${i.excerpt}` : i.title),
      })),
      // As the board's Area filter lists them: each with what it covers and how many open ideas it has.
      ...(areas
        ? {
            areas: areas.areas
              .filter((a) => !a.archived)
              .map((a) => ({
                id: a.id,
                name: a.name,
                about: a.description,
                openIdeas: a.openCount,
              })),
          }
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

  async commit(db, ctx, args, extra) {
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
        // The link anyone on HandsFreeOS can open it by, for "send it to my partner".
        answer: keptAnswer({
          ideaId: out.ideaId,
          number: out.number,
          link: ideaLink(extra.webUrl ?? '', out.ideaId),
        }),
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

  async commit(db, ctx, args, extra) {
    if (hasSecret(args))
      throw HfosError.validation(
        [],
        'A support message can’t carry a password, card number or key. Take out the one in this message, then ask again.',
      );
    // The screen they asked from, as Get help sends its own page: the app's route words and ids, never anything typed.
    const screen = await toolCallScreen(db, ctx, extra.toolCallId).catch(() => null);
    const out = await command<{ ticketId: string; number: number }>(
      db,
      ctx,
      'support.request.create',
      {
        subject: str(args['subject']) ?? '',
        body: str(args['details']),
        context: {
          page: (screen
            ? `Ask HandsFreeOS on /app/w/${ctx.workspaceId}${screen}`
            : 'Ask HandsFreeOS'
          ).slice(0, 200),
        },
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

/**
 * The organization a new business goes under: one of theirs named as they call it, else this business's. Its id is
 * found here from their own list, never taken from the model. Refused, by name, when they have none called that.
 */
async function organizationFor(db: Db, ctx: ToolContext, args: Args) {
  const asked = str(args['organization']);
  if (!asked) return agencyOf(db, ctx).then((a) => ({ ...a, id: ctx.organizationId }));
  const me = await meOf(db, ctx);
  const org = me.organizations.find((o) => o.name.toLowerCase() === asked.toLowerCase());
  if (!org)
    throw HfosError.notFound(
      me.organizations.length
        ? `You have no organization called “${asked}”. Yours are ${joinAnd(me.organizations.map((o) => `“${o.name}”`))}.`
        : `You aren’t an owner or admin of any organization, so you can’t add a business. Ask an owner of ${agencyName(me, ctx)} to add it.`,
    );
  return {
    id: org.id,
    org,
    name: org.name,
    businesses: me.workspaces.filter((w) => w.organizationId === org.id),
  };
}

/** This business's organization's name, as the person's own list has it. */
const agencyName = (me: Me, ctx: ToolContext) =>
  me.workspaces.find((w) => w.organizationId === ctx.organizationId)?.organizationName ??
  'this business';

const addBusiness: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { org, name: orgName, businesses } = await organizationFor(db, ctx, args);
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
          { kind: 'note', text: 'It opens its guided setup next, one question at a time.' },
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
    const { id: organizationId } = await organizationFor(db, ctx, args);
    const out = await command<{ workspaceId: string }>(db, ctx, 'workspace.create', {
      organizationId,
      name,
      timezone: str(args['timezone']) ?? ctx.timezone,
      joinAsOwner: args['whoRunsIt'] === 'me',
    });
    // Where Create workspace goes next: the guided setup, one question at a time.
    return {
      outcome: `${name} is added. Open it to start its guided setup.`,
      href: `/onboarding/${out.workspaceId}`,
      command: 'workspace.create',
    };
  },
};

interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  latestVersion: number | null;
  archivedAt: string | null;
  installs: { total: number; installed: number; pending: number; failed: number; behind: number };
}
interface TemplateInstall {
  workspaceId: string;
  workspaceName: string;
  workflowId: string | null;
  installedVersion: number | null;
  status: string;
  lastError: string | null;
  behind: boolean;
  mapping: Record<string, unknown>;
}
interface TemplateGet {
  template: TemplateSummary & {
    /** The draft's: a save is made against it. */
    revision: number;
    /** The draft as written. */
    definition: Record<string, unknown>;
    placeholders: WorkflowPlaceholder[];
  };
  versions: {
    version: number;
    diff: string[];
    publishedBy: { fullName: string } | null;
    createdAt: string;
  }[];
  installs: TemplateInstall[];
}
interface PackItem {
  kind: string;
  title: string;
  body: string;
  tags: string[];
}
interface PackSummary {
  id: string;
  name: string;
  description: string | null;
  items: PackItem[];
  version: number;
  archivedAt: string | null;
  businesses: { name: string; pending: number; accepted: number; rejected: number }[];
}
interface MoveList {
  migrations: { id: string; status: string }[];
  connections: unknown[];
}

const isForbidden = (e: unknown) => e instanceof HfosError && e.status === 403;
const templateOf = (db: Db, ctx: ToolContext, templateId: unknown) =>
  query<TemplateGet>(db, ctx, 'workflow_template.get', {
    organizationId: ctx.organizationId,
    templateId,
  });

/** Versions an install is behind the newest, as the template's chips count them (0 unless installed). */
const behindBy = (i: TemplateInstall, latest: number | null) =>
  i.status === 'installed' && latest ? Math.max(0, latest - (i.installedVersion ?? 0)) : 0;

/** Templates' Who's behind: "Summit Roofing is 1 behind", "All up to date", or what went wrong. */
function whosBehind(installs: readonly TemplateInstall[], latest: number | null): string {
  if (!installs.length) return 'Not installed yet';
  const failed = installs.filter((i) => i.status === 'failed');
  if (failed.length) return `${joinAnd(failed.map((i) => i.workspaceName))} couldn’t install`;
  if (installs.some((i) => i.status === 'pending')) return 'Installing…';
  const behind = installs.filter((i) => behindBy(i, latest) > 0);
  if (!behind.length) return 'All up to date';
  if (behind.length === 1)
    return `${behind[0]!.workspaceName} is ${behindBy(behind[0]!, latest)} behind`;
  return `${behind.length} businesses are behind`;
}

/**
 * The agency area's pages, as whole links on the web app's address (paths with none known, as in some tests): the
 * organization's id is put on here, never the model's to give.
 */
const agencyLinks = (webUrl: string, organizationId: string) => {
  const at = (page: string) => `${webUrl}/app/org/${organizationId}/${page}`;
  return {
    clientBusinesses: at('businesses'),
    templates: at('templates'),
    knowledgePacks: at('packs'),
    savedSetups: at('ai-setups'),
    migrations: at('migrations'),
  };
};

/** One client business's own workflows and published knowledge, read as the person in that business. */
async function businessForAgency(db: Db, ctx: ToolContext, businessId: string) {
  // The business id goes on last, and only once it's checked to be one of the agency's (getAgencyArea).
  const there = <T>(name: string, input: Record<string, unknown> = {}) =>
    personQuery<T>(db, name, { ...input, workspaceId: businessId }, ctx.actor, ctx.correlationId);
  const [flows, knowledge] = await Promise.all([
    there<{ items: { id: string; name: string; status: string }[] }>('workflow.list'),
    there<{ items: PackItem[]; nextCursor: string | null }>('knowledge_item.list', {
      status: ['published'],
      limit: 50,
    }),
  ]);
  return {
    workflows: flows.items
      .filter((w) => w.status !== 'archived')
      .map((w) => ({ id: w.id, name: w.name, status: w.status })),
    publishedKnowledge: knowledge.items.map((k) => ({
      kind: k.kind,
      title: k.title,
      body: k.body,
      tags: k.tags,
    })),
    ...(knowledge.nextCursor
      ? { moreKnowledge: 'Only its first 50 published items are here.' }
      : {}),
    note: 'To save one of its workflows as a template: do_workflow_template_create_from_workflow with its id. To copy its knowledge into a pack: pass the items as they are to do_knowledge_pack_create, or to do_knowledge_pack_update with every item the pack already has.',
  };
}

async function getAgencyArea(
  db: Db,
  ctx: ToolContext,
  args: Args,
  webUrl = '',
): Promise<ToolOutcome> {
  const { org, name, businesses } = await agencyOf(db, ctx);
  if (!org) return { result: { notYours: notAgencyAdmin(name) } };
  const organizationId = ctx.organizationId;
  const links = agencyLinks(webUrl, organizationId);
  const businessLink = (id: string) => `${webUrl}/app/w/${id}`;
  try {
    const businessId = str(args['businessId']);
    if (businessId) {
      const b = businesses.find((w) => w.id === businessId);
      if (!b)
        throw HfosError.validation(
          [{ path: 'businessId', message: `Not one of ${name}’s businesses.` }],
          `That business isn’t one of ${name}’s. Its id comes from get_agency_area.`,
        );
      return {
        result: {
          business: { id: b.id, name: b.name, link: businessLink(b.id) },
          ...(await businessForAgency(db, ctx, b.id)),
        },
      };
    }

    const packId = str(args['packId']);
    if (packId) {
      const { items } = await query<{ items: PackSummary[] }>(db, ctx, 'knowledge_pack.list', {
        organizationId,
        includeArchived: true,
      });
      const p = items.find((x) => x.id === packId);
      if (!p)
        throw HfosError.notFound(
          'No knowledge pack has that id. Its id comes from get_agency_area.',
        );
      return {
        result: {
          pack: {
            id: p.id,
            name: p.name,
            description: p.description,
            version: p.version,
            ...(p.archivedAt ? { archived: true } : {}),
            items: p.items.map((i) => ({
              kind: i.kind,
              title: i.title,
              body: i.body,
              tags: i.tags,
            })),
            businesses: p.businesses.map((x) => ({
              name: x.name,
              accepted: x.accepted,
              waiting: x.pending,
              rejected: x.rejected,
            })),
            link: links.knowledgePacks,
          },
          note: 'do_knowledge_pack_update’s items replaces this whole list: pass every item here, with only what was asked changed, added or taken out.',
        },
      };
    }

    const templateId = str(args['templateId']);
    if (templateId) {
      const got = await templateOf(db, ctx, templateId);
      const t = got.template;
      const keys = t.placeholders;
      const def = parseDefinition(t.definition);
      return {
        result: {
          template: {
            id: t.id,
            name: t.name,
            description: t.description,
            version: t.latestVersion,
            link: `${links.templates}/${t.id}`,
            detailsEachBusinessPicks: keys.map((p) => ({ key: p.key, label: p.label })),
            checksToFix: templateIssues(def)
              .filter((i) => i.severity === 'error')
              .map((i) => i.message),
            // A template names no business's stages or people, so there are no names to look up.
            ...draftToRead(t.definition, def, {}, t.revision),
          },
          // Versions, newest first, as the editor's Versions lists them.
          versions: got.versions.map((v) => ({
            version: v.version,
            publishedBy: v.publishedBy?.fullName ?? null,
            on: v.createdAt,
            changes: v.diff.slice(0, 10),
            ...(v.diff.length > 10 ? { andMore: v.diff.length - 10 } : {}),
          })),
          whosBehind: whosBehind(got.installs, t.latestVersion),
          businesses: got.installs.map((i) => {
            const behind = behindBy(i, t.latestVersion);
            return {
              id: i.workspaceId,
              name: i.workspaceName,
              status: i.status,
              ...(i.installedVersion !== null ? { hasVersion: i.installedVersion } : {}),
              ...(behind ? { versionsBehind: behind } : {}),
              ...(i.status === 'failed' && i.lastError ? { couldntInstall: i.lastError } : {}),
              ...(i.workflowId
                ? { theirCopy: `${businessLink(i.workspaceId)}/workflows/${i.workflowId}` }
                : {}),
              stillToPick: keys.filter((p) => !i.mapping[p.key]).map((p) => p.label),
            };
          }),
        },
      };
    }

    const [templates, packs, moves] = await Promise.all([
      query<{ items: TemplateSummary[] }>(db, ctx, 'workflow_template.list', { organizationId }),
      query<{ items: PackSummary[] }>(db, ctx, 'knowledge_pack.list', {
        organizationId,
        includeArchived: true,
      }),
      // The agency's own door: every move and connection, as Agency area → Migrations lists them.
      personQuery<MoveList>(
        db,
        'migration.list',
        { organizationId },
        ctx.actor,
        ctx.correlationId,
      ).catch((): null => null),
    ]);
    // Each business's templates and how many it's behind, as Client businesses counts them.
    const installs = await Promise.all(
      templates.items.map((t) => templateOf(db, ctx, t.id).then((g) => g.installs)),
    );
    const tally = (id: string) => {
      const mine = installs.flatMap((list, n) =>
        list
          .filter((i) => i.workspaceId === id)
          .map((i) => behindBy(i, templates.items[n]!.latestVersion)),
      );
      if (!mine.length) return 'No templates yet';
      const behind = mine.filter((b) => b > 0).length;
      return `${plural(mine.length, 'template')} · ${behind ? `${behind} behind` : 'up to date'}`;
    };
    return {
      result: {
        agency: name,
        links,
        businesses: businesses.map((w) => ({
          id: w.id,
          name: w.name,
          templates: tally(w.id),
          link: businessLink(w.id),
        })),
        templates: templates.items.map((t, n) => ({
          id: t.id,
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          published: t.latestVersion !== null,
          ...(t.latestVersion !== null ? { version: t.latestVersion } : {}),
          inBusinesses: t.installs.total,
          installs: {
            installed: t.installs.installed,
            installing: t.installs.pending,
            couldntInstall: t.installs.failed,
            behind: t.installs.behind,
          },
          whosBehind: whosBehind(installs[n]!, t.latestVersion),
        })),
        packs: packs.items.map((p) => ({
          id: p.id,
          name: p.name,
          ...(p.description ? { description: p.description } : {}),
          items: p.items.length,
          version: p.version,
          ...(p.archivedAt ? { archived: true } : {}),
          businesses: p.businesses.map(
            (x) =>
              `${x.name}: ${x.accepted} accepted, ${x.pending} waiting, ${x.rejected} rejected`,
          ),
        })),
        ...(moves
          ? {
              migrations: {
                moves: moves.migrations.map((m) => ({
                  ...m,
                  statusLabel: migrationStatusWords(m.status),
                })),
                connected: moves.connections,
                note: 'Every move the agency has, as Agency area → Migrations lists them. read_migration_get and the migration tools take wholeAgency true to see or act on a move as the agency does.',
              },
            }
          : {}),
        more: 'With a templateId: that template in full. With a packId: that pack’s items. With a businessId: that business’s workflows and published knowledge. read_onboarding_clients: how far each business has got setting up. read_ai_setup_template_list: Saved setups.',
      },
    };
  } catch (e) {
    if (isForbidden(e)) return { result: { notYours: notAgencyAdmin(name) } };
    throw e;
  }
}

const templatePath = (organizationId: string, templateId: unknown) =>
  `/app/org/${organizationId}/templates/${String(templateId)}`;

const editTemplateSteps: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { org, name: orgName } = await agencyOf(db, ctx);
    if (!org)
      return {
        card: settingsCard(toolCallId, 'edit_template_steps', {
          title: 'Change a template',
          fields: [],
          confirmLabel: '',
          warnings: [{ kind: 'blocked', text: notAgencyAdmin(orgName) }],
        }),
        result: { blocked: true, why: notAgencyAdmin(orgName) },
      };
    const ops = args['ops'] as WorkflowOp[];
    const { template: t } = await templateOf(db, ctx, args['templateId']);
    await rehearse(db, ctx, 'workflow_template.save_draft', {
      organizationId: ctx.organizationId,
      templateId: t.id,
      baseRevision: args['baseRevision'],
      ops,
    });
    const { lines, fields } = draftChanges(
      parseDefinition(t.definition),
      ops,
      {},
      `The template “${t.name}”’s draft is that way already.`,
    );
    return {
      card: settingsCard(toolCallId, 'edit_template_steps', {
        title: `Change the template “${t.name}”?`,
        fields: [{ label: 'Template', value: t.name }, ...fields],
        confirmLabel: 'Save draft',
        warnings: [
          {
            kind: 'note',
            text: t.latestVersion
              ? `Only the draft changes. Businesses keep version ${t.latestVersion} until it’s published and pushed to them.`
              : 'Only the draft changes. No business gets it until it’s published and pushed to them.',
          },
        ],
      }),
      result: { template: t.name, changes: lines },
    };
  },
  async commit(db, ctx, args) {
    const out = await command<{ issues: { severity: string; message: string }[] }>(
      db,
      ctx,
      'workflow_template.save_draft',
      {
        organizationId: ctx.organizationId,
        templateId: args['templateId'],
        baseRevision: args['baseRevision'],
        ops: args['ops'],
      },
    );
    return {
      outcome: draftSaved(out.issues),
      href: templatePath(ctx.organizationId, args['templateId']),
      command: 'workflow_template.save_draft',
    };
  },
};

interface DetailMatch {
  businessId: string;
  detail: string;
  id: string | null;
}

/** Most businesses whose details are each written on a push's card; the answer has them all. */
const MATCH_LINES = 6;

/**
 * Each business's details for a template, as Push… → Match details starts them: what the business had, else matched
 * by name (effectiveMapping, as the install does); then what the person asked to change, each checked to be one of
 * that business's own choices. Read as the person in each business, whose ids are checked to be the agency's first.
 */
async function matchDetails(
  db: Db,
  ctx: ToolContext,
  got: TemplateGet,
  ids: readonly string[],
  names: ReadonlyMap<string, string>,
  matches: readonly DetailMatch[],
) {
  const t = got.template;
  const byKey = new Map(t.placeholders.map((p) => [p.key, p]));
  const wrongKey = matches.find((m) => !byKey.has(m.detail));
  if (wrongKey)
    throw HfosError.validation(
      [{ path: 'matches', message: `“${t.name}” has no detail “${wrongKey.detail}”.` }],
      t.placeholders.length
        ? `“${t.name}” has no detail called “${wrongKey.detail}”. Its details are ${joinAnd(t.placeholders.map((p) => p.key))}.`
        : `“${t.name}” names nothing each business picks, so there’s nothing to match.`,
    );
  if (matches.some((m) => !ids.includes(m.businessId)))
    throw HfosError.validation(
      [{ path: 'matches', message: 'Match only the businesses it goes to.' }],
      'Match details only for the businesses it’s pushed to. Add that business to businessIds, or leave its match out.',
    );
  if (!t.placeholders.length) return [];
  return Promise.all(
    ids.map(async (id) => {
      const name = names.get(id) ?? 'That business';
      const { catalogs } = await personQuery<{ catalogs: WorkflowCatalogs }>(
        db,
        'workflow.catalogs',
        { workspaceId: id },
        ctx.actor,
        ctx.correlationId,
      );
      const stored = got.installs.find((i) => i.workspaceId === id)?.mapping ?? {};
      const mapping = effectiveMapping(t.placeholders, stored, catalogs);
      const asked = matches.filter((m) => m.businessId === id);
      for (const m of asked) {
        const p = byKey.get(m.detail)!;
        if (m.id !== null && !placeholderChoices(p.kind, catalogs).some((c) => c.id === m.id))
          throw HfosError.validation(
            [{ path: 'matches', message: `Not one of ${name}’s choices for ${p.label}.` }],
            `That isn’t one of ${name}’s choices for ${p.label}. Pick one of the choices push_to_client_businesses listed for it, or null to leave it for them.`,
          );
        mapping[m.detail] = m.id;
      }
      const details = t.placeholders.map((p) => {
        const choices = placeholderChoices(p.kind, catalogs);
        const picked = mapping[p.key] ?? null;
        return {
          detail: p.key,
          label: p.label,
          // An id they had that's archived since isn't among the choices, but it's still theirs.
          matched: picked ? (choices.find((c) => c.id === picked)?.name ?? 'What they had') : null,
          choices: choices.slice(0, 15).map((c) => ({ id: c.id, name: c.name })),
        };
      });
      return { businessId: id, name, asked: asked.length > 0, mapping, details };
    }),
  );
}

/** One business's line on the card: "Estimate sent: Quote sent · Who takes emergencies: left for them to pick". */
const matchLine = (details: readonly { label: string; matched: string | null }[]) =>
  clip(details.map((d) => `${d.label}: ${d.matched ?? 'left for them to pick'}`).join(' · '), 300);

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
      const matched = await matchDetails(
        db,
        ctx,
        got,
        ids,
        new Map(ids.map((id, n) => [id, names[n]!])),
        list<DetailMatch>(args['matches']) ?? [],
      );
      // What's left for each business to pick, from what it will be matched with, not from what it had.
      const leftTo = matched.filter((b) => b.details.some((d) => !d.matched)).map((b) => b.name);
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
            ...matched
              .slice(0, MATCH_LINES)
              .map((b) => ({ label: b.name, value: matchLine(b.details) })),
            ...(matched.length > MATCH_LINES
              ? [
                  {
                    label: 'And',
                    value: `${plural(matched.length - MATCH_LINES, 'more business', 'more businesses')}, matched the same way`,
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
            ...(leftTo.length
              ? [
                  {
                    kind: 'note',
                    text: `${joinAnd(leftTo)} ${leftTo.length === 1 ? 'picks' : 'pick'} what’s left for them to match; a draft can’t publish until every detail is picked.`,
                  },
                ]
              : []),
          ],
        }),
        result: {
          waiting: true,
          businesses: names,
          ...(matched.length
            ? {
                matched: matched.map((b) => ({
                  businessId: b.businessId,
                  business: b.name,
                  details: b.details,
                })),
                toChange:
                  'To pick another for a business, or leave one for it to pick, call push_to_client_businesses again with matches.',
              }
            : {}),
        },
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
      // Only a business the person matched a detail for gets a mapping: the whole one the card showed, since a
      // mapping replaces what it had. The rest keep what they had, and the install matches the others by name.
      const matches = list<DetailMatch>(args['matches']) ?? [];
      const asked = workspaceIds.filter((id) => matches.some((m) => m.businessId === id));
      const mappings = asked.length
        ? Object.fromEntries(
            (
              await matchDetails(
                db,
                ctx,
                await templateOf(db, ctx, args['templateId']),
                asked,
                new Map(),
                matches,
              )
            ).map((b) => [b.businessId, b.mapping]),
          )
        : {};
      await command(db, ctx, 'workflow_template.push', {
        organizationId,
        templateId: args['templateId'],
        workspaceIds,
        mappings,
      });
      return {
        outcome: `Pushed to ${n}. Each gets a draft to test and publish.`,
        href: templatePath(organizationId, args['templateId']),
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

/**
 * Assistant coverage as the Admin area's page shows it (staff only): its counts, what can't be done yet page by page,
 * the settings pages still to check, and what is never done and why, all from the lists the checks hold the
 * Assistant to, so it says what the code says rather than what it remembers.
 */
async function readAssistantCoverage(): Promise<ToolOutcome> {
  const c = assistantCoverage();
  return {
    result: {
      counts: coverageCards(c).map((card) => ({ what: card.label, count: card.value })),
      notYet: c.notYet.map((p) => ({ page: p.page, why: p.why, actions: p.actions })),
      settingsToCheck: c.settingsToCheck.map((p) => ({ page: p.label, rows: p.rows })),
      never: c.never.map((n) => ({ what: n.command, why: n.why })),
      copyGaps: coverageGapsForClaude(c),
      note: 'Every item on every screen, marked off with how you cover it, and the audit’s gaps are Every item, marked off, on the same page: read_platform_assistant_ledger.',
    },
  };
}

export const extraAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {
  list_automations: listAutomations,
  find_ideas: findIdeas,
  get_agency_area: getAgencyArea,
  read_assistant_coverage: readAssistantCoverage,
};

/** Of those, the ones whose answer links to the web app's own pages, so the executor gives them its address. */
export const extraWebTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args, webUrl: string) => Promise<ToolOutcome>
> = {
  get_agency_area: getAgencyArea,
  find_ideas: findIdeas,
};

export const extraConfirmTools: Record<string, SettingsConfirmTool> = {
  update_ai_teammate_rules: updateAiTeammateRules,
  update_automations: updateAutomations,
  update_my_alerts: myAlerts('update_my_alerts'),
  update_my_support_alerts: myAlerts('update_my_support_alerts'),
  arrange_my_menu: arrangeMyMenu,
  manage_idea: manageIdea,
  contact_support: contactSupport,
  add_business: addBusiness,
  edit_template_steps: editTemplateSteps,
  push_to_client_businesses: pushToClientBusinesses,
};

/** What the panel says while each one runs. */
export const extraStepLabels: Record<string, string> = {
  update_ai_teammate_rules: 'Changing your AI teammate’s rules',
  test_ai_teammate: 'Trying your AI teammate',
  list_automations: 'Looking at your automations',
  update_automations: 'Changing your automations',
  update_my_alerts: 'Changing your alerts',
  update_my_support_alerts: 'Changing your alerts',
  arrange_my_menu: 'Arranging your menu',
  find_ideas: 'Looking at ideas',
  read_assistant_coverage: 'Looking at Assistant coverage',
  manage_idea: 'Getting the idea ready',
  contact_support: 'Writing to support',
  add_business: 'Adding the business',
  get_agency_area: 'Looking at the agency area',
  edit_template_steps: 'Getting the template’s steps ready',
  push_to_client_businesses: 'Getting the push ready',
};
