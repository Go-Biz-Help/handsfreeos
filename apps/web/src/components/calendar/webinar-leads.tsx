'use client';
/**
 * Who to follow up with after an appointment's HandsFreeOS video call with a live poll
 * (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 5): everyone who came, hottest first, with their points, what
 * they came from, the AI's one line, and what happened to the hot ones. Scored a minute after the call ends; read
 * again as the call's rows change.
 */
import {
  callLengthLabel,
  LEAD_LABEL_WORDS,
  LEAD_OUTCOME_WORDS,
  LEAD_WORDS,
  type LeadLabel,
} from '@hfos/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';

/** People listed before "Show everyone". */
const FIRST_SHOWN = 15;
/** Scoring runs a few seconds after the end; past this, an empty list means nobody came. */
const SCORED_WITHIN_MS = 3 * 60_000;

const BADGE: Readonly<Record<LeadLabel, BadgeVariant>> = {
  hot: 'ok',
  warm: 'pending',
  cold: 'gray',
};

const readLeads = (workspaceId: string, appointmentId: string) =>
  apiBrowser()
    .POST('/v1/queries/video_call.leads', { body: { workspaceId, appointmentId } })
    .then(unwrap);
type LeadsGot = Awaited<ReturnType<typeof readLeads>>;

export function WebinarLeads({
  workspaceId,
  appointmentId,
  version,
}: {
  workspaceId: string;
  appointmentId: string;
  version: number;
}) {
  const calls = useLiveVersion(['video_call']);
  const [got, setGot] = useState<LeadsGot | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let gone = false;
    readLeads(workspaceId, appointmentId)
      .then((g) => {
        if (!gone) setGot(g);
      })
      // The list is extra: the call block above still shows who came.
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [workspaceId, appointmentId, version, calls]);

  // No call, no poll, or a call that's still to come or going: nothing to rank yet.
  if (!got?.call?.formId || (!got.leads.length && !got.call.ended)) return null;
  const shown = all ? got.leads : got.leads.slice(0, FIRST_SHOWN);
  return (
    <div className="mt-3.5" data-testid="sheet-webinar-leads">
      <span className="mb-0.5 block text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {LEAD_WORDS.title}
      </span>
      <div className="flex flex-col gap-2 pt-1.5">
        {got.leads.length ? (
          <>
            <p className="text-xs text-text-3" data-testid="sheet-webinar-lead-counts">
              {LEAD_WORDS.counts(got.counts.hot, got.counts.warm, got.counts.cold)} · Hot from{' '}
              {got.call.hot}, Warm from {got.call.warm}
              {got.call.formName ? ` · ${got.call.formName}` : ''}
            </p>
            <ol className="flex flex-col divide-y divide-border">
              {shown.map((l) => (
                <li
                  key={l.id}
                  className="flex flex-col gap-1 py-2"
                  data-testid="sheet-webinar-lead"
                >
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/app/w/${workspaceId}/customers/people/${l.personId}`}
                      className="min-w-0 flex-1 truncate text-[13px] font-medium hover:underline"
                    >
                      {l.name}
                    </Link>
                    <Badge variant={BADGE[l.label]} data-testid="sheet-webinar-lead-label">
                      {LEAD_LABEL_WORDS[l.label]}
                    </Badge>
                    <span className="w-[72px] text-right text-xs tabular-nums text-text-2">
                      {LEAD_WORDS.points(l.points)}
                    </span>
                  </div>
                  <p className="text-[12.5px] text-text-2">
                    {l.reason ??
                      (l.parts.map((p) => p.what).join(' · ') || 'Came, and answered nothing.')}
                  </p>
                  <p className="text-xs text-text-3">
                    {l.stayed ? LEAD_WORDS.stayed : `In it for ${callLengthLabel(l.seconds)}`}
                    {l.label === 'hot' && l.outcome
                      ? ` · ${LEAD_OUTCOME_WORDS[l.outcome]}${l.outcome === 'skipped' && l.outcomeReason ? `: ${l.outcomeReason}` : ''}`
                      : l.label === 'hot' && l.followUp === 'home'
                        ? ` · ${LEAD_OUTCOME_WORDS.card}`
                        : ''}
                  </p>
                </li>
              ))}
            </ol>
            {got.leads.length > shown.length ? (
              <button
                type="button"
                className="self-start text-xs font-medium text-accent-text hover:underline"
                onClick={() => setAll(true)}
                data-testid="sheet-webinar-leads-all"
              >
                Show all {got.leads.length}
              </button>
            ) : null}
          </>
        ) : (
          <p className="text-[13px] text-text-3">
            {got.call.endedAt && Date.parse(got.call.endedAt) < Date.now() - SCORED_WITHIN_MS
              ? LEAD_WORDS.none
              : LEAD_WORDS.waiting}
          </p>
        )}
      </div>
    </div>
  );
}
