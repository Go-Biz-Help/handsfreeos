'use client';
/**
 * A deal's history: every change, newest first, with who made it (a person, HandsFreeOS, or the Assistant with a
 * person's OK) and the reason when one was given. Nothing on it is ever edited or taken out.
 */
import { dealHistoryWords } from '@hfos/core/addons/realestate/history-words';
import { fmtAt } from '@hfos/core';
import Link from 'next/link';
import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { dealHref } from './bits';
import type { DealHistory } from './types';

export function HistoryPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  lines,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  lines: DealHistory['lines'];
}) {
  useLiveRefresh(['custom_record']);
  return (
    <div data-testid="realestate-history">
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link href={dealHref(workspaceId, dealId)} className="text-accent-text hover:underline">
          {dealName}
        </Link>
        <span className="text-text-3">/</span>
        <span className="text-text-2">History</span>
      </div>
      <PageHeader
        title="History"
        description={`${dealName} · every change, newest first. Nothing here is ever edited.`}
      />
      <Card className="p-0">
        {lines.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13.5px] text-text-2">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {lines.map((l, i) => (
              <li
                key={`${l.at}-${i}`}
                className="flex flex-col gap-0.5 px-5 py-3 text-[13.5px] sm:flex-row sm:gap-4"
              >
                <span className="w-44 flex-none text-text-3 tabular-nums">
                  {fmtAt(l.at, timeZone)}
                </span>
                <span className="min-w-0">
                  {dealHistoryWords(l.what, l.before, l.after)}
                  <span className="text-text-2">
                    {' · '}
                    {l.actor
                      ? l.actor.name
                      : l.actorType === 'ai'
                        ? 'the Assistant'
                        : 'HandsFreeOS'}
                  </span>
                  {l.note ? (
                    <span className="block text-[12.5px] text-text-2">“{l.note}”</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
