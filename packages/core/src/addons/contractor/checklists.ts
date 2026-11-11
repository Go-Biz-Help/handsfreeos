/**
 * A visit's checklist (docs/contractor.md, "Crews and work orders"): what an item is, the checklist a new work order
 * starts with, how far along one is, and what's left before its job can be marked Done (the owner's decision 8,
 * 2026-11-10). One copy of these rules, which the server keeps and both apps and the AI read. Pure and browser-safe.
 */
import { isTrade, type Trade } from './trades';

/** A box to tick, or a photo to add. */
export const ITEM_KINDS = ['check', 'photo'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** An item a new work order starts with. */
export interface StarterItem {
  readonly label: string;
  readonly kind: ItemKind;
  /** The job can't be marked Done while it's left. */
  readonly required: boolean;
}

const check = (label: string, required = false): StarterItem => ({
  label,
  kind: 'check',
  required,
});
const photo = (label: string, required = false): StarterItem => ({
  label,
  kind: 'photo',
  required,
});

const CLEANED = check('Work area cleaned up');
const WALKED = check('Walked the customer through the work');
const FINISHED = photo('Photo of the finished work', true);

/**
 * The checklist a visit in each trade starts with. A business sets its own in the add-on's settings, and each work
 * order's checklist can be changed on its page.
 */
export const STARTER_CHECKLISTS: Readonly<Record<Trade, readonly StarterItem[]>> = {
  electrical: [
    check('Power off and locked out before work', true),
    check('Circuits tested and working', true),
    check('Panel labeled'),
    FINISHED,
    CLEANED,
    WALKED,
  ],
  plumbing: [
    check('Water shut off before work'),
    check('Tested for leaks under pressure', true),
    check('Drains run and checked'),
    FINISHED,
    CLEANED,
    WALKED,
  ],
  hvac: [
    check('Power and gas off before work', true),
    check('System started and tested', true),
    check('Filter checked or replaced'),
    photo('Photo of the equipment’s data plate'),
    FINISHED,
    CLEANED,
    WALKED,
  ],
  roofing: [
    check('Fall protection set up', true),
    photo('Photo before work starts', true),
    check('Flashing and vents sealed'),
    check('Nails and debris picked up', true),
    photo('Photo of the finished roof', true),
    WALKED,
  ],
  remodeling: [
    check('Floors and furniture protected'),
    photo('Photo before work starts'),
    check('Work matches the plan and selections', true),
    FINISHED,
    CLEANED,
    WALKED,
  ],
  general: [
    check('Site safe and secured', true),
    photo('Photo of progress'),
    check('Work matches the plans', true),
    check('Site cleaned up'),
    WALKED,
  ],
};

/** A visit's checklist when the business has picked no trade and set no list of its own. */
export const PLAIN_CHECKLIST: readonly StarterItem[] = [FINISHED, CLEANED, WALKED];

/**
 * The checklist a new work order starts with: the business's own list when it has one, else its job's trade's
 * starters, else its first trade's, else the plain three.
 */
export function checklistForNewVisit(
  settings: { readonly trades?: readonly string[]; readonly checklist?: readonly StarterItem[] },
  trade?: string | null,
): readonly StarterItem[] {
  if (settings.checklist?.length) return settings.checklist;
  if (trade && isTrade(trade)) return STARTER_CHECKLISTS[trade];
  const first = settings.trades?.find(isTrade);
  return first ? STARTER_CHECKLISTS[first] : PLAIN_CHECKLIST;
}

/** An item as far as these rules care. */
export interface ItemState {
  readonly required: boolean;
  readonly done: boolean;
  /** An owner or admin marked the job done without it. */
  readonly skipped: boolean;
}

export interface ChecklistProgress {
  readonly total: number;
  readonly done: number;
  /** Required items neither done nor passed over: what holds the job's Done. */
  readonly requiredLeft: number;
}

/** A required item holds its job's Done until it's done, or an owner or admin passes it over with a reason. */
export const holdsDone = (i: ItemState) => i.required && !i.done && !i.skipped;

export function checklistProgress(items: readonly ItemState[]): ChecklistProgress {
  return {
    total: items.length,
    done: items.filter((i) => i.done).length,
    requiredLeft: items.filter(holdsDone).length,
  };
}

/** "No checklist" · "3 of 5 done" · "3 of 5 done · 1 required left". */
export function checklistWords(p: ChecklistProgress): string {
  if (!p.total) return 'No checklist';
  const done = `${p.done} of ${p.total} done`;
  return p.requiredLeft ? `${done} · ${p.requiredLeft} required left` : done;
}

/** "1 required item" · "3 required items". */
export const requiredItemsWords = (n: number) => `${n} required ${n === 1 ? 'item' : 'items'}`;
