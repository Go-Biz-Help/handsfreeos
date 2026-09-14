import type { paths } from '@hfos/api-client';

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type ApprovalList = Ok<'/v1/queries/workflow.approval_list'>;
/** One workflow approval as workflow.approval_list returns it. */
export type Approval = ApprovalList['items'][number];
