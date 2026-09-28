'use client';
import type { SuggestionChoice } from '@hfos/core';
import { Blocks } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ADDON_UI } from '@/addons/registry';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AddonSuggestion } from '@/lib/api/types';

/**
 * The one add-on Home suggests, now and then, to owners and admins when it fits what the business does (the owner's
 * decision, 2026-09-28; `addon.suggestion` picks it, and Home asks only for people who manage add-ons). Small and
 * easy to set aside: See it opens it on Settings → Add-ons, Not now rests every suggestion a while, and Not
 * interested never suggests this one again.
 */
export function AddonSuggestionCard({
  workspaceId,
  suggestion,
}: {
  workspaceId: string;
  suggestion: AddonSuggestion;
}) {
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState<SuggestionChoice | null>(null);
  if (gone) return null;
  const Icon = ADDON_UI[suggestion.addonId]?.icon ?? Blocks;
  const titleId = `addon-suggestion-${suggestion.addonId}`;

  async function setAside(choice: SuggestionChoice) {
    setBusy(choice);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/addon.dismiss_suggestion', {
          body: { workspaceId, addonId: suggestion.addonId, choice },
        }),
      );
      setGone(true);
      toast.success(
        choice === 'not_interested'
          ? `We won’t suggest ${suggestion.name} again.`
          : 'We’ll hold off on suggestions for a while.',
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      className="p-4"
      role="group"
      aria-labelledby={titleId}
      data-testid="addon-suggestion"
      data-addon={suggestion.addonId}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-8 w-8 flex-none items-center justify-center rounded-menu bg-accent-soft text-accent-text"
        >
          <Icon className="h-4 w-4" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-text-3">An add-on that could help</p>
          <h3 id={titleId} className="mt-0.5 text-[15px] font-semibold tracking-tight">
            {suggestion.name}
          </h3>
          <p className="mt-0.5 text-[13px] text-text-2">{suggestion.summary}</p>
          {suggestion.does.length ? (
            <ul className="mt-2 flex list-disc flex-col gap-0.5 pl-4 text-[13px]">
              {suggestion.does.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {/* The card's whole width: in the side rail there's no room for three buttons beside the icon. */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <ButtonLink
          href={`/app/w/${workspaceId}/settings/add-ons?addon=${suggestion.addonId}`}
          variant="primary"
          size="sm"
          data-testid="addon-suggestion-see"
        >
          See it
        </ButtonLink>
        <Button
          variant="ghost"
          size="sm"
          loading={busy === 'not_now'}
          disabled={busy !== null}
          onClick={() => void setAside('not_now')}
          data-testid="addon-suggestion-not-now"
        >
          Not now
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={busy === 'not_interested'}
          disabled={busy !== null}
          onClick={() => void setAside('not_interested')}
          data-testid="addon-suggestion-not-interested"
        >
          Not interested
        </Button>
      </div>
    </Card>
  );
}
