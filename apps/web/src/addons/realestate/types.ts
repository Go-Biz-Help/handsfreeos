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
