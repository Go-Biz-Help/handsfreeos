/**
 * Contractor Operations, server side: its commands and queries (docs/contractor.md, docs/addon-architecture.md). Each
 * is an ordinary kernel operation stamped with the add-on, so it's refused, for every kind of actor, while the add-on
 * is off, and everything it does is its own in history. The business logic lives here: never in its screens, never
 * in a prompt.
 *
 * Every operation a person runs declares `ai`, so the Assistant can do whatever the screens do (the owner's rule,
 * 2026-10-26). Its settings are saved by core's `addon.save_settings`, which the Assistant already covers.
 */
import type { AddonServerModule } from '../server';
import { contractorAddon } from './manifest';
import { jobCosting, otherCostAdd, otherCostRemove, profit } from './ops/costing';
import { crewArchive, crewList, crewSave } from './ops/crews';
import { dispatch } from './ops/dispatch';
import {
  estimateAskOk,
  estimateBuilder,
  estimateFillJob,
  estimateList,
  estimateOk,
  estimateSave,
  estimateSendBuilt,
  estimatingSave,
  itemCostList,
  itemCostSet,
} from './ops/estimates';
import {
  jobFollowVisit,
  jobMakeProject,
  jobOpen,
  jobSetMoney,
  jobSetPercent,
  jobSetStatus,
  jobTeamAdd,
  jobTeamRemove,
  jobUpdate,
  propertyAdd,
} from './ops/jobs';
import {
  materialAdd,
  materialList,
  materialRemove,
  materialSetCost,
  materialStampCost,
  materialUpdate,
} from './ops/materials';
import { phaseAdd, phaseRemove, phaseReorder, phaseUpdate } from './ops/phases';
import { jobGet, jobList, overview, propertyList } from './ops/queries';
import {
  laborRateList,
  laborRateSet,
  timeAdd,
  timeFix,
  timeFollowStatus,
  timeList,
  timeRemove,
  timeSetBreak,
  timeStampCosts,
  timeStopOverrun,
} from './ops/time';
import {
  workOrderGet,
  workOrderItemAdd,
  workOrderItemRemove,
  workOrderItemSet,
  workOrderItemUpdate,
  workOrderSetCrew,
  workOrderStart,
  workOrderSubAdd,
  workOrderSubRemove,
  workOrderSubSet,
  workOrderTellSubs,
  workOrderUpdate,
} from './ops/work-orders';

export const contractorAddonServer: AddonServerModule = {
  manifest: contractorAddon,
  commands: [
    jobOpen,
    jobUpdate,
    jobSetStatus,
    jobSetPercent,
    jobTeamAdd,
    jobTeamRemove,
    jobMakeProject,
    jobSetMoney,
    propertyAdd,
    phaseAdd,
    phaseUpdate,
    phaseRemove,
    phaseReorder,
    jobFollowVisit,
    estimateSave,
    estimateAskOk,
    estimateOk,
    estimateSendBuilt,
    estimatingSave,
    itemCostSet,
    estimateFillJob,
    crewSave,
    crewArchive,
    workOrderStart,
    workOrderUpdate,
    workOrderSetCrew,
    workOrderSubAdd,
    workOrderSubRemove,
    workOrderSubSet,
    workOrderTellSubs,
    workOrderItemAdd,
    workOrderItemUpdate,
    workOrderItemRemove,
    workOrderItemSet,
    materialAdd,
    materialUpdate,
    materialRemove,
    materialSetCost,
    materialStampCost,
    timeFollowStatus,
    timeSetBreak,
    timeFix,
    timeAdd,
    timeRemove,
    timeStampCosts,
    timeStopOverrun,
    laborRateSet,
    otherCostAdd,
    otherCostRemove,
  ],
  queries: [
    overview,
    jobList,
    jobGet,
    propertyList,
    estimateBuilder,
    estimateList,
    itemCostList,
    crewList,
    workOrderGet,
    dispatch,
    materialList,
    timeList,
    laborRateList,
    jobCosting,
    profit,
  ],
  notForTheAssistant: {},
};
