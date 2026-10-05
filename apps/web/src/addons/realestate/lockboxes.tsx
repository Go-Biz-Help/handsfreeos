'use client';
/**
 * A listing's lockboxes and who opened them (round seven; boards 94-95, design/realestate/LockboxesWeb.dc.html and
 * LockboxAdd.dc.html). Chris decided (2026-10-05): read SentriLock's and Supra's emails, guard codes.
 *
 * - A code typed here goes to the worker first, which seals it for this business (`/v1/addons/sealed`); the command
 *   only ever takes it sealed, so the API, the database and phones never hold it in the clear.
 * - Show code asks the worker to open it for someone on this listing (`/v1/addons/sealed/reveal`), and the deal's
 *   history keeps that it was shown. It goes from the screen once hidden or the page reloads.
 * - Who opened them comes from SentriLock's and Supra's "opened" emails, each with the showing it fits, if any.
 */
import {
  LOCKBOX_KIND_CHOICES,
  LOCKBOX_KIND_KEYS,
  LOCKBOX_KIND_LABELS,
  LOCKBOX_WORDS,
  openingSource,
  openingWho,
  type LockboxKindKey,
} from '@hfos/core/addons/realestate/lockbox-words';
import { Eye, Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { CardHead } from './bits';
import type { LockboxList } from './types';
import { useAct } from './use-act';

type Lockbox = LockboxList['lockboxes'][number];

const SEALED = { addonId: 'realestate', key: 'lockbox_code' } as const;

/** "Today · 2:14 PM", "Mon · 7:48 PM", "Oct 2 · 9:00 AM", in the business's time zone. */
function whenOf(iso: string, timeZone: string, now = new Date()): string {
  const at = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone });
  const time = at.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  if (day(at) === day(now)) return `Today · ${time}`;
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  const date =
    days < 6
      ? at.toLocaleDateString('en-US', { timeZone, weekday: 'short' })
      : at.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' });
  return `${date} · ${time}`;
}

export function LockboxesCard({
  workspaceId,
  dealId,
  timeZone,
  list,
  live,
}: {
  workspaceId: string;
  dealId: string;
  timeZone: string;
  list: LockboxList;
  live: boolean;
}) {
  const { busy, act } = useAct();
  const [editing, setEditing] = useState<Lockbox | 'new' | null>(null);
  // What Show code opened, by lockbox, until hidden: never kept anywhere else.
  const [shown, setShown] = useState<Record<string, { value: string; at: string }>>({});
  const [revealing, setRevealing] = useState<string | null>(null);

  async function reveal(l: Lockbox) {
    setRevealing(l.id);
    try {
      const { value } = await workerPost<{ value: string }>('/v1/addons/sealed/reveal', {
        workspaceId,
        ...SEALED,
        recordId: dealId,
        itemId: l.id,
      });
      const at = new Date().toLocaleTimeString('en-US', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
      });
      setShown((s) => ({ ...s, [l.id]: { value, at } }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRevealing(null);
    }
  }
  const hide = (id: string) =>
    setShown((s) => {
      const { [id]: _, ...rest } = s;
      return rest;
    });

  return (
    <>
      <Card className="overflow-x-auto p-0" data-testid="lockboxes">
        <div className="px-5 pt-4">
          <CardHead
            title={LOCKBOX_WORDS.title}
            action={
              live ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing('new')}
                  data-testid="lockbox-add"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.75} /> {LOCKBOX_WORDS.add}
                </Button>
              ) : undefined
            }
          />
        </div>
        {list.lockboxes.length === 0 ? (
          <p className="px-5 pb-5 text-[13.5px] text-text-2">{LOCKBOX_WORDS.none}</p>
        ) : (
          <table className="w-full min-w-[560px] text-left text-[13.5px]">
            <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
              <tr>
                <th className="px-5 py-2.5 font-semibold">Lockbox</th>
                <th className="px-3 py-2.5 font-semibold">Where</th>
                <th className="px-3 py-2.5 font-semibold">Serial</th>
                <th className="px-3 py-2.5 font-semibold">Code</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {list.lockboxes.map((l) => {
                const open = shown[l.id];
                return (
                  <tr
                    key={l.id}
                    className="border-b border-border align-top last:border-b-0"
                    data-testid={`lockbox-${l.id}`}
                  >
                    <td className="px-5 py-3 font-medium">{l.kindLabel}</td>
                    <td className="px-3 py-3">{l.place ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-3 tabular-nums">{l.serial ?? '—'}</td>
                    <td className="px-3 py-3">
                      {!l.hasCode ? (
                        <span className="text-text-3">{LOCKBOX_WORDS.noCode}</span>
                      ) : open ? (
                        <>
                          <span
                            className="font-mono text-[15px] font-semibold tracking-[0.08em]"
                            data-testid="lockbox-code"
                          >
                            {open.value}
                          </span>
                          <div className="text-[12px] text-text-3">
                            {LOCKBOX_WORDS.shownAt(open.at)}
                          </div>
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-text-2">
                          <Lock className="h-3.5 w-3.5" strokeWidth={1.75} />
                          {LOCKBOX_WORDS.keptLocked}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {l.hasCode ? (
                          open ? (
                            <Button size="sm" variant="ghost" onClick={() => hide(l.id)}>
                              {LOCKBOX_WORDS.hide}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={revealing === l.id}
                              onClick={() => void reveal(l)}
                              data-testid="lockbox-show"
                            >
                              {revealing === l.id ? null : (
                                <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                              )}
                              {LOCKBOX_WORDS.showCode}
                            </Button>
                          )
                        ) : null}
                        {live ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditing(l)}
                              data-testid="lockbox-edit"
                            >
                              {LOCKBOX_WORDS.edit}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={busy === `remove:${l.id}`}
                              onClick={() =>
                                void act(
                                  `remove:${l.id}`,
                                  async () =>
                                    unwrap(
                                      await apiBrowser().POST(
                                        '/v1/commands/realestate.lockbox.remove',
                                        { body: { workspaceId, dealId, id: l.id } },
                                      ),
                                    ),
                                  LOCKBOX_WORDS.removed,
                                )
                              }
                              data-testid="lockbox-remove"
                            >
                              {LOCKBOX_WORDS.remove}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="overflow-x-auto p-0" data-testid="lockbox-openings">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
          <CardHead title={LOCKBOX_WORDS.openingsTitle} />
          <span className="text-[12.5px] text-text-3">{LOCKBOX_WORDS.openingsFrom}</span>
        </div>
        {list.openings.length === 0 ? (
          <p className="px-5 pb-5 text-[13.5px] text-text-2">{LOCKBOX_WORDS.noOpenings}</p>
        ) : (
          <table className="w-full min-w-[560px] text-left text-[13.5px]">
            <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
              <tr>
                <th className="px-5 py-2.5 font-semibold">When</th>
                <th className="px-3 py-2.5 font-semibold">Who</th>
                <th className="px-3 py-2.5 font-semibold">From</th>
                <th className="px-5 py-2.5 font-semibold">Showing</th>
              </tr>
            </thead>
            <tbody>
              {list.openings.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-border align-top last:border-b-0"
                  data-testid={`lockbox-opening-${o.id}`}
                >
                  <td className="whitespace-nowrap px-5 py-3 tabular-nums">
                    {whenOf(o.openedAt, timeZone)}
                  </td>
                  <td className="px-3 py-3">{openingWho(o)}</td>
                  <td className="px-3 py-3 text-text-2">{openingSource(o.vendor)}</td>
                  <td className="px-5 py-3">
                    <Badge variant={o.booked ? 'ok' : 'pending'}>
                      {o.booked ? LOCKBOX_WORDS.fits : LOCKBOX_WORDS.noShowing}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <LockboxDialog
        lockbox={editing}
        onClose={() => setEditing(null)}
        workspaceId={workspaceId}
        dealId={dealId}
      />
    </>
  );
}

/** Adding a lockbox, or changing one: the code is sealed by the worker as it's saved, and never shown here. */
function LockboxDialog({
  lockbox,
  onClose,
  workspaceId,
  dealId,
}: {
  lockbox: Lockbox | 'new' | null;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
}) {
  const existing = lockbox && lockbox !== 'new' ? lockbox : null;
  return (
    <Dialog open={lockbox !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={existing ? existing.kindLabel : LOCKBOX_WORDS.add}
        className="w-[min(520px,calc(100vw-32px))]"
      >
        {lockbox !== null ? (
          <LockboxForm
            key={existing?.id ?? 'new'}
            existing={existing}
            onClose={onClose}
            workspaceId={workspaceId}
            dealId={dealId}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LockboxForm({
  existing,
  onClose,
  workspaceId,
  dealId,
}: {
  existing: Lockbox | null;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
}) {
  const [kind, setKind] = useState<LockboxKindKey>(existing?.kind ?? 'sentrilock');
  const [place, setPlace] = useState(existing?.place ?? '');
  const [serial, setSerial] = useState(existing?.serial ?? '');
  const [code, setCode] = useState('');
  const { busy, errors, setErrors, act } = useAct(onClose);
  const vendor = kind === 'sentrilock' || kind === 'supra';
  return (
    <form
      className="mt-4 flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          'save',
          async () => {
            let sealed: string | undefined;
            if (code.trim()) {
              try {
                sealed = (
                  await workerPost<{ sealed: string }>('/v1/addons/sealed', {
                    workspaceId,
                    ...SEALED,
                    value: code.trim(),
                  })
                ).sealed;
              } catch (err) {
                setErrors({ code: errorMessage(err) });
                throw err;
              }
            }
            return unwrap(
              await apiBrowser().POST('/v1/commands/realestate.lockbox.save', {
                body: {
                  workspaceId,
                  dealId,
                  id: existing?.id ?? crypto.randomUUID(),
                  kind,
                  place: place.trim() || null,
                  serial: serial.trim() || null,
                  ...(sealed ? { code: sealed } : {}),
                },
              }),
            );
          },
          code.trim() ? LOCKBOX_WORDS.saved : LOCKBOX_WORDS.savedNoCode,
        );
      }}
    >
      <Field label={LOCKBOX_WORDS.kind} htmlFor="lb-kind" error={errors.kind}>
        <Segmented
          value={kind}
          onChange={setKind}
          ariaLabel={LOCKBOX_WORDS.kind}
          options={LOCKBOX_KIND_KEYS.map((k) => ({
            value: k,
            label: LOCKBOX_KIND_CHOICES[k],
            testId: `lockbox-kind-${k}`,
          }))}
        />
      </Field>
      <Field label={LOCKBOX_WORDS.place} htmlFor="lb-place" error={errors.place}>
        <Input
          id="lb-place"
          value={place}
          maxLength={120}
          placeholder={LOCKBOX_WORDS.placeHint}
          onChange={(e) => setPlace(e.target.value)}
          data-testid="lockbox-place"
        />
      </Field>
      <Field
        label={LOCKBOX_WORDS.serial}
        htmlFor="lb-serial"
        error={errors.serial}
        hint={vendor ? LOCKBOX_WORDS.serialHint(LOCKBOX_KIND_LABELS[kind]) : undefined}
      >
        <Input
          id="lb-serial"
          value={serial}
          maxLength={60}
          onChange={(e) => setSerial(e.target.value)}
          data-testid="lockbox-serial"
        />
      </Field>
      <Field
        label={LOCKBOX_WORDS.code}
        htmlFor="lb-code"
        error={errors.code}
        hint={
          existing?.hasCode
            ? `${LOCKBOX_WORDS.codeKeep} ${LOCKBOX_WORDS.codeHelp}`
            : LOCKBOX_WORDS.codeHelp
        }
      >
        <div className="relative">
          <Input
            id="lb-code"
            type="password"
            autoComplete="off"
            value={code}
            maxLength={500}
            onChange={(e) => setCode(e.target.value)}
            data-testid="lockbox-code-input"
          />
          <Lock
            className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3"
            strokeWidth={1.75}
          />
        </div>
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={busy === 'save'} data-testid="lockbox-save">
          Save
        </Button>
      </div>
    </form>
  );
}
