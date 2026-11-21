'use client';
/**
 * A person's card: What they do and where (docs/outreach.md, decision 177): their line of work, the town they work in,
 * whom they serve and how far that is from the person, as the AI read it from their page or the chat, with Change to
 * set it by hand (`outreach.their_work.set`), which the AI then never writes over.
 */
import {
  LOCAL_WORDS as L,
  REACH,
  REACH_KEYS,
  theirWorkLine,
  type Reach,
  type TheirWorkShown,
} from '@hfos/core/addons/outreach/local';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

const HOW = { page: L.fromPage, chat: L.fromChat, typed: L.typed } as const;

export function TheirWork({
  workspaceId,
  profileId,
  shown,
  onSaved,
}: {
  workspaceId: string;
  profileId: string;
  shown: TheirWorkShown;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [work, setWork] = useState(shown.work ?? '');
  const [area, setArea] = useState(shown.area ?? '');
  const [reach, setReach] = useState<Reach | 'none'>(shown.reach ?? 'none');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const line = theirWorkLine(shown);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.their_work.set', {
          body: {
            workspaceId,
            profileId,
            work: work.trim() || null,
            area: area.trim() || null,
            reach: reach === 'none' ? null : reach,
          },
        }),
      );
      setOpen(false);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-4 border-t border-border pt-4 text-[13.5px]"
      data-testid="person-their-work"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {L.theirWork}
          </h3>
          <p className="mt-1" data-testid="person-their-work-line">
            {line ?? L.theirWorkNone}
          </p>
          {shown.how ? <p className="text-[12.5px] text-text-3">{HOW[shown.how]}</p> : null}
        </div>
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-testid="person-their-work-change"
        >
          {open ? L.cancel : L.change}
        </Button>
      </div>
      {open ? (
        <div className="mt-3 space-y-3 rounded-[10px] bg-card-2 p-3">
          <Field label={L.workLabel} htmlFor="person-their-work-work">
            <Input
              id="person-their-work-work"
              value={work}
              maxLength={80}
              placeholder={L.workPlaceholder}
              onChange={(e) => setWork(e.target.value)}
            />
          </Field>
          <Field label={L.areaLabel} htmlFor="person-their-work-area" error={error}>
            <Input
              id="person-their-work-area"
              value={area}
              maxLength={80}
              placeholder={L.areaPlaceholder}
              invalid={!!error}
              onChange={(e) => setArea(e.target.value)}
            />
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">{L.reachLabel}</div>
            <Segmented
              value={reach}
              onChange={setReach}
              ariaLabel={L.reachLabel}
              options={[
                ...REACH_KEYS.map((k) => ({ value: k, label: REACH[k] })),
                { value: 'none' as const, label: L.noReach },
              ]}
            />
          </div>
          <Button
            size="sm"
            loading={busy}
            onClick={() => void save()}
            data-testid="person-their-work-save"
          >
            {L.save}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
