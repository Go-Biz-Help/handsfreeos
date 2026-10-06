/**
 * Social Outreach's answers, as its screens get them from the API (packages/api-client, generated from the add-on's
 * operations in packages/core/src/addons/outreach/ops).
 */
import type { Ok } from '@/lib/api/types';

export type PlaybookList = Ok<'/v1/queries/outreach.playbook.list'>;
export type Playbook = PlaybookList['playbooks'][number];
export type PersonSocial = Ok<'/v1/queries/outreach.person'>;
export type Activity = Ok<'/v1/queries/outreach.activity'>;
