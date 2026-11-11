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

export type EstimateBuilderData = Ok<'/v1/queries/contractor.estimate.get'>;
/** Whether an estimate can go out, and what it's waiting on, as the server worked it out. */
export type MarginCheck = NonNullable<EstimateBuilderData['check']>;
export type Estimating = EstimateBuilderData['estimating'];
export type EstimateList = Ok<'/v1/queries/contractor.estimate.list'>;
export type EstimateItem = EstimateList['estimates'][number];
export type ItemCostList = Ok<'/v1/queries/contractor.item_cost.list'>;
export type ItemCost = ItemCostList['items'][number];

export type CrewList = Ok<'/v1/queries/contractor.crew.list'>;
export type Crew = CrewList['crews'][number];
export type WorkOrder = Ok<'/v1/queries/contractor.work_order.get'>;
export type ChecklistItem = WorkOrder['items'][number];
export type VisitSub = WorkOrder['subs'][number];
export type Dispatch = Ok<'/v1/queries/contractor.dispatch'>;
export type DispatchVisit = Dispatch['visits'][number];
export type JobVisit = JobDetail['visits'][number];

export type MaterialList = Ok<'/v1/queries/contractor.material.list'>;
/** A material on a job, with what one costs when the person may see job costs. */
export type Material = MaterialList['materials'][number];
export type MaterialCosting = NonNullable<MaterialList['costing']>;
/** A material as a visit's work order has it: never with a cost. */
export type VisitMaterial = WorkOrder['materials'][number];

export type TimeList = Ok<'/v1/queries/contractor.time.list'>;
/** One stretch of one person's time on a job: never with what it cost. */
export type TimeEntry = TimeList['entries'][number];
export type JobCosting = Ok<'/v1/queries/contractor.job.costing'>;
export type OtherCost = JobCosting['otherCosts'][number];
export type LaborRateList = Ok<'/v1/queries/contractor.labor_rate.list'>;
export type LaborRate = LaborRateList['people'][number];
export type Profit = Ok<'/v1/queries/contractor.profit'>;
export type ProfitRow = Profit['rows'][number];
