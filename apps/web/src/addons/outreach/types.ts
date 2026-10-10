/**
 * Social Outreach's answers, as its screens get them from the API (packages/api-client, generated from the add-on's
 * operations in packages/core/src/addons/outreach/ops).
 */
import type { Ok } from '@/lib/api/types';

export type PlaybookList = Ok<'/v1/queries/outreach.playbook.list'>;
export type Playbook = PlaybookList['playbooks'][number];
export type PersonSocial = Ok<'/v1/queries/outreach.person'>;
export type Activity = Ok<'/v1/queries/outreach.activity'>;
export type Friends = Ok<'/v1/queries/outreach.friends'>;
export type Friend = Friends['people'][number];
export type Chats = Ok<'/v1/queries/outreach.chats'>;
export type Chat = Chats['chats'][number];
export type Groups = Ok<'/v1/queries/outreach.groups'>;
export type Group = Groups['groups'][number];
export type TodayList = Ok<'/v1/queries/outreach.today'>;
export type TodayItem = TodayList['items'][number];
/** Who's on training wheels, for owners and admins (packages/core/src/addons/outreach/automation.ts). */
export type WheelsList = Ok<'/v1/queries/outreach.wheels'>;
export type Tidy = Ok<'/v1/queries/outreach.friends.tidy'>;
export type Openers = Ok<'/v1/queries/outreach.openers'>;
