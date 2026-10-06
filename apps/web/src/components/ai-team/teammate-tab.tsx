import { AI_SETUP_WORDS } from '@hfos/core';
import Link from 'next/link';
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

/** Back to quick setup, above the presets "Set it up myself" shows. */
export function QuickSetupInstead({ href }: { href: string }) {
  return (
    <p className="text-[13.5px] text-text-2">
      {AI_SETUP_WORDS.quickInstead}{' '}
      <Link
        href={href}
        className="font-medium text-accent-text hover:underline"
        data-testid="ai-setup-quick-instead"
      >
        {AI_SETUP_WORDS.quickSetup}
      </Link>
    </p>
  );
}

/**
 * The Teammate tab: the preset picker until the business has a teammate, then its builder. `quickSetupHref` is the
 * way back to quick setup for someone who chose "Set it up myself".
 */
export function TeammateTab({
  workspaceId,
  workspaceName,
  data,
  quickSetupHref = null,
}: {
  workspaceId: string;
  workspaceName: string;
  data: TeammateGet;
  quickSetupHref?: string | null;
}) {
  if (!data.teammate)
    return (
      <>
        <AiTeamIntro />
        {data.canManage ? (
          <>
            {quickSetupHref ? (
              <div className="-mt-2 mb-4">
                <QuickSetupInstead href={quickSetupHref} />
              </div>
            ) : null}
            <TeammatePresetPicker
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              catalogs={data.catalogs}
            />
          </>
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
