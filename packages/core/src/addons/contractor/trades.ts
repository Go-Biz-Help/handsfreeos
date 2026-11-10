/**
 * Contractor Operations' trades (docs/contractor.md, the owner's decision 1, 2026-11-10): one add-on for every trade,
 * and each business picks the trades it does in its settings. A trade brings its starter lists: in part 1, the
 * phases a new project starts with. Checklists, materials and estimate templates follow in later parts.
 * Browser-safe and pure: both apps, the server and the AI read it.
 */

export const TRADES = [
  'electrical',
  'plumbing',
  'hvac',
  'roofing',
  'remodeling',
  'general',
] as const;
export type Trade = (typeof TRADES)[number];

/** Each trade's name, as the screens and the AI say it. */
export const TRADE_NAMES: Readonly<Record<Trade, string>> = {
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  hvac: 'HVAC',
  roofing: 'Roofing',
  remodeling: 'Remodeling',
  general: 'General contracting',
};

/** Words people use for each, so "electrician" or "remodel" finds the right one. */
export const TRADE_WORDS: Readonly<Record<Trade, readonly string[]>> = {
  electrical: ['electrician', 'electric', 'wiring', 'panel', 'ev charger', 'generator'],
  plumbing: ['plumber', 'drain', 'water heater', 'pipe', 'sewer', 'leak'],
  hvac: ['heating', 'cooling', 'air conditioning', 'ac', 'furnace', 'heat pump'],
  roofing: ['roofer', 'roof', 'shingles', 'gutters', 'storm damage'],
  remodeling: ['remodeler', 'remodel', 'renovation', 'kitchen', 'bathroom', 'addition'],
  general: ['general contractor', 'gc', 'construction', 'builder', 'new build'],
};

/**
 * The phases a new project in each trade starts with. A business changes its own list in the add-on's settings, and
 * each project's phases can be changed on its page.
 */
export const STARTER_PHASES: Readonly<Record<Trade, readonly string[]>> = {
  electrical: [
    'Walkthrough and plan',
    'Permit',
    'Rough-in',
    'Rough-in inspection',
    'Trim-out',
    'Final inspection',
    'Walkthrough with the customer',
  ],
  plumbing: [
    'Walkthrough and plan',
    'Permit',
    'Rough-in',
    'Rough-in inspection',
    'Set fixtures',
    'Final inspection and testing',
    'Walkthrough with the customer',
  ],
  hvac: [
    'Load check and design',
    'Permit',
    'Equipment delivered',
    'Ducts and lines',
    'Set equipment',
    'Start-up and testing',
    'Final inspection',
    'Walkthrough with the customer',
  ],
  roofing: [
    'Inspection and measurements',
    'Permit or insurance approval',
    'Materials delivered',
    'Tear-off',
    'Dry-in',
    'Install the roof',
    'Clean-up',
    'Final inspection',
  ],
  remodeling: [
    'Design and selections',
    'Permit',
    'Demolition',
    'Framing',
    'Rough-ins',
    'Inspections',
    'Insulation and drywall',
    'Finishes',
    'Punch list',
    'Final walkthrough',
  ],
  general: [
    'Pre-construction',
    'Permit',
    'Site work and foundation',
    'Framing',
    'Rough-ins',
    'Inspections',
    'Exterior',
    'Interior finishes',
    'Punch list',
    'Final walkthrough',
  ],
};

/** A project's phases when the business has picked no trade and set no list of its own. */
export const PLAIN_PHASES: readonly string[] = ['Plan', 'Do the work', 'Final walkthrough'];

export const isTrade = (t: unknown): t is Trade =>
  typeof t === 'string' && (TRADES as readonly string[]).includes(t);

/**
 * The phases a new project starts with: the business's own list when it has one, else its job's trade's starters,
 * else its first trade's, else the plain three.
 */
export function phasesForNewProject(
  settings: { readonly trades?: readonly string[]; readonly phases?: readonly string[] },
  trade?: string | null,
): readonly string[] {
  if (settings.phases?.length) return settings.phases;
  if (trade && isTrade(trade)) return STARTER_PHASES[trade];
  const first = settings.trades?.find(isTrade);
  return first ? STARTER_PHASES[first] : PLAIN_PHASES;
}

/** The trade someone means by a word ("electrician", "Roofing", "hvac"), or null. */
export function tradeFromWords(text: string): Trade | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  for (const trade of TRADES) {
    if (trade === t || TRADE_NAMES[trade].toLowerCase() === t) return trade;
    if (TRADE_WORDS[trade].includes(t)) return trade;
  }
  return null;
}
