'use client';
/**
 * Home's "Set up your business email" (the owner's 7a): for someone who can change the business's email, while it
 * still sends from the address it was made with, or "Finish your email records" while its domain's records are on
 * their way (emailSetupHomeOf). Set it up opens the email screens on a page of their own; Not now sets the card
 * aside on this browser for a week.
 */
import { EMAIL_SETUP_WORDS as W, type EmailSetupHome } from '@hfos/core';
import { Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const REST_MS = 7 * 24 * 60 * 60 * 1000;
const keyOf = (workspaceId: string, kind: EmailSetupHome['kind']) =>
  `hfos.email-setup.not-now.${workspaceId}.${kind}`;

export function EmailSetupCard({
  workspaceId,
  home,
}: {
  workspaceId: string;
  home: EmailSetupHome;
}) {
  // Hidden until the browser says whether it was set aside, so it never flashes.
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    let at = 0;
    try {
      at = Number(window.localStorage.getItem(keyOf(workspaceId, home.kind)) ?? 0);
    } catch {
      // No storage: it shows.
    }
    setHidden(Date.now() - at < REST_MS);
  }, [workspaceId, home.kind]);
  if (hidden) return null;

  const notNow = () => {
    try {
      window.localStorage.setItem(keyOf(workspaceId, home.kind), String(Date.now()));
    } catch {
      // Gone for this visit anyway.
    }
    setHidden(true);
  };
  const records = home.kind === 'records';
  const titleId = `email-setup-card-${home.kind}`;

  return (
    <Card
      className="p-4"
      role="group"
      aria-labelledby={titleId}
      data-testid="email-setup-card"
      data-kind={home.kind}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-8 w-8 flex-none items-center justify-center rounded-menu bg-accent-soft text-accent-text"
        >
          <Mail className="h-4 w-4" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-[15px] font-semibold tracking-tight">
            {records ? W.homeRecordsTitle : W.homeStartTitle}
          </h3>
          <p className="mt-0.5 break-words text-[13px] text-text-2">
            {home.kind === 'records'
              ? W.homeRecordsBody(home.found, home.of, home.host, home.from, home.to)
              : W.homeStartBody(home.address)}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <ButtonLink
          href={`/onboarding/${workspaceId}/email${records ? '?at=records' : ''}`}
          variant="primary"
          size="sm"
          data-testid="email-setup-card-open"
        >
          {records ? W.homeRecords : W.homeStart}
        </ButtonLink>
        <Button variant="ghost" size="sm" onClick={notNow} data-testid="email-setup-card-not-now">
          {W.notNow}
        </Button>
      </div>
    </Card>
  );
}
