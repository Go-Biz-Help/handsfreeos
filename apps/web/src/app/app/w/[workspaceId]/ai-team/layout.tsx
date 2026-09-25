import type { ReactNode } from 'react';
import { AiTeamLive } from '@/components/ai-team/live';

/**
 * The AI teammate area: Teammate (the builder), Activity and Approvals. Everyone sees it; ai_team.manage
 * changes it.
 */
export default function AiTeamLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1320px]">
      <AiTeamLive />
      {children}
    </div>
  );
}
