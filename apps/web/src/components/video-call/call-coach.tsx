'use client';
/**
 * What add-ons show the team beside a HandsFreeOS video call's video (docs/video-calls.md, "The coach in the call"):
 * the Sales Coach's cards on the call the person is on, as above the web's call bar (`call.panels`). The call's
 * page sits outside the business's pages, so it brings along what they would: which add-ons run there, what the
 * person may do, and the live updates the cards come with. With no coached call, nothing.
 */
import { AddonSlot } from '@/components/addons/slot';
import { WorkspaceShellProvider } from '@/components/shell/workspace-shell';
import { LiveProvider } from '@/lib/realtime/live-provider';

/** One of the signed-in person's businesses: what runs there, and what they may do. */
export interface CallBusiness {
  readonly id: string;
  readonly addons: readonly string[];
  readonly permissions: readonly string[];
}

export function CallCoachPanel({ business }: { business: CallBusiness }) {
  return (
    <LiveProvider workspaceId={business.id}>
      <WorkspaceShellProvider
        workspaceId={business.id}
        addons={business.addons}
        permissions={business.permissions}
      >
        <AddonSlot name="call.panels" workspaceId={business.id} personId={null} />
      </WorkspaceShellProvider>
    </LiveProvider>
  );
}
