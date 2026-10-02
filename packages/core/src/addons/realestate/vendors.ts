/**
 * The vendors directory (round five, step 9), in words: the business's own list of the people its deals use, each
 * with their services, areas, approval and any disclosure. Browser-safe and pure: the directory, the duty drawer,
 * the phone and the Assistant say the same thing.
 *
 * The client is offered every approved vendor that fits, not only one, and each disclosure is said where it's shown.
 */

export const VENDOR_SERVICES = {
  inspection: 'Home inspection',
  hvac: 'HVAC',
  repairs: 'Repairs',
  photos: 'Photos and video',
  staging: 'Staging',
  lender: 'Lender',
  title: 'Title and escrow',
  insurance: 'Insurance',
  other: 'Other',
} as const;
export type VendorService = keyof typeof VENDOR_SERVICES;
export const VENDOR_SERVICE_KEYS = Object.keys(VENDOR_SERVICES) as [
  VendorService,
  ...VendorService[],
];

/** "HVAC, repairs" */
export const servicesWords = (services: readonly VendorService[]) =>
  services
    .map((s, i) => (i === 0 ? VENDOR_SERVICES[s] : VENDOR_SERVICES[s].toLowerCase()))
    .join(', ');

/** What a duty most likely needs, from its title; null when the agent should say. */
export function serviceForDuty(title: string): VendorService | null {
  const t = title.toLowerCase();
  if (/\binspect/.test(t)) return 'inspection';
  if (/\bhvac\b|heating|air condition/.test(t)) return 'hvac';
  if (/\brepair|contractor|fix/.test(t)) return 'repairs';
  if (/\bphoto|video|floor plan|media/.test(t)) return 'photos';
  if (/\bstag(e|ing)\b/.test(t)) return 'staging';
  if (/\blender|loan|preapprov|mortgage|financing/.test(t)) return 'lender';
  if (/\btitle|escrow|closing agent/.test(t)) return 'title';
  if (/\binsurance|binder/.test(t)) return 'insurance';
  return null;
}

/**
 * Whether a vendor works where the home is: one of their areas is in its address ("Austin" in "2207 Juniper Trail,
 * Austin, TX"), or names its state. Words like "metro" or "area" don't count against them.
 */
export function inArea(areas: readonly string[], address: string | null): boolean | null {
  if (!address || !areas.length) return null;
  const where = ` ${address.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const STATES: Readonly<Record<string, string>> = { texas: 'tx', california: 'ca', florida: 'fl' };
  return areas.some((a) => {
    const name = a
      .toLowerCase()
      .replace(/\b(metro|area|county|region|greater)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (!name) return false;
    if (where.includes(` ${name} `)) return true;
    const code = STATES[name];
    return !!code && where.includes(` ${code} `);
  });
}

/** What the client is told about a vendor besides their name: the disclosure, plainly. */
export const disclosureWords = (disclosure: string | null) =>
  disclosure ? `Disclosure: ${disclosure}` : 'No disclosure';
