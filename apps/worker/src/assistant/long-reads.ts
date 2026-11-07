/**
 * Screen reads that can run longer than the model reads whole (trunc-1). runScreenRead cuts anything over its limit
 * into a plain string, which loses every id and every key after the cut: a partner with more than about fifty
 * commissions lost their payout account and their payouts, and an import of a wide sheet lost all but its first few
 * failed rows. These shape themselves first instead, putting what the page shows at the top before the long lists, and
 * cutting the lists from their end, each saying how many of how many it shows and where the rest are.
 */

/** Room for an answer and its notes inside runScreenRead's limit (16,000 characters of JSON). */
export const LONG_READ_ROOM = 15_000;

type Row = Record<string, unknown>;

const size = (v: unknown) => JSON.stringify(v ?? null).length;

/**
 * `data` with each named list kept to the same share of itself, the largest share that fits `room` characters of
 * JSON, and how many of each list show when one was cut. Ten halvings find the share, so it costs a few serialisings.
 */
export function fitLists(
  data: Row,
  lists: readonly string[],
  room: number,
): { data: Row; cut: Record<string, { shown: number; total: number }> } {
  const totals = Object.fromEntries(
    lists.map((k) => [k, Array.isArray(data[k]) ? (data[k] as unknown[]).length : 0]),
  );
  const keep = (share: number): Row => {
    const out: Row = { ...data };
    for (const k of lists)
      if (Array.isArray(data[k]))
        out[k] = (data[k] as unknown[]).slice(0, Math.floor(totals[k]! * share));
    return out;
  };
  if (size(data) <= room) return { data, cut: {} };
  let low = 0;
  let high = 1;
  for (let i = 0; i < 10; i++) {
    const mid = (low + high) / 2;
    if (size(keep(mid)) <= room) low = mid;
    else high = mid;
  }
  const fitted = keep(low);
  const cut: Record<string, { shown: number; total: number }> = {};
  for (const k of lists) {
    const shown = Array.isArray(fitted[k]) ? (fitted[k] as unknown[]).length : 0;
    if (shown < totals[k]!) cut[k] = { shown, total: totals[k]! };
  }
  return { data: fitted, cut };
}

/**
 * A partner's page as it reads top to bottom (partner.get): who they are, their link and what they've earned, then how
 * they're paid (their bank and each payout), then their clients and what they've earned line by line, the newest
 * first. Payouts come before the long lists so they always survive; a list too long to read whole says so.
 */
export function partnerRead(got: unknown, room = LONG_READ_ROOM): unknown {
  const g = got as Row | null;
  if (!g || typeof g !== 'object' || !g['partner']) return got;
  const ordered: Row = {
    partner: g['partner'],
    payouts: g['payouts'],
    clients: g['clients'],
    commissions: g['commissions'],
  };
  const { data, cut } = fitLists(ordered, ['clients', 'commissions'], room);
  const notes = [
    cut['clients']
      ? `Their first ${cut['clients'].shown} of ${cut['clients'].total} clients are here; the rest are on their page under Their clients.`
      : null,
    cut['commissions']
      ? `The newest ${cut['commissions'].shown} of ${cut['commissions'].total} lines of what they’ve earned are here; the rest are on their page under What they’ve earned. Their totals in partner.earnings count every one.`
      : null,
  ].filter(Boolean);
  return notes.length ? { ...data, note: notes.join(' ') } : data;
}

/**
 * An import's page (import.get): its progress and result, then the rows that did not import with why. Each failed row
 * keeps the sheet's own cells while they fit; a wide sheet's are left out, keeping each row's number and why, and only
 * then is the list cut.
 */
export function importRead(got: unknown, room = LONG_READ_ROOM): unknown {
  const g = got as { import?: unknown; errors?: Row[] } | null;
  if (!g || !Array.isArray(g.errors) || size(g) <= room) return got;
  const bare: Row = {
    import: g.import,
    errors: g.errors.map((e) => ({ rowNumber: e['rowNumber'], message: e['message'] })),
  };
  const { data, cut } = fitLists(bare, ['errors'], room);
  return {
    ...data,
    note: `Each row’s own cells are left out to fit: the import’s page shows them under Rows that did not import.${
      cut['errors']
        ? ` The first ${cut['errors'].shown} of the ${cut['errors'].total} rows listed there are here.`
        : ''
    }`,
  };
}
