/**
 * What the side panel asks the background worker about HandsFreeOS, and what it answers. The background holds the
 * sign-in and makes every call to HandsFreeOS (./session.ts), so the panels open in different windows share one
 * sign-in and never refresh it twice at once. Both ends are the extension's own; Facebook's tabs never see these.
 */
import type { ProfileCheck, ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import type { ProfileUsernamesSaveInput } from '@hfos/core/addons/outreach/profile-parts';
import type { paths } from '@hfos/api-client';
import type { JoinAnswerInput, JoinAnswerOutput } from '@hfos/core/addons/outreach/group-checks';
import type { LikePickInput, LikePickOutput } from '@hfos/core/addons/outreach/like-pick';
import type { TodayDraftInput, TodayDraftOutput } from '@hfos/core/addons/outreach/today';
import type { DailyStep } from '@hfos/core/addons/outreach/limits';
import type { ReadyItem, ReadyState } from '@hfos/core/addons/outreach/readiness';
import type { ListMark, ListsSaved } from '@hfos/core/addons/outreach/lists';
import type { Platform } from '@hfos/core/addons/outreach/networks';
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

/** Chats read in Messenger for the AI (packages/core/src/addons/outreach/chat-collect.ts). */
export type ChatsCollectInput = Body<'/v1/commands/outreach.chats.collect'>;
export type ChatsCollected = Ok<'/v1/commands/outreach.chats.collect'>;
/** What the person's computer found of some usernames, kept on their check (decision 84). */
export type UsernamesSaved = Ok<'/v1/commands/outreach.profile.usernames_save'>;
export type Me = Ok<'/v1/queries/account.me'>;
/** A step noted on Facebook, and the day's numbers (packages/core/src/addons/outreach/activity.ts). */
export type TouchInput = Body<'/v1/commands/outreach.touch.save'>;
export type TouchSaved = Ok<'/v1/commands/outreach.touch.save'>;
export type Activity = Ok<'/v1/queries/outreach.activity'>;
/** Friends (packages/core/src/addons/outreach/friends.ts): an answer to a request, and a list saved. */
export type FriendNoteInput = Body<'/v1/commands/outreach.friend.note'>;
export type FriendNoted = Ok<'/v1/commands/outreach.friend.note'>;
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
/** Every network's latest check of the person's own profile (decision 99): what the read on its own goes by. */
export type Profiles = Ok<'/v1/queries/outreach.profiles'>;
export type TidyCandidate = Tidy['cancel'][number];
export type FriendEndInput = Body<'/v1/commands/outreach.friend.end'>;
/** A note of what a job saw on a page (decision 74, src/jobs/report.ts). */
export type ReportSaveInput = Body<'/v1/commands/problem_report.send'>;
export type ReportSaved = Ok<'/v1/commands/problem_report.send'>;
export type FriendEnded = Ok<'/v1/commands/outreach.friend.end'>;
/** A warning Facebook showed the person, noted (decision 25). */
export type WarningNoteInput = Body<'/v1/commands/outreach.warning.note'>;
export type WarningNoted = Ok<'/v1/commands/outreach.warning.note'>;
/** Group posts worth a comment, kept and marked (packages/core/src/addons/outreach/posts.ts). */
export type PostsSaveInput = Body<'/v1/commands/outreach.posts.save'>;
export type PostsSaved = Ok<'/v1/commands/outreach.posts.save'>;
/** Chats whose last message is theirs, seen on Facebook (packages/core/src/addons/outreach/alerts.ts). */
export type RepliesNoteInput = Body<'/v1/commands/outreach.replies.note'>;
export type RepliesNoted = Ok<'/v1/commands/outreach.replies.note'>;
/** What the person lets the extension do on its own, and their working hours (packages/core/src/addons/outreach/automation.ts). */
export type Automation = Ok<'/v1/queries/outreach.automation'>;
/**
 * Waiting for you (packages/core/src/addons/outreach/waiting.ts, decisions 40, 42 and 72): everything waiting for the
 * person, counted on the icon and in the panel, and acted on in HandsFreeOS; a step the extension couldn't do handed
 * to them.
 */
export type Waiting = Ok<'/v1/queries/outreach.waiting'>;
export type WaitingItem = Waiting['items'][number];
export type NeedNoteInput = Body<'/v1/commands/outreach.need.note'>;
/** Who to check for a good fit next, and what their pages said (packages/core/src/addons/outreach/checks.ts). */
export type ChecksNextInput = Body<'/v1/queries/outreach.checks.next'>;
export type ChecksNext = Ok<'/v1/queries/outreach.checks.next'>;
export type CheckLookInput = Body<'/v1/commands/outreach.check.look'>;
export type CheckLooked = Ok<'/v1/commands/outreach.check.look'>;
/**
 * Who to look at next on a follow network (Instagram's) to see whether they followed back: those the person followed
 * who haven't yet (packages/core/src/addons/outreach/friends.ts, the owner's 21 Oct 2026).
 */
export type FollowBacksNextInput = Body<'/v1/queries/outreach.follow_backs.next'>;
export type FollowBacksNext = Ok<'/v1/queries/outreach.follow_backs.next'>;
/** Who could partner with the business, for the AI's partner check (decision 81). */
export type PartnersNextInput = Body<'/v1/queries/outreach.partners.next'>;
export type PartnersNext = Ok<'/v1/queries/outreach.partners.next'>;
export type PartnerLookInput = Body<'/v1/commands/outreach.partner.look'>;
export type PartnerLooked = Ok<'/v1/commands/outreach.partner.look'>;
export type PartnerSearchesInput = Body<'/v1/queries/outreach.partners.searches'>;
export type PartnerSearches = Ok<'/v1/queries/outreach.partners.searches'>;
export type PartnerLeadsInput = Body<'/v1/commands/outreach.partner.leads'>;
export type PartnerLeadsKept = Ok<'/v1/commands/outreach.partner.leads'>;
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
export type NetworkEngagedInput = Body<'/v1/commands/outreach.engaged.save'>;
export type NetworkEngaged = Ok<'/v1/commands/outreach.engaged.save'>;
export type PostWords = Ok<'/v1/queries/outreach.posts.words'>;
/**
 * People found by topic on Instagram, LinkedIn and Alignable (decision 92, packages/core/src/addons/outreach/finds.ts):
 * the good posts whose likers and commenters to read next, who a post's people, a search or a group showed, who to check
 * next for the AI's found check, and today's searches of Alignable's businesses.
 */
export type PostsPeopleNextInput = Body<'/v1/queries/outreach.posts.people_next'>;
export type PostsPeopleNext = Ok<'/v1/queries/outreach.posts.people_next'>;
export type FindsSaveInput = Body<'/v1/commands/outreach.finds.save'>;
export type FindsSaved = Ok<'/v1/commands/outreach.finds.save'>;
/**
 * Instagram accounts like the business's (decision 110, packages/core/src/addons/outreach/like-yours.ts): what to search
 * for and which kept account to read today, the accounts a search showed, and an account read.
 */
export type LikeYoursNextInput = Body<'/v1/queries/outreach.like_yours.next'>;
export type LikeYoursNext = Ok<'/v1/queries/outreach.like_yours.next'>;
export type LikeYoursFoundInput = Body<'/v1/commands/outreach.like_yours.found'>;
export type LikeYoursFound = Ok<'/v1/commands/outreach.like_yours.found'>;
export type LikeYoursReadInput = Body<'/v1/commands/outreach.like_yours.read'>;
export type LikeYoursRead = Ok<'/v1/commands/outreach.like_yours.read'>;
/**
 * Events near the person on Alignable (decision 112, packages/core/src/addons/outreach/events-near.ts): whether this
 * week's read is due and which events were read lately, and a read noted.
 */
export type EventsNextInput = Body<'/v1/queries/outreach.events.next'>;
export type EventsNext = Ok<'/v1/queries/outreach.events.next'>;
export type EventsReadInput = Body<'/v1/commands/outreach.events.read'>;
export type EventsRead = Ok<'/v1/commands/outreach.events.read'>;
export type FollowersNextInput = Body<'/v1/queries/outreach.followers.next'>;
export type FollowersNext = Ok<'/v1/queries/outreach.followers.next'>;
export type FollowersSaveInput = Body<'/v1/commands/outreach.followers.save'>;
export type FollowersSaved = Ok<'/v1/commands/outreach.followers.save'>;
/** Staying active in the person's Facebook groups (decision 114). */
export type ActiveNextInput = Body<'/v1/queries/outreach.active.next'>;
export type ActiveNext = Ok<'/v1/queries/outreach.active.next'>;
export type ActiveReplyInput = Body<'/v1/commands/outreach.active.reply'>;
export type ActiveReplied = Ok<'/v1/commands/outreach.active.reply'>;
/** Birthdays and new jobs read once a day (decision 108). */
export type OccasionsSaveInput = Body<'/v1/commands/outreach.occasions.save'>;
export type OccasionsSaved = Ok<'/v1/commands/outreach.occasions.save'>;
export type FindsNextInput = Body<'/v1/queries/outreach.finds.next'>;
export type FindsNext = Ok<'/v1/queries/outreach.finds.next'>;
export type FindsSearchesInput = Body<'/v1/queries/outreach.finds.searches'>;
export type FindsSearches = Ok<'/v1/queries/outreach.finds.searches'>;
/** The towns near the person's own on Alignable (decision 115). */
export type FindsTownsInput = Body<'/v1/queries/outreach.finds.towns'>;
export type FindsTowns = Ok<'/v1/queries/outreach.finds.towns'>;
export type { JoinAnswerInput, JoinAnswerOutput, LikePickInput, LikePickOutput };
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
  /**
   * Get ready (decision 63): what's left before the extension reaches anyone for the person, for the panel's card.
   * Null when HandsFreeOS couldn't say; missing from a background before 0.31.
   */
  readonly ready?: ReadyShown | null;
}

/** Get ready's items as the panel shows them (packages/core/src/addons/outreach/readiness.ts). */
export interface ReadyShown {
  readonly ready: boolean;
  readonly items: readonly {
    readonly item: ReadyItem;
    readonly state: ReadyState;
    readonly left: string | null;
  }[];
}

/** Today's steps against the daily limits, and the newest of the day's feed. */
export interface TodaySoFar {
  readonly limits: Readonly<Record<DailyStep, { readonly done: number; readonly most: number }>>;
  readonly steps: readonly { readonly at: string; readonly line: string; readonly kind: string }[];
}

/** A prompt sent: the number to show, and when it runs out. The secret stays in the background. */
export interface PromptStarted {
  readonly requestId: string;
  readonly number: number;
  readonly expiresAt: string;
}

/** A prompt asked about: still waiting, stopped, run out, or signed in. */
export type PromptState =
  | { readonly status: 'waiting' | 'refused' | 'expired' }
  | { readonly status: 'signed-in'; readonly account: Account };

export type HfosAsk =
  | { readonly type: 'hfos-account'; readonly fresh?: boolean }
  | { readonly type: 'hfos-send-code'; readonly email: string }
  | { readonly type: 'hfos-check-code'; readonly email: string; readonly code: string }
  | { readonly type: 'hfos-password'; readonly email: string; readonly password: string }
  /** Send me a prompt: the person's phone and open HandsFreeOS tabs ask for the number shown (./prompt.ts). */
  | { readonly type: 'hfos-prompt-start'; readonly email: string }
  /** Whether the prompt was answered; signed in once the right number was picked. */
  | { readonly type: 'hfos-prompt-check'; readonly requestId: string }
  | { readonly type: 'hfos-sign-out' }
  | { readonly type: 'hfos-pick'; readonly businessId: string }
  | { readonly type: 'hfos-collect-chats'; readonly input: ChatsCollectInput }
  | { readonly type: 'hfos-save-friends'; readonly input: FriendsSaveInput }
  | { readonly type: 'hfos-save-download'; readonly input: DownloadSaveInput }
  | { readonly type: 'hfos-save-groups'; readonly input: GroupsSaveInput }
  /** Whether usernames are free on a network, as their addresses showed (decision 84). */
  | { readonly type: 'hfos-usernames'; readonly input: ProfileUsernamesSaveInput }
  | { readonly type: 'hfos-save-group'; readonly input: GroupSaveInput }
  | { readonly type: 'hfos-groups'; readonly input: GroupsListInput }
  | {
      readonly type: 'hfos-draft';
      readonly workspaceId: string;
      readonly input: TodayDraftInput;
    }
  /** The person's own profile, read here, for the AI's check (decision 64): kept by HandsFreeOS, only its answer. */
  | {
      readonly type: 'hfos-profile-check';
      readonly workspaceId: string;
      readonly input: ProfileRead;
    }
  /** The people to tidy on a network (Facebook's unless said): requests to cancel, LinkedIn's invitations to withdraw. */
  | { readonly type: 'hfos-tidy'; readonly workspaceId: string; readonly platform?: Platform }
  /** Every network's latest check of the person's own profile, for the read on its own on the 1st (decision 99). */
  | { readonly type: 'hfos-profiles'; readonly workspaceId: string }
  /** When the person's own lists were last saved to their end, and one noted now (../auto/lists.ts). */
  /** A network's lists before its first day (Facebook's unless said), and one noted as saved. */
  | { readonly type: 'hfos-lists'; readonly workspaceId: string; readonly platform?: Platform }
  | {
      readonly type: 'hfos-lists-saved';
      readonly workspaceId: string;
      readonly list: ListMark;
      readonly platform?: Platform;
    }
  /**
   * What to search a network's posts with: its runner's Find posts (LinkedIn's post search), and on Instagram the day's
   * hashtags and the area's places.
   */
  | {
      readonly type: 'hfos-post-words';
      readonly workspaceId: string;
      readonly platform: Platform;
      /** Today's round of finding again (decision 126): the next words. */
      readonly round?: number;
    }
  | { readonly type: 'hfos-friend-end'; readonly input: FriendEndInput }
  /** A request the person got that a job deleted (decision 121), noted whether or not noting is on. */
  | { readonly type: 'hfos-friend-note'; readonly input: FriendNoteInput }
  | { readonly type: 'hfos-report'; readonly input: ReportSaveInput }
  | { readonly type: 'hfos-warning'; readonly input: WarningNoteInput }
  | { readonly type: 'hfos-save-posts'; readonly input: PostsSaveInput }
  | { readonly type: 'hfos-checks-next'; readonly input: ChecksNextInput }
  | { readonly type: 'hfos-check-look'; readonly input: CheckLookInput }
  | { readonly type: 'hfos-follow-backs-next'; readonly input: FollowBacksNextInput }
  | { readonly type: 'hfos-partners-next'; readonly input: PartnersNextInput }
  | { readonly type: 'hfos-partner-look'; readonly input: PartnerLookInput }
  /** Today's searches for partners on a network, and who one found (stage 4 of the partners plan). */
  | { readonly type: 'hfos-partner-searches'; readonly input: PartnerSearchesInput }
  | { readonly type: 'hfos-partner-leads'; readonly input: PartnerLeadsInput }
  /**
   * People found by topic (decision 92): which good posts' likers and commenters to read next, who a post's people, a
   * search or a group's members showed, who to check next for the AI, and today's searches of Alignable's businesses.
   */
  | { readonly type: 'hfos-posts-people-next'; readonly input: PostsPeopleNextInput }
  | { readonly type: 'hfos-finds-save'; readonly input: FindsSaveInput }
  | { readonly type: 'hfos-occasions-save'; readonly input: OccasionsSaveInput }
  /** Instagram accounts like the business's (decision 110): what to do next, what a search showed, one read. */
  | { readonly type: 'hfos-like-yours-next'; readonly input: LikeYoursNextInput }
  | { readonly type: 'hfos-like-yours-found'; readonly input: LikeYoursFoundInput }
  | { readonly type: 'hfos-like-yours-read'; readonly input: LikeYoursReadInput }
  /** Events near the person on Alignable (decision 112): whether this week's read is due, and a read noted. */
  | { readonly type: 'hfos-events-next'; readonly input: EventsNextInput }
  | { readonly type: 'hfos-events-read'; readonly input: EventsReadInput }
  /** The person's own followers on Facebook (decision 113): whether this week's read is due, and a part of it saved. */
  | { readonly type: 'hfos-followers-next'; readonly input: FollowersNextInput }
  | { readonly type: 'hfos-followers-save'; readonly input: FollowersSaveInput }
  /**
   * Staying active in the person's Facebook groups (decision 114): what today's likes and question there are, and the
   * question kept for the day's reply.
   */
  | { readonly type: 'hfos-active-next'; readonly input: ActiveNextInput }
  | { readonly type: 'hfos-active-reply'; readonly input: ActiveReplyInput }
  | { readonly type: 'hfos-finds-next'; readonly input: FindsNextInput }
  | { readonly type: 'hfos-finds-searches'; readonly input: FindsSearchesInput }
  /** The towns within 25 miles of the person's own on Alignable, the closest first, and today's to search in (decision 115). */
  | { readonly type: 'hfos-finds-towns'; readonly input: FindsTownsInput }
  /**
   * Groups to check and to join, and how one went: Facebook's unless the input says its network (`platform`), as
   * Alignable's groups do (decision 92).
   */
  | { readonly type: 'hfos-groups-to-check'; readonly input: GroupsToCheckInput }
  | { readonly type: 'hfos-group-look'; readonly input: GroupLookInput }
  | { readonly type: 'hfos-joins-next'; readonly input: JoinsNextInput }
  | { readonly type: 'hfos-join-note'; readonly input: JoinNoteInput }
  | { readonly type: 'hfos-helpful-ask'; readonly input: HelpfulAskInput }
  | { readonly type: 'hfos-helpful-next'; readonly input: HelpfulNextInput }
  | { readonly type: 'hfos-helpful-posted'; readonly input: HelpfulPostedInput }
  | { readonly type: 'hfos-helpful-engaged'; readonly input: HelpfulEngagedInput }
  | { readonly type: 'hfos-engaged-save'; readonly input: NetworkEngagedInput }
  /** Who wrote last in the chats a job read (Instagram's Read my chats), as a tab tells of them as the person goes. */
  | { readonly type: 'hfos-replies-note'; readonly input: RepliesNoteInput }
  | {
      readonly type: 'hfos-join-answers';
      readonly workspaceId: string;
      readonly input: JoinAnswerInput;
    }
  /** Which of someone's posts to like before their friend request (src/auto/run.ts). */
  | { readonly type: 'hfos-like-pick'; readonly workspaceId: string; readonly input: LikePickInput }
  | { readonly type: 'hfos-auto' }
  | { readonly type: 'hfos-auto-start' }
  | { readonly type: 'hfos-auto-stop' }
  /**
   * What waits, asked again now (src/hfos/waiting.ts), for the panel's count. What waits is answered in HandsFreeOS,
   * never from the panel (decision 72).
   */
  | { readonly type: 'hfos-waiting' }
  /** The person has the panel open on this computer: it becomes the one that works (./live.ts). */
  | { readonly type: 'hfos-here' }
  /** Stop, for an ask under way (../asks/run.ts). Carry on and Skip are pressed in HandsFreeOS. */
  | { readonly type: 'hfos-ask-stop'; readonly askId?: string };

/** What each ask answers with. */
export interface HfosValues {
  readonly 'hfos-account': Account;
  readonly 'hfos-send-code': null;
  readonly 'hfos-check-code': Account;
  readonly 'hfos-password': Account;
  readonly 'hfos-prompt-start': PromptStarted;
  readonly 'hfos-prompt-check': PromptState;
  readonly 'hfos-sign-out': Account;
  readonly 'hfos-pick': Account;
  readonly 'hfos-collect-chats': ChatsCollected;
  readonly 'hfos-save-friends': FriendsSaved;
  readonly 'hfos-save-download': DownloadSaved;
  readonly 'hfos-save-groups': GroupsSaved;
  readonly 'hfos-usernames': UsernamesSaved;
  readonly 'hfos-save-group': GroupSaved;
  readonly 'hfos-groups': GroupsList;
  readonly 'hfos-draft': Drafts;
  readonly 'hfos-profile-check': ProfileCheck;
  readonly 'hfos-tidy': Tidy;
  readonly 'hfos-profiles': Profiles;
  readonly 'hfos-lists': ListsSaved;
  readonly 'hfos-lists-saved': ListsSaved;
  readonly 'hfos-post-words': PostWords;
  readonly 'hfos-friend-end': FriendEnded;
  readonly 'hfos-friend-note': FriendNoted;
  readonly 'hfos-report': ReportSaved;
  readonly 'hfos-warning': WarningNoted;
  readonly 'hfos-save-posts': PostsSaved;
  readonly 'hfos-checks-next': ChecksNext;
  readonly 'hfos-check-look': CheckLooked;
  readonly 'hfos-follow-backs-next': FollowBacksNext;
  readonly 'hfos-partners-next': PartnersNext;
  readonly 'hfos-partner-look': PartnerLooked;
  readonly 'hfos-partner-searches': PartnerSearches;
  readonly 'hfos-partner-leads': PartnerLeadsKept;
  readonly 'hfos-posts-people-next': PostsPeopleNext;
  readonly 'hfos-finds-save': FindsSaved;
  readonly 'hfos-occasions-save': OccasionsSaved;
  readonly 'hfos-like-yours-next': LikeYoursNext;
  readonly 'hfos-like-yours-found': LikeYoursFound;
  readonly 'hfos-like-yours-read': LikeYoursRead;
  readonly 'hfos-events-next': EventsNext;
  readonly 'hfos-events-read': EventsRead;
  readonly 'hfos-followers-next': FollowersNext;
  readonly 'hfos-followers-save': FollowersSaved;
  readonly 'hfos-active-next': ActiveNext;
  readonly 'hfos-active-reply': ActiveReplied;
  readonly 'hfos-finds-next': FindsNext;
  readonly 'hfos-finds-searches': FindsSearches;
  readonly 'hfos-finds-towns': FindsTowns;
  readonly 'hfos-groups-to-check': GroupsToCheck;
  readonly 'hfos-group-look': GroupLooked;
  readonly 'hfos-joins-next': JoinsNext;
  readonly 'hfos-join-note': JoinNoted;
  readonly 'hfos-helpful-ask': HelpfulAsked;
  readonly 'hfos-helpful-next': HelpfulNext;
  readonly 'hfos-helpful-posted': HelpfulPosted;
  readonly 'hfos-helpful-engaged': HelpfulEngaged;
  readonly 'hfos-engaged-save': NetworkEngaged;
  readonly 'hfos-replies-note': RepliesNoted;
  readonly 'hfos-join-answers': JoinAnswerOutput;
  readonly 'hfos-like-pick': LikePickOutput;
  readonly 'hfos-auto': AutoStatus;
  readonly 'hfos-auto-start': AutoStatus;
  readonly 'hfos-auto-stop': AutoStatus;
  readonly 'hfos-waiting': Waiting | null;
  readonly 'hfos-here': null;
  readonly 'hfos-ask-stop': null;
}

export const HFOS_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>([
  'hfos-account',
  'hfos-send-code',
  'hfos-check-code',
  'hfos-password',
  'hfos-prompt-start',
  'hfos-prompt-check',
  'hfos-sign-out',
  'hfos-pick',
  'hfos-auto',
  'hfos-auto-start',
  'hfos-auto-stop',
  'hfos-waiting',
  'hfos-here',
  'hfos-ask-stop',
]);

/** The panel's ask about the ask under way (src/asks/run.ts): Stop. */
export const ASK_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>(['hfos-ask-stop']);

/** The panel's ask about what waits (src/hfos/waiting.ts): a look, for its count. */
export const WAITING_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>(['hfos-waiting']);

/** The asks the runner that works on its own answers (src/auto/run.ts). */
export const AUTO_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>([
  'hfos-auto',
  'hfos-auto-start',
  'hfos-auto-stop',
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
  'outreach.request.answered',
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
  // A code from their email typed in HandsFreeOS: the ask under way takes it at once.
  'outreach.ask.coded',
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
