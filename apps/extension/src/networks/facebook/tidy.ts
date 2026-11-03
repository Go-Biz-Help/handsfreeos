/**
 * Cancelling old friend requests and unfriending (docs/outreach.md, decisions 10, 12 and 17): the buttons the
 * extension presses on someone's profile, once the person has ticked them in the panel. It opens each profile in a
 * tab they can see, checks it's the one ticked and where things stand, presses Cancel request (or Friends, then
 * Unfriend, then Confirm), and checks the profile says Add friend after. And deleting a request the person got, as
 * they picked for those (decision 121): Respond, then Delete request. A step it can't find is handed to the
 * person, as with the download file (./fetch.ts), whose way of finding and pressing these it shares.
 *
 * Its own words are those the profile reader already goes by (./profile.ts): Friends, Cancel request, Add friend.
 * The menu row and the box that asks to be sure are Facebook's usual ones, with what else they may be called.
 */
import type { FetchStep } from './fetch';
import type { ProfilePage, ProfileRef } from './types';
import { classifyUrl } from './urls';

export type TidyJob = 'cancel_request' | 'unfriend' | 'decline';

export interface TidyPlan {
  /** Where things must stand on the profile before anything is pressed. */
  readonly before: ProfilePage['friendship'];
  /** The way to the button, as a path (./fetch.ts): the furthest step on the page is pressed. */
  readonly path: readonly FetchStep[];
  /** Then, in order: Facebook's box asking to be sure, when it shows one. */
  readonly then: readonly FetchStep[];
}

const SURE = ['Confirm', 'Yes', 'Unfriend', 'Cancel request'];
/** Delete request, as the menu under Respond calls it, or the profile's own button on some accounts. */
const DELETE_REQUEST = ['Delete request', 'Delete Request', 'Delete friend request'];

export const TIDY_PLANS: Readonly<Record<TidyJob, TidyPlan>> = {
  cancel_request: {
    before: 'request_sent',
    path: [
      {
        action: 'press',
        words: ['Cancel request', 'Cancel Request'],
        exact: true,
        buttonsOnly: true,
        says: 'Press “Cancel request” under their name.',
      },
    ],
    then: [
      {
        action: 'press',
        words: SURE,
        exact: true,
        inBox: true,
        optional: true,
        says: 'Press “Confirm”.',
      },
    ],
  },
  unfriend: {
    before: 'friends',
    path: [
      {
        action: 'press',
        words: ['Friends'],
        exact: true,
        buttonsOnly: true,
        says: 'Press “Friends” under their name.',
      },
      {
        action: 'press',
        words: ['Unfriend', 'Remove friend'],
        inBox: true,
        says: 'Press “Unfriend”.',
      },
    ],
    then: [
      {
        action: 'press',
        words: SURE,
        exact: true,
        inBox: true,
        optional: true,
        says: 'Press “Confirm”.',
      },
    ],
  },
  decline: {
    before: 'request_received',
    // Respond opens a menu with Delete request in it; some profiles show Delete request straight away.
    path: [
      {
        action: 'press',
        words: ['Respond'],
        exact: true,
        buttonsOnly: true,
        says: 'Press “Respond” under their name.',
      },
      {
        action: 'press',
        words: DELETE_REQUEST,
        exact: true,
        says: 'Press “Delete request”.',
      },
    ],
    then: [
      {
        action: 'press',
        words: ['Delete', 'Confirm', ...DELETE_REQUEST],
        exact: true,
        inBox: true,
        optional: true,
        says: 'Press “Delete”.',
      },
    ],
  },
};

/** Where things stand on a profile, in words for the person: "Facebook says you’re friends". */
export const FRIENDSHIP_WORDS: Readonly<Record<ProfilePage['friendship'], string>> = {
  self: 'that’s you',
  friends: 'you’re friends',
  request_sent: 'your request is still waiting',
  request_received: 'they asked to be friends with you',
  not_friends: 'you aren’t friends',
  unknown: 'it couldn’t tell where things stand',
};

/** Whether an address is someone's profile, the only pages the extension cancels or unfriends on. */
export function tidyPage(href: string): boolean {
  return classifyUrl(href).kind === 'profile';
}

/** Whether a profile the page shows is the one ticked: by its number or its username, either way it was saved. */
export function sameProfile(
  shown: ProfileRef | null,
  ticked: { readonly platformId: string | null; readonly username: string | null },
): boolean {
  if (!shown) return false;
  if (shown.id && ticked.platformId && shown.id === ticked.platformId) return true;
  if (
    shown.username &&
    ticked.username &&
    shown.username.toLowerCase() === ticked.username.toLowerCase()
  )
    return true;
  return false;
}
