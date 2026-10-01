/**
 * Real Estate Agent's answers, as its screens get them from the API (packages/api-client, generated from the
 * add-on's schemas in packages/core/src/addons/realestate/schemas.ts).
 */
import type { Ok } from '@/lib/api/types';

export type DealList = Ok<'/v1/queries/realestate.deal.list'>;
export type DealRow = DealList['deals'][number];
export type DealGet = Ok<'/v1/queries/realestate.deal.get'>;
export type DealDuty = DealGet['duties'][number];
export type DealTerm = DealGet['terms'][number];
export type DealHistory = Ok<'/v1/queries/realestate.deal.history'>;
export type DealRisks = Ok<'/v1/queries/realestate.deal.risks'>;
export type TermHistory = Ok<'/v1/queries/realestate.term.history'>;
export type DutyGet = Ok<'/v1/queries/realestate.duty.get'>;
export type DutyList = Ok<'/v1/queries/realestate.duty.list'>;
export type DutyRow = DutyList['duties'][number];
export type DocumentList = Ok<'/v1/queries/realestate.document.list'>;
export type DealDocument = DocumentList['documents'][number];
export type DraftList = Ok<'/v1/queries/realestate.status_email.list'>;
export type Draft = DraftList['drafts'][number];
export type DraftGet = Ok<'/v1/queries/realestate.status_email.get'>;
export type TemplateList = Ok<'/v1/queries/realestate.template.list'>;
export type TemplateItem = TemplateList['items'][number];
export type TemplateVersions = Ok<'/v1/queries/realestate.template.versions'>;
export type TemplateDiff = Ok<'/v1/queries/realestate.template.diff'>;

/** Someone in the business, as a picker lists them. */
export interface Teammate {
  readonly id: string;
  readonly fullName: string;
}

// Round two: the buyer's side.
export type BuyerProfile = NonNullable<Ok<'/v1/queries/realestate.buyer_profile.get'>['profile']>;
export type HomeList = Ok<'/v1/queries/realestate.homes'>;
export type Home = HomeList['homes'][number];
export type MemoryList = Ok<'/v1/queries/realestate.memory'>;
export type MemoryItem = MemoryList['items'][number];
export type TourList = Ok<'/v1/queries/realestate.tours'>;
export type Tour = TourList['tours'][number];
export type TourStop = Tour['stops'][number];
export type CmaList = Ok<'/v1/queries/realestate.cmas'>;
export type CmaRow = CmaList['cmas'][number];
export type Cma = Ok<'/v1/queries/realestate.cma'>['cma'];
export type CmaComp = Cma['comps'][number];
export type OfferList = Ok<'/v1/queries/realestate.offers'>;
export type Offer = OfferList['offers'][number];
export type OfferVersion = Offer['versions'][number];
export type Financing = Ok<'/v1/queries/realestate.financing'>;
export type FinancingStep = Financing['steps'][number];
export type Inspections = Ok<'/v1/queries/realestate.inspections'>;
export type Inspection = Inspections['inspections'][number];
export type Finding = Inspection['findings'][number];
export type ClientTaskList = Ok<'/v1/queries/realestate.client_tasks'>;
export type ClientTask = ClientTaskList['tasks'][number];
export type DealClient = ClientTaskList['clients'][number];

/** A buyer deal's own side, as the deal page reads it. */
export interface BuyerSide {
  readonly profile: BuyerProfile | null;
  readonly memory: MemoryList;
  readonly homes: readonly Home[];
  readonly tours: TourList;
  readonly financing: Financing;
  readonly tasks: ClientTaskList;
  readonly offers: readonly Offer[];
  readonly cmas: readonly CmaRow[];
}
