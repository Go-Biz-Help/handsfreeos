/**
 * What the side panel asks the background worker about HandsFreeOS, and what it answers. The background holds the
 * sign-in and makes every call to HandsFreeOS (./session.ts), so the panels open in different windows share one
 * sign-in and never refresh it twice at once. Both ends are the extension's own; Facebook's tabs never see these.
 */
import type { paths } from '@hfos/api-client';
import type { JoinAnswerInput, JoinAnswerOutput } from '@hfos/core/addons/outreach/group-checks';
import type { TodayDraftInput, TodayDraftOutput } from '@hfos/core/addons/outreach/today';
import type { DailyStep } from '@hfos/core/addons/outreach/limits';
import type { AutoState } from '../auto/plan';

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

/** A profile saved (packages/core/src/addons/outreach/saves.ts), as the API takes it. */
export type ProfileInput = Body<'/v1/commands/outreach.profile.save'>;
/** Chats read in Messenger for the AI (packages/core/src/addons/outreach/chat-collect.ts). */
export type ChatsCollectInput = Body<'/v1/commands/outreach.chats.collect'>;
export type ChatsCollected = Ok<'/v1/commands/outreach.chats.collect'>;
export type Me = Ok<'/v1/queries/account.me'>;
/** A step noted on Facebook, and the day's numbers (packages/core/src/addons/outreach/activity.ts). */
export type TouchInput = Body<'/v1/commands/outreach.touch.save'>;
export type TouchSaved = Ok<'/v1/commands/outreach.touch.save'>;
export type Activity = Ok<'/v1/queries/outreach.activity'>;
/** Friends (packages/core/src/addons/outreach/friends.ts): an answer to a request, and a list saved. */
export type FriendNoteInput = Body<'/v1/commands/outreach.friend.note'>;
export type FriendsSaveInput = Body<'/v1/commands/outreach.friends.save'>;
export type FriendsSaved = Ok<'/v1/commands/outreach.friends.save'>;
/** A part of Facebook's download file, brought in (packages/core/src/addons/outreach/download.ts). */
export type DownloadSaveInput = Body<'/v1/commands/outreach.download.save'>;
export type DownloadSaved = Ok<'/v1/commands/outreach.download.save'>;
/** Groups and the people in them (packages/core/src/addons/outreach/groups.ts). */
export type GroupsSaveInput = Body<'/v1/commands/outreach.groups.save'>;
export type GroupsSaved = Ok<'/v1/commands/outreach.groups.save'>;
export type GroupSaveInput = Body<'/v1/commands/outreach.group.save'>;
export type GroupSaved = Ok<'/v1/commands/outreach.group.save'>;
export type GroupsListInput = Body<'/v1/queries/outreach.groups'>;
export type GroupsList = Ok<'/v1/queries/outreach.groups'>;
/** The list for today and its drafts (packages/core/src/addons/outreach/today.ts). */
export type TodayList = Ok<'/v1/queries/outreach.today'>;
export type TodayListItem = TodayList['items'][number];
export type { TodayDraftInput };
/** Old requests and friends to unfriend, and each one the extension did (packages/core/src/addons/outreach/tidy.ts). */
export type Tidy = Ok<'/v1/queries/outreach.friends.tidy'>;
export type TidyCandidate = Tidy['cancel'][number];
export type FriendEndInput = Body<'/v1/commands/outreach.friend.end'>;
export type FriendEnded = Ok<'/v1/commands/outreach.friend.end'>;
/** A warning Facebook showed the person, noted (decision 25). */
export type WarningNoteInput = Body<'/v1/commands/outreach.warning.note'>;
export type WarningNoted = Ok<'/v1/commands/outreach.warning.note'>;
/** Group posts worth a comment, kept and marked (packages/core/src/addons/outreach/posts.ts). */
export type PostsSaveInput = Body<'/v1/commands/outreach.posts.save'>;
export type PostsSaved = Ok<'/v1/commands/outreach.posts.save'>;
/** Chats whose last message is theirs, seen on Facebook (packages/core/src/addons/outreach/alerts.ts). */
export type RepliesNoteInput = Body<'/v1/commands/outreach.replies.note'>;
/** What the person lets the extension do on its own, and their working hours (packages/core/src/addons/outreach/automation.ts). */
export type Automation = Ok<'/v1/queries/outreach.automation'>;
/** Messages the extension drafted, OK'd or skipped (packages/core/src/addons/outreach/sends.ts). */
export type SendApproveInput = Body<'/v1/commands/outreach.send.approve'>;
export type SendApproved = Ok<'/v1/commands/outreach.send.approve'>;
export type SendSkipInput = Body<'/v1/commands/outreach.send.skip'>;
export type SendSkipped = Ok<'/v1/commands/outreach.send.skip'>;
/**
 * Waiting for you (packages/core/src/addons/outreach/waiting.ts, decisions 40 and 42): everything waiting for the
 * person, a step the extension couldn't do handed to them, one done or let go, and a friend request left.
 */
export type Waiting = Ok<'/v1/queries/outreach.waiting'>;
export type WaitingItem = Waiting['items'][number];
export type NeedNoteInput = Body<'/v1/commands/outreach.need.note'>;
export type NeedClearInput = Body<'/v1/commands/outreach.need.clear'>;
export type NeedCleared = Ok<'/v1/commands/outreach.need.clear'>;
export type RequestSetAsideInput = Body<'/v1/commands/outreach.request.set_aside'>;
export type RequestSetAside = Ok<'/v1/commands/outreach.request.set_aside'>;
/** Who to check for a good fit next, and what their pages said (packages/core/src/addons/outreach/checks.ts). */
export type ChecksNextInput = Body<'/v1/queries/outreach.checks.next'>;
export type ChecksNext = Ok<'/v1/queries/outreach.checks.next'>;
export type CheckLookInput = Body<'/v1/commands/outreach.check.look'>;
export type CheckLooked = Ok<'/v1/commands/outreach.check.look'>;
/** Groups to check and to join, what a group's About page said, and how an ask to join went (decision 48). */
export type GroupsToCheckInput = Body<'/v1/queries/outreach.groups.to_check'>;
export type GroupsToCheck = Ok<'/v1/queries/outreach.groups.to_check'>;
export type GroupLookInput = Body<'/v1/commands/outreach.group.look'>;
export type GroupLooked = Ok<'/v1/commands/outreach.group.look'>;
export type JoinsNextInput = Body<'/v1/queries/outreach.joins.next'>;
export type JoinsNext = Ok<'/v1/queries/outreach.joins.next'>;
export type JoinNoteInput = Body<'/v1/commands/outreach.join.note'>;
export type JoinNoted = Ok<'/v1/commands/outreach.join.note'>;
/** Helpful posts (decision 50): today's asked for, the one to put up and those to read, and how each went. */
export type HelpfulAskInput = Body<'/v1/commands/outreach.helpful.ask'>;
export type HelpfulAsked = Ok<'/v1/commands/outreach.helpful.ask'>;
export type HelpfulNextInput = Body<'/v1/queries/outreach.helpful.next'>;
export type HelpfulNext = Ok<'/v1/queries/outreach.helpful.next'>;
export type HelpfulPostedInput = Body<'/v1/commands/outreach.helpful.posted'>;
export type HelpfulPosted = Ok<'/v1/commands/outreach.helpful.posted'>;
export type HelpfulEngagedInput = Body<'/v1/commands/outreach.helpful.engaged'>;
export type HelpfulEngaged = Ok<'/v1/commands/outreach.helpful.engaged'>;
export type { JoinAnswerInput, JoinAnswerOutput };
/** The AI's drafts, from the worker (apps/worker/src/addons/outreach/today.ts). */
export type Drafts = TodayDraftOutput;

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

/** The runner that works on its own (src/auto/run.ts), for the panel: the person's choices, and where it is. */
export interface AutoStatus {
  /** Their choices and the business's time zone: null when nobody's signed in, or there's nowhere to save. */
  readonly automation: Automation | null;
  /** Why the choices couldn't be had, in words for the person. */
  readonly trouble: string | null;
  readonly businessId: string | null;
  /** Whether the extension notes the steps the person takes: it works on its own only while it does. */
  readonly noting: boolean;
  readonly state: AutoState;
  /** HandsFreeOS on the web, where the choices are changed. */
  readonly webUrl: string;
  /** Whether this computer is the one that works, and which does when it isn't: null before the first beat. */
  readonly live: { readonly working: boolean; readonly workingName: string | null } | null;
  /** Facebook's warning words seen here today: null when there were none. */
  readonly warned: readonly string[] | null;
  /** The warning when the person's steps today go past a daily limit (`pastLimitWords`): null within them. */
  readonly pastLimit: string | null;
  /**
   * Today in HandsFreeOS, for the panel's Next up and Done today (decision 59): each step against its daily limit, and
   * the latest steps. Null when HandsFreeOS couldn't say; missing from a background before 0.26.
   */
  readonly today?: TodaySoFar | null;
}

/** Today's steps against the daily limits, and the newest of the day's feed. */
export interface TodaySoFar {
  readonly limits: Readonly<Record<DailyStep, { readonly done: number; readonly most: number }>>;
  readonly steps: readonly { readonly at: string; readonly line: string; readonly kind: string }[];
}

export type HfosAsk =
  | { readonly type: 'hfos-account'; readonly fresh?: boolean }
  | { readonly type: 'hfos-send-code'; readonly email: string }
  | { readonly type: 'hfos-check-code'; readonly email: string; readonly code: string }
  | { readonly type: 'hfos-password'; readonly email: string; readonly password: string }
  | { readonly type: 'hfos-sign-out' }
  | { readonly type: 'hfos-pick'; readonly businessId: string }
  | { readonly type: 'hfos-collect-chats'; readonly input: ChatsCollectInput }
  | { readonly type: 'hfos-save-friends'; readonly input: FriendsSaveInput }
  | { readonly type: 'hfos-save-download'; readonly input: DownloadSaveInput }
  | { readonly type: 'hfos-save-groups'; readonly input: GroupsSaveInput }
  | { readonly type: 'hfos-save-group'; readonly input: GroupSaveInput }
  | { readonly type: 'hfos-groups'; readonly input: GroupsListInput }
  | {
      readonly type: 'hfos-draft';
      readonly workspaceId: string;
      readonly input: TodayDraftInput;
    }
  | { readonly type: 'hfos-tidy'; readonly workspaceId: string }
  | { readonly type: 'hfos-friend-end'; readonly input: FriendEndInput }
  | { readonly type: 'hfos-warning'; readonly input: WarningNoteInput }
  | { readonly type: 'hfos-save-posts'; readonly input: PostsSaveInput }
  | { readonly type: 'hfos-checks-next'; readonly input: ChecksNextInput }
  | { readonly type: 'hfos-check-look'; readonly input: CheckLookInput }
  | { readonly type: 'hfos-groups-to-check'; readonly input: GroupsToCheckInput }
  | { readonly type: 'hfos-group-look'; readonly input: GroupLookInput }
  | { readonly type: 'hfos-joins-next'; readonly input: JoinsNextInput }
  | { readonly type: 'hfos-join-note'; readonly input: JoinNoteInput }
  | { readonly type: 'hfos-helpful-ask'; readonly input: HelpfulAskInput }
  | { readonly type: 'hfos-helpful-next'; readonly input: HelpfulNextInput }
  | { readonly type: 'hfos-helpful-posted'; readonly input: HelpfulPostedInput }
  | { readonly type: 'hfos-helpful-engaged'; readonly input: HelpfulEngagedInput }
  | {
      readonly type: 'hfos-join-answers';
      readonly workspaceId: string;
      readonly input: JoinAnswerInput;
    }
  | { readonly type: 'hfos-auto' }
  | { readonly type: 'hfos-auto-start' }
  | { readonly type: 'hfos-auto-stop' }
  | { readonly type: 'hfos-send-ok'; readonly input: SendApproveInput }
  | { readonly type: 'hfos-send-skip'; readonly input: SendSkipInput }
  /** Waiting for you, asked again now (src/hfos/waiting.ts); a need done or let go; a friend request left. */
  | { readonly type: 'hfos-waiting' }
  | { readonly type: 'hfos-need-clear'; readonly input: NeedClearInput }
  | { readonly type: 'hfos-request-aside'; readonly input: RequestSetAsideInput }
  /** The person has the panel open on this computer: it becomes the one that works (./live.ts). */
  | { readonly type: 'hfos-here' }
  /** Carry on or Skip, for a step the ask under way handed to the person; Stop for it (../asks/run.ts). */
  | {
      readonly type: 'hfos-ask-reply';
      readonly reply: 'carry_on' | 'skip';
      readonly askId?: string;
    }
  | { readonly type: 'hfos-ask-stop'; readonly askId?: string };

/** What each ask answers with. */
export interface HfosValues {
  readonly 'hfos-account': Account;
  readonly 'hfos-send-code': null;
  readonly 'hfos-check-code': Account;
  readonly 'hfos-password': Account;
  readonly 'hfos-sign-out': Account;
  readonly 'hfos-pick': Account;
  readonly 'hfos-collect-chats': ChatsCollected;
  readonly 'hfos-save-friends': FriendsSaved;
  readonly 'hfos-save-download': DownloadSaved;
  readonly 'hfos-save-groups': GroupsSaved;
  readonly 'hfos-save-group': GroupSaved;
  readonly 'hfos-groups': GroupsList;
  readonly 'hfos-draft': Drafts;
  readonly 'hfos-tidy': Tidy;
  readonly 'hfos-friend-end': FriendEnded;
  readonly 'hfos-warning': WarningNoted;
  readonly 'hfos-save-posts': PostsSaved;
  readonly 'hfos-checks-next': ChecksNext;
  readonly 'hfos-check-look': CheckLooked;
  readonly 'hfos-groups-to-check': GroupsToCheck;
  readonly 'hfos-group-look': GroupLooked;
  readonly 'hfos-joins-next': JoinsNext;
  readonly 'hfos-join-note': JoinNoted;
  readonly 'hfos-helpful-ask': HelpfulAsked;
  readonly 'hfos-helpful-next': HelpfulNext;
  readonly 'hfos-helpful-posted': HelpfulPosted;
  readonly 'hfos-helpful-engaged': HelpfulEngaged;
  readonly 'hfos-join-answers': JoinAnswerOutput;
  readonly 'hfos-auto': AutoStatus;
  readonly 'hfos-auto-start': AutoStatus;
  readonly 'hfos-auto-stop': AutoStatus;
  readonly 'hfos-send-ok': SendApproved;
  readonly 'hfos-send-skip': SendSkipped;
  readonly 'hfos-waiting': Waiting | null;
  readonly 'hfos-need-clear': NeedCleared;
  readonly 'hfos-request-aside': RequestSetAside;
  readonly 'hfos-here': null;
  readonly 'hfos-ask-reply': null;
  readonly 'hfos-ask-stop': null;
}

export const HFOS_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>([
  'hfos-account',
  'hfos-send-code',
  'hfos-check-code',
  'hfos-password',
  'hfos-sign-out',
  'hfos-pick',
  'hfos-auto',
  'hfos-auto-start',
  'hfos-auto-stop',
  'hfos-send-ok',
  'hfos-send-skip',
  'hfos-waiting',
  'hfos-need-clear',
  'hfos-request-aside',
  'hfos-here',
  'hfos-ask-reply',
  'hfos-ask-stop',
]);

/** The panel's asks about the ask under way (src/asks/run.ts). */
export const ASK_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>([
  'hfos-ask-reply',
  'hfos-ask-stop',
]);

/** The asks about Waiting for you (src/hfos/waiting.ts). */
export const WAITING_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>([
  'hfos-waiting',
  'hfos-need-clear',
  'hfos-request-aside',
]);

/** The asks the runner that works on its own answers (src/auto/run.ts). */
export const AUTO_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>([
  'hfos-auto',
  'hfos-auto-start',
  'hfos-auto-stop',
  'hfos-send-ok',
  'hfos-send-skip',
]);

/** The business the person picked to save to (./session.ts). */
export const BUSINESS_KEY = 'hfos.business';
/** Where the person's steps on Facebook are noted, kept until they sign out (./session.ts, ./noting.ts). */
export const PLACE_KEY = 'hfos.place';

/** Waiting for you's last answer, with whose it is and when it came (./waiting.ts writes it, the panel reads it). */
export const WAITING_FOR_KEY = 'hfos.waitingFor';

/**
 * Waiting for you (./waiting.ts): the changes that can move what waits for the person: a message drafted, OK'd, skipped or sent; a step handed over
 * or cleared; a friend request answered, saved, marked or set aside; a step noted; a download brought in; their pushes
 * choice or hours; their training wheels ended.
 */
export const WAITING_EVENTS: ReadonlySet<string> = new Set([
  'outreach.send.queued',
  'outreach.send.approved',
  'outreach.send.skipped',
  'outreach.send.done',
  'outreach.need.noted',
  'outreach.need.cleared',
  'outreach.request.set_aside',
  'outreach.friend.answered',
  'outreach.friend.marked',
  'outreach.friends.saved',
  'outreach.touch.saved',
  'outreach.download.saved',
  'outreach.automation.saved',
  'outreach.wheels.ended',
  // An ask that no longer needs the person (decision 43). One that newly does, this computer's runner of asks tells
  // itself (../asks/run.ts): its every line isn't worth a look.
  'outreach.ask.replied',
  'outreach.ask.ended',
  'outreach.ask.cancelled',
]);

/**
 * What the person asks of their computer from HandsFreeOS (decision 43, ../asks/run.ts): an ask made, which this
 * computer takes when it's the one that works; and one stopped or answered, which reaches the ask under way.
 */
export const ASK_EVENTS: ReadonlySet<string> = new Set([
  'outreach.ask.made',
  'outreach.ask.cancelled',
  'outreach.ask.replied',
]);

/**
 * Of those, the ones heard whoever made them: an owner or admin may change the person's pushes, hours or training
 * wheels (decision 39), and the live channel names only who did it, not whose they were.
 */
export const WAITING_ANY_ACTOR: ReadonlySet<string> = new Set([
  'outreach.automation.saved',
  'outreach.wheels.ended',
]);

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
