/**
 * The kinds Search everything looks in, and who may look in each (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Who can
 * see what"). This is the only place a kind's gate is written: the server skips a kind the person may not search,
 * and both apps draw the chips and the Search page's kinds list from it, in its order. Row security still decides
 * every row; the gate closes the gaps it leaves.
 *
 * A new kind adds its entry here, its searcher in `search/server/kinds`, and a case to `test/search/gaps.test.ts`.
 */
import type { AddonManifest } from '../addons/manifest';
import type { WorkspacePermission } from '../permissions';
import { addonSearchKinds, type AddonSearchKind } from './addon';
import { SEARCH_KIND_LABELS } from './words';

export interface SearchKind {
  /** The searcher's key. `records` answers a group per kind of record (`record.<key>`). */
  readonly key: string;
  /** The heading, chip and kinds-list line; null for `records`, whose groups carry the record kind's own. */
  readonly label: string | null;
  /** What the person needs to search it. */
  readonly needs: WorkspacePermission;
  /** The phone searches its own copy of it with no signal. */
  readonly offline: boolean;
  /** Long text matched in a window of the newest rows, rather than the whole business. */
  readonly windowed: boolean;
  /** Worked out on the server, or on the device from core's catalogue (Settings). */
  readonly where: 'server' | 'device';
  /** Shown as a chip and in the Search page's kinds list. Close matches stand in for the others when nothing matched. */
  readonly chip: boolean;
  /** Searched only when asked for by name: Spam, through the Messages page's Look in Spam (decision 9). */
  readonly picked: boolean;
}

const kind = (
  key: keyof typeof SEARCH_KIND_LABELS | 'records',
  needs: WorkspacePermission,
  more: Partial<Pick<SearchKind, 'offline' | 'windowed' | 'where' | 'chip' | 'picked'>> = {},
): SearchKind => ({
  key,
  label: key === 'records' ? null : SEARCH_KIND_LABELS[key],
  needs,
  offline: more.offline ?? false,
  windowed: more.windowed ?? false,
  where: more.where ?? 'server',
  chip: more.chip ?? true,
  picked: more.picked ?? false,
});

/** Every kind, in kind order: the chips', the groups' after the best tiers (decision 33), and the kinds list's. */
export const SEARCH_KINDS: readonly SearchKind[] = [
  kind('contacts', 'records.read', { offline: true }),
  kind('companies', 'records.read', { offline: true }),
  kind('leads', 'records.read', { offline: true }),
  kind('money', 'money.read'),
  // Row security never asks for Use the inbox on threads, messages or calls (gap 1): this gate does.
  kind('messages', 'inbox.use', { windowed: true }),
  kind('calendar', 'workspace.read', { offline: true }),
  kind('tasks', 'records.read', { offline: true }),
  kind('notes', 'records.read', { offline: true, windowed: true }),
  kind('files', 'records.read'),
  // Form names are on the phone too; their answers wait for signal.
  kind('forms', 'workspace.read', { offline: true, windowed: true }),
  kind('knowledge', 'workspace.read'),
  kind('records', 'records.read'),
  // Each setting has its own needs as well; core's catalogue is searched on the device.
  kind('settings', 'workspace.read', { offline: true, where: 'device' }),
  kind('spam', 'inbox.use', { windowed: true, chip: false, picked: true }),
  kind('bin', 'records.delete'),
  kind('close', 'records.read', { offline: true, chip: false }),
];

/** The kinds the server searches, by key. */
export const SERVER_SEARCH_KINDS: readonly SearchKind[] = SEARCH_KINDS.filter(
  (k) => k.where === 'server',
);

/** Where a group's kind sits: core's kinds by their place, a business's own kinds in their slot, then add-ons'. */
const SLOTS: readonly string[] = [
  'contacts',
  'companies',
  'leads',
  'money',
  'messages',
  'calendar',
  'tasks',
  'notes',
  'files',
  'forms',
  'knowledge',
  'record',
  'addon',
  'settings',
  'spam',
  'archived',
  'bin',
  'close',
];

/**
 * A group kind's place in kind order. `record.pets` takes the records' slot, as does `records` (the business's own
 * kinds together, when they didn't answer), and `realestate.listings` an add-on's.
 */
export function kindRank(groupKind: string): number {
  const dot = groupKind.indexOf('.');
  const slot =
    groupKind === 'records' || groupKind.startsWith('record.')
      ? 'record'
      : dot < 0
        ? groupKind
        : 'addon';
  const at = SLOTS.indexOf(slot);
  return at < 0 ? SLOTS.indexOf('addon') : at;
}

/** The searcher that answers a group kind: `record.pets` is the records searcher's. */
export function searcherKeyOf(groupKind: string): string {
  return groupKind.startsWith('record.') ? 'records' : groupKind;
}

/** A kind's entry by its searcher key. */
export function searchKindEntry(key: string): SearchKind | undefined {
  return SEARCH_KINDS.find((k) => k.key === key);
}

/**
 * The kinds this person may search, in kind order: core's, and the kinds of each add-on running here that answers
 * searches (`addons`, the running add-ons' manifests), in the add-ons' slot. Under a staff view-as nobody holds any
 * permission, so the gates are skipped and row security alone decides, as it does for every other look-up there.
 */
export function searchKindsFor(who: {
  readonly permissions: readonly string[];
  readonly viewAs?: boolean;
  readonly addons?: readonly Pick<AddonManifest, 'id' | 'name' | 'search'>[];
}): readonly (SearchKind | AddonSearchKind)[] {
  const may = (k: SearchKind) => !!who.viewAs || who.permissions.includes(k.needs);
  const core = SEARCH_KINDS.filter(may);
  const addons = (who.addons ?? []).flatMap(addonSearchKinds).filter(may);
  const slot = SLOTS.indexOf('addon');
  const at = core.findIndex((k) => kindRank(k.key) > slot);
  return at < 0 ? [...core, ...addons] : [...core.slice(0, at), ...addons, ...core.slice(at)];
}
