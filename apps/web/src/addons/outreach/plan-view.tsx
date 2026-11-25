'use client';
/**
 * Today's Plan (docs/outreach.md, decision 195): what the person's computer will do today on the network shown, and
 * about when. Where the day stands in a line, what they asked for that goes first, what's coming in order with rough
 * times, and what it has done so far. HandsFreeOS works it out from where the extension said its day is up to, with
 * the rules the extension follows (packages/core/src/addons/outreach/plan.ts), so nothing here is pressed yet: it
 * only shows. It asks for the plan again every minute and when the computer, the day or an ask changes, never the
 * whole page (the owner's pick, 23 Nov 2026).
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';
import {
  PLAN_STANDS,
  PLAN_WORDS,
  planCountsLine,
  planMoreWords,
  planTone,
  planWhen,
} from '@hfos/core/addons/outreach/plan';
import { PLATFORMS } from '@hfos/core/addons/outreach/playbooks';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { apiBrowser } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { useAskedAgain } from './live-view';
import type { Plan } from './types';

const TONES: Record<ReturnType<typeof planTone>, BadgeVariant> = {
  good: 'ok',
  waiting: 'accent',
  warn: 'pending',
  plain: 'gray',
};

/** What moves the plan: the computer's state and steps, a day pressed, an ask made or ended, and the settings. */
const PLAN_CHANGES = [
  'outreach_computer',
  'outreach_day',
  'outreach_ask',
  'outreach_automation',
] as const;

export function PlanCard({
  workspaceId,
  platform,
  plan: first,
  many,
}: {
  workspaceId: string;
  platform: Platform;
  /** The plan the page came with. */
  plan: Plan;
  /** The person works more than one network: the heading names the one shown. */
  many: boolean;
}) {
  const heard = useLiveVersion(PLAN_CHANGES, 1500);
  const asked = useAskedAgain(
    `${workspaceId}:${platform}`,
    () =>
      apiBrowser()
        .POST('/v1/queries/outreach.plan', { body: { workspaceId, platform } })
        .then((r) => r.data ?? null)
        .catch(() => null),
    heard,
  );
  // The newer of the page's own and the one asked for since.
  const plan = asked && Date.parse(asked.now) > Date.parse(first.now) ? asked : first;
  const tz = plan.timezone;
  const counts = planCountsLine(plan.counts);
  return (
    <div className="max-w-3xl space-y-5" data-testid="today-plan" data-stand={plan.stand}>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">
            {many ? PLAN_WORDS.titleOn(PLATFORMS[platform]) : PLAN_WORDS.title}
          </h2>
          <Badge variant={TONES[planTone(plan.stand)]} data-testid="plan-stand">
            {PLAN_STANDS[plan.stand]}
          </Badge>
        </div>
        <p className="mt-0.5 text-[12.5px] text-text-3">{PLAN_WORDS.about}</p>
        <p className="mt-3 text-[13.5px]" data-testid="plan-line">
          {plan.line}
        </p>
        {plan.doing ? (
          <p className="mt-1 text-[13px] text-text-2" data-testid="plan-doing">
            {plan.doing}
          </p>
        ) : null}
      </Card>

      {plan.asked.length ? (
        <Card className="p-4" data-testid="plan-asked">
          <h3 className="text-[15px] font-semibold">{PLAN_WORDS.asked}</h3>
          <ul className="mt-3 space-y-2">
            {plan.asked.map((ask) => (
              <li key={ask.askId} className="flex gap-3 text-[13px]">
                <span className="w-[96px] flex-none text-text-3">
                  {ask.working ? PLAN_WORDS.askWorking : PLAN_WORDS.askWaiting}
                </span>
                <span className="min-w-0">{ask.title}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {plan.reported ? (
        <Card className="p-4" data-testid="plan-coming">
          <h3 className="text-[15px] font-semibold">{PLAN_WORDS.coming}</h3>
          {plan.coming.length ? (
            <>
              <p className="mt-0.5 text-[12.5px] text-text-3">{PLAN_WORDS.times}</p>
              <ol className="mt-3 space-y-2" data-testid="plan-rows">
                {plan.coming.map((row, i) => (
                  <li
                    key={`${row.at}-${i}`}
                    className="flex gap-3 text-[13px]"
                    data-testid="plan-row"
                    data-kind={row.kind}
                    aria-current={row.now ? 'step' : undefined}
                  >
                    <span
                      className={cn(
                        'w-[96px] flex-none tabular-nums text-text-3',
                        row.now && 'font-medium text-success-text',
                      )}
                    >
                      {planWhen(row, tz)}
                    </span>
                    <span className="min-w-0">
                      {row.title}
                      {row.who ? <span className="font-medium"> · {row.who}</span> : null}
                      {row.detail ? <span className="text-text-3"> · {row.detail}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
              {plan.more > 0 ? (
                <p className="mt-3 text-[13px] text-text-2" data-testid="plan-more">
                  {planMoreWords(plan.more, plan.until, tz)}
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-[13px] text-text-2" data-testid="plan-none">
              {PLAN_WORDS.nothingComing}
            </p>
          )}
          {plan.notes.length ? (
            <ul className="mt-3 space-y-1 border-t border-border pt-3 text-[12.5px] text-text-3">
              {plan.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {plan.done.length || counts ? (
        <Card className="p-4" data-testid="plan-done">
          <h3 className="text-[15px] font-semibold">{PLAN_WORDS.done}</h3>
          {counts ? <p className="mt-2 text-[13px]">{counts}</p> : null}
          {plan.done.length ? (
            <ul className="mt-3 space-y-2">
              {plan.done.map((job) => (
                <li key={job.title} className="text-[13px]">
                  <span className="font-medium">{job.title}</span>
                  {job.line ? <span className="text-text-2"> · {job.line}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
