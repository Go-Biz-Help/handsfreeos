'use client';
import { CALENDAR_PRESETS, configFromPreset, inferLabels, type PresetKey } from '@hfos/core';
import {
  CalendarDays,
  Info,
  MapPin,
  Plus,
  Shuffle,
  Truck,
  User,
  Users,
  UsersRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Stepper } from '@/components/ui/stepper';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ResourceItem, ResourceKind, ServiceItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { LabelChips } from './chips';
import { RESOURCE_KINDS } from './resources-page';

/** Stands in for a resource made along with the calendar, so the labels preview counts it. */
const PENDING_RESOURCE = '00000000-0000-4000-8000-000000000000';

interface PresetCopy {
  readonly title: string;
  readonly description: string;
  readonly fills: string;
  readonly icon: LucideIcon;
  readonly name: (first: string) => string;
}

/** The answers to "How do you want this calendar to work?", in the canvas's words. */
export const PRESET_COPY: Record<PresetKey, PresetCopy> = {
  personal: {
    title: 'Personal',
    description: 'One person, booked for their own appointments.',
    fills: 'You, one at a time, 1 hour',
    icon: User,
    name: (first) => `${first}’s calendar`,
  },
  round_robin: {
    title: 'Round Robin',
    description: 'A team takes turns, so bookings spread out evenly.',
    fills: 'People you pick, taking turns',
    icon: Shuffle,
    name: () => 'Estimates',
  },
  service: {
    title: 'Service',
    description: 'Customers pick a service, and the first free person takes it.',
    fills: 'Your services, first free person',
    icon: Wrench,
    name: () => 'Service calls',
  },
  group: {
    title: 'Group/Class',
    description: 'Several people book the same time, up to a seat limit.',
    fills: '10 seats, parties up to 4, waitlist',
    icon: Users,
    name: () => 'Class',
  },
  event: {
    title: 'Event',
    description: 'Set dates and times that people sign up for.',
    fills: 'Fixed sessions, 50 seats, waitlist',
    icon: CalendarDays,
    name: () => 'Open house',
  },
  resource: {
    title: 'Resource',
    // Core's own words for it (no staff by default).
    description: CALENDAR_PRESETS.find((p) => p.key === 'resource')!.description,
    fills: 'A resource, no staff needed',
    icon: Truck,
    name: () => 'Equipment',
  },
  collective: {
    title: 'Collective',
    description: 'Needs two or more people free at the same time.',
    fills: 'Two people who must both be free',
    icon: UsersRound,
    name: () => 'Walkthrough',
  },
  dispatch: {
    title: 'Dispatch',
    description: 'Sends the right tech to the customer’s address by ZIP code.',
    fills: 'Taking turns, ZIP areas, 30 min travel',
    icon: MapPin,
    name: () => 'Service visits',
  },
  scratch: {
    title: 'Start from scratch',
    description: 'Just the basics. Turn on what you need.',
    fills: 'Nothing extra',
    icon: Plus,
    name: () => 'New calendar',
  },
};

const ORDER: PresetKey[] = [
  'personal',
  'round_robin',
  'service',
  'group',
  'event',
  'resource',
  'collective',
  'dispatch',
  'scratch',
];

export function PresetPicker({
  workspaceId,
  myUserId,
  myName,
  people,
  services,
  resources,
}: {
  workspaceId: string;
  myUserId: string;
  myName: string;
  people: { id: string; fullName: string }[];
  services: ServiceItem[];
  resources: ResourceItem[];
}) {
  const router = useRouter();
  const first = myName.trim().split(/\s+/)[0] || myName;
  const others = people.filter((p) => p.id !== myUserId);
  const [pick, setPick] = useState<PresetKey>('personal');
  const [name, setName] = useState(PRESET_COPY.personal.name(first));
  const [edited, setEdited] = useState(false);
  const [team, setTeam] = useState<string[]>(people.map((p) => p.id));
  const [partner, setPartner] = useState(others[0]?.id ?? '');
  const [picked, setPicked] = useState<string[]>(services.map((s) => s.id));
  const live = resources.filter((r) => !r.archivedAt);
  const [resource, setResource] = useState(live[0]?.id ?? '');
  // The Resource preset's follow-up: one you have, or a new one made along with the calendar.
  const [resourceMode, setResourceMode] = useState<'existing' | 'new'>(
    live.length ? 'existing' : 'new',
  );
  const [draftResource, setDraftResource] = useState<{
    name: string;
    kind: ResourceKind;
    quantity: number;
  }>({ name: '', kind: 'equipment', quantity: 1 });
  const [made, setMade] = useState<{ key: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const turns = pick === 'round_robin' || pick === 'dispatch';
  const teammates = turns ? team : pick === 'collective' && partner ? [partner] : [];
  const chosenServices = pick === 'service' ? picked : [];
  const adding = pick === 'resource' && resourceMode === 'new';
  const chosenResources =
    pick !== 'resource'
      ? []
      : adding
        ? draftResource.name.trim()
          ? [PENDING_RESOURCE]
          : []
        : resource
          ? [resource]
          : [];
  const labels = useMemo(
    () =>
      inferLabels(
        configFromPreset(pick, {
          me: myUserId,
          teammates,
          services: chosenServices,
          resources: chosenResources,
        }),
      ).tags,
    [pick, myUserId, teammates.join(), chosenServices.join(), chosenResources.join()],
  );

  function choose(key: PresetKey) {
    setPick(key);
    if (!edited) setName(PRESET_COPY[key].name(first));
  }

  /** The new resource's id, made once: trying again after a failed create reuses it. */
  async function newResourceId(): Promise<string> {
    const body = { ...draftResource, name: draftResource.name.trim() };
    const key = JSON.stringify(body);
    if (made?.key === key) return made.id;
    const { resourceId } = unwrap(
      await apiBrowser().POST('/v1/commands/resource.create', {
        body: { workspaceId, ...body, location: null, hours: null },
      }),
    );
    setMade({ key, id: resourceId });
    return resourceId;
  }

  async function create() {
    setBusy(true);
    try {
      const resourceIds = adding ? [await newResourceId()] : chosenResources;
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/calendar.create', {
          body: {
            workspaceId,
            name: name.trim(),
            preset: pick,
            teammates,
            services: chosenServices,
            resources: resourceIds,
          },
        }),
      );
      toast.success(
        `Created “${name.trim()}” from ${PRESET_COPY[pick].title}.${adding ? ` ${draftResource.name.trim()} is under Resources now.` : ''} It starts as a draft.`,
      );
      router.push(`/app/w/${workspaceId}/settings/calendars/${out.calendarId}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  return (
    <Card className="p-5 md:px-7 md:py-6" data-testid="preset-picker">
      <h2 className="text-lg font-semibold tracking-tight">
        How do you want this calendar to work?
      </h2>
      <p className="mb-[18px] mt-1.5 flex items-center gap-2 text-[13px] text-text-2">
        <Info className="h-4 w-4 flex-none" strokeWidth={1.5} />
        Pick the closest match. Presets only fill in settings. You can change anything later.
      </p>
      <div
        role="radiogroup"
        aria-label="How it works"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {ORDER.map((key) => {
          const c = PRESET_COPY[key];
          const Icon = c.icon;
          const on = pick === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`preset-${key}`}
              onClick={() => choose(key)}
              className={cn(
                'flex min-h-[132px] flex-col gap-2.5 rounded-menu border px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                on
                  ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
                  : 'border-border-strong bg-card hover:bg-card-2',
                key === 'scratch' && !on && 'border-dashed',
              )}
            >
              <span className="flex w-full items-center gap-2.5">
                <span className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] bg-accent-soft text-accent-text">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <span className="flex-1 text-[15px] font-semibold">{c.title}</span>
                <span
                  aria-hidden
                  className={cn(
                    'inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
                    on ? 'border-accent' : 'border-border-strong',
                  )}
                >
                  {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
                </span>
              </span>
              <span className="text-[13px] leading-[1.45] text-text-2">{c.description}</span>
              <span className="mt-auto text-xs text-text-3">Fills in: {c.fills}</span>
            </button>
          );
        })}
      </div>

      {turns && people.length > 1 ? (
        <fieldset className="mt-5">
          <legend className="mb-2 text-[13px] font-medium">Who takes turns?</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {people.map((p) => (
              <Checkbox
                key={p.id}
                label={p.id === myUserId ? `${p.fullName} (you)` : p.fullName}
                checked={team.includes(p.id)}
                onChange={() => setTeam(toggle(team, p.id))}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      {pick === 'collective' ? (
        <div className="mt-5 max-w-sm">
          <Field
            label="Who goes with you?"
            htmlFor="preset-partner"
            hint={
              others.length
                ? undefined
                : 'Invite a teammate first; until then the builder offers a fix.'
            }
          >
            <Select
              id="preset-partner"
              value={partner}
              onChange={(e) => setPartner(e.target.value)}
              disabled={!others.length}
            >
              {others.length ? null : <option value="">Nobody else yet</option>}
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
      {pick === 'service' ? (
        <fieldset className="mt-5">
          <legend className="mb-2 text-[13px] font-medium">Which services?</legend>
          {services.length ? (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {services.map((s) => (
                <Checkbox
                  key={s.id}
                  label={s.name}
                  checked={picked.includes(s.id)}
                  onChange={() => setPicked(toggle(picked, s.id))}
                />
              ))}
            </div>
          ) : (
            <Hint className="mt-0">
              No services yet. Add them under Services, then pick them in the builder.
            </Hint>
          )}
        </fieldset>
      ) : null}
      {pick === 'resource' ? (
        <div
          role="group"
          aria-labelledby="preset-resource-label"
          className="mt-5 flex max-w-xl flex-col gap-3"
          data-testid="preset-resource-step"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span id="preset-resource-label" className="text-[13px] font-medium">
              What does each booking reserve?
            </span>
            {live.length ? (
              <Segmented
                value={resourceMode}
                onChange={setResourceMode}
                ariaLabel="One you have or a new one"
                options={[
                  { value: 'existing', label: 'One you have', testId: 'preset-resource-existing' },
                  { value: 'new', label: 'A new one', testId: 'preset-resource-new' },
                ]}
              />
            ) : null}
          </div>
          {adding ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_150px_auto]">
              <Field label="Resource name" htmlFor="preset-resource-name">
                <Input
                  id="preset-resource-name"
                  value={draftResource.name}
                  maxLength={120}
                  placeholder="Red light bed"
                  onChange={(e) => setDraftResource({ ...draftResource, name: e.target.value })}
                />
              </Field>
              <Field label="Kind" htmlFor="preset-resource-kind">
                <Select
                  id="preset-resource-kind"
                  value={draftResource.kind}
                  onChange={(e) =>
                    setDraftResource({ ...draftResource, kind: e.target.value as ResourceKind })
                  }
                >
                  {(Object.keys(RESOURCE_KINDS) as ResourceKind[]).map((k) => (
                    <option key={k} value={k}>
                      {RESOURCE_KINDS[k].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div>
                <Label>How many</Label>
                <div className="flex h-10 items-center">
                  <Stepper
                    value={draftResource.quantity}
                    min={1}
                    max={100}
                    label="How many"
                    testId="preset-resource-quantity"
                    onChange={(quantity) => setDraftResource({ ...draftResource, quantity })}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-sm">
              <Field label="Which resource?" htmlFor="preset-resource">
                <Select
                  id="preset-resource"
                  value={resource}
                  onChange={(e) => setResource(e.target.value)}
                >
                  {live.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          <Hint className="mt-0">
            {adding
              ? 'How many there are decides how many people can book the same time. It’s added under Resources with the calendar.'
              : 'Each booking reserves one. How many there are decides how many people can book the same time.'}
          </Hint>
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-5 border-t border-border pt-[18px] md:grid-cols-2">
        <Field
          label="Name"
          htmlFor="calendar-name"
          hint="Customers see it on the booking page, and the link is made from it."
        >
          <Input
            id="calendar-name"
            value={name}
            maxLength={120}
            onChange={(e) => {
              setName(e.target.value);
              setEdited(true);
            }}
          />
        </Field>
        <div>
          <Label>It starts out as</Label>
          <div className="flex min-h-10 items-center">
            <LabelChips tags={labels} testId="preset-labels" />
          </div>
          <Hint>
            Labels describe the settings and change as you edit. They never lock anything.
          </Hint>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Link
          href={`/app/w/${workspaceId}/settings/calendars`}
          className={buttonClassName({ variant: 'ghost' })}
        >
          Cancel
        </Link>
        <Button
          loading={busy}
          disabled={!name.trim() || (adding && !draftResource.name.trim())}
          onClick={() => void create()}
          data-testid="calendar-create"
        >
          Create calendar
        </Button>
      </div>
    </Card>
  );
}
