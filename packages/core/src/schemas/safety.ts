/**
 * Check-ins (round six, 20261022000300): a person's safety when they're alone at a customer's place. Their contacts
 * and check-ins are theirs alone; a teammate who was told reads one check-in, and only while it's theirs to answer.
 */
import { z } from 'zod';
import { email, isoDateTime, uuid } from './common';
import { phoneRequired } from './telephony';

const place = z
  .string()
  .trim()
  .min(1, 'Say where you are: the address, or a few words.')
  .max(300, 'Keep the place to 300 characters.');
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

export const SafetyContactSaveInput = z
  .object({
    workspaceId: uuid,
    /** Changing one already saved. */
    id: uuid.optional(),
    /** A teammate, told in the app. */
    contactUserId: uuid.optional(),
    /** Someone outside: their name, and a phone, an email or both. */
    name: z.string().trim().min(1, 'Enter their name.').max(120).optional(),
    phone: phoneRequired.optional(),
    email: email.optional(),
  })
  .refine((v) => v.contactUserId || (v.name && (v.phone || v.email)), {
    message: 'Pick a teammate, or enter someone’s name with their phone or email.',
    path: ['name'],
  });

export const SafetyContactRemoveInput = z.object({ workspaceId: uuid, id: uuid });

export const SafetyContact = z.object({
  id: uuid,
  contactUserId: uuid.nullable(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** An outside contact who hasn't agreed by text yet gets nothing; one who said STOP gets nothing ever. */
  status: z.enum(['teammate', 'asked', 'agreed', 'stopped']),
});
export const SafetyContactOutput = z.object({ contact: SafetyContact });
export const SafetyContactRemoveOutput = z.object({ id: uuid, removed: z.boolean() });

export const SafetyCheckInInput = z.object({
  workspaceId: uuid,
  /** Made on the phone, so a check-in made with no signal is the same one when it arrives. */
  id: uuid,
  appointmentId: uuid.optional(),
  place,
  plannedEndAt: isoDateTime,
  latitude: latitude.optional(),
  longitude: longitude.optional(),
});

export const SafetyCheckInRef = z.object({ workspaceId: uuid, checkInId: uuid });
export const SafetyExtendInput = SafetyCheckInRef.extend({
  minutes: z.number().int().min(5, 'Add at least 5 minutes.').max(240, 'Add at most 4 hours.'),
});
export const SafetyHelpInput = z.object({
  workspaceId: uuid,
  /** The check-in it's from; left out, a new one starts here and now. */
  checkInId: uuid.optional(),
  place: place.optional(),
  latitude: latitude.optional(),
  longitude: longitude.optional(),
});

export const SafetyCheckIn = z.object({
  id: uuid,
  appointmentId: uuid.nullable(),
  place: z.string(),
  startedAt: isoDateTime,
  plannedEndAt: isoDateTime,
  state: z.enum(['in', 'asked', 'alerted', 'ok', 'out', 'help']),
  extendedCount: z.number().int(),
});
export const SafetyCheckInOutput = z.object({ checkIn: SafetyCheckIn });

export const SafetyMineInput = z.object({ workspaceId: uuid });
export const SafetyMineOutput = z.object({
  contacts: z.array(SafetyContact),
  /** The check-in still open, if any. */
  open: SafetyCheckIn.nullable(),
});

/** What a teammate who was told sees, while it's theirs to answer. */
export const SafetyAlertOutput = z.object({
  alert: z
    .object({
      checkInId: uuid,
      personName: z.string(),
      personPhone: z.string().nullable(),
      place: z.string(),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      locatedAt: isoDateTime.nullable(),
      startedAt: isoDateTime,
      plannedEndAt: isoDateTime,
      state: z.enum(['alerted', 'help']),
    })
    .nullable(),
});
export const SafetyResolveOutput = z.object({ checkInId: uuid, resolved: z.boolean() });

// ---------- the worker's ladder ----------

/** The worker's: a step of a missed check-out's ladder, with who was told in the app, or one outside link. */
export const SafetyEscalateInput = z.object({
  workspaceId: uuid,
  checkInId: uuid,
  /** ask: "Still there?"; alert: the contacts told the first time; repeat: again; link: one text or email's link. */
  step: z.enum(['ask', 'alert', 'repeat', 'link']),
  told: z
    .array(
      z.object({
        contactId: uuid.nullable(),
        userId: uuid.nullable(),
        channel: z.literal('app'),
      }),
    )
    .max(50)
    .default([]),
  link: z
    .object({
      contactId: uuid,
      channel: z.enum(['text', 'email']),
      tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
      round: z.number().int().min(1).max(20),
    })
    .optional(),
});
export const SafetyEscalateOutput = z.object({
  checkInId: uuid,
  state: z.enum(['in', 'asked', 'alerted', 'ok', 'out', 'help']),
  round: z.number().int(),
});

/** The worker's: an outside contact asked by text, or answering it (OK agrees; STOP stops). */
export const SafetyContactRecordInput = z
  .object({
    workspaceId: uuid,
    contactId: uuid.optional(),
    phone: z
      .string()
      .regex(/^\+[1-9][0-9]{6,14}$/)
      .optional(),
    what: z.enum(['asked', 'agreed', 'stopped']),
  })
  .refine((v) => !!v.contactId || !!v.phone, {
    message: 'Say which contact.',
    path: ['contactId'],
  });
export const SafetyContactRecordOutput = z.object({
  contacts: z.number().int(),
  /** Whose contacts they are, for the answer to OK. */
  people: z.array(z.string()),
});

/** A contact's page (`/s/<token>`): they reached the person, who's OK; or they couldn't. */
export const SafetyResolveByLinkInput = z.object({
  workspaceId: uuid,
  escalationId: uuid,
  how: z.enum(['ok', 'unreached']),
});
export const SafetyResolveByLinkOutput = z.object({
  checkInId: uuid,
  resolved: z.boolean(),
});

/** Settings → Safety: the business's times and its safety person. */
export const SafetySettingsInput = z.object({
  workspaceId: uuid,
  askAfterMinutes: z
    .number()
    .int()
    .min(0, 'Pick 0 minutes or more.')
    .max(60, 'Pick an hour at most.'),
  alertAfterMinutes: z
    .number()
    .int()
    .min(1, 'Pick at least a minute.')
    .max(60, 'Pick an hour at most.'),
  /** Told when someone has no contacts; left out, the owners and admins are. */
  safetyUserId: uuid.nullable(),
});
export const SafetySettingsOutput = z.object({
  askAfterMinutes: z.number().int(),
  alertAfterMinutes: z.number().int(),
  safetyUserId: uuid.nullable(),
});
export const SafetySettingsGetInput = z.object({ workspaceId: uuid });
export const SafetySettingsView = SafetySettingsOutput.extend({
  /** The safety person's name, when one is named. */
  safetyPersonName: z.string().nullable(),
});
