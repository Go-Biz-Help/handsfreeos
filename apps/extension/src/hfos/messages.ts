/**
 * What the side panel asks the background worker about HandsFreeOS, and what it answers. The background holds the
 * sign-in and makes every call to HandsFreeOS (./session.ts), so the panels open in different windows share one
 * sign-in and never refresh it twice at once. Both ends are the extension's own; Facebook's tabs never see these.
 */
import type { paths } from '@hfos/api-client';

type Body<P extends keyof paths> = paths[P] extends {
  post: { requestBody?: { content: { 'application/json': infer B } } };
}
  ? B
  : never;
type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

/** Social Outreach's look-up and saves (packages/core/src/addons/outreach/saves.ts), as the API takes and answers them. */
export type LookupInput = Body<'/v1/queries/outreach.lookup'>;
export type Lookup = Ok<'/v1/queries/outreach.lookup'>;
export type ProfileInput = Body<'/v1/commands/outreach.profile.save'>;
export type ProfileSaved = Ok<'/v1/commands/outreach.profile.save'>;
export type ChatInput = Body<'/v1/commands/outreach.chat.save'>;
export type ChatSaved = Ok<'/v1/commands/outreach.chat.save'>;
export type Me = Ok<'/v1/queries/account.me'>;
/** A step noted on Facebook, and the day's numbers (packages/core/src/addons/outreach/activity.ts). */
export type TouchInput = Body<'/v1/commands/outreach.touch.save'>;
export type TouchSaved = Ok<'/v1/commands/outreach.touch.save'>;
export type Activity = Ok<'/v1/queries/outreach.activity'>;
/** Friends (packages/core/src/addons/outreach/friends.ts): an answer to a request, a list saved, Keep and Don't pitch. */
export type FriendNoteInput = Body<'/v1/commands/outreach.friend.note'>;
export type FriendsSaveInput = Body<'/v1/commands/outreach.friends.save'>;
export type FriendsSaved = Ok<'/v1/commands/outreach.friends.save'>;
export type FriendSetInput = Body<'/v1/commands/outreach.friend.set'>;
export type FriendSet = Ok<'/v1/commands/outreach.friend.set'>;
/** The business's playbooks, which the requests on a page are sorted by (packages/core/src/addons/outreach/fit.ts). */
export type Playbooks = Ok<'/v1/queries/outreach.playbook.list'>;

/** A business the extension can save to: Social Outreach is on there, and the person may use it. */
export interface Business {
  readonly id: string;
  readonly name: string;
}

export type Account =
  | {
      readonly signedIn: false;
      /** Whether this build was given HandsFreeOS's sign-in key (./config.ts). */
      readonly canSignIn: boolean;
      readonly webUrl: string;
    }
  | {
      readonly signedIn: true;
      readonly email: string;
      readonly name: string;
      readonly businesses: readonly Business[];
      /** The one it saves to: the person's pick, or the first. Null when there are none. */
      readonly businessId: string | null;
      readonly webUrl: string;
    };

/** One of the last steps noted, as the panel lists them: a step, or an answer to a friend request. */
export interface Noted {
  readonly kind: TouchInput['kind'] | FriendNoteInput['answer'];
  readonly name: string;
  readonly at: string;
  /** Kept in HandsFreeOS, waiting to be sent while it can't be reached, or not kept (`why` says). */
  readonly state: 'saved' | 'waiting' | 'not_saved';
  /** For a message: a chat started, or a follow-up. */
  readonly step: TouchSaved['step'];
  /** Noted already: the same post liked again, a second request within a day. */
  readonly repeated: boolean;
  readonly why: string | null;
}

/** The person's day on Facebook so far, for the panel (src/hfos/noting.ts). */
export interface Today {
  /**
   * The day's numbers in the business it saves to: null when nobody's signed in, or there's nowhere to save, or
   * HandsFreeOS couldn't say.
   */
  readonly activity: Activity | null;
  /** Why the numbers couldn't be had, in words for the person: null when they could, or weren't asked for. */
  readonly trouble: string | null;
  readonly businessId: string | null;
  readonly webUrl: string;
  /** Whether the extension notes the steps the person takes: the switch in the panel. */
  readonly noting: boolean;
  /** Steps noted while HandsFreeOS couldn't be reached, sent when it can be. */
  readonly waiting: number;
  /** The last steps noted, the latest first. */
  readonly recent: readonly Noted[];
}

export type HfosAsk =
  | { readonly type: 'hfos-account'; readonly fresh?: boolean }
  | { readonly type: 'hfos-send-code'; readonly email: string }
  | { readonly type: 'hfos-check-code'; readonly email: string; readonly code: string }
  | { readonly type: 'hfos-password'; readonly email: string; readonly password: string }
  | { readonly type: 'hfos-sign-out' }
  | { readonly type: 'hfos-pick'; readonly businessId: string }
  | { readonly type: 'hfos-lookup'; readonly input: LookupInput }
  | { readonly type: 'hfos-save-profile'; readonly input: ProfileInput }
  | { readonly type: 'hfos-save-chat'; readonly input: ChatInput }
  | { readonly type: 'hfos-save-friends'; readonly input: FriendsSaveInput }
  | { readonly type: 'hfos-set-friend'; readonly input: FriendSetInput }
  | { readonly type: 'hfos-playbooks'; readonly workspaceId: string }
  | { readonly type: 'hfos-today' }
  | { readonly type: 'hfos-noting'; readonly on: boolean };

/** What each ask answers with. */
export interface HfosValues {
  readonly 'hfos-account': Account;
  readonly 'hfos-send-code': null;
  readonly 'hfos-check-code': Account;
  readonly 'hfos-password': Account;
  readonly 'hfos-sign-out': Account;
  readonly 'hfos-pick': Account;
  readonly 'hfos-lookup': Lookup;
  readonly 'hfos-save-profile': ProfileSaved;
  readonly 'hfos-save-chat': ChatSaved;
  readonly 'hfos-save-friends': FriendsSaved;
  readonly 'hfos-set-friend': FriendSet;
  readonly 'hfos-playbooks': Playbooks;
  readonly 'hfos-today': Today;
  readonly 'hfos-noting': Today;
}

export const HFOS_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>([
  'hfos-account',
  'hfos-send-code',
  'hfos-check-code',
  'hfos-password',
  'hfos-sign-out',
  'hfos-pick',
  'hfos-lookup',
  'hfos-save-profile',
  'hfos-save-chat',
  'hfos-save-friends',
  'hfos-set-friend',
  'hfos-playbooks',
  'hfos-today',
  'hfos-noting',
]);

/** What the background tells the extension's pages when it has noted a step: the day's numbers have changed. */
export type Touched = { readonly type: 'hfos-touched' };

/** Why something didn't work, in words for the person, and HandsFreeOS's rule when one refused it. */
export interface Problem {
  readonly message: string;
  readonly rule: string | null;
  readonly status: number | null;
  /** The sign-in ended, or the business can't be saved to now: the panel asks for the account again. */
  readonly recheck: boolean;
}

export type HfosAnswer<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: Problem };
