/**
 * Add-on votes on the support desk (0109, the team's side), said once for the web's /admin/add-ons and the phone's.
 * Every Sunday at midnight Eastern the planned add-on with the most votes becomes Coming soon on its own; a week with
 * nothing voted for, or a tie, waits for one of the team to choose (the owner's decision, 2026-09-28).
 */

import { intlTimeZone } from '../intl/engine-zones';

/** Where the week closes, so the page says its times there whatever the reader's own zone. */
const EASTERN = 'America/New_York';

/** "Sun, Oct 4, 2026, 12:00 AM": when the next pick is, in Eastern time. */
export const addonPickMoment = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: intlTimeZone(EASTERN),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** "Oct 4, 2026": the day a week ended or an add-on was picked, in Eastern time. */
export const addonPickDay = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', {
    timeZone: intlTimeZone(EASTERN),
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

/** "1 vote", "12 votes". */
export const addonVotesCount = (n: number): string => `${n} ${n === 1 ? 'vote' : 'votes'}`;

/** How an add-on became Coming soon. */
export const ADDON_PICK_HOW_WORDS: Readonly<Record<'votes' | 'team' | 'plan', string>> = {
  votes: 'Won the vote',
  team: 'Chosen by the team',
  plan: 'Already planned',
};

/** The race shows this many until "Show all". */
export const ADDON_RACE_SHOWN = 25;

export const ADDON_VOTES_WORDS = {
  intro:
    'Businesses vote for the planned add-ons they want. Every Sunday at midnight Eastern, the one with the most votes becomes Coming soon. When nobody voted, or there’s a tie, you choose.',
  nextPick: 'Next pick:',
  nextPickAt: (iso: string) => `${addonPickMoment(iso)} Eastern`,
  waiting: 'Waiting on you',
  noneWaiting: 'Nothing to choose. A week with no votes or a tie lands here, and you get an email.',
  weekEnding: (iso: string) => `Week ending ${addonPickDay(iso)}`,
  tie: (names: readonly string[], topVotes: number) =>
    `A tie between ${names.join(', ')}, with ${addonVotesCount(topVotes)} each. Choose one of them.`,
  noVotes: 'Nobody voted. Choose any planned add-on to come next.',
  choiceLabel: 'Add-on to make Coming soon',
  choose: 'Make it Coming soon',
  chosen: (name: string) =>
    `${name} is coming soon. The businesses that voted for it are being told.`,
  comingSoon: 'Coming soon',
  nothingPicked: 'Nothing picked yet.',
  picked: (votes: number, iso: string) => `${addonVotesCount(votes)} · picked ${addonPickDay(iso)}`,
  race: 'The race',
  find: 'Find an add-on',
  addOn: 'Add-on',
  category: 'Category',
  votes: 'Votes',
  showAll: (n: number) => `Show all ${n}`,
  recentWeeks: 'Recent weeks',
  noWeeks: 'No week has closed yet.',
  tieWaiting: 'Tie, waiting on you',
  noVotesWaiting: 'No votes, waiting on you',
} as const;

/**
 * "Waiting on you · 2": a desk heading with its count. Without `always`, a count of none is left off ("Waiting on
 * you"); with it, it's said ("Coming soon · 0").
 */
export const deskCountHeading = (title: string, n: number, always = false): string =>
  always || n ? `${title} · ${n}` : title;

/** The add-ons a waiting week may become: the tied ones for a tie, anything still in the race when nobody voted. */
export const addonWeekChoices = (
  week: { readonly outcome: 'no_votes' | 'tie'; readonly tied: readonly string[] },
  race: readonly { readonly addonId: string }[],
): readonly string[] => (week.outcome === 'tie' ? week.tied : race.map((r) => r.addonId));

/** The race, narrowed to the names that have the typed words in them. */
export function filterAddonRace<R extends { readonly name: string }>(
  race: readonly R[],
  query: string,
): readonly R[] {
  const q = query.trim().toLowerCase();
  return q ? race.filter((r) => r.name.toLowerCase().includes(q)) : race;
}

/** One of Recent weeks: what it became, and how. */
export function addonWeekResult(week: {
  readonly outcome: 'votes' | 'no_votes' | 'tie';
  readonly name: string | null;
  readonly topVotes: number;
  readonly decidedBy: string | null;
}): { readonly what: string; readonly how: string } {
  return {
    what:
      week.name ??
      (week.outcome === 'tie' ? ADDON_VOTES_WORDS.tieWaiting : ADDON_VOTES_WORDS.noVotesWaiting),
    how:
      week.outcome === 'votes'
        ? `Won with ${addonVotesCount(week.topVotes)}`
        : week.decidedBy
          ? `Chosen by ${week.decidedBy}`
          : week.name
            ? ADDON_PICK_HOW_WORDS.team
            : '',
  };
}
