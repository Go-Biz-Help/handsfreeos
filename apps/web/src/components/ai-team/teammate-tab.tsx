import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import type { TeammateGet } from '@/lib/ai-team/types';
import { TeammateBuilder } from './builder';
import { TeammatePresetPicker } from './preset-picker';

/** The page heading before there's a teammate. */
export function AiTeamIntro() {
  return (
    <div className="mb-5 max-w-[900px]">
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
        AI teammate
      </h1>
      <p className="mt-1 text-text-2">
        An AI teammate answers your customers by text, email and website chat, and hands them to
        your team when it should. One per business.
      </p>
    </div>
  );
}

/** The Teammate tab: the preset picker until the business has a teammate, then its builder. */
export function TeammateTab({
  workspaceId,
  workspaceName,
  data,
}: {
  workspaceId: string;
  workspaceName: string;
  data: TeammateGet;
}) {
  if (!data.teammate)
    return (
      <>
        <AiTeamIntro />
        {data.canManage ? (
          <TeammatePresetPicker
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            catalogs={data.catalogs}
          />
        ) : (
          <Card>
            <EmptyState title="No AI teammate yet">
              An owner or admin can set one up here.
            </EmptyState>
          </Card>
        )}
      </>
    );
  return (
    <TeammateBuilder
      key={data.teammate.id}
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      teammate={data.teammate}
      progress={data.progress}
      revisions={data.revisions}
      catalogs={data.catalogs}
      canManage={data.canManage}
    />
  );
}
