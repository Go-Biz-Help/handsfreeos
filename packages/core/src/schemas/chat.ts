/**
 * Website chat (M7): the widget a business puts on its site, the visitors who chat in it, and what the
 * worker's chat routes and Settings → Website chat send and get back.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { optionalEmail, phoneInput } from './crm';

// ---------- asking visitors for their details ----------

/** When the chat window asks for a detail: never, only once it's needed (to book, to follow up), or first. */
export const chatAskMode = z.enum(['never', 'when_needed', 'before_chat']);
export type ChatAskMode = z.infer<typeof chatAskMode>;
export const ChatAskFor = z.object({
  name: chatAskMode.default('when_needed'),
  phone: chatAskMode.default('when_needed'),
  email: chatAskMode.default('when_needed'),
});
export type ChatAskFor = z.infer<typeof ChatAskFor>;
/** Part of it, for an update: the rest stays as it was. */
export const ChatAskForPatch = z.object({
  name: chatAskMode.optional(),
  phone: chatAskMode.optional(),
  email: chatAskMode.optional(),
});

/** A widget's stored ask_for with every default filled in. Anything unreadable counts as the defaults. */
export function chatAskForOf(raw: unknown): ChatAskFor {
  const parsed = ChatAskFor.safeParse(raw ?? {});
  return parsed.success ? parsed.data : ChatAskFor.parse({});
}

// ---------- widgets (channels.manage) ----------

export const chatWidgetPosition = z.enum(['right', 'left']);
/** Blank clears it. */
const optionalMessage = z
  .string()
  .trim()
  .max(500, 'Keep it under 500 characters.')
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v));
const widgetFields = {
  /** The AI teammate that answers; null: only people do. It must be the business's own. */
  teammateId: uuid.nullable().optional(),
  greeting: optionalMessage,
  launcherLabel: z
    .string()
    .trim()
    .min(1, 'Give the button a label.')
    .max(40, 'Keep the label under 40 characters.')
    .optional(),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour like #2d69d8.')
    .optional(),
  position: chatWidgetPosition.optional(),
  /** Shown when nobody is answering. */
  awayMessage: optionalMessage,
  /** Show the SMS consent box (the booking page's wording) when a visitor gives a phone number. */
  smsConsent: z.boolean().optional(),
  /** The most new chats it takes a day. */
  dailyCap: z.number().int().min(1).max(10_000).optional(),
};
/** The sites as people typed them (a bare domain, a URL, upper case); saved as exact origins with www twins. */
const typedOrigins = z.array(z.string().max(300)).max(20);

export const ChatWidgetCreateInput = z.object({
  workspaceId: uuid,
  allowedOrigins: typedOrigins.min(1, 'Add the website the chat goes on.'),
  ...widgetFields,
  askFor: ChatAskFor.optional(),
});
export const ChatWidgetCreateOutput = z.object({
  widgetId: uuid,
  publicKey: z.string(),
  allowedOrigins: z.array(z.string()),
});
export const ChatWidgetUpdateInput = z.object({
  workspaceId: uuid,
  widgetId: uuid,
  allowedOrigins: typedOrigins.optional(),
  ...widgetFields,
  askFor: ChatAskForPatch.optional(),
});
export const ChatWidgetUpdateOutput = z.object({
  widgetId: uuid,
  /** The fields that changed. */
  updated: z.array(z.string()),
  allowedOrigins: z.array(z.string()),
});
export const ChatWidgetRefInput = z.object({ workspaceId: uuid, widgetId: uuid });
export const ChatWidgetPauseOutput = z.object({ widgetId: uuid, paused: z.boolean() });
export const ChatWidgetRotateKeyOutput = z.object({ widgetId: uuid, publicKey: z.string() });

/** Worker: the chat window loaded on a site (the install check). */
export const ChatWidgetRecordSeenInput = z.object({
  workspaceId: uuid,
  widgetId: uuid,
  origin: z.string().trim().min(1).max(300),
});
export const ChatWidgetRecordSeenOutput = z.object({
  widgetId: uuid,
  /** False when the site isn't one of the widget's, or it was recorded under a minute ago. */
  recorded: z.boolean(),
});

export const ChatWidgetOut = z.object({
  id: uuid,
  /** The first site it shows on ("lonestarhvac.com"). */
  name: z.string(),
  /** Goes in the snippet: <script async src="…/embed/v1/<publicKey>.js">. Not a secret. */
  publicKey: z.string(),
  allowedOrigins: z.array(z.string()),
  teammate: z
    .object({ id: uuid, name: z.string(), status: z.enum(['off', 'training', 'automatic']) })
    .nullable(),
  greeting: z.string().nullable(),
  launcherLabel: z.string(),
  accentColor: z.string(),
  /** The text colour on the accent: white or near-black, whichever reads better. */
  textColor: z.string(),
  position: chatWidgetPosition,
  awayMessage: z.string().nullable(),
  askFor: ChatAskFor,
  smsConsent: z.boolean(),
  dailyCap: z.number().int(),
  paused: z.boolean(),
  pausedAt: isoDateTime.nullable(),
  /** The install check: "Seen on acme.com 3 min ago". */
  install: z.object({
    seen: z.boolean(),
    lastSeenOrigin: z.string().nullable(),
    lastSeenAt: isoDateTime.nullable(),
  }),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type ChatWidgetOut = z.infer<typeof ChatWidgetOut>;
export const ChatWidgetListInput = z.object({ workspaceId: uuid });
export const ChatWidgetListOutput = z.object({
  items: z.array(ChatWidgetOut),
  /** Whether the reader may change widgets (channels.manage). */
  canManage: z.boolean(),
});
export const ChatWidgetGetOutput = z.object({ widget: ChatWidgetOut, canManage: z.boolean() });

// ---------- visitors (the worker, for the chat window) ----------

/** A hash the worker made (16 to 64 bytes, in hex). Core never sees a raw token or IP address. */
export const chatHashHex = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[0-9a-f]{2}){16,64}$/, 'Send a hash of 16 to 64 bytes, in hex.');
/** The page on the business's site, like /services/ac-repair. */
export const chatPagePath = z.string().trim().max(2000).regex(/^\//, 'A page path starts with /.');

export const ChatVisitorStartInput = z.object({
  workspaceId: uuid,
  widgetId: uuid,
  /** The hash of the new visitor's token. */
  tokenHash: chatHashHex,
  /** A keyed hash of their IP, for limits and network blocks. */
  ipHmac: chatHashHex.optional(),
  pagePath: chatPagePath.optional(),
});
export const ChatVisitorStartOutput = z.object({
  visitorId: uuid,
  /** Their network is blocked here: the chat window can say so now. */
  blocked: z.boolean(),
});
export const ChatVisitorResumeInput = z.object({
  workspaceId: uuid,
  widgetId: uuid,
  tokenHash: chatHashHex,
  ipHmac: chatHashHex.optional(),
  pagePath: chatPagePath.optional(),
});
export const ChatVisitorResumeOutput = z.object({
  visitorId: uuid,
  conversationId: uuid.nullable(),
  /** The token was the previous one, still inside its grace period. */
  viaPreviousToken: z.boolean(),
  tokenIssuedAt: isoDateTime,
  /** The token is a week old: give the chat window a new one (chat_visitor.rotate_token). */
  rotateDue: z.boolean(),
  turnstilePassedAt: isoDateTime.nullable(),
  /** The visitor, or their network, is blocked. */
  blocked: z.boolean(),
  /** Which details they've given, so the window knows what to ask for; never the details themselves. */
  gave: z.object({ name: z.boolean(), phone: z.boolean(), email: z.boolean() }),
});
export const ChatVisitorRotateTokenInput = z.object({
  workspaceId: uuid,
  visitorId: uuid,
  /** The hash of the new token. */
  tokenHash: chatHashHex,
});
export const ChatVisitorRotateTokenOutput = z.object({
  visitorId: uuid,
  /** Until then the previous token still works. */
  previousExpiresAt: isoDateTime,
});
export const ChatVisitorRecordSeenInput = z.object({
  workspaceId: uuid,
  visitorId: uuid,
  pagePath: chatPagePath.optional(),
  /** They just passed the invisible human check. */
  turnstilePassed: z.boolean().default(false),
  ipHmac: chatHashHex.optional(),
});
export const ChatVisitorRecordSeenOutput = z.object({ visitorId: uuid });

// ---------- chatting ----------

export const ChatReceiveInput = z.object({
  workspaceId: uuid,
  visitorId: uuid,
  body: z
    .string()
    .trim()
    .min(1, 'Write a message.')
    .max(1000, 'Keep chat messages under 1,000 characters.'),
  /** Made by the chat window, so a resent message lands once. */
  clientId: z.string().trim().min(1).max(64),
  pagePath: chatPagePath.optional(),
  /** Tests and demos shorten the reply reminder; otherwise the workspace setting decides. */
  reminderAfterMs: z.number().int().min(1000).max(86_400_000).optional(),
});
export const ChatReceiveOutput = z.object({
  messageId: uuid,
  conversationId: uuid,
  duplicate: z.boolean(),
  /** This message started the visitor's chat (it counts toward the daily cap). */
  newChat: z.boolean(),
});

export const ChatIdentifyInput = z.object({
  workspaceId: uuid,
  visitorId: uuid,
  name: z
    .string()
    .trim()
    .max(120, 'Keep the name under 120 characters.')
    .optional()
    .transform((v) => v || undefined),
  phone: phoneInput,
  email: optionalEmail,
  /** They ticked the box to get texts (the booking page's wording). Never overrides a STOP. */
  smsConsent: z.boolean().default(false),
});
/** Ids and flags only: nothing about a matched customer ever goes back to the visitor. */
export const ChatIdentifyOutput = z.object({
  visitorId: uuid,
  personId: uuid.nullable(),
  conversationId: uuid.nullable(),
  personCreated: z.boolean(),
  /** This call linked the visitor (and their chat) to a customer. */
  linkedNow: z.boolean(),
  /** The customer this call created agreed to texts. */
  smsOptedIn: z.boolean(),
});

// ---------- blocking (inbox.use) ----------

export const ChatBlockVisitorInput = z.object({
  workspaceId: uuid,
  visitorId: uuid,
  /** Also block every visitor from the same network, for 7 days. */
  network: z.boolean().default(false),
});
export const ChatBlockVisitorOutput = z.object({
  visitorId: uuid,
  blockedAt: isoDateTime,
  /** Null when only the visitor is blocked (or their network isn't known). */
  networkBlockedUntil: isoDateTime.nullable(),
});
export const ChatVisitorRefInput = z.object({ workspaceId: uuid, visitorId: uuid });
export const ChatUnblockVisitorOutput = z.object({ visitorId: uuid });
