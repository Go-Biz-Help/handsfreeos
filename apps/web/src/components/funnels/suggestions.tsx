'use client';
/**
 * The teammate's funnel suggestions, on its Approvals tab (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "Who
 * gets in": the AI suggests, a person OKs). Each says who, which funnel and why; yes puts them in it as adding them
 * would, and no keeps it from suggesting them for that funnel again.
 */
import { funnelAtWords } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@/components/shell/workspace-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorMessage } from '@/lib/api/client';
import { funnelActions, type FunnelPersonOut } from '@/lib/funnels/actions';

export function FunnelSuggestions({
  workspaceId,
  teammateName,
  suggestions,
  timeZone,
}: {
  workspaceId: string;
  teammateName: string;
  suggestions: readonly FunnelPersonOut[];
  timeZone: string;
}) {
  const router = useRouter();
  const canDecide = useCan('records.write');
  const actions = useMemo(() => funnelActions(workspaceId), [workspaceId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const left = suggestions.filter((s) => !done.has(s.id));
  if (!left.length) return null;

  async function decide(s: FunnelPersonOut, accept: boolean) {
    setBusy(s.id);
    try {
      await actions.decideSuggestion(s.id, accept);
      setDone((now) => new Set(now).add(s.id));
      toast.success(
        accept
          ? `${s.personName} is in ${s.funnelName}.`
          : `${teammateName} won’t suggest ${s.personName} for ${s.funnelName} again.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mb-3 p-4" data-testid="funnel-suggestions">
      <h2 className="text-[15px] font-semibold">Funnel suggestions</h2>
      <p className="mt-1 text-[13px] text-text-2">
        {teammateName} thinks these people fit a funnel. Yes puts them in it, and its messages
        start. No and it won’t suggest them for it again.
      </p>
      <ul className="mt-3 flex flex-col divide-y divide-border">
        {left.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-3 py-2.5"
            data-testid={`funnel-suggestion-${s.id}`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px]">
                <a
                  href={`/app/w/${workspaceId}/customers/people/${s.personId}`}
                  className="font-medium hover:underline"
                >
                  {s.personName}
                </a>{' '}
                <span className="text-text-2">for</span>{' '}
                <a
                  href={`/app/w/${workspaceId}/ai-team/funnels/${s.funnelId}`}
                  className="font-medium hover:underline"
                >
                  {s.funnelName}
                </a>
              </p>
              <p className="mt-0.5 text-[12.5px] text-text-2">
                {s.suggestedWhy ? `${s.suggestedWhy} · ` : ''}
                {funnelAtWords(new Date(s.createdAt).getTime(), timeZone)}
              </p>
            </div>
            {canDecide ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void decide(s, false)}
                  disabled={!!busy}
                >
                  No
                </Button>
                <Button
                  size="sm"
                  onClick={() => void decide(s, true)}
                  loading={busy === s.id}
                  disabled={!!busy}
                  data-testid={`funnel-suggestion-yes-${s.id}`}
                >
                  Yes, put them in
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
