/**
 * Contractor Operations' answers, as its screens get them from the API (packages/api-client, generated from the
 * add-on's schemas in packages/core/src/addons/contractor/schemas.ts).
 */
import type { Ok } from '@/lib/api/types';

export type Overview = Ok<'/v1/queries/contractor.overview'>;
export type JobList = Ok<'/v1/queries/contractor.job.list'>;
export type JobRow = JobList['jobs'][number];
export type JobDetail = Ok<'/v1/queries/contractor.job.get'>;
export type JobPhase = JobDetail['phaseList'][number];
export type JobMoney = NonNullable<JobDetail['money']>;
export type PropertyList = Ok<'/v1/queries/contractor.property.list'>;
export type PropertyItem = PropertyList['properties'][number];

/** Someone on the business's team, as the people pickers list them. */
export interface Teammate {
  readonly userId: string;
  readonly name: string;
}
