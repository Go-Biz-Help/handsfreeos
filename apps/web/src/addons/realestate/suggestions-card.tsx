'use client';
/**
 * Our own listings that fit a buyer (board 43, design/realestate/BuyerMatch.dc.html). When one of the business's
 * listings goes live on the MLS or its price changes, it's checked against our buyers' searches and suggested on the
 * deals it fits. Adding it puts it on their homes, where it shows in their portal like any home; "Not a fit" sets it
 * aside. The listing's agent sees only how many buyers it was suggested to, never who.
 */
import { money } from '@hfos/core';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { CardHead } from './bits';
import { FitList, homeFactsLine, street } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import type { Home, Suggestion } from './types';
import { useAct } from './use-act';

export function SuggestionsCard({
  workspaceId,
  suggestions,
  clients,
  live,
}: {
  workspaceId: string;
  suggestions: readonly Suggestion[];
  /** The buyers' first names: "Linh and Tuan". */
  clients: string;
  live: boolean;
}) {
  const fresh = suggestions.filter((s) => s.state === 'new');
  const { busy, act } = useAct();
  const [setting, setSetting] = useState<Suggestion | null>(null);
  if (!fresh.length) return null;
  return (
    <Card className="p-4 md:p-5" data-testid="realestate-suggestions">
      <CardHead title="Fits from our listings" action={<Badge variant="accent">New</Badge>} />
      <ul className="space-y-3">
        {fresh.map((s) => {
          const facts = s.facts as Home['facts'];
          const line = [
            s.priceCents !== null ? money(s.priceCents) : null,
            homeFactsLine({ ...facts, price_cents: undefined } as Home['facts']),
            typeof facts.year_built === 'number' ? `built ${facts.year_built}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li
              key={s.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-border p-3"
              data-testid="suggestion"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-semibold">{street(s.address)}</div>
                <div className="text-[13px] text-text-2">{line}</div>
                <FitList
                  fit={{ lines: s.fit as Home['fit']['lines'], met: 0, missed: 0, unknown: 0 }}
                  className="mt-1.5 flex flex-wrap gap-x-3 space-y-0"
                />
                <div className="mt-1 text-[12.5px] text-text-3">
                  Our listing{s.mlsNumber ? ` · MLS #${s.mlsNumber}` : ''}
                </div>
              </div>
              {live ? (
                <div className="flex flex-col items-end gap-1.5">
                  <Button
                    size="sm"
                    loading={busy === s.id}
                    onClick={() =>
                      void act(
                        s.id,
                        async () =>
                          unwrap(
                            await apiBrowser().POST('/v1/commands/realestate.suggestion.add', {
                              body: { workspaceId, suggestionId: s.id },
                            }),
                          ),
                        `Added to their homes. ${clients || 'They'} see it in their portal.`,
                      )
                    }
                    data-testid="suggestion-add"
                  >
                    Add to their homes
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSetting(s)}>
                    Not a fit
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[12.5px] text-text-2">
        Suggested because it fits what {clients || 'they'} want: price, area, kind of home, beds,
        baths and size. Added, it shows in their portal like any home you add. The listing’s agent
        sees only how many buyers it was suggested to.
      </p>
      <ReasonDialog
        open={!!setting}
        onOpenChange={(o) => !o && setSetting(null)}
        title={setting ? `${street(setting.address)} isn’t a fit?` : 'Not a fit?'}
        description="It’s set aside on this deal. Say why if you like; it’s kept with your name."
        label="Why (optional)"
        optional
        submit="Set it aside"
        done="Set aside."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.suggestion.not_a_fit', {
              body: { workspaceId, suggestionId: setting!.id, ...(reason ? { reason } : {}) },
            }),
          )
        }
      />
    </Card>
  );
}
