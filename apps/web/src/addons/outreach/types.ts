/**
 * Social Outreach's answers, as its screens get them from the API (packages/api-client, generated from the add-on's
 * operations in packages/core/src/addons/outreach/ops).
 */
import type { Ok } from '@/lib/api/types';

export type PlaybookList = Ok<'/v1/queries/outreach.playbook.list'>;
export type Playbook = PlaybookList['playbooks'][number];
export type PersonSocial = Ok<'/v1/queries/outreach.person'>;
export type Activity = Ok<'/v1/queries/outreach.activity'>;
export type Tracking = Ok<'/v1/queries/outreach.tracking'>;
export type Friends = Ok<'/v1/queries/outreach.friends'>;
export type Friend = Friends['people'][number];
export type Chats = Ok<'/v1/queries/outreach.chats'>;
export type Chat = Chats['chats'][number];
export type Groups = Ok<'/v1/queries/outreach.groups'>;
/** What each way of finding people found this week, for Find people (decision 128). */
export type FindsWeek = Ok<'/v1/queries/outreach.finds.week'>;
export type Group = Groups['groups'][number];
export type TodayList = Ok<'/v1/queries/outreach.today'>;
/** Get ready (packages/core/src/addons/outreach/readiness.ts, decision 63): what's left before the extension reaches anyone. */
export type Readiness = Ok<'/v1/queries/outreach.readiness'>;
/** Today's helpful post and those up lately (decision 50). */
export type HelpfulList = Ok<'/v1/queries/outreach.helpful'>;
export type TodayItem = TodayList['items'][number];
/** Everyone the person reached, by where they stand (packages/core/src/addons/outreach/stages.ts). */
export type Pipeline = Ok<'/v1/queries/outreach.stages'>;
export type PipelinePerson = Pipeline['people'][number];
/** Who's on training wheels, for owners and admins (packages/core/src/addons/outreach/automation.ts). */
export type WheelsList = Ok<'/v1/queries/outreach.wheels'>;
export type Tidy = Ok<'/v1/queries/outreach.friends.tidy'>;
export type Openers = Ok<'/v1/queries/outreach.openers'>;
/** Someone's choices for the extension, inside the business's rules (packages/core/src/addons/outreach/automation.ts). */
export type Automation = Ok<'/v1/queries/outreach.automation'>;
export type AutomationPeople = Ok<'/v1/queries/outreach.automation.people'>;
/** The person's extension right now, their day and today's steps (packages/core/src/addons/outreach/live.ts). */
export type Live = Ok<'/v1/queries/outreach.live'>;
/** Each person's status for owners and admins: never their lines, feed or messages. */
export type LiveTeam = Ok<'/v1/queries/outreach.live.team'>;
/**
 * Everything waiting for the person: replies handed over, messages to OK, steps the extension needs them for, and
 * friend requests to decide (packages/core/src/addons/outreach/waiting.ts).
 */
export type Waiting = Ok<'/v1/queries/outreach.waiting'>;
export type WaitingItem = Waiting['items'][number];
/**
 * What the person asked their computer to do from HandsFreeOS, today's and the open ones, with the computer that does
 * them (packages/core/src/addons/outreach/asks.ts).
 */
export type Asks = Ok<'/v1/queries/outreach.asks'>;
export type Ask = Asks['asks'][number];
/** The person's own Social Outreach setup (packages/core/src/addons/outreach/setup.ts). */
export type Setup = Ok<'/v1/queries/outreach.setup'>;
/** The person's Partners list, by stage (packages/core/src/addons/outreach/partners.ts, decision 81). */
export type Partners = Ok<'/v1/queries/outreach.partners'>;
export type PartnerListRow = Partners['partners'][number];
/** A group's own page (decision 103): who was found there and how each turned out. */
export type GroupPeople = Ok<'/v1/queries/outreach.group.people'>;
