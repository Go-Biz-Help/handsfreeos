/**
 * The demo link (docs/outreach.md, decision 24): a playbook's link to the business's booking page, with a `ref` that
 * says who sent it to whom. Someone who books through it is counted as a demo by itself: core keeps the `ref` on the
 * booking (`app.appointment_attendees.ref`), and Social Outreach hears of the booking (`appointment.booked`) and reads
 * it back (`readDemoRef`). The person can also mark a demo booked some other way (`outreach.demo.mark`). Each counts
 * once per person reached, for the results card (./openers.ts) and the person's numbers. Browser-safe.
 *
 * The `ref` holds the two ids it names, packed short, and nothing else: no name, and nothing a visitor could use. A
 * made-up one names nobody here and is passed over.
 */
import { z } from 'zod';
import { LINK_REF } from '../../schemas/calendar';
import { PLATFORM_KEYS } from './playbooks';
import { PersonName, ProfileRef } from './saves';

/** What a demo link's `ref` starts with, so another add-on's or a campaign's is left alone. */
export const DEMO_REF_PREFIX = 'so-';
/** The query parameter booking pages pass on to the booking. */
export const BOOKING_REF_PARAM = 'ref';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID's 16 bytes in 22 link-safe characters. */
function packUuid(id: string): string {
  const hex = id.replace(/-/g, '');
  let bits = '';
  for (const c of hex) bits += parseInt(c, 16).toString(2).padStart(4, '0');
  bits = bits.padEnd(132, '0');
  let out = '';
  for (let i = 0; i < 132; i += 6) out += B64[parseInt(bits.slice(i, i + 6), 2)];
  return out;
}

function unpackUuid(packed: string): string | null {
  if (packed.length !== 22) return null;
  let bits = '';
  for (const c of packed) {
    const v = B64.indexOf(c);
    if (v < 0) return null;
    bits += v.toString(2).padStart(6, '0');
  }
  if (/1/.test(bits.slice(128))) return null;
  let hex = '';
  for (let i = 0; i < 128; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return HEX_UUID.test(id) ? id : null;
}

/** The `ref` of the person's demo link for someone they reached: 47 characters. */
export function demoRef(userId: string, profileId: string): string {
  return `${DEMO_REF_PREFIX}${packUuid(profileId)}${packUuid(userId)}`;
}

/** Who a booking's `ref` says sent the link to whom; null for any other `ref`. */
export function readDemoRef(
  ref: string | null | undefined,
): { userId: string; profileId: string } | null {
  if (!ref?.startsWith(DEMO_REF_PREFIX)) return null;
  const packed = ref.slice(DEMO_REF_PREFIX.length);
  if (packed.length !== 44) return null;
  const profileId = unpackUuid(packed.slice(0, 22));
  const userId = unpackUuid(packed.slice(22));
  return profileId && userId ? { userId, profileId } : null;
}

/**
 * The playbook's link with the `ref` on it, for someone the person reached: null with no link. A booking page of the
 * business's counts the booking by itself; any other page just carries the `ref` along.
 */
export function demoLink(link: string | null | undefined, ref: string): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.searchParams.set(BOOKING_REF_PARAM, ref);
    return url.toString();
  } catch {
    return null;
  }
}

/** How a demo was known: a booking through the demo link, or the person saying so. */
export const DEMO_HOWS = { link: 'Booked through your link', marked: 'Marked by you' } as const;
export type DemoHow = keyof typeof DEMO_HOWS;

/** The person marking a demo booked, or taking the mark off, from a profile in the extension. */
export const DemoMarkInput = z
  .object({
    workspaceId: z.uuid(),
    platform: z.enum(PLATFORM_KEYS).default('facebook'),
    /** The profile kept here (the web's Today), or their profile on Facebook and their name. */
    profileId: z.uuid().optional(),
    profile: ProfileRef.optional(),
    name: PersonName.optional(),
    booked: z.boolean(),
  })
  .refine((i) => i.profileId !== undefined || (i.profile !== undefined && i.name !== undefined), {
    error: 'Say who: the profile kept here, or their profile on Facebook and their name.',
  });
export type DemoMarkInput = z.input<typeof DemoMarkInput>;

export const DemoMarkOutput = z.object({
  profileId: z.uuid(),
  booked: z.boolean(),
});

/** A booking through someone's demo link (the worker runs it, from `appointment.booked`). */
export const DemoNoteInput = z.object({
  workspaceId: z.uuid(),
  ref: z.string().regex(LINK_REF),
  appointmentId: z.uuid(),
  personId: z.uuid(),
  at: z.iso.datetime(),
});
export type DemoNoteInput = z.input<typeof DemoNoteInput>;

export const DemoNoteOutput = z.object({
  /** False when the `ref` named nobody here, or the booking was counted already. */
  counted: z.boolean(),
});
