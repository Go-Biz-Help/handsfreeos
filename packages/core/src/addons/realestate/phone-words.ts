/**
 * Real Estate's words on the phone (round six) that more than one of its screens says: its places in More, what a
 * deal kept as its summary says, and what waits for signal. A screen's own words sit with the screen's group in
 * `phone-words-*.ts` beside this. Browser-safe.
 */

/** "12 open · 3 at risk", "5 today · 1 late", "14 approved": the line under each of Real Estate's rows in More. */
export const RE_MORE_WORDS = {
  section: 'Real Estate',
  deals: (open: number, atRisk: number) =>
    [`${open} open`, atRisk > 0 ? `${atRisk} at risk` : null].filter(Boolean).join(' · '),
  duties: (today: number, late: number) =>
    today === 0 && late === 0
      ? 'Nothing due today'
      : [`${today} today`, late > 0 ? `${late} late` : null].filter(Boolean).join(' · '),
  coordinate: 'Today, exceptions, waiting, workload',
  vendors: (approved: number) => (approved === 1 ? '1 approved' : `${approved} approved`),
  /** Places the phone leaves to the web, named under the rows. */
  onTheWeb: (names: readonly string[]) =>
    `${names.join(' and ')} ${names.length === 1 ? 'opens' : 'open'} on the web.`,
  settingsOnTheWeb: 'Deal settings (the duty list, alerts, connections) opens on the web.',
} as const;

/** What every Real Estate screen may say about what the phone holds and what waits for signal. */
export const RE_PHONE_WORDS = {
  /** A deal someone sees as whoever sees every deal: the phone keeps its summary, duties and dates. */
  summaryChip: 'Summary, duties and dates on this phone',
  summaryNote:
    'Deals you’re not on keep their summary, duties and dates here; their documents, history and offers load with signal.',
  /** A page of a deal kept as its summary, with no signal. */
  summaryNeedsSignal: (what: string) =>
    `This deal’s ${what} load${what.endsWith('s') ? '' : 's'} with signal, because you’re not on it. Try again when you have signal.`,
  needsSignal: 'Needs signal',
  needsSignalWhy: (what: string) => `${what} needs signal. Try again when you have signal.`,
  noSignal: 'No signal',
  keptAt: (time: string) => `No signal · what this phone kept at ${time}`,
  waitingToSend: 'Waiting to send',
  waitsToSend: 'waits to send',
  openOnWeb: 'Open on the web',
  notOnPhone:
    'This deal isn’t on this phone. It may have ended more than 90 days ago, or you may no longer be on it.',
  tryAgain: 'Try again',
} as const;
