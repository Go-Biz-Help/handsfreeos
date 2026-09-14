'use client';
import { Plus, Quote } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/lib/api/errors';
import type { KnowledgeItemKind, KnowledgeProfileGet, KnowledgeSuggestion } from '@/lib/api/types';
import { acceptSuggestion, rejectSuggestion, saveProfile } from '@/lib/knowledge/actions';
import { AI_TINT, KIND_PLURAL, suggestionFrom } from '@/lib/knowledge/labels';
import { missingParts } from '@/lib/knowledge/profile-parts';
import { cn } from '@/lib/utils';
import { KindChip, Meter, TagChip } from './chips';
import { TryIt } from './try-it';

export interface KindCount {
  readonly kind: KnowledgeItemKind;
  readonly published: number;
  readonly drafts: number;
  readonly newest: string | null;
}

export function KnowledgeOverview({
  workspaceId,
  canManage,
  profile,
  counts,
  countsCapped,
  suggestions,
  moreSuggestions,
  samples,
  ask,
}: {
  workspaceId: string;
  canManage: boolean;
  profile: KnowledgeProfileGet;
  counts: readonly KindCount[];
  countsCapped: boolean;
  suggestions: readonly KnowledgeSuggestion[];
  moreSuggestions: boolean;
  samples: readonly string[];
  ask: string;
}) {
  const base = `/app/w/${workspaceId}/knowledge`;
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-w-0 flex-col gap-3.5">
        <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <ProfileCard
            workspaceId={workspaceId}
            canManage={canManage}
            profile={profile}
            base={base}
          />
          <ToneCard profile={profile.profile} canManage={canManage} base={base} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="knowledge-tiles">
          {counts.map((c) => (
            <Link
              key={c.kind}
              href={c.kind === 'document' ? `${base}/documents` : `${base}/items?kind=${c.kind}`}
              data-testid={`tile-${c.kind}`}
              className="flex min-w-0 flex-col gap-[3px] rounded-card border border-border bg-card px-4 py-3.5 shadow-1 transition-colors hover:border-border-strong"
            >
              <KindChip kind={c.kind} label={KIND_PLURAL[c.kind]} className="self-start" />
              <span className="mt-1 text-2xl font-semibold leading-tight tracking-[-0.01em]">
                {c.published + c.drafts}
                {countsCapped ? '+' : ''}
              </span>
              <span className="truncate text-xs text-text-3">
                {c.published + c.drafts === 0
                  ? 'None yet'
                  : c.drafts
                    ? `${c.published} published · ${c.drafts} ${c.drafts === 1 ? 'draft' : 'drafts'}`
                    : c.kind === 'document' && c.newest
                      ? c.newest
                      : 'All published'}
              </span>
            </Link>
          ))}
        </div>
        <SuggestionsPreview
          workspaceId={workspaceId}
          canManage={canManage}
          items={suggestions}
          more={moreSuggestions}
          base={base}
        />
      </div>
      <TryIt workspaceId={workspaceId} canManage={canManage} samples={samples} initial={ask} />
    </div>
  );
}

function ProfileCard({
  workspaceId,
  canManage,
  profile,
  base,
}: {
  workspaceId: string;
  canManage: boolean;
  profile: KnowledgeProfileGet;
  base: string;
}) {
  const router = useRouter();
  const p = profile.profile;
  const [prices, setPrices] = useState(p.allowPrices);
  const [busy, setBusy] = useState(false);
  const missing = missingParts(p);
  const rows = [
    { label: 'What you do', value: p.description },
    { label: 'Services', value: p.services.map((s) => s.name).join(', ') },
    { label: 'Service area', value: p.serviceArea },
    { label: 'Hours', value: p.hours },
  ].filter((r) => r.value.trim());

  async function togglePrices(next: boolean) {
    setPrices(next);
    setBusy(true);
    try {
      await saveProfile(workspaceId, { ...p, allowPrices: next });
      toast.success(
        next
          ? 'On. The AI may quote prices exactly as you wrote them.'
          : 'Off. The AI won’t quote prices.',
      );
      router.refresh();
    } catch (e) {
      setPrices(!next);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col px-[18px] py-4" data-testid="profile-card">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Business profile</h2>
        {canManage ? (
          <Link
            href={`${base}/profile`}
            className="text-[13px] font-medium text-accent-text hover:underline"
            data-testid="profile-edit"
          >
            Edit
          </Link>
        ) : null}
      </div>
      <div className="mb-1 flex items-center gap-2.5">
        <Meter
          filled={profile.completeness.filled}
          total={profile.completeness.total}
          className="flex-1"
        />
        <span className="text-xs font-medium" data-testid="profile-completeness">
          {profile.completeness.filled} of {profile.completeness.total}
        </span>
      </div>
      {missing.length ? (
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-xs text-text-3">
          <span>Still to add:</span>
          {missing.map((m) =>
            canManage ? (
              <Link
                key={m.key}
                href={`${base}/profile#${m.key}`}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-border-strong bg-card px-2 text-xs font-medium text-text-2 hover:bg-card-2"
              >
                <Plus className="h-3 w-3" strokeWidth={1.75} />
                {m.label}
              </Link>
            ) : (
              <span key={m.key} className="text-text-2">
                {m.label}
              </span>
            ),
          )}
        </div>
      ) : (
        <p className="mb-2.5 text-xs text-success-text">Everything the AI needs is filled in.</p>
      )}
      {rows.length ? (
        <dl className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-[7px] text-[13px]">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-text-3">{r.label}</dt>
              <dd className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-[13px] text-text-2">
          Nothing yet. Say what you do, your services, where and when you work, so the AI can answer
          customers.
        </p>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border pt-2.5">
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium">AI may quote prices</span>
          <span className="text-xs text-text-3" data-testid="prices-note">
            {prices
              ? 'On. Only prices written in your services or published items, word for word.'
              : 'Off. The AI says your team will confirm prices.'}
          </span>
        </span>
        <Switch
          checked={prices}
          onChange={(next) => void togglePrices(next)}
          label="AI may quote prices"
          disabled={!canManage || busy}
          testId="prices-switch"
        />
      </div>
    </Card>
  );
}

function ToneCard({
  profile,
  canManage,
  base,
}: {
  profile: KnowledgeProfileGet['profile'];
  canManage: boolean;
  base: string;
}) {
  return (
    <Card className="px-[18px] py-4" data-testid="tone-card">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Tone of voice</h2>
        {canManage ? (
          <Link
            href={`${base}/profile#tone`}
            className="text-[13px] font-medium text-accent-text hover:underline"
          >
            Edit
          </Link>
        ) : null}
      </div>
      {profile.tone.trim() ? (
        <div className={cn('flex items-start gap-2.5 rounded-[10px] px-3.5 py-3', AI_TINT)}>
          <Quote className="mt-0.5 h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
          <span className="text-[17px] font-semibold leading-snug" data-testid="tone-text">
            {profile.tone}
          </span>
        </div>
      ) : (
        <p className="rounded-[10px] bg-card-2 px-3.5 py-3 text-[13px] text-text-2">
          Not set yet. Say how your texts and emails should sound, like “Friendly and plain, no
          jargon”.
        </p>
      )}
      {profile.wordsToUse.length ? (
        <>
          <div className="mb-1.5 mt-3 text-[13px] font-medium">Words to use</div>
          <div className="flex flex-wrap gap-1.5">
            {profile.wordsToUse.map((w) => (
              <TagChip key={w}>{w}</TagChip>
            ))}
          </div>
        </>
      ) : null}
      {profile.wordsToAvoid.length ? (
        <>
          <div className="mb-1.5 mt-2.5 text-[13px] font-medium">Words to avoid</div>
          <div className="flex flex-wrap gap-1.5">
            {profile.wordsToAvoid.map((w) => (
              <TagChip key={w} className="text-danger-text">
                {w}
              </TagChip>
            ))}
          </div>
        </>
      ) : null}
      {profile.signature.trim() ? (
        <p className="mt-2.5 text-[13px] text-text-2">
          Signed <span className="font-medium text-text">{profile.signature}</span>
        </p>
      ) : null}
      <p className="mt-2.5 text-[12.5px] text-text-3">
        Every AI-written text and email uses this voice.
      </p>
    </Card>
  );
}

function SuggestionsPreview({
  workspaceId,
  canManage,
  items,
  more,
  base,
}: {
  workspaceId: string;
  canManage: boolean;
  items: readonly KnowledgeSuggestion[];
  more: boolean;
  base: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const shown = items.slice(0, 3);

  async function decide(s: KnowledgeSuggestion, accept: boolean) {
    setBusy(s.id);
    try {
      if (accept) {
        await acceptSuggestion(workspaceId, s.id);
        toast.success(`Added “${s.proposed.title}” and published it.`);
      } else {
        await rejectSuggestion(workspaceId, s.id);
        toast.success('Rejected. Nothing was added.');
      }
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="overflow-hidden" data-testid="overview-suggestions">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold">Suggestions</h2>
          {items.length ? (
            <Badge variant="accent">{more ? '100+' : items.length} waiting</Badge>
          ) : null}
        </span>
        <Link
          href={`${base}/suggestions`}
          className="text-[13px] font-medium text-accent-text hover:underline"
        >
          See all
        </Link>
      </div>
      {shown.length ? (
        shown.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2.5"
          >
            <KindChip kind={s.reason === 'gap' ? 'gap' : s.kind} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium">
                {s.reason === 'gap' ? `Customers asked: ${s.proposed.title}` : s.proposed.title}
              </span>
              <span className="truncate text-xs text-text-3">{suggestionFrom(s)}</span>
            </span>
            {canManage ? (
              s.reason === 'gap' ? (
                <ButtonLink href={`${base}/suggestions?reason=gap`} size="sm">
                  Write the answer
                </ButtonLink>
              ) : (
                <span className="flex gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === s.id}
                    disabled={!!busy}
                    onClick={() => void decide(s, true)}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => void decide(s, false)}
                  >
                    Reject
                  </Button>
                </span>
              )
            ) : null}
          </div>
        ))
      ) : (
        <p className="border-t border-border px-4 py-5 text-[13px] text-text-2">
          Nothing waiting. Suggestions come from scanning your website, from questions the AI
          couldn’t answer, and from Go Biz Help.
        </p>
      )}
    </Card>
  );
}
