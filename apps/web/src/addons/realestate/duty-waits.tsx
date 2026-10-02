'use client';
/**
 * What a duty waits on, what waits on it, and what moves if it slips (board 53, design/realestate/DutyWaitsOn.dc.html).
 * Built-in orders stay; the ones a person added can be taken back. Drawn inside the duty drawer.
 */
import { dueWords } from '@hfos/core/addons/realestate/rule-words';
import {
  DUTY_STATUS_LABELS,
  isDoneDuty,
  type DutyStatus,
} from '@hfos/core/addons/realestate/states';
import { Check, Circle, Plus, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { DutyGet } from './types';

type Line = DutyGet['waitsOn'][number];
type Act = (key: string, run: () => Promise<unknown>, done?: string) => Promise<unknown>;

/** "The sellers · overdue 2 days · waiting on Cool Air": who has it, and where it stands. */
function lineWords(w: Line, timeZone: string): string {
  const status = w.status as DutyStatus;
  return [
    w.accountableName ?? 'Nobody accountable',
    isDoneDuty(status)
      ? DUTY_STATUS_LABELS[status].toLowerCase()
      : w.dueAt
        ? dueWords(w.dueAt, timeZone)
        : null,
    w.waitingOn ? `waiting on ${w.waitingOn}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function LineIcon({ w }: { w: Line }) {
  if (isDoneDuty(w.status as DutyStatus))
    return <Check className="mt-0.5 h-4 w-4 flex-none text-success" strokeWidth={2} />;
  if (w.overdue)
    return <TriangleAlert className="mt-0.5 h-4 w-4 flex-none text-danger" strokeWidth={1.75} />;
  return <Circle className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />;
}

export function DutyWaits({
  workspaceId,
  data,
  timeZone,
  open,
  busy,
  act,
}: {
  workspaceId: string;
  data: DutyGet;
  timeZone: string;
  /** The duty is still to do, so its order can change. */
  open: boolean;
  busy: string | null;
  act: Act;
}) {
  const { duty, waitsOn, waitingOnThis, ifItSlips } = data;
  const [adding, setAdding] = useState(false);
  const [others, setOthers] = useState<{ id: string; title: string }[] | null>(null);
  const [pick, setPick] = useState('');
  const api = apiBrowser();
  const ids = { workspaceId, dutyId: duty.dutyId };

  function startAdding() {
    setAdding(true);
    setPick('');
    if (others === null)
      void api
        .POST('/v1/queries/realestate.duty.list', {
          body: { workspaceId, dealId: duty.dealId, mine: false, status: 'open', limit: 500 },
        })
        .then(unwrap)
        .then((d) =>
          setOthers(
            d.duties
              .filter(
                (o) => o.dutyId !== duty.dutyId && !waitsOn.some((w) => w.dutyId === o.dutyId),
              )
              .map((o) => ({ id: o.dutyId, title: o.title })),
          ),
        )
        .catch(() => setOthers([]));
  }

  const slips = [
    ifItSlips.waiting.length
      ? `${ifItSlips.waiting.join(', ')} ${ifItSlips.waiting.length === 1 ? 'waits' : 'wait'} on it.`
      : null,
    ifItSlips.sameDate.length
      ? `${ifItSlips.sameDate.length === 1 ? 'One more duty rests' : `${ifItSlips.sameDate.length} more duties rest`} on the same date: ${ifItSlips.sameDate.join(', ')}.`
      : null,
  ].filter(Boolean);

  if (!waitsOn.length && !waitingOnThis.length && !slips.length && !open) return null;

  return (
    <section className="space-y-3" data-testid="duty-waits">
      <div>
        <h3 className="mb-1.5 font-medium">Waits on</h3>
        {waitsOn.length ? (
          <ul className="divide-y divide-border rounded-menu border border-border">
            {waitsOn.map((w) => (
              <li
                key={w.dutyId}
                className="flex items-start gap-2.5 px-3 py-2"
                data-testid="duty-waits-on"
              >
                <LineIcon w={w} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{w.title}</div>
                  <div
                    className={
                      w.overdue ? 'text-[12.5px] text-danger-text' : 'text-[12.5px] text-text-3'
                    }
                  >
                    {lineWords(w, timeZone)}
                  </div>
                </div>
                {w.builtIn ? (
                  <Badge variant="gray">Built in</Badge>
                ) : (
                  <div className="flex flex-none items-center gap-2">
                    <span className="text-[12px] text-text-3">
                      {w.addedByName ? `${w.addedByName.split(' ')[0]} added` : 'Added'}
                    </span>
                    {open ? (
                      <button
                        type="button"
                        className="text-[12.5px] text-text-2 hover:text-text"
                        disabled={busy === `unlink-${w.dutyId}`}
                        onClick={() =>
                          void act(
                            `unlink-${w.dutyId}`,
                            async () =>
                              unwrap(
                                await api.POST('/v1/commands/realestate.duty.unlink', {
                                  body: { ...ids, waitsOnId: w.dutyId },
                                }),
                              ),
                            'It doesn’t wait on that anymore.',
                          )
                        }
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-text-3">Nothing. It can be done whenever it’s ready.</p>
        )}
        {open && adding ? (
          <div className="mt-2 rounded-menu border border-border p-3">
            <Field
              label="It can’t be done before"
              htmlFor="duty-waits-pick"
              hint="Another duty on this deal. Waiting on someone outside? Use Waiting on… instead."
            >
              <Select
                id="duty-waits-pick"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                data-testid="duty-waits-pick"
              >
                <option value="">{others === null ? 'Loading…' : 'Pick a duty'}</option>
                {(others ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button
                disabled={!pick}
                loading={busy === 'link'}
                data-testid="duty-waits-save"
                onClick={() =>
                  void act(
                    'link',
                    async () => {
                      unwrap(
                        await api.POST('/v1/commands/realestate.duty.link', {
                          body: { ...ids, waitsOnId: pick },
                        }),
                      );
                      setAdding(false);
                      setOthers(null);
                    },
                    'Saved. It shows what it waits on, and who has it.',
                  )
                }
              >
                It waits on this
              </Button>
            </div>
          </div>
        ) : open ? (
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-accent-text hover:underline"
            onClick={startAdding}
            data-testid="duty-waits-add"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Waits on another duty
          </button>
        ) : null}
      </div>

      {waitingOnThis.length ? (
        <div>
          <h3 className="mb-1.5 font-medium">Waiting on this</h3>
          <ul className="divide-y divide-border rounded-menu border border-border">
            {waitingOnThis.map((w) => (
              <li key={w.dutyId} className="flex items-start gap-2.5 px-3 py-2">
                <LineIcon w={w} />
                <div className="min-w-0">
                  <div className="font-medium">{w.title}</div>
                  <div className="text-[12.5px] text-text-3">{lineWords(w, timeZone)}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {slips.length && open ? (
        <div data-testid="duty-if-it-slips">
          <h3 className="mb-1 font-medium">If it slips</h3>
          <p className="text-text-2">{slips.join(' ')}</p>
        </div>
      ) : null}
    </section>
  );
}

/** "Waits on 1 still open", for the drawer's badges; null when nothing it waits on is open. */
export function waitsOpenWords(data: DutyGet): string | null {
  const n = data.waitsOn.filter((w) => !isDoneDuty(w.status as DutyStatus)).length;
  return n ? `Waits on ${n} still open` : null;
}
