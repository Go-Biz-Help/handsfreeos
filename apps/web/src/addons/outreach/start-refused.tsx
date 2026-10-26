'use client';
/**
 * A press of Start my day the server refused, kept beside the button that was pressed (the owner, 26 Oct 2026: "if
 * there is something else preventing the day from starting it should tell the user what it is"): the server's words,
 * which say what's in the way and where it's fixed, and **Do it now** to the setup's step that fixes it, chosen by the
 * refusal's rule and details (`startFix`), never by its words. Today's strip, Details and the setup's Start use it.
 */
import { NO_SUCH_ROUTE } from '@hfos/core';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import {
  outreachSetupPath,
  SETUP_WORDS,
  startFix,
  type SetupStop,
} from '@hfos/core/addons/outreach/setup';
import { ButtonLink } from '@/components/ui/button';
import { ApiError, errorMessage } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/** A press of Start my day the server refused: its words, and where the setup fixes it. */
export interface StartRefused {
  readonly platform: Platform;
  readonly words: string;
  readonly fix: SetupStop | null;
}

/**
 * Whether a refusal of Start my day is kept beside the button (`startRefused`) rather than toasted: one with a rule
 * that says what's in the way. A route the API doesn't serve yet (`NO_SUCH_ROUTE`, for a few minutes each deploy)
 * isn't: it's plumbing, and `errorMessage`'s try again is the truer words.
 */
export function keptBesideStart(e: unknown): e is ApiError {
  return e instanceof ApiError && Boolean(e.rule) && e.rule !== NO_SUCH_ROUTE;
}

/**
 * A refusal of Start my day to keep beside the button: its words, and the setup's step that fixes it, by its rule and
 * details (`startFix`). Null for anything else (`keptBesideStart`), which a toast says.
 */
export function startRefused(
  e: unknown,
  platform: Platform,
  canManage: boolean,
): StartRefused | null {
  if (!keptBesideStart(e)) return null;
  return {
    platform,
    words: errorMessage(e),
    fix: startFix({ rule: e.rule, details: e.details }, platform, canManage),
  };
}

/** A refused Start my day, beside the button: the server's words, with Do it now where the setup fixes it. */
export function StartRefusedNote({
  workspaceId,
  refused,
  named = false,
  className,
}: {
  workspaceId: string;
  refused: StartRefused;
  /** With more than one network: the words say which. */
  named?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-menu bg-warning-soft p-2.5 text-[12.5px] text-warning-text',
        className,
      )}
      data-testid="live-start-refused"
    >
      <p className="min-w-0 flex-[1_1_240px]">
        {named ? `${PLATFORMS[refused.platform]}: ${refused.words}` : refused.words}
      </p>
      {refused.fix ? (
        <ButtonLink
          size="sm"
          variant="secondary"
          href={outreachSetupPath(workspaceId, { step: refused.fix })}
          data-testid="live-start-fix"
        >
          {SETUP_WORDS.start.doItNow}
        </ButtonLink>
      ) : null}
    </div>
  );
}
