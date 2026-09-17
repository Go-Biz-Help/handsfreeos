import { useWaitingDrafts } from '@/components/drafts';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { useNow } from '@/home/use-home';
import { useWaitingWorkflowApprovals } from '@/home/use-approvals';

/**
 * How many things wait for this person's yes, beside Approvals in More (as the web's count): the workflow approvals
 * they can decide and the AI teammate's drafts they can decide, less those decided on this phone.
 */
export function ApprovalsCount() {
  const now = useNow();
  const flows = useWaitingWorkflowApprovals(now);
  const { visible } = useWaitingDrafts();
  const count = flows.length + visible.filter((d) => d.draft.canDecide).length;
  if (!count) return null;
  return (
    <Badge variant="accent" testID="more-approvals-count">
      <Text>{String(count)}</Text>
    </Badge>
  );
}
