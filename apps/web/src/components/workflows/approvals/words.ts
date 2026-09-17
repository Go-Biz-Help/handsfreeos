/**
 * Reading an approval for people (M7). The words live in core since M10 (`packages/core/src/workflows/
 * approval-words.ts`), so the phone's Approvals says exactly what this page does; these are the names the web's
 * components have always imported.
 */
export {
  approvalPreviewOf as previewOf,
  approvalCustomerOf as customerOf,
  approvalTitle,
  approvalKind,
  approverNames as nameList,
  approvalExpiresIn as expiresIn,
  approvalDecidedLine as decidedLine,
  approvalSegmentLabel as segmentLabel,
} from '@hfos/core';
export type { ApprovalPreview, ApprovalKnowledgeItem as ApprovalItem } from '@hfos/core';
