import { z } from 'zod';
import { uuid } from './common';

/** An Expo push token, as 0058's check has it: ExponentPushToken[…] or ExpoPushToken[…]. */
export const expoPushToken = z
  .string()
  .trim()
  .regex(/^Expo(nent)?PushToken\[[^\]\s]{1,200}\]$/, 'Not an Expo push token.');

export const pushPlatform = z.enum(['ios', 'android']);

export const PushDeviceRegisterInput = z.object({
  platform: pushPlatform,
  token: expoPushToken,
  /** The app build ("1.4.2"). */
  appVersion: z.string().trim().min(1).max(40),
  /** What the person calls the phone ("Dale's iPhone"). */
  deviceName: z.string().trim().min(1).max(120).nullable().optional(),
});
export const PushDeviceRegisterOutput = z.object({
  deviceId: uuid,
  /** True the first time this person registers this phone; false when it was refreshed or turned back on. */
  created: z.boolean(),
});

export const PushDeviceRemoveInput = z
  .object({
    /** This phone's own token (signing out, or turning notifications off here). */
    token: expoPushToken.optional(),
    /** One of the person's devices from their list (turning another phone off). */
    deviceId: uuid.optional(),
    reason: z.enum(['signed_out', 'turned_off']).default('signed_out'),
  })
  .refine((v) => (v.token === undefined) !== (v.deviceId === undefined), {
    path: ['token'],
    error: 'Name the phone by its token or by its id.',
  });
export const PushDeviceRemoveOutput = z.object({
  /** The device turned off, or null when there was nothing on to turn off. */
  deviceId: uuid.nullable(),
  changed: z.boolean(),
});

/** The phones a person gets notifications on (M10): each live install of the app they're signed in on. */
export const PushDeviceListInput = z.object({});
export const PushDeviceListOutput = z.object({
  devices: z.array(
    z.object({
      id: uuid,
      platform: pushPlatform,
      deviceName: z.string().nullable(),
      appVersion: z.string(),
      lastSeenAt: z.iso.datetime(),
    }),
  ),
});

// ---------- notifications under the bell (20261027012600) ----------

/** One push kept under a person's bell: its words, its business and the screen it opens, as the push. */
export const BellNotification = z.object({
  id: uuid,
  /** The business it's about; null for one about none (a new support ticket, a sign-in to the extension). */
  workspaceId: uuid.nullable(),
  /** The push's category (PUSH_CATEGORIES). */
  category: z.string(),
  title: z.string(),
  /** The business's name, after the channel for a customer's message ("Text · Lone Star HVAC & Roofing"). */
  subtitle: z.string().nullable(),
  body: z.string(),
  /** Where pressing it goes: the web path its push opens. */
  path: z.string(),
  sentAt: z.iso.datetime(),
  /** When the bell was opened with it in the list; null while it's new. */
  seenAt: z.iso.datetime().nullable(),
  /** When it was pressed, in the bell or as the push itself; null while it's unread. */
  readAt: z.iso.datetime().nullable(),
});
export type BellNotification = z.infer<typeof BellNotification>;

export const NotificationListInput = z.object({
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().max(400).optional(),
});
export const NotificationListOutput = z.object({
  /** Newest first, from every business the person is in. */
  notifications: z.array(BellNotification),
  /** How many aren't seen yet: what the bell counts. */
  unseen: z.number().int().min(0),
  nextCursor: z.string().nullable(),
});

export const NotificationSeenInput = z.object({
  /**
   * The newest one the bell showed (its `sentAt`): anything that came in after it stays new. Left out, every one
   * kept so far.
   */
  upTo: z.iso.datetime().optional(),
});
export const NotificationSeenOutput = z.object({
  /** How many were new until now. */
  seen: z.number().int().min(0),
});

export const NotificationReadInput = z
  .object({
    /** Ones pressed in the bell. */
    ids: z.array(uuid).max(100).optional(),
    /** Pushes pressed on the phone (their `notificationId`): the notifications they're kept as. */
    pushIds: z.array(uuid).max(100).optional(),
  })
  .refine((v) => (v.ids?.length ?? 0) + (v.pushIds?.length ?? 0) > 0, {
    path: ['ids'],
    error: 'Name the notifications that were opened.',
  });
export const NotificationReadOutput = z.object({
  /** How many were unread until now. */
  read: z.number().int().min(0),
});
