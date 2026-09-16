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
