'use client';
/**
 * Key dates and terms (board 4, design/realestate/KeyDates.dc.html): every date, amount and word typed in from the
 * contract and its amendments, with where it came from and who confirmed it. Two values that disagree are never
 * settled quietly: a person picks the one that counts, with a reason. Duties resting on a contract date wait as
 * drafts until it's confirmed.
 */
import { TERM_SOURCES, type TermSource } from '@hfos/core/addons/realestate/dates/key-dates';
import { SOURCE_WORDS } from '@hfos/core/addons/realestate/rule-words';
import {
  termKind,
  termLabel,
  termOnSide,
  termValueWords,
  TERM_KEYS,
  type TermKey,
} from '@hfos/core/addons/realestate/terms';
import { parseMoney, zoneLabel } from '@hfos/core';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { dealHref } from './bits';
import type { DealGet, TermHistory } from './types';
import { useAct } from './use-act';

type Entry = TermHistory['entries'][number];

const valueOf = (e: Pick<Entry, 'date' | 'time' | 'cents' | 'text'>) =>
  termValueWords({ valueDate: e.date, valueTime: e.time, valueCents: e.cents, valueText: e.text });
const sourceOf = (e: Pick<Entry, 'source' | 'sourceRef'>) =>
  [
    (SOURCE_WORDS as Readonly<Record<string, string>>)[e.source]?.replace(/^(the|an?) /, '') ??
      e.source,
    e.sourceRef,
  ]
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w![0]!.toUpperCase() + w!.slice(1) : w))
    .join(' · ');

export function DatesPage({
  workspaceId,
  timeZone,
  deal,
  history,
}: {
  workspaceId: string;
  timeZone: string;
  deal: DealGet;
  history: TermHistory;
}) {
  useLiveRefresh(['custom_record']);
  const d = deal.deal;
  const dealId = d.dealId;
  const [entering, setEntering] = useState<{ key?: TermKey; replaces?: Entry } | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const [resolving, setResolving] = useState<{ key: TermKey; keep: Entry } | null>(null);
  const { busy, act } = useAct();
  const byKey = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of history.entries) m.set(e.key, [...(m.get(e.key) ?? []), e]);
    return m;
  }, [history]);
  const unconfirmed = history.entries.filter(
    (e) => e.live && !e.confirmedAt && !deal.terms.find((t) => t.key === e.key)?.conflict,
  );
  const conflicts = deal.terms.filter((t) => t.conflict);
  const problems = (key: string) => deal.dateProblems.filter((p) => p.keys.includes(key));

  const confirm = (ids: string[]) =>
    act(
      'confirm',
      async () => {
        for (const entryId of ids)
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.term.confirm', {
              body: { workspaceId, dealId, entryId },
            }),
          );
      },
      ids.length === 1 ? 'Confirmed.' : `${ids.length} confirmed.`,
    );

  return (
    <div data-testid="realestate-dates">
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link href={dealHref(workspaceId, dealId)} className="text-accent-text hover:underline">
          {d.name}
        </Link>
        <span className="text-text-3">/</span>
        <span className="text-text-2">Key dates</span>
      </div>
      <PageHeader
        title="Key dates and terms"
        description={`${d.name}${deal.property ? ` · ${deal.property.address}` : ''} · every value keeps its source and history`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEntering({})} data-testid="add-term">
              Add a date or term
            </Button>
            {unconfirmed.length ? (
              <Button
                loading={busy === 'confirm'}
                onClick={() => void confirm(unconfirmed.map((e) => e.entryId))}
                data-testid="confirm-all"
              >
                Confirm {unconfirmed.length === 1 ? '1 value' : `${unconfirmed.length} values`}
              </Button>
            ) : null}
          </>
        }
      />

      {conflicts.map((t) => (
        <Callout key={t.key} tone="warning" className="mb-4" data-testid={`conflict-${t.key}`}>
          <div className="font-semibold">Two values for {t.label.toLowerCase()} disagree</div>
          <div className="mt-0.5">
            {t.entries
              .map(
                (e) => `${sourceOf(e)} says ${valueOf(e)}${e.confirmed ? '' : ' (not confirmed)'}`,
              )
              .join('. ')}
            . Duties that rest on it keep the earlier value until someone decides.
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {t.entries.map((e) => {
              const full = history.entries.find((h) => h.entryId === e.entryId);
              return full ? (
                <Button
                  key={e.entryId}
                  size="sm"
                  variant="secondary"
                  onClick={() => setResolving({ key: t.key as TermKey, keep: full })}
                >
                  Use {valueOf(e).replace(/, \d{4}/, '')}
                </Button>
              ) : null;
            })}
          </div>
        </Callout>
      ))}

      <Card className="overflow-x-auto p-0">
        {deal.terms.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13.5px] text-text-2">
            Nothing typed in yet. Add the dates and amounts from the contract; each keeps where it
            came from.
          </p>
        ) : (
          <table className="w-full min-w-[720px] text-[13.5px]" data-testid="terms-table">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-text-3">
                <th className="px-5 py-2.5 font-semibold">Date or term</th>
                <th className="px-3 py-2.5 font-semibold">Value</th>
                <th className="px-3 py-2.5 font-semibold">Source</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {deal.terms.map((t) => {
                const live = t.entries;
                const all = byKey.get(t.key) ?? [];
                const first = live[0];
                const full = first ? all.find((e) => e.entryId === first.entryId) : undefined;
                return (
                  <Fragment key={t.key}>
                    <tr className="border-t border-border align-top" data-testid={`term-${t.key}`}>
                      <td className="px-5 py-3">{t.label}</td>
                      <td className="px-3 py-3 font-medium">
                        {t.conflict ? live.map(valueOf).join(' → ') : first ? valueOf(first) : '—'}
                      </td>
                      <td className="px-3 py-3 text-text-2">{first ? sourceOf(first) : ''}</td>
                      <td className="px-3 py-3">
                        {t.conflict ? (
                          <Badge variant="danger">Conflict</Badge>
                        ) : full?.confirmedAt ? (
                          <Badge variant="ok">
                            Confirmed
                            {full.confirmedBy ? ` · ${full.confirmedBy.name.split(' ')[0]}` : ''}
                          </Badge>
                        ) : (
                          <Badge variant="pending">Typed · confirm</Badge>
                        )}
                        {problems(t.key).map((p) => (
                          <div
                            key={p.check}
                            className={
                              p.severity === 'problem'
                                ? 'mt-1 text-[12px] text-danger-text'
                                : 'mt-1 text-[12px] text-warning-text'
                            }
                          >
                            {p.words}
                          </div>
                        ))}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-right">
                        {!t.conflict && full && !full.confirmedAt ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy === 'confirm'}
                            onClick={() => void confirm([full.entryId])}
                          >
                            Confirm
                          </Button>
                        ) : null}
                        {full && !t.conflict ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEntering({ key: t.key as TermKey, replaces: full })}
                          >
                            Change
                          </Button>
                        ) : null}
                        {all.length > 1 ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowing(showing === t.key ? null : t.key)}
                          >
                            History ({all.length})
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                    {showing === t.key ? (
                      <tr>
                        <td colSpan={5} className="bg-card-2 px-5 py-3">
                          <ul className="space-y-1 text-[12.5px] text-text-2">
                            {all.map((e) => (
                              <li key={e.entryId}>
                                <span className={e.live ? 'font-medium text-text' : 'line-through'}>
                                  {valueOf(e)}
                                </span>{' '}
                                · {sourceOf(e)} · typed by {e.enteredBy?.name ?? 'HandsFreeOS'}
                                {e.confirmedBy ? ` · confirmed by ${e.confirmedBy.name}` : ''}
                                {e.supersededAt ? ' · replaced' : ''}
                                {e.rejectedAt ? ` · set aside: ${e.rejectedReason ?? ''}` : ''}
                                {e.note ? ` · ${e.note}` : ''}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <p className="mt-4 text-[12.5px] text-text-3">
        Business days skip weekends, US federal holidays and the days this office is closed. A date
        with no time is due at 11:59 PM {zoneLabel(timeZone)}. A deadline in calendar days that
        lands on a weekend or holiday keeps its date and shows a warning.
      </p>

      <TermDialog
        open={entering !== null}
        onOpenChange={(o) => !o && setEntering(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        side={d.side}
        start={entering}
      />
      <ResolveDialog
        open={resolving !== null}
        onOpenChange={(o) => !o && setResolving(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        pick={resolving}
      />
    </div>
  );
}

function TermDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  side,
  start,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  dealId: string;
  side: 'buyer' | 'listing';
  start: { key?: TermKey; replaces?: Entry } | null;
}) {
  const keys = TERM_KEYS.filter((k) => termOnSide(k, side));
  const [key, setKey] = useState<TermKey>('acceptance');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [source, setSource] = useState<TermSource>('contract');
  const [ref, setRef] = useState('');
  const [checked, setChecked] = useState(true);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, errors, act } = useAct(close);
  useEffect(() => {
    if (!open) return;
    const r = start?.replaces;
    setKey(start?.key ?? 'acceptance');
    setDate(r?.date ?? '');
    setTime(r?.time ?? '');
    setAmount('');
    setText(r?.text ?? '');
    setSource(r ? 'amendment' : 'contract');
    setRef('');
    setChecked(true);
  }, [open, start]);
  const kind = termKind(key);
  const group = (k: 'date' | 'money' | 'text') => keys.filter((x) => termKind(x) === k);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={start?.replaces ? `Change ${termLabel(key).toLowerCase()}` : 'Add a date or term'}
        description={
          start?.replaces
            ? `Now ${valueOf(start.replaces)}. The old value stays in its history.`
            : 'From the contract, an amendment, the lender or title.'
        }
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const cents = kind === 'money' ? parseMoney(amount) : null;
            void act(
              'go',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.term.enter', {
                    body: {
                      workspaceId,
                      dealId,
                      key,
                      source,
                      confirm: checked,
                      ...(kind === 'date' ? { date, ...(time ? { time } : {}) } : {}),
                      ...(kind === 'money' && cents !== null ? { cents } : {}),
                      ...(kind === 'text' ? { text: text.trim() } : {}),
                      ...(ref.trim() ? { sourceRef: ref.trim() } : {}),
                      ...(start?.replaces ? { replaces: start.replaces.entryId } : {}),
                    },
                  }),
                ),
              checked ? 'Saved and confirmed.' : 'Saved. Someone needs to confirm it.',
            );
          }}
        >
          {!start?.key ? (
            <Field label="What" htmlFor="term-key">
              <Select
                id="term-key"
                value={key}
                onChange={(e) => setKey(e.target.value as TermKey)}
                data-testid="term-key"
              >
                <optgroup label="Dates">
                  {group('date').map((k) => (
                    <option key={k} value={k}>
                      {termLabel(k)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Amounts">
                  {group('money').map((k) => (
                    <option key={k} value={k}>
                      {termLabel(k)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Words">
                  {group('text').map((k) => (
                    <option key={k} value={k}>
                      {termLabel(k)}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </Field>
          ) : null}
          {kind === 'date' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date" htmlFor="term-date" error={errors.date}>
                <Input
                  id="term-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  data-testid="term-date"
                />
              </Field>
              <Field
                label="Time (optional)"
                htmlFor="term-time"
                hint="None: 11:59 PM."
                error={errors.time}
              >
                <Input
                  id="term-time"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </Field>
            </div>
          ) : kind === 'money' ? (
            <Field label="Amount" htmlFor="term-amount" error={errors.cents}>
              <Input
                id="term-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="$412,000"
              />
            </Field>
          ) : (
            <Field label="Words" htmlFor="term-text" error={errors.text}>
              <Input id="term-text" value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Where it came from" htmlFor="term-source">
              <Select
                id="term-source"
                value={source}
                onChange={(e) => setSource(e.target.value as TermSource)}
              >
                {TERM_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_WORDS[s][0]!.toUpperCase() + SOURCE_WORDS[s].slice(1)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Where in it (optional)" htmlFor="term-ref" hint="“§7, page 4”">
              <Input id="term-ref" value={ref} onChange={(e) => setRef(e.target.value)} />
            </Field>
          </div>
          <Checkbox
            label="I checked it against the document"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'go'} data-testid="term-save">
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  pick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  dealId: string;
  pick: { key: TermKey; keep: Entry } | null;
}) {
  const [reason, setReason] = useState('');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, errors, act } = useAct(close);
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={pick ? `Use ${valueOf(pick.keep)}?` : 'Settle the conflict'}
        description="The other value is set aside, kept in the history. Duties that rest on it are dated again."
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pick) return;
            void act(
              'go',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.term.resolve_conflict', {
                    body: {
                      workspaceId,
                      dealId,
                      key: pick.key,
                      keepEntryId: pick.keep.entryId,
                      reason: reason.trim(),
                    },
                  }),
                ),
              'Settled.',
            );
          }}
        >
          <Field
            label="Why this one"
            htmlFor="resolve-why"
            error={errors.reason}
            hint="“Amendment 1 is signed by both sides.”"
          >
            <Input id="resolve-why" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'go'} disabled={!reason.trim()}>
              Use it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
