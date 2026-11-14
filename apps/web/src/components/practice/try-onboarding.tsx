'use client';
/**
 * Admin → Try onboarding (20261027027400): every onboarding, gone through as a brand-new customer would, in a practice
 * business made just for it. The flows ready now start here; the rest say they're coming. Below, the practice
 * businesses this person has going, to open again or end.
 */
import {
  PRACTICE_FLOWS,
  PRACTICE_HOURS,
  PRACTICE_MOST,
  PRACTICE_WORDS as W,
  practiceEndsIn,
} from '@hfos/core';
import { FlaskConical, Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { Ok } from '@/lib/api/types';
import { EndPracticeDialog } from './practice-banner';

type Practice = Ok<'/v1/queries/practice.list'>['businesses'][number];

/** Where each ready flow starts. */
const STARTS: Partial<Record<(typeof PRACTICE_FLOWS)[number]['key'], string>> = {
  new_business: '/try/sign-up',
};

export function TryOnboarding({
  businesses,
  ended,
}: {
  businesses: readonly Practice[];
  /** Back from End practice on the business's own banner. */
  ended: boolean;
}) {
  const full = businesses.length >= PRACTICE_MOST;
  // "in 23 hours" is worked out after the page is drawn, so the server's clock and the browser's never disagree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-testid="try-onboarding">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold md:text-2xl">{W.title}</h1>
        <p className="max-w-2xl text-[14px] leading-relaxed text-text-2">{W.intro}</p>
      </div>

      <Card className="flex flex-col gap-2 p-5">
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <FlaskConical className="h-4 w-4 text-warning-text" strokeWidth={1.75} />
          What’s pretended
        </div>
        <ul className="ml-5 list-disc text-[13.5px] leading-relaxed text-text-2">
          {W.pretended.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-[13px] text-text-3">{W.kept(PRACTICE_HOURS)}</p>
      </Card>

      {ended ? (
        <p
          className="rounded-control bg-success-soft px-3 py-2 text-[13px] text-success-text"
          data-testid="try-ended"
        >
          {W.ended}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-semibold">{W.running}</h2>
        {businesses.length === 0 ? (
          <p className="text-[13px] text-text-3">{W.none}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {businesses.map((b) => (
              <PracticeRow key={b.organizationId} business={b} now={now} />
            ))}
          </ul>
        )}
        {full ? (
          <p
            className="rounded-control bg-warning-soft px-3 py-2 text-[13px] text-warning-text"
            data-testid="try-too-many"
          >
            {W.tooMany(PRACTICE_MOST)}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-semibold">Onboardings</h2>
        <ol className="flex flex-col gap-2.5">
          {PRACTICE_FLOWS.map((f) => {
            const start = f.ready ? STARTS[f.key] : undefined;
            return (
              <Card
                key={f.key}
                className="flex flex-wrap items-center gap-3 p-4"
                data-testid={`try-flow-${f.key}`}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[15px] font-semibold leading-snug">{f.title}</span>
                  <span className="text-[13px] leading-relaxed text-text-2">{f.blurb}</span>
                </div>
                {start ? (
                  full ? (
                    <Button size="sm" disabled>
                      <Play className="h-3.5 w-3.5" />
                      {W.start}
                    </Button>
                  ) : (
                    <ButtonLink
                      href={start}
                      variant="primary"
                      size="sm"
                      data-testid={`try-start-${f.key}`}
                    >
                      <Play className="h-3.5 w-3.5" />
                      {W.start}
                    </ButtonLink>
                  )
                ) : (
                  <Badge variant="gray">{W.coming}</Badge>
                )}
              </Card>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function PracticeRow({ business: b, now }: { business: Practice; now: number | null }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  return (
    <li>
      <Card
        className="flex flex-wrap items-center gap-3 px-4 py-3"
        data-testid={`try-business-${b.organizationId}`}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{b.name}</span>
            <Badge variant="pending">{W.tag}</Badge>
          </span>
          <span className="text-[12.5px] text-text-3">
            {b.ending || !b.workspaceId
              ? W.ending
              : now === null
                ? '\u00a0'
                : `Deleted ${practiceEndsIn(b.endsAt, now)}`}
          </span>
        </div>
        {b.workspaceId && !b.ending ? (
          <div className="flex items-center gap-2">
            <ButtonLink href={`/app/w/${b.workspaceId}`} size="sm" variant="secondary">
              {W.open}
            </ButtonLink>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAsking(true)}
              data-testid={`try-end-${b.organizationId}`}
            >
              {W.end}
            </Button>
            <EndPracticeDialog
              workspaceId={b.workspaceId}
              name={b.name}
              open={asking}
              onOpenChange={setAsking}
              onEnded={() => router.refresh()}
            />
          </div>
        ) : null}
      </Card>
    </li>
  );
}
