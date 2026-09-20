import { z } from 'zod';
import { normalizePhone } from '../crm/phone';
import { isoDateTime, uuid } from './common';

/** A number already in E.164 (provider webhooks, numbers picked from search results). */
export const e164Phone = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{6,14}$/, 'Use the full number, like +17135550100.');

/** A phone typed by a person, required, stored as E.164 (US default). */
export const phoneRequired = z
  .string()
  .trim()
  .min(1, 'Enter a phone number.')
  .max(40)
  .transform((value, ctx) => {
    const e164 = normalizePhone(value);
    if (!e164) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number.' });
      return z.NEVER;
    }
    return e164;
  });

export const phoneNumberType = z.enum(['local', 'toll_free']);
export const phoneNumberStatus = z.enum([
  'provisioning',
  'active',
  'failed',
  'releasing',
  'released',
]);
export const registrationKind = z.enum([
  'toll_free_verification',
  'a2p_customer_profile',
  'a2p_trust_product',
  'a2p_brand',
  'a2p_campaign',
]);
export const registrationStatus = z.enum([
  'draft',
  'submitted',
  'in_review',
  'approved',
  'rejected',
  'failed',
]);
/** What people submit: toll-free verification, or the 10DLC chain (profile, trust product, brand, campaign). */
export const registrationFamily = z.enum(['toll_free_verification', 'a2p_10dlc']);
export type RegistrationFamily = z.infer<typeof registrationFamily>;

const clock = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use HH:MM.');
export const QuietHoursSetting = z.object({ enabled: z.boolean(), start: clock, end: clock });
export const TelephonySettings = z.object({
  quietHours: QuietHoursSetting,
  /** Minutes a customer waits before the one reminder email; 0 turns reminders off. */
  unansweredReminderMinutes: z.number().int().min(0).max(240),
});
export type TelephonySettings = z.infer<typeof TelephonySettings>;
export const DEFAULT_TELEPHONY_SETTINGS: TelephonySettings = {
  quietHours: { enabled: true, start: '20:00', end: '08:00' },
  unansweredReminderMinutes: 10,
};

export const ForwardingPhoneInput = z.object({
  e164: phoneRequired,
  label: z.string().trim().min(1, 'Name this phone.').max(40),
  enabled: z.boolean().default(true),
});
/**
 * What a forwarding phone shows when a customer's call rings it: the customer's number (as always), or the
 * business number, so a phone that silences unknown callers (iOS's call screening) still rings once the business
 * number is a contact. Either way the phone hears who is calling before pressing 1.
 */
export const forwardedCallerId = z.enum(['customer', 'business']);
export type ForwardedCallerId = z.infer<typeof forwardedCallerId>;

export const PhoneRoutingInput = z.object({
  forwarding: z
    .array(ForwardingPhoneInput)
    .max(3, 'Up to three phones can ring with the browsers.'),
  ringSeconds: z.number().int().min(10).max(25),
  voicemailEnabled: z.boolean(),
  voicemailGreeting: z.string().trim().max(500).nullable(),
  /** Left out, the number keeps what it shows now (phone_number.set_caller_id changes it on its own). */
  forwardedCallerId: forwardedCallerId.optional(),
});
export const PhoneRoutingOut = z.object({
  forwarding: z.array(z.object({ e164: z.string(), label: z.string(), enabled: z.boolean() })),
  ringSeconds: z.number().int(),
  voicemailEnabled: z.boolean(),
  voicemailGreeting: z.string().nullable(),
  forwardedCallerId: forwardedCallerId,
});

export const PhoneNumberBuyInput = z.object({
  workspaceId: uuid,
  e164: e164Phone,
  numberType: phoneNumberType,
});
export const PhoneNumberBuyOutput = z.object({ phoneNumberId: uuid });
export const PhoneNumberReleaseInput = z.object({
  workspaceId: uuid,
  phoneNumberId: uuid,
  confirmE164: phoneRequired,
});
export const PhoneNumberReleaseOutput = z.object({ phoneNumberId: uuid });
export const PhoneNumberSetRoutingInput = z.object({
  workspaceId: uuid,
  phoneNumberId: uuid,
  routing: PhoneRoutingInput,
});
export const PhoneNumberSetRoutingOutput = z.object({ phoneNumberId: uuid });
export const PhoneNumberSetCallerIdInput = z.object({
  workspaceId: uuid,
  phoneNumberId: uuid,
  forwardedCallerId: forwardedCallerId,
});
export const PhoneNumberSetCallerIdOutput = z.object({
  phoneNumberId: uuid,
  forwardedCallerId: forwardedCallerId,
});
export const PhoneNumberSetDefaultInput = z.object({ workspaceId: uuid, phoneNumberId: uuid });
export const PhoneNumberSetDefaultOutput = z.object({ phoneNumberId: uuid });
export const PhoneNumberSetLabelInput = z.object({
  workspaceId: uuid,
  phoneNumberId: uuid,
  /** What the team calls it — "Front desk", "Dispatch". Null clears it back to just the number. */
  label: z.string().trim().min(1).max(40).nullable(),
});
export const PhoneNumberSetLabelOutput = z.object({ phoneNumberId: uuid });

export const PhoneUpdateSettingsInput = z.object({
  workspaceId: uuid,
  quietHours: QuietHoursSetting.optional(),
  unansweredReminderMinutes: z.number().int().min(0).max(240).optional(),
});
export const PhoneUpdateSettingsOutput = z.object({ settings: TelephonySettings });

// ---------- worker-only (system actor) ----------
export const PhoneNumberActivateInput = z.object({
  workspaceId: uuid,
  phoneNumberId: uuid,
  providerSid: z.string().trim().min(2).max(64),
  accountId: uuid,
  capabilities: z.record(z.string(), z.boolean()).default({}),
});
export const PhoneNumberFailInput = z.object({
  workspaceId: uuid,
  phoneNumberId: uuid,
  error: z.string().trim().min(1).max(500),
});
export const PhoneNumberMarkReleasedInput = z.object({ workspaceId: uuid, phoneNumberId: uuid });
export const PhoneNumberSystemOutput = z.object({ phoneNumberId: uuid, status: phoneNumberStatus });

// ---------- carrier registration ----------
export const businessType = z.enum([
  'llc',
  'corporation',
  'sole_proprietor',
  'partnership',
  'non_profit',
]);
export const BusinessProfile = z
  .object({
    legalName: z.string().trim().min(2, 'Enter the legal business name.').max(120),
    businessType,
    ein: z
      .string()
      .trim()
      .regex(/^[0-9]{2}-?[0-9]{7}$/, 'Use the 9-digit EIN, like 12-3456789.')
      .nullable()
      .optional(),
    website: z.url({ error: 'Enter the full website address, like https://example.com.' }).max(200),
    address: z.object({
      line1: z.string().trim().min(3, 'Enter the street address.').max(200),
      city: z.string().trim().min(2).max(100),
      state: z.string().trim().length(2, 'Use the two-letter state.').toUpperCase(),
      postalCode: z
        .string()
        .trim()
        .regex(/^[0-9]{5}(-[0-9]{4})?$/, 'Use a 5-digit ZIP code.'),
      country: z.literal('US').default('US'),
    }),
    contact: z.object({
      firstName: z.string().trim().min(1).max(60),
      lastName: z.string().trim().min(1).max(60),
      email: z.email({ error: 'Enter a valid email address.' }).max(254),
      phone: phoneRequired,
    }),
    useCase: z.enum(['customer_care', 'mixed', 'marketing']),
    messageSamples: z
      .array(z.string().trim().min(20, 'Write a full example text.').max(320))
      .min(1)
      .max(5),
    optInDescription: z
      .string()
      .trim()
      .min(40, 'Explain how customers agree to get texts.')
      .max(1000),
    monthlyVolume: z.enum(['under_1000', '1000_10000', '10000_100000', 'over_100000']),
  })
  .refine((b) => b.businessType === 'sole_proprietor' || !!b.ein, {
    path: ['ein'],
    error: 'Enter the EIN.',
  });
export type BusinessProfile = z.infer<typeof BusinessProfile>;

export const RegistrationSubmitInput = z
  .object({
    workspaceId: uuid,
    kind: registrationFamily,
    business: BusinessProfile,
  })
  // Carriers refuse a 10DLC campaign with fewer than two example texts.
  .refine((v) => v.kind !== 'a2p_10dlc' || v.business.messageSamples.length >= 2, {
    path: ['business', 'messageSamples'],
    error: 'Local numbers need at least two example texts.',
  });
export const RegistrationSubmitOutput = z.object({ registrationIds: z.array(uuid) });
export const RegistrationUpdateStatusInput = z.object({
  workspaceId: uuid,
  registrationId: uuid,
  status: registrationStatus.exclude(['draft']),
  providerSid: z.string().trim().max(64).nullable().optional(),
  providerStatus: z.string().trim().max(64).nullable().optional(),
  rejectionReason: z.string().trim().max(2000).nullable().optional(),
  nextPollAt: isoDateTime.nullable().optional(),
  /** The submitted_at of the details the worker just sent the carrier (the version the carrier now has). */
  carrierSubmittedAt: isoDateTime.nullable().optional(),
});
export const RegistrationUpdateStatusOutput = z.object({
  registrationId: uuid,
  status: registrationStatus,
  changed: z.boolean(),
});

// ---------- setup status ----------
export const phoneNextStep = z.enum([
  'buy_number',
  'provisioning',
  'releasing',
  'submit_registration',
  'awaiting_approval',
  'rejected',
  'ready',
]);
export type PhoneNextStep = z.infer<typeof phoneNextStep>;
export const PhoneNumberOut = z.object({
  id: uuid,
  e164: z.string(),
  display: z.string(),
  numberType: phoneNumberType,
  status: phoneNumberStatus,
  label: z.string().nullable(),
  routing: PhoneRoutingOut,
  purchasedAt: isoDateTime.nullable(),
  lastError: z.string().nullable(),
});
export const RegistrationOut = z.object({
  id: uuid,
  kind: registrationKind,
  status: registrationStatus,
  providerStatus: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  approvedAt: isoDateTime.nullable(),
  submission: z.record(z.string(), z.unknown()),
});
export const QuietState = z.object({
  quiet: z.boolean(),
  localTime: z.string(),
  endsAt: z.string().nullable(),
});
export const PhoneSetupStatusInput = z.object({ workspaceId: uuid });
export const PhoneSetupStatusOutput = z.object({
  number: PhoneNumberOut.nullable(),
  accountStatus: z.string().nullable(),
  registrations: z.array(RegistrationOut),
  messagingReady: z.boolean(),
  voiceReady: z.boolean(),
  nextStep: phoneNextStep,
  settings: TelephonySettings,
  timezone: z.string(),
  quiet: QuietState,
  canManage: z.boolean(),
});
