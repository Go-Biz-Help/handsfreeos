import { Badge } from '@/components/ui/badge';
import type { WorkflowRunStatus } from '@/lib/api/types';
import { RUN_STATUS } from '@/lib/workflows/run-words';

/** Running, Waiting, Needs approval, Held, Completed, Stopped or Failed. */
export function RunStatusBadge({ status }: { status: WorkflowRunStatus }) {
  const s = RUN_STATUS[status];
  return (
    <Badge variant={s.variant} data-testid="run-status" data-status={status}>
      {s.label}
    </Badge>
  );
}
