/**
 * What the kind of business picks in the onboarding setup (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md
 * §3), on top of what it picks in the AI part (`ai-setup/kinds.ts`): whether customers book a time, so the goal and
 * the booking stop start from it, and what the business calls what it sells. And the big buttons the kind of business
 * is picked from. Browser-safe.
 */
import { setupFor, setupKindOf, type SetupKind } from '../ai-setup/kinds';
import { INDUSTRIES, INDUSTRY_GROUP_NAMES, type IndustryGroupName } from '../industries';

export interface OnboardingKindInfo {
  /**
   * Customers book a time with the business: the goal starts at Getting booked, and the booking stop shows. Only
   * the starting pick; anyone can change it on "About your business".
   */
  readonly booksTime: boolean;
  /** What it calls what it sells, as the services list's heading: "Services", "Classes and sessions", "Menu". */
  readonly services: string;
}

export const ONBOARDING_KIND_INFO: Readonly<Record<SetupKind, OnboardingKindInfo>> = {
  home: { booksTime: false, services: 'Services' },
  salon: { booksTime: true, services: 'Services' },
  fitness: { booksTime: true, services: 'Classes and sessions' },
  health: { booksTime: true, services: 'Services' },
  pets: { booksTime: true, services: 'Services' },
  auto: { booksTime: true, services: 'Services' },
  lessons: { booksTime: true, services: 'Lessons and programs' },
  legal_money: { booksTime: true, services: 'Services' },
  professional: { booksTime: true, services: 'Services' },
  property: { booksTime: true, services: 'Properties' },
  real_estate: { booksTime: false, services: 'How you help' },
  insurance: { booksTime: false, services: 'Kinds of insurance' },
  events: { booksTime: false, services: 'Packages' },
  food: { booksTime: false, services: 'Menu' },
  stays: { booksTime: false, services: 'Rooms and trips' },
  rentals: { booksTime: false, services: 'What you rent' },
  retail: { booksTime: false, services: 'Products' },
  community: { booksTime: false, services: 'Programs' },
  other: { booksTime: false, services: 'Services' },
};

/** What the onboarding setup picks for one industry, with the booking calendar's name from the AI part. */
export function onboardingKindFor(industry: string | null | undefined): OnboardingKindInfo & {
  readonly kind: SetupKind;
  /** The booking calendar's name: "Service calls", "Lessons", "Tours" for childcare. */
  readonly calendar: string;
} {
  const kind = setupKindOf(industry);
  return { kind, ...ONBOARDING_KIND_INFO[kind], calendar: setupFor(industry).calendar };
}

/**
 * The big buttons on "Your business", each a group or more of the business list (`INDUSTRY_GROUP_NAMES`). Tapping
 * one shows the exact kinds in it; the search finds any of them.
 */
export const ONBOARDING_PICKER = [
  { key: 'home', label: 'Home services & trades', groups: ['Home services & trades'] },
  { key: 'beauty', label: 'Beauty & fitness', groups: ['Beauty & fitness'] },
  { key: 'health', label: 'Health & care', groups: ['Health & care'] },
  { key: 'property', label: 'Real estate & property', groups: ['Real estate & property'] },
  {
    key: 'money',
    label: 'Finance, legal & insurance',
    groups: ['Finance, legal & insurance'],
  },
  {
    key: 'events',
    label: 'Events, food & hospitality',
    groups: ['Events, food & hospitality'],
  },
  { key: 'professional', label: 'Professional services', groups: ['Professional services'] },
  {
    key: 'else',
    label: 'Something else',
    groups: [
      'Pets',
      'Auto & vehicles',
      'Education & childcare',
      'Rentals & equipment',
      'Retail',
      'Community',
      'Something else',
    ],
  },
] as const satisfies readonly {
  readonly key: string;
  readonly label: string;
  readonly groups: readonly IndustryGroupName[];
}[];
export type OnboardingPickerKey = (typeof ONBOARDING_PICKER)[number]['key'];

/** The kinds of business behind a big button, in the business list's order, with their group to head them. */
export function industriesForPicker(
  key: OnboardingPickerKey,
): { readonly id: string; readonly label: string; readonly group: IndustryGroupName }[] {
  const button = ONBOARDING_PICKER.find((b) => b.key === key);
  if (!button) return [];
  const groups: readonly IndustryGroupName[] = button.groups;
  return INDUSTRY_GROUP_NAMES.filter((g) => groups.includes(g)).flatMap((g) =>
    INDUSTRIES.filter((i) => i.group === g).map((i) => ({
      id: i.id,
      label: i.label,
      group: i.group,
    })),
  );
}

/** The big button an industry sits under, so "Your business" opens on it; null for none picked yet. */
export function pickerKeyOf(industry: string | null | undefined): OnboardingPickerKey | null {
  const group = INDUSTRIES.find((i) => i.id === industry)?.group;
  if (!group) return null;
  return (
    ONBOARDING_PICKER.find((b) => (b.groups as readonly IndustryGroupName[]).includes(group))
      ?.key ?? null
  );
}
