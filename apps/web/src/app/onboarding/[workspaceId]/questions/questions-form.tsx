'use client';
import {
  CUSTOMER_SOURCES,
  laterOrder,
  mustDoOrder,
  ONBOARDING_GOALS,
  previewDetail,
  QUESTION_WORDS,
  stepTitle,
  TEAM_SIZES,
  type CustomerSource,
  type OnboardingAnswers,
  type OnboardingGoal,
  type TeamSize,
} from '@hfos/core';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FieldError, Label } from '@/components/ui/field';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/** A choice among a few, as the design draws them: a row of pills, one pressed. */
function Choices<T extends string>({
  legend,
  options,
  labels,
  value,
  onChange,
  name,
}: {
  legend: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T | undefined;
  onChange: (value: T) => void;
  name: string;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2" data-testid={`question-${name}`}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={value === o}
            onClick={() => onChange(o)}
            className={cn(
              'inline-flex h-9 items-center rounded-full border px-3.5 text-[13.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring max-md:h-11',
              value === o
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border-strong bg-card text-text-2 hover:bg-card-2 hover:text-text',
            )}
          >
            {labels[o]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** The website as people type it, without the https:// the field already shows. */
const bare = (url: string | null) => (url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

/** The message a refusal gives for one field, when it names that field. */
function fieldMessage(e: unknown, path: string): string | null {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return null;
  const hit = (e.details as { path?: unknown; message?: unknown }[]).find((d) => d.path === path);
  return typeof hit?.message === 'string' ? hit.message : null;
}

export function QuestionsForm({
  workspaceId,
  overline,
  next,
  initial,
}: {
  workspaceId: string;
  overline: string;
  /** Where Continue and Skip go: the setup wizard's first step, or Home from the Getting started card. */
  next: string;
  initial: { answers: OnboardingAnswers | null; website: string | null };
}) {
  const router = useRouter();
  const [goal, setGoal] = useState<OnboardingGoal | undefined>(initial.answers?.goal);
  const [customersIn, setCustomersIn] = useState<CustomerSource | undefined>(
    initial.answers?.customersIn,
  );
  const [teamSize, setTeamSize] = useState<TeamSize | undefined>(initial.answers?.teamSize);
  const [site, setSite] = useState(bare(initial.website));
  const [noSite, setNoSite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!goal || !customersIn || !teamSize) {
      setError(QUESTION_WORDS.unanswered);
      return;
    }
    setBusy(true);
    setError(null);
    setSiteError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/onboarding.save_answers', {
          body: {
            workspaceId,
            goal,
            customersIn,
            teamSize,
            // Left empty, the website the business already has stays as it is.
            ...(noSite ? { website: null } : site.trim() ? { website: site.trim() } : {}),
          },
        }),
      );
      router.push(next);
      router.refresh();
    } catch (err) {
      setBusy(false);
      const onSite = fieldMessage(err, 'website');
      if (onSite) setSiteError(onSite);
      else setError(errorMessage(err));
    }
  }

  const answers = { goal, customersIn, teamSize };
  const must = mustDoOrder(goal);
  const later = laterOrder(answers);
  const pick =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setError(null);
    };

  return (
    <Card className="grid w-[920px] max-w-full grid-cols-1 overflow-hidden rounded-dialog md:grid-cols-[minmax(0,1fr)_320px]">
      <form onSubmit={submit} className="flex flex-col gap-[22px] p-6 sm:p-9" noValidate>
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
            {overline}
          </div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">
            {QUESTION_WORDS.title}
          </h1>
          <p className="text-text-2">{QUESTION_WORDS.intro}</p>
        </div>

        <Choices
          name="goal"
          legend={QUESTION_WORDS.goal}
          options={ONBOARDING_GOALS}
          labels={QUESTION_WORDS.goals}
          value={goal}
          onChange={pick(setGoal)}
        />
        <Choices
          name="customers"
          legend={QUESTION_WORDS.customersIn}
          options={CUSTOMER_SOURCES}
          labels={QUESTION_WORDS.sources}
          value={customersIn}
          onChange={pick(setCustomersIn)}
        />

        <div>
          <Label htmlFor="website">{QUESTION_WORDS.website}</Label>
          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <div
              className={cn(
                'flex h-11 min-w-0 flex-1 items-center overflow-hidden rounded-menu border bg-card focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring max-sm:basis-full',
                siteError ? 'border-danger' : 'border-border-strong',
                noSite && 'opacity-50',
              )}
            >
              <span className="flex h-full items-center border-r border-border bg-card-2 px-3 text-sm text-text-3">
                https://
              </span>
              <input
                id="website"
                inputMode="url"
                autoComplete="url"
                placeholder="yourbusiness.com"
                value={site}
                disabled={noSite}
                aria-invalid={!!siteError || undefined}
                aria-describedby={siteError ? 'website-error' : 'website-hint'}
                onChange={(e) => {
                  setSite(e.target.value);
                  setSiteError(null);
                }}
                className="h-full min-w-0 flex-1 bg-transparent px-3 text-[15px] text-text placeholder:text-placeholder focus:outline-none max-md:text-base"
              />
            </div>
            <Button
              variant="ghost"
              aria-pressed={noSite}
              onClick={() => {
                setNoSite((v) => !v);
                setSiteError(null);
              }}
              className={cn('h-11', noSite && 'bg-accent-soft text-accent-text')}
            >
              {QUESTION_WORDS.noWebsite}
            </Button>
          </div>
          {siteError ? (
            <FieldError id="website-error">{siteError}</FieldError>
          ) : (
            <p id="website-hint" className="mt-1.5 text-[12.5px] text-text-3">
              {noSite ? QUESTION_WORDS.noWebsiteHint : QUESTION_WORDS.websiteHint}
            </p>
          )}
        </div>

        <Choices
          name="team"
          legend={QUESTION_WORDS.teamSize}
          options={TEAM_SIZES}
          labels={QUESTION_WORDS.teams}
          value={teamSize}
          onChange={pick(setTeamSize)}
        />

        {error ? <FieldError>{error}</FieldError> : null}
        <div className="flex flex-wrap-reverse items-center justify-between gap-3">
          <ButtonLink href={next} variant="ghost" data-testid="questions-skip">
            {QUESTION_WORDS.skip}
          </ButtonLink>
          <Button type="submit" size="lg" loading={busy} data-testid="questions-continue">
            {QUESTION_WORDS.continue}
            <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>
      </form>

      <aside
        className="flex flex-col gap-3.5 border-t border-border bg-card-2 p-6 md:border-l md:border-t-0 md:px-[26px] md:py-9"
        aria-label={QUESTION_WORDS.preview}
        data-testid="questions-preview"
      >
        <Overline>{QUESTION_WORDS.preview}</Overline>
        <ol className="flex flex-col">
          {must.map((key, i) => (
            <li
              key={key}
              className="flex items-start gap-3 border-b border-border py-3 last:border-b-0"
            >
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full border border-border-strong bg-card text-xs font-semibold tabular-nums text-text-2">
                {i + 1}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{stepTitle(key)}</span>
                <span className="text-xs text-text-3">{previewDetail(key, answers)}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="h-px bg-border" />
        <Overline>{QUESTION_WORDS.previewLater}</Overline>
        <div className="flex flex-wrap gap-1.5">
          {later.map((key) => (
            <Badge key={key} variant="gray" className="bg-card-3">
              {stepTitle(key)}
            </Badge>
          ))}
        </div>
        <p className="mt-auto pt-2 text-xs text-text-3">{QUESTION_WORDS.numberFirst}</p>
      </aside>
    </Card>
  );
}

function Overline({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
      {children}
    </div>
  );
}
