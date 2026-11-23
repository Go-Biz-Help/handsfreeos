/**
 * The guided website chat setup (the owner, 23 Nov 2026: W1 a, W2 b, W3 a, W4 b): six questions, one at a time (which
 * website shows the chat, who answers, what happens when nobody is answering, what it asks visitors for, how it looks,
 * where its button sits), then Check it over, where Turn on website chat carries them all out (chat_setup.save), and
 * last "Put it on your site": the code, the steps for each site builder, Email your web person, and the check that
 * turns green once the chat is seen there. Picking the AI teammate also turns on its Website chat (W1). What it asks
 * for is today's three rows (W2). With a chat already set up, the same questions change it (Settings → Website chat's
 * Change, and "Go through the questions again"), without the last step.
 *
 * What the web and the phone both decide lives here: the answers as they are saved (guided_setup.save_draft, under
 * `chat`), where they start, what is wrong with an answer, the lines beside the questions and on Settings → Website
 * chat, and what Turn on website chat sends. Browser-safe.
 */
import { z } from 'zod';
import { CHAT_DEFAULT_GREETING } from '../chat/install';
import { CHAT_LIFT_LIMIT } from '../chat/look';
import { MAX_CHAT_ORIGINS, normalizeChatOrigin, normalizeChatOrigins } from '../chat/origins';
import {
  chatAskMode,
  chatWhenAway,
  chatWidgetPosition,
  type ChatAskMode,
  type ChatWidgetOut,
} from '../schemas/chat';
import { uuid } from '../schemas/common';

export const CHAT_SETUP_QUESTIONS = ['sites', 'who', 'away', 'ask', 'look', 'place'] as const;
export type ChatSetupQuestion = (typeof CHAT_SETUP_QUESTIONS)[number];
/** A question, or Check it over. */
export type ChatSetupScreen = ChatSetupQuestion | 'review';
export const chatSetupScreen = z.enum([...CHAT_SETUP_QUESTIONS, 'review']);

/** On phones: the same corner as on computers, moved up above a bar along the bottom, or no button at all. */
export const CHAT_SETUP_PHONE = ['same', 'lift', 'hidden'] as const;
export type ChatSetupPhone = (typeof CHAT_SETUP_PHONE)[number];
/** "A little", "Above a bar", "Higher": how far up the phone's button moves, in pixels. */
export const CHAT_SETUP_LIFTS = [60, 90, 120] as const;
/** What "Yes, move the chat up" starts at. */
export const CHAT_SETUP_LIFT = 90;

/** The swatches, the business's own colour first when it has one. The same six as Settings → Website chat. */
export const CHAT_SETUP_SWATCHES = [
  '#b42318',
  '#2d69d8',
  '#0e7490',
  '#008743',
  '#7c3aed',
  '#191d25',
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The answers as the screens keep them. Text stays as typed (a half-typed greeting is still worth keeping):
 * `chatSetupProblems` says what is wrong, and chat_widget.create and chat_widget.update check the real thing again.
 */
export const ChatSetupAnswers = z.object({
  /** The sites as typed (acme.com); each gets its www twin when it's turned on. */
  sites: z.array(z.string().max(300)).max(20),
  /** The AI teammate, or only the team. */
  who: z.enum(['ai', 'team']),
  whenAway: chatWhenAway,
  awayMessage: z.string().max(600),
  /** Today's three rows (W2 b): when the chat asks for each. */
  askName: chatAskMode,
  askPhone: chatAskMode,
  askEmail: chatAskMode,
  smsConsent: z.boolean(),
  greeting: z.string().max(600),
  launcherLabel: z.string().max(60),
  accentColor: z.string().max(7),
  showLogo: z.boolean(),
  position: chatWidgetPosition,
  desktopButton: z.enum(['label', 'icon']),
  phone: z.enum(CHAT_SETUP_PHONE),
  mobileLift: z.int().min(0).max(CHAT_LIFT_LIMIT),
  mobileButton: z.enum(['label', 'icon']),
});
export type ChatSetupAnswers = z.infer<typeof ChatSetupAnswers>;

/** The AI teammate as the setup needs it: its name, whether it's on, and which chat its Website chat answers. */
export interface ChatSetupTeammate {
  readonly id: string;
  readonly name: string;
  readonly status: 'off' | 'training' | 'automatic';
  /** Its Website chat channel is on. */
  readonly chatOn: boolean;
  /** The one chat that channel answers. */
  readonly widgetId: string | null;
}

/** The chat being changed, as chat_widget.list gives it. */
export type ChatSetupWidget = Pick<
  ChatWidgetOut,
  | 'id'
  | 'name'
  | 'publicKey'
  | 'allowedOrigins'
  | 'teammate'
  | 'greeting'
  | 'launcherLabel'
  | 'accentColor'
  | 'showLogo'
  | 'placement'
  | 'awayMessage'
  | 'whenAway'
  | 'askFor'
  | 'smsConsent'
  | 'paused'
  | 'install'
>;

export interface ChatSetupContext {
  /** No chat yet: Turn on website chat makes one, then Put it on your site. With one: the same questions change it. */
  readonly mode: 'new' | 'again';
  readonly widget: ChatSetupWidget | null;
  readonly teammate: ChatSetupTeammate | null;
  /** The business's website from sign-up (Settings → Workspace): the first site a new chat shows on. */
  readonly website: string | null;
  /** The business's colour (Settings → Workspace): a new chat starts in it. */
  readonly brandColor: string | null;
  /** The business has a logo for the top of the chat. */
  readonly hasLogo: boolean;
}

/** The context from chat_widget.list's first chat, ai_teammate.get and the business's settings. */
export function chatSetupContextFrom(input: {
  readonly widget: ChatSetupWidget | null;
  readonly teammate: ChatSetupTeammate | null;
  readonly website: string | null;
  readonly brandColor: string | null;
  readonly hasLogo: boolean;
}): ChatSetupContext {
  return {
    mode: input.widget ? 'again' : 'new',
    widget: input.widget,
    teammate: input.teammate,
    website: input.website,
    brandColor:
      input.brandColor && HEX.test(input.brandColor) ? input.brandColor.toLowerCase() : null,
    hasLogo: input.hasLogo,
  };
}

/** The AI teammate's Website chat channel from its saved settings, as ai_teammate.get gives them. */
export function chatSetupTeammateOf(
  t: {
    readonly id: string;
    readonly name: string;
    readonly status: 'off' | 'training' | 'automatic';
    readonly config?: unknown;
  } | null,
): ChatSetupTeammate | null {
  if (!t) return null;
  const channels = (t.config as { channels?: { chat?: unknown; widgetId?: unknown } } | undefined)
    ?.channels;
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    chatOn: channels?.chat === true,
    widgetId: typeof channels?.widgetId === 'string' ? channels.widgetId : null,
  };
}

/** A chat's sites as people typed them: each origin once, without the www twins added for it. */
export function chatTypedSites(origins: readonly string[]): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  for (const origin of origins) {
    if (used.has(origin)) continue;
    used.add(origin);
    const r = normalizeChatOrigin(origin);
    if (r.ok && r.twin && origins.includes(r.twin)) used.add(r.twin);
    out.push(origin);
  }
  return out;
}

/** A site as people read it: acme.com, or http://localhost:4191. */
export const chatSiteShown = (origin: string): string => origin.replace(/^https:\/\//, '');

/** The answers a chat already has, for changing it. */
export function chatSetupAnswersFromWidget(w: ChatSetupWidget): ChatSetupAnswers {
  const m = w.placement.mobile;
  const hidden = m.button === 'hidden';
  return {
    sites: chatTypedSites(w.allowedOrigins),
    who: w.teammate ? 'ai' : 'team',
    whenAway: w.whenAway,
    awayMessage: w.awayMessage ?? '',
    askName: w.askFor.name,
    askPhone: w.askFor.phone,
    askEmail: w.askFor.email,
    smsConsent: w.smsConsent,
    greeting: w.greeting ?? '',
    launcherLabel: w.launcherLabel,
    accentColor: w.accentColor.toLowerCase(),
    showLogo: w.showLogo,
    position: w.placement.desktop.position,
    desktopButton: w.placement.desktop.button,
    phone: hidden ? 'hidden' : m.lift > 0 ? 'lift' : 'same',
    mobileLift: m.lift > 0 ? m.lift : CHAT_SETUP_LIFT,
    mobileButton: m.button === 'label' ? 'label' : 'icon',
  };
}

/**
 * Where the answers start. A chat that's set up starts from what it has; a new one from sign-up: the business's
 * website, its colour and its logo, with the AI teammate answering when there is one, the chat working as usual while
 * nobody is answering, and the round icon on phones.
 */
export function chatSetupStart(ctx: ChatSetupContext): ChatSetupAnswers {
  if (ctx.widget) return chatSetupAnswersFromWidget(ctx.widget);
  const site = ctx.website && normalizeChatOrigin(ctx.website).ok ? ctx.website.trim() : null;
  return {
    sites: site ? [site] : [],
    who: ctx.teammate ? 'ai' : 'team',
    whenAway: 'chat',
    awayMessage: '',
    askName: 'when_needed',
    askPhone: 'when_needed',
    askEmail: 'when_needed',
    smsConsent: true,
    greeting: CHAT_DEFAULT_GREETING,
    launcherLabel: CHAT_SETUP_WORDS.look.labelDefault,
    accentColor: ctx.brandColor ?? CHAT_SETUP_SWATCHES[1],
    showLogo: true,
    position: 'right',
    desktopButton: 'label',
    phone: 'same',
    mobileLift: CHAT_SETUP_LIFT,
    mobileButton: 'icon',
  };
}

/** Saved answers read back over where they start, a field at a time: one that no longer fits is left at its start. */
export function chatSetupAnswersOf(raw: unknown, start: ChatSetupAnswers): ChatSetupAnswers {
  const from = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...start };
  for (const [key, schema] of Object.entries(ChatSetupAnswers.shape)) {
    const got = (schema as z.ZodType).safeParse(from[key]);
    if (got.success) out[key] = got.data;
  }
  return out as ChatSetupAnswers;
}

/** The swatches to offer: the business's colour first, then the usual ones, then the one picked if it's neither. */
export function chatSetupSwatches(
  ctx: Pick<ChatSetupContext, 'brandColor'>,
  picked: string,
): string[] {
  const out: string[] = [];
  const add = (c: string | null) => {
    const v = c?.toLowerCase();
    if (v && HEX.test(v) && !out.includes(v)) out.push(v);
  };
  add(ctx.brandColor);
  for (const c of CHAT_SETUP_SWATCHES) add(c);
  add(picked);
  return out;
}

/** What the AI teammate's Website chat needs for this chat: nothing, turning on, or moving from another chat. */
export function chatSetupTeammateChange(
  a: Pick<ChatSetupAnswers, 'who'>,
  ctx: {
    readonly teammate: ChatSetupTeammate | null;
    readonly widget: { readonly id: string } | null;
  },
): 'none' | 'on' | 'turn_on' | 'move' {
  const t = ctx.teammate;
  if (a.who !== 'ai' || !t) return 'none';
  if (!t.chatOn) return 'turn_on';
  if (ctx.widget && t.widgetId === ctx.widget.id) return 'on';
  return t.widgetId ? 'move' : 'turn_on';
}

// ---------- what is wrong ----------

export interface ChatSetupProblem {
  /** The answer's field. */
  readonly path: keyof ChatSetupAnswers;
  readonly message: string;
}

/** What stops Next on a question; empty when it can go on. */
export function chatSetupProblems(
  q: ChatSetupScreen,
  a: ChatSetupAnswers,
  ctx: Pick<ChatSetupContext, 'teammate'>,
): ChatSetupProblem[] {
  const P = CHAT_SETUP_WORDS.problems;
  const out: ChatSetupProblem[] = [];
  switch (q) {
    case 'sites': {
      const { issues } = normalizeChatOrigins(a.sites);
      if (issues.length) out.push({ path: 'sites', message: issues[0]!.message });
      break;
    }
    case 'who':
      if (a.who === 'ai' && !ctx.teammate) out.push({ path: 'who', message: P.noTeammate });
      break;
    case 'away':
      if (a.awayMessage.trim().length > 500) out.push({ path: 'awayMessage', message: P.long });
      break;
    case 'look':
      if (a.greeting.trim().length > 500) out.push({ path: 'greeting', message: P.long });
      if (!a.launcherLabel.trim()) out.push({ path: 'launcherLabel', message: P.labelEmpty });
      else if (a.launcherLabel.trim().length > 40)
        out.push({ path: 'launcherLabel', message: P.labelLong });
      if (!HEX.test(a.accentColor)) out.push({ path: 'accentColor', message: P.colour });
      break;
    case 'place':
      if (a.phone === 'lift' && (a.mobileLift < 1 || a.mobileLift > CHAT_LIFT_LIMIT))
        out.push({ path: 'mobileLift', message: P.lift });
      break;
    case 'ask':
    case 'review':
      break;
  }
  return out;
}

/** The first question with something wrong, for Check it over; null when all is well. */
export function chatSetupFirstProblem(
  a: ChatSetupAnswers,
  ctx: Pick<ChatSetupContext, 'teammate'>,
): ChatSetupQuestion | null {
  return CHAT_SETUP_QUESTIONS.find((q) => chatSetupProblems(q, a, ctx).length > 0) ?? null;
}

const QUESTION_OF: Readonly<Record<string, ChatSetupQuestion>> = {
  sites: 'sites',
  allowedOrigins: 'sites',
  who: 'who',
  teammateId: 'who',
  whenAway: 'away',
  awayMessage: 'away',
  askName: 'ask',
  askPhone: 'ask',
  askEmail: 'ask',
  askFor: 'ask',
  smsConsent: 'ask',
  greeting: 'look',
  launcherLabel: 'look',
  accentColor: 'look',
  showLogo: 'look',
  position: 'place',
  desktopButton: 'place',
  phone: 'place',
  mobileLift: 'place',
  mobileButton: 'place',
};

/**
 * The question a refusal from Turn on website chat is about, from its path ("answers.greeting", or the chat's own
 * "allowedOrigins.1"), and the answer's field; null when it's about none of them.
 */
export function chatSetupQuestionOf(
  path: string,
): { readonly question: ChatSetupQuestion; readonly field: keyof ChatSetupAnswers } | null {
  const parts = path.split('.').filter((p) => p !== 'answers' && !/^\d+$/.test(p));
  const key = parts[0];
  const question = key ? QUESTION_OF[key] : undefined;
  if (!key || !question) return null;
  const field: keyof ChatSetupAnswers =
    key in ChatSetupAnswers.shape
      ? (key as keyof ChatSetupAnswers)
      : key === 'allowedOrigins'
        ? 'sites'
        : key === 'teammateId'
          ? 'who'
          : key === 'askFor'
            ? parts[1] === 'phone'
              ? 'askPhone'
              : parts[1] === 'email'
                ? 'askEmail'
                : 'askName'
            : 'sites';
  return { question, field };
}

// ---------- what Turn on website chat sends ----------

/**
 * The chat's fields from the answers, as chat_widget.create and chat_widget.update take them. What the setup doesn't
 * ask stays as it is on a chat being changed (its name, daily limit, words and top bar colours, how far up it sits on
 * computers, and the phone's own corner): those are under All settings.
 */
export function chatSetupWidgetFields(a: ChatSetupAnswers, teammateId: string | null) {
  return {
    allowedOrigins: a.sites.map((s) => s.trim()).filter(Boolean),
    teammateId: a.who === 'ai' ? teammateId : null,
    greeting: a.greeting.trim(),
    launcherLabel: a.launcherLabel.trim(),
    accentColor: a.accentColor.toLowerCase(),
    showLogo: a.showLogo,
    position: a.position,
    desktopButton: a.desktopButton,
    mobileButton: a.phone === 'hidden' ? ('hidden' as const) : a.mobileButton,
    ...(a.phone === 'hidden' ? {} : { mobileLift: a.phone === 'lift' ? a.mobileLift : 0 }),
    whenAway: a.whenAway,
    awayMessage: a.awayMessage.trim(),
    askFor: { name: a.askName, phone: a.askPhone, email: a.askEmail },
    smsConsent: a.smsConsent,
  };
}

export const ChatSetupSaveInput = z.object({
  workspaceId: uuid,
  /** The chat being changed; null makes a new one. */
  widgetId: uuid.nullable(),
  answers: ChatSetupAnswers,
});
export const ChatSetupSaveOutput = z.object({
  widgetId: uuid,
  publicKey: z.string(),
  /** A new chat was made (so Put it on your site comes next). */
  created: z.boolean(),
  /**
   * The AI teammate's Website chat: not asked for, already answering this chat, turned on (or moved here) now, or
   * left as it was because the person can't change the AI teammate.
   */
  teammateChat: z.enum(['none', 'on', 'turned_on', 'not_allowed']),
});
export type ChatSetupSaveOutput = z.infer<typeof ChatSetupSaveOutput>;

// ---------- the lines ----------

export interface ChatSetupLine {
  readonly key: ChatSetupQuestion;
  readonly label: string;
  readonly value: string;
}

const ASK_SHORT: Readonly<Record<ChatAskMode, string>> = {
  never: 'never',
  when_needed: 'when needed',
  after_first_message: 'after their first message',
  before_chat: 'before the chat starts',
};

/** "Name and mobile when needed, email never". */
export function chatAskSummary(
  a: Pick<ChatSetupAnswers, 'askName' | 'askPhone' | 'askEmail'>,
): string {
  const groups = new Map<ChatAskMode, string[]>();
  for (const [label, mode] of [
    ['name', a.askName],
    ['mobile', a.askPhone],
    ['email', a.askEmail],
  ] as const) {
    groups.set(mode, [...(groups.get(mode) ?? []), label]);
  }
  const parts = [...groups.entries()].map(([mode, labels]) => {
    const who =
      labels.length === 3
        ? 'name, mobile and email'
        : labels.length === 2
          ? `${labels[0]} and ${labels[1]}`
          : labels[0]!;
    return `${who} ${ASK_SHORT[mode]}`;
  });
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The colour's name, when it's one of the swatches; otherwise the colour itself. */
export function chatColourName(hex: string, brandColor: string | null): string {
  const v = hex.toLowerCase();
  if (brandColor && v === brandColor.toLowerCase()) return CHAT_SETUP_WORDS.look.yourColour;
  return CHAT_SETUP_WORDS.look.colourNames[v] ?? v;
}

/** One line a question, for the list beside the questions, Check it over and Settings → Website chat. */
export function chatSetupLines(
  a: ChatSetupAnswers,
  ctx: Pick<ChatSetupContext, 'teammate' | 'brandColor' | 'hasLogo'>,
): ChatSetupLine[] {
  const W = CHAT_SETUP_WORDS.lines;
  const sites = a.sites.map((s) => s.trim()).filter(Boolean);
  const shown = sites.map((s) => {
    const r = normalizeChatOrigin(s);
    return r.ok ? chatSiteShown(r.origin) : s;
  });
  const teammate = a.who === 'ai' ? ctx.teammate : null;
  return [
    { key: 'sites', label: W.sites, value: shown.length ? W.sitesValue(shown) : W.noSites },
    { key: 'who', label: W.who, value: teammate ? W.whoAi(teammate.name) : W.whoTeam },
    {
      key: 'away',
      label: W.away,
      value: a.whenAway === 'chat' ? W.awayChat : W.awayForm,
    },
    {
      key: 'ask',
      label: W.ask,
      value: `${chatAskSummary(a)}.${a.smsConsent ? ` ${W.textsBox}` : ''}`,
    },
    {
      key: 'look',
      label: W.look,
      value: W.lookValue(
        chatColourName(a.accentColor, ctx.brandColor),
        a.launcherLabel.trim() || CHAT_SETUP_WORDS.look.labelDefault,
        a.showLogo && ctx.hasLogo,
      ),
    },
    {
      key: 'place',
      label: W.place,
      value: W.placeValue(a.position, a.desktopButton, a.phone, a.mobileButton),
    },
  ];
}

/** The chips on Done: the site, who answers, after hours, and the phone. */
export function chatDoneChips(
  a: ChatSetupAnswers,
  ctx: Pick<ChatSetupContext, 'teammate'>,
): string[] {
  const C = CHAT_SETUP_WORDS.done.chips;
  const first = a.sites.map((s) => normalizeChatOrigin(s)).find((r) => r.ok);
  return [
    ...(first && first.ok ? [chatSiteShown(first.origin)] : []),
    a.who === 'ai' && ctx.teammate ? C.ai(ctx.teammate.name) : C.team,
    a.whenAway === 'chat' ? C.awayChat : C.awayForm,
    a.phone === 'hidden' ? C.phoneHidden : a.phone === 'lift' ? C.phoneLift : C.phoneSame,
  ];
}

// ---------- words ----------

const ASK_CHOICES: readonly { readonly value: ChatAskMode; readonly label: string }[] = [
  { value: 'never', label: 'Don’t ask' },
  { value: 'when_needed', label: 'When needed' },
  { value: 'after_first_message', label: 'After their first message' },
  { value: 'before_chat', label: 'Before the chat starts' },
];

/** Everything the website chat setup says, on the web and the phone. */
export const CHAT_SETUP_WORDS = {
  pageTitle: 'Set up website chat',
  settingUp: (business: string) => `Setting up website chat for ${business}`,
  soFar: 'Your website chat so far',
  startedFrom:
    'Started from your sign-up: your website, your colour and your logo. Change anything.',
  notAllowed: 'Only an owner or admin can set up website chat.',
  notAllowedHint: 'Ask an owner of this business to set it up, or to give you that permission.',
  sites: {
    title: 'Which website should show the chat?',
    hint: 'The chat only opens on the sites you list here. Anywhere else, browsers refuse to show it.',
    label: 'Your sites',
    fromSignUp: 'From your sign-up',
    twin: (site: string) => `${site} is added for you`,
    addLabel: 'Another site, like a Spanish one or a second business',
    addPlaceholder: 'Like acmeroofing.es',
    add: 'Add',
    remove: (site: string) => `Remove ${site}`,
    adds: (site: string, twin: string | null) =>
      twin ? `Adds ${site} and ${twin}.` : `Adds ${site}.`,
    already: 'That site is already on the list.',
    limit: `Up to ${MAX_CHAT_ORIGINS} sites, all on https. To try it on your own computer, use http://localhost with its port.`,
    noWebsite:
      'No website yet? You can stop here and come back later. Your booking page and forms work without one.',
  },
  who: {
    title: 'Who should answer chats?',
    hint: 'Every chat lands in your inbox either way, and your team can always jump in.',
    ai: (name: string) => `${name}, your AI teammate`,
    aiHint: (name: string) =>
      `Answers in seconds, day and night. ${name} answers from what it knows about your business, books visits, and hands the chat to your team when it needs a person.`,
    aiBest: 'Answers right away',
    turnOn: (name: string) =>
      `${name}’s Website chat is off right now. Picking ${name} here turns it on.`,
    move: (name: string) =>
      `${name} answers another of your website chats now. Picking ${name} here moves it to this one.`,
    off: (name: string) =>
      `${name} is off right now, so your team answers until you turn ${name} on from the AI teammate page.`,
    team: 'Only your team',
    teamHint:
      'Chats wait in the inbox until someone replies. Everyone who looks after the inbox gets a notification for each new chat.',
    noTeammate: 'No AI teammate yet?',
    noTeammateHint:
      'Set one up in about 2 minutes, then come back here. Your answers are saved, so you pick up on this question.',
    setUpTeammate: 'Set up an AI teammate',
  },
  away: {
    title: 'What should happen when nobody is answering?',
    hintAi: (name: string) =>
      `That’s when ${name} is off and your business is closed by its open hours (Settings → Workspace).`,
    hintTeam:
      'That’s whenever your business is closed by its open hours (Settings → Workspace), because only your team answers.',
    chat: 'Let them chat anyway',
    chatHint:
      'The chat works as usual and says you’ll reply as soon as you can. Their message waits in your inbox.',
    form: 'Show a short form instead',
    formHint: 'They leave their name, number and message on a form before anything else.',
    messageLabel: 'What the chat says then',
    chatPlaceholder:
      'Nobody’s here right now. Leave a message and we’ll get back to you as soon as we can.',
    formPlaceholder:
      'We’re not answering chats right now. Leave your details and we’ll get back to you.',
    chatMessageHint: 'The first thing visitors read then. They can write straight away.',
    formMessageHint: 'Shown with a short form for their details and message.',
  },
  ask: {
    title: 'What should the chat ask visitors for?',
    hint: 'Their name, mobile and email go on their contact, so you can call or text them back.',
    rows: [
      { key: 'askName', label: 'Name' },
      { key: 'askPhone', label: 'Mobile' },
      { key: 'askEmail', label: 'Email' },
    ] as const,
    choices: ASK_CHOICES,
    askLabel: (what: string) => `When to ask for their ${what.toLowerCase()}`,
    explainAi: (name: string) =>
      `“When needed” means ${name} asks only when it has to, like before booking a visit. “After their first message” shows a short form then, with the box to get texts.`,
    explainTeam:
      '“When needed” and “After their first message” both ask after the visitor’s first message, so your team can get back to them.',
    textsBox: 'Offer a box to get texts',
    textsWords: 'Text me about my request. Msg & data rates may apply. Reply STOP to opt out.',
    textsHint:
      'The same words as your booking page. It’s how texting approval collects agreement, and ticking it never undoes a STOP.',
  },
  look: {
    title: 'How should the chat look?',
    hint: 'It starts in your business colour with your logo, so it matches your booking page and invoices.',
    greeting: 'Greeting',
    greetingHint: 'The first thing visitors read when they open the chat.',
    label: 'Words on the button',
    labelDefault: 'Chat with us',
    colour: 'Colour',
    anyColour: 'Any colour',
    colourHintBrand: (name: string) =>
      `${name} is your business colour, from Settings → Workspace. The words switch between white and dark by themselves, so they’re always easy to read.`,
    colourHint:
      'The words switch between white and dark by themselves, so they’re always easy to read.',
    yourColour: 'Your colour',
    colourNames: {
      '#b42318': 'Red',
      '#2d69d8': 'Blue',
      '#0e7490': 'Teal',
      '#008743': 'Green',
      '#7c3aed': 'Purple',
      '#191d25': 'Black',
    } as Readonly<Record<string, string>>,
    logo: 'Show your logo',
    logoHint: 'At the top of the chat. Off shows your initials.',
    noLogoHint:
      'You haven’t added a logo yet, so the chat shows your initials. Add one in Settings → Workspace.',
    preview: 'What visitors see',
    typeHere: 'Type a message…',
  },
  place: {
    title: 'Where should the chat button sit?',
    hint: 'Pick a spot where it never covers a bar or button on your site.',
    computers: 'On computers',
    phones: 'On phones',
    corner: 'Corner',
    right: 'Bottom right',
    left: 'Bottom left',
    button: 'Button',
    label: 'Words and icon',
    icon: 'Just the icon',
    barQuestion: 'Is there a bar or button along the bottom of your site on phones?',
    same: 'No, use the same corner',
    lift: 'Yes, move the chat up above it',
    hidden: 'Hide the chat button on phones',
    hiddenHint: 'Visitors on phones open the chat from a link to #hfos-chat on your site.',
    lifts: { 60: 'A little', 90: 'Above a bar', 120: 'Higher' } as Readonly<Record<number, string>>,
    ownLift: (px: number) => `As it is now (${px} px)`,
    note: 'Changes show on your site within about 5 minutes.',
  },
  review: {
    title: 'Check it over',
    hintNew: 'Change anything, then turn it on. Next you’ll put it on your website.',
    hintAgain: 'Change anything, then save.',
    next: 'What happens next',
    nextOn: 'Your chat is made with these answers. Nothing shows on your site yet.',
    nextAi: (name: string) => `${name}’s Website chat is turned on for it.`,
    nextCode:
      'You paste one line of code on your site. It takes a minute, or your web person can do it.',
    nextSave: 'Your chat changes the moment you save. Your site shows it within about 5 minutes.',
    turnOn: 'Turn on website chat',
    save: 'Save my answers',
    saved: 'Website chat saved.',
    notAllowedTeammate: (name: string) =>
      `Saved. Only someone who can change the AI teammate can turn on ${name}’s Website chat, so your team answers for now.`,
  },
  install: {
    on: 'Website chat is on. One last step.',
    title: (site: string) => `Put the chat on ${site}`,
    titleAny: 'Put the chat on your website',
    hint: 'Paste this code once, on every page. It loads after your page, so it never slows it down.',
    code: 'Your code',
    copy: 'Copy',
    copied: 'Copied',
    copiedToast: 'Code copied. Paste it once on your site.',
    builtWith: 'What is your website built with?',
    webPerson: 'Someone else looks after your website?',
    webPersonHint: 'Email them the code and these steps. Their reply comes back to you.',
    webPersonButton: 'Email your web person',
    tryIt: 'Try it first',
    later: 'I’ll do it later',
    done: 'Done',
    onPhone:
      'Pasting the code is easiest on a computer. Open this on one, or send it to your web person.',
    openOnWeb: 'Open it on the web',
  },
  done: {
    title: 'Your website chat is on',
    titleSeen: 'Your website chat is live',
    hint: 'Every chat lands in your inbox.',
    hintAi: (name: string) =>
      `${name} answers visitors on your site, and every chat lands in your inbox.`,
    change: 'Change any of it in Settings → Website chat.',
    tryIt: 'Try it',
    backToSettings: 'Back to Settings',
    backToSetup: 'Back to Getting started',
    chips: {
      ai: (name: string) => `${name} answers`,
      team: 'Your team answers',
      awayChat: 'Chats anyway after hours',
      awayForm: 'A short form after hours',
      phoneSame: 'Same corner on phones',
      phoneLift: 'Moved up on phones',
      phoneHidden: 'Hidden on phones',
    },
  },
  summary: {
    start: 'Start',
    resume: 'Pick up where you left off',
    setUp: 'Set up website chat',
    setUpHint:
      'Six quick questions: your website, who answers, what it asks and how it looks. Then you paste one line of code on your site.',
    again: 'Go through the questions again',
    answers: 'Your answers',
    allSettings: 'All settings',
    hideAll: 'Hide all settings',
    lead: 'A chat button on your website. Every chat lands in your inbox.',
    under: 'Under All settings',
    allSettingsHint:
      'The daily limit on new chats, the words and top bar colours, how far up the button sits on each device, a new key, your logo, and the chat’s name in Forms. Nothing from before is taken away.',
    on: 'On',
    paused: 'Paused',
    pausedHint:
      'Visitors don’t see the button until you turn it back on. The code stays on your site.',
    onHint: 'Pause it to hide the button from your site. The code stays put.',
    copyCode: 'Copy the code',
    tryIt: 'Try it',
    putOnSite: 'Put it on your site',
  },
  lines: {
    sites: 'Your website',
    sitesValue: (sites: readonly string[]) =>
      sites.length <= 2 ? sites.join(' and ') : `${sites[0]} and ${sites.length - 1} more`,
    noSites: 'No site yet',
    who: 'Who answers',
    whoAi: (name: string) => `${name}, and your team can jump in`,
    whoTeam: 'Only your team',
    away: 'When nobody’s answering',
    awayChat: 'Let them chat anyway',
    awayForm: 'A short form first',
    ask: 'What it asks',
    textsBox: 'Offers the box to get texts.',
    look: 'How it looks',
    lookValue: (colour: string, label: string, logo: boolean) =>
      `${colour}, “${label}”${logo ? ', with your logo' : ''}`,
    place: 'Where the button sits',
    placeValue: (
      position: 'right' | 'left',
      desktop: 'label' | 'icon',
      phone: ChatSetupPhone,
      mobile: 'label' | 'icon',
    ) => {
      const corner = position === 'right' ? 'Bottom right' : 'Bottom left';
      const computers = desktop === 'label' ? `${corner} with words` : `${corner}, just the icon`;
      const phones =
        phone === 'hidden'
          ? 'Hidden on phones.'
          : `${mobile === 'icon' ? 'Just the icon' : 'Words and icon'} on phones${phone === 'lift' ? ', moved up above a bar' : ''}.`;
      return `${computers}. ${phones}`;
    },
  },
  problems: {
    noTeammate: 'You don’t have an AI teammate yet. Set one up first, or pick Only your team.',
    long: 'Keep it under 500 characters.',
    labelEmpty: 'Give the button some words, like Chat with us.',
    labelLong: 'Keep the button’s words under 40 characters.',
    colour: 'Pick a colour like #2d69d8.',
    lift: `Pick how far up, from 1 to ${CHAT_LIFT_LIMIT} pixels.`,
  },
} as const;
