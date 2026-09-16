import { z } from 'zod';
import { uuid } from './common';
import { phoneRequired } from './telephony';

/**
 * My cell phone (M10): the number "Call" rings first. HandsFreeOS confirms it with a call from one of the person's
 * business numbers ("Press 1"); only the worker marks it verified.
 */
export const UserPhoneStartVerificationInput = z.object({
  /** The business whose number places the verification call. */
  workspaceId: uuid,
  /** The person's own cell. */
  phone: phoneRequired,
});
export const UserPhoneStartVerificationOutput = z.object({
  userPhoneId: uuid,
  e164: z.string(),
  /** calling: the verification call is on its way; verified: this cell already is (nothing rings). */
  status: z.enum(['calling', 'verified']),
  /** The business number the call comes from. */
  callerId: z.string(),
});

/** My cell phone as the person set it: verified, or waiting for them to press 1 (null when there is none). */
export const UserPhoneGetInput = z.object({});
export const UserPhoneGetOutput = z.object({
  phone: z
    .object({
      id: uuid,
      e164: z.string(),
      /** When they pressed 1 on the call; null until they do. */
      verifiedAt: z.iso.datetime().nullable(),
      /** The last verification call HandsFreeOS placed to it. */
      lastVerificationAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});

// ---------- worker-only (system actor) ----------
export const UserPhoneRecordCallInput = z.object({
  workspaceId: uuid,
  userPhoneId: uuid,
});
export const UserPhoneVerifyInput = z.object({
  workspaceId: uuid,
  userPhoneId: uuid,
});
export const UserPhoneRefOutput = z.object({ userPhoneId: uuid, changed: z.boolean() });
