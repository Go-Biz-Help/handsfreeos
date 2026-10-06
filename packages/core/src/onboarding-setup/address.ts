/**
 * The business's address, asked once on the business stop (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md
 * §4): it picks the time zone, shown to confirm, and the setup uses it for invoices, the texting registration and
 * the business number search. US addresses only, like the carriers' registration. Browser-safe.
 */
import { z } from 'zod';

/** The time zones a US business picks from, as the screens name them. */
export const US_TIME_ZONES = [
  { id: 'America/New_York', label: 'Eastern', example: 'New York' },
  { id: 'America/Chicago', label: 'Central', example: 'Chicago' },
  { id: 'America/Denver', label: 'Mountain', example: 'Denver' },
  { id: 'America/Phoenix', label: 'Arizona', example: 'Phoenix' },
  { id: 'America/Los_Angeles', label: 'Pacific', example: 'Los Angeles' },
  { id: 'America/Anchorage', label: 'Alaska', example: 'Anchorage' },
  { id: 'Pacific/Honolulu', label: 'Hawaii', example: 'Honolulu' },
] as const;
export type UsTimeZone = (typeof US_TIME_ZONES)[number]['id'];

/** "Central", for "on Central time"; a zone the list doesn't have is named as it is. */
export const usTimeZoneLabel = (id: string): string =>
  US_TIME_ZONES.find((z) => z.id === id)?.label ?? id;

const ET = 'America/New_York';
const CT = 'America/Chicago';
const MT = 'America/Denver';
const PT = 'America/Los_Angeles';

/** Each state, its name, and the time zone most of it keeps. */
export const US_STATES: readonly {
  readonly code: string;
  readonly name: string;
  readonly zone: UsTimeZone;
}[] = [
  { code: 'AL', name: 'Alabama', zone: CT },
  { code: 'AK', name: 'Alaska', zone: 'America/Anchorage' },
  { code: 'AZ', name: 'Arizona', zone: 'America/Phoenix' },
  { code: 'AR', name: 'Arkansas', zone: CT },
  { code: 'CA', name: 'California', zone: PT },
  { code: 'CO', name: 'Colorado', zone: MT },
  { code: 'CT', name: 'Connecticut', zone: ET },
  { code: 'DE', name: 'Delaware', zone: ET },
  { code: 'DC', name: 'District of Columbia', zone: ET },
  { code: 'FL', name: 'Florida', zone: ET },
  { code: 'GA', name: 'Georgia', zone: ET },
  { code: 'HI', name: 'Hawaii', zone: 'Pacific/Honolulu' },
  { code: 'ID', name: 'Idaho', zone: MT },
  { code: 'IL', name: 'Illinois', zone: CT },
  { code: 'IN', name: 'Indiana', zone: ET },
  { code: 'IA', name: 'Iowa', zone: CT },
  { code: 'KS', name: 'Kansas', zone: CT },
  { code: 'KY', name: 'Kentucky', zone: ET },
  { code: 'LA', name: 'Louisiana', zone: CT },
  { code: 'ME', name: 'Maine', zone: ET },
  { code: 'MD', name: 'Maryland', zone: ET },
  { code: 'MA', name: 'Massachusetts', zone: ET },
  { code: 'MI', name: 'Michigan', zone: ET },
  { code: 'MN', name: 'Minnesota', zone: CT },
  { code: 'MS', name: 'Mississippi', zone: CT },
  { code: 'MO', name: 'Missouri', zone: CT },
  { code: 'MT', name: 'Montana', zone: MT },
  { code: 'NE', name: 'Nebraska', zone: CT },
  { code: 'NV', name: 'Nevada', zone: PT },
  { code: 'NH', name: 'New Hampshire', zone: ET },
  { code: 'NJ', name: 'New Jersey', zone: ET },
  { code: 'NM', name: 'New Mexico', zone: MT },
  { code: 'NY', name: 'New York', zone: ET },
  { code: 'NC', name: 'North Carolina', zone: ET },
  { code: 'ND', name: 'North Dakota', zone: CT },
  { code: 'OH', name: 'Ohio', zone: ET },
  { code: 'OK', name: 'Oklahoma', zone: CT },
  { code: 'OR', name: 'Oregon', zone: PT },
  { code: 'PA', name: 'Pennsylvania', zone: ET },
  { code: 'RI', name: 'Rhode Island', zone: ET },
  { code: 'SC', name: 'South Carolina', zone: ET },
  { code: 'SD', name: 'South Dakota', zone: CT },
  { code: 'TN', name: 'Tennessee', zone: CT },
  { code: 'TX', name: 'Texas', zone: CT },
  { code: 'UT', name: 'Utah', zone: MT },
  { code: 'VT', name: 'Vermont', zone: ET },
  { code: 'VA', name: 'Virginia', zone: ET },
  { code: 'WA', name: 'Washington', zone: PT },
  { code: 'WV', name: 'West Virginia', zone: ET },
  { code: 'WI', name: 'Wisconsin', zone: CT },
  { code: 'WY', name: 'Wyoming', zone: MT },
];

const STATE_BY_CODE = new Map(US_STATES.map((s) => [s.code, s]));

/**
 * The parts of split states that keep another state's time, by the first three digits of the ZIP code: the Florida
 * panhandle, north Idaho, Indiana's corners, western Kentucky, western Nebraska, south-west North Dakota, eastern
 * Oregon, western South Dakota, East Tennessee and El Paso. Close enough to pick from: the screen shows the time
 * zone, and the business changes it there when its corner of the state differs.
 */
const ZIP_ZONES: Readonly<Record<string, readonly (readonly [string, UsTimeZone])[]>> = {
  FL: [
    ['324', CT],
    ['325', CT],
  ],
  ID: [
    ['835', PT],
    ['838', PT],
  ],
  IN: [
    ['463', CT],
    ['464', CT],
    ['476', CT],
    ['477', CT],
  ],
  KY: [
    ['420', CT],
    ['421', CT],
    ['422', CT],
    ['423', CT],
    ['424', CT],
  ],
  NE: [['693', MT]],
  ND: [['586', MT]],
  OR: [['979', MT]],
  SD: [['577', MT]],
  TN: [
    ['373', ET],
    ['374', ET],
    ['376', ET],
    ['377', ET],
    ['378', ET],
    ['379', ET],
  ],
  TX: [
    ['798', MT],
    ['799', MT],
    ['885', MT],
  ],
};

/** A state's name from its two letters ("Texas"), or the letters when the list doesn't have them. */
export const usStateName = (code: string): string =>
  STATE_BY_CODE.get(code.trim().toUpperCase())?.name ?? code;

/** The time zone an address is most likely in, or null for a state the list doesn't have. */
export function timeZoneForAddress(address: {
  readonly state: string;
  readonly postalCode?: string | null;
}): UsTimeZone | null {
  const code = address.state.trim().toUpperCase();
  const state = STATE_BY_CODE.get(code);
  if (!state) return null;
  const zip3 = (address.postalCode ?? '').trim().slice(0, 3);
  return ZIP_ZONES[code]?.find(([prefix]) => prefix === zip3)?.[1] ?? state.zone;
}

/** The address as the business writes it: the street, the city, the state's two letters and the ZIP code. */
export const BusinessAddress = z.object({
  line1: z
    .string()
    .trim()
    .min(3, 'Enter the street address.')
    .max(200, 'Keep it under 200 characters.'),
  /** A suite or unit. */
  line2: z.string().trim().max(100, 'Keep it under 100 characters.').default(''),
  city: z.string().trim().min(2, 'Enter the city.').max(100, 'Keep it under 100 characters.'),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .refine((s) => STATE_BY_CODE.has(s), { error: 'Pick the state.' }),
  postalCode: z
    .string()
    .trim()
    .regex(/^[0-9]{5}(-[0-9]{4})?$/, 'Use the 5-digit ZIP code.'),
  country: z.literal('US').default('US'),
});
export type BusinessAddress = z.infer<typeof BusinessAddress>;
export type BusinessAddressInput = z.input<typeof BusinessAddress>;

/** Where the address is kept: `workspaces.settings.address`, for invoices, texting and the number search. */
export const BUSINESS_ADDRESS_KEY = 'address';

/** The business's address from its settings, or null when it hasn't given one (or it no longer reads). */
export function businessAddressOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): BusinessAddress | null {
  const r = BusinessAddress.safeParse(settings?.[BUSINESS_ADDRESS_KEY]);
  return r.success ? r.data : null;
}

/** The address as it heads an estimate or an invoice: "12 Oak St\nSuite 4\nAustin, TX 78701". */
export function addressLines(a: BusinessAddress): string {
  return [a.line1, a.line2, `${a.city}, ${a.state} ${a.postalCode}`].filter(Boolean).join('\n');
}

/** "Austin, Texas", for the summary. */
export const cityAndState = (a: Pick<BusinessAddress, 'city' | 'state'>): string =>
  `${a.city}, ${usStateName(a.state)}`;
