'use client';
/**
 * People's In your hands (docs/outreach.md, decision 185; core's ./in-hands.ts): everyone someone on the team wrote
 * to themselves, or took over, whom the AI sends no messages till someone gives them back. Each row says whose hands
 * and when, with Give back to the AI; Give all back takes the whole list, or only the person's own with Only mine.
 */
import { handsLine, relativeTimeAgo } from '@hfos/core';
import { HANDS_OUTREACH_WORDS as W, type HandsOutput } from '@hfos/core/addons/outreach/in-hands';
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { outreachHref } from './address';
import { PersonName } from './person-menu';
import { useAct } from './use-act';

export function HandsView({
  workspaceId,
  me,
  mine,
}: {
  workspaceId: string;
  me: string | null;
  mine: boolean;
}) {
  const [got, setGot] = useState<HandsOutput | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setGot(
        unwrap(
          await apiBrowser().POST('/v1/queries/outreach.hands', {
            body: { workspaceId, mine, limit: 200 },
          }),
        ),
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [workspaceId, mine]);
  useEffect(() => {
    void load();
  }, [load]);
  const { busy, act } = useAct(() => void load());

  const giveBack = (which: string | 'all') =>
    void act(
      which,
      async () => {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.hands.give_back', {
            body: {
              workspaceId,
              profileIds: which === 'all' ? [] : [which],
              all: which === 'all',
              mine: which === 'all' && mine,
            },
          }),
        );
        return out;
      },
      W.gaveBack(which === 'all' ? Math.max(1, got?.total ?? 1) : 1),
    );

  const people = got?.people ?? [];
  return (
    <div className="flex flex-col gap-3" data-testid="outreach-hands">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13.5px] text-text-2">{W.about}</p>
        <div className="flex items-center gap-2">
          <Link
            href={outreachHref(workspaceId, { view: 'hands', mine: !mine })}
            className="text-[12.5px] font-medium text-accent-text hover:underline"
            data-testid="outreach-hands-mine"
          >
            {mine ? W.everyone : W.mine}
          </Link>
          {people.length ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => giveBack('all')}
              loading={busy === 'all'}
              disabled={busy !== null}
              data-testid="outreach-hands-give-all-back"
            >
              {W.giveAllBack}
            </Button>
          ) : null}
        </div>
      </div>
      {failed ? (
        <p className="rounded-lg border border-border px-4 py-6 text-center text-[13.5px] text-text-2">
          The list couldn’t load. Check your connection, then reload the page.
        </p>
      ) : got && people.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-6 text-center text-[13.5px] text-text-2">
          {W.empty}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {people.map((p) => (
            <li
              key={p.profileId}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              data-testid="outreach-hands-person"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <PersonName
                    workspaceId={workspaceId}
                    who={{
                      profileId: p.profileId,
                      name: p.name,
                      platform: p.platform,
                      url: p.url,
                      threadKey: p.threadKey,
                      personId: p.personId,
                    }}
                    className="font-medium"
                  />
                  <Badge>{PLATFORMS[p.platform]}</Badge>
                  {p.ask ? <Badge variant="accent">{W.asksTitle}</Badge> : null}
                </div>
                <p className="text-[12.5px] text-text-2">
                  {handsLine(p, me)} · {relativeTimeAgo(p.lastAt)}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => giveBack(p.profileId)}
                loading={busy === p.profileId}
                disabled={busy !== null}
                title={W.giveBackHint}
                data-testid="outreach-hands-give-back"
              >
                {W.giveBack}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {got && got.total > people.length ? (
        <p className="text-[12.5px] text-text-2">
          Showing the latest {people.length} of {got.total}.
        </p>
      ) : null}
    </div>
  );
}
