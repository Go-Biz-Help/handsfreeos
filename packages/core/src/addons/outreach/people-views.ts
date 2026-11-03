/**
 * People's views (docs/outreach.md, decision 128): one list of everyone the person is reaching, with a view for each
 * kind, in this order, on the web and the phone alike. Each view is one of the lists HandsFreeOS already keeps (the
 * pipeline's stages, the friends lists, the chats, the Partners list), so its people, counts and buttons are that
 * list's own. **Left alone** gathers whoever outreach leaves be: Don't pitch, Never contact, Not a fit, Keep, and
 * those the country setting skips.
 *
 * Browser-safe and pure.
 */
import type { FriendsOutput, FriendView } from './friends';
import type { StagesOutput, StageView } from './stages';

export const PEOPLE_VIEWS = {
  in_play: 'In play',
  fits: 'Good fits',
  talking: 'Talking',
  friends: 'Friends',
  requests: 'Requests',
  sent: 'Sent',
  chats: 'Chats',
  partners: 'Partners',
  clients: 'Clients',
  left_alone: 'Left alone',
} as const;
export type PeopleView = keyof typeof PEOPLE_VIEWS;
export const PEOPLE_VIEW_KEYS = Object.keys(PEOPLE_VIEWS) as [PeopleView, ...PeopleView[]];

/** Left alone's lists, in its row's order. */
export const LEFT_ALONE = {
  dont_pitch: 'Don’t pitch',
  never_contact: 'Never contact',
  lost: 'Not a fit',
  keep: 'Keep',
  country: 'Skipped for country',
} as const;
export type LeftAlone = keyof typeof LEFT_ALONE;
export const LEFT_ALONE_KEYS = Object.keys(LEFT_ALONE) as [LeftAlone, ...LeftAlone[]];

/** The words around the views. */
export const PEOPLE_VIEW_WORDS = {
  label: 'Which people',
  leftAloneLabel: 'Who’s left alone',
  leftAloneAbout:
    'Nobody here sends outreach to anyone on these lists. Each says who put them on, and how to take them off.',
} as const;

/** The list a view, or one of Left alone's, is: the stages' (`show` one, or `all` in play), a friends list, or another. */
export type PeopleList =
  | { readonly list: 'stages'; readonly show: StageView }
  | { readonly list: 'friends'; readonly show: FriendView }
  | { readonly list: 'chats' }
  | { readonly list: 'partners' }
  | { readonly list: 'country' };

/** The list behind a view: Left alone opens on Don't pitch. */
export function peopleListOf(view: PeopleView | LeftAlone): PeopleList {
  switch (view) {
    case 'in_play':
      return { list: 'stages', show: 'all' };
    case 'talking':
      return { list: 'stages', show: 'talking' };
    case 'clients':
      return { list: 'stages', show: 'client' };
    case 'lost':
      return { list: 'stages', show: 'lost' };
    case 'fits':
    case 'friends':
    case 'requests':
    case 'sent':
    case 'keep':
    case 'dont_pitch':
    case 'never_contact':
      return { list: 'friends', show: view };
    case 'left_alone':
      return { list: 'friends', show: 'dont_pitch' };
    case 'chats':
      return { list: 'chats' };
    case 'partners':
      return { list: 'partners' };
    case 'country':
      return { list: 'country' };
  }
}

/**
 * The view a list shows under, and which of Left alone's it is: a stage of its own (Ready to pitch, Pitched, Booked…)
 * is in play, as the board's columns are.
 */
export function peopleViewOf(at: PeopleList): {
  readonly view: PeopleView;
  readonly alone: LeftAlone | null;
} {
  switch (at.list) {
    case 'stages':
      return at.show === 'talking'
        ? { view: 'talking', alone: null }
        : at.show === 'client'
          ? { view: 'clients', alone: null }
          : at.show === 'lost'
            ? { view: 'left_alone', alone: 'lost' }
            : { view: 'in_play', alone: null };
    case 'friends':
      return at.show === 'keep' || at.show === 'dont_pitch' || at.show === 'never_contact'
        ? { view: 'left_alone', alone: at.show }
        : { view: at.show, alone: null };
    case 'chats':
      return { view: 'chats', alone: null };
    case 'partners':
      return { view: 'partners', alone: null };
    case 'country':
      return { view: 'left_alone', alone: 'country' };
  }
}

/**
 * The counts on the views' chips, from the list shown: a friends list knows every friends list's count, the stages
 * theirs. A view whose count the list doesn't know shows none.
 */
export function peopleCountsOf(
  shown:
    | { readonly friends: FriendsOutput['counts'] }
    | { readonly stages: StagesOutput['counts'] }
    | null,
): Partial<Record<PeopleView | LeftAlone, number>> {
  if (!shown) return {};
  if ('friends' in shown) {
    const c = shown.friends;
    return {
      fits: c.fits,
      friends: c.friends,
      requests: c.requests,
      sent: c.sent,
      keep: c.keep,
      dont_pitch: c.dontPitch,
      never_contact: c.neverContact,
    };
  }
  const c = shown.stages;
  return { in_play: c.all, talking: c.talking, clients: c.client, lost: c.lost };
}
