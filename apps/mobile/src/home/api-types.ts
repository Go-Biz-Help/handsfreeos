import type { paths } from '@hfos/api-client';

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

/** What Let HandsFreeOS Handle would do for an item (`attention.preview_handle`). */
export type HandlePreview = Ok<'/v1/queries/attention.preview_handle'>;
/** A workflow approval as `workflow.approval_list` answers. */
export type ApprovalListItem = Ok<'/v1/queries/workflow.approval_list'>['items'][number];
/** An AI teammate draft as `ai_teammate.draft_list` answers. */
export type DraftListItem = Ok<'/v1/queries/ai_teammate.draft_list'>['items'][number];
/** The AI teammate and its training (`ai_teammate.get`). */
export type TeammateGet = Ok<'/v1/queries/ai_teammate.get'>;
