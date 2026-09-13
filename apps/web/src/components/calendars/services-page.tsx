'use client';
import type { WeeklyHours } from '@hfos/core';
import { Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ResourceItem, ServiceItem } from '@/lib/api/types';
import { fmtLength } from '@/lib/calendar/time';
import { formatMoney, parseMoney } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { hoursProblem, WeeklyHoursEditor } from './weekly-hours';

const LENGTHS = [15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720];
const BUFFERS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const WEEKDAYS_9_TO_5: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));

interface Form {
  id: string | null;
  name: string;
  price: string;
  durations: number[];
  bufferBefore: number;
  bufferAfter: number;
  staffUserIds: string[];
  resources: { resourceId: string; quantity: number }[];
  hours: WeeklyHours | null;
  color: string;
}

const blank = (): Form => ({
  id: null,
  name: '',
  price: '',
  durations: [60],
  bufferBefore: 0,
  bufferAfter: 0,
  staffUserIds: [],
  resources: [],
  hours: null,
  color: '#0e7490',
});

const formOf = (s: ServiceItem): Form => ({
  id: s.id,
  name: s.name,
  price: s.priceCents === null ? '' : formatMoney(s.priceCents),
  durations: [s.defaultDuration, ...s.durations.filter((d) => d !== s.defaultDuration)],
  bufferBefore: s.bufferBefore,
  bufferAfter: s.bufferAfter,
  staffUserIds: s.staffUserIds,
  resources: s.resources,
  hours: (s.hours as WeeklyHours | null) ?? null,
  color: s.color,
});

/** Settings → Calendars → Services: what customers can book; each calendar picks which it offers. */
export function ServicesPage({
  workspaceId,
  services,
  resources,
  people,
}: {
  workspaceId: string;
  services: ServiceItem[];
  resources: ResourceItem[];
  people: { id: string; fullName: string }[];
}) {
  useLiveRefresh(['service', 'resource']);
  const [form, setForm] = useState<Form | null>(null);
  const first = (id: string) =>
    people.find((p) => p.id === id)?.fullName.split(/\s+/)[0] ?? 'Someone';
  const resourceName = (id: string) => resources.find((r) => r.id === id)?.name ?? 'A resource';

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
      <Card className="overflow-hidden" data-testid="services">
        <div className="flex items-start justify-between gap-3 px-5 pb-3.5 pt-[18px]">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Services</h2>
            <p className="mt-1 text-[13px] text-text-2">
              What customers can book. Each calendar picks which ones it offers.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setForm(blank())}
            data-testid="service-new"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New service
          </Button>
        </div>
        {services.length === 0 ? (
          <EmptyState title="No services yet" className="border-t border-border">
            Add the jobs customers book, like a tune-up or a repair, with how long each takes.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr className="text-left text-xs font-medium tracking-[0.02em] text-text-3">
                  {['Service', 'Lengths', 'Before / after', 'Who can do it', 'Needs'].map((h) => (
                    <th
                      key={h}
                      className="border-y border-border bg-card-2 px-4 py-2.5 font-medium"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {services.map((s) => {
                  const on = form?.id === s.id;
                  const td = cn('border-b border-border px-4 py-3', on && 'bg-accent-soft');
                  return (
                    <tr
                      key={s.id}
                      className="cursor-pointer hover:[&>td]:bg-card-2"
                      onClick={() => setForm(formOf(s))}
                      data-testid={`service-row-${s.name}`}
                    >
                      <td className={td}>
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 flex-none rounded-full"
                            style={{ background: s.color }}
                          />
                          <span className="font-medium">{s.name}</span>
                        </span>
                      </td>
                      <td className={td}>{s.durations.map(fmtLength).join(', ')}</td>
                      <td className={td}>
                        {s.bufferBefore} / {s.bufferAfter} min
                      </td>
                      <td className={td}>
                        {s.staffUserIds.length ? s.staffUserIds.map(first).join(', ') : 'Everyone'}
                      </td>
                      <td className={td}>
                        {s.resources.length
                          ? s.resources.map((r) => resourceName(r.resourceId)).join(', ')
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {form ? (
        <ServiceEditor
          key={form.id ?? 'new'}
          workspaceId={workspaceId}
          initial={form}
          resources={resources}
          people={people}
          onDone={() => setForm(null)}
        />
      ) : (
        <Card className="hidden p-6 text-[13px] text-text-2 xl:block">
          Pick a service to change it, or add a new one.
        </Card>
      )}
    </div>
  );
}

function ServiceEditor({
  workspaceId,
  initial,
  resources,
  people,
  onDone,
}: {
  workspaceId: string;
  initial: Form;
  resources: ResourceItem[];
  people: { id: string; fullName: string }[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const price = f.price.trim() ? parseMoney(f.price) : null;
  const invalid =
    !f.name.trim() ||
    !f.durations.length ||
    (f.price.trim() !== '' && price === null) ||
    (f.hours ? !!hoursProblem(f.hours) : false);

  async function save() {
    setBusy(true);
    try {
      const body = {
        workspaceId,
        name: f.name.trim(),
        durations: f.durations,
        defaultDuration: f.durations[0],
        bufferBefore: f.bufferBefore,
        bufferAfter: f.bufferAfter,
        priceCents: price,
        staffUserIds: f.staffUserIds,
        resources: f.resources,
        hours: f.hours,
        color: f.color,
      };
      if (f.id)
        unwrap(
          await apiBrowser().POST('/v1/commands/service.update', {
            body: { ...body, serviceId: f.id },
          }),
        );
      else unwrap(await apiBrowser().POST('/v1/commands/service.create', { body }));
      toast.success(f.id ? 'Service saved.' : `${f.name.trim()} added.`);
      onDone();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!f.id || !confirm(`Archive ${f.name}? Calendars offering it will show something to fix.`))
      return;
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/service.archive', {
          body: { workspaceId, serviceId: f.id },
        }),
      );
      toast.success(
        out.calendars.length
          ? `Archived. ${out.calendars.map((c) => c.name).join(', ')} still offer${out.calendars.length === 1 ? 's' : ''} it; the builder offers a fix.`
          : 'Archived.',
      );
      onDone();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const addable = resources.filter((r) => !f.resources.some((x) => x.resourceId === r.id));

  return (
    <Card className="px-[22px] py-[18px]" data-testid="service-editor">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">
          {f.id ? initial.name : 'New service'}
        </h2>
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onDone}>
          <X className="h-4 w-4" strokeWidth={1.5} />
        </Button>
      </div>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_130px] gap-3">
        <Field label="Name" htmlFor="service-name">
          <Input
            id="service-name"
            inputSize="sm"
            value={f.name}
            maxLength={120}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </Field>
        <Field label="Price shown" htmlFor="service-price">
          <Input
            id="service-price"
            inputSize="sm"
            placeholder="$0"
            value={f.price}
            invalid={f.price.trim() !== '' && price === null}
            onChange={(e) => setF({ ...f, price: e.target.value })}
          />
        </Field>
      </div>
      <div className="mt-3">
        <Label>
          Lengths customers can pick{' '}
          {f.durations[0] ? (
            <span className="font-normal text-text-3">
              · {fmtLength(f.durations[0])} unless they change it
            </span>
          ) : null}
        </Label>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="service-lengths">
          {f.durations.map((m) => (
            <span
              key={m}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-accent-soft pl-3 pr-2 text-[13px] font-medium text-accent-text"
            >
              {fmtLength(m)}
              <button
                type="button"
                aria-label={`Remove ${fmtLength(m)}`}
                onClick={() => setF({ ...f, durations: f.durations.filter((x) => x !== m) })}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </span>
          ))}
          {f.durations.length < 6 ? (
            <Select
              selectSize="sm"
              className="h-[30px] w-[130px] text-[13px]"
              aria-label="Add a length"
              value=""
              onChange={(e) =>
                e.target.value &&
                setF({ ...f, durations: [...f.durations, Number(e.target.value)] })
              }
            >
              <option value="">Add a length</option>
              {LENGTHS.filter((m) => !f.durations.includes(m)).map((m) => (
                <option key={m} value={m}>
                  {fmtLength(m)}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Setup before" htmlFor="service-before">
          <Select
            id="service-before"
            selectSize="sm"
            value={String(f.bufferBefore)}
            onChange={(e) => setF({ ...f, bufferBefore: Number(e.target.value) })}
          >
            {BUFFERS.map((m) => (
              <option key={m} value={m}>
                {m ? `${m} min` : 'None'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cleanup after" htmlFor="service-after">
          <Select
            id="service-after"
            selectSize="sm"
            value={String(f.bufferAfter)}
            onChange={(e) => setF({ ...f, bufferAfter: Number(e.target.value) })}
          >
            {BUFFERS.map((m) => (
              <option key={m} value={m}>
                {m ? `${m} min` : 'None'}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-3">
        <Label>Who can do it</Label>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {people.map((p) => (
            <Checkbox
              key={p.id}
              label={p.fullName.split(/\s+/)[0]}
              checked={f.staffUserIds.includes(p.id)}
              onChange={(e) =>
                setF({
                  ...f,
                  staffUserIds: e.target.checked
                    ? [...f.staffUserIds, p.id]
                    : f.staffUserIds.filter((x) => x !== p.id),
                })
              }
            />
          ))}
        </div>
        <p className="mt-1 text-[12.5px] text-text-3">
          {f.staffUserIds.length ? 'Only the people ticked.' : 'Nobody ticked means everyone.'}
        </p>
      </div>
      <div className="mt-3">
        <Label>Needs</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {f.resources.map((r) => (
            <span
              key={r.resourceId}
              className="inline-flex h-[30px] items-center gap-2 rounded-full border border-border-strong bg-card pl-3 pr-2 text-[13px] font-medium text-text-2"
            >
              {resources.find((x) => x.id === r.resourceId)?.name ?? 'A resource'} × {r.quantity}
              <button
                type="button"
                aria-label="Remove"
                onClick={() =>
                  setF({
                    ...f,
                    resources: f.resources.filter((x) => x.resourceId !== r.resourceId),
                  })
                }
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </span>
          ))}
          {addable.length ? (
            <Select
              selectSize="sm"
              className="h-[30px] w-[160px] text-[13px]"
              aria-label="Add a resource it needs"
              value=""
              onChange={(e) =>
                e.target.value &&
                setF({
                  ...f,
                  resources: [...f.resources, { resourceId: e.target.value, quantity: 1 }],
                })
              }
            >
              <option value="">Add a resource</option>
              {addable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          ) : f.resources.length ? null : (
            <span className="text-[13px] text-text-3">Nothing</span>
          )}
        </div>
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <label className="flex items-center justify-between gap-3 text-[13px] font-medium">
          Only at certain hours
          <Switch
            checked={!!f.hours}
            label="Only at certain hours"
            onChange={(on) => setF({ ...f, hours: on ? WEEKDAYS_9_TO_5 : null })}
          />
        </label>
        {f.hours ? (
          <div className="mt-2">
            <WeeklyHoursEditor
              value={f.hours}
              onChange={(hours) => setF({ ...f, hours })}
              idPrefix="service-hours"
            />
          </div>
        ) : null}
      </div>
      <div className="mt-3.5 flex justify-end gap-2">
        {f.id ? (
          <Button variant="ghost" size="sm" onClick={() => void archive()}>
            Archive
          </Button>
        ) : null}
        <Button
          size="sm"
          loading={busy}
          disabled={invalid}
          onClick={() => void save()}
          data-testid="service-save"
        >
          Save service
        </Button>
      </div>
    </Card>
  );
}
