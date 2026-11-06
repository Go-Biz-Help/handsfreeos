/**
 * Admin → Assistant coverage's table: the checklist's items, the audit's gaps and the screens to check, filtered and a
 * page at a time. An item is "changed" when its file's fingerprint now differs from the one recorded at its check, and
 * a screen file is "new" when no area lists it. Pure, so the test runs it on small made-up areas.
 */
import type {
  AssistantLedgerInput,
  AssistantLedgerOutput,
  LedgerGap,
  LedgerItem,
} from '../../schemas/assistant-ledger';
import type { LedgerAreaFile } from './index';

const fileOf = (ref: string) => ref.replace(/:\d+(?:-\d+)?$/, '');

type Counts = Omit<AssistantLedgerOutput['areas'][number], 'key' | 'title' | 'checkedOn'>;

function itemsOf(area: LedgerAreaFile, now: Readonly<Record<string, string>>): LedgerItem[] {
  return area.items.map((i) => {
    const file = fileOf(i.file);
    const then = area.files[file];
    return {
      area: area.area,
      path: i.path,
      kind: i.kind === 'do' ? 'do' : 'see',
      file: i.file,
      covered: i.covered,
      by: i.by,
      // A file the area never fingerprinted (a shared helper) can't say it changed.
      changed: then !== undefined && now[file] !== then,
    };
  });
}

const unmarked = (i: LedgerItem) => i.changed || i.covered === 'no' || i.covered === 'partly';

function countsOf(items: readonly LedgerItem[], gaps: LedgerAreaFile['gaps']): Counts {
  const by = (c: LedgerItem['covered']) => items.filter((i) => i.covered === c).length;
  return {
    items: items.length,
    yes: by('yes'),
    partly: by('partly'),
    no: by('no'),
    never: by('never'),
    person: by('person'),
    changed: items.filter((i) => i.changed).length,
    unmarked: items.filter(unmarked).length,
    gapsOpen: gaps.filter((g) => g.status === 'open').length,
    gapsFixed: gaps.filter((g) => g.status === 'fixed').length,
  };
}

const matches = (q: string, ...texts: string[]) =>
  !q || texts.some((t) => t.toLowerCase().includes(q.toLowerCase()));

export function ledgerReport(
  areas: readonly LedgerAreaFile[],
  now: Readonly<Record<string, string>>,
  input: AssistantLedgerInput,
): AssistantLedgerOutput {
  const all = areas.map((a) => ({ area: a, items: itemsOf(a, now) }));
  const listed = new Set(areas.flatMap((a) => Object.keys(a.files)));
  const newScreens = Object.keys(now).filter((f) => !listed.has(f));
  const gone = areas.flatMap((a) =>
    Object.keys(a.files)
      .filter((f) => !(f in now))
      .map((file) => ({ file, area: a.area })),
  );

  const summed = all.map(({ area, items }) => ({
    key: area.area,
    title: area.title,
    checkedOn: area.checkedOn || null,
    ...countsOf(items, area.gaps),
  }));
  const keys = Object.keys(countsOf([], [])) as (keyof Counts)[];
  const totals = Object.fromEntries(
    keys.map((k) => [k, summed.reduce((n, a) => n + a[k], 0)]),
  ) as Counts;

  const inArea = (key: string) => !input.area || key === input.area;
  const page = <T>(rows: T[]) => rows.slice(input.offset, input.offset + input.limit);
  const out: AssistantLedgerOutput = {
    totals: { ...totals, newScreens: newScreens.length, goneFiles: gone.length },
    areas: summed,
    total: 0,
    items: [],
    gaps: [],
    screens: [],
  };

  if (input.view === 'items') {
    const rows = all
      .filter(({ area }) => inArea(area.area))
      .flatMap(({ items }) => items)
      .filter((i) =>
        input.itemState === 'all'
          ? true
          : input.itemState === 'unmarked'
            ? unmarked(i)
            : input.itemState === 'changed'
              ? i.changed
              : i.covered === input.itemState,
      )
      .filter((i) => matches(input.q, i.path, i.by, i.file));
    return { ...out, total: rows.length, items: page(rows) };
  }

  if (input.view === 'gaps') {
    const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    const rows: LedgerGap[] = areas
      .filter((a) => inArea(a.area))
      .flatMap((a) =>
        a.gaps.map((g) => ({
          area: a.area,
          id: g.id,
          severity: (g.severity in rank ? g.severity : 'low') as LedgerGap['severity'],
          kind: g.kind,
          where: g.where,
          gap: g.gap,
          fix: g.fix,
          status: (['open', 'fixed', 'never'].includes(g.status)
            ? g.status
            : 'open') as LedgerGap['status'],
          pr: g.pr ?? null,
        })),
      )
      .filter((g) => input.gapState === 'all' || g.status === input.gapState)
      .filter((g) => matches(input.q, g.id, g.where, g.gap))
      .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
    return { ...out, total: rows.length, gaps: page(rows) };
  }

  const rows = [
    ...(input.area ? [] : newScreens.map((file) => ({ file, state: 'new' as const, area: null }))),
    ...gone.filter((g) => inArea(g.area)).map((g) => ({ ...g, state: 'gone' as const })),
  ].filter((s) => matches(input.q, s.file));
  return { ...out, total: rows.length, screens: page(rows) };
}
