/**
 * The guided Facebook & Instagram setup (the owner, 24 Nov 2026: F1 a, F2 a, F3 a, F4 a): four questions, one at a
 * time (what lands in the inbox, getting Instagram ready, what happens when someone new writes, and ads), then Check
 * it over, where Connect with Facebook saves the answers (facebook_setup.save) and opens Facebook's own sign-in, and
 * last a live test: a message sent to the Page and to Instagram turns green the moment it lands (F2). Instagram's
 * steps are asked only when Instagram is picked, and lead ads only once a sign-in may read leads (Meta approves that
 * separately). With a Page already connected, the same questions change the answers (Settings → Facebook &
 * Instagram's Change, and "Go through the questions again"), and Save my answers keeps the sign-in as it is.
 *
 * What the setup can't change is said, not hidden: Messenger always comes with the Page, an Instagram account linked
 * to the Page comes along with it, and Facebook decides which permissions its screens ask for, so the ads answer only
 * changes what those screens are said to ask.
 *
 * What the web and the phone both decide lives here: the answers as they are saved (guided_setup.save_draft, under
 * `facebook`), where they start, what is wrong with one, the lines beside the questions and on Settings → Facebook &
 * Instagram, and the live test's rows. Browser-safe.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from '../schemas/common';
import { IntakeChannelKind } from '../schemas/intake';

export const FACEBOOK_SETUP_QUESTIONS = ['inbox', 'instagram', 'leads', 'ads'] as const;
export type FacebookSetupQuestion = (typeof FACEBOOK_SETUP_QUESTIONS)[number];
/** A question, or Check it over. */
export type FacebookSetupScreen = FacebookSetupQuestion | 'review';
export const facebookSetupScreen = z.enum([...FACEBOOK_SETUP_QUESTIONS, 'review']);

/** The three things Instagram needs before another app may read its messages, in the order they're done. */
export const FACEBOOK_SETUP_IG_STEPS = ['igProfessional', 'igLinked', 'igAccess'] as const;
export type FacebookSetupIgStep = (typeof FACEBOOK_SETUP_IG_STEPS)[number];

/** The answers as the screens keep them. */
export const FacebookSetupAnswers = z.object({
  /** Instagram DMs come in too. Messenger always does: it comes with the Page. */
  instagram: z.boolean(),
  /** Question 2's ticks: a professional account, linked to the Page, with Allow access to messages on. */
  igProfessional: z.boolean(),
  igLinked: z.boolean(),
  igAccess: z.boolean(),
  /** Someone new becomes a customer and a lead (on), or a customer only. */
  createLead: z.boolean(),
  /** Null: the business's first pipeline. */
  pipelineId: uuid.nullable(),
  /** Null: the pipeline's first open stage. */
  stageId: uuid.nullable(),
  /** Ads that start a chat: Facebook's screens ask to read the business's ads. */
  adsChat: z.boolean(),
  /** Lead ads' forms come in as customers and leads. Only once a sign-in may read leads. */
  leadAds: z.boolean(),
});
export type FacebookSetupAnswers = z.infer<typeof FacebookSetupAnswers>;

/** A Page or Instagram account as meta_account.list gives it. */
export interface FacebookSetupAccount {
  readonly id: string;
  readonly platform: 'facebook' | 'instagram';
  readonly name: string;
  readonly username: string | null;
  readonly status: 'active' | 'needs_attention' | 'disconnected';
}

/** A channel's rules as intake.list gives them. */
export interface FacebookSetupSource {
  readonly kind: string;
  readonly active: boolean;
  readonly createLead: boolean;
  readonly pipelineId: string | null;
  readonly stageId: string | null;
}

export interface FacebookSetupPipeline {
  readonly id: string;
  readonly name: string;
  readonly stages: readonly { readonly id: string; readonly name: string; readonly kind: string }[];
}

export interface FacebookSetupContext {
  /** Nothing connected yet: Connect with Facebook comes after Check it over. Something connected: Save my answers. */
  readonly mode: 'new' | 'again';
  /** The Pages and Instagram accounts connected now (not the ones disconnected). */
  readonly accounts: readonly FacebookSetupAccount[];
  /** Messenger's rules for someone new; null while it has none of its own (the usual ones apply). */
  readonly messenger: FacebookSetupSource | null;
  /** Lead ads' rules; null while it has none of its own. */
  readonly leadAdsSource: FacebookSetupSource | null;
  readonly pipelines: readonly FacebookSetupPipeline[];
  /** A sign-in may read the business's ads. */
  readonly readsAds: boolean;
  /** A sign-in may read lead ads' forms: Meta has approved it. */
  readonly readsLeads: boolean;
}

/** The context from meta_account.list and intake.list. */
export function facebookSetupContextFrom(input: {
  readonly accounts: readonly FacebookSetupAccount[];
  readonly connections: readonly { readonly readsAds: boolean; readonly readsLeads: boolean }[];
  readonly sources: readonly FacebookSetupSource[];
  readonly pipelines: readonly FacebookSetupPipeline[];
}): FacebookSetupContext {
  const accounts = input.accounts.filter((a) => a.status !== 'disconnected');
  return {
    mode: accounts.length ? 'again' : 'new',
    accounts,
    messenger: input.sources.find((s) => s.kind === 'messenger') ?? null,
    leadAdsSource: input.sources.find((s) => s.kind === 'facebook_lead_ad') ?? null,
    pipelines: input.pipelines,
    readsAds: input.connections.some((c) => c.readsAds),
    readsLeads: input.connections.some((c) => c.readsLeads),
  };
}

const hasInstagram = (ctx: Pick<FacebookSetupContext, 'accounts'>) =>
  ctx.accounts.some((a) => a.platform === 'instagram');

/**
 * Where the answers start. With nothing connected: Instagram too, a customer and a lead in the first pipeline, and ads
 * read (what most businesses pick). With something connected: what's connected and set now, so the same questions
 * change it.
 */
export function facebookSetupStart(ctx: FacebookSetupContext): FacebookSetupAnswers {
  const m = ctx.messenger;
  const igHere = hasInstagram(ctx);
  return {
    instagram: ctx.mode === 'new' || igHere,
    igProfessional: igHere,
    igLinked: igHere,
    igAccess: igHere,
    createLead: m ? m.createLead : true,
    pipelineId: m?.pipelineId ?? null,
    stageId: m?.stageId ?? null,
    adsChat: ctx.mode === 'new' || ctx.readsAds,
    leadAds: ctx.readsLeads && (ctx.leadAdsSource?.active ?? true),
  };
}

/** Saved answers read back over where they start, a field at a time: one that no longer fits is left at its start. */
export function facebookSetupAnswersOf(
  raw: unknown,
  start: FacebookSetupAnswers,
): FacebookSetupAnswers {
  const from = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...start };
  for (const [key, schema] of Object.entries(FacebookSetupAnswers.shape)) {
    const got = (schema as z.ZodType).safeParse(from[key]);
    if (got.success) out[key] = got.data;
  }
  return out as FacebookSetupAnswers;
}

/** The questions these answers ask: Instagram's steps only with Instagram picked. */
export function facebookSetupQuestions(
  a: Pick<FacebookSetupAnswers, 'instagram'>,
): FacebookSetupQuestion[] {
  return FACEBOOK_SETUP_QUESTIONS.filter((q) => q !== 'instagram' || a.instagram);
}

/** The pipeline someone new lands in: the one picked, or the first. */
export function facebookSetupPipeline(
  a: Pick<FacebookSetupAnswers, 'pipelineId'>,
  ctx: Pick<FacebookSetupContext, 'pipelines'>,
): FacebookSetupPipeline | null {
  return (
    (a.pipelineId ? ctx.pipelines.find((p) => p.id === a.pipelineId) : ctx.pipelines[0]) ?? null
  );
}

/** A pipeline's stages a lead can open in. */
export const facebookSetupOpenStages = (p: FacebookSetupPipeline | null) =>
  (p?.stages ?? []).filter((s) => s.kind === 'open');

// ---------- what is wrong ----------

export interface FacebookSetupProblem {
  readonly path: keyof FacebookSetupAnswers;
  readonly message: string;
}

/** What stops Next on a question; empty when it can go on. Instagram's steps never stop it ("Press Next anyway"). */
export function facebookSetupProblems(
  q: FacebookSetupScreen,
  a: FacebookSetupAnswers,
  ctx: Pick<FacebookSetupContext, 'pipelines' | 'readsLeads'>,
): FacebookSetupProblem[] {
  const P = FACEBOOK_SETUP_WORDS.problems;
  const out: FacebookSetupProblem[] = [];
  switch (q) {
    case 'leads': {
      if (!a.createLead) break;
      const pipeline = a.pipelineId ? ctx.pipelines.find((p) => p.id === a.pipelineId) : null;
      if (a.pipelineId && !pipeline) out.push({ path: 'pipelineId', message: P.pipeline });
      else if (
        a.stageId &&
        !facebookSetupOpenStages(pipeline ?? ctx.pipelines[0] ?? null).some(
          (s) => s.id === a.stageId,
        )
      )
        out.push({ path: 'stageId', message: P.stage });
      break;
    }
    case 'ads':
      if (a.leadAds && !ctx.readsLeads) out.push({ path: 'leadAds', message: P.leadAds });
      break;
    case 'inbox':
    case 'instagram':
    case 'review':
      break;
  }
  return out;
}

/** The first question with something wrong, for Check it over; null when all is well. */
export function facebookSetupFirstProblem(
  a: FacebookSetupAnswers,
  ctx: Pick<FacebookSetupContext, 'pipelines' | 'readsLeads'>,
): FacebookSetupQuestion | null {
  return facebookSetupQuestions(a).find((q) => facebookSetupProblems(q, a, ctx).length > 0) ?? null;
}

/**
 * The question a refusal from Connect with Facebook is about, from its path ("answers.stageId", or a channel's own
 * "pipelineId"), and the answer's field; null when it's about none of them.
 */
export function facebookSetupQuestionOf(path: string): {
  readonly question: FacebookSetupQuestion;
  readonly field: keyof FacebookSetupAnswers;
} | null {
  const key = path.split('.').filter((p) => p !== 'answers')[0];
  if (key === 'pipelineId' || key === 'stageId' || key === 'createLead')
    return { question: 'leads', field: key };
  if (key === 'leadAds' || key === 'adsChat') return { question: 'ads', field: key };
  if (key === 'instagram') return { question: 'inbox', field: key };
  return null;
}

// ---------- what Connect with Facebook saves ----------

/**
 * The rules for someone new on one channel, as intake_source.update takes them: on, with the lead (or not) the answers
 * say, in the pipeline and stage they picked. A customer only leaves where leads land as it was.
 */
export function facebookSetupIntakeFields(a: FacebookSetupAnswers) {
  return {
    active: true,
    createLead: a.createLead,
    ...(a.createLead
      ? { pipelineId: a.pipelineId, ...(a.stageId ? { stageId: a.stageId } : {}) }
      : {}),
  };
}

export const FacebookSetupSaveInput = z.object({
  workspaceId: uuid,
  answers: FacebookSetupAnswers,
});
export const FacebookSetupSaveOutput = z.object({
  /** The channels whose rules for someone new changed. */
  changed: z.array(IntakeChannelKind),
});
export type FacebookSetupSaveOutput = z.infer<typeof FacebookSetupSaveOutput>;

// ---------- the live test ----------

export const MetaAccountTestMessagesInput = z.object({
  workspaceId: uuid,
  /** Messages from this moment on count. */
  since: isoDateTime,
});
export const MetaAccountTestMessagesOutput = z.object({
  accounts: z.array(
    z.object({
      accountId: uuid,
      platform: z.enum(['facebook', 'instagram']),
      name: z.string(),
      username: z.string().nullable(),
      /** The newest message someone sent it since then; null while none has come. */
      gotAt: isoDateTime.nullable(),
      /** That message's first words. */
      preview: z.string().nullable(),
    }),
  ),
});
export type MetaAccountTestMessages = z.infer<typeof MetaAccountTestMessagesOutput>;

/** How long the test waits before it says what to check. */
export const FACEBOOK_TEST_HINT_AFTER_MS = 2 * 60_000;

// ---------- the lines ----------

export interface FacebookSetupLine {
  readonly key: FacebookSetupQuestion;
  readonly label: string;
  readonly value: string;
}

/** "2 of 3 steps ticked. Allow access to messages isn’t ticked yet." */
export function facebookIgStepsLine(a: Pick<FacebookSetupAnswers, FacebookSetupIgStep>): string {
  const W = FACEBOOK_SETUP_WORDS.lines;
  const left = FACEBOOK_SETUP_IG_STEPS.filter((s) => !a[s]);
  if (left.length === 0) return W.igAll;
  const done = FACEBOOK_SETUP_IG_STEPS.length - left.length;
  const first = FACEBOOK_SETUP_WORDS.instagram.steps.find((s) => s.key === left[0])!;
  return W.igSome(done, first.title);
}

/** "A customer and a lead, in Sales at New lead". */
export function facebookLeadsLine(
  a: Pick<FacebookSetupAnswers, 'createLead' | 'pipelineId' | 'stageId'>,
  ctx: Pick<FacebookSetupContext, 'pipelines'>,
): string {
  const W = FACEBOOK_SETUP_WORDS.lines;
  if (!a.createLead) return W.customerOnly;
  const pipeline = facebookSetupPipeline(a, ctx);
  const stages = facebookSetupOpenStages(pipeline);
  const stage = (a.stageId ? stages.find((s) => s.id === a.stageId) : stages[0]) ?? null;
  return pipeline ? W.leadIn(pipeline.name, stage?.name ?? null) : W.lead;
}

/** "Ads that start a chat and lead ads", or "No ads right now". */
export function facebookAdsLine(a: Pick<FacebookSetupAnswers, 'adsChat' | 'leadAds'>): string {
  const W = FACEBOOK_SETUP_WORDS.lines;
  if (a.adsChat && a.leadAds) return W.adsBoth;
  if (a.adsChat) return W.adsChat;
  if (a.leadAds) return W.adsLead;
  return W.adsNone;
}

/** One line a question asked, for the list beside the questions and Check it over. */
export function facebookSetupLines(
  a: FacebookSetupAnswers,
  ctx: Pick<FacebookSetupContext, 'pipelines'>,
): FacebookSetupLine[] {
  const W = FACEBOOK_SETUP_WORDS.lines;
  return facebookSetupQuestions(a).map((key): FacebookSetupLine => {
    switch (key) {
      case 'inbox':
        return { key, label: W.inbox, value: a.instagram ? W.inboxBoth : W.inboxMessenger };
      case 'instagram':
        return { key, label: W.instagram, value: facebookIgStepsLine(a) };
      case 'leads':
        return { key, label: W.leads, value: facebookLeadsLine(a, ctx) };
      case 'ads':
        return { key, label: W.ads, value: facebookAdsLine(a) };
    }
  });
}

/**
 * Settings → Facebook & Instagram's answers, read from what's connected and set now (so they're never out of step
 * with All settings): what lands in the inbox, someone new, and ads.
 */
export function facebookSettingsLines(ctx: FacebookSetupContext): FacebookSetupLine[] {
  const W = FACEBOOK_SETUP_WORDS.lines;
  const a = facebookSetupStart(ctx);
  const ig = hasInstagram(ctx);
  return [
    { key: 'inbox', label: W.inbox, value: ig ? W.inboxBoth : W.inboxMessenger },
    { key: 'leads', label: W.leads, value: facebookLeadsLine(a, ctx) },
    {
      key: 'ads',
      label: W.ads,
      value: ctx.readsAds ? facebookAdsLine({ adsChat: true, leadAds: a.leadAds }) : W.adsNotRead,
    },
  ];
}

/** What Facebook's screens ask, on Check it over: pick the Page (and Instagram), and leave the permissions ticked. */
export function facebookSignInSteps(a: Pick<FacebookSetupAnswers, 'instagram' | 'adsChat'>) {
  const W = FACEBOOK_SETUP_WORDS.review;
  return [a.instagram ? W.pickBoth : W.pickPage, a.adsChat ? W.permsAds : W.perms, W.comesBack];
}

// ---------- words ----------

/** Everything the Facebook & Instagram setup says, on the web and the phone. */
export const FACEBOOK_SETUP_WORDS = {
  pageTitle: 'Set up Facebook & Instagram',
  settingUp: (business: string) => `Setting up Facebook & Instagram for ${business}`,
  soFar: 'Your Facebook & Instagram so far',
  startedFrom: 'Started from what most businesses pick. Change anything.',
  skip: 'Skip, I’ll do it in Settings',
  notAllowed: 'Only an owner or admin can connect Facebook and Instagram.',
  notAllowedHint: 'Ask an owner of this business to set it up, or to give you that permission.',
  inbox: {
    title: 'What should land in your inbox?',
    hint: 'Answer them beside your texts and emails, on the web and the phone app.',
    messenger: 'Facebook Messenger',
    messengerHint: 'Messages people send your Facebook Page. Always on: it comes with your Page.',
    instagram: 'Instagram direct messages',
    instagramHint:
      'DMs to your business’s Instagram account. It connects through your Facebook Page.',
    instagramOff:
      'If an Instagram account is linked to your Page, it still comes along. You can disconnect it under All settings.',
    need: 'You’ll need',
    needLogin: 'A Facebook login that manages your business’s Page.',
    needInstagram:
      'For Instagram, about 2 minutes in the Instagram app. The next question walks you through it.',
    note: 'Comments on your posts don’t come in yet. Only direct messages do.',
  },
  instagram: {
    title: 'Get your Instagram ready',
    hint: 'Instagram only lets another app read your DMs once these three are done. Tick each one as you go.',
    steps: [
      {
        key: 'igProfessional',
        title: 'Make it a professional account',
        how: 'In the Instagram app: your profile, the menu, Account type and tools, then Switch to professional account. Business or Creator both work.',
      },
      {
        key: 'igLinked',
        title: 'Link it to your Facebook Page',
        how: 'On Facebook, open your Page’s Settings, then Linked accounts, and connect Instagram. Sign in to Instagram when it asks.',
      },
      {
        key: 'igAccess',
        title: 'Allow access to messages',
        how: 'In the Instagram app: Settings, Messages and story replies, Connected tools, then turn on Allow access to messages.',
      },
    ] as const satisfies readonly {
      readonly key: FacebookSetupIgStep;
      readonly title: string;
      readonly how: string;
    }[],
    note: 'Not sure? Press Next anyway. If Instagram doesn’t show up when you connect, this tells you which step is missing.',
  },
  leads: {
    title: 'When someone new messages you, what should happen?',
    hint: 'People you already know just join their customer page. This is for strangers.',
    lead: 'Add them as a customer and open a lead',
    leadHint: 'So nobody new slips through. Their name comes from Facebook or Instagram.',
    best: 'Most businesses',
    customer: 'Add them as a customer only',
    customerHint: 'Open a lead yourself when the chat turns into work.',
    pipeline: 'Leads land in',
    firstPipeline: 'Your first pipeline',
    stage: 'Stage',
    firstStage: 'Its first open stage',
    note: 'Same for Messenger and Instagram. Set them apart, or change the 50 a day limit, in Settings → Lead intake.',
  },
  ads: {
    title: 'Do you run ads on Facebook or Instagram?',
    hint: 'Then you can see which ad brought each person in, and every time they came back.',
    chat: 'Ads that start a chat',
    chatHint:
      'Each chat shows the campaign, ad set and ad it came from. Facebook asks to let HandsFreeOS read your ads: leave it ticked.',
    leadAds: 'Lead ads with a form',
    leadAdsHint:
      'Each form someone sends comes in as a customer and a lead, with their OK to text when they tick it.',
    leadAdsWait: 'Once Meta approves it',
    none: 'No ads right now',
    noneHint: 'Nothing about ads is asked for. Turn it on later in Settings.',
    note: 'HandsFreeOS only reads your ads. It never changes them or spends anything.',
  },
  review: {
    title: 'Check it over',
    kicker: 'Almost done',
    hintNew: 'Change anything, then connect. Facebook asks you to sign in next.',
    hintAgain: 'Change anything, then save. Your Facebook sign-in stays as it is.',
    onFacebook: 'On Facebook’s screens',
    pickBoth: 'Pick your business, then your Page and its Instagram account.',
    pickPage: 'Pick your business, then your Page.',
    permsAds: 'Leave every permission ticked, including managing messages and reading ads.',
    perms: 'Leave every permission ticked, including managing messages.',
    comesBack: 'It comes straight back here for the test.',
    asideNew: 'Each answer is saved. Connecting uses them all at once.',
    connect: 'Connect with Facebook',
    save: 'Save my answers',
    saveConnect: 'Save and connect with Facebook',
    saveConnectHint: 'To add Instagram, or another Page, sign in to Facebook again.',
    saved: 'Facebook & Instagram saved.',
  },
  test: {
    title: 'Send yourself a test message',
    hint: 'From your personal Facebook or Instagram, or a friend’s, message your Page and your Instagram. Each one shows here the moment it lands.',
    hintPhone:
      'Message your Page and your Instagram from your own account. Each shows here when it lands.',
    connected: (names: string) => `Connected ${names}. One last check.`,
    nothing: 'Nothing is connected yet.',
    nothingHint:
      'Facebook didn’t connect a Page. Connect with Facebook again, and pick your Page on its screens.',
    tryAgain: 'Connect with Facebook again',
    kindPage: 'Facebook Page · Messenger',
    kindInstagram: 'Instagram',
    got: (preview: string | null) => (preview ? `Got “${preview}” just now` : 'Got it just now'),
    gotShort: 'Got it',
    waiting: 'Waiting for a message',
    stuckInstagram:
      'Nothing from Instagram after 2 minutes? In the Instagram app, turn on Allow access to messages (Settings, Messages and story replies, Connected tools), then send it again.',
    stuckPage:
      'Nothing from your Page after 2 minutes? Check you messaged the Page itself, not your own profile, then send it again.',
    noInstagram:
      'No Instagram came along. Check the 3 steps (a professional account, linked to your Page, Allow access to messages), then Connect with Facebook again.',
    later: 'I’ll test it later',
    openInbox: 'Open the inbox',
    openInstagram: 'Open Instagram',
    done: 'Done',
    aside: 'Connected. The test just shows it works end to end.',
  },
  summary: {
    lead: 'Messages to your Page and Instagram land in your inbox.',
    setUp: 'Bring your Facebook and Instagram messages in',
    setUpHint: 'Four quick questions, then connect with Facebook and send a test. About 5 minutes.',
    start: 'Start',
    resume: 'Pick up where you left off',
    connected: 'Connected',
    answering: 'Answering here',
    needsAttention: 'Needs attention',
    fix: 'Something needs fixing. Open All settings to see what.',
    conversations: (n: number) => `${n} ${n === 1 ? 'conversation' : 'conversations'}`,
    sendTest: 'Send a test message',
    connectMore: 'Connect more',
    answers: 'Your answers',
    again: 'Go through the questions again',
    change: 'Change',
    allSettings: 'All settings',
    hideAll: 'Hide all settings',
    under: 'Under All settings',
    underHint:
      'Today’s page, unchanged: each Page and Instagram account with Disconnect, your Facebook sign-ins and whether they read ads, lead ads’ forms and Leads Access, and what to do when one needs attention. Nothing is taken away.',
  },
  phone: {
    row: 'Facebook & Instagram',
    rowHint: 'Messenger and Instagram DMs in your inbox',
    signInHint: 'Facebook’s sign-in opens in your browser, then comes back here.',
    onWeb:
      'Facebook asked you to sign in on the web too. Finish there, then come back here for the test.',
  },
  lines: {
    inbox: 'What lands in your inbox',
    inboxBoth: 'Messenger and Instagram DMs',
    inboxMessenger: 'Messenger only',
    instagram: 'Instagram',
    igAll: 'All 3 steps ticked',
    igSome: (done: number, first: string) =>
      `${done} of 3 steps ticked. ${first} isn’t ticked yet.`,
    leads: 'New people who message you',
    lead: 'A customer and a lead',
    leadIn: (pipeline: string, stage: string | null) =>
      `A customer and a lead, in ${pipeline}${stage ? ` at ${stage}` : ''}`,
    customerOnly: 'A customer only',
    ads: 'Your ads',
    adsBoth: 'Ads that start a chat, and lead ads. HandsFreeOS reads your ads.',
    adsChat: 'Ads that start a chat. HandsFreeOS reads your ads.',
    adsLead: 'Lead ads with a form',
    adsNone: 'No ads right now',
    adsNotRead: 'Your ads aren’t read. Connect Facebook again and allow ads to see them.',
  },
  problems: {
    pipeline: 'That pipeline isn’t there anymore. Pick where leads land.',
    stage: 'That stage isn’t in this pipeline anymore. Pick another, or its first open stage.',
    leadAds:
      'Lead ads come in once Meta approves them for HandsFreeOS. Untick it for now; we’ll offer it then.',
  },
} as const;
