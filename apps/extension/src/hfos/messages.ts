/**
 * What the side panel asks the background worker about HandsFreeOS, and what it answers. The background holds the
 * sign-in and makes every call to HandsFreeOS (./session.ts), so the panels open in different windows share one
 * sign-in and never refresh it twice at once. Both ends are the extension's own; Facebook's tabs never see these.
 */
import type { paths } from '@hfos/api-client';
import type { TodayDraftInput, TodayDraftOutput } from '@hfos/core/addons/outreach/today';
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

/** Social Outreach's look-up and saves (packages/core/src/addons/outreach/saves.ts), as the API takes and answers them. */
export type LookupInput = Body<'/v1/queries/outreach.lookup'>;
export type Lookup = Ok<'/v1/queries/outreach.lookup'>;
export type ProfileInput = Body<'/v1/commands/outreach.profile.save'>;
export type ProfileSaved = Ok<'/v1/commands/outreach.profile.save'>;
export type ChatInput = Body<'/v1/commands/outreach.chat.save'>;
export type ChatSaved = Ok<'/v1/commands/outreach.chat.save'>;
/** Chats read in Messenger for the AI (packages/core/src/addons/outreach/chat-collect.ts). */
export type ChatsCollectInput = Body<'/v1/commands/outreach.chats.collect'>;
export type ChatsCollected = Ok<'/v1/commands/outreach.chats.collect'>;
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
/** A part of Facebook's download file, brought in (packages/core/src/addons/outreach/download.ts). */
export type DownloadSaveInput = Body<'/v1/commands/outreach.download.save'>;
export type DownloadSaved = Ok<'/v1/commands/outreach.download.save'>;
/** The business's playbooks, which the requests on a page are sorted by (packages/core/src/addons/outreach/fit.ts). */
export type Playbooks = Ok<'/v1/queries/outreach.playbook.list'>;
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
/** Group posts worth a comment, kept and marked, and one put aside (packages/core/src/addons/outreach/posts.ts). */
export type PostsSaveInput = Body<'/v1/commands/outreach.posts.save'>;
export type PostsSaved = Ok<'/v1/commands/outreach.posts.save'>;
export type PostMark = PostsSaved['posts'][number];
export type PostSkipInput = Body<'/v1/commands/outreach.post.skip'>;
export type PostSkipped = Ok<'/v1/commands/outreach.post.skip'>;
/** Which opener a copied draft was, and a demo marked booked (packages/core/src/addons/outreach/openers.ts, demos.ts). */
export type OpenerUseInput = Body<'/v1/commands/outreach.opener.use'>;
export type OpenerUsed = Ok<'/v1/commands/outreach.opener.use'>;
export type DemoMarkInput = Body<'/v1/commands/outreach.demo.mark'>;
export type DemoMarked = Ok<'/v1/commands/outreach.demo.mark'>;
/** Chats whose last message is theirs, seen on Facebook (packages/core/src/addons/outreach/alerts.ts). */
export type RepliesNoteInput = Body<'/v1/commands/outreach.replies.note'>;
/** What the person lets the extension do on its own, and their working hours (packages/core/src/addons/outreach/automation.ts). */
export type Automation = Ok<'/v1/queries/outreach.automation'>;
export type AutomationSaveInput = Body<'/v1/commands/outreach.automation.save'>;
/** Messages the extension drafted to send, OK'd or skipped (packages/core/src/addons/outreach/sends.ts). */
export type SendQueueInput = Body<'/v1/commands/outreach.send.queue'>;
export type SendQueued = Ok<'/v1/commands/outreach.send.queue'>;
export type SendApproveInput = Body<'/v1/commands/outreach.send.approve'>;
export type SendApproved = Ok<'/v1/commands/outreach.send.approve'>;
export type SendSkipInput = Body<'/v1/commands/outreach.send.skip'>;
export type SendSkipped = Ok<'/v1/commands/outreach.send.skip'>;
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
  | { readonly type: 'hfos-collect-chats'; readonly input: ChatsCollectInput }
  | { readonly type: 'hfos-save-friends'; readonly input: FriendsSaveInput }
  | { readonly type: 'hfos-set-friend'; readonly input: FriendSetInput }
  | { readonly type: 'hfos-save-download'; readonly input: DownloadSaveInput }
  | { readonly type: 'hfos-playbooks'; readonly workspaceId: string }
  | { readonly type: 'hfos-save-groups'; readonly input: GroupsSaveInput }
  | { readonly type: 'hfos-save-group'; readonly input: GroupSaveInput }
  | { readonly type: 'hfos-groups'; readonly input: GroupsListInput }
  | { readonly type: 'hfos-today-list'; readonly workspaceId: string }
  | {
      readonly type: 'hfos-draft';
      readonly workspaceId: string;
      readonly input: TodayDraftInput;
    }
  | { readonly type: 'hfos-tidy'; readonly workspaceId: string }
  | { readonly type: 'hfos-friend-end'; readonly input: FriendEndInput }
  | { readonly type: 'hfos-warning'; readonly input: WarningNoteInput }
  | { readonly type: 'hfos-save-posts'; readonly input: PostsSaveInput }
  | { readonly type: 'hfos-post-skip'; readonly input: PostSkipInput }
  | { readonly type: 'hfos-opener-use'; readonly input: OpenerUseInput }
  | { readonly type: 'hfos-demo-mark'; readonly input: DemoMarkInput }
  | { readonly type: 'hfos-today' }
  | { readonly type: 'hfos-noting'; readonly on: boolean }
  | { readonly type: 'hfos-auto' }
  | { readonly type: 'hfos-auto-save'; readonly input: AutomationSaveInput }
  | { readonly type: 'hfos-auto-start' }
  | { readonly type: 'hfos-auto-stop' }
  | { readonly type: 'hfos-send-ok'; readonly input: SendApproveInput }
  | { readonly type: 'hfos-send-skip'; readonly input: SendSkipInput };

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
  readonly 'hfos-collect-chats': ChatsCollected;
  readonly 'hfos-save-friends': FriendsSaved;
  readonly 'hfos-set-friend': FriendSet;
  readonly 'hfos-save-download': DownloadSaved;
  readonly 'hfos-playbooks': Playbooks;
  readonly 'hfos-save-groups': GroupsSaved;
  readonly 'hfos-save-group': GroupSaved;
  readonly 'hfos-groups': GroupsList;
  readonly 'hfos-today-list': TodayList;
  readonly 'hfos-draft': Drafts;
  readonly 'hfos-tidy': Tidy;
  readonly 'hfos-friend-end': FriendEnded;
  readonly 'hfos-warning': WarningNoted;
  readonly 'hfos-save-posts': PostsSaved;
  readonly 'hfos-post-skip': PostSkipped;
  readonly 'hfos-opener-use': OpenerUsed;
  readonly 'hfos-demo-mark': DemoMarked;
  readonly 'hfos-today': Today;
  readonly 'hfos-noting': Today;
  readonly 'hfos-auto': AutoStatus;
  readonly 'hfos-auto-save': AutoStatus;
  readonly 'hfos-auto-start': AutoStatus;
  readonly 'hfos-auto-stop': AutoStatus;
  readonly 'hfos-send-ok': SendApproved;
  readonly 'hfos-send-skip': SendSkipped;
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
  'hfos-collect-chats',
  'hfos-save-friends',
  'hfos-set-friend',
  'hfos-save-download',
  'hfos-playbooks',
  'hfos-save-groups',
  'hfos-save-group',
  'hfos-groups',
  'hfos-today-list',
  'hfos-draft',
  'hfos-tidy',
  'hfos-friend-end',
  'hfos-warning',
  'hfos-save-posts',
  'hfos-post-skip',
  'hfos-opener-use',
  'hfos-demo-mark',
  'hfos-today',
  'hfos-noting',
  'hfos-auto',
  'hfos-auto-save',
  'hfos-auto-start',
  'hfos-auto-stop',
  'hfos-send-ok',
  'hfos-send-skip',
]);

/** The asks the runner that works on its own answers (src/auto/run.ts). */
export const AUTO_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>([
  'hfos-auto',
  'hfos-auto-save',
  'hfos-auto-start',
  'hfos-auto-stop',
  'hfos-send-ok',
  'hfos-send-skip',
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
