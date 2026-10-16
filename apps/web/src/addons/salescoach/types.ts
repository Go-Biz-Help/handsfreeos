/**
 * AI Sales Coach's answers, as its screens get them from the API (packages/api-client, generated from the add-on's
 * operations in packages/core/src/addons/salescoach/ops).
 */
import type { Ok } from '@/lib/api/types';

export type PlaybookList = Ok<'/v1/queries/salescoach.playbook.list'>;
export type Playbook = PlaybookList['playbooks'][number];
export type CoachedCalls = Ok<'/v1/queries/salescoach.call.list'>;
export type CoachedCallSummary = CoachedCalls['calls'][number];
export type CoachedCall = Ok<'/v1/queries/salescoach.call.get'>['call'];
export type CoachTrends = Ok<'/v1/queries/salescoach.trends'>;
export type CoachTrend = CoachTrends['team'];
