import { PowerOff } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * An add-on's page while the add-on isn't running in this business (0108). The owner decided its screens and
 * records stay hidden until it's back on, and that nothing is lost meanwhile, so that is what this says — inside
 * the shell, never as a crash. Someone who may turn add-ons on and off (`addons.manage`) is told it's off and
 * where to go; everyone else, only that it isn't available here.
 *
 * Plain markup, no hooks: the gate draws it on the server (addons/gate.tsx) and the business's error screen in the
 * browser (app/app/w/[workspaceId]/error.tsx).
 */
export function AddonUnavailable({
  workspaceId,
  name,
  canManage,
}: {
  workspaceId: string;
  /** The add-on's name, when it's known; the words make do without it. */
  name?: string;
  canManage: boolean;
}) {
  const home = `/app/w/${workspaceId}`;
  const what = name ?? 'This add-on';
  return (
    <div className="mx-auto max-w-[520px] py-8 md:py-14" data-testid="addon-unavailable">
      <Card className="rounded-dialog p-7 text-center md:p-9">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-card-2 text-text-2">
          <PowerOff className="h-5 w-5" strokeWidth={1.5} />
        </div>
        {canManage ? (
          <>
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
              {what} is off for this business
            </h1>
            <p className="mt-2 text-text-2">
              Its screens and records are hidden while it’s off, and nothing is lost. Turn it on
              again in Settings and everything is back where it was.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
              This isn’t available here
            </h1>
            <p className="mt-2 text-text-2">
              {what} isn’t turned on for this business. If you need it, ask an owner or an admin.
            </p>
          </>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {canManage ? (
            <ButtonLink href={`${home}/settings`} variant="primary">
              Go to Settings
            </ButtonLink>
          ) : null}
          <ButtonLink href={home} variant={canManage ? 'secondary' : 'primary'}>
            Go to Home
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
