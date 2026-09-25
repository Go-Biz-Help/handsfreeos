'use client';
import { CONTACT_AI_DETAIL_LABELS, type ContactAiDetailField } from '@hfos/core';
import { Sparkles, Square, Tag } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { formatDate } from '@/lib/format';

type Tags = Ok<'/v1/queries/tag.list'>['tags'];
type Status = Ok<'/v1/queries/contact_ai.status'>;
type Sweep = Status['recent'][number];
type Review = Ok<'/v1/queries/contact_ai.reviews'>['items'][number];

/** While a pass is going: how often the card looks again. */
const POLL_MS = 4000;

const heading = 'text-lg font-semibold tracking-tight';
const note = 'text-[13px] leading-[1.5] text-text-2';

const detailWord = (field: string): string =>
  CONTACT_AI_DETAIL_LABELS[field as ContactAiDetailField] ?? field;

/**
 * Settings → Tags (0107): the business's tags; the AI going through the whole customer list — what to look for,
 * which tags it may use, only the customers with one tag, whether it also fixes contact details — with its progress
 * and a Stop; and what the AI changed lately, each change with its reason. Everything it changes is also in the
 * audit log.
 */
export function AiTagging({
  workspaceId,
  tags,
  status: initial,
  reviews,
  canSeeAudit,
  canChangeAutomations,
}: {
  workspaceId: string;
  tags: Tags;
  status: Status;
  reviews: Review[];
  canSeeAudit: boolean;
  canChangeAutomations: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [onlyTagId, setOnlyTagId] = useState('');
  const [fixDetails, setFixDetails] = useState(false);
  const running = status.running;

  useEffect(() => setStatus(initial), [initial]);
  // Follow the pass while it goes, and bring the log up to date once it ends.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      try {
        const next = unwrap(
          await apiBrowser().POST('/v1/queries/contact_ai.status', { body: { workspaceId } }),
        );
        setStatus(next);
        if (!next.running) router.refresh();
      } catch {
        // The next look tries again.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, workspaceId, router]);

  async function start() {
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/contact_ai.start_sweep', {
          body: {
            workspaceId,
            instructions: instructions.trim(),
            tagIds: picked,
            onlyTagId: onlyTagId || null,
            fixDetails,
          },
        }),
      );
      toast.success(`The AI is going through ${out.total} customer${out.total === 1 ? '' : 's'}.`);
      setInstructions('');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop(sweep: Sweep) {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/contact_ai.cancel_sweep', {
          body: { workspaceId, sweepId: sweep.id },
        }),
      );
      toast.success('Stopped. What it already changed stays.');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const last = status.recent.find((s) => s.status !== 'running') ?? null;

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-6">
        <h2 className={heading}>Tags</h2>
        <p className={`${note} mb-4 mt-1`}>
          The labels you put on customers and leads. Add one from any customer’s page.
        </p>
        {tags.length ? (
          <ul className="flex flex-wrap gap-2" data-testid="tag-list">
            {tags.map((t) => (
              <li
                key={t.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[13px]"
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: t.color }}
                />
                {t.name}
                <span className="text-text-3">{t.usage}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={note}>No tags yet.</p>
        )}
      </Card>

      <Card className="p-6" data-testid="ai-tagging">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent-text" aria-hidden />
          <h2 className={heading}>Let the AI tag your customers</h2>
        </div>
        <p className={`${note} mt-1`}>
          The AI reads each customer — their details, messages, calls, visits, deals, payments and
          forms — and puts on the tags that fit, or takes off ones it put on that no longer do. A
          tag someone on your team put on stays. Every change is kept with its reason
          {canSeeAudit ? (
            <>
              {' '}
              in the{' '}
              <Link
                href={`/app/w/${workspaceId}/audit`}
                className="text-accent-text hover:underline"
              >
                audit log
              </Link>
            </>
          ) : null}
          .
        </p>
        <p className={`${note} mt-2`}>
          On its own it tags {status.switches.tags ? 'each customer' : 'nobody'} after a new
          message, call, visit or payment, and{' '}
          {status.switches.details
            ? 'keeps their contact details up to date'
            : 'leaves their details alone'}
          {canChangeAutomations ? (
            <>
              {' '}
              (
              <Link
                href={`/app/w/${workspaceId}/settings/automations`}
                className="text-accent-text hover:underline"
              >
                Automations
              </Link>
              )
            </>
          ) : null}
          . Last 7 days: {status.lastWeek.changed} of {status.lastWeek.reviewed} customers changed.
        </p>

        {running ? (
          <div
            className="mt-5 flex flex-col gap-3 rounded-control border border-border bg-card-2 p-4"
            data-testid="ai-tagging-running"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="pending">Going through your customers</Badge>
              <span className="text-sm">
                {running.reviewed} of {running.total} looked at · {running.changed} changed
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-border" aria-hidden>
              <div
                className="h-full bg-accent transition-[width]"
                style={{
                  width: `${running.total ? Math.min(100, (running.reviewed / running.total) * 100) : 0}%`,
                }}
              />
            </div>
            {running.note ? <p className={note}>{running.note}</p> : null}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void stop(running)}
              >
                <Square className="h-3.5 w-3.5" aria-hidden /> Stop
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="mt-5 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <div>
              <Label htmlFor="ai-tag-instructions">What to look for (optional)</Label>
              <Textarea
                id="ai-tag-instructions"
                value={instructions}
                maxLength={2000}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Anyone who asked about solar gets Solar interest. Customers who spent over $2,000 are VIP."
              />
            </div>
            {tags.length ? (
              <fieldset>
                <legend className="mb-2 text-[13px] font-medium">
                  Tags it may use {picked.length ? '' : '(all of them)'}
                </legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {tags.map((t) => (
                    <Checkbox
                      key={t.id}
                      label={t.name}
                      checked={picked.includes(t.id)}
                      onChange={(e) =>
                        setPicked((p) =>
                          e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id),
                        )
                      }
                    />
                  ))}
                </div>
              </fieldset>
            ) : (
              <p className={note}>
                Add a tag on any customer’s page first, then the AI can put it on.
              </p>
            )}
            <div className="max-w-sm">
              <Label htmlFor="ai-tag-only">Which customers</Label>
              <Select
                id="ai-tag-only"
                value={onlyTagId}
                onChange={(e) => setOnlyTagId(e.target.value)}
              >
                <option value="">Everyone</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    Only customers tagged {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <Checkbox
              label="Also fill in and fix names, emails, numbers and addresses customers gave"
              checked={fixDetails}
              onChange={(e) => setFixDetails(e.target.checked)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy || !tags.length}>
                <Tag className="h-4 w-4" aria-hidden /> Go through my customers
              </Button>
              {last ? (
                <span className={note}>
                  Last time, {formatDate(last.createdAt)}:{' '}
                  {last.status === 'done'
                    ? `${last.reviewed} looked at, ${last.changed} changed`
                    : (last.note ?? last.status)}
                </span>
              ) : null}
            </div>
          </form>
        )}
      </Card>

      <Card className="p-6">
        <h2 className={heading}>What the AI changed lately</h2>
        <p className={`${note} mb-4 mt-1`}>Newest first, each change with the AI’s reason.</p>
        {reviews.length ? (
          <ul className="flex flex-col divide-y divide-border" data-testid="ai-tagging-log">
            {reviews.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Link
                    href={`/app/w/${workspaceId}/customers/people/${r.person.id}`}
                    className="font-medium hover:underline"
                  >
                    {r.person.fullName}
                  </Link>
                  <span className="text-[12.5px] text-text-3">
                    {formatDate(r.createdAt, { time: true })} ·{' '}
                    {r.trigger === 'sweep' ? 'going through the list' : 'after something happened'}
                  </span>
                </div>
                <ul className="flex flex-col gap-0.5 text-[13.5px]">
                  {r.addedTags.map((t) => (
                    <li key={`on-${t.name}`}>
                      Put on <strong className="font-medium">{t.name}</strong>{' '}
                      <span className="text-text-2">— {t.reason}</span>
                    </li>
                  ))}
                  {r.removedTags.map((t) => (
                    <li key={`off-${t.name}`}>
                      Took off <strong className="font-medium">{t.name}</strong>{' '}
                      <span className="text-text-2">— {t.reason}</span>
                    </li>
                  ))}
                  {r.details.map((d, i) => (
                    <li key={`d-${i}`}>
                      Changed the {detailWord(d.field)}: {d.from ?? 'none'} → {d.to ?? 'none'}{' '}
                      <span className="text-text-2">— {d.reason}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className={note}>Nothing yet.</p>
        )}
      </Card>
    </div>
  );
}
